import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chat, series, withServer, withClient, RawClient } from './test-client.js';

/**
 * Asserts that every property of expected is present on actual with a deeply equal value
 * (chai deep.include on objects)
 */
function assertDeepIncludes(actual: any, expected: Record<string, unknown>): void {
    assert.ok(actual !== null && actual !== undefined, 'expected an object');
    for (let [key, value] of Object.entries(expected)) {
        assert.ok(key in actual, 'expected property ' + key);
        assert.deepStrictEqual(actual[key], value, 'property ' + key);
    }
}

/**
 * Asserts that every property of expected is present on actual with a strictly equal value
 * (chai include on objects)
 */
function assertIncludes(actual: any, expected: Record<string, unknown>): void {
    assert.ok(actual !== null && actual !== undefined, 'expected an object');
    for (let [key, value] of Object.entries(expected)) {
        assert.ok(key in actual, 'expected property ' + key);
        assert.strictEqual(actual[key], value, 'property ' + key);
    }
}

const PLAIN = { disabledCommands: ['AUTH'] };
const ENHANCED = { disabledCommands: ['AUTH'], hideENHANCEDSTATUSCODES: false };
const XCLIENT = { disabledCommands: ['AUTH'], useXClient: true, useXForward: true };
const LMTP = { lmtp: true, disabledCommands: ['AUTH'] };
const DSN = { disabledCommands: ['AUTH'], hideDSN: false };
const LIMITED = { disabledCommands: ['AUTH'], maxRecipients: 2 };
// trust lists for XCLIENT and XFORWARD, the test client connects from 127.0.0.1
const XCLIENT_UNTRUSTED = { disabledCommands: ['AUTH'], useXClient: ['192.0.2.9'], useXForward: ['192.0.2.9'] };
const XCLIENT_MAPPED = { disabledCommands: ['AUTH'], useXClient: ['::ffff:127.0.0.1'], useXForward: ['::FFFF:127.0.0.1'] };
const AUTH = {
    authMethods: ['PLAIN', 'LOGIN'],
    allowInsecureAuth: true,
    onAuth(auth: any, session: any, callback: any) {
        if (auth.username === 'user' && auth.password === 'pass') {
            return callback(null, { user: auth.username });
        }
        callback(null, { message: 'Invalid credentials' });
    }
};

const MAIL = 'MAIL FROM:<sender@example.com>';
const RCPT = 'RCPT TO:<rcpt@example.com>';
const PLAIN_TOKEN = Buffer.from('\0user\0pass').toString('base64');

