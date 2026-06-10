/* eslint no-unused-expressions:0, prefer-arrow-callback: 0 */

'use strict';

const chai = require('chai');
const Client = require('nodemailer/lib/smtp-connection');
const XOAuth2 = require('nodemailer/lib/xoauth2');
const SMTPServer = require('../lib/smtp-server').SMTPServer;
const SMTPConnection = require('../lib/smtp-connection').SMTPConnection;
const net = require('net');
const pem = require('pem');

const expect = chai.expect;
const fs = require('fs');

chai.config.includeStack = true;

describe('SMTPServer', function () {
    this.timeout(10 * 1000); // eslint-disable-line no-invalid-this

    describe('Unit tests', function () {
        describe('Session ID generation', function () {
            it('should generate valid session IDs with correct format', function () {
                let conn = new SMTPConnection(
                    {
                        options: {}
                    },
                    {}
                );

                // ID should be 16 characters long
                expect(conn.id).to.have.length(16);

                // ID should only contain base32 characters (0-9, a-v)
                expect(conn.id).to.match(/^[0-9a-v]+$/);
            });

            it('should generate unique session IDs', function () {
                let ids = new Set();
                for (let i = 0; i < 100; i++) {
                    let conn = new SMTPConnection(
                        {
                            options: {}
                        },
                        {}
                    );
                    ids.add(conn.id);
                }
                // All 100 IDs should be unique
                expect(ids.size).to.equal(100);
            });

            it('should use provided ID from options', function () {
                let customId = 'mycustomsessionid';
                let conn = new SMTPConnection(
                    {
                        options: {}
                    },
                    {},
                    { id: customId }
                );

                expect(conn.id).to.equal(customId);
            });

            it('should set session.id to match connection id', function () {
                let conn = new SMTPConnection(
                    {
                        options: {}
                    },
                    {}
                );

                expect(conn.session.id).to.equal(conn.id);
            });

            it('should handle edge case of small random values (leading zeros)', function () {
                // Test that IDs are always 16 chars even with small random values
                // by verifying padding works correctly
                for (let i = 0; i < 50; i++) {
                    let conn = new SMTPConnection(
                        {
                            options: {}
                        },
                        {}
                    );
                    expect(conn.id).to.have.length(16);
                    // Verify no undefined or NaN characters
                    expect(conn.id).to.not.include('undefined');
                    expect(conn.id).to.not.include('NaN');
                }
            });
        });

        describe('#_parseAddressCommand', function () {
            it('should parse MAIL FROM/RCPT TO', function () {
                let conn = new SMTPConnection(
                    {
                        options: {}
                    },
                    {}
                );

                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<test@example.com>')).to.deep.equal({
                    address: 'test@example.com',
                    args: false
                });

                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@example.com> SIZE=12345    RET=HDRS  ')).to.deep.equal({
                    address: 'sender@example.com',
                    args: {
                        SIZE: '12345',
                        RET: 'HDRS'
                    }
                });

                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM : <test@example.com>')).to.deep.equal({
                    address: 'test@example.com',
                    args: false
                });

                expect(conn._parseAddressCommand('MAIL TO', 'MAIL FROM:<test@example.com>')).to.be.false;

                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@example.com> CUSTOM=a+ABc+20foo')).to.deep.equal({
                    address: 'sender@example.com',
                    args: {
                        CUSTOM: 'a\xabc foo'
                    }
                });
            });

            it('should parse IPv4 literal addresses', function () {
                let conn = new SMTPConnection(
                    {
                        options: {}
                    },
                    {}
                );

                expect(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[192.168.5.146]>')).to.deep.equal({
                    address: 'test@[192.168.5.146]',
                    args: false
                });

                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@[10.0.0.1]>')).to.deep.equal({
                    address: 'sender@[10.0.0.1]',
                    args: false
                });

                // With additional parameters
                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@[127.0.0.1]> SIZE=1234')).to.deep.equal({
                    address: 'sender@[127.0.0.1]',
                    args: {
                        SIZE: '1234'
                    }
                });
            });

            it('should parse IPv6 literal addresses', function () {
                let conn = new SMTPConnection(
                    {
                        options: {}
                    },
                    {}
                );

                expect(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[IPv6:2001:db8::1]>')).to.deep.equal({
                    address: 'test@[IPv6:2001:db8::1]',
                    args: false
                });

                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@[IPv6:::1]>')).to.deep.equal({
                    address: 'sender@[IPv6:::1]',
                    args: false
                });

                // Case insensitive IPv6 prefix
                expect(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[ipv6:fe80::1]>')).to.deep.equal({
                    address: 'test@[IPv6:fe80::1]',
                    args: false
                });
            });

            it('should reject invalid IP literal addresses', function () {
                let conn = new SMTPConnection(
                    {
                        options: {}
                    },
                    {}
                );

                // Invalid IPv4 (out of range)
                expect(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[999.999.999.999]>')).to.be.false;

                // Invalid IPv4 format
                expect(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[192.168.1]>')).to.be.false;

                // Invalid IPv6
                expect(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[IPv6:invalid]>')).to.be.false;

                // Empty brackets
                expect(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[]>')).to.be.false;

                // Random content in brackets (not a valid IP)
                expect(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[notanip]>')).to.be.false;
            });

            it('should normalize full form IPv6 addresses', function () {
                let conn = new SMTPConnection(
                    {
                        options: {}
                    },
                    {}
                );

                // Full form IPv6 should be normalized to compressed form
                expect(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[IPv6:2001:0db8:0000:0000:0000:0000:0000:0001]>')).to.deep.equal({
                    address: 'test@[IPv6:2001:db8::1]',
                    args: false
                });

                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@[IPv6:0000:0000:0000:0000:0000:0000:0000:0001]>')).to.deep.equal({
                    address: 'sender@[IPv6:::1]',
                    args: false
                });
            });

            it('should accept IPv4-mapped IPv6 addresses', function () {
                let conn = new SMTPConnection(
                    {
                        options: {}
                    },
                    {}
                );

                // IPv4-mapped IPv6 addresses are valid per RFC 4291
                expect(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[IPv6:::ffff:192.168.1.1]>')).to.deep.equal({
                    address: 'test@[IPv6:::ffff:192.168.1.1]',
                    args: false
                });

                // IPv4-mapped in hex form
                expect(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[IPv6:::ffff:c0a8:0101]>')).to.deep.equal({
                    address: 'test@[IPv6:::ffff:c0a8:101]',
                    args: false
                });
            });

            it('should reject malformed addresses by default', function () {
                let conn = new SMTPConnection(
                    {
                        options: {}
                    },
                    {}
                );

                // local part with trailing dot (eg. HPE iLO firmware)
                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<ilo.@example.com>')).to.be.false;

                // leading dot and consecutive dots in local part
                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<.test@example.com>')).to.be.false;
                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<te..st@example.com>')).to.be.false;

                // malformed domain
                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<test@example..com>')).to.be.false;
                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<test@example.com.>')).to.be.false;
                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<test@.example.com>')).to.be.false;
            });

            it('should accept malformed addresses in lenient mode', function () {
                let conn = new SMTPConnection(
                    {
                        options: {
                            lenientAddressParsing: true
                        }
                    },
                    {}
                );

                // local part with trailing dot (eg. HPE iLO firmware)
                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<ilo.@example.com>')).to.deep.equal({
                    address: 'ilo.@example.com',
                    args: false
                });

                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<.te..st.@example..com.> SIZE=12345')).to.deep.equal({
                    address: '.te..st.@example..com.',
                    args: {
                        SIZE: '12345'
                    }
                });

                // length limits are not enforced
                let longLocal = 'a'.repeat(300);
                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<' + longLocal + '@example.com>')).to.deep.equal({
                    address: longLocal + '@example.com',
                    args: false
                });

                // basic structure is still required
                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<test>')).to.be.false;
                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<@example.com>')).to.be.false;
                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<test@>')).to.be.false;
                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:test@example.com')).to.be.false;

                // empty address (null return path) is still allowed
                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<>')).to.deep.equal({
                    address: '',
                    args: false
                });
            });

            it('should reject control and invisible characters in addresses even in lenient mode', function () {
                let strictConn = new SMTPConnection(
                    {
                        options: {}
                    },
                    {}
                );
                let lenientConn = new SMTPConnection(
                    {
                        options: {
                            lenientAddressParsing: true
                        }
                    },
                    {}
                );

                for (let conn of [strictConn, lenientConn]) {
                    // NUL byte in local part
                    expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<te\x00st@example.com>')).to.be.false;

                    // escape and DEL characters in local part
                    expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<te\x1bst@example.com>')).to.be.false;
                    expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<te\x7fst@example.com>')).to.be.false;

                    // C1 control character in local part
                    expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<te\u0085st@example.com>')).to.be.false;

                    // zero-width space and word joiner in domain
                    expect(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@exam\u200Bple.com>')).to.be.false;
                    expect(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@exam\u2060ple.com>')).to.be.false;

                    // zero-width no-break space in domain
                    expect(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@exam\uFEFFple.com>')).to.be.false;
                }
            });

            it('should reject parameter values with control characters', function () {
                let conn = new SMTPConnection(
                    {
                        options: {}
                    },
                    {}
                );

                // raw NUL byte in parameter value
                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<test@example.com> ENVID=ab\x00cd')).to.be.false;

                // CRLF smuggled through xtext encoding
                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<test@example.com> ENVID=ab+0D+0Acd')).to.be.false;

                // properly encoded printable characters are still decoded
                expect(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<test@example.com> ENVID=ab+2Bcd')).to.deep.equal({
                    address: 'test@example.com',
                    args: {
                        ENVID: 'ab+cd'
                    }
                });
            });
        });
    });

    describe('Plaintext server', function () {
        let PORT;
        let server;

        beforeEach(function (done) {
            server = new SMTPServer({
                maxClients: 5,
                logger: false,
                socketTimeout: 2 * 1000
            });
            server.listen(0, '127.0.0.1', err => {
                if (err) return done(err);
                PORT = server.server.address().port;
                done();
            });
        });

        afterEach(function (done) {
            server.close(done);
        });

        it('should connect without TLS', function (done) {
            let connection = new Client({
                port: PORT,
                host: '127.0.0.1',
                ignoreTLS: true
            });

            connection.on('end', done);

            connection.connect(function () {
                connection.quit();
            });
        });

        it('should connect with TLS', function (done) {
            let connection = new Client({
                port: PORT,
                host: '127.0.0.1',
                tls: {
                    rejectUnauthorized: false
                }
            });

            connection.on('end', done);

            connection.connect(function () {
                connection.quit();
            });
        });

        it('open multiple connections', function (done) {
            let limit = 5;
            let disconnected = 0;
            let connected = 0;
            let connections = [];

            let createConnection = function (callback) {
                let connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('error', function (err) {
                    connected++;
                    expect(err).to.not.exist;
                    connection.close();
                });

                connection.on('end', function () {
                    disconnected++;
                    if (disconnected >= limit) {
                        return done();
                    }
                });

                connection.connect(function () {
                    connected++;
                    callback(null, connection);
                });
            };

            let connCb = function (err, conn) {
                expect(err).to.not.exist;
                connections.push(conn);

                if (connected >= limit) {
                    connections.forEach(function (connection) {
                        connection.close();
                    });
                }
            };

            for (let i = 0; i < limit; i++) {
                createConnection(connCb);
            }
        });

        it('should reject too many connections', function (done) {
            let limit = 7;
            let expectedErrors = 2;
            let disconnected = 0;
            let connected = 0;
            let connections = [];

            let createConnection = function (callback) {
                let connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('error', function (err) {
                    connected++;
                    if (!expectedErrors) {
                        expect(err).to.not.exist;
                    } else {
                        expectedErrors--;
                    }
                    connection.close();
                });

                connection.on('end', function () {
                    disconnected++;
                    if (disconnected >= limit) {
                        return done();
                    }
                });

                connection.connect(function () {
                    connected++;
                    callback(null, connection);
                });
            };

            let connCb = function (err, conn) {
                expect(err).to.not.exist;
                connections.push(conn);

                if (connected >= limit) {
                    connections.forEach(function (connection) {
                        connection.close();
                    });
                }
            };

            for (let i = 0; i < limit; i++) {
                createConnection(connCb);
            }
        });

        it('should close on timeout', function (done) {
            let connection = new Client({
                port: PORT,
                host: '127.0.0.1',
                ignoreTLS: true
            });

            connection.on('error', function (err) {
                expect(err).to.exist;
            });

            connection.on('end', done);

            connection.connect(function () {
                // do nothing, wait until timeout occurs
            });
        });

        it('should close on timeout using secure socket', function (done) {
            let connection = new Client({
                port: PORT,
                host: '127.0.0.1',
                tls: {
                    rejectUnauthorized: false
                }
            });

            connection.on('error', function (err) {
                expect(err).to.exist;
            });

            connection.on('end', done);

            connection.connect(function () {
                // do nothing, wait until timeout occurs
            });
        });
    });

    describe('Plaintext server with no connection limit', function () {
        this.timeout(60 * 1000); // eslint-disable-line no-invalid-this

        let PORT = 1336;

        let server = new SMTPServer({
            logger: false,
            socketTimeout: 100 * 1000,
            closeTimeout: 6 * 1000
        });

        beforeEach(function (done) {
            server.listen(PORT, '127.0.0.1', done);
        });

        it('open multiple connections and close all at once', function (done) {
            let limit = 100;
            let cleanClose = 4;

            let disconnected = 0;
            let connected = 0;
            let connections = [];

            let createConnection = function (callback) {
                let connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('error', function (err) {
                    expect(err.responseCode).to.equal(421); // Server shutting down
                });

                connection.on('end', function () {
                    disconnected++;

                    if (disconnected >= limit) {
                        return done();
                    }
                });

                connection.connect(function () {
                    connected++;
                    callback(null, connection);
                });
            };

            let connCb = function (err, conn) {
                expect(err).to.not.exist;
                connections.push(conn);

                if (connected >= limit) {
                    server.close();
                    setTimeout(function () {
                        for (let i = 0; i < cleanClose; i++) {
                            connections[i].quit();
                        }
                    }, 1000);
                } else {
                    createConnection(connCb);
                }
            };

            createConnection(connCb);
        });
    });

    describe('Plaintext server with hidden STARTTLS', function () {
        let PORT;
        let server;

        beforeEach(function (done) {
            server = new SMTPServer({
                maxClients: 5,
                hideSTARTTLS: true,
                logger: false,
                socketTimeout: 2 * 1000
            });
            server.listen(0, '127.0.0.1', err => {
                if (err) return done(err);
                PORT = server.server.address().port;
                done();
            });
        });

        afterEach(function (done) {
            server.close(done);
        });

        it('should connect without TLS', function (done) {
            let connection = new Client({
                port: PORT,
                host: '127.0.0.1'
            });

            connection.on('end', done);

            connection.connect(function () {
                expect(connection.secure).to.be.false;
                connection.quit();
            });
        });

        it('should connect with TLS', function (done) {
            let connection = new Client({
                port: PORT,
                host: '127.0.0.1',
                requireTLS: true,
                tls: {
                    rejectUnauthorized: false
                }
            });

            connection.on('end', done);

            connection.connect(function () {
                expect(connection.secure).to.be.true;
                connection.quit();
            });
        });
    });

    describe('Plaintext server with no STARTTLS', function () {
        let PORT;
        let server;

        beforeEach(function (done) {
            server = new SMTPServer({
                maxClients: 5,
                disabledCommands: ['STARTTLS'],
                logger: false,
                socketTimeout: 2 * 1000,
                onAuth(auth, session, callback) {
                    expect(session.tlsOptions).to.be.false;
                    if (auth.username === 'testuser' && auth.password === 'testpass') {
                        return callback(null, {
                            user: 'userdata'
                        });
                    } else {
                        return callback(null, {
                            message: 'Authentication failed'
                        });
                    }
                }
            });
            server.listen(0, '127.0.0.1', err => {
                if (err) return done(err);
                PORT = server.server.address().port;
                done();
            });
        });

        afterEach(function (done) {
            server.close(done);
        });

        it('should connect without TLS', function (done) {
            let connection = new Client({
                port: PORT,
                host: '127.0.0.1'
            });

            connection.on('end', done);

            connection.connect(function () {
                expect(connection.secure).to.be.false;
                connection.quit();
            });
        });

        it('should not connect with TLS', function (done) {
            let connection = new Client({
                port: PORT,
                host: '127.0.0.1',
                requireTLS: true,
                tls: {
                    rejectUnauthorized: false
                }
            });

            let error;

            connection.on('error', function (err) {
                error = err;
            });

            connection.on('end', function () {
                expect(error).to.exist;
                done();
            });

            connection.connect(function () {
                // should not be called
                expect(false).to.be.true;
                connection.quit();
            });
        });

        it('should close after too many unauthenticated commands', function (done) {
            let connection = new Client({
                port: PORT,
                host: '127.0.0.1',
                ignoreTLS: true
            });

            connection.on('error', function (err) {
                expect(err).to.exist;
            });

            connection.on('end', done);

            connection.connect(function () {
                let looper = function () {
                    connection._currentAction = function () {
                        looper();
                    };
                    connection._sendCommand('NOOP');
                };
                looper();
            });
        });

        it('should close after too many unrecognized commands', function (done) {
            let connection = new Client({
                port: PORT,
                host: '127.0.0.1',
                ignoreTLS: true
            });

            connection.on('error', function (err) {
                expect(err).to.exist;
            });

            connection.on('end', done);

            connection.connect(function () {
                connection.login(
                    {
                        user: 'testuser',
                        pass: 'testpass'
                    },
                    function (err) {
                        expect(err).to.not.exist;

                        let looper = function () {
                            connection._currentAction = function () {
                                looper();
                            };
                            connection._sendCommand('ZOOP');
                        };
                        looper();
                    }
                );
            });
        });

        it('should close connection when command line is too long', function (done) {
            let socket = net.connect(PORT, '127.0.0.1', function () {
                let buffers = [];
                let started = false;
                socket.on('data', function (chunk) {
                    buffers.push(chunk);
                    if (!started) {
                        started = true;
                        // send a large chunk with no newline to trigger maxCommandLength
                        let longData = Buffer.alloc(5 * 1024, 0x41);
                        socket.write(longData);
                    }
                });
                socket.on('end', function () {
                    let data = Buffer.concat(buffers).toString();
                    expect(data).to.include('421');
                    expect(data).to.include('Command line too long');
                    done();
                });
            });
        });

        it('should reject early talker', function (done) {
            let socket = net.connect(PORT, '127.0.0.1', function () {
                let buffers = [];
                socket.on('data', function (chunk) {
                    buffers.push(chunk);
                });
                socket.on('end', function () {
                    let data = Buffer.concat(buffers).toString();
                    expect(/^421 /.test(data)).to.be.true;
                    done();
                });
                socket.write('EHLO FOO\r\n');
            });
        });

        it('should reject HTTP requests', function (done) {
            let socket = net.connect(PORT, '127.0.0.1', function () {
                let buffers = [];
                let started = false;
                socket.on('data', function (chunk) {
                    buffers.push(chunk);

                    if (!started) {
                        started = true;
                        socket.write('GET /path/file.html HTTP/1.0\r\nHost: www.example.com\r\n\r\n');
                    }
                });
                socket.on('end', function () {
                    let data = Buffer.concat(buffers).toString();
                    expect(/^421 /m.test(data)).to.be.true;
                    done();
                });
            });
        });
    });

    describe('Secure server', function () {
        let PORT = 1336;

        let server = new SMTPServer({
            secure: true,
            logger: false
        });

        beforeEach(function (done) {
            server.listen(PORT, '127.0.0.1', done);
        });

        afterEach(function (done) {
            server.close(function () {
                done();
            });
        });

        it('should connect to secure server', function (done) {
            let connection = new Client({
                port: PORT,
                host: '127.0.0.1',
                secure: true,
                tls: {
                    rejectUnauthorized: false
                }
            });

            connection.on('end', done);

            connection.connect(function () {
                connection.quit();
            });
        });
    });

    describe('Secure server with upgrade', function () {
        let PORT = 1336;

        let server = new SMTPServer({
            secure: true,
            needsUpgrade: true,
            logger: false
        });

        beforeEach(function (done) {
            server.listen(PORT, '127.0.0.1', done);
        });

        afterEach(function (done) {
            server.close(function () {
                done();
            });
        });

        it('should connect to secure server', function (done) {
            let connection = new Client({
                port: PORT,
                host: '127.0.0.1',
                secure: true,
                tls: {
                    rejectUnauthorized: false
                }
            });

            connection.on('end', done);

            connection.connect(function () {
                connection.quit();
            });
        });
    });

    describe('Secure server with cert update', function () {
        let PORT = 1336;
        let server;

        beforeEach(function (done) {
            pem.createCertificate({ days: 1, selfSigned: true }, (err, keys) => {
                if (err) {
                    return done(err);
                }

                server = new SMTPServer({
                    secure: true,
                    logger: false,
                    key: keys.serviceKey,
                    cert: keys.certificate
                });

                server.listen(PORT, '127.0.0.1', done);
            });
        });

        afterEach(function (done) {
            server.close(function () {
                done();
            });
        });

        it('should connect to secure server', function (done) {
            let connection = new Client({
                port: PORT,
                host: '127.0.0.1',
                secure: true,
                tls: {
                    rejectUnauthorized: false
                }
            });

            let firstFingerprint;

            connection.connect(() => {
                firstFingerprint = connection._socket.getPeerCertificate().fingerprint;
                connection.quit();
            });

            connection.on('end', () => {
                pem.createCertificate({ days: 1, selfSigned: true }, (err, keys) => {
                    if (err) {
                        return done(err);
                    }

                    server.updateSecureContext({
                        key: keys.serviceKey,
                        cert: keys.certificate
                    });

                    setTimeout(() => {
                        let connection = new Client({
                            port: PORT,
                            host: '127.0.0.1',
                            secure: true,
                            tls: {
                                rejectUnauthorized: false
                            }
                        });

                        connection.connect(() => {
                            let secondFingerprint = connection._socket.getPeerCertificate().fingerprint;
                            expect(firstFingerprint).to.not.equal(secondFingerprint);
                            connection.quit();
                        });

                        connection.on('end', done);
                    }, 1000);
                });
            });
        });
    });

    describe('Authentication tests', function () {
        let PORT;
        let server;

        beforeEach(function (done) {
            server = new SMTPServer({
                maxClients: 5,
                logger: false,
                authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2', 'CRAM-MD5'],
                allowInsecureAuth: true,
                onAuth(auth, session, callback) {
                    expect(session.tlsOptions).to.exist;
                    if (auth.method === 'XOAUTH2') {
                        if (auth.username === 'testuser' && auth.accessToken === 'testtoken') {
                            return callback(null, {
                                user: 'userdata'
                            });
                        } else {
                            return callback(null, {
                                data: {
                                    status: '401',
                                    schemes: 'bearer mac',
                                    scope: 'https://mail.google.com/'
                                }
                            });
                        }
                    } else if (
                        auth.username === 'testuser' &&
                        (auth.method === 'CRAM-MD5' ? auth.validatePassword('testpass') : auth.password === 'testpass')
                    ) {
                        return callback(null, {
                            user: 'userdata'
                        });
                    } else {
                        return callback(null, {
                            message: 'Authentication failed'
                        });
                    }
                }
            });
            server.listen(0, '127.0.0.1', err => {
                if (err) return done(err);
                PORT = server.server.address().port;
                done();
            });
        });

        afterEach(function (done) {
            server.close(done);
        });

        describe('PLAIN', function () {
            it('should authenticate', function (done) {
                let connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('end', done);

                connection.connect(function () {
                    connection.login(
                        {
                            user: 'testuser',
                            pass: 'testpass',
                            method: 'PLAIN'
                        },
                        function (err) {
                            expect(err).to.not.exist;
                            connection.quit();
                        }
                    );
                });
            });

            it('should fail', function (done) {
                let connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('end', done);

                connection.connect(function () {
                    connection.login(
                        {
                            user: 'zzzz',
                            pass: 'yyyy',
                            method: 'PLAIN'
                        },
                        function (err) {
                            expect(err).to.exist;
                            connection.quit();
                        }
                    );
                });
            });
        });

        describe('LOGIN', function () {
            it('should authenticate', function (done) {
                let connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    },
                    logger: false
                });

                connection.on('end', done);

                connection.connect(function () {
                    connection.login(
                        {
                            user: 'testuser',
                            pass: 'testpass',
                            method: 'LOGIN'
                        },
                        function (err) {
                            expect(err).to.not.exist;
                            connection.quit();
                        }
                    );
                });
            });

            it('should authenticate without STARTTLS', function (done) {
                let connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    ignoreTLS: true,
                    logger: false
                });

                connection.on('end', done);

                connection.connect(function () {
                    connection.login(
                        {
                            user: 'testuser',
                            pass: 'testpass',
                            method: 'LOGIN'
                        },
                        function (err) {
                            expect(err).to.not.exist;
                            connection.quit();
                        }
                    );
                });
            });

            it('should fail', function (done) {
                let connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('end', done);

                connection.connect(function () {
                    connection.login(
                        {
                            user: 'zzzz',
                            pass: 'yyyy',
                            method: 'LOGIN'
                        },
                        function (err) {
                            expect(err).to.exist;
                            connection.quit();
                        }
                    );
                });
            });
        });

        describe('XOAUTH2', function () {
            it('should authenticate', function (done) {
                let connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('end', done);

                connection.connect(function () {
                    connection.login(
                        {
                            type: 'oauth2',
                            user: 'testuser',
                            method: 'XOAUTH2',
                            oauth2: new XOAuth2(
                                {
                                    user: 'testuser',
                                    accessToken: 'testtoken'
                                },
                                false
                            )
                        },
                        function (err) {
                            expect(err).to.not.exist;
                            connection.quit();
                        }
                    );
                });
            });

            it('should fail', function (done) {
                let connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('end', done);

                connection.connect(function () {
                    connection.login(
                        {
                            type: 'oauth2',
                            user: 'zzzz',
                            method: 'XOAUTH2',
                            oauth2: new XOAuth2(
                                {
                                    user: 'zzzz',
                                    accessToken: 'testtoken'
                                },
                                false
                            )
                        },
                        function (err) {
                            expect(err).to.exist;
                            connection.quit();
                        }
                    );
                });
            });
        });

        describe('CRAM-MD5', function () {
            it('should authenticate', function (done) {
                let connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('end', done);

                connection.connect(function () {
                    connection.login(
                        {
                            user: 'testuser',
                            pass: 'testpass',
                            method: 'CRAM-MD5'
                        },
                        function (err) {
                            expect(err).to.not.exist;
                            connection.quit();
                        }
                    );
                });
            });

            it('should fail', function (done) {
                let connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('end', done);

                connection.connect(function () {
                    connection.login(
                        {
                            user: 'zzzz',
                            pass: 'yyyy',
                            method: 'CRAM-MD5'
                        },
                        function (err) {
                            expect(err).to.exist;
                            connection.quit();
                        }
                    );
                });
            });
        });
    });

    describe('SASL identity handling', function () {
        let PORT;
        let server;
        let lastAuth;

        beforeEach(function (done) {
            lastAuth = false;
            server = new SMTPServer({
                maxClients: 5,
                logger: false,
                authMethods: ['PLAIN', 'LOGIN'],
                allowInsecureAuth: true,
                onAuth(auth, session, callback) {
                    lastAuth = auth;
                    if (auth.username === 'testuser' && auth.password === 'testpass') {
                        return callback(null, {
                            user: 'userdata'
                        });
                    }
                    return callback(null, {
                        message: 'Authentication failed'
                    });
                }
            });
            server.listen(0, '127.0.0.1', err => {
                if (err) return done(err);
                PORT = server.server.address().port;
                done();
            });
        });

        afterEach(function (done) {
            server.close(done);
        });

        // connects, sends EHLO and then one command after every final response,
        // ending with QUIT. Calls onClose with all collected response data
        function exchange(commands, onClose) {
            commands = ['EHLO example.com'].concat(commands).concat('QUIT');
            let socket = net.connect(PORT, '127.0.0.1', function () {
                let buffers = [];
                let sent = 0;

                socket.on('data', function (chunk) {
                    buffers.push(chunk);
                    let data = Buffer.concat(buffers).toString();
                    // count final response lines (status code not followed by a dash)
                    let finals = (data.match(/^\d{3}(?!-)/gm) || []).length;
                    while (sent < commands.length && finals > sent) {
                        socket.write(commands[sent++] + '\r\n');
                    }
                });

                socket.on('end', function () {
                    onClose(Buffer.concat(buffers).toString());
                });
            });
        }

        it('should fall back to authzid when authcid is empty', function (done) {
            // some clients place the username in the authzid field, eg. testuser\x00\x00testpass
            let token = Buffer.from('testuser\x00\x00testpass').toString('base64');
            exchange(['AUTH PLAIN ' + token], function (data) {
                expect(data).to.include('235 Authentication successful');
                expect(lastAuth.method).to.equal('PLAIN');
                expect(lastAuth.username).to.equal('testuser');
                expect(lastAuth.authcid).to.equal('');
                expect(lastAuth.authzid).to.equal('testuser');
                done();
            });
        });

        it('should expose authzid and authcid for PLAIN', function (done) {
            let token = Buffer.from('admin\x00testuser\x00testpass').toString('base64');
            exchange(['AUTH PLAIN ' + token], function (data) {
                expect(data).to.include('235 Authentication successful');
                expect(lastAuth.method).to.equal('PLAIN');
                expect(lastAuth.username).to.equal('testuser');
                expect(lastAuth.authcid).to.equal('testuser');
                expect(lastAuth.authzid).to.equal('admin');
                done();
            });
        });

        it('should reject PLAIN token with control characters in username', function (done) {
            // CRLF injection attempt through the authzid field
            let token = Buffer.from('attacker\r\nReceived: evil\x00\x00p').toString('base64');
            exchange(['AUTH PLAIN ' + token], function (data) {
                expect(data).to.include('500 Error: invalid userdata');
                // onAuth must never see the poisoned username
                expect(lastAuth).to.equal(false);
                done();
            });
        });

        it('should reject LOGIN username with control characters', function (done) {
            let username = Buffer.from('attacker\r\nReceived: evil').toString('base64');
            exchange(['AUTH LOGIN', username], function (data) {
                expect(data).to.include('500 Error: invalid userdata');
                expect(lastAuth).to.equal(false);
                done();
            });
        });
    });

    describe('Mail tests', function () {
        let PORT;

        let connection;

        let server;

        beforeEach(function (done) {
            server = new SMTPServer({
                maxClients: 5,
                logger: false,
                authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2'],
                size: 1024
            });

            server.onAuth = function (auth, session, callback) {
                if (auth.username === 'testuser' && auth.password === 'testpass') {
                    return callback(null, {
                        user: 'userdata'
                    });
                } else {
                    return callback(null, {
                        message: 'Authentication failed'
                    });
                }
            };

            server.onMailFrom = function (address, session, callback) {
                if (/^deny/i.test(address.address)) {
                    return callback(new Error('Not accepted'));
                }
                callback();
            };

            server.onRcptTo = function (address, session, callback) {
                if (/^deny/i.test(address.address)) {
                    return callback(new Error('Not accepted'));
                }
                callback();
            };

            server.onData = function (stream, session, callback) {
                let chunks = [];
                let chunklen = 0;

                stream.on('data', chunk => {
                    chunks.push(chunk);
                    chunklen += chunk.length;
                });

                stream.on('end', () => {
                    let message = Buffer.concat(chunks, chunklen).toString();
                    let err;

                    if (/^deny/i.test(message)) {
                        return callback(new Error('Not queued'));
                    } else if (stream.sizeExceeded) {
                        err = new Error('Maximum allowed message size 1kB exceeded');
                        err.statusCode = 552;
                        return callback(err);
                    }

                    callback(null, 'Message queued as abcdef'); // accept the message once the stream is ended
                });
            };

            server.listen(0, '127.0.0.1', err => {
                if (err) return done(err);
                PORT = server.server.address().port;
                connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.connect(function () {
                    connection.login(
                        {
                            user: 'testuser',
                            pass: 'testpass'
                        },
                        function (err) {
                            expect(err).to.not.exist;
                            done();
                        }
                    );
                });
            });
        });

        afterEach(function (done) {
            connection.on('end', function () {
                server.close(done);
            });
            connection.close();
        });

        it('should send', function (done) {
            connection.send(
                {
                    from: 'sender@example.com',
                    to: ['recipient@exmaple.com']
                },
                'testmessage',
                function (err, status) {
                    expect(err).to.not.exist;
                    expect(status.accepted.length).to.equal(1);
                    expect(status.rejected.length).to.equal(0);
                    done();
                }
            );
        });

        it('should reject single recipient', function (done) {
            connection.send(
                {
                    from: 'sender@example.com',
                    to: ['recipient@exmaple.com', 'deny-recipient@example.com']
                },
                'testmessage',
                function (err, status) {
                    expect(err).to.not.exist;
                    expect(status.accepted.length).to.equal(1);
                    expect(status.rejected.length).to.equal(1);
                    done();
                }
            );
        });

        it('should reject sender', function (done) {
            connection.send(
                {
                    from: 'deny-sender@example.com',
                    to: ['recipient@exmaple.com']
                },
                'testmessage',
                function (err) {
                    expect(err).to.exist;
                    done();
                }
            );
        });

        it('should reject recipients', function (done) {
            connection.send(
                {
                    from: 'sender@example.com',
                    to: ['deny-recipient@exmaple.com']
                },
                'testmessage',
                function (err) {
                    expect(err).to.exist;
                    done();
                }
            );
        });

        it('should reject message', function (done) {
            connection.send(
                {
                    from: 'sender@example.com',
                    to: ['recipient@exmaple.com']
                },
                'deny-testmessage',
                function (err) {
                    expect(err).to.exist;
                    done();
                }
            );
        });

        it('should reject too big message', function (done) {
            connection.send(
                {
                    from: 'sender@example.com',
                    to: ['recipient@exmaple.com']
                },
                new Array(1000).join('testmessage'),
                function (err) {
                    expect(err).to.exist;
                    done();
                }
            );
        });

        it('should send multiple messages', function (done) {
            connection.send(
                {
                    from: 'sender@example.com',
                    to: ['recipient@exmaple.com']
                },
                'testmessage 1',
                function (err, status) {
                    expect(err).to.not.exist;
                    expect(status.accepted.length).to.equal(1);
                    expect(status.rejected.length).to.equal(0);

                    connection.send(
                        {
                            from: 'sender@example.com',
                            to: ['recipient@exmaple.com']
                        },
                        'testmessage 2',
                        function (err, status) {
                            expect(err).to.not.exist;
                            expect(status.accepted.length).to.equal(1);
                            expect(status.rejected.length).to.equal(0);

                            connection.send(
                                {
                                    from: 'sender@example.com',
                                    to: ['recipient@exmaple.com']
                                },
                                'deny-testmessage',
                                function (err) {
                                    expect(err).to.exist;

                                    connection.send(
                                        {
                                            from: 'sender@example.com',
                                            to: ['recipient@exmaple.com']
                                        },
                                        'testmessage 3',
                                        function (err, status) {
                                            expect(err).to.not.exist;
                                            expect(status.accepted.length).to.equal(1);
                                            expect(status.rejected.length).to.equal(0);
                                            done();
                                        }
                                    );
                                }
                            );
                        }
                    );
                }
            );
        });
    });

    describe('STARTTLS syntax', function () {
        it('should reject STARTTLS command with parameters', function (done) {
            let server = new SMTPServer({
                logger: false
            });

            server.listen(0, '127.0.0.1', function () {
                let PORT = server.server.address().port;
                let socket = net.connect(PORT, '127.0.0.1', function () {
                    let buffers = [];
                    let sentEhlo = false;
                    let sentStarttls = false;
                    let sentQuit = false;

                    socket.on('data', function (chunk) {
                        buffers.push(chunk);
                        let data = Buffer.concat(buffers).toString();

                        if (!sentEhlo && /^220 /m.test(data)) {
                            sentEhlo = true;
                            return socket.write('EHLO example.com\r\n');
                        }

                        if (!sentStarttls && /^250 /m.test(data)) {
                            sentStarttls = true;
                            return socket.write('STARTTLS FOO\r\n');
                        }

                        if (!sentQuit && /^501 /m.test(data)) {
                            sentQuit = true;
                            return socket.write('QUIT\r\n');
                        }
                    });

                    socket.on('end', function () {
                        let data = Buffer.concat(buffers).toString();
                        expect(data).to.include('501 Error: syntax: STARTTLS');
                        // connection must remain usable in plaintext mode after the rejection
                        expect(data).to.include('221 Bye');
                        server.close(done);
                    });
                });
            });
        });
    });

    describe('Lenient address parsing', function () {
        it('should reject a non-compliant sender address by default', function (done) {
            let PORT = 1336;

            let connection;

            let server = new SMTPServer({
                logger: false,
                disabledCommands: ['AUTH', 'STARTTLS']
            });

            server.listen(PORT, '127.0.0.1', function () {
                connection = new Client({
                    port: PORT,
                    host: '127.0.0.1'
                });

                connection.on('end', function () {
                    server.close(done);
                });

                connection.connect(function () {
                    connection.send(
                        {
                            from: 'ilo.@example.com',
                            to: ['recipient@example.com']
                        },
                        'testmessage',
                        function (err) {
                            expect(err).to.exist;
                            expect(err.responseCode).to.equal(501);
                            connection.quit();
                        }
                    );
                });
            });
        });

        it('should accept a non-compliant sender address in lenient mode', function (done) {
            let PORT = 1336;

            let connection;

            let server = new SMTPServer({
                logger: false,
                lenientAddressParsing: true,
                disabledCommands: ['AUTH', 'STARTTLS']
            });

            server.onMailFrom = function (address, session, callback) {
                expect(address.address).to.equal('ilo.@example.com');
                callback();
            };

            server.listen(PORT, '127.0.0.1', function () {
                connection = new Client({
                    port: PORT,
                    host: '127.0.0.1'
                });

                connection.on('end', function () {
                    server.close(done);
                });

                connection.connect(function () {
                    connection.send(
                        {
                            from: 'ilo.@example.com',
                            to: ['recipient@example.com']
                        },
                        'testmessage',
                        function (err, status) {
                            expect(err).to.not.exist;
                            expect(status.accepted.length).to.equal(1);
                            expect(status.rejected.length).to.equal(0);
                            connection.quit();
                        }
                    );
                });
            });
        });
    });

    describe('SMTPUTF8', function () {
        it('should allow addresses with UTF-8 characters', function (done) {
            let utf8Address = 'δοκιμή@παράδειγμα.δοκιμή';
            let PORT = 1336;

            let connection;

            let server = new SMTPServer({
                logger: false,
                disabledCommands: ['AUTH', 'STARTTLS']
            });

            server.onRcptTo = function (address, session, callback) {
                expect(utf8Address).to.equal(address.address);
                callback();
            };

            server.listen(PORT, '127.0.0.1', function () {
                connection = new Client({
                    port: PORT,
                    host: '127.0.0.1'
                });

                connection.on('end', function () {
                    server.close(done);
                });

                connection.connect(function () {
                    connection.send(
                        {
                            from: 'sender@example.com',
                            to: [utf8Address]
                        },
                        'testmessage',
                        function (err, status) {
                            expect(err).to.not.exist;
                            expect(status.accepted.length).to.equal(1);
                            expect(status.rejected.length).to.equal(0);
                            connection.quit();
                        }
                    );
                });
            });
        });
    });

    describe('#onData', function () {
        it('should accept a prematurely called continue callback', function (done) {
            let PORT = 1336;

            let connection;

            let server = new SMTPServer({
                logger: false,
                disabledCommands: ['AUTH', 'STARTTLS']
            });

            server.onData = function (stream, session, callback) {
                const nullDevice = process.platform === 'win32' ? '\\\\.\\NUL' : '/dev/null';
                stream.pipe(fs.createWriteStream(nullDevice));
                callback();
            };

            server.listen(PORT, '127.0.0.1', function () {
                connection = new Client({
                    port: PORT,
                    host: '127.0.0.1'
                });

                connection.on('end', function () {
                    server.close(done);
                });

                connection.connect(function () {
                    connection.send(
                        {
                            from: 'sender@example.com',
                            to: ['receiver@example.com']
                        },
                        new Array(1024 * 1024).join('#'),
                        function (err) {
                            expect(err).to.not.exist;
                            connection.quit();
                        }
                    );
                });
            });
        });
    });

    describe('PROXY server', function () {
        let PORT = 1336;

        let server = new SMTPServer({
            maxClients: 5,
            logger: false,
            useProxy: true,
            onConnect(session, callback) {
                if (session.remoteAddress === '1.2.3.4') {
                    let err = new Error('Blacklisted IP');
                    err.responseCode = 421;
                    return callback(err);
                }
                callback();
            }
        });

        beforeEach(function (done) {
            server.listen(PORT, '127.0.0.1', done);
        });

        afterEach(function (done) {
            server.close(done);
        });

        it('should rewrite remote address value', function (done) {
            let connection = new Client({
                port: PORT,
                host: '127.0.0.1',
                ignoreTLS: true
            });

            connection.on('end', done);

            connection.connect(function () {
                let conn;
                // get first connection
                server.connections.forEach(function (val) {
                    if (!conn) {
                        conn = val;
                    }
                });
                // default remote address should be overriden by the value from the PROXY header
                expect(conn.remoteAddress).to.equal('198.51.100.22');
                expect(conn.remotePort).to.equal(35646);
                connection.quit();
            });

            connection._socket.write('PROXY TCP4 198.51.100.22 203.0.113.7 35646 80\r\n');
        });

        it('should block blacklisted connection', function (done) {
            let socket = net.connect(PORT, '127.0.0.1', function () {
                let buffers = [];
                socket.on('data', function (chunk) {
                    buffers.push(chunk);
                });
                socket.on('end', function () {
                    let data = Buffer.concat(buffers).toString();
                    expect(data.indexOf('421 ')).to.equal(0);
                    expect(data.indexOf('Blacklisted')).to.gte(4);
                    done();
                });
                socket.write('PROXY TCP4 1.2.3.4 203.0.113.7 35646 80\r\n');
            });
        });

        it('should deliver "* BAD" diagnostic before closing on invalid PROXY header', function (done) {
            // A garbage (non-PROXY) header must still receive the diagnostic
            // line: the socket is closed via end() and must not be destroy()ed
            // before that buffered line is flushed to the client.
            let socket = net.connect(PORT, '127.0.0.1', function () {
                let buffers = [];
                socket.on('data', function (chunk) {
                    buffers.push(chunk);
                });
                socket.on('end', function () {
                    let data = Buffer.concat(buffers).toString();
                    expect(data.indexOf('* BAD Invalid PROXY header')).to.equal(0);
                    done();
                });
                socket.write('NOTPROXY garbage line\r\n');
            });
            socket.on('error', function () {});
        });

        it('should not crash when client RSTs before sending PROXY header', function (done) {
            // Regression test: previously the socket inside _handleProxy had
            // no 'error' listener, so a client that reset the connection
            // before the PROXY header arrived bubbled up as an
            // uncaughtException and tore down the process.
            //
            // The deterministic signal is _handleProxy invoking its callback
            // with an error: that means the server saw the broken socket and
            // routed it through the error path instead of crashing.
            let prevHandleProxy = server._handleProxy;

            let onUncaught;
            let onServerError;

            function cleanup() {
                process.removeListener('uncaughtException', onUncaught);
                server.removeListener('error', onServerError);
                server._handleProxy = prevHandleProxy;
            }

            onUncaught = function (err) {
                cleanup();
                done(new Error('uncaughtException leaked from _handleProxy: ' + err.message));
            };

            onServerError = function (err) {
                cleanup();
                done(new Error('server emitted error: ' + err.message));
            };

            process.once('uncaughtException', onUncaught);
            server.on('error', onServerError);

            server._handleProxy = function (sock, cb) {
                return prevHandleProxy.call(this, sock, function (err, opts) {
                    if (err) {
                        cleanup();
                        done();
                        return;
                    }
                    return cb(err, opts);
                });
            };

            let socket = net.connect(PORT, '127.0.0.1', function () {
                // partial header, then force a RST instead of a clean FIN
                socket.write('PROXY TCP4 1.2.3.4');
                if (typeof socket.resetAndDestroy === 'function') {
                    socket.resetAndDestroy();
                } else {
                    socket.destroy(new Error('boom'));
                }
            });
            socket.on('error', function () {
                // expected on the client side
            });
        });

        it('should not invoke onConnect when client closes before PROXY header', function (done) {
            // If the socket FINs before we ever see a newline-terminated PROXY
            // header, the connection should be aborted silently — onConnect
            // must not fire, and the process must not crash.
            let connectFired = false;
            let prevOnConnect = server.options.onConnect;
            server.options.onConnect = function (session, cb) {
                connectFired = true;
                cb();
            };

            // _handleProxy invoking its callback with an error is the
            // deterministic signal: the error and the (erroneous) connect path
            // are mutually exclusive branches of that same callback, so once we
            // see the error we know connect was not taken — no timer needed.
            let prevHandleProxy = server._handleProxy;
            server._handleProxy = function (sock, cb) {
                return prevHandleProxy.call(this, sock, function (err, opts) {
                    if (err) {
                        server.options.onConnect = prevOnConnect;
                        server._handleProxy = prevHandleProxy;
                        expect(connectFired).to.equal(false);
                        done();
                        return;
                    }
                    return cb(err, opts);
                });
            };

            let socket = net.connect(PORT, '127.0.0.1', function () {
                socket.end(); // graceful close, no PROXY header sent
            });
            socket.on('error', function () {});
        });
    });

    describe('Secure PROXY server', function () {
        let PORT = 1336;

        let server = new SMTPServer({
            maxClients: 5,
            logger: false,
            useProxy: true,
            secure: true,
            onConnect(session, callback) {
                if (session.remoteAddress === '1.2.3.4') {
                    let err = new Error('Blacklisted IP');
                    err.responseCode = 421;
                    return callback(err);
                }
                callback();
            }
        });

        beforeEach(function (done) {
            server.listen(PORT, '127.0.0.1', done);
        });

        afterEach(function (done) {
            server.close(done);
        });

        it('should rewrite remote address value', function (done) {
            let connection = new Client({
                port: PORT,
                host: '127.0.0.1',
                tls: {
                    rejectUnauthorized: false
                }
            });

            connection.on('end', done);

            connection.connect(function () {
                let conn;
                // get first connection
                server.connections.forEach(function (val) {
                    if (!conn) {
                        conn = val;
                    }
                });
                // default remote address should be overriden by the value from the PROXY header
                expect(conn.remoteAddress).to.equal('198.51.100.22');
                expect(conn.remotePort).to.equal(35646);
                connection.quit();
            });

            connection._socket.write('PROXY TCP4 198.51.100.22 203.0.113.7 35646 80\r\n');
            connection._upgradeConnection(err => {
                expect(err).to.not.exist;
                // server should respond with greeting after this point
            });
        });
    });

    describe('onClose handler', function () {
        let PORT = 1336;

        it('should detect once a connection is closed', function (done) {
            let closed = 0;
            let total = 50;
            let server = new SMTPServer({
                logger: false,
                onClose(session) {
                    expect(session).to.exist;
                    expect(closed).to.be.lt(total);
                    if (++closed >= total) {
                        server.close(done);
                    }
                }
            });

            server.listen(PORT, '127.0.0.1', function () {
                let createConnection = function () {
                    let connection = new Client({
                        port: PORT,
                        host: '127.0.0.1',
                        ignoreTLS: true
                    });

                    connection.connect(function () {
                        setTimeout(() => connection.quit(), 100);
                    });
                };
                for (let i = 0; i < total; i++) {
                    createConnection();
                }
            });
        });
    });

    describe('onSecure handler', function () {
        let PORT = 1336;

        it('should detect once a connection is established with TLS', function (done) {
            let server;
            pem.createCertificate({ days: 1, selfSigned: true }, (err, keys) => {
                if (err) {
                    return done(err);
                }

                let secureCount = 0;

                server = new SMTPServer({
                    secure: true,
                    logger: false,
                    key: keys.serviceKey,
                    cert: keys.certificate,

                    onSecure(socket, session, done) {
                        expect(session).to.exist;
                        expect(session.servername).to.equal('teretere1');
                        secureCount++;
                        done();
                    }
                });

                server.listen(PORT, '127.0.0.1');

                let connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    secure: true,
                    tls: {
                        rejectUnauthorized: false,
                        servername: 'teretere1'
                    }
                });

                connection.connect(function () {
                    setTimeout(() => {
                        connection.quit();
                        server.close(() => {
                            expect(secureCount).to.equal(1);
                            done();
                        });
                    }, 100);
                });

                connection.on('error', err => {
                    server.close(() => done(err));
                });
            });
        });

        it('should detect once a connection is upgraded to TLS', function (done) {
            let server;
            pem.createCertificate({ days: 1, selfSigned: true }, (err, keys) => {
                if (err) {
                    return done(err);
                }

                let secureCount = 0;

                server = new SMTPServer({
                    secure: false,
                    logger: false,
                    key: keys.serviceKey,
                    cert: keys.certificate,

                    onSecure(socket, session, done) {
                        expect(session).to.exist;
                        expect(session.servername).to.equal('teretere2');
                        secureCount++;
                        done();
                    },
                    onConnect(session, done) {
                        done();
                    }
                });

                server.listen(PORT, '127.0.0.1');

                let connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    secure: false,
                    tls: {
                        rejectUnauthorized: false,
                        servername: 'teretere2'
                    }
                });

                connection.connect(function () {
                    setTimeout(() => {
                        connection.quit();
                        server.close(() => {
                            expect(secureCount).to.equal(1);
                            done();
                        });
                    }, 100);
                });

                connection.on('error', err => {
                    server.close(() => done(err));
                });
            });
        });

        it('onSecure is not triggered for cleartext connections', function (done) {
            let server;
            pem.createCertificate({ days: 1, selfSigned: true }, (err, keys) => {
                if (err) {
                    return done(err);
                }

                let secureCount = 0;

                server = new SMTPServer({
                    secure: false,
                    logger: false,
                    key: keys.serviceKey,
                    cert: keys.certificate,

                    onSecure(socket, session, done) {
                        expect(session).to.exist;
                        expect(session.servername).to.equal('teretere2');
                        secureCount++;
                        done();
                    },

                    onConnect(session, done) {
                        done();
                    }
                });

                server.listen(PORT, '127.0.0.1');

                let connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    secure: false,
                    ignoreTLS: true,
                    tls: {
                        rejectUnauthorized: false,
                        servername: 'teretere2'
                    }
                });

                connection.connect(function () {
                    setTimeout(() => {
                        connection.quit();
                        server.close(() => {
                            expect(secureCount).to.equal(0);
                            done();
                        });
                    }, 100);
                });

                connection.on('error', err => {
                    server.close(() => done(err));
                });
            });
        });
    });
});
