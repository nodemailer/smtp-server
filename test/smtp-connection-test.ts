import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import Client from 'nodemailer/lib/smtp-connection';
import XOAuth2 from 'nodemailer/lib/xoauth2';
import pem from 'pem';
import { SMTPServer } from '../src/smtp-server.js';
import { SMTPConnection } from '../src/smtp-connection.js';
import { driveSocket, chat } from './test-client.js';

describe('SMTPServer', () => {
    describe('Unit tests', () => {
        describe('Session ID generation', () => {
            it('should generate valid session IDs with correct format', () => {
                let conn = new (SMTPConnection as any)(
                    {
                        options: {}
                    },
                    {}
                );

                // ID should be 16 characters long
                assert.strictEqual(conn.id.length, 16);

                // ID should only contain base32 characters (0-9, a-v)
                assert.match(conn.id, /^[0-9a-v]+$/);
            });

            it('should generate unique session IDs', () => {
                let ids = new Set();
                for (let i = 0; i < 100; i++) {
                    let conn = new (SMTPConnection as any)(
                        {
                            options: {}
                        },
                        {}
                    );
                    ids.add(conn.id);
                }
                // All 100 IDs should be unique
                assert.strictEqual(ids.size, 100);
            });

            it('should use provided ID from options', () => {
                let customId = 'mycustomsessionid';
                let conn = new (SMTPConnection as any)(
                    {
                        options: {}
                    },
                    {},
                    { id: customId }
                );

                assert.strictEqual(conn.id, customId);
            });

            it('should set session.id to match connection id', () => {
                let conn = new (SMTPConnection as any)(
                    {
                        options: {}
                    },
                    {}
                );

                assert.strictEqual(conn.session.id, conn.id);
            });

            it('should handle edge case of small random values (leading zeros)', () => {
                // Test that IDs are always 16 chars even with small random values
                // by verifying padding works correctly
                for (let i = 0; i < 50; i++) {
                    let conn = new (SMTPConnection as any)(
                        {
                            options: {}
                        },
                        {}
                    );
                    assert.strictEqual(conn.id.length, 16);
                    // Verify no undefined or NaN characters
                    assert.ok(!conn.id.includes('undefined'));
                    assert.ok(!conn.id.includes('NaN'));
                }
            });
        });

        describe('#_parseAddressCommand', () => {
            it('should parse MAIL FROM/RCPT TO', () => {
                let conn = new (SMTPConnection as any)(
                    {
                        options: {}
                    },
                    {}
                );

                assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<test@example.com>'), {
                    address: 'test@example.com',
                    args: false
                });

                assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@example.com> SIZE=12345    RET=HDRS  '), {
                    address: 'sender@example.com',
                    args: {
                        SIZE: '12345',
                        RET: 'HDRS'
                    }
                });

                assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM : <test@example.com>'), {
                    address: 'test@example.com',
                    args: false
                });

                assert.strictEqual(conn._parseAddressCommand('MAIL TO', 'MAIL FROM:<test@example.com>'), false);

                assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@example.com> CUSTOM=a+ABc+20foo'), {
                    address: 'sender@example.com',
                    args: {
                        CUSTOM: 'a\xabc foo'
                    }
                });
            });

            it('should parse IPv4 literal addresses', () => {
                let conn = new (SMTPConnection as any)(
                    {
                        options: {}
                    },
                    {}
                );

                assert.deepStrictEqual(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[192.168.5.146]>'), {
                    address: 'test@[192.168.5.146]',
                    args: false
                });

                assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@[10.0.0.1]>'), {
                    address: 'sender@[10.0.0.1]',
                    args: false
                });

                // With additional parameters
                assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@[127.0.0.1]> SIZE=1234'), {
                    address: 'sender@[127.0.0.1]',
                    args: {
                        SIZE: '1234'
                    }
                });
            });

            it('should parse IPv6 literal addresses', () => {
                let conn = new (SMTPConnection as any)(
                    {
                        options: {}
                    },
                    {}
                );

                assert.deepStrictEqual(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[IPv6:2001:db8::1]>'), {
                    address: 'test@[IPv6:2001:db8::1]',
                    args: false
                });

                assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@[IPv6:::1]>'), {
                    address: 'sender@[IPv6:::1]',
                    args: false
                });

                // Case insensitive IPv6 prefix
                assert.deepStrictEqual(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[ipv6:fe80::1]>'), {
                    address: 'test@[IPv6:fe80::1]',
                    args: false
                });
            });

            it('should reject invalid IP literal addresses', () => {
                let conn = new (SMTPConnection as any)(
                    {
                        options: {}
                    },
                    {}
                );

                // Invalid IPv4 (out of range)
                assert.strictEqual(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[999.999.999.999]>'), false);

                // Invalid IPv4 format
                assert.strictEqual(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[192.168.1]>'), false);

                // Invalid IPv6
                assert.strictEqual(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[IPv6:invalid]>'), false);

                // Empty brackets
                assert.strictEqual(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[]>'), false);

                // Random content in brackets (not a valid IP)
                assert.strictEqual(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[notanip]>'), false);
            });

            it('should normalize full form IPv6 addresses', () => {
                let conn = new (SMTPConnection as any)(
                    {
                        options: {}
                    },
                    {}
                );

                // Full form IPv6 should be normalized to compressed form
                assert.deepStrictEqual(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[IPv6:2001:0db8:0000:0000:0000:0000:0000:0001]>'), {
                    address: 'test@[IPv6:2001:db8::1]',
                    args: false
                });

                assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@[IPv6:0000:0000:0000:0000:0000:0000:0000:0001]>'), {
                    address: 'sender@[IPv6:::1]',
                    args: false
                });
            });

            it('should accept IPv4-mapped IPv6 addresses', () => {
                let conn = new (SMTPConnection as any)(
                    {
                        options: {}
                    },
                    {}
                );

                // IPv4-mapped IPv6 addresses are valid per RFC 4291
                assert.deepStrictEqual(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[IPv6:::ffff:192.168.1.1]>'), {
                    address: 'test@[IPv6:::ffff:192.168.1.1]',
                    args: false
                });

                // IPv4-mapped in hex form
                assert.deepStrictEqual(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@[IPv6:::ffff:c0a8:0101]>'), {
                    address: 'test@[IPv6:::ffff:c0a8:101]',
                    args: false
                });
            });

            it('should reject malformed addresses by default', () => {
                let conn = new (SMTPConnection as any)(
                    {
                        options: {}
                    },
                    {}
                );

                // local part with trailing dot (eg. HPE iLO firmware)
                assert.strictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<ilo.@example.com>'), false);

                // leading dot and consecutive dots in local part
                assert.strictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<.test@example.com>'), false);
                assert.strictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<te..st@example.com>'), false);

                // malformed domain
                assert.strictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<test@example..com>'), false);
                assert.strictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<test@example.com.>'), false);
                assert.strictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<test@.example.com>'), false);
            });

            it('should accept malformed addresses in lenient mode', () => {
                let conn = new (SMTPConnection as any)(
                    {
                        options: {
                            lenientAddressParsing: true
                        }
                    },
                    {}
                );

                // local part with trailing dot (eg. HPE iLO firmware)
                assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<ilo.@example.com>'), {
                    address: 'ilo.@example.com',
                    args: false
                });

                assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<.te..st.@example..com.> SIZE=12345'), {
                    address: '.te..st.@example..com.',
                    args: {
                        SIZE: '12345'
                    }
                });

                // length limits are not enforced
                let longLocal = 'a'.repeat(300);
                assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<' + longLocal + '@example.com>'), {
                    address: longLocal + '@example.com',
                    args: false
                });

                // basic structure is still required
                assert.strictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<test>'), false);
                assert.strictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<@example.com>'), false);
                assert.strictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<test@>'), false);
                assert.strictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:test@example.com'), false);

                // empty address (null return path) is still allowed
                assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<>'), {
                    address: '',
                    args: false
                });
            });

            it('should reject control and invisible characters in addresses even in lenient mode', () => {
                let strictConn = new (SMTPConnection as any)(
                    {
                        options: {}
                    },
                    {}
                );
                let lenientConn = new (SMTPConnection as any)(
                    {
                        options: {
                            lenientAddressParsing: true
                        }
                    },
                    {}
                );

                for (let conn of [strictConn, lenientConn]) {
                    // NUL byte in local part
                    assert.strictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<te\x00st@example.com>'), false);

                    // escape and DEL characters in local part
                    assert.strictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<te\x1bst@example.com>'), false);
                    assert.strictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<te\x7fst@example.com>'), false);

                    // C1 control character in local part
                    assert.strictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<te\u0085st@example.com>'), false);

                    // zero-width space and word joiner in domain
                    assert.strictEqual(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@exam\u200Bple.com>'), false);
                    assert.strictEqual(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@exam\u2060ple.com>'), false);

                    // zero-width no-break space in domain
                    assert.strictEqual(conn._parseAddressCommand('RCPT TO', 'RCPT TO:<test@exam\uFEFFple.com>'), false);
                }
            });

            it('should reject parameter values with control characters', () => {
                let conn = new (SMTPConnection as any)(
                    {
                        options: {}
                    },
                    {}
                );

                // raw NUL byte in parameter value
                assert.strictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<test@example.com> ENVID=ab\x00cd'), false);

                // CRLF smuggled through xtext encoding
                assert.strictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<test@example.com> ENVID=ab+0D+0Acd'), false);

                // properly encoded printable characters are still decoded
                assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<test@example.com> ENVID=ab+2Bcd'), {
                    address: 'test@example.com',
                    args: {
                        ENVID: 'ab+cd'
                    }
                });
            });
        });
    });

    describe('Plaintext server', () => {
        let PORT: any;
        let server: any;

        beforeEach((t, done) => {
            server = new SMTPServer({
                maxClients: 5,
                logger: false,
                socketTimeout: 2 * 1000
            });
            server.listen(0, '127.0.0.1', (err: any) => {
                if (err) return done(err);
                PORT = (server.server.address() as any).port;
                done();
            });
        });

        afterEach((t, done) => {
            server.close(done);
        });

        it('should connect without TLS', (t, done) => {
            let connection: any = new Client({
                port: PORT,
                host: '127.0.0.1',
                ignoreTLS: true
            });

            connection.on('end', done);

            connection.connect(() => {
                connection.quit();
            });
        });

        it('should connect with TLS', (t, done) => {
            let connection: any = new Client({
                port: PORT,
                host: '127.0.0.1',
                tls: {
                    rejectUnauthorized: false
                }
            });

            connection.on('end', done);

            connection.connect(() => {
                connection.quit();
            });
        });

        it('open multiple connections', (t, done) => {
            let limit = 5;
            let disconnected = 0;
            let connected = 0;
            let connections = [];

            let createConnection = (callback: any) => {
                let connection: any = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('error', (err: any) => {
                    connected++;
                    assert.ok(err === null || err === undefined);
                    connection.close();
                });

                connection.on('end', () => {
                    disconnected++;
                    if (disconnected >= limit) {
                        return done();
                    }
                });

                connection.connect(() => {
                    connected++;
                    callback(null, connection);
                });
            };

            let connCb = (err: any, conn: any) => {
                assert.ok(err === null || err === undefined);
                connections.push(conn);

                if (connected >= limit) {
                    connections.forEach(connection => {
                        connection.close();
                    });
                }
            };

            for (let i = 0; i < limit; i++) {
                createConnection(connCb);
            }
        });

        it('should reject too many connections', (t, done) => {
            let limit = 7;
            let expectedErrors = 2;
            let disconnected = 0;
            let connected = 0;
            let connections = [];

            let createConnection = (callback: any) => {
                let connection: any = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('error', (err: any) => {
                    connected++;
                    if (!expectedErrors) {
                        assert.ok(err === null || err === undefined);
                    } else {
                        expectedErrors--;
                    }
                    connection.close();
                });

                connection.on('end', () => {
                    disconnected++;
                    if (disconnected >= limit) {
                        return done();
                    }
                });

                connection.connect(() => {
                    connected++;
                    callback(null, connection);
                });
            };

            let connCb = (err: any, conn: any) => {
                assert.ok(err === null || err === undefined);
                connections.push(conn);

                if (connected >= limit) {
                    connections.forEach(connection => {
                        connection.close();
                    });
                }
            };

            for (let i = 0; i < limit; i++) {
                createConnection(connCb);
            }
        });

        it('should close on timeout', (t, done) => {
            let connection: any = new Client({
                port: PORT,
                host: '127.0.0.1',
                ignoreTLS: true
            });

            connection.on('error', (err: any) => {
                assert.ok(err !== null && err !== undefined);
            });

            connection.on('end', done);

            connection.connect(() => {
                // do nothing, wait until timeout occurs
            });
        });

        it('should close on timeout using secure socket', (t, done) => {
            let connection: any = new Client({
                port: PORT,
                host: '127.0.0.1',
                tls: {
                    rejectUnauthorized: false
                }
            });

            connection.on('error', (err: any) => {
                assert.ok(err !== null && err !== undefined);
            });

            connection.on('end', done);

            connection.connect(() => {
                // do nothing, wait until timeout occurs
            });
        });
    });

    describe('Plaintext server with no connection limit', () => {
        let PORT: any;

        let server: any = new SMTPServer({
            logger: false,
            socketTimeout: 100 * 1000,
            closeTimeout: 6 * 1000
        });

        beforeEach((t, done) => {
            server.listen(0, '127.0.0.1', () => {
                PORT = (server.server.address() as any).port;
                done();
            });
        });

        it('open multiple connections and close all at once', (t, done) => {
            let limit = 100;
            let cleanClose = 4;

            let disconnected = 0;
            let connected = 0;
            let connections = [];

            let createConnection = (callback: any) => {
                let connection: any = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('error', (err: any) => {
                    assert.strictEqual(err.responseCode, 421); // Server shutting down
                });

                connection.on('end', () => {
                    disconnected++;

                    if (disconnected >= limit) {
                        return done();
                    }
                });

                connection.connect(() => {
                    connected++;
                    callback(null, connection);
                });
            };

            let connCb = (err: any, conn: any) => {
                assert.ok(err === null || err === undefined);
                connections.push(conn);

                if (connected >= limit) {
                    server.close();
                    setTimeout(() => {
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

    describe('Plaintext server with hidden STARTTLS', () => {
        let PORT: any;
        let server: any;

        beforeEach((t, done) => {
            server = new SMTPServer({
                maxClients: 5,
                hideSTARTTLS: true,
                logger: false,
                socketTimeout: 2 * 1000
            });
            server.listen(0, '127.0.0.1', (err: any) => {
                if (err) return done(err);
                PORT = (server.server.address() as any).port;
                done();
            });
        });

        afterEach((t, done) => {
            server.close(done);
        });

        it('should connect without TLS', (t, done) => {
            let connection: any = new Client({
                port: PORT,
                host: '127.0.0.1'
            });

            connection.on('end', done);

            connection.connect(() => {
                assert.strictEqual(connection.secure, false);
                connection.quit();
            });
        });

        it('should connect with TLS', (t, done) => {
            let connection: any = new Client({
                port: PORT,
                host: '127.0.0.1',
                requireTLS: true,
                tls: {
                    rejectUnauthorized: false
                }
            });

            connection.on('end', done);

            connection.connect(() => {
                assert.strictEqual(connection.secure, true);
                connection.quit();
            });
        });
    });

    describe('Plaintext server with no STARTTLS', () => {
        let PORT: any;
        let server: any;

        beforeEach((t, done) => {
            server = new SMTPServer({
                maxClients: 5,
                disabledCommands: ['STARTTLS'],
                logger: false,
                socketTimeout: 2 * 1000,
                onAuth(auth, session, callback) {
                    assert.strictEqual(session.tlsOptions, false);
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
            server.listen(0, '127.0.0.1', (err: any) => {
                if (err) return done(err);
                PORT = (server.server.address() as any).port;
                done();
            });
        });

        afterEach((t, done) => {
            server.close(done);
        });

        it('should connect without TLS', (t, done) => {
            let connection: any = new Client({
                port: PORT,
                host: '127.0.0.1'
            });

            connection.on('end', done);

            connection.connect(() => {
                assert.strictEqual(connection.secure, false);
                connection.quit();
            });
        });

        it('should not connect with TLS', (t, done) => {
            let connection: any = new Client({
                port: PORT,
                host: '127.0.0.1',
                requireTLS: true,
                tls: {
                    rejectUnauthorized: false
                }
            });

            let error: any;

            connection.on('error', (err: any) => {
                error = err;
            });

            connection.on('end', () => {
                assert.ok(error !== null && error !== undefined);
                done();
            });

            connection.connect(() => {
                // should not be called
                assert.strictEqual(false, true);
                connection.quit();
            });
        });

        it('should close after too many unauthenticated commands', (t, done) => {
            let connection: any = new Client({
                port: PORT,
                host: '127.0.0.1',
                ignoreTLS: true
            });

            connection.on('error', (err: any) => {
                assert.ok(err !== null && err !== undefined);
            });

            connection.on('end', done);

            connection.connect(() => {
                let looper = () => {
                    connection._currentAction = () => {
                        looper();
                    };
                    connection._sendCommand('NOOP');
                };
                looper();
            });
        });

        it('should close after too many unrecognized commands', (t, done) => {
            let connection: any = new Client({
                port: PORT,
                host: '127.0.0.1',
                ignoreTLS: true
            });

            connection.on('error', (err: any) => {
                assert.ok(err !== null && err !== undefined);
            });

            connection.on('end', done);

            connection.connect(() => {
                connection.login(
                    {
                        user: 'testuser',
                        pass: 'testpass'
                    },
                    (err: any) => {
                        assert.ok(err === null || err === undefined);

                        let looper = () => {
                            connection._currentAction = () => {
                                looper();
                            };
                            connection._sendCommand('ZOOP');
                        };
                        looper();
                    }
                );
            });
        });

        it('should close connection when command line is too long', (t, done) => {
            let socket = net.connect(PORT, '127.0.0.1', () => {
                let buffers: any = [];
                let started = false;
                socket.on('data', chunk => {
                    buffers.push(chunk);
                    if (!started) {
                        started = true;
                        // send a large chunk with no newline to trigger maxCommandLength
                        let longData = Buffer.alloc(17 * 1024, 0x41);
                        socket.write(longData);
                    }
                });
                socket.on('end', () => {
                    let data = Buffer.concat(buffers).toString();
                    assert.ok(data.includes('421'));
                    assert.ok(data.includes('Command line too long'));
                    done();
                });
            });
        });

        it('should destroy a half-open socket once the socket timeout fires', (t, done) => {
            // after a 421 the server ends its side and waits for the client to close, a
            // client that keeps its side open must not be able to pin the socket forever
            let halfOpenServer: any = new SMTPServer({ logger: false, socketTimeout: 500 });
            halfOpenServer.listen(0, '127.0.0.1', () => {
                let socket = net.connect({ port: (halfOpenServer.server.address() as any).port, host: '127.0.0.1', allowHalfOpen: true }, () => {
                    driveSocket(socket, [Buffer.alloc(17 * 1024, 0x41)] as any, true, (err, lines) => {
                        assert.ok(err === null || err === undefined);
                        assert.ok(lines.pop()!.includes('421'));
                        socket.once('end', () => {
                            // the server has sent its FIN, keep our side open. Closing the
                            // server must not wait for us, only for the socket timeout
                            halfOpenServer.close(() => {
                                socket.destroy();
                                done();
                            });
                        });
                    });
                });
            });
        });

        it('should destroy a closed connection whose client keeps sending', (t, done) => {
            // after QUIT the server ends its side and the client is expected to close. A
            // client that keeps its side open and trickles bytes under the idle timeout
            // used to hold the socket and the parser indefinitely, outside the maxClients
            // limit since the connection no longer counted
            let trickleServer: any = new SMTPServer({ logger: false, socketTimeout: 500, disabledCommands: ['AUTH', 'STARTTLS'] });
            trickleServer.listen(0, '127.0.0.1', () => {
                let socket = net.connect({ port: (trickleServer.server.address() as any).port, host: '127.0.0.1', allowHalfOpen: true });
                socket.on('error', () => false); // the server resets the connection in the end
                driveSocket(socket, ['QUIT\r\n'], true, (err, lines) => {
                    assert.ok(err === null || err === undefined);
                    assert.ok(lines.pop()!.includes('221'));
                    let start = Date.now();
                    let trickle = setInterval(() => socket.write('x'), 50);
                    socket.once('close', () => {
                        clearInterval(trickle);
                        // well before a trickle-reset idle timeout could ever have fired
                        assert.ok(Date.now() - start < 3000);
                        trickleServer.close(done);
                    });
                });
            });
        });

        it('should reject early talker', (t, done) => {
            let socket = net.connect(PORT, '127.0.0.1', () => {
                let buffers: any = [];
                socket.on('data', chunk => {
                    buffers.push(chunk);
                });
                socket.on('end', () => {
                    let data = Buffer.concat(buffers).toString();
                    assert.strictEqual(/^421 /.test(data), true);
                    done();
                });
                socket.write('EHLO FOO\r\n');
            });
        });

        it('should reject HTTP requests', (t, done) => {
            let socket = net.connect(PORT, '127.0.0.1', () => {
                let buffers: any = [];
                let started = false;
                socket.on('data', chunk => {
                    buffers.push(chunk);

                    if (!started) {
                        started = true;
                        socket.write('GET /path/file.html HTTP/1.0\r\nHost: www.example.com\r\n\r\n');
                    }
                });
                socket.on('end', () => {
                    let data = Buffer.concat(buffers).toString();
                    assert.strictEqual(/^421 /m.test(data), true);
                    done();
                });
            });
        });
    });

    describe('Secure server', () => {
        let PORT: any;

        let server: any = new SMTPServer({
            secure: true,
            logger: false
        });

        beforeEach((t, done) => {
            server.listen(0, '127.0.0.1', () => {
                PORT = (server.server.address() as any).port;
                done();
            });
        });

        afterEach((t, done) => {
            server.close(() => {
                done();
            });
        });

        it('should connect to secure server', (t, done) => {
            let connection: any = new Client({
                port: PORT,
                host: '127.0.0.1',
                secure: true,
                tls: {
                    rejectUnauthorized: false
                }
            });

            connection.on('end', done);

            connection.connect(() => {
                connection.quit();
            });
        });
    });

    describe('Secure server with upgrade', () => {
        let PORT: any;

        let server: any = new SMTPServer({
            secure: true,
            needsUpgrade: true,
            logger: false
        });

        beforeEach((t, done) => {
            server.listen(0, '127.0.0.1', () => {
                PORT = (server.server.address() as any).port;
                done();
            });
        });

        afterEach((t, done) => {
            server.close(() => {
                done();
            });
        });

        it('should connect to secure server', (t, done) => {
            let connection: any = new Client({
                port: PORT,
                host: '127.0.0.1',
                secure: true,
                tls: {
                    rejectUnauthorized: false
                }
            });

            connection.on('end', done);

            connection.connect(() => {
                connection.quit();
            });
        });
    });

    describe('Secure server with cert update', () => {
        let PORT: any;
        let server: any;

        beforeEach((t, done) => {
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

                server.listen(0, '127.0.0.1', () => {
                    PORT = (server.server.address() as any).port;
                    done();
                });
            });
        });

        afterEach((t, done) => {
            server.close(() => {
                done();
            });
        });

        it('should connect to secure server', (t, done) => {
            let connection: any = new Client({
                port: PORT,
                host: '127.0.0.1',
                secure: true,
                tls: {
                    rejectUnauthorized: false
                }
            });

            let firstFingerprint: any;

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
                        let connection: any = new Client({
                            port: PORT,
                            host: '127.0.0.1',
                            secure: true,
                            tls: {
                                rejectUnauthorized: false
                            }
                        });

                        connection.connect(() => {
                            let secondFingerprint = connection._socket.getPeerCertificate().fingerprint;
                            assert.notStrictEqual(firstFingerprint, secondFingerprint);
                            connection.quit();
                        });

                        connection.on('end', done);
                    }, 1000);
                });
            });
        });
    });

    describe('Authentication tests', () => {
        let PORT: any;
        let server: any;

        beforeEach((t, done) => {
            server = new SMTPServer({
                maxClients: 5,
                logger: false,
                authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2', 'CRAM-MD5'],
                allowInsecureAuth: true,
                onAuth(auth, session, callback) {
                    assert.ok(session.tlsOptions !== null && session.tlsOptions !== undefined);
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
            server.listen(0, '127.0.0.1', (err: any) => {
                if (err) return done(err);
                PORT = (server.server.address() as any).port;
                done();
            });
        });

        afterEach((t, done) => {
            server.close(done);
        });

        describe('PLAIN', () => {
            it('should authenticate', (t, done) => {
                let connection: any = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('end', done);

                connection.connect(() => {
                    connection.login(
                        {
                            user: 'testuser',
                            pass: 'testpass',
                            method: 'PLAIN'
                        },
                        (err: any) => {
                            assert.ok(err === null || err === undefined);
                            connection.quit();
                        }
                    );
                });
            });

            it('should fail', (t, done) => {
                let connection: any = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('end', done);

                connection.connect(() => {
                    connection.login(
                        {
                            user: 'zzzz',
                            pass: 'yyyy',
                            method: 'PLAIN'
                        },
                        (err: any) => {
                            assert.ok(err !== null && err !== undefined);
                            connection.quit();
                        }
                    );
                });
            });
        });

        describe('LOGIN', () => {
            it('should authenticate', (t, done) => {
                let connection: any = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    },
                    logger: false
                });

                connection.on('end', done);

                connection.connect(() => {
                    connection.login(
                        {
                            user: 'testuser',
                            pass: 'testpass',
                            method: 'LOGIN'
                        },
                        (err: any) => {
                            assert.ok(err === null || err === undefined);
                            connection.quit();
                        }
                    );
                });
            });

            it('should authenticate without STARTTLS', (t, done) => {
                let connection: any = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    ignoreTLS: true,
                    logger: false
                });

                connection.on('end', done);

                connection.connect(() => {
                    connection.login(
                        {
                            user: 'testuser',
                            pass: 'testpass',
                            method: 'LOGIN'
                        },
                        (err: any) => {
                            assert.ok(err === null || err === undefined);
                            connection.quit();
                        }
                    );
                });
            });

            it('should fail', (t, done) => {
                let connection: any = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('end', done);

                connection.connect(() => {
                    connection.login(
                        {
                            user: 'zzzz',
                            pass: 'yyyy',
                            method: 'LOGIN'
                        },
                        (err: any) => {
                            assert.ok(err !== null && err !== undefined);
                            connection.quit();
                        }
                    );
                });
            });
        });

        describe('XOAUTH2', () => {
            it('should authenticate', (t, done) => {
                let connection: any = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('end', done);

                connection.connect(() => {
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
                        (err: any) => {
                            assert.ok(err === null || err === undefined);
                            connection.quit();
                        }
                    );
                });
            });

            it('should fail', (t, done) => {
                let connection: any = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('end', done);

                connection.connect(() => {
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
                        (err: any) => {
                            assert.ok(err !== null && err !== undefined);
                            connection.quit();
                        }
                    );
                });
            });
        });

        describe('CRAM-MD5', () => {
            it('should authenticate', (t, done) => {
                let connection: any = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('end', done);

                connection.connect(() => {
                    connection.login(
                        {
                            user: 'testuser',
                            pass: 'testpass',
                            method: 'CRAM-MD5'
                        },
                        (err: any) => {
                            assert.ok(err === null || err === undefined);
                            connection.quit();
                        }
                    );
                });
            });

            it('should fail', (t, done) => {
                let connection: any = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.on('end', done);

                connection.connect(() => {
                    connection.login(
                        {
                            user: 'zzzz',
                            pass: 'yyyy',
                            method: 'CRAM-MD5'
                        },
                        (err: any) => {
                            assert.ok(err !== null && err !== undefined);
                            connection.quit();
                        }
                    );
                });
            });
        });
    });

    describe('SASL identity handling', () => {
        let PORT: any;
        let server: any;
        let lastAuth: any;

        beforeEach((t, done) => {
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
            server.listen(0, '127.0.0.1', (err: any) => {
                if (err) return done(err);
                PORT = (server.server.address() as any).port;
                done();
            });
        });

        afterEach((t, done) => {
            server.close(done);
        });

        // connects, sends EHLO and then one command after every final response,
        // ending with QUIT. Calls onClose with all collected response data
        function exchange(commands: any, onClose: any) {
            commands = ['EHLO example.com'].concat(commands).concat('QUIT');
            let socket = net.connect(PORT, '127.0.0.1', () => {
                let buffers: any = [];
                let sent = 0;

                socket.on('data', chunk => {
                    buffers.push(chunk);
                    let data = Buffer.concat(buffers).toString();
                    // count final response lines (status code not followed by a dash)
                    let finals = (data.match(/^\d{3}(?!-)/gm) || []).length;
                    while (sent < commands.length && finals > sent) {
                        socket.write(commands[sent++] + '\r\n');
                    }
                });

                socket.on('end', () => {
                    onClose(Buffer.concat(buffers).toString());
                });
            });
        }

        it('should fall back to authzid when authcid is empty', (t, done) => {
            // some clients place the username in the authzid field, eg. testuser\x00\x00testpass
            let token = Buffer.from('testuser\x00\x00testpass').toString('base64');
            exchange(['AUTH PLAIN ' + token], (data: any) => {
                assert.ok(data.includes('235 Authentication successful'));
                assert.strictEqual(lastAuth.method, 'PLAIN');
                assert.strictEqual(lastAuth.username, 'testuser');
                assert.strictEqual(lastAuth.authcid, '');
                assert.strictEqual(lastAuth.authzid, 'testuser');
                done();
            });
        });

        it('should expose authzid and authcid for PLAIN', (t, done) => {
            let token = Buffer.from('admin\x00testuser\x00testpass').toString('base64');
            exchange(['AUTH PLAIN ' + token], (data: any) => {
                assert.ok(data.includes('235 Authentication successful'));
                assert.strictEqual(lastAuth.method, 'PLAIN');
                assert.strictEqual(lastAuth.username, 'testuser');
                assert.strictEqual(lastAuth.authcid, 'testuser');
                assert.strictEqual(lastAuth.authzid, 'admin');
                done();
            });
        });

        it('should reject PLAIN token with control characters in username', (t, done) => {
            // CRLF injection attempt through the authzid field
            let token = Buffer.from('attacker\r\nReceived: evil\x00\x00p').toString('base64');
            exchange(['AUTH PLAIN ' + token], (data: any) => {
                assert.ok(data.includes('501 Error: invalid userdata'));
                // onAuth must never see the poisoned username
                assert.strictEqual(lastAuth, false);
                done();
            });
        });

        it('should reject LOGIN username with control characters', (t, done) => {
            let username = Buffer.from('attacker\r\nReceived: evil').toString('base64');
            exchange(['AUTH LOGIN', username], (data: any) => {
                assert.ok(data.includes('501 Error: invalid userdata'));
                assert.strictEqual(lastAuth, false);
                done();
            });
        });
    });

    describe('Mail tests', () => {
        let PORT;

        let connection: any;

        let server: any;

        beforeEach((t, done) => {
            server = new SMTPServer({
                maxClients: 5,
                logger: false,
                authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2'],
                size: 1024
            });

            server.onAuth = (auth: any, session: any, callback: any) => {
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

            server.onMailFrom = (address: any, session: any, callback: any) => {
                if (/^deny/i.test(address.address)) {
                    return callback(new Error('Not accepted'));
                }
                callback();
            };

            server.onRcptTo = (address: any, session: any, callback: any) => {
                if (/^deny/i.test(address.address)) {
                    return callback(new Error('Not accepted'));
                }
                callback();
            };

            server.onData = (stream: any, session: any, callback: any) => {
                let chunks: any = [];
                let chunklen = 0;

                stream.on('data', (chunk: any) => {
                    chunks.push(chunk);
                    chunklen += chunk.length;
                });

                stream.on('end', () => {
                    let message = Buffer.concat(chunks, chunklen).toString();
                    let err: any;

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

            server.listen(0, '127.0.0.1', (err: any) => {
                if (err) return done(err);
                PORT = (server.server.address() as any).port;
                connection = new Client({
                    port: PORT,
                    host: '127.0.0.1',
                    tls: {
                        rejectUnauthorized: false
                    }
                });

                connection.connect(() => {
                    connection.login(
                        {
                            user: 'testuser',
                            pass: 'testpass'
                        },
                        (err: any) => {
                            assert.ok(err === null || err === undefined);
                            done();
                        }
                    );
                });
            });
        });

        afterEach((t, done) => {
            connection.on('end', () => {
                server.close(done);
            });
            connection.close();
        });

        it('should send', (t, done) => {
            connection.send(
                {
                    from: 'sender@example.com',
                    to: ['recipient@exmaple.com']
                },
                'testmessage',
                (err: any, status: any) => {
                    assert.ok(err === null || err === undefined);
                    assert.strictEqual(status.accepted.length, 1);
                    assert.strictEqual(status.rejected.length, 0);
                    done();
                }
            );
        });

        it('should reject single recipient', (t, done) => {
            connection.send(
                {
                    from: 'sender@example.com',
                    to: ['recipient@exmaple.com', 'deny-recipient@example.com']
                },
                'testmessage',
                (err: any, status: any) => {
                    assert.ok(err === null || err === undefined);
                    assert.strictEqual(status.accepted.length, 1);
                    assert.strictEqual(status.rejected.length, 1);
                    done();
                }
            );
        });

        it('should reject sender', (t, done) => {
            connection.send(
                {
                    from: 'deny-sender@example.com',
                    to: ['recipient@exmaple.com']
                },
                'testmessage',
                (err: any) => {
                    assert.ok(err !== null && err !== undefined);
                    done();
                }
            );
        });

        it('should reject recipients', (t, done) => {
            connection.send(
                {
                    from: 'sender@example.com',
                    to: ['deny-recipient@exmaple.com']
                },
                'testmessage',
                (err: any) => {
                    assert.ok(err !== null && err !== undefined);
                    done();
                }
            );
        });

        it('should reject message', (t, done) => {
            connection.send(
                {
                    from: 'sender@example.com',
                    to: ['recipient@exmaple.com']
                },
                'deny-testmessage',
                (err: any) => {
                    assert.ok(err !== null && err !== undefined);
                    done();
                }
            );
        });

        it('should reject too big message', (t, done) => {
            connection.send(
                {
                    from: 'sender@example.com',
                    to: ['recipient@exmaple.com']
                },
                new Array(1000).join('testmessage'),
                (err: any) => {
                    assert.ok(err !== null && err !== undefined);
                    done();
                }
            );
        });

        it('should send multiple messages', (t, done) => {
            connection.send(
                {
                    from: 'sender@example.com',
                    to: ['recipient@exmaple.com']
                },
                'testmessage 1',
                (err: any, status: any) => {
                    assert.ok(err === null || err === undefined);
                    assert.strictEqual(status.accepted.length, 1);
                    assert.strictEqual(status.rejected.length, 0);

                    connection.send(
                        {
                            from: 'sender@example.com',
                            to: ['recipient@exmaple.com']
                        },
                        'testmessage 2',
                        (err: any, status: any) => {
                            assert.ok(err === null || err === undefined);
                            assert.strictEqual(status.accepted.length, 1);
                            assert.strictEqual(status.rejected.length, 0);

                            connection.send(
                                {
                                    from: 'sender@example.com',
                                    to: ['recipient@exmaple.com']
                                },
                                'deny-testmessage',
                                (err: any) => {
                                    assert.ok(err !== null && err !== undefined);

                                    connection.send(
                                        {
                                            from: 'sender@example.com',
                                            to: ['recipient@exmaple.com']
                                        },
                                        'testmessage 3',
                                        (err: any, status: any) => {
                                            assert.ok(err === null || err === undefined);
                                            assert.strictEqual(status.accepted.length, 1);
                                            assert.strictEqual(status.rejected.length, 0);
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

    describe('STARTTLS syntax', () => {
        it('should reject STARTTLS command with parameters', (t, done) => {
            let server: any = new SMTPServer({
                logger: false
            });

            server.listen(0, '127.0.0.1', () => {
                let PORT = (server.server.address() as any).port;
                let socket = net.connect(PORT, '127.0.0.1', () => {
                    let buffers: any = [];
                    let sentEhlo = false;
                    let sentStarttls = false;
                    let sentQuit = false;

                    socket.on('data', chunk => {
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

                    socket.on('end', () => {
                        let data = Buffer.concat(buffers).toString();
                        assert.ok(data.includes('501 Error: syntax: STARTTLS'));
                        // connection must remain usable in plaintext mode after the rejection
                        assert.ok(data.includes('221 Bye'));
                        server.close(done);
                    });
                });
            });
        });
    });

    describe('STARTTLS', () => {
        let server: any;
        let PORT: any;
        let sockets: any;

        beforeEach((t, done) => {
            sockets = [];
            server = new SMTPServer({
                logger: false,
                allowInsecureAuth: true,
                onAuth(auth, session, callback) {
                    callback(null, { user: auth.username });
                },
                onMailFrom(address, session, callback) {
                    callback();
                }
            });
            server.listen(0, '127.0.0.1', (err: any) => {
                if (err) {
                    return done(err);
                }
                PORT = (server.server.address() as any).port;
                done();
            });
        });

        afterEach((t, done) => {
            sockets.forEach((socket: any) => socket.destroy());
            server.close(done);
        });

        // Runs the plaintext commands, then performs the TLS handshake once the
        // server is ready for it and runs the remaining commands inside the tunnel.
        // Calls back with everything the server sent inside the TLS session.
        //
        // Commands are written verbatim, so a test can pipeline additional data
        // after STARTTLS by including it in that command string
        function starttls(plaintextCommands: any, secureCommands: any, callback: any) {
            let socket = net.connect(PORT, '127.0.0.1');
            sockets.push(socket);
            socket.on('error', callback);

            // driveSocket detaches its own listener once the last plaintext command
            // has been answered, so it can not eat any of the handshake bytes
            driveSocket(socket, plaintextCommands, true, err => {
                if (err) {
                    return callback(err);
                }

                let secureSocket = tls.connect({ socket, rejectUnauthorized: false }, () => driveSocket(secureSocket, secureCommands, false, callback));

                secureSocket.on('error', callback);
                sockets.push(secureSocket);
            });
        }

        it('should discard the pre-TLS EHLO and mail transaction', (t, done) => {
            starttls(
                ['EHLO example.com\r\n', 'MAIL FROM:<sender@example.com>\r\n', 'STARTTLS\r\n'],
                // continue the plaintext transaction without a new EHLO
                ['RCPT TO:<rcpt@example.com>\r\n', 'QUIT\r\n'],
                (err: any, lines: any, data: any) => {
                    if (err) {
                        return done(err);
                    }
                    assert.ok(data.includes('503 Error: send HELO/EHLO first'));
                    done();
                }
            );
        });

        it('should discard an identity authenticated in plaintext', (t, done) => {
            let sessions: any = [];
            server.onMailFrom = (address: any, session: any, callback: any) => {
                sessions.push(session);
                callback();
            };

            starttls(
                ['EHLO example.com\r\n', 'AUTH PLAIN ' + Buffer.from(' insecure pass').toString('base64') + '\r\n', 'STARTTLS\r\n'],
                ['EHLO example.com\r\n', 'MAIL FROM:<sender@example.com>\r\n', 'QUIT\r\n'],
                (err: any, lines: any, data: any) => {
                    if (err) {
                        return done(err);
                    }
                    // the plaintext identity must not carry over into the TLS session
                    assert.ok(data.includes('530 Error: authentication Required'));
                    // and the client must be able to authenticate again
                    assert.ok(data.includes('AUTH '));
                    assert.deepStrictEqual(sessions, []);
                    done();
                }
            );
        });

        it('should not execute plaintext commands pipelined after STARTTLS', (t, done) => {
            starttls(
                // a complete line and a trailing partial line, the partial one used to
                // survive in the parser remainder and get spliced onto the first
                // command received inside the TLS session
                ['EHLO example.com\r\n', 'STARTTLS\r\nNOOP\r\nQUIT '],
                ['NOOP\r\n', 'QUIT\r\n'],
                (err: any, lines: any, data: any) => {
                    if (err) {
                        return done(err);
                    }
                    // "QUIT NOOP" would answer 221, the pipelined NOOP an extra 250 OK
                    assert.strictEqual(data.match(/^250 OK/gm)!.length, 1);
                    assert.ok(data.indexOf('221') > data.indexOf('250 OK'));
                    done();
                }
            );
        });

        it('should discard pipelined plaintext even when the handshake completes while it is still queued', (t, done) => {
            // The parser yields to the event loop every hundred lines, so with enough
            // padding behind STARTTLS the TLS handshake finishes while plaintext lines are
            // still queued. Those used to run inside the TLS session ahead of the client's
            // own commands, as if the TLS client had sent them (STARTTLS command injection).
            // The payload stays below the loopback MTU so that it arrives in one segment
            let injected = 'NOOP\r\n'.repeat(2000) + 'EHLO attacker.example.com\r\nMAIL FROM:<attacker@example.com>\r\n';
            let senders: any = [];
            server.onMailFrom = (address: any, session: any, callback: any) => {
                senders.push(address.address);
                callback();
            };

            starttls(['EHLO example.com\r\n', 'STARTTLS\r\n' + injected], ['EHLO example.com\r\n', 'QUIT\r\n'], (err: any, lines: any, data: any) => {
                if (err) {
                    return done(err);
                }
                // the first thing said inside TLS is the reply to the client's own EHLO,
                // not a NOOP reply or the reply to the injected EHLO
                assert.match(data, /^250-/);
                assert.ok(!data.includes('250 OK'));
                assert.deepStrictEqual(senders, []);
                done();
            });
        });

        it('should not answer plaintext pipelined after STARTTLS on the raw socket', (t, done) => {
            let socket = net.connect(PORT, '127.0.0.1');
            sockets.push(socket);
            socket.on('error', done);

            let data = '';
            let sent = 0;

            socket.on('data', chunk => {
                data += chunk.toString();

                if (sent === 0 && /^220 /m.test(data)) {
                    sent = 1;
                    data = '';
                    return socket.write('EHLO example.com\r\n');
                }

                if (sent === 1 && /^250 /m.test(data)) {
                    sent = 2;
                    data = '';
                    // a payload that every branch of _onCommand above the upgrade
                    // check would answer with a plaintext 421 and then close
                    return socket.write('STARTTLS\r\nGET / HTTP/1.0\r\n');
                }

                if (sent === 2 && /220 Ready to start TLS\r\n/.test(data)) {
                    sent = 3;
                    return setTimeout(() => {
                        // nothing may be written to the raw socket once the
                        // handshake has been announced
                        assert.strictEqual(data, '220 Ready to start TLS\r\n');
                        assert.strictEqual(socket.destroyed, false);
                        done();
                    }, 100);
                }
            });
        });

        it('should not write a socket timeout response onto the raw socket', (t, done) => {
            // the timeout fires from upgrade()'s own setTimeout, so it is not gated by
            // the check in _onCommand and has to be suppressed by send() itself
            let timeoutServer: any = new SMTPServer({ logger: false, authOptional: true, socketTimeout: 500 });

            timeoutServer.listen(0, '127.0.0.1', (err: any) => {
                if (err) {
                    return done(err);
                }

                let socket = net.connect((timeoutServer.server.address() as any).port, '127.0.0.1');
                sockets.push(socket);
                socket.on('error', () => false); // the server drops the connection on timeout

                let data = '';
                let afterUpgrade = '';
                let sent = 0;

                socket.on('data', chunk => {
                    if (sent === 3) {
                        afterUpgrade += chunk.toString();
                        return;
                    }

                    data += chunk.toString();

                    if (sent === 0 && /^220 /m.test(data)) {
                        sent = 1;
                        data = '';
                        return socket.write('EHLO example.com\r\n');
                    }

                    if (sent === 1 && /^250 /m.test(data)) {
                        sent = 2;
                        data = '';
                        return socket.write('STARTTLS\r\n');
                    }

                    if (sent === 2 && /220 Ready to start TLS\r\n/.test(data)) {
                        sent = 3;
                        // begin a handshake and stall, leaving a partial TLS record
                        socket.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x50, 0x01]));

                        return setTimeout(() => {
                            // NB! close before asserting, so that a failure reports the
                            // assertion instead of hanging the suite on a live server
                            timeoutServer.close(() => {
                                assert.strictEqual(afterUpgrade, '');
                                done();
                            });
                        }, 1200);
                    }
                });
            });
        });

        it('should not reset the session when the client renegotiates', (t, done) => {
            let socket = net.connect(PORT, '127.0.0.1');
            sockets.push(socket);
            socket.on('error', done);

            driveSocket(socket, ['EHLO example.com\r\n', 'STARTTLS\r\n'], true, err => {
                if (err) {
                    return done(err);
                }

                // renegotiation only exists up to TLS 1.2
                let secureSocket = tls.connect({ socket, rejectUnauthorized: false, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }, () => {
                    driveSocket(secureSocket, ['EHLO example.com\r\n'], false, err => {
                        if (err) {
                            return done(err);
                        }

                        secureSocket.renegotiate({ rejectUnauthorized: false }, err => {
                            if (err) {
                                // the platform refused to renegotiate, nothing to assert
                                return done();
                            }

                            driveSocket(secureSocket, ['NOOP\r\n', 'MAIL FROM:<sender@example.com>\r\n'], false, (err, lines, data) => {
                                if (err) {
                                    return done(err);
                                }
                                // a second 'secure' event used to re-pipe the socket into
                                // the parser, answering every later command twice
                                assert.strictEqual(data.match(/^250 OK/gm)!.length, 1);
                                // and it used to wipe the EHLO identity mid-session. MAIL
                                // FROM is refused for lack of auth on this server, so a
                                // 530 rather than a 503 shows the identity survived
                                assert.ok(!data.includes('503 Error: send HELO/EHLO first'));
                                assert.ok(data.includes('530 Error: authentication Required'));
                                done();
                            });
                        });
                    });
                });

                secureSocket.on('error', done);
                sockets.push(secureSocket);
            });
        });
    });

    describe('XCLIENT parameter validation', () => {
        let server: any;
        let PORT: any;
        let sockets: any;
        let sessions: any;

        beforeEach((t, done) => {
            sockets = [];
            sessions = [];
            server = new SMTPServer({
                logger: false,
                useXClient: true,
                authOptional: true,
                onMailFrom(address, session, callback) {
                    sessions.push(session);
                    callback();
                }
            });
            server.listen(0, '127.0.0.1', (err: any) => {
                if (err) {
                    return done(err);
                }
                PORT = (server.server.address() as any).port;
                done();
            });
        });

        afterEach((t, done) => {
            sockets.forEach((socket: any) => socket.destroy());
            server.close(done);
        });

        // connects and runs the commands, calling back with the final line of each
        // response. Index 0 is the greeting, so command N is answered by index N+1
        function exchange(commands: any, callback: any) {
            let socket = net.connect(PORT, '127.0.0.1');
            sockets.push(socket);
            socket.on('error', callback);

            driveSocket(
                socket,
                commands.map((command: any) => command + '\r\n'),
                true,
                callback
            );
        }

        it('should reject xtext values with control characters', (t, done) => {
            // +0D+0A decodes to CR LF after xtext decoding
            exchange(['XCLIENT NAME=evil+0D+0Ainjected ADDR=127.0.0.1', 'EHLO example.com', 'MAIL FROM:<sender@example.com>'], (err: any, responses: any) => {
                if (err) {
                    return done(err);
                }
                // the greeting is the first response, XCLIENT the second
                assert.strictEqual(responses[1], '501 Error: Bad command parameter syntax');
                assert.strictEqual(sessions.length, 1);
                assert.ok(!sessions[0].clientHostname.includes('injected'));
                assert.strictEqual(sessions[0].xClient.has('NAME'), false);
                done();
            });
        });

        it('should not apply any parameter of a rejected command', (t, done) => {
            exchange(
                [
                    // ADDR is valid and would be applied before NAME is rejected
                    'XCLIENT ADDR=6.6.6.6 NAME=evil+0Dinjected',
                    'XCLIENT ADDR=198.51.100.22',
                    'EHLO example.com',
                    'MAIL FROM:<sender@example.com>'
                ],
                (err: any, responses: any) => {
                    if (err) {
                        return done(err);
                    }
                    assert.strictEqual(responses[1], '501 Error: Bad command parameter syntax');
                    // the rejected command must not have latched ADDR, otherwise the
                    // retry would be answered with "550 Error: Not allowed"
                    assert.ok(responses[2].includes('220 '));
                    assert.strictEqual(sessions.length, 1);
                    assert.strictEqual(sessions[0].remoteAddress, '198.51.100.22');
                    done();
                }
            );
        });

        it('should reject an invalid ADDR without applying the other parameters', (t, done) => {
            exchange(
                ['XCLIENT NAME=proxied.example.com ADDR=not-an-ip', 'XCLIENT ADDR=198.51.100.22', 'EHLO example.com', 'MAIL FROM:<sender@example.com>'],
                (err: any, responses: any) => {
                    if (err) {
                        return done(err);
                    }
                    assert.strictEqual(responses[1], '501 Error: Bad command parameter syntax. Invalid address');
                    assert.ok(responses[2].includes('220 '));
                    assert.strictEqual(sessions.length, 1);
                    assert.strictEqual(sessions[0].remoteAddress, '198.51.100.22');
                    assert.notStrictEqual(sessions[0].clientHostname, 'proxied.example.com');
                    done();
                }
            );
        });

        it('should pass XCLIENT LOGIN through the default onAuth handler', (t, done) => {
            exchange(['XCLIENT ADDR=198.51.100.22 LOGIN=relayuser', 'EHLO example.com', 'MAIL FROM:<sender@example.com>'], (err: any, responses: any) => {
                if (err) {
                    return done(err);
                }
                // the built-in onAuth answers XCLIENT with a bare callback(), which
                // means "no identity established" and not "authentication failed"
                assert.ok(responses[1].includes('220 '));
                assert.strictEqual(sessions.length, 1);
                assert.ok(!sessions[0].user);
                done();
            });
        });
    });

    describe('Reverse resolved hostname', () => {
        let server: any;
        let sockets: any;

        let observed: any;

        // starts a server whose resolver answers every address with the given PTR
        // value, connects, and calls back once the greeting has been received
        function connectWithPtr(hostname: any, callback: any) {
            server = new SMTPServer({
                logger: false,
                authOptional: true,
                resolver: {
                    reverse: (ip, cb) => cb(null, [hostname])
                },
                onConnect(session, cb) {
                    observed = session.clientHostname;
                    cb();
                }
            });

            server.listen(0, '127.0.0.1', (err: any) => {
                if (err) {
                    return callback(err);
                }
                let socket = net.connect((server.server.address() as any).port, '127.0.0.1');
                sockets.push(socket);
                socket.on('error', callback);

                // no commands, so this returns as soon as the greeting arrives
                driveSocket(socket, [], true, (err, lines, greeting) => callback(err, greeting, observed));
            });
        }

        beforeEach(() => {
            sockets = [];
            observed = undefined;
        });

        afterEach((t, done) => {
            sockets.forEach((socket: any) => socket.destroy());
            server.close(done);
        });

        it('should accept a regular hostname', (t, done) => {
            connectWithPtr('mail.example.com', (err: any, greeting: any, hostname: any) => {
                if (err) {
                    return done(err);
                }
                assert.strictEqual(hostname, 'mail.example.com');
                done();
            });
        });

        it('should accept an underscore in a PTR value', (t, done) => {
            // underscores are not valid in hostnames but real ISPs do publish them
            connectWithPtr('host_name.example.com', (err: any, greeting: any, hostname: any) => {
                if (err) {
                    return done(err);
                }
                assert.strictEqual(hostname, 'host_name.example.com');
                done();
            });
        });

        it('should strip the trailing dot of a root terminated PTR value', (t, done) => {
            connectWithPtr('mail.example.com.', (err: any, greeting: any, hostname: any) => {
                if (err) {
                    return done(err);
                }
                assert.strictEqual(hostname, 'mail.example.com');
                done();
            });
        });

        it('should fall back to the IP address for a PTR value with CRLF', (t, done) => {
            connectWithPtr('evil.example.com\r\n250 injected', (err: any, greeting: any, hostname: any) => {
                if (err) {
                    return done(err);
                }
                assert.strictEqual(hostname, '[127.0.0.1]');
                assert.ok(!greeting.includes('injected'));
                done();
            });
        });

        it('should fall back to the IP address for an overlong PTR value', (t, done) => {
            connectWithPtr('a'.repeat(300) + '.example.com', (err: any, greeting: any, hostname: any) => {
                if (err) {
                    return done(err);
                }
                assert.strictEqual(hostname, '[127.0.0.1]');
                done();
            });
        });
    });

    describe('onAuth callback contract', () => {
        let server: any;
        let socket: any;

        afterEach((t, done) => {
            if (socket) {
                socket.destroy();
            }
            server.close(done);
        });

        // command sequences that reach onAuth for every built-in mechanism
        let flows: Record<string, string[]> = {
            PLAIN: ['AUTH PLAIN ' + Buffer.from('\x00user\x00pass').toString('base64')],
            LOGIN: ['AUTH LOGIN', Buffer.from('user').toString('base64'), Buffer.from('pass').toString('base64')],
            'CRAM-MD5': ['AUTH CRAM-MD5', Buffer.from('user ' + '0123456789abcdef'.repeat(2)).toString('base64')],
            XOAUTH2: ['AUTH XOAUTH2 ' + Buffer.from('user=user\x01auth=Bearer token\x01\x01').toString('base64')]
        };

        // an application may report a failure with a bare callback(), this must
        // produce an ordinary authentication failure and not an internal error
        Object.keys(flows).forEach(method => {
            it('should reject AUTH ' + method + ' when onAuth calls back with nothing', (t, done) => {
                let authenticated = 0;

                server = new SMTPServer({
                    logger: false,
                    allowInsecureAuth: true,
                    authMethods: Object.keys(flows),
                    onAuth(auth, session, callback) {
                        authenticated++;
                        (callback as any)();
                    }
                });

                server.listen(0, '127.0.0.1', (err: any) => {
                    if (err) {
                        return done(err);
                    }
                    socket = net.connect((server.server.address() as any).port, '127.0.0.1');
                    socket.on('error', done);

                    let commands = ['EHLO example.com'].concat(flows[method]).map(command => command + '\r\n');

                    driveSocket(socket, commands, true, (err, lines) => {
                        if (err) {
                            return done(err);
                        }
                        assert.strictEqual(authenticated, 1);
                        // 334 means the mechanism asked for one more round trip (XOAUTH2),
                        // anything else has to be a clean failure and not an internal error
                        let last = lines[lines.length - 1];
                        assert.match(last, /^(334|5\d\d) /);
                        assert.ok(!last.includes('421 '));
                        assert.ok(!last.includes('Cannot read properties'));
                        done();
                    });
                });
            });
        });
    });

    describe('Lenient address parsing', () => {
        it('should reject a non-compliant sender address by default', (t, done) => {
            let PORT;

            let connection: any;

            let server: any = new SMTPServer({
                logger: false,
                disabledCommands: ['AUTH', 'STARTTLS']
            });

            server.listen(0, '127.0.0.1', () => {
                PORT = (server.server.address() as any).port;
                connection = new Client({
                    port: PORT,
                    host: '127.0.0.1'
                });

                connection.on('end', () => {
                    server.close(done);
                });

                connection.connect(() => {
                    connection.send(
                        {
                            from: 'ilo.@example.com',
                            to: ['recipient@example.com']
                        },
                        'testmessage',
                        (err: any) => {
                            assert.ok(err !== null && err !== undefined);
                            assert.strictEqual(err.responseCode, 501);
                            connection.quit();
                        }
                    );
                });
            });
        });

        it('should accept a non-compliant sender address in lenient mode', (t, done) => {
            let PORT;

            let connection: any;

            let server: any = new SMTPServer({
                logger: false,
                lenientAddressParsing: true,
                disabledCommands: ['AUTH', 'STARTTLS']
            });

            server.onMailFrom = (address: any, session: any, callback: any) => {
                assert.strictEqual(address.address, 'ilo.@example.com');
                callback();
            };

            server.listen(0, '127.0.0.1', () => {
                PORT = (server.server.address() as any).port;
                connection = new Client({
                    port: PORT,
                    host: '127.0.0.1'
                });

                connection.on('end', () => {
                    server.close(done);
                });

                connection.connect(() => {
                    connection.send(
                        {
                            from: 'ilo.@example.com',
                            to: ['recipient@example.com']
                        },
                        'testmessage',
                        (err: any, status: any) => {
                            assert.ok(err === null || err === undefined);
                            assert.strictEqual(status.accepted.length, 1);
                            assert.strictEqual(status.rejected.length, 0);
                            connection.quit();
                        }
                    );
                });
            });
        });
    });

    describe('SMTPUTF8', () => {
        it('should allow addresses with UTF-8 characters', (t, done) => {
            let utf8Address = 'δοκιμή@παράδειγμα.δοκιμή';
            let PORT;

            let connection: any;

            let server: any = new SMTPServer({
                logger: false,
                disabledCommands: ['AUTH', 'STARTTLS']
            });

            server.onRcptTo = (address: any, session: any, callback: any) => {
                assert.strictEqual(utf8Address, address.address);
                callback();
            };

            server.listen(0, '127.0.0.1', () => {
                PORT = (server.server.address() as any).port;
                connection = new Client({
                    port: PORT,
                    host: '127.0.0.1'
                });

                connection.on('end', () => {
                    server.close(done);
                });

                connection.connect(() => {
                    connection.send(
                        {
                            from: 'sender@example.com',
                            to: [utf8Address]
                        },
                        'testmessage',
                        (err: any, status: any) => {
                            assert.ok(err === null || err === undefined);
                            assert.strictEqual(status.accepted.length, 1);
                            assert.strictEqual(status.rejected.length, 0);
                            connection.quit();
                        }
                    );
                });
            });
        });
    });

    describe('#onData', () => {
        it('should accept a prematurely called continue callback', (t, done) => {
            let PORT;

            let connection: any;

            let server: any = new SMTPServer({
                logger: false,
                disabledCommands: ['AUTH', 'STARTTLS']
            });

            server.onData = (stream: any, session: any, callback: any) => {
                const nullDevice = process.platform === 'win32' ? '\\\\.\\NUL' : '/dev/null';
                stream.pipe(fs.createWriteStream(nullDevice));
                callback();
            };

            server.listen(0, '127.0.0.1', () => {
                PORT = (server.server.address() as any).port;
                connection = new Client({
                    port: PORT,
                    host: '127.0.0.1'
                });

                connection.on('end', () => {
                    server.close(done);
                });

                connection.connect(() => {
                    connection.send(
                        {
                            from: 'sender@example.com',
                            to: ['receiver@example.com']
                        },
                        new Array(1024 * 1024).join('#'),
                        (err: any) => {
                            assert.ok(err === null || err === undefined);
                            connection.quit();
                        }
                    );
                });
            });
        });
    });

    describe('PROXY server', () => {
        let PORT: any;

        let server: any = new SMTPServer({
            maxClients: 5,
            logger: false,
            useProxy: true,
            onConnect(session, callback) {
                if (session.remoteAddress === '1.2.3.4') {
                    let err: any = new Error('Blacklisted IP');
                    err.responseCode = 421;
                    return callback(err);
                }
                callback();
            }
        });

        beforeEach((t, done) => {
            server.listen(0, '127.0.0.1', () => {
                PORT = (server.server.address() as any).port;
                done();
            });
        });

        afterEach((t, done) => {
            server.close(done);
        });

        it('should rewrite remote address value', (t, done) => {
            let connection: any = new Client({
                port: PORT,
                host: '127.0.0.1',
                ignoreTLS: true
            });

            connection.on('end', done);

            connection.connect(() => {
                let conn: any;
                // get first connection
                server.connections.forEach((val: any) => {
                    if (!conn) {
                        conn = val;
                    }
                });
                // default remote address should be overriden by the value from the PROXY header
                assert.strictEqual(conn.remoteAddress, '198.51.100.22');
                assert.strictEqual(conn.remotePort, 35646);
                connection.quit();
            });

            connection._socket.write('PROXY TCP4 198.51.100.22 203.0.113.7 35646 80\r\n');
        });

        it('should block blacklisted connection', (t, done) => {
            let socket = net.connect(PORT, '127.0.0.1', () => {
                let buffers: any = [];
                socket.on('data', chunk => {
                    buffers.push(chunk);
                });
                socket.on('end', () => {
                    let data = Buffer.concat(buffers).toString();
                    assert.strictEqual(data.indexOf('421 '), 0);
                    assert.ok(data.indexOf('Blacklisted') >= 4);
                    done();
                });
                socket.write('PROXY TCP4 1.2.3.4 203.0.113.7 35646 80\r\n');
            });
        });

        it('should reject a PROXY header whose source address is not an IP', (t, done) => {
            // the address ends up in SMTP responses, logs and Received headers, so a
            // value carrying an embedded CR must never reach the connection
            let socket = net.connect(PORT, '127.0.0.1', () => {
                let buffers: any = [];
                socket.on('data', chunk => {
                    buffers.push(chunk);
                });
                socket.on('end', () => {
                    let data = Buffer.concat(buffers).toString();
                    assert.strictEqual(data.indexOf('* BAD Invalid PROXY header'), 0);
                    assert.ok(!data.includes('220 '));
                    done();
                });
                socket.write('PROXY TCP4 1.2.3\r.4 127.0.0.1 1111 2222\r\n');
            });
            socket.on('error', () => {});
        });

        it('should deliver "* BAD" diagnostic before closing on invalid PROXY header', (t, done) => {
            // A garbage (non-PROXY) header must still receive the diagnostic
            // line: the socket is closed via end() and must not be destroy()ed
            // before that buffered line is flushed to the client.
            let socket = net.connect(PORT, '127.0.0.1', () => {
                let buffers: any = [];
                socket.on('data', chunk => {
                    buffers.push(chunk);
                });
                socket.on('end', () => {
                    let data = Buffer.concat(buffers).toString();
                    assert.strictEqual(data.indexOf('* BAD Invalid PROXY header'), 0);
                    done();
                });
                socket.write('NOTPROXY garbage line\r\n');
            });
            socket.on('error', () => {});
        });

        it('should reject PROXY header without newline once it exceeds the length cap', (t, done) => {
            // A peer that withholds the terminating newline must not cause
            // unbounded buffering: the server caps the PROXY header at 1kB
            // and drops the connection with the diagnostic line.
            let socket = net.connect(PORT, '127.0.0.1', () => {
                let buffers: any = [];
                socket.on('data', chunk => {
                    buffers.push(chunk);
                });
                socket.on('close', () => {
                    let data = Buffer.concat(buffers).toString();
                    assert.strictEqual(data.indexOf('* BAD Invalid PROXY header'), 0);
                    done();
                });
                socket.write(Buffer.alloc(1500, 0x41)); // 1500 bytes of "A", no newline
            });
            socket.on('error', () => {});
        });

        it('should reject overlong PROXY header line even when newline-terminated', (t, done) => {
            let socket = net.connect(PORT, '127.0.0.1', () => {
                let buffers: any = [];
                socket.on('data', chunk => {
                    buffers.push(chunk);
                });
                socket.on('close', () => {
                    let data = Buffer.concat(buffers).toString();
                    assert.strictEqual(data.indexOf('* BAD Invalid PROXY header'), 0);
                    done();
                });
                socket.write('PROXY TCP4 ' + 'A'.repeat(2048) + '\r\n');
            });
            socket.on('error', () => {});
        });

        it('should not crash when client RSTs before sending PROXY header', (t, done) => {
            // Regression test: previously the socket inside _handleProxy had
            // no 'error' listener, so a client that reset the connection
            // before the PROXY header arrived bubbled up as an
            // uncaughtException and tore down the process.
            //
            // The deterministic signal is _handleProxy invoking its callback
            // with an error: that means the server saw the broken socket and
            // routed it through the error path instead of crashing.
            let prevHandleProxy = server._handleProxy;

            let onUncaught: any;
            let onServerError: any;

            function cleanup() {
                process.removeListener('uncaughtException', onUncaught);
                server.removeListener('error', onServerError);
                server._handleProxy = prevHandleProxy;
            }

            onUncaught = (err: any) => {
                cleanup();
                done(new Error('uncaughtException leaked from _handleProxy: ' + err.message));
            };

            onServerError = (err: any) => {
                cleanup();
                done(new Error('server emitted error: ' + err.message));
            };

            process.once('uncaughtException', onUncaught);
            server.on('error', onServerError);

            server._handleProxy = (sock: any, cb: any) =>
                prevHandleProxy.call(server, sock, (err: any, opts: any) => {
                    if (err) {
                        cleanup();
                        done();
                        return;
                    }
                    return cb(err, opts);
                });

            let socket = net.connect(PORT, '127.0.0.1', () => {
                // partial header, then force a RST instead of a clean FIN
                socket.write('PROXY TCP4 1.2.3.4');
                if (typeof socket.resetAndDestroy === 'function') {
                    socket.resetAndDestroy();
                } else {
                    socket.destroy(new Error('boom'));
                }
            });
            socket.on('error', () => {
                // expected on the client side
            });
        });

        it('should not invoke onConnect when client closes before PROXY header', (t, done) => {
            // If the socket FINs before we ever see a newline-terminated PROXY
            // header, the connection should be aborted silently — onConnect
            // must not fire, and the process must not crash.
            let connectFired = false;
            let prevOnConnect = server.options.onConnect;
            server.options.onConnect = (session: any, cb: any) => {
                connectFired = true;
                cb();
            };

            // _handleProxy invoking its callback with an error is the
            // deterministic signal: the error and the (erroneous) connect path
            // are mutually exclusive branches of that same callback, so once we
            // see the error we know connect was not taken — no timer needed.
            let prevHandleProxy = server._handleProxy;
            server._handleProxy = (sock: any, cb: any) =>
                prevHandleProxy.call(server, sock, (err: any, opts: any) => {
                    if (err) {
                        server.options.onConnect = prevOnConnect;
                        server._handleProxy = prevHandleProxy;
                        assert.strictEqual(connectFired, false);
                        done();
                        return;
                    }
                    return cb(err, opts);
                });

            let socket = net.connect(PORT, '127.0.0.1', () => {
                socket.end(); // graceful close, no PROXY header sent
            });
            socket.on('error', () => {});
        });
    });

    describe('Secure PROXY server', () => {
        let PORT: any;

        let server: any = new SMTPServer({
            maxClients: 5,
            logger: false,
            useProxy: true,
            secure: true,
            onConnect(session, callback) {
                if (session.remoteAddress === '1.2.3.4') {
                    let err: any = new Error('Blacklisted IP');
                    err.responseCode = 421;
                    return callback(err);
                }
                callback();
            }
        });

        beforeEach((t, done) => {
            server.listen(0, '127.0.0.1', () => {
                PORT = (server.server.address() as any).port;
                done();
            });
        });

        afterEach((t, done) => {
            server.close(done);
        });

        it('should rewrite remote address value', (t, done) => {
            let connection: any = new Client({
                port: PORT,
                host: '127.0.0.1',
                tls: {
                    rejectUnauthorized: false
                }
            });

            connection.on('end', done);

            connection.connect(() => {
                let conn: any;
                // get first connection
                server.connections.forEach((val: any) => {
                    if (!conn) {
                        conn = val;
                    }
                });
                // default remote address should be overriden by the value from the PROXY header
                assert.strictEqual(conn.remoteAddress, '198.51.100.22');
                assert.strictEqual(conn.remotePort, 35646);
                connection.quit();
            });

            connection._socket.write('PROXY TCP4 198.51.100.22 203.0.113.7 35646 80\r\n');
            connection._upgradeConnection((err: any) => {
                assert.ok(err === null || err === undefined);
                // server should respond with greeting after this point
            });
        });
    });

    describe('onClose handler', () => {
        let PORT: any;

        it('should detect once a connection is closed', (t, done) => {
            let closed = 0;
            let total = 50;
            let server: any = new SMTPServer({
                logger: false,
                onClose(session) {
                    assert.ok(session !== null && session !== undefined);
                    assert.ok(closed < total);
                    if (++closed >= total) {
                        server.close(done);
                    }
                }
            });

            server.listen(0, '127.0.0.1', () => {
                PORT = (server.server.address() as any).port;
                let createConnection = () => {
                    let connection: any = new Client({
                        port: PORT,
                        host: '127.0.0.1',
                        ignoreTLS: true
                    });

                    connection.connect(() => {
                        setTimeout(() => connection.quit(), 100);
                    });
                };
                for (let i = 0; i < total; i++) {
                    createConnection();
                }
            });
        });
    });

    describe('onSecure handler', () => {
        let PORT;

        it('should detect once a connection is established with TLS', (t, done) => {
            let server: any;
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
                        assert.ok(session !== null && session !== undefined);
                        assert.strictEqual(session.servername, 'teretere1');
                        secureCount++;
                        done();
                    }
                });

                server.listen(0, '127.0.0.1', () => {
                    PORT = (server.server.address() as any).port;

                    let connection: any = new Client({
                        port: PORT,
                        host: '127.0.0.1',
                        secure: true,
                        tls: {
                            rejectUnauthorized: false,
                            servername: 'teretere1'
                        }
                    });

                    connection.connect(() => {
                        setTimeout(() => {
                            connection.quit();
                            server.close(() => {
                                assert.strictEqual(secureCount, 1);
                                done();
                            });
                        }, 100);
                    });

                    connection.on('error', (err: any) => {
                        server.close(() => done(err));
                    });
                });
            });
        });

        it('should detect once a connection is upgraded to TLS', (t, done) => {
            let server: any;
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
                        assert.ok(session !== null && session !== undefined);
                        assert.strictEqual(session.servername, 'teretere2');
                        secureCount++;
                        done();
                    },
                    onConnect(session, done) {
                        done();
                    }
                });

                server.listen(0, '127.0.0.1', () => {
                    PORT = (server.server.address() as any).port;

                    let connection: any = new Client({
                        port: PORT,
                        host: '127.0.0.1',
                        secure: false,
                        tls: {
                            rejectUnauthorized: false,
                            servername: 'teretere2'
                        }
                    });

                    connection.connect(() => {
                        setTimeout(() => {
                            connection.quit();
                            server.close(() => {
                                assert.strictEqual(secureCount, 1);
                                done();
                            });
                        }, 100);
                    });

                    connection.on('error', (err: any) => {
                        server.close(() => done(err));
                    });
                });
            });
        });

        it('onSecure is not triggered for cleartext connections', (t, done) => {
            let server: any;
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
                        assert.ok(session !== null && session !== undefined);
                        assert.strictEqual(session.servername, 'teretere2');
                        secureCount++;
                        done();
                    },

                    onConnect(session, done) {
                        done();
                    }
                });

                server.listen(0, '127.0.0.1', () => {
                    PORT = (server.server.address() as any).port;

                    let connection: any = new Client({
                        port: PORT,
                        host: '127.0.0.1',
                        secure: false,
                        ignoreTLS: true,
                        tls: {
                            rejectUnauthorized: false,
                            servername: 'teretere2'
                        }
                    });

                    connection.connect(() => {
                        setTimeout(() => {
                            connection.quit();
                            server.close(() => {
                                assert.strictEqual(secureCount, 0);
                                done();
                            });
                        }, 100);
                    });

                    connection.on('error', (err: any) => {
                        server.close(() => done(err));
                    });
                });
            });
        });
    });
});