// Every case runs against a fresh server: [description, server options, commands,
// expected reply code for each command]. The greeting is checked separately and
// every reply goes through the reply grammar check of test-client.js
const CASES: Record<string, [string, any, string[], (number | null)[]][]> = {
    'Command sequencing (RFC 5321 section 4.1.4)': [
        ['MAIL before EHLO', PLAIN, [MAIL], [503]],
        ['RCPT before EHLO', PLAIN, [RCPT], [503]],
        ['DATA before EHLO', PLAIN, ['DATA'], [503]],
        ['RCPT before MAIL', PLAIN, ['EHLO client.example.com', RCPT], [250, 503]],
        ['DATA before MAIL', PLAIN, ['EHLO client.example.com', 'DATA'], [250, 503]],
        ['DATA before RCPT', PLAIN, ['EHLO client.example.com', MAIL, 'DATA'], [250, 250, 503]],
        ['nested MAIL', PLAIN, ['EHLO client.example.com', MAIL, MAIL], [250, 250, 503]],
        ['RSET ends the transaction', PLAIN, ['EHLO client.example.com', MAIL, 'RSET', RCPT], [250, 250, 250, 503]],
        ['EHLO ends the transaction', PLAIN, ['EHLO client.example.com', MAIL, 'EHLO client.example.com', RCPT], [250, 250, 250, 503]],
        ['HELO ends the transaction', PLAIN, ['HELO client.example.com', MAIL, 'HELO client.example.com', RCPT], [250, 250, 250, 503]],
        ['RSET keeps the client identity', PLAIN, ['EHLO client.example.com', 'RSET', MAIL], [250, 250, 250]],
        ['commands are case insensitive', PLAIN, ['ehlo client.example.com', 'mail from:<sender@example.com>', 'rcpt to:<rcpt@example.com>'], [250, 250, 250]]
    ],

    'Basic commands': [
        ['HELO with a hostname', PLAIN, ['HELO client.example.com', MAIL], [250, 250]],
        ['HELO without a hostname', PLAIN, ['HELO'], [501]],
        ['HELO with extra arguments', PLAIN, ['HELO client example.com'], [501]],
        ['EHLO without a hostname', PLAIN, ['EHLO'], [501]],
        ['EHLO with extra arguments', PLAIN, ['EHLO client example.com'], [501]],
        ['HELO with a control character in the hostname', PLAIN, ['HELO client\u0001.example.com'], [501]],
        ['HELO with an over-long hostname', PLAIN, ['HELO ' + 'a'.repeat(400)], [501]],
        ['EHLO with a control character in the hostname', PLAIN, ['EHLO client\u0001.example.com'], [501]],
        ['EHLO with an over-long hostname', PLAIN, ['EHLO ' + 'a'.repeat(400)], [501]],
        ['EHLO with a hostname at the length limit', PLAIN, ['EHLO ' + 'a'.repeat(300)], [250]],
        ['EHLO with an address literal', PLAIN, ['EHLO [192.0.2.1]'], [250]],
        ['NOOP before EHLO', PLAIN, ['NOOP'], [250]],
        ['HELP', PLAIN, ['HELP'], [214]],
        ['VRFY', PLAIN, ['VRFY user'], [252]],
        ['VRFY without an argument', PLAIN, ['VRFY'], [501]],
        ['unknown command', PLAIN, ['EXPN list'], [500]],
        ['empty line', PLAIN, [''], [500]],
        ['disabled command', { disabledCommands: ['AUTH', 'VRFY'] }, ['VRFY user'], [500]],
        ['QUIT closes the connection', PLAIN, ['QUIT', 'NOOP'], [221, null]]
    ],

    'Addresses (RFC 5321 section 4.1.2)': [
        ['null sender', PLAIN, ['EHLO client.example.com', 'MAIL FROM:<>'], [250, 250]],
        ['domainless postmaster recipient', PLAIN, ['EHLO client.example.com', MAIL, 'RCPT TO:<postmaster>', 'RCPT TO:<PostMaster>'], [250, 250, 250, 250]],
        ['domainless sender', PLAIN, ['EHLO client.example.com', 'MAIL FROM:<postmaster>'], [250, 501]],
        ['domainless recipient other than postmaster', PLAIN, ['EHLO client.example.com', MAIL, 'RCPT TO:<user>'], [250, 250, 501]],
        [
            'source route',
            PLAIN,
            [
                'EHLO client.example.com',
                'MAIL FROM:<@relay.example.com,@other.example.com:sender@example.com>',
                'RCPT TO:<@relay.example.com:rcpt@example.com>'
            ],
            [250, 250, 250]
        ],
        ['quoted local part', PLAIN, ['EHLO client.example.com', 'MAIL FROM:<"sender"@example.com>'], [250, 250]],
        ['missing brackets', PLAIN, ['EHLO client.example.com', 'MAIL FROM:sender@example.com'], [250, 501]]
    ],

    'MAIL and RCPT parameters': [
        ['SIZE with a number', ENHANCED, ['EHLO client.example.com', 'MAIL FROM:<sender@example.com> SIZE=100'], [250, 250]],
        ['SIZE that is not a number (RFC 1870)', ENHANCED, ['EHLO client.example.com', 'MAIL FROM:<sender@example.com> SIZE=abc'], [250, 501]],
        ['SIZE with a sign', ENHANCED, ['EHLO client.example.com', 'MAIL FROM:<sender@example.com> SIZE=-1'], [250, 501]],
        ['duplicate RET (RFC 3461 section 4)', DSN, ['EHLO client.example.com', 'MAIL FROM:<sender@example.com> RET=FULL RET=HDRS'], [250, 501]],
        ['duplicate parameter on RCPT', DSN, ['EHLO client.example.com', MAIL, 'RCPT TO:<rcpt@example.com> NOTIFY=NEVER NOTIFY=SUCCESS'], [250, 250, 501]],
        ['valid ORCPT', DSN, ['EHLO client.example.com', MAIL, 'RCPT TO:<rcpt@example.com> ORCPT=rfc822;rcpt@example.com'], [250, 250, 250]],
        [
            'ORCPT without an address type (RFC 3461 section 4.2)',
            DSN,
            ['EHLO client.example.com', MAIL, 'RCPT TO:<rcpt@example.com> ORCPT=rcpt@example.com'],
            [250, 250, 501]
        ]
    ],

    'Enhanced status codes (RFC 2034)': [
        ['on success', ENHANCED, ['NOOP', 'EHLO client.example.com', MAIL, RCPT, 'RSET'], [250, 250, 250, 250, 250]],
        ['on failure', ENHANCED, [MAIL, 'EHLO client.example.com', 'RCPT TO:<bad', 'FOO'], [503, 250, 501, 500]],
        [
            'on a message over the SIZE limit',
            Object.assign({ size: 1024 }, ENHANCED),
            ['EHLO client.example.com', 'MAIL FROM:<sender@example.com> SIZE=2048'],
            [250, 552]
        ],
        [
            'on a whole transaction',
            ENHANCED,
            ['EHLO client.example.com', MAIL, RCPT, 'DATA', 'Subject: test\r\n\r\nHello\r\n.', 'QUIT'],
            [250, 250, 250, 354, 250, 221]
        ]
    ],

    'Authentication (RFC 4954)': [
        ['AUTH before EHLO', AUTH, ['AUTH PLAIN ' + PLAIN_TOKEN], [503]],
        ['MAIL before AUTH', AUTH, ['EHLO client.example.com', MAIL], [250, 530]],
        ['unknown mechanism', AUTH, ['EHLO client.example.com', 'AUTH FOO'], [250, 504]],
        ['PLAIN with an initial response', AUTH, ['EHLO client.example.com', 'AUTH PLAIN ' + PLAIN_TOKEN, MAIL], [250, 235, 250]],
        ['PLAIN without an initial response', AUTH, ['EHLO client.example.com', 'AUTH PLAIN', PLAIN_TOKEN, MAIL], [250, 334, 235, 250]],
        ['PLAIN aborted', AUTH, ['EHLO client.example.com', 'AUTH PLAIN', '*', MAIL], [250, 334, 501, 530]],
        ['PLAIN with too many arguments', AUTH, ['EHLO client.example.com', 'AUTH PLAIN a b'], [250, 501]],
        ['PLAIN with an invalid token', AUTH, ['EHLO client.example.com', 'AUTH PLAIN AAAA'], [250, 501]],
        ['LOGIN in steps', AUTH, ['EHLO client.example.com', 'AUTH LOGIN', 'dXNlcg==', 'cGFzcw==', MAIL], [250, 334, 334, 235, 250]],
        ['LOGIN with the username as initial response', AUTH, ['EHLO client.example.com', 'AUTH LOGIN dXNlcg==', 'cGFzcw=='], [250, 334, 235]],
        ['LOGIN aborted at the username', AUTH, ['EHLO client.example.com', 'AUTH LOGIN', '*'], [250, 334, 501]],
        ['LOGIN aborted at the password', AUTH, ['EHLO client.example.com', 'AUTH LOGIN', 'dXNlcg==', '*'], [250, 334, 334, 501]],
        ['LOGIN with wrong credentials', AUTH, ['EHLO client.example.com', 'AUTH LOGIN', 'dXNlcg==', 'd3Jvbmc='], [250, 334, 334, 535]],
        ['AUTH after a successful AUTH', AUTH, ['EHLO client.example.com', 'AUTH PLAIN ' + PLAIN_TOKEN, 'AUTH PLAIN ' + PLAIN_TOKEN], [250, 235, 503]],
        ['optional authentication', Object.assign({ authOptional: true }, AUTH), ['EHLO client.example.com', MAIL], [250, 250]]
    ],

    'XCLIENT and XFORWARD': [
        ['XCLIENT when not enabled', PLAIN, ['XCLIENT ADDR=192.0.2.1'], [550]],
        ['XFORWARD when not enabled', PLAIN, ['XFORWARD ADDR=192.0.2.1'], [550]],
        [
            'XCLIENT re-greets the client',
            XCLIENT,
            ['EHLO proxy.example.com', 'XCLIENT ADDR=192.0.2.1 NAME=client.example.com', 'EHLO client.example.com'],
            [250, 220, 250]
        ],
        ['XCLIENT twice', XCLIENT, ['XCLIENT ADDR=192.0.2.1', 'XCLIENT ADDR=192.0.2.2'], [220, 550]],
        ['XCLIENT during a transaction', XCLIENT, ['EHLO proxy.example.com', MAIL, 'XCLIENT ADDR=192.0.2.1'], [250, 250, 503]],
        ['XCLIENT without parameters', XCLIENT, ['XCLIENT'], [501]],
        [
            'XFORWARD with every parameter',
            XCLIENT,
            ['XFORWARD ADDR=192.0.2.1 NAME=client.example.com PORT=1234 PROTO=ESMTP HELO=helo.example.com IDENT=abc SOURCE=REMOTE'],
            [250]
        ],
        ['XFORWARD with unavailable values', XCLIENT, ['XFORWARD ADDR=[UNAVAILABLE] NAME=[UNAVAILABLE]'], [250]],
        ['XFORWARD without parameters', XCLIENT, ['XFORWARD'], [501]],
        ['XFORWARD with an unknown parameter', XCLIENT, ['XFORWARD FOO=bar'], [501]],
        ['XFORWARD with an invalid address', XCLIENT, ['XFORWARD ADDR=not-an-ip'], [501]],
        ['XFORWARD with an invalid hostname', XCLIENT, ['XFORWARD NAME=bad!host.example.com'], [501]],
        ['XCLIENT with an overlong hostname', XCLIENT, ['XCLIENT NAME=' + 'a'.repeat(600) + '.example.com'], [501]],
        ['XFORWARD during a transaction', XCLIENT, ['EHLO proxy.example.com', MAIL, 'XFORWARD ADDR=192.0.2.1'], [250, 250, 503]],
        ['XFORWARD after XCLIENT ADDR', XCLIENT, ['XCLIENT ADDR=192.0.2.1', 'XFORWARD ADDR=192.0.2.2'], [220, 550]],
        ['XCLIENT from a peer outside the useXClient list', XCLIENT_UNTRUSTED, ['XCLIENT ADDR=192.0.2.1'], [550]],
        ['XFORWARD from a peer outside the useXForward list', XCLIENT_UNTRUSTED, ['XFORWARD ADDR=192.0.2.1'], [550]],
        ['XCLIENT from a listed peer written as an IPv4-mapped address', XCLIENT_MAPPED, ['XCLIENT ADDR=192.0.2.1'], [220]],
        ['XFORWARD from a listed peer written as an IPv4-mapped address', XCLIENT_MAPPED, ['XFORWARD ADDR=192.0.2.1'], [250]]
    ],

    'Recipient limit': [
        [
            'maxRecipients refuses the recipient over the limit',
            LIMITED,
            ['EHLO client.example.com', MAIL, 'RCPT TO:<a@example.com>', 'RCPT TO:<b@example.com>', 'RCPT TO:<c@example.com>'],
            [250, 250, 250, 250, 452]
        ],
        [
            'a repeated recipient does not count against maxRecipients',
            LIMITED,
            ['EHLO client.example.com', MAIL, 'RCPT TO:<a@example.com>', 'RCPT TO:<b@example.com>', 'RCPT TO:<A@example.com>'],
            [250, 250, 250, 250, 250]
        ],
        [
            'RSET resets the recipient count',
            LIMITED,
            ['EHLO client.example.com', MAIL, 'RCPT TO:<a@example.com>', 'RCPT TO:<b@example.com>', 'RSET', MAIL, 'RCPT TO:<c@example.com>'],
            [250, 250, 250, 250, 250, 250, 250]
        ],
        [
            'the transaction continues with the accepted recipients',
            LIMITED,
            ['EHLO client.example.com', MAIL, 'RCPT TO:<a@example.com>', 'RCPT TO:<b@example.com>', 'RCPT TO:<c@example.com>', 'DATA'],
            [250, 250, 250, 250, 452, 354]
        ]
    ],

    'LMTP (RFC 2033)': [
        ['EHLO is not allowed', LMTP, ['EHLO client.example.com'], [500]],
        ['HELO is not allowed', LMTP, ['HELO client.example.com'], [500]],
        ['LHLO opens the session', LMTP, ['LHLO client.example.com', MAIL], [250, 250]],
        ['MAIL before LHLO', LMTP, [MAIL], [503]]
    ]
};

