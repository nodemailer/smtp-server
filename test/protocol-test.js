'use strict';

const chai = require('chai');
const { chat, series, withServer, withClient } = require('./test-client');

const expect = chai.expect;

chai.config.includeStack = true;

const PLAIN = { disabledCommands: ['AUTH'] };
const ENHANCED = { disabledCommands: ['AUTH'], hideENHANCEDSTATUSCODES: false };
const XCLIENT = { disabledCommands: ['AUTH'], useXClient: true, useXForward: true };
const LMTP = { lmtp: true, disabledCommands: ['AUTH'] };
const DSN = { disabledCommands: ['AUTH'], hideDSN: false };
const AUTH = {
    authMethods: ['PLAIN', 'LOGIN'],
    allowInsecureAuth: true,
    onAuth(auth, session, callback) {
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
const CASES = {
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
        ['XFORWARD after XCLIENT ADDR', XCLIENT, ['XCLIENT ADDR=192.0.2.1', 'XFORWARD ADDR=192.0.2.2'], [220, 550]]
    ],

    'LMTP (RFC 2033)': [
        ['EHLO is not allowed', LMTP, ['EHLO client.example.com'], [500]],
        ['HELO is not allowed', LMTP, ['HELO client.example.com'], [500]],
        ['LHLO opens the session', LMTP, ['LHLO client.example.com', MAIL], [250, 250]],
        ['MAIL before LHLO', LMTP, [MAIL], [503]]
    ]
};

describe('Protocol', function () {
    this.timeout(10 * 1000);

    for (let [group, cases] of Object.entries(CASES)) {
        describe(group, function () {
            for (let [description, options, commands, expected] of cases) {
                it(description, () =>
                    withServer(options, async ({ port }) => {
                        let [greeting, ...replies] = await chat(port, commands);
                        expect(greeting.code).to.equal(220);
                        expect(replies.map(reply => reply && reply.code)).to.deep.equal(expected);

                        if (options.hideENHANCEDSTATUSCODES === false) {
                            // RFC 2034 section 3: every reply except the greeting, EHLO and 3xx
                            // carries an enhanced status code whose class matches the reply code
                            replies.forEach((reply, i) => {
                                if (reply && !/^EHLO /.test(commands[i]) && reply.code !== 354) {
                                    expect(
                                        reply.lines.every(line => /^\d{3}[ -]\d\.\d{1,3}\.\d{1,3} /.test(line)),
                                        commands[i]
                                    ).to.be.true;
                                }
                            });
                        }
                    })
                );
            }
        });
    }

    describe('Enhanced status code values (RFC 3463)', function () {
        // the enhanced status code of every reply to the commands, null if there is none
        let enhancedCodes = (options, commands) =>
            withServer(Object.assign({ hideENHANCEDSTATUSCODES: false }, options), ({ port }) => chat(port, commands)).then(replies =>
                replies.slice(1).map(reply => (reply.lines[0].match(/^\d{3}[ -](\d\.\d{1,3}\.\d{1,3}) /) || [])[1] || null)
            );

        it('should use 5.1.7 for a bad sender and 5.1.3 for a bad recipient', async function () {
            expect(await enhancedCodes(PLAIN, ['EHLO client.example.com', 'MAIL FROM:<bad', MAIL, 'RCPT TO:<bad'])).to.deep.equal([
                null,
                '5.1.7',
                '2.1.0',
                '5.1.3'
            ]);
        });

        it('should use 5.3.4 for a message over the size limit', async function () {
            expect(
                await enhancedCodes({ size: 1024, disabledCommands: ['AUTH'] }, ['EHLO client.example.com', 'MAIL FROM:<sender@example.com> SIZE=2048'])
            ).to.deep.equal([null, '5.3.4']);
        });

        it('should use 5.7.0 for a refused proxy command and none for the XCLIENT greeting', async function () {
            expect(await enhancedCodes(XCLIENT, ['XCLIENT ADDR=192.0.2.1', 'XCLIENT ADDR=192.0.2.2', 'XFORWARD ADDR=192.0.2.3'])).to.deep.equal([
                null,
                '5.7.0',
                '5.7.0'
            ]);
        });
    });

    describe('Source routes', function () {
        it('should drop the source route from the address', async function () {
            let addresses = [];
            let options = Object.assign({}, PLAIN, {
                onMailFrom(address, session, callback) {
                    addresses.push(address.address);
                    callback();
                },
                onRcptTo(address, session, callback) {
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
            expect(addresses).to.deep.equal(['sender@example.com', 'rcpt@example.com']);
        });
    });

    describe('EHLO capabilities', function () {
        // replies to the commands, the greeting left out
        let replies = (options, commands) => withServer(options, ({ port }) => chat(port, commands)).then(list => list.slice(1));
        let capabilities = async options => {
            let [ehlo] = await replies(options, ['EHLO client.example.com']);
            return ehlo.lines.slice(1).map(line => line.slice(4));
        };

        it('should advertise the default extensions', async function () {
            expect(await capabilities({})).to.deep.equal(['PIPELINING', '8BITMIME', 'SMTPUTF8', 'AUTH LOGIN PLAIN', 'STARTTLS']);
        });

        it('should advertise opt-in extensions', async function () {
            let features = await capabilities({
                hideENHANCEDSTATUSCODES: false,
                hideDSN: false,
                size: 1024,
                useXClient: true,
                useXForward: true,
                disabledCommands: ['AUTH', 'STARTTLS']
            });
            expect(features).to.deep.equal([
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

        it('should stop advertising XCLIENT and XFORWARD after XCLIENT ADDR', async function () {
            let [, ehlo] = await replies(XCLIENT, ['XCLIENT ADDR=192.0.2.1', 'EHLO client.example.com']);
            expect(ehlo.text).to.not.match(/XCLIENT|XFORWARD/);
        });

        it('should hide AUTH once authenticated', async function () {
            let [before, , after] = await replies(AUTH, ['EHLO client.example.com', 'AUTH PLAIN ' + PLAIN_TOKEN, 'EHLO client.example.com']);
            expect(before.text).to.match(/AUTH PLAIN LOGIN/);
            expect(after.text).to.not.match(/AUTH/);
        });
    });

    describe('XCLIENT and XFORWARD session data', function () {
        // runs the commands and collects the given session details on every MAIL FROM
        let sessionsOnMail = (commands, pick) => {
            let sessions = [];
            let onMailFrom = (address, session, callback) => {
                sessions.push(pick(session));
                callback();
            };
            return withServer(Object.assign({ onMailFrom }, XCLIENT), ({ port }) => chat(port, commands)).then(() => sessions);
        };

        it('should expose the forwarded client in the session', async function () {
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
                session => ({
                    remoteAddress: session.remoteAddress,
                    remotePort: session.remotePort,
                    clientHostname: session.clientHostname,
                    xForward: Object.fromEntries(session.xForward)
                })
            );
            expect(sessions[0]).to.deep.include({ remoteAddress: '192.0.2.1', remotePort: 1234, clientHostname: 'client.example.com' });
            expect(sessions[0].xForward).to.include({ ADDR: '192.0.2.1', HELO: 'helo.example.com' });
            expect(sessions[1]).to.deep.include({ remoteAddress: '198.51.100.7', remotePort: 4321 });
        });

        it('should keep the XCLIENT address if XFORWARD is attempted afterwards', async function () {
            let sessions = await sessionsOnMail(
                ['XCLIENT ADDR=198.51.100.7', 'XFORWARD ADDR=192.0.2.66', 'EHLO client.example.com', MAIL],
                session => session.remoteAddress
            );
            expect(sessions).to.deep.equal(['198.51.100.7']);
        });
    });

    describe('LMTP DATA replies', function () {
        // LMTP sends one reply per accepted recipient after the message (RFC 2033 section 4.2)
        let deliver = onData =>
            withClient(Object.assign({ onData }, LMTP), async client => {
                await series(['LHLO client.example.com', MAIL, 'RCPT TO:<a@example.com>', 'RCPT TO:<b@example.com>', 'DATA'], command =>
                    client.command(command)
                );
                client.write('Subject: test\r\n\r\nHello\r\n.\r\n');
                let replies = [await client.read(), await client.read()];
                expect((await client.command('NOOP')).code).to.equal(250);
                return replies.map(reply => reply.code + ' ' + reply.text);
            });

        let consume = (stream, callback, result) => {
            stream.on('data', () => false);
            stream.on('end', () => callback(...result));
        };

        it('should reply for every recipient on success', async function () {
            let replies = await deliver((stream, session, callback) => consume(stream, callback, [null, 'Delivered']));
            expect(replies).to.deep.equal(['250 Delivered', '250 Delivered']);
        });

        it('should reply for every recipient on failure', async function () {
            let replies = await deliver((stream, session, callback) => {
                let err = new Error('Mailbox full');
                err.responseCode = 452;
                consume(stream, callback, [err]);
            });
            expect(replies).to.deep.equal(['452 Mailbox full', '452 Mailbox full']);
        });

        it('should use separate results per recipient', async function () {
            let replies = await deliver((stream, session, callback) => {
                let err = new Error('No such user');
                err.responseCode = 550;
                consume(stream, callback, [null, ['Delivered to a', err]]);
            });
            expect(replies).to.deep.equal(['250 Delivered to a', '550 No such user']);
        });
    });

    describe('Server shutdown', function () {
        it('should refuse commands once the server is closing', () =>
            withClient(PLAIN, async (client, greeting, server) => {
                expect(greeting.code).to.equal(220);
                server.close();
                expect(await client.command('EHLO client.example.com')).to.include({ code: 421 });
                expect(await client.read()).to.be.null;
            }));

        it('should close idle sessions once closeTimeout expires', () =>
            withClient(Object.assign({ closeTimeout: 200 }, PLAIN), async (client, greeting, server) => {
                expect(greeting.code).to.equal(220);
                let start = Date.now();
                let closed = new Promise(resolve => server.close(resolve));
                expect(await client.read()).to.include({ code: 421 });
                expect(await client.read()).to.be.null;
                await closed;
                expect(Date.now() - start).to.be.below(2000);
            }));
    });
});
