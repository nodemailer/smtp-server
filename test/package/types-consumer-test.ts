import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The suite runs through tsx, which strips the types instead of checking them, and
// `npm run typecheck` checks the types in src/. These tests type-check a consumer against
// the built declarations in dist/ the way an installed copy is resolved: the package is
// linked into a temporary project so that the specifiers go through the package.json
// exports map.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsc = require.resolve('typescript/bin/tsc');

const hasDist = fs.existsSync(path.join(root, 'dist', 'cjs', 'smtp-server.d.ts')) && fs.existsSync(path.join(root, 'dist', 'esm', 'smtp-server.d.ts'));

// The idioms that code written against the community @types/smtp-server declarations uses,
// which the shipped declarations replace: handlers in the options object with parameters
// left to inference or typed as a subtype of the session, overridden handler methods, the
// typed events, the session, envelope and address shapes and the error codes
const consumer = `
import { SMTPServer } from 'smtp-server';
import type {
    SMTPServerOptions,
    SMTPServerSession,
    SMTPServerDataStream,
    SMTPServerAddress,
    SMTPServerAuthentication,
    SMTPServerAuthenticationResponse,
    SMTPServerEnvelope,
    SMTPServerConnectionInfo,
    SMTPServerError
} from 'smtp-server';
import type { AddressInfo } from 'node:net';

interface ReceiverSession extends SMTPServerSession {
    accounts?: string[];
}

const options: SMTPServerOptions = {
    banner: 'test',
    secure: false,
    key: 'key',
    cert: 'cert',
    authOptional: true,
    logger: false,
    size: 1024 * 1024,
    disabledCommands: ['AUTH'],
    authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2', 'CRAM-MD5'],
    useProxy: ['127.0.0.1'],
    useXClient: true,
    sniOptions: new Map([['example.com', { key: 'key', cert: 'cert' }]]),
    socketTimeout: 1000,
    closeTimeout: 1000,
    onAuth(auth, session, done) {
        if (auth.method === 'CRAM-MD5' && !auth.validatePassword('secret')) {
            return done(new Error('Invalid username or password'));
        }
        const response: SMTPServerAuthenticationResponse = { user: auth.username };
        done(null, response);
    },
    onConnect(session, callback) {
        if (session.remoteAddress === '127.0.0.2') {
            const err: SMTPServerError = new Error('No connections from localhost allowed');
            err.responseCode = 421;
            return callback(err);
        }
        callback();
    },
    onSecure(socket, session, callback) {
        callback(session.servername === 'example.com' ? null : new Error('Unknown name'));
    },
    onMailFrom(address, session, callback) {
        const from: string = address.address;
        callback(from.endsWith('@example.com') ? null : new Error('Not accepted'));
    },
    onRcptTo(address, session: ReceiverSession, callback) {
        session.accounts = session.accounts || [];
        session.accounts.push(address.address);
        callback();
    },
    onData(stream: SMTPServerDataStream, session: ReceiverSession, callback) {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('error', callback);
        stream.on('end', () => {
            const envelope: SMTPServerEnvelope = session.envelope;
            const mailFrom = envelope.mailFrom ? envelope.mailFrom.address : null;
            const recipients: string[] = envelope.rcptTo.map((rcpt: SMTPServerAddress) => rcpt.address);
            void [mailFrom, recipients, stream.sizeExceeded, stream.byteLength, session.hostNameAppearsAs || null];
            callback(null, 'Message queued as abcdef');
        });
    },
    onClose(session) {
        session.id.toUpperCase();
    }
};

const server = new SMTPServer(options);
server.on('error', (err: Error) => err.message);
server.on('error', err => err.message);
server.on('close', () => {});
server.on('connect', (info: SMTPServerConnectionInfo) => info.remoteAddress);
server.listen(0, '127.0.0.1', () => {
    const port: number = (server.server.address() as AddressInfo).port;
    void port;
    server.close(() => {});
});
server.listen(2525);
server.updateSecureContext({ key: 'key', cert: 'cert' });
server.close();
const size: number = server.connections.size;
void [size, server.options.secure, server.logger, server.secureContext.get('*')];

// Subclasses override the handler methods
class Receiver extends SMTPServer {
    override onData(stream: SMTPServerDataStream, session: SMTPServerSession, callback: (err?: Error | null) => void): void {
        stream.resume();
        stream.on('end', () => callback());
    }

    override onAuth(auth: SMTPServerAuthentication, session: SMTPServerSession, callback: (err: Error | null | undefined, response?: SMTPServerAuthenticationResponse) => void): void {
        callback(null, { user: 123 });
    }
}
new Receiver({ authMethods: ['PLAIN'] });
new SMTPServer();
`;

// The default import, which resolved to the CommonJS exports object before the ES module
// build existed, and the deep imports of the library modules
const defaultAndDeepImports = `
import smtpServer from 'smtp-server';
import { SMTPConnection } from 'smtp-server/lib/smtp-connection';
import { SMTPStream } from 'smtp-server/lib/smtp-stream.js';
import getTLSOptions from 'smtp-server/lib/tls-options';

const server = new smtpServer.SMTPServer({ logger: false });
const stream = new SMTPStream();
const dataStream = stream.startDataMode(1024);
const tlsOptions = getTLSOptions({ minVersion: 'TLSv1.2' });
void [server, dataStream.sizeExceeded, tlsOptions.minVersion, SMTPConnection];
`;

