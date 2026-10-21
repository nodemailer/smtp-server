import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withClient, RawClient, type Reply } from './test-client.js';
import type { SMTPServerDataStream, SMTPServerOptions, SMTPServerSession } from '../src/smtp-server.js';

// Deterministic by default, set FUZZ_SEED to explore other inputs and
// FUZZ_ITERATIONS to run longer
const SEED = Number(process.env.FUZZ_SEED) || 0x5eed;
const ITERATIONS = Number(process.env.FUZZ_ITERATIONS) || 150;

const LIMIT = 1000;

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

type DataHandler = (stream: SMTPServerDataStream, session: SMTPServerSession, callback: (err?: any, message?: any) => void) => void;

/** onData handler that reads the whole message and accepts it, ignoring sizeExceeded */
const acceptAll: DataHandler = (stream, session, callback) => {
    stream.on('data', () => false);
    stream.on('end', () => callback(null, 'Queued'));
};

function serverOptions(overrides: SMTPServerOptions): SMTPServerOptions {
    return {
        disabledCommands: ['AUTH'],
        hideENHANCEDSTATUSCODES: false,
        logger: false,
        size: LIMIT,
        onData: acceptAll,
        ...overrides
    };
}

/**
 * Builds a message body of exactly `length` bytes as onData sees it (after dot
 * unstuffing), ending with CRLF, and the dot-stuffed form that goes on the wire
 */
function buildMessage(length: number, random: () => number): { wire: string; length: number } {
    let body = '';
    while (body.length < length - 2) {
        let roll = random();
        if (roll < 0.05 && !body.endsWith('\r')) {
            body += '\r\n';
        } else if (roll < 0.1) {
            body += '.';
        } else {
            body += String.fromCharCode(97 + Math.floor(random() * 26));
        }
    }
    body = body.slice(0, length - 2);
    if (body.endsWith('\r')) {
        // do not form a CRLF across the final line break
        body = body.slice(0, -1) + 'x';
    }
    body += '\r\n';
    let wire = body.replace(/(^|\n)\./g, '$1..');
    return { wire, length: Buffer.byteLength(body) };
}

/**
 * Sends one transaction, writing the DATA payload in random sized chunks with a
 * pause between them so that they reach the server as separate reads
 */
async function transaction(client: RawClient, wire: string, random: () => number): Promise<Reply | null> {
    assert.equal((await client.command('MAIL FROM:<sender@example.com>'))?.code, 250);
    assert.equal((await client.command('RCPT TO:<rcpt@example.com>'))?.code, 250);
    assert.equal((await client.command('DATA'))?.code, 354);

    let payload = wire + '.\r\n';
    let pos = 0;
    while (pos < payload.length) {
        let len = 1 + Math.floor(random() * Math.min(400, payload.length - pos));
        client.write(payload.slice(pos, pos + len));
        pos += len;
        if (random() < 0.5) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }
    return client.read();
}

describe('rejectOversized option', () => {
    it('answers an oversized message with 552 5.3.4 even if onData accepts it', async () => {
        await withClient(serverOptions({ rejectOversized: true }), async client => {
            await client.command('EHLO client.example.com');
            let random = prng(1);
            let reply = await transaction(client, buildMessage(LIMIT + 1, random).wire, random);
            assert.equal(reply?.code, 552);
            assert.match(reply?.text || '', /^5\.3\.4 Error: message exceeds fixed maximum message size 1000$/);

            // the session is reset and usable for the next transaction
            reply = await transaction(client, buildMessage(LIMIT, random).wire, random);
            assert.equal(reply?.code, 250);
            assert.match(reply?.text || '', /^2\.6\.0 Queued$/);
        });
    });

    it('answers 552 even if onData fails the message with its own error', async () => {
        let onData: DataHandler = (stream, session, callback) => {
            stream.on('data', () => false);
            stream.on('end', () => {
                let err: any = new Error('Temporary failure');
                err.responseCode = 451;
                callback(err);
            });
        };
        await withClient(serverOptions({ rejectOversized: true, onData }), async client => {
            await client.command('EHLO client.example.com');
            let random = prng(2);
            let reply = await transaction(client, buildMessage(LIMIT * 3, random).wire, random);
            assert.equal(reply?.code, 552);
        });
    });

    it('answers 552 when onData replies without reading the stream', async () => {
        let onData: DataHandler = (stream, session, callback) => callback(null, 'Queued');
        await withClient(serverOptions({ rejectOversized: true, onData }), async client => {
            await client.command('EHLO client.example.com');
            let random = prng(3);
            let reply = await transaction(client, buildMessage(LIMIT * 2, random).wire, random);
            assert.equal(reply?.code, 552);
        });
    });

    it('applies to a hidden limit too', async () => {
        await withClient(serverOptions({ rejectOversized: true, hideSize: true }), async client => {
            let ehlo = await client.command('EHLO client.example.com');
            assert.ok(ehlo?.lines.some(line => /^250[- ]SIZE$/.test(line)));
            let random = prng(4);
            let reply = await transaction(client, buildMessage(LIMIT + 50, random).wire, random);
            assert.equal(reply?.code, 552);
        });
    });

    it('sends one 552 per recipient with LMTP', async () => {
        await withClient(serverOptions({ rejectOversized: true, lmtp: true }), async client => {
            await client.command('LHLO client.example.com');
            assert.equal((await client.command('MAIL FROM:<sender@example.com>'))?.code, 250);
            assert.equal((await client.command('RCPT TO:<a@example.com>'))?.code, 250);
            assert.equal((await client.command('RCPT TO:<b@example.com>'))?.code, 250);
            assert.equal((await client.command('DATA'))?.code, 354);
            client.write(buildMessage(LIMIT + 10, prng(5)).wire + '.\r\n');
            assert.equal((await client.read())?.code, 552);
            assert.equal((await client.read())?.code, 552);
            assert.equal((await client.command('NOOP'))?.code, 250);
        });
    });

    it('leaves the decision to onData when not set (default)', async () => {
        await withClient(serverOptions({}), async client => {
            await client.command('EHLO client.example.com');
            let random = prng(6);
            let reply = await transaction(client, buildMessage(LIMIT * 2, random).wire, random);
            assert.equal(reply?.code, 250);
        });
    });

    it('has no effect without a size limit', async () => {
        await withClient(serverOptions({ rejectOversized: true, size: 0 }), async client => {
            await client.command('EHLO client.example.com');
            let random = prng(7);
            let reply = await transaction(client, buildMessage(LIMIT * 5, random).wire, random);
            assert.equal(reply?.code, 250);
        });
    });

    it('property: random sizes and chunk splits get 552 exactly when the size is over the limit', async () => {
        let random = prng(SEED);
        let seen: number[] = [];
        let onData: DataHandler = (stream, session, callback) => {
            stream.on('data', () => false);
            stream.on('end', () => {
                seen.push(stream.byteLength);
                callback(null, 'Queued');
            });
        };
        await withClient(serverOptions({ rejectOversized: true, onData }), async client => {
            await client.command('EHLO client.example.com');
            for (let i = 0; i < ITERATIONS; i++) {
                let length = LIMIT - 20 + Math.floor(random() * 41);
                let { wire, length: actual } = buildMessage(length, random);
                let reply = await transaction(client, wire, random);
                let label = 'seed ' + SEED + ' case ' + i + ' length ' + actual;
                assert.equal(seen[seen.length - 1], actual, label + ': byte count seen by onData');
                assert.equal(reply?.code, actual > LIMIT ? 552 : 250, label);
            }
        });
    });
});