describe('Connection socket options', () => {
    it('should turn Nagle off for accepted connections', (t, done) => {
        // Replies to pipelined commands are written one by one, Nagle would hold the later ones
        // back until the client acknowledged the earlier ones
        const calls: any[] = [];
        const setNoDelay = net.Socket.prototype.setNoDelay;
        net.Socket.prototype.setNoDelay = function (this: any, ...args: any[]) {
            calls.push({ socket: this, args });
            return setNoDelay.apply(this, args as any);
        };

        const server: any = new SMTPServer({ logger: false, disabledCommands: ['STARTTLS', 'AUTH'] });
        server.listen(0, '127.0.0.1', () => {
            const client = net.connect((server.server.address() as any).port, '127.0.0.1');
            client.once('data', () => {
                net.Socket.prototype.setNoDelay = setNoDelay;
                const accepted = [...server.connections][0]._socket;
                const call = calls.find(entry => entry.socket === accepted);
                try {
                    assert.ok(call !== null && call !== undefined);
                    assert.deepStrictEqual(call.args, [true]);
                } catch (err) {
                    client.destroy();
                    return server.close(() => done(err));
                }
                client.end('QUIT\r\n');
                client.on('close', () => server.close(done));
            });
        });
    });
});

describe('SNI', () => {
    let keys: any;

    before((t, done) => {
        pem.createCertificate({ days: 1, selfSigned: true, commonName: 'sni.example.com' }, (err, result) => {
            keys = result;
            done(err);
        });
    });

    // Opens a TLS session (implicit, or with STARTTLS first) requesting the given
    // SNI name and calls back with the common name of the server certificate
    function peerCommonName(port: any, starttls: any, servername: any, callback: any) {
        let handshake = (socket?: any) => {
            let secureSocket = tls.connect({ socket, host: '127.0.0.1', port, servername, rejectUnauthorized: false }, () => {
                let cn = secureSocket.getPeerCertificate().subject.CN;
                secureSocket.destroy();
                callback(null, cn);
            });
            secureSocket.once('error', callback);
        };

        if (!starttls) {
            return handshake();
        }

        let socket = net.connect(port, '127.0.0.1');
        socket.once('error', callback);
        driveSocket(socket, ['EHLO example.com\r\n', 'STARTTLS\r\n'], true, (err, lines) => {
            if (err) {
                return callback(err);
            }
            assert.match(lines.pop()!, /^220 /);
            handshake(socket);
        });
    }

    for (let [label, options, starttls] of [
        ['implicit TLS', { secure: true }, false],
        ['STARTTLS on a plaintext server', {}, true]
    ]) {
        it('should use sniOptions with ' + label, (t, done) => {
            let server: any = new SMTPServer(
                Object.assign(
                    {
                        logger: false,
                        sniOptions: {
                            'SNI.example.com': { key: keys.serviceKey, cert: keys.certificate }
                        }
                    },
                    options
                )
            );
            // a TLS 1.3 client is done before the server, so hanging up right away
            // fails the server side of the handshake
            server.on('error', () => false);
            server.listen(0, '127.0.0.1', () => {
                let port = (server.server.address() as any).port;
                peerCommonName(port, starttls, 'sni.EXAMPLE.com', (err: any, matched: any) => {
                    if (err) {
                        return server.close(() => done(err));
                    }
                    assert.strictEqual(matched, 'sni.example.com');
                    peerCommonName(port, starttls, 'unknown.example.com', (err: any, fallback: any) => {
                        if (err) {
                            return server.close(() => done(err));
                        }
                        // the built-in default certificate
                        assert.strictEqual(fallback, 'localhost');
                        server.close(done);
                    });
                });
            });
        });
    }
});

