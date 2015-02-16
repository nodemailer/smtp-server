'use strict';

var chai = require('chai');
var SMTPStream = require('../lib/smtp-stream').SMTPStream;
var expect = chai.expect;

chai.config.includeStack = true;

describe('SMTPStream', function() {
    it('should emit commands', function(done) {
        var stream = new SMTPStream();

        var expecting = [
            new Buffer([0x43, 0x4d, 0x44, 0x31]),
            new Buffer([0x43, 0x4d, 0x44, 0x32]),
            new Buffer([0x43, 0x4d, 0x44, 0x33])
        ];

        stream.oncommand = function(cmd, cb) {
            expect(cmd).to.deep.equal(expecting.shift());
            if (cb) {
                cb();
            } else {
                done();
            }
        };

        stream.end('CMD1\r\nCMD2\r\nCMD3');
    });

    it('should start data stream', function(done) {
        var stream = new SMTPStream();

        var expecting = [
            'DATA',
            'QUIT'
        ];

        stream.oncommand = function(cmd, cb) {
            cmd = cmd.toString();
            expect(cmd).to.deep.equal(expecting.shift());

            var datastream;
            var output = '';
            if (cmd === 'DATA') {
                datastream = stream.startDataMode();
                datastream.on('data', function(chunk) {
                    output += chunk.toString();
                });
                datastream.on('end', function() {
                    expect(output).to.equal('test1\r\n.test2\r\n.test3');
                    stream.continue();
                });
            }

            if (cb) {
                cb();
            } else {
                done();
            }
        };

        stream.end('DATA\r\ntest1\r\n..test2\r\n.test3\r\n.\r\nQUIT');
    });
});