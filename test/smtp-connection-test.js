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
            server.listen(0, '127.0.0.1', (err) => {
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
            server.listen(0, '127.0.0.1', (err) => {
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
            server.listen(0, '127.0.0.1', (err) => {
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
                    } else if (auth.username === 'testuser' && (auth.method === 'CRAM-MD5' ? auth.validatePassword('testpass') : auth.password === 'testpass')) {
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
            server.listen(0, '127.0.0.1', (err) => {
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

            server.listen(0, '127.0.0.1', (err) => {
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
