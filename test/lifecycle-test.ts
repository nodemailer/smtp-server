import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Writable } from 'node:stream';
import tls from 'node:tls';
import { RawClient, withClient, withServer } from './test-client.js';

// Connection lifecycle: timeouts, socket teardown, back pressure and the data stream
// when the client or the application does something unexpected

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Settles with the promise, or with the fallback value if that takes longer than ms
const within = <T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> => {
    let timer: NodeJS.Timeout;
    return Promise.race([promise, new Promise<F>(resolve => (timer = setTimeout(() => resolve(fallback), ms)))]).finally(() => clearTimeout(timer));
};

// Opens a mail transaction and starts its DATA phase
const openData = async (client: RawClient): Promise<void> => {
    assert.strictEqual((await client.command('EHLO client.example.com'))!.code, 250);
    assert.strictEqual((await client.command('MAIL FROM:<sender@example.com>'))!.code, 250);
    assert.strictEqual((await client.command('RCPT TO:<rcpt@example.com>'))!.code, 250);
    assert.strictEqual((await client.command('DATA'))!.code, 354);
};

const plainOptions = { disableReverseLookup: true, authOptional: true, hideSTARTTLS: true };

describe('Connection lifecycle', () => {
    describe('implicit TLS', () => {
        it('times out an idle TLS session with a 421 and not as a failed handshake', async () => {
            let errors: Error[] = [];
            await withServer({ secure: true, disableReverseLookup: true, authOptional: true, socketTimeout: 500 }, async ({ server, port }) => {
                server.on('error', err => errors.push(err));
                let client = await RawClient.connectTLS(port);
                try {
                    assert.strictEqual((await client.read())!.code, 220);
                    assert.strictEqual((await client.command('EHLO client.example.com'))!.code, 250);
                    // idle until the server gives up on the client
                    let reply = await client.read(3000);
                    assert.ok(reply, 'the client got a reply before the connection closed');
                    assert.strictEqual(reply.code, 421);
                    assert.match(reply.text, /Timeout/);
                    assert.strictEqual(await client.read(3000), null, 'the connection is closed');
                } finally {
                    client.close();
                }
            });
            assert.strictEqual(errors.length, 0, 'no server errors');
        });

        it('refuses the session with a reply when onSecure fails', async () => {
            let errors: Error[] = [];
            await withServer(
                {
                    secure: true,
                    disableReverseLookup: true,
                    onSecure(socket, session, callback) {
                        let err: any = new Error('Certificate required');
                        err.responseCode = 530;
                        callback(err);
                    }
                },
                async ({ server, port }) => {
                    server.on('error', err => errors.push(err));
                    let client = await RawClient.connectTLS(port);
                    try {
                        let reply = await client.read(3000);
                        assert.ok(reply);
                        assert.strictEqual(reply.code, 530);
                        assert.match(reply.text, /Certificate required/);
                        assert.strictEqual(await client.read(3000), null, 'the connection is closed');
                    } finally {
                        client.close();
                    }
                }
            );
            assert.strictEqual(errors.length, 0, 'the refusal is not reported as a server error');
        });
    });

    describe('STARTTLS', () => {
        it('refuses the session with a reply when onSecure fails', async () => {
            await withClient(
                {
                    disableReverseLookup: true,
                    authOptional: true,
                    onSecure(socket, session, callback) {
                        callback(new Error('TLS session refused'));
                    }
                },
                async client => {
                    assert.strictEqual((await client.command('EHLO client.example.com'))!.code, 250);
                    assert.strictEqual((await client.command('STARTTLS'))!.code, 220);

                    let secure = new RawClient(tls.connect({ socket: client.socket, rejectUnauthorized: false }));
                    try {
                        let reply = await secure.read(3000);
                        assert.ok(reply);
                        assert.strictEqual(reply.code, 554);
                        assert.match(reply.text, /TLS session refused/);
                        assert.strictEqual(await secure.read(3000), null, 'the connection is closed');
                    } finally {
                        secure.close();
                    }
                }
            );
        });
    });

    describe('PROXY header', () => {
        it('closes a connection whose header was rejected even if the peer keeps its side open', async () => {
            await withServer({ ...plainOptions, useProxy: true, socketTimeout: 60 * 1000 }, async ({ server, port }) => {
                let connections = () =>
                    new Promise<number>((resolve, reject) => server.server.getConnections((err, count) => (err ? reject(err) : resolve(count))));
                // a peer that keeps its side open after the server ended its own
                let socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true });
                socket.on('error', () => false);
                let received = '';
                socket.on('data', chunk => (received += chunk.toString()));
                try {
                    await new Promise(resolve => socket.once('connect', resolve));
                    socket.write('GARBAGE\r\n');
                    await new Promise(resolve => socket.once('end', resolve));
                    assert.match(received, /\* BAD Invalid PROXY header/);
                    assert.strictEqual(await connections(), 1);

                    // the server lets go of the socket itself, well before the idle timeout
                    let start = Date.now();
                    while ((await connections()) > 0) {
                        assert.ok(Date.now() - start < 5000, 'the server still holds the socket');
                        await wait(50);
                    }
                } finally {
                    socket.destroy();
                }
            });
        });
    });

    describe('QUIT', () => {
        it('lets go of the socket as soon as the client closes its side', async () => {
            await withServer(plainOptions, async ({ server, port }) => {
                let client = await RawClient.connect(port);
                await client.read();
                assert.strictEqual((await client.command('QUIT'))!.code, 221);
                assert.strictEqual(await client.read(3000), null, 'the connection is closed');
                // without reading the FIN the server held the socket until its half-close deadline
                let start = Date.now();
                while (await new Promise<number>((resolve, reject) => server.server.getConnections((err, count) => (err ? reject(err) : resolve(count))))) {
                    assert.ok(Date.now() - start < 1000, 'the server still holds the socket');
                    await wait(20);
                }
            });
        });
    });

    describe('idle timeout', () => {
        it('does not time out while an application handler is running', async () => {
            await withClient(
                {
                    ...plainOptions,
                    socketTimeout: 200,
                    onMailFrom(address, session, callback) {
                        setTimeout(callback, 600);
                    }
                },
                async client => {
                    assert.strictEqual((await client.command('EHLO client.example.com'))!.code, 250);
                    assert.strictEqual((await client.command('MAIL FROM:<sender@example.com>', 5000))!.code, 250);
                    // and the timeout still applies once the server is waiting for the client again
                    assert.strictEqual((await client.read(3000))!.code, 421);
                }
            );
        });

        it('does not time out while the onData handler decides on a received message', async () => {
            await withClient(
                {
                    ...plainOptions,
                    socketTimeout: 200,
                    onData(stream, session, callback) {
                        stream.resume();
                        stream.on('end', () => setTimeout(() => callback(null, 'Queued after a while'), 600));
                    }
                },
                async client => {
                    await openData(client);
                    let reply = await client.command('Subject: test\r\n\r\nHello\r\n.', 5000);
                    assert.strictEqual(reply!.code, 250);
                    assert.match(reply!.text, /Queued after a while/);
                }
            );
        });

        it('still times out a client that stops sending in the middle of a message', async () => {
            await withClient(
                {
                    ...plainOptions,
                    socketTimeout: 200,
                    onData(stream, session, callback) {
                        stream.resume();
                        stream.on('end', () => callback());
                    }
                },
                async client => {
                    await openData(client);
                    client.write('Subject: test\r\n\r\nHello');
                    assert.strictEqual((await client.read(3000))!.code, 421);
                }
            );
        });
    });

    describe('back pressure', () => {
        it('stops reading commands while the client does not read the replies', async () => {
            await withServer(plainOptions, async ({ server, port }) => {
                let socket = net.connect(port, '127.0.0.1');
                socket.on('error', () => false);
                await new Promise(resolve => socket.once('connect', resolve));
                // the client never reads anything
                socket.pause();
                while (!server.connections.size) {
                    await wait(10);
                }

                let connection: any = [...server.connections][0];
                let maxBuffered = 0;
                let sampler = setInterval(() => {
                    maxBuffered = Math.max(maxBuffered, connection._socket.writableLength);
                }, 5);

                // past the greeting delay, commands sent before it are refused as early talk
                await wait(150);

                // 2 MB of pipelined EHLO commands, each one answered with a multi-line reply
                // some 15 times its size
                let batch = Buffer.from('EHLO a\r\n'.repeat(10 * 1000));
                for (let i = 0; i < 25; i++) {
                    if (!socket.write(batch)) {
                        await within(new Promise(resolve => socket.once('drain', resolve)), 200, null);
                    }
                }
                await wait(300);
                clearInterval(sampler);
                socket.destroy();

                // without back pressure the replies to everything that fits in the socket
                // buffers pile up in memory, several megabytes of them
                assert.ok(maxBuffered < 256 * 1024, 'replies buffered in memory: ' + maxBuffered);
            });
        });
    });

    describe('data stream', () => {
        it('replies when the onData handler rejects the message without reading it', async () => {
            await withClient(
                {
                    ...plainOptions,
                    socketTimeout: 5000,
                    onData(stream, session, callback) {
                        let err: any = new Error('Rejected without reading');
                        err.responseCode = 550;
                        callback(err);
                    }
                },
                async client => {
                    await openData(client);
                    // larger than the buffers of the data stream
                    client.write(('x'.repeat(76) + '\r\n').repeat(4000));
                    assert.strictEqual((await client.command('.', 2000))!.code, 550);
                    assert.strictEqual((await client.command('QUIT'))!.code, 221);
                }
            );
        });

        it('carries on with pipelined commands when the onData handler destroyed the stream', async () => {
            await withClient(
                {
                    ...plainOptions,
                    socketTimeout: 5000,
                    onData(stream, session, callback) {
                        stream.once('data', () => {
                            stream.destroy();
                            let err: any = new Error('Message too large');
                            err.responseCode = 552;
                            callback(err);
                        });
                    }
                },
                async client => {
                    await openData(client);
                    client.write('Subject: test\r\n\r\n');
                    await wait(100);
                    client.write('Hello\r\n.\r\nNOOP\r\nQUIT\r\n');
                    assert.strictEqual((await client.read(2000))!.code, 552);
                    assert.strictEqual((await client.read(2000))!.code, 250);
                    assert.strictEqual((await client.read(2000))!.code, 221);
                }
            );
        });

        it('ends the data stream with an error when the client disconnects in the middle of a message', async () => {
            let streamError: Promise<any>;
            await withClient(
                {
                    ...plainOptions,
                    onData(stream, session, callback) {
                        streamError = new Promise(resolve => {
                            stream.on('error', err => {
                                resolve(err);
                                callback(err);
                            });
                            stream.on('end', () => resolve(null));
                        });
                        stream.resume();
                    }
                },
                async client => {
                    await openData(client);
                    client.write('Subject: test\r\n\r\nHello');
                    await wait(100);
                    client.close();
                    let err = await within(streamError!, 3000, 'timeout');
                    assert.ok(err instanceof Error, 'the stream emitted an error, got ' + err);
                    assert.strictEqual((err as any).code, 'ECONNECTION');
                }
            );
        });

        it('closes the data stream without an error event when nothing listens for one', async () => {
            let streamClosed: Promise<string>;
            await withClient(
                {
                    ...plainOptions,
                    onData(stream) {
                        streamClosed = new Promise(resolve => stream.on('close', () => resolve('closed')));
                        stream.resume();
                    }
                },
                async client => {
                    await openData(client);
                    client.write('Subject: test\r\n\r\nHello');
                    await wait(100);
                    client.close();
                    assert.strictEqual(await within(streamClosed!, 3000, 'timeout'), 'closed');
                }
            );
        });

        it('lets the onData handler finish reading a message the client sent in full before leaving', async () => {
            let message = ('y'.repeat(76) + '\r\n').repeat(5000);
            let delivered: Promise<number>;
            await withClient(
                {
                    ...plainOptions,
                    onData(stream, session, callback) {
                        delivered = new Promise(resolve => {
                            let length = 0;
                            // a slow destination keeps the pipe busy after the client is gone
                            let destination = new Writable({
                                highWaterMark: 1,
                                write(chunk, encoding, next) {
                                    length += chunk.length;
                                    setTimeout(next, 20);
                                }
                            });
                            destination.on('finish', () => {
                                resolve(length);
                                callback();
                            });
                            stream.pipe(destination);
                        });
                    }
                },
                async client => {
                    await openData(client);
                    client.write(message + '.\r\nQUIT\r\n');
                    client.socket.end();
                    assert.strictEqual(await within(delivered!, 10 * 1000, -1), message.length);
                }
            );
        });
    });

    describe('handlers', () => {
        it('passes a callback to onClose', async () => {
            await withServer(plainOptions, async ({ server, port }) => {
                let callbackType = new Promise<string>(resolve => {
                    server.onClose = (session: any, done: any) => {
                        resolve(typeof done);
                        done();
                    };
                });
                let client = await RawClient.connect(port);
                try {
                    await client.read();
                    await client.command('QUIT');
                } finally {
                    client.close();
                }
                assert.strictEqual(await callbackType, 'function');
            });
        });

        it('uses a custom resolver for the reverse lookup', async () => {
            let lookups: string[] = [];
            let hostname: string | undefined;
            await withClient(
                {
                    authOptional: true,
                    resolver: {
                        reverse(ip, callback) {
                            lookups.push(ip);
                            callback(null, ['client.resolver.example.com']);
                        }
                    },
                    onConnect(session, callback) {
                        hostname = session.clientHostname;
                        callback();
                    }
                },
                async client => {
                    assert.deepStrictEqual(lookups, ['127.0.0.1']);
                    assert.strictEqual(hostname, 'client.resolver.example.com');
                    let reply = await client.command('EHLO client.example.com');
                    assert.match(reply!.lines[0], /client\.resolver\.example\.com/);
                }
            );
        });

        it('treats network errors outside a transaction as a disconnect, not a server error', async () => {
            let errors: Error[] = [];
            await withClient(plainOptions, async (client, greeting, server) => {
                server.on('error', err => errors.push(err));
                let connection: any = [...server.connections][0];
                for (let code of ['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']) {
                    let err: any = new Error('network error');
                    err.code = code;
                    connection._onError(err);
                }
                assert.strictEqual(await client.read(3000), null, 'the connection is closed');
            });
            assert.strictEqual(errors.length, 0);
        });
    });
});