describe('Secure server with client certificates', () => {
    let keys: any;
    let clientKeys: any;

    before((t, done) => {
        pem.createCertificate({ days: 1, selfSigned: true }, (err, serverKeys) => {
            if (err) {
                return done(err);
            }
            keys = serverKeys;
            pem.createCertificate({ days: 1, selfSigned: true, commonName: 'client.example.com' }, (err, result) => {
                if (err) {
                    return done(err);
                }
                clientKeys = result;
                done();
            });
        });
    });

    // Talks to a server that requires a client certificate, over implicit TLS or
    // STARTTLS, and calls back with whether the server answered inside the TLS session
    // and what its onSecure handler saw of the client certificate
    function connect(serverOptions: any, tlsOptions: any, callback: any) {
        let authorized: any = [];
        let server: any = new SMTPServer(
            Object.assign(
                {
                    logger: false,
                    key: keys.serviceKey,
                    cert: keys.certificate,
                    ca: [clientKeys.certificate],
                    requestCert: true,
                    rejectUnauthorized: true,
                    onSecure(socket: any, session: any, next: any) {
                        authorized.push(socket.authorized);
                        next();
                    }
                },
                serverOptions
            )
        );
        // a refused client certificate is reported as a server error
        server.on('error', () => false);
        server.listen(0, '127.0.0.1', () => {
            let port = (server.server.address() as any).port;
            let answered = false;

            let handshake = (rawSocket?: any) => {
                let socket = tls.connect(Object.assign({ port, host: '127.0.0.1', socket: rawSocket, rejectUnauthorized: false }, tlsOptions), () => {
                    if (rawSocket) {
                        // inside STARTTLS the client speaks first, implicit TLS waits for the greeting
                        socket.write('EHLO client.example.com\r\n');
                    }
                });
                socket.on('data', chunk => {
                    if (!answered && /^(220|250)[ -]/.test(chunk.toString())) {
                        answered = true;
                        socket.end('QUIT\r\n');
                    }
                });
                socket.on('error', () => false);
                socket.on('close', () => server.close(() => callback(null, answered, authorized)));
            };

            if (serverOptions.secure) {
                return handshake();
            }

            let rawSocket = net.connect(port, '127.0.0.1');
            rawSocket.on('error', () => false);
            driveSocket(rawSocket, ['EHLO client.example.com\r\n', 'STARTTLS\r\n'], true, (err, lines) => {
                if (err) {
                    return server.close(() => callback(err));
                }
                assert.match(lines.pop()!, /^220 /);
                handshake(rawSocket);
            });
        });
    }

    for (let [label, serverOptions] of [
        ['implicit TLS', { secure: true }],
        ['STARTTLS', {}]
    ]) {
        it('should refuse a client without a certificate over ' + label, (t, done) => {
            // requestCert and rejectUnauthorized used to be dropped on the way to the implicit
            // TLS socket, so every client completed the handshake and got the greeting
            connect(serverOptions, {}, (err: any, answered: any, authorized: any) => {
                assert.ok(err === null || err === undefined);
                assert.strictEqual(answered, false);
                assert.deepStrictEqual(authorized, []);
                done();
            });
        });

        it('should refuse a client with an untrusted certificate over ' + label, (t, done) => {
            // OpenSSL only fails the handshake for a missing certificate, an untrusted one
            // has to be refused by the library once the handshake is done, as tls.Server does
            connect(serverOptions, { key: keys.serviceKey, cert: keys.certificate }, (err: any, answered: any, authorized: any) => {
                assert.ok(err === null || err === undefined);
                assert.strictEqual(answered, false);
                assert.deepStrictEqual(authorized, []);
                done();
            });
        });

        it('should admit a client with a trusted certificate over ' + label, (t, done) => {
            connect(serverOptions, { key: clientKeys.serviceKey, cert: clientKeys.certificate }, (err: any, answered: any, authorized: any) => {
                assert.ok(err === null || err === undefined);
                assert.strictEqual(answered, true);
                assert.deepStrictEqual(authorized, [true]);
                done();
            });
        });
    }
});

