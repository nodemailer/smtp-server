import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

// These tests exercise the compiled output in dist/ (built by the pretest
// script) through the package.json exports map, the same way an installed
// copy of the package is loaded. Node resolves the package name to the
// package itself when the specifier is used from inside the package.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Non-literal specifiers keep TypeScript from resolving the built types at
// type-check time, when dist/ may not exist yet
const packageName: string = 'smtp-server';
const subpath = (name: string) => packageName + '/lib/' + name;

const hasDist = fs.existsSync(path.join(root, 'dist', 'cjs', 'smtp-server.js')) && fs.existsSync(path.join(root, 'dist', 'esm', 'smtp-server.js'));

// The runtime exports of every module before the TypeScript build, as `require()` returned them
const LEGACY_EXPORTS: Record<string, string[]> = {
    'smtp-server': ['SMTPServer'],
    'smtp-connection': ['SMTPConnection', 'SOCKET_TIMEOUT', 'socketTimeout', 'TLS_SOCKET_OPTIONS', 'isAddressAllowed', 'verifyPeerCertificate'],
    'smtp-stream': ['SMTPStream'],
    sasl: [
        'SASL_PLAIN',
        'SASL_LOGIN',
        'SASL_XOAUTH2',
        'SASL_CRAM-MD5',
        'PLAIN_token',
        'LOGIN_username',
        'LOGIN_password',
        'XOAUTH2_token',
        'XOAUTH2_error',
        'CRAM-MD5_token',
        'SASL_XCLIENT',
        'CONTROL_CHARS'
    ]
};

