// Shared helpers for tests that talk SMTP over a raw socket. Not a test file
// itself, the test scripts only run test/**/*-test.ts

import net from 'node:net';
import type { AddressInfo } from 'node:net';
import tls from 'node:tls';
import { SMTPServer, type SMTPServerOptions } from '../src/smtp-server.js';

/** A validated reply block */
export interface Reply {
    code: number;
    lines: string[];
    text: string;
}

// a complete reply block: any continuation lines followed by the final line
const REPLY_BLOCK = /^(?:\d{3}-[^\r\n]*\r\n)*\d{3}(?: [^\r\n]*)?\r\n/;

// RFC 5321 section 4.5.3.1.5, a reply line is at most 512 octets including the CRLF
const MAX_REPLY_LINE = 512;

/**
 * Checks a complete reply block against the RFC 5321 section 4.2 reply grammar and
 * the RFC 3463 enhanced status code format, throws if anything is off.
 *
 * @param {String} block Reply block as received, including the final CRLF
 * @returns {Object} Parsed reply as {code, lines, text}
 */
export function validateReply(block: string): Reply {
    let fail = (message: string): never => {
        throw new Error('Invalid reply (' + message + '): ' + JSON.stringify(block));
    };

    if (!block.endsWith('\r\n')) {
        fail('missing CRLF');
    }

    let lines = block.slice(0, -2).split('\r\n');
    let code: string | undefined;

    lines.forEach((line, i) => {
        if (Buffer.byteLength(line) + 2 > MAX_REPLY_LINE) {
            fail('line longer than ' + MAX_REPLY_LINE + ' octets');
        }

        // a bare CR or LF, or any other control character, would let the text split the reply
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x08\x0A-\x1F\x7F]/.test(line)) {
            fail('control character in line ' + i);
        }

        // Reply-line = Reply-code [ SP textstring ] CRLF, continuation lines use "-"
        let match = line.match(/^([2-5][0-5]\d)(?:([ -])(.*))?$/);
        if (!match) {
            return fail('malformed line ' + i);
        }

        if (code && match[1] !== code) {
            fail('reply code changes within the block');
        }
        code = match[1];

        if ((match[2] === '-') !== i < lines.length - 1) {
            fail('continuation marker on line ' + i);
        }

        let enhanced = (match[3] || '').match(/^(\d)\.\d{1,3}\.\d{1,3}(?: |$)/);
        if (enhanced && enhanced[1] !== match[1].charAt(0)) {
            fail('enhanced status code class does not match the reply code');
        }
    });

    return {
        code: Number(code),
        lines,
        text: lines.map(line => line.slice(4)).join('\n')
    };
}

/**
 * Drives an SMTP conversation on an open socket: writes the next command after
 * every final response line, then calls back with the final line of each response
 * block and with everything the server sent.
 *
 * @param {Socket} socket Connected socket, plaintext or TLS
 * @param {String[]} commands Commands to send (strings or buffers), each including its own CRLF
 * @param {Boolean} expectGreeting False inside a TLS session, where the server
 *     never speaks first and the client has to send the opening command
 * @param {Function} callback Called as (err, responseLines, fullText)
 */
export function driveSocket(
    socket: net.Socket,
    commands: (string | Buffer)[],
    expectGreeting: boolean,
    callback: (err: Error | null, responseLines: string[], fullText: string) => void
): void {
    let data = '';
    let sent = 0;
    let lines: string[] = [];
    let full = '';

    let onData = (chunk: Buffer): void => {
        data += chunk.toString();
        if (!REPLY_BLOCK.test(data)) {
            // still waiting for the end of this response block
            return;
        }

        full += data;
        lines.push(data.trim().split(/\r\n/).pop() as string);
        data = '';

        if (sent < commands.length) {
            socket.write(commands[sent++]);
            return;
        }

        socket.removeListener('data', onData);
        return callback(null, lines, full);
    };

    socket.on('data', onData);

    if (!expectGreeting && commands.length) {
        socket.write(commands[sent++]);
    }
}

/**
 * Starts a server on an ephemeral port
 *
 * @param {Object} options SMTPServer options, logging is off unless set
 * @returns {Promise<Object>} {server, port}
 */
function startServer(options?: SMTPServerOptions): Promise<{ server: SMTPServer; port: number }> {
    let server = new SMTPServer(Object.assign({ logger: false }, options));
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve({ server, port: (server.server.address() as AddressInfo).port });
        });
    });
}

function stopServer(server: SMTPServer): Promise<void> {
    return new Promise(resolve => server.close(() => resolve()));
}

/**
 * A plaintext SMTP client that reads one validated reply block at a time
 */
export class RawClient {
    socket: net.Socket;
    buffer: string;
    closed: boolean;
    _waiting: { resolve: (reply: Reply | null) => void; reject: (err: Error) => void; timer: NodeJS.Timeout } | null;