describe('Command logging', () => {
    // runs the commands against a server whose logger records every entry
    function logged(commands: any, callback: any) {
        let entries: any = [];
        let record = (entry: any, message: any, ...args: any[]) => entries.push({ command: entry.command, text: [message].concat(args).join(' ') });
        let server: any = new SMTPServer({
            logger: { trace: record, debug: record, info: record, warn: record, error: record, fatal: record },
            allowInsecureAuth: true,
            authMethods: ['PLAIN', 'LOGIN'],
            onAuth(auth, session, next) {
                next(null, { user: auth.username });
            }
        });
        server.listen(0, '127.0.0.1', () => {
            chat((server.server.address() as any).port, commands).then(
                replies => server.close(() => callback(null, entries, replies)),
                err => server.close(() => callback(err))
            );
        });
    }

    it('should redact the argument of AUTH PLAIN', (t, done) => {
        let token = Buffer.from('\0testuser\0testpass').toString('base64');
        logged(['EHLO client.example.com', 'AUTH PLAIN ' + token, 'QUIT'], (err: any, entries: any, replies: any) => {
            assert.ok(err === null || err === undefined);
            assert.strictEqual(replies[2].code, 235);
            assert.ok(!JSON.stringify(entries).includes(token));
            let lines = entries.map((entry: any) => entry.text);
            assert.ok(lines.includes('C: AUTH PLAIN /* secured */'));
            // only the credentials are hidden
            assert.ok(lines.includes('C: EHLO client.example.com'));
            done();
        });
    });

    it('should redact the continuation lines of AUTH LOGIN', (t, done) => {
        let username = Buffer.from('testuser').toString('base64');
        let password = Buffer.from('testpass').toString('base64');
        logged(['EHLO client.example.com', 'AUTH LOGIN', username, password, 'QUIT'], (err: any, entries: any, replies: any) => {
            assert.ok(err === null || err === undefined);
            assert.strictEqual(replies[4].code, 235);
            let text = JSON.stringify(entries);
            assert.ok(!text.includes(username));
            assert.ok(!text.includes(password));
            // both continuation lines are logged as part of the AUTH exchange
            let secured = entries.filter((entry: any) => entry.text === 'C: /* secured */');
            assert.strictEqual(secured.length, 2);
            assert.deepStrictEqual(
                secured.map((entry: any) => entry.command),
                ['AUTH', 'AUTH']
            );
            assert.ok(entries.map((entry: any) => entry.text).includes('C: AUTH LOGIN'));
            done();
        });
    });
});