// Delivers one message to a server built from the given module and resolves with what onData received
const deliver = async (SMTPServer: any): Promise<{ data: string; envelope: any }> => {
    let received: { data: string; envelope: any } | undefined;
    const server = new SMTPServer({
        logger: false,
        disableReverseLookup: true,
        authOptional: true,
        disabledCommands: ['STARTTLS'],
        onData(stream: any, session: any, callback: (err?: Error | null) => void) {
            const chunks: Buffer[] = [];
            // the envelope is reset once the transaction is over
            const envelope = structuredClone(session.envelope);
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('end', () => {
                received = { data: Buffer.concat(chunks).toString(), envelope };
                callback();
            });
        }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    try {
        const transport = nodemailer.createTransport({ host: '127.0.0.1', port: (server.server.address() as AddressInfo).port, ignoreTLS: true });
        const info = await transport.sendMail({ from: 'sender@example.com', to: 'rcpt@example.com', subject: 'test', text: 'hello world' });
        assert.deepStrictEqual(info.accepted, ['rcpt@example.com']);
        transport.close();
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
    assert.ok(received, 'onData was called');
    return received;
};

// Runs a script in a separate project that has the package installed as a dependency (linked
// into node_modules), the way an application such as EmailEngine loads it
const runConsumer = (fileName: string, source: string, type?: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp-server-consumer-'));
    try {
        fs.mkdirSync(path.join(dir, 'node_modules'));
        fs.symlinkSync(root, path.join(dir, 'node_modules', 'smtp-server'), 'dir');
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, ...(type ? { type } : {}) }));
        fs.writeFileSync(path.join(dir, fileName), source);
        const result = spawnSync(process.execPath, [path.join(dir, fileName)], { cwd: dir, encoding: 'utf8', timeout: 30 * 1000 });
        assert.strictEqual(result.status, 0, 'consumer failed\n' + result.stdout + result.stderr);
        return result.stdout;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};

describe('Built package', { timeout: 60 * 1000, skip: hasDist ? false : 'dist/ is not built, run npm run build first' }, () => {
    it('ships both module formats with type declarations', () => {
        for (const format of ['esm', 'cjs']) {
            for (const name of ['smtp-server', 'smtp-connection', 'smtp-stream', 'sasl', 'tls-options', 'types']) {
                assert.ok(fs.existsSync(path.join(root, 'dist', format, name + '.js')), format + ' ' + name);
                assert.ok(fs.existsSync(path.join(root, 'dist', format, name + '.d.ts')), format + ' ' + name + ' type declarations');
            }
        }
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'dist', 'esm', 'package.json'), 'utf8')), { type: 'module' });
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'dist', 'cjs', 'package.json'), 'utf8')), { type: 'commonjs' });
    });

    it('points every exports entry at an existing file', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        assert.strictEqual(pkg.exports['.'].import, './dist/esm/smtp-server.js');
        assert.strictEqual(pkg.exports['.'].require, './dist/cjs/smtp-server.js');
        assert.strictEqual(pkg.main, './dist/cjs/smtp-server.js');
        assert.ok(fs.existsSync(path.join(root, pkg.types)), 'types entry exists');
        for (const [entry, target] of Object.entries(pkg.exports)) {
            if (entry.includes('*')) {
                continue;
            }
            const targets = typeof target === 'string' ? [target] : Object.values(target as Record<string, string>);
            for (const file of targets) {
                assert.ok(fs.existsSync(path.join(root, file)), entry + ' points at a missing file ' + file);
            }
        }
    });

    it('does not ship the TypeScript sources or the test suite', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        assert.ok(pkg.files.includes('dist'));
        assert.ok(!pkg.files.includes('src'));
        assert.ok(!pkg.files.includes('test'));
    });

    it('keeps the runtime dependencies loadable with require()', () => {
        // the CommonJS build is bundled into single-file executables with @yao-pkg/pkg,
        // which can not load ES module only packages
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        for (const dependency of Object.keys(pkg.dependencies)) {
            const manifest = JSON.parse(fs.readFileSync(require.resolve(dependency + '/package.json'), 'utf8'));
            assert.ok(manifest.type !== 'module' || manifest.exports, dependency + ' is not an ES module only package');
        }
        assert.strictEqual(typeof require('nodemailer/lib/shared').getLogger, 'function');
        assert.strictEqual(typeof require('punycode.js').toUnicode, 'function');
        assert.strictEqual(typeof require('ipv6-normalize'), 'function');
    });

    describe('CommonJS build', () => {
        it('gives every module the shape its declaration file announces', () => {
            // A module whose declaration has a default export is loaded as that
            // export itself (the build rewrites it, see scripts/build.js), the
            // entry point keeps both forms, and everything else is a plain
            // exports object
            const cjsRoot = path.join(root, 'dist', 'cjs');
            const files = (fs.readdirSync(cjsRoot, { recursive: true }) as string[]).filter(name => name.endsWith('.js'));
            assert.ok(files.length >= 6, 'expected the compiled modules under dist/cjs');
            for (const name of files) {
                const declaration = fs.readFileSync(path.join(cjsRoot, name.replace(/\.js$/, '.d.ts')), 'utf8');
                const hasDefault = /^export default /m.test(declaration);
                const mod = require(path.join(cjsRoot, name));
                if (name === 'smtp-server.js') {
                    assert.strictEqual(typeof mod.SMTPServer, 'function', name);
                    assert.strictEqual(mod.default, mod, name);
                } else if (hasDefault) {
                    assert.ok(typeof mod === 'function' || typeof mod === 'object', name + ' should load as its default export');
                    assert.strictEqual(mod.default, mod, name + ' should alias .default to itself');
                    assert.ok(!Object.keys(mod).includes('default'), name + ' default alias is not enumerable');
                } else {
                    assert.strictEqual(typeof mod, 'object', name + ' should load as an exports object');
                    assert.strictEqual(mod.__esModule, true, name);
                    assert.ok(!('default' in mod), name + ' should not have a default export');
                }
            }
        });

        it('resolves require() to the CommonJS entry point', () => {
            assert.strictEqual(require.resolve(packageName), path.join(root, 'dist', 'cjs', 'smtp-server.js'));
        });

        it('exposes the same enumerable exports as the CommonJS sources did', () => {
            const smtpServer = require(packageName);
            assert.deepStrictEqual(Object.keys(smtpServer), LEGACY_EXPORTS['smtp-server']);
            assert.strictEqual(typeof smtpServer.SMTPServer, 'function');
            // a default import compiled to CommonJS reads .default, which is the module itself
            assert.strictEqual(smtpServer.default, smtpServer);
            assert.ok(new smtpServer.SMTPServer({ logger: false }) instanceof require('node:events').EventEmitter);
        });

        it('keeps the deep imports of every module working', () => {
            for (const [name, keys] of Object.entries(LEGACY_EXPORTS)) {
                for (const specifier of [subpath(name), subpath(name + '.js')]) {
                    const mod = require(specifier);
                    for (const key of keys) {
                        assert.ok(key in mod, specifier + ' exports ' + key);
                    }
                }
            }
            const sasl = require(subpath('sasl'));
            assert.strictEqual(typeof sasl.SASL_PLAIN, 'function');
            assert.ok(sasl.CONTROL_CHARS instanceof RegExp);

            const getTLSOptions = require(subpath('tls-options'));
            assert.strictEqual(typeof getTLSOptions, 'function');
            assert.strictEqual(getTLSOptions().minVersion, 'TLSv1');
            assert.strictEqual(getTLSOptions({ minVersion: 'TLSv1.2' }).minVersion, 'TLSv1.2');

            const connection = require(subpath('smtp-connection'));
            assert.strictEqual(connection.SOCKET_TIMEOUT, 60 * 1000);
            assert.strictEqual(connection.socketTimeout({ socketTimeout: 5 }), 5);
            assert.strictEqual(connection.isAddressAllowed(['127.0.0.1'], '::ffff:127.0.0.1'), true);

            const { SMTPStream } = require(subpath('smtp-stream'));
            assert.strictEqual(typeof new SMTPStream().startDataMode, 'function');

            // the server and the deep imports share one module instance
            assert.strictEqual(require(subpath('smtp-server')).SMTPServer, require(packageName).SMTPServer);
        });

        it('receives a message with the CommonJS build', async () => {
            const { SMTPServer } = require(packageName);
            const { data, envelope } = await deliver(SMTPServer);
            assert.match(data, /hello world/);
            assert.strictEqual(envelope.mailFrom.address, 'sender@example.com');
            assert.deepStrictEqual(
                envelope.rcptTo.map((rcpt: any) => rcpt.address),
                ['rcpt@example.com']
            );
        });

        it('works from a separate CommonJS project', () => {
            const output = runConsumer(
                'index.js',
                `
                const { SMTPServer } = require('smtp-server');
                const smtpServer = require('smtp-server');
                const { SMTPConnection } = require('smtp-server/lib/smtp-connection');
                const sasl = require('smtp-server/lib/sasl');
                const assert = require('assert');
                assert.strictEqual(require.resolve('smtp-server'), require('fs').realpathSync(${JSON.stringify(path.join(root, 'dist', 'cjs', 'smtp-server.js'))}));
                assert.strictEqual(smtpServer.SMTPServer, SMTPServer);
                assert.strictEqual(typeof SMTPConnection, 'function');
                assert.strictEqual(typeof sasl.SASL_LOGIN, 'function');
                const server = new SMTPServer({ logger: false });
                server.listen(0, '127.0.0.1', () => {
                    console.log('listening ' + (server.server.address().port > 0));
                    server.close(() => console.log('closed'));
                });
                `
            );
            assert.strictEqual(output.trim(), 'listening true\nclosed');
        });
    });

    describe('ES module build', () => {
        it('resolves import to the ES module entry point', async () => {
            const url = new URL('../../dist/esm/smtp-server.js', import.meta.url).href;
            const direct = await import(url);
            const byName = await import(packageName);
            assert.strictEqual(byName.SMTPServer, direct.SMTPServer);
            assert.notStrictEqual(byName.SMTPServer, require(packageName).SMTPServer, 'import and require load different builds');
        });

        it('exposes named and default exports', async () => {
            const smtpServer = await import(packageName);
            assert.strictEqual(typeof smtpServer.SMTPServer, 'function');
            // `import smtpServer from 'smtp-server'` used to resolve to the CommonJS exports object
            assert.strictEqual(smtpServer.default.SMTPServer, smtpServer.SMTPServer);
        });

        it('exposes deep imports as default and named exports', async () => {
            const { default: getTLSOptions } = await import(subpath('tls-options'));
            assert.strictEqual(getTLSOptions().minVersion, 'TLSv1');
            const { default: sasl } = await import(subpath('sasl.js'));
            assert.strictEqual(typeof sasl.SASL_PLAIN, 'function');
            const connection = await import(subpath('smtp-connection'));
            assert.strictEqual(typeof connection.SMTPConnection, 'function');
            const stream = await import(subpath('smtp-stream'));
            assert.strictEqual(typeof stream.SMTPStream, 'function');
        });

        it('receives a message with the ES module build', async () => {
            const { SMTPServer } = await import(packageName);
            const { data } = await deliver(SMTPServer);
            assert.match(data, /hello world/);
        });

        it('works from a separate ES module project', () => {
            const output = runConsumer(
                'index.js',
                `
                import { SMTPServer } from 'smtp-server';
                import smtpServer from 'smtp-server';
                import getTLSOptions from 'smtp-server/lib/tls-options';
                import assert from 'node:assert';
                assert.strictEqual(smtpServer.SMTPServer, SMTPServer);
                assert.strictEqual(typeof getTLSOptions, 'function');
                const server = new SMTPServer({ logger: false });
                server.listen(0, '127.0.0.1', () => {
                    console.log('listening ' + (server.server.address().port > 0));
                    server.close(() => console.log('closed'));
                });
                `,
                'module'
            );
            assert.strictEqual(output.trim(), 'listening true\nclosed');
        });
    });
});