    constructor(socket: net.Socket) {
        this.socket = socket;
        this.buffer = '';
        this.closed = false;
        this._waiting = null;

        socket.on('data', (chunk: Buffer) => {
            this.buffer += chunk.toString('binary');
            this._check();
        });
        socket.on('error', () => false);
        socket.on('close', () => {
            this.closed = true;
            this._check();
        });
    }

    static connect(port: number): Promise<RawClient> {
        return new Promise((resolve, reject) => {
            let socket = net.connect(port, '127.0.0.1', () => {
                socket.removeListener('error', reject);
                resolve(new RawClient(socket));
            });
            socket.once('error', reject);
        });
    }

    /**
     * Connects with implicit TLS, the certificate is not verified
     */
    static connectTLS(port: number): Promise<RawClient> {
        return new Promise((resolve, reject) => {
            let socket = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
                socket.removeListener('error', reject);
                resolve(new RawClient(socket));
            });
            socket.once('error', reject);
        });
    }

    _check(): void {
        if (!this._waiting) {
            return;
        }

        let match = this.buffer.match(REPLY_BLOCK);
        let { resolve, reject, timer } = this._waiting;
        let settle = () => {
            this._waiting = null;
            clearTimeout(timer);
        };

        if (match) {
            settle();
            this.buffer = this.buffer.slice(match[0].length);
            try {
                return resolve(validateReply(Buffer.from(match[0], 'binary').toString()));
            } catch (err) {
                return reject(err as Error);
            }
        }

        if (this.closed) {
            settle();
            if (this.buffer) {
                return reject(new Error('Connection closed in the middle of a reply: ' + JSON.stringify(this.buffer)));
            }
            // no reply, the server closed the connection
            return resolve(null);
        }
    }

    /**
     * Resolves with the next reply block, or null if the connection closed instead
     */
    read(timeout?: number): Promise<Reply | null> {
        return new Promise((resolve, reject) => {
            let timer = setTimeout(() => {
                this._waiting = null;
                reject(new Error('Timed out waiting for a reply, buffered: ' + JSON.stringify(this.buffer)));
            }, timeout || 3000);
            this._waiting = { resolve, reject, timer };
            this._check();
        });
    }

    write(data: string | Buffer): void {
        if (!this.closed) {
            this.socket.write(data);
        }
    }

    /**
     * Sends a command (CRLF is added) and resolves with its reply
     */
    command(line: string, timeout?: number): Promise<Reply | null> {
        this.write(line + '\r\n');
        return this.read(timeout);
    }

    close(): void {
        this.socket.destroy();
    }
}

/**
 * Runs an async function for every item, one after another (protocol steps can not
 * run in parallel)
 *
 * @param {Array} items Items to process
 * @param {Function} fn Called as fn(item, index), returns a promise
 * @returns {Promise<Array>} Results in item order
 */
export function series<T, R>(items: T[], fn: (item: T, index: number) => R | Promise<R>): Promise<R[]> {
    return items.reduce(
        (previous: Promise<R[]>, item, i) => previous.then(results => Promise.resolve(fn(item, i)).then(result => results.concat([result]))),
        Promise.resolve([] as R[])
    );
}

/**
 * Connects, reads the greeting and sends the commands one at a time. Resolves with
 * the greeting followed by one reply per command; a null entry means the server
 * closed the connection instead of replying.
 *
 * @param {Number} port Server port
 * @param {String[]} commands Commands without CRLF
 * @returns {Promise<Object[]>} Validated replies
 */
export async function chat(port: number, commands: string[]): Promise<(Reply | null)[]> {
    let client = await RawClient.connect(port);
    try {
        let greeting = await client.read();
        let replies = await series(commands, command => client.command(command));
        return [greeting].concat(replies);
    } finally {
        client.close();
    }
}

/**
 * Starts a server for the duration of fn and stops it afterwards, even if fn fails
 *
 * @param {Object} options SMTPServer options
 * @param {Function} fn Called as fn({server, port}), returns a promise
 */
export async function withServer<R>(options: SMTPServerOptions, fn: (ctx: { server: SMTPServer; port: number }) => Promise<R>): Promise<R> {
    let { server, port } = await startServer(options);
    try {
        return await fn({ server, port });
    } finally {
        await stopServer(server);
    }
}

/**
 * Like withServer, but also connects a RawClient and reads the greeting first
 *
 * @param {Object} options SMTPServer options
 * @param {Function} fn Called as fn(client, greeting, server), returns a promise
 */
export function withClient<R>(options: SMTPServerOptions, fn: (client: RawClient, greeting: Reply | null, server: SMTPServer) => Promise<R>): Promise<R> {
    return withServer(options, async ({ server, port }) => {
        let client = await RawClient.connect(port);
        try {
            return await fn(client, await client.read(), server);
        } finally {
            client.close();
        }
    });
}
