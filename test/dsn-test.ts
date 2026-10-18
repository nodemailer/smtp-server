import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SMTPServer } from '../src/smtp-server.js';
import { SMTPConnection } from '../src/smtp-connection.js';

describe('DSN (Delivery Status Notification) Support', () => {
    describe('Unit Tests for DSN Parameter Parsing', () => {
        it('should parse DSN parameters in _parseAddressCommand', () => {
            let conn: any = new SMTPConnection(
                {
                    options: {}
                } as any,
                {} as any
            );

            // Test MAIL FROM with DSN parameters
            assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@example.com> RET=FULL ENVID=test123'), {
                address: 'sender@example.com',
                args: {
                    RET: 'FULL',
                    ENVID: 'test123'
                }
            });

            // Test RCPT TO with DSN parameters
            assert.deepStrictEqual(
                conn._parseAddressCommand('RCPT TO', 'RCPT TO:<recipient@example.com> NOTIFY=SUCCESS,FAILURE ORCPT=rfc822;original@example.com'),
                {
                    address: 'recipient@example.com',
                    args: {
                        NOTIFY: 'SUCCESS,FAILURE',
                        ORCPT: 'rfc822;original@example.com'
                    }
                }
            );

            // Test mixed parameters
            assert.deepStrictEqual(conn._parseAddressCommand('MAIL FROM', 'MAIL FROM:<sender@example.com> SIZE=12345 RET=HDRS ENVID=env456'), {
                address: 'sender@example.com',
                args: {
                    SIZE: '12345',
                    RET: 'HDRS',
                    ENVID: 'env456'
                }
            });
        });
    });

    describe('DSN Session Data Structure', () => {
        it('should initialize DSN data in session envelope', () => {
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

            assert.ok(conn.session.envelope.dsn !== null && conn.session.envelope.dsn !== undefined);
            assert.strictEqual(conn.session.envelope.dsn.ret, null);
            assert.strictEqual(conn.session.envelope.dsn.envid, null);
        });
    });

    describe('EHLO Response', () => {
        it('should include ENHANCEDSTATUSCODES and DSN in features list', (t, done) => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                hideENHANCEDSTATUSCODES: false,
                hideDSN: false
            });

            // Mock connection for testing EHLO handler
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

            // Mock the send method to capture the response
            let sentResponse: any = null;
            mockConnection.send = (code: any, message: any) => {
                sentResponse = { code, message };
            };

            // Test EHLO handler
            mockConnection.handler_EHLO('EHLO test.example.com', () => {
                assert.ok(sentResponse !== null && sentResponse !== undefined);
                assert.strictEqual(sentResponse.code, 250);
                assert.ok(Array.isArray(sentResponse.message), 'expected an array');

                // Check if ENHANCEDSTATUSCODES and DSN is in the features
                const features = sentResponse.message.slice(1); // Skip the greeting
                assert.ok(features.includes('ENHANCEDSTATUSCODES'), 'expected ' + JSON.stringify(features) + ' to include ENHANCEDSTATUSCODES');
                assert.ok(features.includes('DSN'), 'expected ' + JSON.stringify(features) + ' to include DSN');

                done();
            });
        });

        it('should hide ENHANCEDSTATUSCODES when hideENHANCEDSTATUSCODES is true', (t, done) => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                hideENHANCEDSTATUSCODES: true
            });

            // Mock connection for testing EHLO handler
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

            // Mock the send method to capture the response
            let sentResponse: any = null;
            mockConnection.send = (code: any, message: any) => {
                sentResponse = { code, message };
            };

            // Test EHLO handler
            mockConnection.handler_EHLO('EHLO test.example.com', () => {
                assert.ok(sentResponse !== null && sentResponse !== undefined);
                assert.strictEqual(sentResponse.code, 250);
                assert.ok(Array.isArray(sentResponse.message), 'expected an array');

                // Check if ENHANCEDSTATUSCODES is NOT in the features
                const features = sentResponse.message.slice(1); // Skip the greeting
                assert.ok(!features.includes('ENHANCEDSTATUSCODES'), 'did not expect ' + JSON.stringify(features) + ' to include ENHANCEDSTATUSCODES');

                done();
            });
        });

        it('should hide DSN when hideDSN is true', (t, done) => {
            let server = new SMTPServer({
                disabledCommands: ['AUTH'],
                hideDSN: true
            });

            // Mock connection for testing EHLO handler
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

            // Mock the send method to capture the response
            let sentResponse: any = null;
            mockConnection.send = (code: any, message: any) => {
                sentResponse = { code, message };
            };

            // Test EHLO handler
            mockConnection.handler_EHLO('EHLO test.example.com', () => {
                assert.ok(sentResponse !== null && sentResponse !== undefined);
                assert.strictEqual(sentResponse.code, 250);
                assert.ok(Array.isArray(sentResponse.message), 'expected an array');

                // Check if DSN is NOT in the features
                const features = sentResponse.message.slice(1); // Skip the greeting
                assert.ok(!features.includes('DSN'), 'did not expect ' + JSON.stringify(features) + ' to include DSN');

                done();
            });
        });
    });

    describe('MAIL FROM DSN Parameter Validation', () => {
        it('should accept valid RET=FULL parameter', (t, done) => {
            let server = new SMTPServer({
                hideDSN: false,
                onMailFrom(address: any, session: any, callback: any) {
                    assert.strictEqual(session.envelope.dsn.ret, 'FULL');
                    assert.strictEqual(address.args.RET, 'FULL');
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
            mockConnection.openingCommand = 'EHLO';

            let sentResponse: any = null;
            mockConnection.send = (code: any, message: any) => {
                sentResponse = { code, message };
            };

            mockConnection.handler_MAIL('MAIL FROM:<test@example.com> RET=FULL', () => {
                assert.ok(sentResponse !== null && sentResponse !== undefined);
                assert.strictEqual(sentResponse.code, 250);
                done();
            });
        });

        it('should reject invalid RET parameter', (t, done) => {
            let server = new SMTPServer({
                hideDSN: false,
                onMailFrom(address: any, session: any, callback: any) {
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
            mockConnection.openingCommand = 'EHLO';

            let sentResponse: any = null;
            mockConnection.send = (code: any, message: any) => {
                sentResponse = { code, message };
            };

            mockConnection.handler_MAIL('MAIL FROM:<test@example.com> RET=INVALID', () => {
                assert.ok(sentResponse !== null && sentResponse !== undefined);
                assert.strictEqual(sentResponse.code, 501);
                assert.ok(
                    sentResponse.message.includes('Invalid RET parameter'),
                    'expected ' + JSON.stringify(sentResponse.message) + ' to include Invalid RET parameter'
                );
                done();
            });
        });

        it('should accept ENVID parameter', (t, done) => {
            let server = new SMTPServer({
                hideDSN: false,
                onMailFrom(address: any, session: any, callback: any) {
                    assert.strictEqual(session.envelope.dsn.envid, 'test-envelope-123');
                    assert.strictEqual(address.args.ENVID, 'test-envelope-123');
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
            mockConnection.openingCommand = 'EHLO';

            let sentResponse: any = null;
            mockConnection.send = (code: any, message: any) => {
                sentResponse = { code, message };
            };

            mockConnection.handler_MAIL('MAIL FROM:<test@example.com> ENVID=test-envelope-123', () => {
                assert.ok(sentResponse !== null && sentResponse !== undefined);
                assert.strictEqual(sentResponse.code, 250);
                done();
            });
        });
    });

    describe('RCPT TO DSN Parameter Validation', () => {
        it('should accept valid NOTIFY=SUCCESS parameter', (t, done) => {
            let server = new SMTPServer({
                hideDSN: false,
                onMailFrom(address: any, session: any, callback: any) {
                    callback();
                },
                onRcptTo(address: any, session: any, callback: any) {
                    assert.deepStrictEqual(address.dsn.notify, ['SUCCESS']);
                    assert.strictEqual(address.args.NOTIFY, 'SUCCESS');
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
            mockConnection.openingCommand = 'EHLO';
            mockConnection.session.envelope.mailFrom = { address: 'test@example.com' };

            let sentResponse: any = null;
            mockConnection.send = (code: any, message: any) => {
                sentResponse = { code, message };
            };

            mockConnection.handler_RCPT('RCPT TO:<recipient@example.com> NOTIFY=SUCCESS', () => {
                assert.ok(sentResponse !== null && sentResponse !== undefined);
                assert.strictEqual(sentResponse.code, 250);
                done();
            });
        });

        it('should reject invalid NOTIFY parameter', (t, done) => {
            let server = new SMTPServer({
                hideDSN: false,
                onMailFrom(address: any, session: any, callback: any) {
                    callback();
                },
                onRcptTo(address: any, session: any, callback: any) {
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
            mockConnection.openingCommand = 'EHLO';
            mockConnection.session.envelope.mailFrom = { address: 'test@example.com' };

            let sentResponse: any = null;
            mockConnection.send = (code: any, message: any) => {
                sentResponse = { code, message };
            };

            mockConnection.handler_RCPT('RCPT TO:<recipient@example.com> NOTIFY=INVALID', () => {
                assert.ok(sentResponse !== null && sentResponse !== undefined);
                assert.strictEqual(sentResponse.code, 501);
                assert.ok(
                    sentResponse.message.includes('NOTIFY parameter must be NEVER, SUCCESS, FAILURE, or DELAY'),
                    'expected ' + JSON.stringify(sentResponse.message) + ' to include NOTIFY parameter must be NEVER, SUCCESS, FAILURE, or DELAY'
                );
                done();
            });
        });

        it('should reject NOTIFY=NEVER combined with other values', (t, done) => {
            let server = new SMTPServer({
                hideDSN: false,
                onMailFrom(address: any, session: any, callback: any) {
                    callback();
                },
                onRcptTo(address: any, session: any, callback: any) {
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
            mockConnection.openingCommand = 'EHLO';
            mockConnection.session.envelope.mailFrom = { address: 'test@example.com' };

            let sentResponse: any = null;
            mockConnection.send = (code: any, message: any) => {
                sentResponse = { code, message };
            };

            mockConnection.handler_RCPT('RCPT TO:<recipient@example.com> NOTIFY=NEVER,SUCCESS', () => {
                assert.ok(sentResponse !== null && sentResponse !== undefined);
                assert.strictEqual(sentResponse.code, 501);
                assert.ok(
                    sentResponse.message.includes('NOTIFY=NEVER cannot be combined with other values'),
                    'expected ' + JSON.stringify(sentResponse.message) + ' to include NOTIFY=NEVER cannot be combined with other values'
                );
                done();
            });
        });

        it('should accept ORCPT parameter', (t, done) => {
            let server = new SMTPServer({
                hideDSN: false,
                onMailFrom(address: any, session: any, callback: any) {
                    callback();
                },
                onRcptTo(address: any, session: any, callback: any) {
                    assert.strictEqual(address.dsn.orcpt, 'rfc822;original@example.com');
                    assert.strictEqual(address.args.ORCPT, 'rfc822;original@example.com');
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
            mockConnection.openingCommand = 'EHLO';
            mockConnection.session.envelope.mailFrom = { address: 'test@example.com' };

            let sentResponse: any = null;
            mockConnection.send = (code: any, message: any) => {
                sentResponse = { code, message };
            };

            mockConnection.handler_RCPT('RCPT TO:<recipient@example.com> ORCPT=rfc822;original@example.com', () => {
                assert.ok(sentResponse !== null && sentResponse !== undefined);
                assert.strictEqual(sentResponse.code, 250);
                done();
            });
        });
    });
});
