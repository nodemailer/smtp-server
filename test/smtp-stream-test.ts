import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SMTPStream } from '../src/smtp-stream.js';

describe('SMTPStream', () => {
    it('should emit commands', (t, done) => {
        let stream: any = new SMTPStream();

        let expecting = [Buffer.from([0x43, 0x4d, 0x44, 0x31]), Buffer.from([0x43, 0x4d, 0x44, 0x32]), Buffer.from([0x43, 0x4d, 0x44, 0x33])];

        stream.oncommand = (cmd: any, cb: any) => {
            assert.deepStrictEqual(cmd, expecting.shift());
            if (cb) {
                return cb();
            } else {
                return done();
            }
        };

        stream.end('CMD1\r\nCMD2\r\nCMD3');
    });

    it('should start data stream', (t, done) => {
        let stream: any = new SMTPStream();

        let expecting = ['DATA', 'QUIT'];

        stream.oncommand = (cmd: any, cb: any) => {
            cmd = cmd.toString();
            assert.deepStrictEqual(cmd, expecting.shift());

            let datastream: any;
            let output = '';
            if (cmd === 'DATA') {
                datastream = stream.startDataMode();
                datastream.on('data', (chunk: Buffer) => {
                    output += chunk.toString();
                });
                datastream.on('end', () => {
                    assert.strictEqual(output, 'test1\r\n.test2\r\n.test3\r\n');
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

    it('should set sizeExceeded in real time while receiving data', (t, done) => {
        let stream: any = new SMTPStream();

        stream.oncommand = (cmd: any, cb: any) => {
            cmd = cmd.toString();

            let datastream: any;
            if (cmd === 'DATA') {
                datastream = stream.startDataMode(1024); // 1kB limit

                assert.strictEqual(datastream.sizeExceeded, false);
                assert.strictEqual(datastream.byteLength, 0);

                let exceededDuringTransfer = false;
                datastream.on('data', () => {
                    if (datastream.sizeExceeded) {
                        exceededDuringTransfer = true;
                    }
                });
                datastream.on('end', () => {
                    assert.strictEqual(exceededDuringTransfer, true);
                    assert.strictEqual(datastream.sizeExceeded, true);
                    assert.ok(datastream.byteLength > 1024, 'expected byteLength to be above 1024, got ' + datastream.byteLength);
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

    it('should not overflow the stack on heavily pipelined commands', (t, done) => {
        let stream: any = new SMTPStream();

        let count = 0;
        let total = 100000;

        stream.oncommand = (cmd: any, cb: any) => {
            assert.strictEqual(cmd.toString(), 'NOOP');
            count++;
            // complete every command synchronously
            cb();
        };

        stream.on('error', done);

        stream.on('finish', () => {
            assert.strictEqual(count, total);
            done();
        });

        stream.end('NOOP\r\n'.repeat(total));
    });

    it('should not get stuck when a command handler throws', () => {
        let stream: any = new SMTPStream();

        let seen: string[] = [];
        let thrown = false;
        let continuation: any;

        stream.oncommand = (cmd: any, cb: any) => {
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

        assert.strictEqual(thrown, true);
        assert.deepStrictEqual(seen, ['BOOM']);

        // the parser must still accept the continuation, otherwise the connection
        // would hang until the socket times out
        continuation();
        assert.deepStrictEqual(seen, ['BOOM', 'NOOP', 'QUIT']);
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
        it('should read ' + title, (t, done) => {
            let stream: any = new SMTPStream();

            let expecting = ['DATA', 'QUIT'];

            stream.oncommand = (cmd: any, cb: any) => {
                cmd = cmd.toString();
                assert.deepStrictEqual(cmd, expecting.shift());

                let output = '';
                if (cmd === 'DATA') {
                    let datastream = stream.startDataMode();
                    datastream.on('data', (chunk: Buffer) => {
                        output += chunk.toString();
                    });
                    datastream.on('end', () => {
                        assert.strictEqual(output, expected);
                        assert.strictEqual(stream.dataBytes, expected.length);
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
