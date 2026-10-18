import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SMTPServer } from '../src/smtp-server.js';
import { SMTPConnection } from '../src/smtp-connection.js';

describe('MAIL FROM Parameters (BODY, SMTPUTF8, REQUIRETLS)', () => {
    describe('Unit Tests for Parameter Parsing', () => {
        it('should parse BODY parameter in _parseAddressCommand', () => {
            let conn: any = new SMTPConnection(
                {
                    options: {}
                } as any,
                {} as any
            );

            // Test BODY=8BITMIME
            assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@example.com> BODY=8BITMIME'), {
                address: 'sender@example.com',
                args: {
                    BODY: '8BITMIME'
                }
            });

            // Test BODY=7BIT
            assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@example.com> BODY=7BIT'), {
                address: 'sender@example.com',
                args: {
                    BODY: '7BIT'
                }
            });
        });

        it('should parse SMTPUTF8 parameter in _parseAddressCommand', () => {
            let conn: any = new SMTPConnection(
                {
                    options: {}
                } as any,
                {} as any
            );

            // Test SMTPUTF8 flag
            assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@example.com> SMTPUTF8'), {
                address: 'sender@example.com',
                args: {
                    SMTPUTF8: true
                }
            });
        });

        it('should parse REQUIRETLS parameter in _parseAddressCommand', () => {
            let conn: any = new SMTPConnection(
                {
                    options: {}
                } as any,
                {} as any
            );

            // Test REQUIRETLS flag
            assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@example.com> REQUIRETLS'), {
                address: 'sender@example.com',
                args: {
                    REQUIRETLS: true
                }
            });
        });

        it('should parse combined parameters', () => {
            let conn: any = new SMTPConnection(
                {
                    options: {}
                } as any,
                {} as any
            );

            // Test all three parameters together
            assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@example.com> BODY=8BITMIME SMTPUTF8 REQUIRETLS'), {
                address: 'sender@example.com',
                args: {
                    BODY: '8BITMIME',
                    SMTPUTF8: true,
                    REQUIRETLS: true
                }
            });
        });
    });

    describe('Session Data Structure', () => {
        it('should initialize parameter fields in session envelope', () => {
            let conn: any = new SMTPConnection(
                {
                    options: {}
                } as any,
                {
                    on() {},
                    write() {},
                    end() {}
                } as any
            );

            conn._resetSession();

            assert.strictEqual(conn.session.envelope.bodyType, '7bit');
            assert.strictEqual(conn.session.envelope.smtpUtf8, false);
            assert.strictEqual(conn.session.envelope.requireTLS, false);
        });
    });

    describe('EHLO Response', () => {
        it('should include 8BITMIME and SMTPUTF8 in features list', (t, done) => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH']
            });

            let mockConnection: any = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            } as any);

            mockConnection.clientHostname = 'test.example.com';
            mockConnection.name = 'test-server';

            let sentResponse: any = null;
            mockConnection.send = (code: any, message: any) => {
                sentResponse = { code, message };
            };

            mockConnection.handler_EHLO('EHLO test.example.com', () => {
                assert.ok(sentResponse !== null && sentResponse !== undefined);
                assert.strictEqual(sentResponse.code, 250);
                assert.ok(Array.isArray(sentResponse.message), 'expected an array');
                const features = sentResponse.message.slice(1);
                assert.ok(features.includes('8BITMIME'), 'expected ' + JSON.stringify(features) + ' to include 8BITMIME');
                assert.ok(features.includes('SMTPUTF8'), 'expected ' + JSON.stringify(features) + ' to include SMTPUTF8');
                done();
            });
        });

        it('should include REQUIRETLS when secure and not hidden', (t, done) => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                hideREQUIRETLS: false
            });

            let mockConnection: any = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            } as any);

            mockConnection.clientHostname = 'test.example.com';
            mockConnection.name = 'test-server';
            mockConnection.secure = true; // Simulate TLS connection

            let sentResponse: any = null;
            mockConnection.send = (code: any, message: any) => {
                sentResponse = { code, message };
            };

            mockConnection.handler_EHLO('EHLO test.example.com', () => {
                assert.ok(sentResponse !== null && sentResponse !== undefined);
                assert.strictEqual(sentResponse.code, 250);
                assert.ok(Array.isArray(sentResponse.message), 'expected an array');
                const features = sentResponse.message.slice(1);
                assert.ok(features.includes('REQUIRETLS'), 'expected ' + JSON.stringify(features) + ' to include REQUIRETLS');
                done();
            });
        });

        it('should hide REQUIRETLS by default', (t, done) => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH']
            });

            let mockConnection: any = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            } as any);

            mockConnection.clientHostname = 'test.example.com';
            mockConnection.name = 'test-server';
            mockConnection.secure = true; // Simulate TLS connection

            let sentResponse: any = null;
            mockConnection.send = (code: any, message: any) => {
                sentResponse = { code, message };
            };

            mockConnection.handler_EHLO('EHLO test.example.com', () => {
                assert.ok(sentResponse !== null && sentResponse !== undefined);
                assert.strictEqual(sentResponse.code, 250);
                assert.ok(Array.isArray(sentResponse.message), 'expected an array');
                const features = sentResponse.message.slice(1);
                assert.ok(!features.includes('REQUIRETLS'), 'did not expect ' + JSON.stringify(features) + ' to include REQUIRETLS');
                done();
            });
        });
    });

    describe('MAIL FROM Parameter Validation', () => {
        it('should accept valid BODY=8BITMIME parameter', (t, done) => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                authOptional: true,
                onMailFrom: (address: any, session: any, callback: any) => {
                    assert.strictEqual(session.envelope.bodyType, '8bitmime');
                    callback();
                }
            });

            let mockConnection: any = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            } as any);

            mockConnection._resetSession();
            mockConnection.send = (code: any) => {
                assert.strictEqual(code, 250);
                done();
            };

            mockConnection.handler_MAIL('MAIL FROM:<sender@example.com> BODY=8BITMIME', () => {});
        });

        it('should reject invalid BODY parameter', (t, done) => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                authOptional: true
            });

            let mockConnection: any = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            } as any);

            mockConnection._resetSession();
            mockConnection.send = (code: any, message: any) => {
                assert.strictEqual(code, 501);
                assert.ok(message.includes('Invalid BODY parameter'), 'expected ' + JSON.stringify(message) + ' to include Invalid BODY parameter');
                done();
            };

            mockConnection.handler_MAIL('MAIL FROM:<sender@example.com> BODY=INVALID', () => {});
        });

        it('should accept SMTPUTF8 parameter', (t, done) => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                authOptional: true,
                onMailFrom: (address: any, session: any, callback: any) => {
                    assert.strictEqual(session.envelope.smtpUtf8, true);
                    callback();
                }
            });

            let mockConnection: any = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            } as any);

            mockConnection._resetSession();
            mockConnection.send = (code: any) => {
                assert.strictEqual(code, 250);
                done();
            };

            mockConnection.handler_MAIL('MAIL FROM:<sender@example.com> SMTPUTF8', () => {});
        });

        it('should reject SMTPUTF8 with value', (t, done) => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                authOptional: true
            });

            let mockConnection: any = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            } as any);

            mockConnection._resetSession();
            mockConnection.send = (code: any, message: any) => {
                assert.strictEqual(code, 501);
                assert.ok(message.includes('does not accept a value'), 'expected ' + JSON.stringify(message) + ' to include does not accept a value');
                done();
            };

            mockConnection.handler_MAIL('MAIL FROM:<sender@example.com> SMTPUTF8=YES', () => {});
        });

        it('should accept REQUIRETLS parameter over TLS', (t, done) => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                authOptional: true,
                hideREQUIRETLS: false,
                onMailFrom: (address: any, session: any, callback: any) => {
                    assert.strictEqual(session.envelope.requireTLS, true);
                    callback();
                }
            });

            let mockConnection: any = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            } as any);

            mockConnection._resetSession();
            mockConnection.secure = true; // Simulate TLS connection
            mockConnection.send = (code: any) => {
                assert.strictEqual(code, 250);
                done();
            };

            mockConnection.handler_MAIL('MAIL FROM:<sender@example.com> REQUIRETLS', () => {});
        });

        it('should reject REQUIRETLS without TLS', (t, done) => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                authOptional: true,
                hideREQUIRETLS: false
            });

            let mockConnection: any = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            } as any);

            mockConnection._resetSession();
            mockConnection.secure = false; // Not secure
            mockConnection.send = (code: any, message: any) => {
                assert.strictEqual(code, 530);
                assert.ok(message.includes('not permitted on non-TLS'), 'expected ' + JSON.stringify(message) + ' to include not permitted on non-TLS');
                done();
            };

            mockConnection.handler_MAIL('MAIL FROM:<sender@example.com> REQUIRETLS', () => {});
        });

        it('should accept combined parameters', (t, done) => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                authOptional: true,
                hideREQUIRETLS: false,
                onMailFrom: (address: any, session: any, callback: any) => {
                    assert.strictEqual(session.envelope.bodyType, '8bitmime');
                    assert.strictEqual(session.envelope.smtpUtf8, true);
                    assert.strictEqual(session.envelope.requireTLS, true);
                    callback();
                }
            });

            let mockConnection: any = new SMTPConnection(server, {
                on() {},
                write() {},
                end() {},
                localAddress: '127.0.0.1',
                localPort: 25,
                remoteAddress: '127.0.0.1',
                remotePort: 12345
            } as any);

            mockConnection._resetSession();
            mockConnection.secure = true;
            mockConnection.send = (code: any) => {
                assert.strictEqual(code, 250);
                done();
            };

            mockConnection.handler_MAIL('MAIL FROM:<sender@example.com> BODY=8BITMIME SMTPUTF8 REQUIRETLS', () => {});
        });
    });
});
