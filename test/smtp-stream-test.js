/* eslint no-unused-expressions:0, prefer-arrow-callback: 0 */

'use strict';

const chai = require('chai');
const SMTPStream = require('../lib/smtp-stream').SMTPStream;
const expect = chai.expect;

chai.config.includeStack = true;

describe('SMTPStream', function () {
    it('should emit commands', function (done) {
        let stream = new SMTPStream();

        let expecting = [Buffer.from([0x43, 0x4d, 0x44, 0x31]), Buffer.from([0x43, 0x4d, 0x44, 0x32]), Buffer.from([0x43, 0x4d, 0x44, 0x33])];

        stream.oncommand = function (cmd, cb) {
            expect(cmd).to.deep.equal(expecting.shift());
            if (cb) {
                return cb();
            } else {
                return done();
            }
        };

        stream.end('CMD1\r\nCMD2\r\nCMD3');
    });

    it('should start data stream', function (done) {
        let stream = new SMTPStream();

        let expecting = ['DATA', 'QUIT'];

        stream.oncommand = function (cmd, cb) {
            cmd = cmd.toString();
            expect(cmd).to.deep.equal(expecting.shift());

            let datastream;
            let output = '';
            if (cmd === 'DATA') {
                datastream = stream.startDataMode();
                datastream.on('data', function (chunk) {
                    output += chunk.toString();
                });
                datastream.on('end', function () {
                    expect(output).to.equal('test1\r\n.test2\r\n.test3\r\n');
                    stream.continue();
                });
            }

            if (cb) {
                return cb();
            } else {
                return done();
            }
        };

        stream.end('DATA\r\ntest1\r\n..test2\r\n.test3\r\n.\r\nQUIT');
    });

    it('should set sizeExceeded in real time while receiving data', function (done) {
        let stream = new SMTPStream();

        stream.oncommand = function (cmd, cb) {
            cmd = cmd.toString();

            let datastream;
            if (cmd === 'DATA') {
                datastream = stream.startDataMode(1024); // 1kB limit

                expect(datastream.sizeExceeded).to.equal(false);
                expect(datastream.byteLength).to.equal(0);

                let exceededDuringTransfer = false;
                datastream.on('data', function () {
                    if (datastream.sizeExceeded) {
                        exceededDuringTransfer = true;
                    }
                });
                datastream.on('end', function () {
                    expect(exceededDuringTransfer).to.equal(true);
                    expect(datastream.sizeExceeded).to.equal(true);
                    expect(datastream.byteLength).to.be.gt(1024);
                    stream.continue();
                });
            }

            if (cb) {
                return cb();
            } else {
                return done();
            }
        };

        stream.write('DATA\r\n');
        // exceed the 1kB limit several times over in separate chunks
        for (let i = 0; i < 8; i++) {
            stream.write(Buffer.alloc(1024, 0x62)); // 1kB of "b"
        }
        stream.end('\r\n.\r\nQUIT');
    });

    it('should not overflow the stack on heavily pipelined commands', function (done) {
        let stream = new SMTPStream();

        let count = 0;
        let total = 100000;

        stream.oncommand = function (cmd, cb) {
            expect(cmd.toString()).to.equal('NOOP');
            count++;
            // complete every command synchronously
            cb();
        };

        stream.on('error', done);

        stream.on('finish', () => {
            expect(count).to.equal(total);
            done();
        });

        stream.end('NOOP\r\n'.repeat(total));
    });

    it('should not get stuck when a command handler throws', function () {
        let stream = new SMTPStream();

        let seen = [];
        let thrown = false;
        let continuation;

        stream.oncommand = function (cmd, cb) {
            cmd = cmd.toString();
            seen.push(cmd);
            if (cmd === 'BOOM') {
                continuation = cb;
                throw new Error('handler failed');
            }
            if (cb) {
                return cb();
            }
        };

        try {
            stream.write('BOOM\r\nNOOP\r\nQUIT\r\n');
        } catch {
            thrown = true;
        }

        expect(thrown).to.be.true;
        expect(seen).to.deep.equal(['BOOM']);

        // the parser must still accept the continuation, otherwise the connection
        // would hang until the socket times out
        continuation();
        expect(seen).to.deep.equal(['BOOM', 'NOOP', 'QUIT']);
    });

    // How the payload is split across TCP segments is under the sender's control and
    // must never change the message the application receives. Every case below writes
    // "DATA\r\n" first and then the listed chunks, the last one through end()
    [
        {
            title: 'a dot-stuffed first line arriving as its own chunk',
            chunks: ['..', '\r\nMAIL FROM:<a@b.c>\r\n.\r\nQUIT'],
            // the leading ".." is content (a single dot), not the end of DATA, so the
            // commands behind it stay part of the body instead of being executed
            expected: '.\r\nMAIL FROM:<a@b.c>\r\n'
        },
        {
            title: 'dot-stuffing split across two chunks',
            // wire "...." is a single dot-stuffed line of "..."
            chunks: ['..', '..', '\r\n.\r\nQUIT'],
            expected: '...\r\n'
        },
        {
            title: 'an empty message with a chunk-split terminator',
            chunks: ['.', '\r\nQUIT'],
            expected: ''
        },
        {
            title: 'a message in one chunk',
            chunks: ['Subject: test\r\n\r\nHello\r\n.\r\nQUIT'],
            expected: 'Subject: test\r\n\r\nHello\r\n'
        },
        {
            title: 'a message whose terminator is split',
            chunks: ['Subject: test\r\n\r\nHello\r\n.\r', '\nQUIT'],
            expected: 'Subject: test\r\n\r\nHello\r\n'
        },
        {
            title: 'a message whose last line is split',
            chunks: ['Subject: test\r\n\r\nHello', '\r\n.\r\nQUIT'],
            expected: 'Subject: test\r\n\r\nHello\r\n'
        },
        {
            title: 'a message delivered byte by byte',
            chunks: 'Subject: test\r\n\r\nHello\r\n.\r\nQUIT'.split(''),
            expected: 'Subject: test\r\n\r\nHello\r\n'
        }
    ].forEach(({ title, chunks, expected }) => {
        it('should read ' + title, function (done) {
            let stream = new SMTPStream();

            let expecting = ['DATA', 'QUIT'];

            stream.oncommand = function (cmd, cb) {
                cmd = cmd.toString();
                expect(cmd).to.deep.equal(expecting.shift());

                let output = '';
                if (cmd === 'DATA') {
                    let datastream = stream.startDataMode();
                    datastream.on('data', function (chunk) {
                        output += chunk.toString();
                    });
                    datastream.on('end', function () {
                        expect(output).to.equal(expected);
                        expect(stream.dataBytes).to.equal(expected.length);
                        stream.continue();
                    });
                }

                if (cb) {
                    return cb();
                } else {
                    return done();
                }
            };

            stream.write('DATA\r\n');
            chunks.forEach((chunk, i) => (i === chunks.length - 1 ? stream.end(chunk) : stream.write(chunk)));
        });
    });
});
