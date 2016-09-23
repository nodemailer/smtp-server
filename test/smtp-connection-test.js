/* eslint no-unused-expressions:0 */
/* globals afterEach, beforeEach, describe, it */

'use strict';

var chai = require('chai');
var Client = require('smtp-connection');
var SMTPServer = require('../lib/smtp-server').SMTPServer;
var SMTPConnection = require('../lib/smtp-connection').SMTPConnection;
var net = require('net');

var expect = chai.expect;
var fs = require('fs');

chai.config.includeStack = true;

describe('SMTPServer', function () {
    this.timeout(10 * 1000); // eslint-disable-line no-invalid-this

    describe('Unit tests', function () {

        describe('#_parseAddressCommand', function () {
            it('should parse MAIL FROM/RCPT TO', function () {
                var conn = new SMTPConnection({
                    options: {}
                }, {});

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
        var PORT = 1336;

        var server = new SMTPServer({
            maxClients: 5,
            logger: false,
            socketTimeout: 2 * 1000
        });

        beforeEach(function (done) {
            server.listen(PORT, '127.0.0.1', done);
        });

        afterEach(function (done) {
            server.close(done);
        });

        it('should connect without TLS', function (done) {
            var connection = new Client({
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
            var connection = new Client({
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
            var limit = 5;
            var disconnected = 0;
            var connected = 0;
            var connections = [];

            var createConnection = function (callback) {
                var connection = new Client({
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

            var connCb = function (err, conn) {
                expect(err).to.not.exist;
                connections.push(conn);

                if (connected >= limit) {
                    connections.forEach(function (connection) {
                        connection.close();
                    });
                }
            };

            for (var i = 0; i < limit; i++) {
                createConnection(connCb);
            }

        });

        it('should reject too many connections', function (done) {
            var limit = 7;
            var expectedErrors = 2;
            var disconnected = 0;
            var connected = 0;
            var connections = [];

            var createConnection = function (callback) {
                var connection = new Client({
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

            var connCb = function (err, conn) {
                expect(err).to.not.exist;
                connections.push(conn);

                if (connected >= limit) {
                    connections.forEach(function (connection) {
                        connection.close();
                    });
                }
            };

            for (var i = 0; i < limit; i++) {
                createConnection(connCb);
            }

        });

        it('should close on timeout', function (done) {
            var connection = new Client({
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
            var connection = new Client({
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

        var PORT = 1336;

        var server = new SMTPServer({
            logger: false,
            socketTimeout: 100 * 1000,
            closeTimeout: 6 * 1000
        });

        beforeEach(function (done) {
            server.listen(PORT, '127.0.0.1', done);
        });

        it('open multiple connections and close all at once', function (done) {
            var limit = 100;
            var cleanClose = 4;

            var disconnected = 0;
            var connected = 0;
            var connections = [];

            var createConnection = function (callback) {
                var connection = new Client({
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

            var connCb = function (err, conn) {
                expect(err).to.not.exist;
                connections.push(conn);

                if (connected >= limit) {
                    server.close();
                    setTimeout(function () {
                        for (var i = 0; i < cleanClose; i++) {
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
        var PORT = 1336;

        var server = new SMTPServer({
            maxClients: 5,
            hideSTARTTLS: true,
            logger: false,
            socketTimeout: 2 * 1000
        });

        beforeEach(function (done) {
            server.listen(PORT, '127.0.0.1', done);
        });

        afterEach(function (done) {
            server.close(done);
        });

        it('should connect without TLS', function (done) {
            var connection = new Client({
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
            var connection = new Client({
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
        var PORT = 1336;

        var server = new SMTPServer({
            maxClients: 5,
            disabledCommands: ['STARTTLS'],
            logger: false,
            socketTimeout: 2 * 1000,
            onAuth: function (auth, session, callback) {
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

        beforeEach(function (done) {
            server.listen(PORT, '127.0.0.1', done);
        });

        afterEach(function (done) {
            server.close(done);
        });

        it('should connect without TLS', function (done) {
            var connection = new Client({
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
            var connection = new Client({
                port: PORT,
                host: '127.0.0.1',
                requireTLS: true,
                tls: {
                    rejectUnauthorized: false
                }
            });

            var error;

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
            var connection = new Client({
                port: PORT,
                host: '127.0.0.1',
                ignoreTLS: true
            });

            connection.on('error', function (err) {
                expect(err).to.exist;
            });

            connection.on('end', done);

            connection.connect(function () {
                var looper = function () {
                    connection._currentAction = function () {
                        looper();
                    };
                    connection._sendCommand('NOOP');
                };
                looper();
            });
        });

        it('should close after too many unrecognized commands', function (done) {
            var connection = new Client({
                port: PORT,
                host: '127.0.0.1',
                ignoreTLS: true
            });

            connection.on('error', function (err) {
                expect(err).to.exist;
            });

            connection.on('end', done);

            connection.connect(function () {
                connection.login({
                    user: 'testuser',
                    pass: 'testpass'
                }, function (err) {
                    expect(err).to.not.exist;

                    var looper = function () {
                        connection._currentAction = function () {
                            looper();
                        };
                        connection._sendCommand('ZOOP');
                    };
                    looper();
                });
            });
        });

        it('should reject early talker', function (done) {
            var socket = net.connect(PORT, '127.0.0.1', function () {
                var buffers = [];
                socket.on('data', function (chunk) {
                    buffers.push(chunk);
                });
                socket.on('end', function () {
                    var data = Buffer.concat(buffers).toString();
                    expect(/^421 /.test(data)).to.be.true;
                    done();
                });
                socket.write('EHLO FOO\r\n');
            });
        });

        it('should reject HTTP requests', function (done) {
            var socket = net.connect(PORT, '127.0.0.1', function () {
                var buffers = [];
                var started = false;
                socket.on('data', function (chunk) {
                    buffers.push(chunk);

                    if (!started) {
                        started = true;
                        socket.write('GET /path/file.html HTTP/1.0\r\nHost: www.example.com\r\n\r\n');
                    }
                });
                socket.on('end', function () {
                    var data = Buffer.concat(buffers).toString();
                    expect(/^421 /m.test(data)).to.be.true;
                    done();
                });
            });
        });

    });

    describe('Secure server', function () {
        var PORT = 1336;

        var server = new SMTPServer({
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
            var connection = new Client({
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

    describe('Authentication tests', function () {
        var PORT = 1336;

        var server = new SMTPServer({
            maxClients: 5,
            logger: false,
            authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2', 'CRAM-MD5'],
            allowInsecureAuth: true,
            onAuth: function (auth, session, callback) {
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
                } else if (auth.username === 'testuser' &&
                    (
                        auth.method === 'CRAM-MD5' ?
                        auth.validatePassword('testpass') :
                        auth.password === 'testpass'
                    )
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

        beforeEach(function (done) {
            server.listen(PORT, '127.0.0.1', done);
        });

        afterEach(function (done) {
            server.close(done);
        });

        describe('PLAIN', function () {

            it('should authenticate', function (done) {
                var connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    },
                    authMethod: 'PLAIN'
                });

                connection.on('end', done);

                connection.connect(function () {
                    connection.login({
                        user: 'testuser',
                        pass: 'testpass'
                    }, function (err) {
                        expect(err).to.not.exist;
                        connection.quit();
                    });
                });
            });

            it('should fail', function (done) {
                var connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    },
                    authMethod: 'PLAIN'
                });

                connection.on('end', done);

                connection.connect(function () {
                    connection.login({
                        user: 'zzzz',
                        pass: 'yyyy'
                    }, function (err) {
                        expect(err).to.exist;
                        connection.quit();
                    });
                });
            });
        });

        describe('LOGIN', function () {

            it('should authenticate', function (done) {
                var connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    },
                    authMethod: 'LOGIN',
                    logger: false
                });

                connection.on('end', done);

                connection.connect(function () {
                    connection.login({
                        user: 'testuser',
                        pass: 'testpass'
                    }, function (err) {
                        expect(err).to.not.exist;
                        connection.quit();
                    });
                });
            });

            it('should authenticate without STARTTLS', function (done) {
                var connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    ignoreTLS: true,
                    authMethod: 'LOGIN',
                    logger: false
                });

                connection.on('end', done);

                connection.connect(function () {
                    connection.login({
                        user: 'testuser',
                        pass: 'testpass'
                    }, function (err) {
                        expect(err).to.not.exist;
                        connection.quit();
                    });
                });
            });

            it('should fail', function (done) {
                var connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    },
                    authMethod: 'LOGIN'
                });

                connection.on('end', done);

                connection.connect(function () {
                    connection.login({
                        user: 'zzzz',
                        pass: 'yyyy'
                    }, function (err) {
                        expect(err).to.exist;
                        connection.quit();
                    });
                });
            });
        });

        describe('XOAUTH2', function () {

            it('should authenticate', function (done) {
                var connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    },
                    authMethod: 'XOAUTH2'
                });

                connection.on('end', done);

                connection.connect(function () {
                    connection.login({
                        user: 'testuser',
                        xoauth2: 'testtoken'
                    }, function (err) {
                        expect(err).to.not.exist;
                        connection.quit();
                    });
                });
            });

            it('should fail', function (done) {
                var connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    },
                    authMethod: 'XOAUTH2'
                });

                connection.on('end', done);

                connection.connect(function () {
                    connection.login({
                        user: 'zzzz',
                        xoauth2: 'testtoken'
                    }, function (err) {
                        expect(err).to.exist;
                        connection.quit();
                    });
                });
            });
        });

        describe('CRAM-MD5', function () {

            it('should authenticate', function (done) {
                var connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    },
                    authMethod: 'CRAM-MD5'
                });

                connection.on('end', done);

                connection.connect(function () {
                    connection.login({
                        user: 'testuser',
                        pass: 'testpass'
                    }, function (err) {
                        expect(err).to.not.exist;
                        connection.quit();
                    });
                });
            });

            it('should fail', function (done) {
                var connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    },
                    authMethod: 'CRAM-MD5'
                });

                connection.on('end', done);

                connection.connect(function () {
                    connection.login({
                        user: 'zzzz',
                        pass: 'yyyy'
                    }, function (err) {
                        expect(err).to.exist;
                        connection.quit();
                    });
                });
            });
        });
    });

    describe('Mail tests', function () {
        var PORT = 1336;

        var connection;

        var server = new SMTPServer({
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
            var chunks = [];
            var chunklen = 0;

            stream.on('data', function (chunk) {
                chunks.push(chunk);
                chunklen += chunk.length;
            }.bind(this));

            stream.on('end', function () {
                var message = Buffer.concat(chunks, chunklen).toString();
                var err;

                if (/^deny/i.test(message)) {
                    return callback(new Error('Not queued'));
                } else if (stream.sizeExceeded) {
                    err = new Error('Maximum allowed message size 1kB exceeded');
                    err.statusCode = 552;
                    return callback(err);
                }

                callback(null, 'Message queued as abcdef'); // accept the message once the stream is ended
            }.bind(this));
        };

        beforeEach(function (done) {
            server.listen(PORT, '127.0.0.1', function () {
                connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.connect(function () {
                    connection.login({
                        user: 'testuser',
                        pass: 'testpass'
                    }, function (err) {
                        expect(err).to.not.exist;
                        done();
                    });
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
            connection.send({
                from: 'sender@example.com',
                to: ['recipient@exmaple.com']
            }, 'testmessage', function (err, status) {
                expect(err).to.not.exist;
                expect(status.accepted.length).to.equal(1);
                expect(status.rejected.length).to.equal(0);
                done();
            });
        });

        it('should reject single recipient', function (done) {
            connection.send({
                from: 'sender@example.com',
                to: ['recipient@exmaple.com', 'deny-recipient@example.com']
            }, 'testmessage', function (err, status) {
                expect(err).to.not.exist;
                expect(status.accepted.length).to.equal(1);
                expect(status.rejected.length).to.equal(1);
                done();
            });
        });

        it('should reject sender', function (done) {
            connection.send({
                from: 'deny-sender@example.com',
                to: ['recipient@exmaple.com']
            }, 'testmessage', function (err) {
                expect(err).to.exist;
                done();
            });
        });

        it('should reject recipients', function (done) {
            connection.send({
                from: 'sender@example.com',
                to: ['deny-recipient@exmaple.com']
            }, 'testmessage', function (err) {
                expect(err).to.exist;
                done();
            });
        });

        it('should reject message', function (done) {
            connection.send({
                from: 'sender@example.com',
                to: ['recipient@exmaple.com']
            }, 'deny-testmessage', function (err) {
                expect(err).to.exist;
                done();
            });
        });

        it('should reject too big message', function (done) {
            connection.send({
                from: 'sender@example.com',
                to: ['recipient@exmaple.com']
            }, new Array(1000).join('testmessage'), function (err) {
                expect(err).to.exist;
                done();
            });
        });

        it('should send multiple messages', function (done) {
            connection.send({
                from: 'sender@example.com',
                to: ['recipient@exmaple.com']
            }, 'testmessage 1', function (err, status) {
                expect(err).to.not.exist;
                expect(status.accepted.length).to.equal(1);
                expect(status.rejected.length).to.equal(0);

                connection.send({
                    from: 'sender@example.com',
                    to: ['recipient@exmaple.com']
                }, 'testmessage 2', function (err, status) {
                    expect(err).to.not.exist;
                    expect(status.accepted.length).to.equal(1);
                    expect(status.rejected.length).to.equal(0);

                    connection.send({
                        from: 'sender@example.com',
                        to: ['recipient@exmaple.com']
                    }, 'deny-testmessage', function (err) {
                        expect(err).to.exist;

                        connection.send({
                            from: 'sender@example.com',
                            to: ['recipient@exmaple.com']
                        }, 'testmessage 3', function (err, status) {
                            expect(err).to.not.exist;
                            expect(status.accepted.length).to.equal(1);
                            expect(status.rejected.length).to.equal(0);
                            done();
                        });
                    });
                });
            });
        });
    });

    describe('SMTPUTF8', function () {
        it('should allow addresses with UTF-8 characters', function (done) {
            var utf8Address = 'δοκιμή@παράδειγμα.δοκιμή';
            var PORT = 1336;

            var connection;

            var server = new SMTPServer({
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
                    connection.send({
                        from: 'sender@example.com',
                        to: [utf8Address]
                    }, 'testmessage', function (err, status) {
                        expect(err).to.not.exist;
                        expect(status.accepted.length).to.equal(1);
                        expect(status.rejected.length).to.equal(0);
                        connection.quit();
                    });
                });
            });
        });
    });

    describe('#onData', function () {
        it('should accept a prematurely called continue callback', function (done) {
            var PORT = 1336;

            var connection;

            var server = new SMTPServer({
                logger: false,
                disabledCommands: ['AUTH', 'STARTTLS']
            });

            server.onData = function (stream, session, callback) {
                stream.pipe(fs.createWriteStream('/dev/null'));
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
                    connection.send({
                        from: 'sender@example.com',
                        to: ['receiver@example.com']
                    }, new Array(1024 * 1024).join('#'), function (err) {
                        expect(err).to.not.exist;
                        connection.quit();
                    });
                });
            });
        });
    });

    describe('PROXY server', function () {
        var PORT = 1336;

        var server = new SMTPServer({
            maxClients: 5,
            logger: false,
            useProxy: true,
            onConnect: function (session, callback) {
                if (session.remoteAddress === '1.2.3.4') {
                    var err = new Error('Blacklisted IP');
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
            var connection = new Client({
                port: PORT,
                host: '127.0.0.1',
                ignoreTLS: true
            });

            connection.on('end', done);

            connection.connect(function () {
                var conn;
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
            var socket = net.connect(PORT, '127.0.0.1', function () {
                var buffers = [];
                socket.on('data', function (chunk) {
                    buffers.push(chunk);
                });
                socket.on('end', function () {
                    var data = Buffer.concat(buffers).toString();
                    expect(data.indexOf('421 ')).to.equal(0);
                    expect(data.indexOf('Blacklisted')).to.gte(4);
                    done();
                });
                socket.write('PROXY TCP4 1.2.3.4 203.0.113.7 35646 80\r\n');
            });
        });
    });

    describe('onClose handler', function () {
        var PORT = 1336;

        it('should detect once a connection is closed', function (done) {
            var closed = 0;
            var total = 50;
            var server = new SMTPServer({
                logger: false,
                onClose: function (session) {
                    expect(session).to.exist;
                    expect(closed).to.be.lt(total);
                    if (++closed >= total) {
                        server.close(done);
                    }
                }
            });

            server.listen(PORT, '127.0.0.1', function () {
                var createConnection = function () {
                    var connection = new Client({
                        port: PORT,
                        host: '127.0.0.1',
                        ignoreTLS: true
                    });

                    connection.connect(function () {
                        setTimeout(connection.quit.bind(connection), 100);
                    });
                };
                for (var i = 0; i < total; i++) {
                    createConnection();
                }
            });
        });
    });
});
