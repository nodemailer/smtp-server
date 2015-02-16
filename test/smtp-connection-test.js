'use strict';

var chai = require('chai');
var SMTPConnection = require('smtp-connection');
var SMTPServer = require('../lib/smtp-server').SMTPServer;
var expect = chai.expect;
var fs = require('fs');

chai.config.includeStack = true;

describe('SMTPServer', function() {
    this.timeout(10 * 1000);

    describe('Plaintext server', function() {
        var PORT = 1336;

        var server = new SMTPServer({
            maxClients: 5,
            logger: {
                info: function() {},
                debug: function() {},
                error: function() {}
            },
            socketTimeout: 2 * 1000
        });

        beforeEach(function(done) {
            server.listen(PORT, '127.0.0.1', done);
        });

        afterEach(function(done) {
            server.close(done);
        });

        it('should connect without TLS', function(done) {
            var connection = new SMTPConnection({
                port: PORT,
                host: '127.0.0.1',
                ignoreTLS: true
            });

            connection.on('end', done);

            connection.connect(function() {
                connection.quit();
            });
        });

        it('should connect with TLS', function(done) {
            var connection = new SMTPConnection({
                port: PORT,
                host: '127.0.0.1',
                tls: {
                    rejectUnauthorized: false
                }
            });

            connection.on('end', done);

            connection.connect(function() {
                connection.quit();
            });
        });

        it('open multiple connections', function(done) {
            var limit = 5;
            var disconnected = 0;
            var connected = 0;
            var connections = [];

            var createConnection = function(callback) {
                var connection = new SMTPConnection({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('error', function(err) {
                    connected++;
                    expect(err).to.not.exist;
                    connection.close();
                });

                connection.on('end', function() {
                    disconnected++;
                    if (disconnected >= limit) {
                        done();
                    }
                });

                connection.connect(function() {
                    connected++;
                    callback(null, connection);
                });
            };

            var connCb = function(err, conn) {
                expect(err).to.not.exist;
                connections.push(conn);

                if (connected >= limit) {
                    connections.forEach(function(connection) {
                        connection.close();
                    });
                }
            };

            for (var i = 0; i < limit; i++) {
                createConnection(connCb);
            }

        });

        it('should reject too many connections', function(done) {
            var limit = 7;
            var expectedErrors = 2;
            var disconnected = 0;
            var connected = 0;
            var connections = [];

            var createConnection = function(callback) {
                var connection = new SMTPConnection({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('error', function(err) {
                    connected++;
                    if (!expectedErrors) {
                        expect(err).to.not.exist;
                    } else {
                        expectedErrors--;
                    }
                    connection.close();
                });

                connection.on('end', function() {
                    disconnected++;
                    if (disconnected >= limit) {
                        done();
                    }
                });

                connection.connect(function() {
                    connected++;
                    callback(null, connection);
                });
            };

            var connCb = function(err, conn) {
                expect(err).to.not.exist;
                connections.push(conn);

                if (connected >= limit) {
                    connections.forEach(function(connection) {
                        connection.close();
                    });
                }
            };

            for (var i = 0; i < limit; i++) {
                createConnection(connCb);
            }

        });

        it('should close on timeout', function(done) {
            var connection = new SMTPConnection({
                port: PORT,
                host: '127.0.0.1',
                ignoreTLS: true
            });

            connection.on('error', function(err) {
                expect(err).to.exist;
            });

            connection.on('end', done);

            connection.connect(function() {
                // do nothing, wait until timeout occurs
            });
        });

        it('should close on timeout using secure socket', function(done) {
            var connection = new SMTPConnection({
                port: PORT,
                host: '127.0.0.1',
                tls: {
                    rejectUnauthorized: false
                }
            });

            connection.on('error', function(err) {
                expect(err).to.exist;
            });

            connection.on('end', done);

            connection.connect(function() {
                // do nothing, wait until timeout occurs
            });
        });

    });

    describe('Secure server', function() {
        var PORT = 1336;

        var server = new SMTPServer({
            secure: true,
            logger: {
                info: function() {},
                debug: function() {},
                error: function() {}
            }
        });

        beforeEach(function(done) {
            server.listen(PORT, '127.0.0.1', done);
        });

        afterEach(function(done) {
            server.close(function() {
                done();
            });
        });

        it('should connect to secure server', function(done) {
            var connection = new SMTPConnection({
                port: PORT,
                host: '127.0.0.1',
                secure: true,
                tls: {
                    rejectUnauthorized: false
                }
            });

            connection.on('end', done);

            connection.connect(function() {
                connection.quit();
            });
        });
    });

    describe('Authentication tests', function() {
        var PORT = 1336;

        var server = new SMTPServer({
            maxClients: 5,
            logger: {
                info: function() {},
                debug: function() {},
                error: function() {}
            },
            authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2']
        });

        server.onAuth = function(auth, session, callback) {
            if (auth.method === 'XOAUTH2') {
                if (auth.username === 'testuser' && auth.accessToken === 'testtoken') {
                    callback(null, {
                        user: 'userdata'
                    });
                } else {
                    callback(null, {
                        data: {
                            status: '401',
                            schemes: 'bearer mac',
                            scope: 'https://mail.google.com/'
                        }
                    });
                }
            } else if (auth.username === 'testuser' && auth.password === 'testpass') {
                callback(null, {
                    user: 'userdata'
                });
            } else {
                callback(null, {
                    message: 'Authentication failed'
                });
            }
        };

        beforeEach(function(done) {
            server.listen(PORT, '127.0.0.1', done);
        });

        afterEach(function(done) {
            server.close(done);
        });

        describe('PLAIN', function() {

            it('should authenticate', function(done) {
                var connection = new SMTPConnection({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    },
                    authMethod: 'PLAIN'
                });

                connection.on('end', done);

                connection.connect(function() {
                    connection.login({
                        user: 'testuser',
                        pass: 'testpass'
                    }, function(err) {
                        expect(err).to.not.exist;
                        connection.quit();
                    });
                });
            });

            it('should fail', function(done) {
                var connection = new SMTPConnection({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    },
                    authMethod: 'PLAIN'
                });

                connection.on('end', done);

                connection.connect(function() {
                    connection.login({
                        user: 'zzzz',
                        pass: 'yyyy'
                    }, function(err) {
                        expect(err).to.exist;
                        connection.quit();
                    });
                });
            });
        });

        describe('LOGIN', function() {

            it('should authenticate', function(done) {
                var connection = new SMTPConnection({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    },
                    authMethod: 'LOGIN'
                });

                connection.on('end', done);

                connection.connect(function() {
                    connection.login({
                        user: 'testuser',
                        pass: 'testpass'
                    }, function(err) {
                        expect(err).to.not.exist;
                        connection.quit();
                    });
                });
            });

            it('should fail', function(done) {
                var connection = new SMTPConnection({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    },
                    authMethod: 'LOGIN'
                });

                connection.on('end', done);

                connection.connect(function() {
                    connection.login({
                        user: 'zzzz',
                        pass: 'yyyy'
                    }, function(err) {
                        expect(err).to.exist;
                        connection.quit();
                    });
                });
            });
        });

        describe('XOAUTH2', function() {

            it('should authenticate', function(done) {
                var connection = new SMTPConnection({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    },
                    authMethod: 'XOAUTH2'
                });

                connection.on('end', done);

                connection.connect(function() {
                    connection.login({
                        user: 'testuser',
                        xoauth2: 'testtoken'
                    }, function(err) {
                        expect(err).to.not.exist;
                        connection.quit();
                    });
                });
            });

            it('should fail', function(done) {
                var connection = new SMTPConnection({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    },
                    authMethod: 'XOAUTH2'
                });

                connection.on('end', done);

                connection.connect(function() {
                    connection.login({
                        user: 'zzzz',
                        xoauth2: 'testtoken'
                    }, function(err) {
                        expect(err).to.exist;
                        connection.quit();
                    });
                });
            });
        });
    });

    describe('Mail tests', function() {
        var PORT = 1336;

        var connection;

        var server = new SMTPServer({
            maxClients: 5,
            logger: {
                info: function() {},
                debug: function() {},
                error: function() {}
            },
            authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2']
        });

        server.onAuth = function(auth, session, callback) {
            if (auth.username === 'testuser' && auth.password === 'testpass') {
                callback(null, {
                    user: 'userdata'
                });
            } else {
                callback(null, {
                    message: 'Authentication failed'
                });
            }
        };

        server.onMailFrom = function(address, session, callback) {
            if (/^deny/i.test(address.address)) {
                return callback(new Error('Not accepted'));
            }
            callback();
        };

        server.onRcptTo = function(address, session, callback) {
            if (/^deny/i.test(address.address)) {
                return callback(new Error('Not accepted'));
            }
            callback();
        };

        server.onData = function(stream, session, callback) {
            var chunks = [];
            var chunklen = 0;

            stream.on('data', function(chunk) {
                chunks.push(chunk);
                chunklen += chunk.length;
            }.bind(this));

            stream.on('end', function() {
                var message = Buffer.concat(chunks, chunklen).toString();

                if (/^deny/i.test(message)) {
                    callback(new Error('Not queued'));
                } else {
                    callback();
                }
            }.bind(this));
        };

        beforeEach(function(done) {
            server.listen(PORT, '127.0.0.1', function() {
                connection = new SMTPConnection({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.connect(function() {
                    connection.login({
                        user: 'testuser',
                        pass: 'testpass'
                    }, function(err) {
                        expect(err).to.not.exist;
                        done();
                    });
                });
            });
        });

        afterEach(function(done) {
            connection.on('end', function() {
                server.close(done);
            });
            connection.close();
        });

        it('should send', function(done) {
            connection.send({
                from: 'sender@example.com',
                to: ['recipient@exmaple.com']
            }, 'testmessage', function(err, status) {
                expect(err).to.not.exist;
                expect(status.accepted.length).to.equal(1);
                expect(status.rejected.length).to.equal(0);
                done();
            });
        });

        it('should reject single recipient', function(done) {
            connection.send({
                from: 'sender@example.com',
                to: ['recipient@exmaple.com', 'deny-recipient@example.com']
            }, 'testmessage', function(err, status) {
                expect(err).to.not.exist;
                expect(status.accepted.length).to.equal(1);
                expect(status.rejected.length).to.equal(1);
                done();
            });
        });

        it('should reject sender', function(done) {
            connection.send({
                from: 'deny-sender@example.com',
                to: ['recipient@exmaple.com']
            }, 'testmessage', function(err) {
                expect(err).to.exist;
                done();
            });
        });

        it('should reject recipients', function(done) {
            connection.send({
                from: 'sender@example.com',
                to: ['deny-recipient@exmaple.com']
            }, 'testmessage', function(err) {
                expect(err).to.exist;
                done();
            });
        });

        it('should reject message', function(done) {
            connection.send({
                from: 'sender@example.com',
                to: ['recipient@exmaple.com']
            }, 'deny-testmessage', function(err) {
                expect(err).to.exist;
                done();
            });
        });

        it('should send multiple messages', function(done) {
            connection.send({
                from: 'sender@example.com',
                to: ['recipient@exmaple.com']
            }, 'testmessage 1', function(err, status) {
                expect(err).to.not.exist;
                expect(status.accepted.length).to.equal(1);
                expect(status.rejected.length).to.equal(0);

                connection.send({
                    from: 'sender@example.com',
                    to: ['recipient@exmaple.com']
                }, 'testmessage 2', function(err, status) {
                    expect(err).to.not.exist;
                    expect(status.accepted.length).to.equal(1);
                    expect(status.rejected.length).to.equal(0);

                    connection.send({
                        from: 'sender@example.com',
                        to: ['recipient@exmaple.com']
                    }, 'deny-testmessage', function(err) {
                        expect(err).to.exist;

                        connection.send({
                            from: 'sender@example.com',
                            to: ['recipient@exmaple.com']
                        }, 'testmessage 3', function(err, status) {
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

    describe('SMTPUTF8', function() {
        it('should allow addresses with UTF-8 characters', function(done) {
            var utf8Address = 'δοκιμή@παράδειγμα.δοκιμή';
            var PORT = 1336;

            var connection;

            var server = new SMTPServer({
                logger: {
                    info: function() {},
                    debug: function() {},
                    error: function() {}
                },
                disabledCommands: ['AUTH', 'STARTTLS']
            });

            server.onRcptTo = function(address, session, callback) {
                expect(utf8Address).to.equal(address.address);
                callback();
            };

            server.listen(PORT, '127.0.0.1', function() {
                connection = new SMTPConnection({
                    port: PORT,
                    host: '127.0.0.1'
                });

                connection.on('end', function() {
                    server.close(done);
                });

                connection.connect(function() {
                    connection.send({
                        from: 'sender@example.com',
                        to: [utf8Address]
                    }, 'testmessage', function(err, status) {
                        expect(err).to.not.exist;
                        expect(status.accepted.length).to.equal(1);
                        expect(status.rejected.length).to.equal(0);
                        connection.quit();
                    });
                });
            });
        });
    });

    describe('#onData', function() {
        it('should accept a prematurely called continue callback', function(done) {
            var PORT = 1336;

            var connection;

            var server = new SMTPServer({
                logger: {
                    info: function() {},
                    debug: function() {},
                    error: function() {}
                },
                disabledCommands: ['AUTH', 'STARTTLS']
            });

            server.onData = function(stream, session, callback) {
                stream.pipe(fs.createWriteStream('/dev/null'));
                callback();
            };

            server.listen(PORT, '127.0.0.1', function() {
                connection = new SMTPConnection({
                    port: PORT,
                    host: '127.0.0.1'
                });

                connection.on('end', function() {
                    server.close(done);
                });

                connection.connect(function() {
                    connection.send({
                        from: 'sender@example.com',
                        to: ['receiver@example.com']
                    }, new Array(1024 * 1024).join('#'), function(err) {
                        expect(err).to.not.exist;
                        connection.quit();
                    });
                });
            });
        });
    });
});