describe('Protocol', () => {
    for (let [group, cases] of Object.entries(CASES)) {
        describe(group, () => {
            for (let [description, options, commands, expected] of cases) {
                it(description, () =>
                    withServer(options, async ({ port }) => {
                        let [greeting, ...replies] = await chat(port, commands);
                        assert.strictEqual(greeting!.code, 220);
                        assert.deepStrictEqual(
                            replies.map(reply => reply && reply.code),
                            expected
                        );

                        if (options.hideENHANCEDSTATUSCODES === false) {
                            // RFC 2034 section 3: every reply except the greeting, EHLO and 3xx
                            // carries an enhanced status code whose class matches the reply code
                            replies.forEach((reply, i) => {
                                if (reply && !/^EHLO /.test(commands[i]) && reply.code !== 354) {
                                    assert.strictEqual(
                                        reply.lines.every(line => /^\d{3}[ -]\d\.\d{1,3}\.\d{1,3} /.test(line)),
                                        true,
                                        commands[i]
                                    );
                                }
                            });
                        }
                    })
                );
            }
        });
    }

    describe('Enhanced status code values (RFC 3463)', () => {
        // the enhanced status code of every reply to the commands, null if there is none
        let enhancedCodes = (options: any, commands: string[]) =>
            withServer(Object.assign({ hideENHANCEDSTATUSCODES: false }, options), ({ port }) => chat(port, commands)).then(replies =>
                replies.slice(1).map((reply: any) => (reply.lines[0].match(/^\d{3}[ -](\d\.\d{1,3}\.\d{1,3}) /) || [])[1] || null)
            );

        it('should use 5.1.7 for a bad sender and 5.1.3 for a bad recipient', async () => {
            assert.deepStrictEqual(await enhancedCodes(PLAIN, ['EHLO client.example.com', 'MAIL FROM:<bad', MAIL, 'RCPT TO:<bad']), [
                null,
                '5.1.7',
                '2.1.0',
                '5.1.3'
            ]);
        });

        it('should use 5.3.4 for a message over the size limit', async () => {
            assert.deepStrictEqual(
                await enhancedCodes({ size: 1024, disabledCommands: ['AUTH'] }, ['EHLO client.example.com', 'MAIL FROM:<sender@example.com> SIZE=2048']),
                [null, '5.3.4']
            );
        });

        it('should use 5.7.0 for a refused proxy command and none for the XCLIENT greeting', async () => {
            assert.deepStrictEqual(await enhancedCodes(XCLIENT, ['XCLIENT ADDR=192.0.2.1', 'XCLIENT ADDR=192.0.2.2', 'XFORWARD ADDR=192.0.2.3']), [
                null,
                '5.7.0',
                '5.7.0'
            ]);
        });

        it('should use 4.5.3 for a recipient over maxRecipients', async () => {
            assert.deepStrictEqual(
                await enhancedCodes(LIMITED, [
                    'EHLO client.example.com',
                    MAIL,
                    'RCPT TO:<a@example.com>',
                    'RCPT TO:<b@example.com>',
                    'RCPT TO:<c@example.com>'
                ]),
                [null, '2.1.0', '2.1.5', '2.1.5', '4.5.3']
            );
        });
    });

    describe('Source routes', () => {
        it('should drop the source route from the address', async () => {
            let addresses: string[] = [];
            let options = Object.assign({}, PLAIN, {
                onMailFrom(address: any, session: any, callback: any) {
                    addresses.push(address.address);
                    callback();
                },
                onRcptTo(address: any, session: any, callback: any) {
                    addresses.push(address.address);
                    callback();
                }
            });
            await withServer(options, ({ port }) =>
                chat(port, [
                    'EHLO client.example.com',
                    'MAIL FROM:<@relay.example.com:sender@example.com>',
                    'RCPT TO:<@a.example.com,@b.example.com:rcpt@example.com>'
                ])
            );
            assert.deepStrictEqual(addresses, ['sender@example.com', 'rcpt@example.com']);
        });
    });

    describe('EHLO capabilities', () => {
        // replies to the commands, the greeting left out
        let replies = (options: any, commands: string[]): Promise<any[]> => withServer(options, ({ port }) => chat(port, commands)).then(list => list.slice(1));
        let capabilities = async (options: any) => {
            let [ehlo] = await replies(options, ['EHLO client.example.com']);
            return ehlo.lines.slice(1).map((line: string) => line.slice(4));
        };

        it('should advertise the default extensions', async () => {
            assert.deepStrictEqual(await capabilities({}), ['PIPELINING', '8BITMIME', 'SMTPUTF8', 'AUTH LOGIN PLAIN', 'STARTTLS']);
        });

        it('should advertise opt-in extensions', async () => {
            let features = await capabilities({
                hideENHANCEDSTATUSCODES: false,
                hideDSN: false,
                size: 1024,
                useXClient: true,
                useXForward: true,
                disabledCommands: ['AUTH', 'STARTTLS']
            });
            assert.deepStrictEqual(features, [
                'PIPELINING',
                '8BITMIME',
                'SMTPUTF8',
                'ENHANCEDSTATUSCODES',
                'DSN',
                'SIZE 1024',
                'XCLIENT NAME ADDR PORT PROTO HELO LOGIN',
                'XFORWARD NAME ADDR PORT PROTO HELO IDENT SOURCE'
            ]);
        });

        it('should stop advertising XCLIENT and XFORWARD after XCLIENT ADDR', async () => {
            let [, ehlo] = await replies(XCLIENT, ['XCLIENT ADDR=192.0.2.1', 'EHLO client.example.com']);
            assert.doesNotMatch(ehlo.text, /XCLIENT|XFORWARD/);
        });

        it('should advertise XCLIENT and XFORWARD only to the peers in the trust lists', async () => {
            let [outside] = await replies(XCLIENT_UNTRUSTED, ['EHLO client.example.com']);
            assert.doesNotMatch(outside.text, /XCLIENT|XFORWARD/);

            let [listed] = await replies(XCLIENT_MAPPED, ['EHLO client.example.com']);
            assert.match(listed.text, /XCLIENT/);
            assert.match(listed.text, /XFORWARD/);
        });

        it('should hide AUTH once authenticated', async () => {
            let [before, , after] = await replies(AUTH, ['EHLO client.example.com', 'AUTH PLAIN ' + PLAIN_TOKEN, 'EHLO client.example.com']);
            assert.match(before.text, /AUTH PLAIN LOGIN/);
            assert.doesNotMatch(after.text, /AUTH/);
        });
    });

    describe('XCLIENT and XFORWARD session data', () => {
        // runs the commands and collects the given session details on every MAIL FROM
        let sessionsOnMail = (commands: string[], pick: (session: any) => any): Promise<any[]> => {
            let sessions: any[] = [];
            let onMailFrom = (address: any, session: any, callback: any) => {
                sessions.push(pick(session));
                callback();
            };
            return withServer(Object.assign({ onMailFrom }, XCLIENT), ({ port }) => chat(port, commands)).then(() => sessions);
        };

        it('should expose the forwarded client in the session', async () => {
            let sessions = await sessionsOnMail(
                [
                    'XFORWARD ADDR=192.0.2.1 NAME=client.example.com PORT=1234 HELO=helo.example.com',
                    'EHLO proxy.example.com',
                    MAIL,
                    'RSET',
                    'XCLIENT ADDR=198.51.100.7 PORT=4321',
                    'EHLO client.example.com',
                    MAIL
                ],
                (session: any) => ({
                    remoteAddress: session.remoteAddress,
                    remotePort: session.remotePort,
                    clientHostname: session.clientHostname,
                    xForward: Object.fromEntries(session.xForward)
                })
            );
            assertDeepIncludes(sessions[0], { remoteAddress: '192.0.2.1', remotePort: 1234, clientHostname: 'client.example.com' });
            assertIncludes(sessions[0].xForward, { ADDR: '192.0.2.1', HELO: 'helo.example.com' });
            assertDeepIncludes(sessions[1], { remoteAddress: '198.51.100.7', remotePort: 4321 });
        });

        it('should keep the XCLIENT address if XFORWARD is attempted afterwards', async () => {
            let sessions = await sessionsOnMail(
                ['XCLIENT ADDR=198.51.100.7', 'XFORWARD ADDR=192.0.2.66', 'EHLO client.example.com', MAIL],
                (session: any) => session.remoteAddress
            );
            assert.deepStrictEqual(sessions, ['198.51.100.7']);
        });

        it('should refresh the session when XFORWARD follows EHLO', async () => {
            // XFORWARD is not followed by a new EHLO, so without this the handlers of the
            // transaction would still see the proxy
            let sessions = await sessionsOnMail(
                ['EHLO proxy.example.com', 'XFORWARD ADDR=192.0.2.1 PORT=2525 NAME=client.example.com', MAIL],
                (session: any) => ({
                    remoteAddress: session.remoteAddress,
                    remotePort: session.remotePort,
                    clientHostname: session.clientHostname,
                    xForward: Object.fromEntries(session.xForward),
                    xClient: Object.fromEntries(session.xClient)
                })
            );
            assertDeepIncludes(sessions[0], { remoteAddress: '192.0.2.1', remotePort: 2525, clientHostname: 'client.example.com' });
            // the address the proxy connected from is kept next to the forwarded one, in the XFORWARD map
            assertIncludes(sessions[0].xForward, { ADDR: '192.0.2.1', 'ADDR:DEFAULT': '127.0.0.1' });
            assert.ok(!('ADDR:DEFAULT' in sessions[0].xClient), 'xClient should not have ADDR:DEFAULT');
        });

        describe('XCLIENT and the authenticated identity', () => {
            // the session user seen by onMailFrom after each command sequence
            let usersOnMail = (commands: string[]): Promise<any[]> => {
                let users: any[] = [];
                let options = {
                    useXClient: true,
                    authOptional: true,
                    allowInsecureAuth: true,
                    onAuth(auth: any, session: any, callback: any) {
                        callback(null, { user: auth.username });
                    },
                    onMailFrom(address: any, session: any, callback: any) {
                        users.push(session.user);
                        callback();
                    }
                };
                return withServer(options, ({ port }) => chat(port, commands)).then(() => users);
            };

            it('should drop an identity the proxy authenticated as on XCLIENT ADDR', async () => {
                // the forwarded client must not inherit the proxy's own login
                let users = await usersOnMail([
                    'EHLO proxy.example.com',
                    'AUTH PLAIN ' + PLAIN_TOKEN,
                    'XCLIENT ADDR=192.0.2.1',
                    'EHLO client.example.com',
                    MAIL
                ]);
                assert.deepStrictEqual(users, [false]);
            });

            it('should apply a LOGIN attribute given together with ADDR', async () => {
                let users = await usersOnMail(['XCLIENT ADDR=192.0.2.1 LOGIN=forwarded', 'EHLO client.example.com', MAIL]);
                assert.deepStrictEqual(users, ['forwarded']);
            });
        });

        it('should match the XCLIENT trust list against the PROXY protocol address', async () => {
            // behind a PROXY protocol load balancer the peer to trust is the one the header
            // names, not the load balancer itself
            let options = { disabledCommands: ['AUTH'], useProxy: true, useXClient: ['192.0.2.1'] };
            let xclientVia = async (port: number, proxiedAddress: string) => {
                let client = await RawClient.connect(port);
                try {
                    client.write('PROXY TCP4 ' + proxiedAddress + ' 203.0.113.7 35646 25\r\n');
                    assert.strictEqual((await client.read())!.code, 220);
                    return (await client.command('XCLIENT ADDR=198.51.100.7'))!.code;
                } finally {
                    client.close();
                }
            };
            await withServer(options, async ({ port }) => {
                assert.strictEqual(await xclientVia(port, '192.0.2.1'), 220);
                assert.strictEqual(await xclientVia(port, '192.0.2.2'), 550);
            });
        });
    });

    describe('LMTP DATA replies', () => {
        // LMTP sends one reply per accepted recipient after the message (RFC 2033 section 4.2)
        let deliver = (onData: any) =>
            withClient(Object.assign({ onData }, LMTP), async client => {
                await series(['LHLO client.example.com', MAIL, 'RCPT TO:<a@example.com>', 'RCPT TO:<b@example.com>', 'DATA'], command =>
                    client.command(command)
                );
                client.write('Subject: test\r\n\r\nHello\r\n.\r\n');
                let replies = [await client.read(), await client.read()];
                assert.strictEqual((await client.command('NOOP'))!.code, 250);
                return replies.map((reply: any) => reply.code + ' ' + reply.text);
            });

        let consume = (stream: any, callback: any, result: any[]) => {
            stream.on('data', () => false);
            stream.on('end', () => callback(...result));
        };

        it('should reply for every recipient on success', async () => {
            let replies = await deliver((stream: any, session: any, callback: any) => consume(stream, callback, [null, 'Delivered']));
            assert.deepStrictEqual(replies, ['250 Delivered', '250 Delivered']);
        });

        it('should reply for every recipient on failure', async () => {
            let replies = await deliver((stream: any, session: any, callback: any) => {
                let err: any = new Error('Mailbox full');
                err.responseCode = 452;
                consume(stream, callback, [err]);
            });
            assert.deepStrictEqual(replies, ['452 Mailbox full', '452 Mailbox full']);
        });

        it('should use separate results per recipient', async () => {
            let replies = await deliver((stream: any, session: any, callback: any) => {
                let err: any = new Error('No such user');
                err.responseCode = 550;
                consume(stream, callback, [null, ['Delivered to a', err]]);
            });
            assert.deepStrictEqual(replies, ['250 Delivered to a', '550 No such user']);
        });
    });

    describe('Server shutdown', () => {
        it('should refuse commands once the server is closing', () =>
            withClient(PLAIN, async (client, greeting, server) => {
                assert.strictEqual(greeting!.code, 220);
                server.close();
                assertIncludes(await client.command('EHLO client.example.com'), { code: 421 });
                assert.strictEqual(await client.read(), null);
            }));

        it('should close idle sessions once closeTimeout expires', () =>
            withClient(Object.assign({ closeTimeout: 200 }, PLAIN), async (client, greeting, server) => {
                assert.strictEqual(greeting!.code, 220);
                let start = Date.now();
                let closed = new Promise<void>(resolve => server.close(() => resolve()));
                assertIncludes(await client.read(), { code: 421 });
                assert.strictEqual(await client.read(), null);
                await closed;
                let elapsed = Date.now() - start;
                assert.ok(elapsed < 2000, 'expected ' + elapsed + ' to be below 2000');
            }));
    });
});