describe('PROXY peer list', () => {
    it('should match the listed addresses whatever form the peer address takes', () => {
        // a dual-stack listener reports IPv4 peers as ::ffff:a.b.c.d, and IPv6 has many spellings
        let server: any = new SMTPServer({ logger: false, useProxy: ['127.0.0.1', '2001:DB8::1'] });
        assert.strictEqual(server._expectsProxyHeader({ remoteAddress: '::ffff:127.0.0.1' }), true);
        assert.strictEqual(server._expectsProxyHeader({ remoteAddress: '127.0.0.1' }), true);
        assert.strictEqual(server._expectsProxyHeader({ remoteAddress: '2001:db8:0:0:0:0:0:1' }), true);
        assert.strictEqual(server._expectsProxyHeader({ remoteAddress: '::ffff:127.0.0.2' }), false);
        assert.strictEqual(server._expectsProxyHeader({ remoteAddress: '::1' }), false);
    });

    it('should expect the PROXY header from a listed peer written as an IPv4-mapped address', (t, done) => {
        let server: any = new SMTPServer({ logger: false, useProxy: ['::ffff:127.0.0.1'], disabledCommands: ['AUTH', 'STARTTLS'] });
        server.listen(0, '127.0.0.1', () => {
            let greeted = false;
            let socket = net.connect((server.server.address() as any).port, '127.0.0.1', () => {
                socket.write('PROXY TCP4 198.51.100.22 203.0.113.7 35646 25\r\n');
            });
            let data = '';
            socket.on('data', chunk => {
                data += chunk.toString();
                if (!greeted && /^220 /.test(data)) {
                    greeted = true;
                    let [connection] = server.connections;
                    assert.strictEqual(connection.remoteAddress, '198.51.100.22');
                    socket.end('QUIT\r\n');
                }
            });
            socket.on('close', () => {
                // without the header being expected the PROXY line is an early command, answered 421
                assert.strictEqual(greeted, true);
                server.close(done);
            });
        });
    });
});

