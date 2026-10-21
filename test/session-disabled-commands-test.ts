import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withServer, withClient, RawClient, type Reply } from './test-client.js';
import type { SMTPServerOptions, SMTPServerSession } from '../src/smtp-server.js';

const SEED = Number(process.env.FUZZ_SEED) || 0x5eed;
const ITERATIONS = Number(process.env.FUZZ_ITERATIONS) || 40;

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

function capabilities(reply: Reply | null): string[] {
    assert.equal(reply?.code, 250);
    return (reply?.lines || []).slice(1).map(line => line.slice(4).split(' ')[0] as string);
}

function options(overrides: SMTPServerOptions): SMTPServerOptions {
    return {
        logger: false,
        allowInsecureAuth: true,
        disableReverseLookup: true,
        onAuth(auth, session, callback) {
            callback(null, { user: auth.username });
        },
        ...overrides
    };
}

/** onConnect that sets session.disabledCommands from a per-connection list */
function perConnection(lists: (string[] | undefined)[]): (session: SMTPServerSession, callback: (err?: Error | null) => void) => void {
    let count = 0;
    return (session: SMTPServerSession, callback: (err?: Error | null) => void) => {
        let list = lists[count++];
        if (list) {
            session.disabledCommands = list;
        }
        callback();
    };
}

describe('session.disabledCommands', () => {
    it('enables a command for one session that the server disables', async () => {
        await withClient(options({ disabledCommands: ['AUTH'], onConnect: perConnection([[]]) }), async client => {
            let caps = capabilities(await client.command('EHLO client.example.com'));
            assert.ok(caps.includes('AUTH'), caps.join(','));
            // AUTH is in effect, so a transaction needs authentication
            assert.equal((await client.command('MAIL FROM:<sender@example.com>'))?.code, 530);
            assert.equal((await client.command('AUTH PLAIN ' + Buffer.from('\0user\0pass').toString('base64')))?.code, 235);
            assert.equal((await client.command('MAIL FROM:<sender@example.com>'))?.code, 250);
        });
    });

    it('disables AUTH and STARTTLS for one session, including the EHLO advertisement', async () => {
        await withClient(options({ onConnect: perConnection([['auth', ' StartTLS ']]) }), async client => {
            let caps = capabilities(await client.command('EHLO client.example.com'));
            assert.ok(!caps.includes('AUTH'), caps.join(','));
            assert.ok(!caps.includes('STARTTLS'), caps.join(','));
            assert.equal((await client.command('AUTH PLAIN ' + Buffer.from('\0user\0pass').toString('base64')))?.code, 500);
            assert.equal((await client.command('STARTTLS'))?.code, 500);
            // without AUTH no authentication is required
            assert.equal((await client.command('MAIL FROM:<sender@example.com>'))?.code, 250);
        });
    });

    it('does not affect other open connections', async () => {
        await withServer(options({ onConnect: perConnection([['AUTH'], undefined]) }), async ({ port }) => {
            let first = await RawClient.connect(port);
            await first.read();
            let second = await RawClient.connect(port);
            await second.read();
            try {
                assert.ok(!capabilities(await first.command('EHLO one.example.com')).includes('AUTH'));
                assert.ok(capabilities(await second.command('EHLO two.example.com')).includes('AUTH'));
                assert.ok(!capabilities(await first.command('EHLO one.example.com')).includes('AUTH'));
                assert.equal((await first.command('MAIL FROM:<a@example.com>'))?.code, 250);
                assert.equal((await second.command('MAIL FROM:<a@example.com>'))?.code, 530);
            } finally {
                first.close();
                second.close();
            }
        });
    });

    it('falls back to the server option when the session does not set it', async () => {
        await withClient(options({ disabledCommands: ['VRFY'] }), async client => {
            await client.command('EHLO client.example.com');
            assert.equal((await client.command('VRFY someone'))?.code, 500);
        });
    });

    it('can be changed during the session', async () => {
        let session: SMTPServerSession | undefined;
        let onConnect = (s: SMTPServerSession, callback: (err?: Error | null) => void) => {
            session = s;
            callback();
        };
        await withClient(options({ onConnect }), async client => {
            assert.equal((await client.command('HELP'))?.code, 214);
            session!.disabledCommands = ['HELP'];
            assert.equal((await client.command('HELP'))?.code, 500);
            session!.disabledCommands = undefined;
            assert.equal((await client.command('HELP'))?.code, 214);
        });
    });

    it('property: random per-session lists decide availability and advertisement', async () => {
        let random = prng(SEED);
        const CANDIDATES = ['AUTH', 'STARTTLS', 'HELP', 'VRFY', 'NOOP'];
        let lists = Array.from({ length: ITERATIONS }, () => CANDIDATES.filter(() => random() < 0.5));
        let serverDisabled = ['HELP', 'AUTH'];

        await withServer(options({ disabledCommands: serverDisabled, onConnect: perConnection(lists) }), async ({ port }) => {
            for (let i = 0; i < lists.length; i++) {
                let list = lists[i] as string[];
                let label = 'seed ' + SEED + ' case ' + i + ' disabled ' + JSON.stringify(list);
                let client = await RawClient.connect(port);
                try {
                    await client.read();
                    let caps = capabilities(await client.command('EHLO client.example.com'));
                    assert.equal(caps.includes('AUTH'), !list.includes('AUTH'), label + ': AUTH');
                    assert.equal(caps.includes('STARTTLS'), !list.includes('STARTTLS'), label + ': STARTTLS');
                    assert.equal((await client.command('HELP'))?.code, list.includes('HELP') ? 500 : 214, label + ': HELP');
                    assert.equal((await client.command('VRFY x'))?.code, list.includes('VRFY') ? 500 : 252, label + ': VRFY');
                    assert.equal((await client.command('NOOP'))?.code, list.includes('NOOP') ? 500 : 250, label + ': NOOP');
                    assert.equal((await client.command('MAIL FROM:<a@example.com>'))?.code, list.includes('AUTH') ? 250 : 530, label + ': MAIL');
                } finally {
                    client.close();
                }
            }
        });
    });
});
