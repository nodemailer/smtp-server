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
});