describe('Recipient list', () => {
    // a connection with a mail transaction open, RCPT handled without a socket
    function transaction(options?: any) {
        let server = {
            options: Object.assign({ disabledCommands: [], authMethods: [], hideDSN: true }, options),
            logger: { debug() {}, info() {}, error() {} },
            onRcptTo(address: any, session: any, callback: any) {
                callback();
            }
        };
        let connection = new (SMTPConnection as any)(server, {}, {});
        connection.replies = [];
        connection.send = (code: any, message: any) => connection.replies.push(code + ' ' + message);
        connection._resetSession();
        connection.session.envelope.mailFrom = { address: 'sender@example.com' };
        return connection;
    }

    function rcpt(connection: any, address: any) {
        connection.handler_RCPT(Buffer.from('RCPT TO:<' + address + '>'), () => false);
    }

    let addresses = (connection: any) => connection.session.envelope.rcptTo.map((rcpt: any) => rcpt.address);

    it('should replace a repeated recipient whatever its case', () => {
        let connection = transaction();
        rcpt(connection, 'a@example.com');
        rcpt(connection, 'b@example.com');
        rcpt(connection, 'A@Example.com');
        assert.deepStrictEqual(addresses(connection), ['A@Example.com', 'b@example.com']);
    });

    it('should cope with a handler that edited the list', () => {
        let connection = transaction();
        rcpt(connection, 'a@example.com');
        rcpt(connection, 'b@example.com');
        // an application that drops an accepted recipient itself
        connection.session.envelope.rcptTo.shift();
        rcpt(connection, 'b@example.com');
        rcpt(connection, 'a@example.com');
        assert.deepStrictEqual(addresses(connection), ['b@example.com', 'a@example.com']);
    });

    it('should refuse recipients over maxRecipients with 452', () => {
        let connection = transaction({ maxRecipients: 2 });
        rcpt(connection, 'a@example.com');
        rcpt(connection, 'b@example.com');
        rcpt(connection, 'c@example.com');
        rcpt(connection, 'A@example.com');
        assert.deepStrictEqual(connection.replies, ['250 Accepted', '250 Accepted', '452 Error: too many recipients', '250 Accepted']);
        assert.deepStrictEqual(addresses(connection), ['A@example.com', 'b@example.com']);
    });

    it('should take a long recipient list in linear time', () => {
        // every RCPT used to scan all recipients so far, so 20000 of them took seconds
        let connection = transaction();
        let start = Date.now();
        for (let i = 0; i < 20000; i++) {
            rcpt(connection, 'user' + i + '@example.com');
        }
        let elapsed = Date.now() - start;
        assert.strictEqual(connection.session.envelope.rcptTo.length, 20000);
        assert.ok(elapsed < 1000);
    });
});
