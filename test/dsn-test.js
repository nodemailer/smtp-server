/* eslint no-unused-expressions:0, prefer-arrow-callback: 0 */

'use strict';

const chai = require('chai');
const SMTPServer = require('../lib/smtp-server').SMTPServer;
const SMTPConnection = require('../lib/smtp-connection').SMTPConnection;

const expect = chai.expect;

chai.config.includeStack = true;

describe('DSN (Delivery Status Notification) Support', function () {
    this.timeout(10 * 1000); // eslint-disable-line no-invalid-this

    describe('Unit Tests for DSN Parameter Parsing', function () {
        it('should parse DSN parameters in _parseAddressCommand', function () {
            let conn = new SMTPConnection(
                {
                    options: {}
                },
                {}
            );

            // Test MAIL FROM with DSN parameters
            expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@example.com> RET=FULL ENVID=test123')).to.deep.equal({
                address: 'sender@example.com',
                args: {
                    RET: 'FULL',
                    ENVID: 'test123'
                }
            });

            // Test RCPT TO with DSN parameters
            expect(
                conn._parseAddressCommand('RCPT TO', 'RCPT TO:<recipient@example.com> NOTIFY=SUCCESS,FAILURE ORCPT=rfc822;original@example.com')
            ).to.deep.equal({
                address: 'recipient@example.com',
                args: {
                    NOTIFY: 'SUCCESS,FAILURE',
                    ORCPT: 'rfc822;original@example.com'
                }
            });

            // Test mixed parameters
            expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@example.com> SIZE=12345 RET=HDRS ENVID=env456')).to.deep.equal({
                address: 'sender@example.com',
                args: {
                    SIZE: '12345',
                    RET: 'HDRS',
                    ENVID: 'env456'
                }
            });
        });
    });

    describe('DSN Session Data Structure', function () {
        it('should initialize DSN data in session envelope', function () {
            let conn = new SMTPConnection(
                {
                    options: {}
                },
                {
                    on() {},
                    write() {},
                    end() {}
                }
            );

            conn._resetSession();

            expect(conn.session.envelope.dsn).to.exist;
            expect(conn.session.envelope.dsn.ret).to.be.null;
            expect(conn.session.envelope.dsn.envid).to.be.null;
        });
    });

    describe('EHLO Response', function () {
        it('should include ENHANCEDSTATUSCODES and DSN in features list', function (done) {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                hideENHANCEDSTATUSCODES: false,
                hideDSN: false
            });

            // Mock connection for testing EHLO handler
            let mockConnection = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            });

            mockConnection.clientHostname = 'test.example.com';
            mockConnection.name = 'test-server';

            // Mock the send method to capture the response
            let sentResponse = null;
            mockConnection.send = function (code, message) {
                sentResponse = { code, message };
            };

            // Test EHLO handler
            mockConnection.handler_EHLO('EHLO test.example.com', function () {
                expect(sentResponse).to.exist;
                expect(sentResponse.code).to.equal(250);
                expect(sentResponse.message).to.be.an('array');

                // Check if ENHANCEDSTATUSCODES and DSN is in the features
                const features = sentResponse.message.slice(1); // Skip the greeting
                expect(features).to.include('ENHANCEDSTATUSCODES');
                expect(features).to.include('DSN');

                done();
            });
        });

        it('should hide ENHANCEDSTATUSCODES when hideENHANCEDSTATUSCODES is true', function (done) {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                hideENHANCEDSTATUSCODES: true
            });

            // Mock connection for testing EHLO handler
            let mockConnection = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            });

            mockConnection.clientHostname = 'test.example.com';
            mockConnection.name = 'test-server';

            // Mock the send method to capture the response
            let sentResponse = null;
            mockConnection.send = function (code, message) {
                sentResponse = { code, message };
            };

            // Test EHLO handler
            mockConnection.handler_EHLO('EHLO test.example.com', function () {
                expect(sentResponse).to.exist;
                expect(sentResponse.code).to.equal(250);
                expect(sentResponse.message).to.be.an('array');

                // Check if ENHANCEDSTATUSCODES is NOT in the features
                const features = sentResponse.message.slice(1); // Skip the greeting
                expect(features).to.not.include('ENHANCEDSTATUSCODES');

                done();
            });
        });

        it('should hide DSN when hideDSN is true', function (done) {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                hideDSN: true
            });

            // Mock connection for testing EHLO handler
            let mockConnection = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            });

            mockConnection.clientHostname = 'test.example.com';
            mockConnection.name = 'test-server';

            // Mock the send method to capture the response
            let sentResponse = null;
            mockConnection.send = function (code, message) {
                sentResponse = { code, message };
            };

            // Test EHLO handler
            mockConnection.handler_EHLO('EHLO test.example.com', function () {
                expect(sentResponse).to.exist;
                expect(sentResponse.code).to.equal(250);
                expect(sentResponse.message).to.be.an('array');

                // Check if DSN is NOT in the features
                const features = sentResponse.message.slice(1); // Skip the greeting
                expect(features).to.not.include('DSN');

                done();
            });
        });
    });

    describe('MAIL FROM DSN Parameter Validation', function () {
        it('should accept valid RET=FULL parameter', function (done) {
            let server = new SMTPServer({
                hideDSN: false,
                onMailFrom(address, session, callback) {
                    expect(session.envelope.dsn.ret).to.equal('FULL');
                    expect(address.args.RET).to.equal('FULL');
                    callback();
                }
            });

            let mockConnection = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            });

            mockConnection._resetSession();
            mockConnection.openingCommand = 'EHLO';

            let sentResponse = null;
            mockConnection.send = function (code, message) {
                sentResponse = { code, message };
            };

            mockConnection.handler_MAIL('MAIL FROM:<test@example.com> RET=FULL', function () {
                expect(sentResponse).to.exist;
                expect(sentResponse.code).to.equal(250);
                done();
            });
        });

        it('should reject invalid RET parameter', function (done) {
            let server = new SMTPServer({
                hideDSN: false,
                onMailFrom(address, session, callback) {
                    callback();
                }
            });

            let mockConnection = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            });

            mockConnection._resetSession();
            mockConnection.openingCommand = 'EHLO';

            let sentResponse = null;
            mockConnection.send = function (code, message) {
                sentResponse = { code, message };
            };

            mockConnection.handler_MAIL('MAIL FROM:<test@example.com> RET=INVALID', function () {
                expect(sentResponse).to.exist;
                expect(sentResponse.code).to.equal(501);
                expect(sentResponse.message).to.include('Invalid RET parameter');
                done();
            });
        });

        it('should accept ENVID parameter', function (done) {
            let server = new SMTPServer({
                hideDSN: false,
                onMailFrom(address, session, callback) {
                    expect(session.envelope.dsn.envid).to.equal('test-envelope-123');
                    expect(address.args.ENVID).to.equal('test-envelope-123');
                    callback();
                }
            });

            let mockConnection = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            });

            mockConnection._resetSession();
            mockConnection.openingCommand = 'EHLO';

            let sentResponse = null;
            mockConnection.send = function (code, message) {
                sentResponse = { code, message };
            };

            mockConnection.handler_MAIL('MAIL FROM:<test@example.com> ENVID=test-envelope-123', function () {
                expect(sentResponse).to.exist;
                expect(sentResponse.code).to.equal(250);
                done();
            });
        });
    });

    describe('RCPT TO DSN Parameter Validation', function () {
        it('should accept valid NOTIFY=SUCCESS parameter', function (done) {
            let server = new SMTPServer({
                hideDSN: false,
                onMailFrom(address, session, callback) {
                    callback();
                },
                onRcptTo(address, session, callback) {
                    expect(address.dsn.notify).to.deep.equal(['SUCCESS']);
                    expect(address.args.NOTIFY).to.equal('SUCCESS');
                    callback();
                }
            });

            let mockConnection = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            });

            mockConnection._resetSession();
            mockConnection.openingCommand = 'EHLO';
            mockConnection.session.envelope.mailFrom = { address: 'test@example.com' };

            let sentResponse = null;
            mockConnection.send = function (code, message) {
                sentResponse = { code, message };
            };

            mockConnection.handler_RCPT('RCPT TO:<recipient@example.com> NOTIFY=SUCCESS', function () {
                expect(sentResponse).to.exist;
                expect(sentResponse.code).to.equal(250);
                done();
            });
        });

        it('should reject invalid NOTIFY parameter', function (done) {
            let server = new SMTPServer({
                hideDSN: false,
                onMailFrom(address, session, callback) {
                    callback();
                },
                onRcptTo(address, session, callback) {
                    callback();
                }
            });

            let mockConnection = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            });

            mockConnection._resetSession();
            mockConnection.openingCommand = 'EHLO';
            mockConnection.session.envelope.mailFrom = { address: 'test@example.com' };

            let sentResponse = null;
            mockConnection.send = function (code, message) {
                sentResponse = { code, message };
            };

            mockConnection.handler_RCPT('RCPT TO:<recipient@example.com> NOTIFY=INVALID', function () {
                expect(sentResponse).to.exist;
                expect(sentResponse.code).to.equal(501);
                expect(sentResponse.message).to.include('NOTIFY parameter must be NEVER, SUCCESS, FAILURE, or DELAY');
                done();
            });
        });

        it('should reject NOTIFY=NEVER combined with other values', function (done) {
            let server = new SMTPServer({
                hideDSN: false,
                onMailFrom(address, session, callback) {
                    callback();
                },
                onRcptTo(address, session, callback) {
                    callback();
                }
            });

            let mockConnection = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            });

            mockConnection._resetSession();
            mockConnection.openingCommand = 'EHLO';
            mockConnection.session.envelope.mailFrom = { address: 'test@example.com' };

            let sentResponse = null;
            mockConnection.send = function (code, message) {
                sentResponse = { code, message };
            };

            mockConnection.handler_RCPT('RCPT TO:<recipient@example.com> NOTIFY=NEVER,SUCCESS', function () {
                expect(sentResponse).to.exist;
                expect(sentResponse.code).to.equal(501);
                expect(sentResponse.message).to.include('NOTIFY=NEVER cannot be combined with other values');
                done();
            });
        });

        it('should accept ORCPT parameter', function (done) {
            let server = new SMTPServer({
                hideDSN: false,
                onMailFrom(address, session, callback) {
                    callback();
                },
                onRcptTo(address, session, callback) {
                    expect(address.dsn.orcpt).to.equal('rfc822;original@example.com');
                    expect(address.args.ORCPT).to.equal('rfc822;original@example.com');
                    callback();
                }
            });

            let mockConnection = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            });

            mockConnection._resetSession();
            mockConnection.openingCommand = 'EHLO';
            mockConnection.session.envelope.mailFrom = { address: 'test@example.com' };

            let sentResponse = null;
            mockConnection.send = function (code, message) {
                sentResponse = { code, message };
            };

            mockConnection.handler_RCPT('RCPT TO:<recipient@example.com> ORCPT=rfc822;original@example.com', function () {
                expect(sentResponse).to.exist;
                expect(sentResponse.code).to.equal(250);
                done();
            });
        });
    });
});
