import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { series, withServer, withClient, RawClient } from './test-client.js';

// Deterministic by default, set FUZZ_SEED to explore other inputs and
// FUZZ_ITERATIONS to run longer
const SEED = Number(process.env.FUZZ_SEED) || 0x5eed;
const ITERATIONS = Number(process.env.FUZZ_ITERATIONS) || 1000;

/**
 * mulberry32, a small seedable PRNG. Returns a float in [0, 1)
 */
function prng(seed: number): () => number {
    // the PRNG is built on 32-bit integer arithmetic
    /* eslint-disable no-bitwise */
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    /* eslint-enable no-bitwise */
}

// Valid commands for a session that already sent EHLO
const CORPUS = [
    'EHLO client.example.com',
    'HELO client.example.com',
    'MAIL FROM:<sender@example.com>',
    'MAIL FROM:<sender@example.com> SIZE=1000 BODY=8BITMIME',
    'MAIL FROM:<sender@example.com> SMTPUTF8',
    'MAIL FROM:<sender@example.com> RET=HDRS ENVID=QQ314159',
    'MAIL FROM:<> BODY=7BIT',
    'MAIL FROM:<"quoted local"@example.com>',
    'MAIL FROM:<user@[192.0.2.1]>',
    'MAIL FROM:<user@[IPv6:2001:db8::1]>',
    'MAIL FROM:<user@xn--bcher-kva.example>',
    'RCPT TO:<rcpt@example.com>',
    'RCPT TO:<rcpt@example.com> NOTIFY=SUCCESS,FAILURE ORCPT=rfc822;rcpt@example.com',
    'RCPT TO:<postmaster>',
    'RSET',
    'NOOP',
    'VRFY user',
    'HELP',
    'AUTH PLAIN ' + Buffer.from('\0user\0pass').toString('base64'),
    'AUTH LOGIN dXNlcg==',
    'AUTH XOAUTH2 ' + Buffer.from('user=user\x01auth=Bearer token\x01\x01').toString('base64'),
    'AUTH CRAM-MD5',
    'XCLIENT NAME=client.example.com ADDR=192.0.2.1 PORT=1234 PROTO=ESMTP HELO=client.example.com LOGIN=user',
    'XCLIENT ADDR=IPV6:2001:db8::1 NAME=[UNAVAILABLE]',
    'XFORWARD NAME=client.example.com ADDR=192.0.2.1 PORT=1234 PROTO=ESMTP HELO=client.example.com IDENT=abc SOURCE=REMOTE',
    'XFORWARD ADDR=[UNAVAILABLE] NAME=[TEMPUNAVAIL]'
];

const HOSTILE_TOKENS = [
    '\x00',
    '\r',
    '\n',
    '\t',
    ' ',
    '<',
    '>',
    '<>',
    '<<a@b>>',
    '"',
    '\\',
    '=',
    '@',
    ':',
    ',',
    '+',
    '%',
    '[',
    ']',
    '​',
    'é',
    '😀',
    'xn--',
    '[UNAVAILABLE]',
    'IPV6:',
    'SIZE=',
    'BODY=',
    'NOTIFY=NEVER,SUCCESS',
    'A'.repeat(600),
    'MAIL FROM:',
    'RCPT TO:'
];

const HOSTILE_NUMBERS = ['-1', '0', '4294967296', '99999999999999999999999', '1e308', 'NaN', '0x10', '1.5'];

/**
 * Applies one random mutation to a command
 */
function mutate(random: () => number, command: string): string {
    let pick = (list: string[]) => list[Math.floor(random() * list.length)];
    let tokens = command.split(' ');
    let position = Math.floor(random() * (command.length + 1));

    switch (Math.floor(random() * 6)) {
        case 0: {
            // replace a byte with a random one, including control and 8-bit bytes
            let bytes = Buffer.from(command, 'binary');
            bytes[Math.min(position, bytes.length - 1)] = Math.floor(random() * 256);
            return bytes.toString('binary');
        }
        case 1:
            return command.slice(0, position);
        case 2:
            return command.slice(0, position) + Buffer.from(pick(HOSTILE_TOKENS)).toString('binary') + command.slice(position);
        case 3: {
            let index = Math.floor(random() * tokens.length);
            tokens.splice(index, 0, tokens[index]);
            return tokens.join(' ');
        }
        case 4:
            tokens.splice(Math.floor(random() * tokens.length), 1);
            return tokens.join(' ');
        default:
            return command.replace(/\d+/, pick(HOSTILE_NUMBERS));
    }
}