// A CommonJS consumer, the way the package was loaded before the ES module build existed
const cjsConsumer = `
import smtpServer = require('smtp-server');
import type { SMTPServerOptions } from 'smtp-server';

const options: SMTPServerOptions = { secure: true, logger: false };
const server = new smtpServer.SMTPServer(options);
const other = new smtpServer.default.SMTPServer(options);
server.close();
other.close();
`;

// Every optional property is declared as \`T | undefined\` so that an explicit undefined is
// still accepted under exactOptionalPropertyTypes
const exactOptionalConsumer = `
import { SMTPServer } from 'smtp-server';
import type {
    SMTPServerOptions,
    SMTPServerAddress,
    SMTPServerAuthentication,
    SMTPServerAuthenticationResponse,
    SMTPServerEnvelope,
    SMTPServerSession,
    SMTPServerRecipientDSN
} from 'smtp-server';

declare const maybeString: string | undefined;
declare const maybeNumber: number | undefined;
declare const maybeBoolean: boolean | undefined;

new SMTPServer({
    name: maybeString,
    banner: maybeString,
    secure: maybeBoolean,
    size: maybeNumber,
    socketTimeout: maybeNumber,
    authOptional: maybeBoolean,
    disableReverseLookup: maybeBoolean,
    hideDSN: maybeBoolean,
    logger: maybeBoolean
});

type OptionalKeys<T> = Extract<{ [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T], string>;
type MissingUndefined<T> = { [K in OptionalKeys<T>]-?: { [P in K]: undefined } extends Pick<T, K> ? never : K }[OptionalKeys<T>];
type NoneMissing<T extends never> = T;

// handler methods are optional members too, but they are functions, not values a caller sets to undefined
type OwnOptions = Omit<SMTPServerOptions, 'onAuth' | 'onConnect' | 'onSecure' | 'onMailFrom' | 'onRcptTo' | 'onData' | 'onClose'>;

export type Checks = [
    NoneMissing<MissingUndefined<OwnOptions>>,
    NoneMissing<MissingUndefined<SMTPServerAddress>>,
    NoneMissing<MissingUndefined<SMTPServerAuthentication>>,
    NoneMissing<MissingUndefined<SMTPServerAuthenticationResponse>>,
    NoneMissing<MissingUndefined<SMTPServerEnvelope>>,
    NoneMissing<MissingUndefined<SMTPServerSession>>,
    NoneMissing<MissingUndefined<SMTPServerRecipientDSN>>
];
`;

const node16 = { module: 'node16', moduleResolution: 'node16' };

const resolutions: Array<{ name: string; compilerOptions: { [key: string]: unknown }; type?: string }> = [
    { name: 'node16 ES module project', compilerOptions: node16, type: 'module' },
    { name: 'node16 CommonJS project', compilerOptions: node16 },
    { name: 'bundler resolution', compilerOptions: { module: 'esnext', moduleResolution: 'bundler' }, type: 'module' },
    // the classic resolution of older CommonJS projects ignores the exports map and goes through
    // the types entry and typesVersions instead
    { name: 'node10 resolution', compilerOptions: { module: 'commonjs', moduleResolution: 'node10', ignoreDeprecations: '6.0' } }
];

// Type-checks one or more consumer sources against the built declarations in dist/ the way
// an installed copy is resolved: the package is linked into a temporary project so that the
// specifiers go through the package.json exports map
const typeCheckConsumer = (sources: string | string[], compilerOptions: { [key: string]: unknown }, type?: string): void => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp-server-types-'));
    try {
        fs.mkdirSync(path.join(dir, 'node_modules'));
        // link the package itself and the node typings a real consumer has, so that
        // the specifiers resolve the way they do in an installed project
        fs.symlinkSync(root, path.join(dir, 'node_modules', 'smtp-server'), 'dir');
        fs.mkdirSync(path.join(dir, 'node_modules', '@types'));
        fs.symlinkSync(path.join(root, 'node_modules', '@types', 'node'), path.join(dir, 'node_modules', '@types', 'node'), 'dir');
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, ...(type ? { type } : {}) }));
        const files = (Array.isArray(sources) ? sources : [sources]).map((source, index) => {
            const name = 'consumer' + index + '.ts';
            fs.writeFileSync(path.join(dir, name), source);
            return name;
        });
        fs.writeFileSync(
            path.join(dir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    lib: ['ES2023'],
                    types: ['node'],
                    strict: true,
                    exactOptionalPropertyTypes: true,
                    noImplicitOverride: true,
                    noEmit: true,
                    skipLibCheck: false,
                    esModuleInterop: true,
                    ...compilerOptions
                },
                include: files
            })
        );

        const result = spawnSync(process.execPath, [tsc, '-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8' });
        assert.strictEqual(result.status, 0, 'tsc reported\n' + result.stdout + result.stderr);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};

describe('Built package types', { timeout: 120 * 1000, skip: hasDist ? false : 'dist/ is not built, run npm run build first' }, () => {
    // one compiler run per resolution keeps the suite fast, tsc names the consumer file that fails
    for (const resolution of resolutions) {
        it('type-checks consumer code, the default and deep imports, and explicit undefined options with ' + resolution.name, () => {
            typeCheckConsumer([consumer, defaultAndDeepImports, exactOptionalConsumer], resolution.compilerOptions, resolution.type);
        });
    }

    it('type-checks a CommonJS consumer that uses import = require()', () => {
        typeCheckConsumer(cjsConsumer, node16);
    });
});
