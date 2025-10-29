/* eslint no-unused-expressions:0 */

'use strict';

const chai = require('chai');
const SMTPServer = require('../lib/smtp-server').SMTPServer;
const SMTPConnection = require('../lib/smtp-connection').SMTPConnection;

const expect = chai.expect;

chai.config.includeStack = true;

describe('MAIL FROM Parameters (BODY, SMTPUTF8, REQUIRETLS)', function () {
    this.timeout(10 * 1000); // eslint-disable-line no-invalid-this

    describe('Unit Tests for Parameter Parsing', function () {
        it('should parse BODY parameter in _parseAddressCommand', () => {
            let conn = new SMTPConnection(
                {
                    options: {}
                },
                {}
            );

            // Test BODY=8BITMIME
            expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@example.com> BODY=8BITMIME')).to.deep.equal({
                address: 'sender@example.com',
                args: {
                    BODY: '8BITMIME'
                }
            });

            // Test BODY=7BIT
            expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@example.com> BODY=7BIT')).to.deep.equal({
                address: 'sender@example.com',
                args: {
                    BODY: '7BIT'
                }
            });
        });

        it('should parse SMTPUTF8 parameter in _parseAddressCommand', () => {
            let conn = new SMTPConnection(
                {
                    options: {}
                },
                {}
            );

            // Test SMTPUTF8 flag
            expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@example.com> SMTPUTF8')).to.deep.equal({
                address: 'sender@example.com',
                args: {
                    SMTPUTF8: true
                }
            });
        });

        it('should parse REQUIRETLS parameter in _parseAddressCommand', () => {
            let conn = new SMTPConnection(
                {
                    options: {}
                },
                {}
            );

            // Test REQUIRETLS flag
            expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@example.com> REQUIRETLS')).to.deep.equal({
                address: 'sender@example.com',
                args: {
                    REQUIRETLS: true
                }
            });
        });

        it('should parse combined parameters', () => {
            let conn = new SMTPConnection(
                {
                    options: {}
                },
                {}
            );

            // Test all three parameters together
            expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@example.com> BODY=8BITMIME SMTPUTF8 REQUIRETLS')).to.deep.equal({
                address: 'sender@example.com',
                args: {
                    BODY: '8BITMIME',
                    SMTPUTF8: true,
                    REQUIRETLS: true
                }
            });
        });
    });

    describe('Session Data Structure', function () {
        it('should initialize parameter fields in session envelope', () => {
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

            expect(conn.session.envelope.bodyType).to.equal('7bit');
            expect(conn.session.envelope.smtpUtf8).to.equal(false);
            expect(conn.session.envelope.requireTLS).to.equal(false);
        });
    });

    describe('EHLO Response', function () {
        it('should include 8BITMIME and SMTPUTF8 in features list', done => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH']
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

            mockConnection.clientHostname = 'test.example.com';
            mockConnection.name = 'test-server';

            let sentResponse = null;
            mockConnection.send = (code, message) => {
                sentResponse = { code, message };
            };

            mockConnection.handler_EHLO('EHLO test.example.com', () => {
                expect(sentResponse).to.exist;
                expect(sentResponse.code).to.equal(250);
                expect(sentResponse.message).to.be.an('array');
                const features = sentResponse.message.slice(1);
                expect(features).to.include('8BITMIME');
                expect(features).to.include('SMTPUTF8');
                done();
            });
        });

        it('should include REQUIRETLS when secure and not hidden', done => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                hideREQUIRETLS: false
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

            mockConnection.clientHostname = 'test.example.com';
            mockConnection.name = 'test-server';
            mockConnection.secure = true; // Simulate TLS connection

            let sentResponse = null;
            mockConnection.send = (code, message) => {
                sentResponse = { code, message };
            };

            mockConnection.handler_EHLO('EHLO test.example.com', () => {
                expect(sentResponse).to.exist;
                expect(sentResponse.code).to.equal(250);
                expect(sentResponse.message).to.be.an('array');
                const features = sentResponse.message.slice(1);
                expect(features).to.include('REQUIRETLS');
                done();
            });
        });

        it('should hide REQUIRETLS by default', done => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH']
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

            mockConnection.clientHostname = 'test.example.com';
            mockConnection.name = 'test-server';
            mockConnection.secure = true; // Simulate TLS connection

            let sentResponse = null;
            mockConnection.send = (code, message) => {
                sentResponse = { code, message };
            };

            mockConnection.handler_EHLO('EHLO test.example.com', () => {
                expect(sentResponse).to.exist;
                expect(sentResponse.code).to.equal(250);
                expect(sentResponse.message).to.be.an('array');
                const features = sentResponse.message.slice(1);
                expect(features).to.not.include('REQUIRETLS');
                done();
            });
        });
    });

    describe('MAIL FROM Parameter Validation', function () {
        it('should accept valid BODY=8BITMIME parameter', done => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                authOptional: true,
                onMailFrom: (address, session, callback) => {
                    expect(session.envelope.bodyType).to.equal('8bitmime');
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
            mockConnection.send = code => {
                expect(code).to.equal(250);
                done();
            };

            mockConnection.handler_MAIL('MAIL FROM:<sender@example.com> BODY=8BITMIME', () => {});
        });

        it('should reject invalid BODY parameter', done => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                authOptional: true
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
            mockConnection.send = (code, message) => {
                expect(code).to.equal(501);
                expect(message).to.include('Invalid BODY parameter');
                done();
            };

            mockConnection.handler_MAIL('MAIL FROM:<sender@example.com> BODY=INVALID', () => {});
        });

        it('should accept SMTPUTF8 parameter', done => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                authOptional: true,
                onMailFrom: (address, session, callback) => {
                    expect(session.envelope.smtpUtf8).to.equal(true);
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
            mockConnection.send = code => {
                expect(code).to.equal(250);
                done();
            };

            mockConnection.handler_MAIL('MAIL FROM:<sender@example.com> SMTPUTF8', () => {});
        });

        it('should reject SMTPUTF8 with value', done => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                authOptional: true
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
            mockConnection.send = (code, message) => {
                expect(code).to.equal(501);
                expect(message).to.include('does not accept a value');
                done();
            };

            mockConnection.handler_MAIL('MAIL FROM:<sender@example.com> SMTPUTF8=YES', () => {});
        });

        it('should accept REQUIRETLS parameter over TLS', done => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                authOptional: true,
                hideREQUIRETLS: false,
                onMailFrom: (address, session, callback) => {
                    expect(session.envelope.requireTLS).to.equal(true);
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
            mockConnection.secure = true; // Simulate TLS connection
            mockConnection.send = code => {
                expect(code).to.equal(250);
                done();
            };

            mockConnection.handler_MAIL('MAIL FROM:<sender@example.com> REQUIRETLS', () => {});
        });

        it('should reject REQUIRETLS without TLS', done => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                authOptional: true,
                hideREQUIRETLS: false
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
            mockConnection.secure = false; // Not secure
            mockConnection.send = (code, message) => {
                expect(code).to.equal(530);
                expect(message).to.include('not permitted on non-TLS');
                done();
            };

            mockConnection.handler_MAIL('MAIL FROM:<sender@example.com> REQUIRETLS', () => {});
        });

        it('should accept combined parameters', done => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                authOptional: true,
                hideREQUIRETLS: false,
                onMailFrom: (address, session, callback) => {
                    expect(session.envelope.bodyType).to.equal('8bitmime');
                    expect(session.envelope.smtpUtf8).to.equal(true);
                    expect(session.envelope.requireTLS).to.equal(true);
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
            mockConnection.secure = true;
            mockConnection.send = code => {
                expect(code).to.equal(250);
                done();
            };

            mockConnection.handler_MAIL('MAIL FROM:<sender@example.com> BODY=8BITMIME SMTPUTF8 REQUIRETLS', () => {});
        });
    });
});