describe('Fuzzing', () => {
    let fuzz = async ({ server, port }: { server: any; port: number }) => {
        let errors: Error[] = [];
        server.on('error', (err: Error) => errors.push(err));

        let random = prng(SEED);
        let client: RawClient | undefined;
        let connections = 0;

        let connect = async () => {
            connections++;
            client = await RawClient.connect(port);
            assert.strictEqual((await client.read())!.code, 220);
            assert.strictEqual((await client.command('EHLO fuzz.example.com'))!.code, 250);
        };

        let input: string | undefined;
        let transcript: string[] = [];

        // Reads the replies to one input, answering the ones that wait for more input.
        // Resolves with true if the server is closing the connection
        let readReplies = async (expected: number): Promise<boolean> => {
            if (expected <= 0) {
                return false;
            }
            let reply = await client!.read();
            // the server may close the connection, but only after saying why
            assert.notStrictEqual(reply, null, 'connection closed without a 221 or 421');
            if (!reply) {
                return true;
            }
            transcript.push(reply.code + ' ' + reply.text);

            switch (reply.code) {
                case 221:
                case 421:
                    return true;
                case 334:
                    // abort the SASL exchange the mutation started
                    client!.write('*\r\n');
                    return readReplies(expected);
                case 354:
                    // a complete transaction, end the empty message
                    client!.write('.\r\n');
                    return readReplies(expected);
            }
            return readReplies(expected - 1);
        };

        let iterate = async (i: number): Promise<void> => {
            if (i >= ITERATIONS) {
                return;
            }

            input = mutate(random, CORPUS[Math.floor(random() * CORPUS.length)]);
            if (random() < 0.3) {
                input = mutate(random, input);
            }
            transcript = [];

            client!.write(Buffer.from(input + '\r\n', 'binary'));

            // the parser splits on LF, every resulting line gets exactly one reply
            if (await readReplies(input.split('\n').length)) {
                // wait for the close, then check that a new session still works
                assert.strictEqual(await client!.read(), null);
                client!.close();
                await connect();
            } else {
                // liveness probe, also drops whatever transaction state the input created
                let probe = await client!.command('RSET');
                assert.strictEqual(probe && probe.code, 250, 'RSET after the input');
            }

            return iterate(i + 1);
        };

        try {
            await connect();
            await iterate(0);

            assert.deepStrictEqual(
                errors.map(err => err.message),
                []
            );
            assert.ok(connections < ITERATIONS, 'expected ' + connections + ' to be below ' + ITERATIONS);
        } catch (err: any) {
            let details = '\nFUZZ_SEED=' + SEED + ' input=' + JSON.stringify(input) + ' replies=' + JSON.stringify(transcript);
            err.message += details;
            // the stack is captured when the error is created and node:test prints it, so
            // the details have to go there as well to show up in the report
            if (typeof err.stack === 'string' && !err.stack.includes(details)) {
                err.stack = err.stack.replace(/\n\s+at /, (match: string) => details + match);
            }
            throw err;
        } finally {
            if (client) {
                client.close();
            }
        }
    };

    it('should answer every mutated command with a valid reply and stay usable', () =>
        withServer(
            {
                size: 1024 * 1024,
                hideDSN: false,
                hideENHANCEDSTATUSCODES: false,
                useXClient: true,
                useXForward: true,
                disabledCommands: ['STARTTLS'],
                authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2', 'CRAM-MD5'],
                authOptional: true,
                allowInsecureAuth: true,
                onAuth(auth: any, session: any, callback: any) {
                    callback(null, { user: auth.username || 'user' });
                }
            },
            fuzz
        ));
});

describe('Fragmented input', () => {
    // Lines starting with a dot are dot-stuffed on the wire (RFC 5321 section 4.5.2)
    const MESSAGE = 'Subject: fragments\r\n\r\n.leading dot\r\n..two dots\r\nlast line without dot';
    const WIRE = MESSAGE.replace(/^\./gm, '..') + '\r\n.\r\n';

    /**
     * Writes data in random sized chunks, yielding to the event loop between them so
     * the server sees separate reads
     */
    let writeChunked = (client: RawClient, data: string, random: () => number, maxChunk: number): Promise<void> => {
        let bytes = Buffer.from(data);
        let next = (pos: number): Promise<void> => {
            if (pos >= bytes.length) {
                return Promise.resolve();
            }
            let size = 1 + Math.floor(random() * maxChunk);
            client.write(bytes.subarray(pos, pos + size));
            return new Promise<void>(resolve => setImmediate(resolve)).then(() => next(pos + size));
        };
        return next(0);
    };

    for (let maxChunk of [1, 3, 17]) {
        it('should handle a session delivered in chunks of up to ' + maxChunk + ' bytes', async () => {
            let received: any[] = [];
            let onData = (stream: any, session: any, callback: any) => {
                let chunks: Buffer[] = [];
                stream.on('data', (chunk: Buffer) => chunks.push(chunk));
                stream.on('end', () => {
                    received.push({
                        from: session.envelope.mailFrom.address,
                        to: session.envelope.rcptTo.map((rcpt: any) => rcpt.address),
                        message: Buffer.concat(chunks).toString()
                    });
                    callback();
                });
            };
            let random = prng(SEED + maxChunk);

            let codes = await withClient({ disabledCommands: ['AUTH', 'STARTTLS'], onData }, (client, greeting) =>
                series(
                    [
                        'EHLO client.example.com\r\n',
                        'MAIL FROM:<sender@example.com>\r\n',
                        'RCPT TO:<a@example.com>\r\n',
                        'RCPT TO:<b@example.com>\r\n',
                        'DATA\r\n',
                        WIRE,
                        'QUIT\r\n'
                    ],
                    async data => {
                        await writeChunked(client, data, random, maxChunk);
                        return (await client.read())!.code;
                    }
                ).then(list => [greeting!.code].concat(list))
            );

            assert.deepStrictEqual(codes, [220, 250, 250, 250, 250, 354, 250, 221]);
            assert.deepStrictEqual(received, [
                {
                    from: 'sender@example.com',
                    to: ['a@example.com', 'b@example.com'],
                    message: MESSAGE + '\r\n'
                }
            ]);
        });
    }

    it('should handle pipelined commands sent in a single write (RFC 2920)', () =>
        withClient({ disabledCommands: ['AUTH', 'STARTTLS'] }, async client => {
            await client.command('EHLO client.example.com');
            client.write('MAIL FROM:<sender@example.com>\r\nRCPT TO:<a@example.com>\r\nRCPT TO:<bad\r\nRCPT TO:<b@example.com>\r\nDATA\r\n');
            let pipelined = await series([1, 2, 3, 4, 5], () => client.read());
            client.write(WIRE + 'QUIT\r\n');
            let codes = pipelined.concat([await client.read(), await client.read()]).map(reply => reply!.code);
            assert.deepStrictEqual(codes, [250, 250, 501, 250, 354, 250, 221]);
        }));
});
