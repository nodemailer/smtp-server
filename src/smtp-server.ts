import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { getLogger, type Logger } from 'nodemailer/lib/shared';
import punycode from 'punycode.js';
import {
    SMTPConnection,
    copyTLSSocketOptions,
    isAddressAllowed,
    socketTimeout,
    verifyPeerCertificate,
    type SMTPConnectionOptions,
    type TLSError,
    type TLSErrorMeta
} from './smtp-connection.js';
import tlsOptions from './tls-options.js';
import type {
    SMTPServerAddress,
    SMTPServerAuthentication,
    SMTPServerAuthenticationResponse,
    SMTPServerDataResult,
    SMTPServerDataStream,
    SMTPServerEvents,
    SMTPServerOptions,
    SMTPServerSession
} from './types.js';

export type * from './types.js';

const CLOSE_TIMEOUT = 30 * 1000; // how much to wait until pending connections are terminated

// PROXY protocol v1 limits the header line to 107 bytes including CRLF.
// Allow generous slack for non-conforming proxies, but never buffer
// unbounded input from a peer that withholds the terminating newline
const MAX_PROXY_HEADER_LENGTH = 1024;

/** Server options once the constructor has normalized the command and mechanism lists */
export type SMTPServerResolvedOptions = SMTPServerOptions & {
    disabledCommands: string[];
    authMethods: string[];
};

/** Connection details known before the SMTP session starts, plus the PROXY header flag */
type SocketOptions = SMTPConnectionOptions & { id: string };

type HandlerName = 'onConnect' | 'onSecure' | 'onAuth' | 'onMailFrom' | 'onRcptTo' | 'onData' | 'onClose';

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface SMTPServer {
    on<K extends keyof SMTPServerEvents>(event: K, listener: (...args: SMTPServerEvents[K]) => void): this;
    on(event: string | symbol, listener: (...args: any[]) => void): this;
    once<K extends keyof SMTPServerEvents>(event: K, listener: (...args: SMTPServerEvents[K]) => void): this;
    once(event: string | symbol, listener: (...args: any[]) => void): this;
    off<K extends keyof SMTPServerEvents>(event: K, listener: (...args: SMTPServerEvents[K]) => void): this;
    off(event: string | symbol, listener: (...args: any[]) => void): this;
    addListener<K extends keyof SMTPServerEvents>(event: K, listener: (...args: SMTPServerEvents[K]) => void): this;
    addListener(event: string | symbol, listener: (...args: any[]) => void): this;
    removeListener<K extends keyof SMTPServerEvents>(event: K, listener: (...args: SMTPServerEvents[K]) => void): this;
    removeListener(event: string | symbol, listener: (...args: any[]) => void): this;
    prependListener<K extends keyof SMTPServerEvents>(event: K, listener: (...args: SMTPServerEvents[K]) => void): this;
    prependListener(event: string | symbol, listener: (...args: any[]) => void): this;
    prependOnceListener<K extends keyof SMTPServerEvents>(event: K, listener: (...args: SMTPServerEvents[K]) => void): this;
    prependOnceListener(event: string | symbol, listener: (...args: any[]) => void): this;
    emit<K extends keyof SMTPServerEvents>(event: K, ...args: SMTPServerEvents[K]): boolean;
    emit(event: string | symbol, ...args: any[]): boolean;
}

/**
 * Creates a SMTP server instance.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class SMTPServer extends EventEmitter {
    options: SMTPServerResolvedOptions;
    logger: Logger;
    secureContext!: Map<string, tls.SecureContext>;
    /** A set of all currently open connections */
    connections: Set<SMTPConnection>;
    server: net.Server;

    /** Timeout after close has been called until pending connections are forcibly closed */
    _closeTimeout: NodeJS.Timeout | false;
    /**
     * Sockets that were accepted but have not reached connect() yet (PROXY header
     * or implicit TLS handshake still pending). Maps the accepted socket to the
     * socket on top of it, the TLS socket once the handshake has started
     */
    _pendingSockets: Map<net.Socket, net.Socket>;

    constructor(options?: SMTPServerOptions | null) {
        super();

        // NB! the options object of the caller is used and modified in place, as it always has been
        this.options = (options || {}) as SMTPServerResolvedOptions;

        // NB! updateSecureContext() below merges the built-in key/cert into this.options,
        // after which there is no way to tell what the operator actually supplied.
        // Capture that now, before anything mutates it
        let hasOwnCertificate = !!(this.options.key || this.options.cert || this.options.pfx || this.options.SNICallback || this.options.sniOptions);

        // setup disabled commands list
        this.options.disabledCommands = ([] as unknown[])
            .concat(this.options.disabledCommands || [])
            .map(command => (command || '').toString().toUpperCase().trim());

        this._warnAboutDefaultCertificate(hasOwnCertificate);

        this.updateSecureContext();

        // setup allowed auth methods
        this.options.authMethods = ([] as unknown[]).concat(this.options.authMethods || []).map(method => (method || '').toString().toUpperCase().trim());

        if (!this.options.authMethods.length) {
            this.options.authMethods = ['LOGIN', 'PLAIN'];
        }

        // set default value for hideENHANCEDSTATUSCODES to true (disable enhanced status codes by default)
        if (this.options.hideENHANCEDSTATUSCODES === undefined) {
            this.options.hideENHANCEDSTATUSCODES = true;
        }

        // set default value for hideDSN to true (disable delivery status notifications by default)
        if (this.options.hideDSN === undefined) {
            this.options.hideDSN = true;
        }

        // set default value for hideREQUIRETLS to true (disable REQUIRETLS by default, opt-in)
        if (this.options.hideREQUIRETLS === undefined) {
            this.options.hideREQUIRETLS = true;
        }

        this.logger = getLogger(this.options, {
            component: this.options.component || 'smtp-server'
        });

        // apply shorthand handlers
        (['onConnect', 'onSecure', 'onAuth', 'onMailFrom', 'onRcptTo', 'onData', 'onClose'] as HandlerName[]).forEach(handler => {
            if (typeof this.options[handler] === 'function') {
                (this as Record<HandlerName, unknown>)[handler] = this.options[handler];
            }
        });

        this._closeTimeout = false;

        this.connections = new Set();

        this._pendingSockets = new Map();

        // setup server listener and connection handler
        if (this.options.secure && !this.options.needsUpgrade) {
            this.server = net.createServer(this.options, socket => {
                // the TLS handshake is still ahead unless an external terminator did it
                let release = this._acceptSocket(socket, !this.options.secured);
                if (!release) {
                    return;
                }
                this._handleProxy(socket, (err, socketOptions) => {
                    if (err) {
                        // PROXY header could not be read (client dropped the
                        // connection or sent garbage). The socket is already
                        // closing/closed and guarded against late errors in
                        // _handleProxy; just don't proceed to connect().
                        return release();
                    }
                    if (this.options.secured) {
                        release();
                        return this.connect(socket, socketOptions);
                    }
                    this._upgrade(socket, (err, tlsSocket) => {
                        release();
                        if (err) {
                            // the guard is gone, so make sure a failed handshake does not leave the socket open
                            socket.destroy();
                            return this._onError(err);
                        }
                        this.connect(tlsSocket as tls.TLSSocket, socketOptions);
                    });
                });
            });
        } else {
            this.server = net.createServer(this.options, socket => {
                let release = this._acceptSocket(socket, false);
                if (!release) {
                    return;
                }
                this._handleProxy(socket, (err, socketOptions) => {
                    release();
                    if (err) {
                        // socket already closing/closed and guarded in
                        // _handleProxy; just don't proceed to connect()
                        return;
                    }
                    this.connect(socket, socketOptions);
                });
            });
        }

        this._setListeners();
    }

    /**
     * The built-in certificate is only meant for testing. Its private key is
     * published in the source tree, so anyone can intercept "encrypted" sessions
     * that rely on it. Make sure the operator knows.
     *
     * Runs once from the constructor. This has to write to stderr rather than to
     * this.logger, which does not exist yet and is a no-op unless logging was
     * explicitly enabled, so an explicit `logger: false` is honored as an opt-out
     *
     * @param hasOwnCertificate Whether the operator supplied a certificate
     */
    _warnAboutDefaultCertificate(hasOwnCertificate: boolean): void {
        // a server with `secured` gets its TLS from an external terminator, and a
        // plaintext server without STARTTLS never presents a certificate at all
        let terminatesTls =
            !this.options.secured && (this.options.secure || !(this.options.hideSTARTTLS || this.options.disabledCommands.includes('STARTTLS')));

        if (!terminatesTls || hasOwnCertificate || this.options.logger === false) {
            return;
        }

        console.error(
            'WARNING: smtp-server is using the built-in default TLS certificate. ' +
                'The private key of this certificate is publicly known, so TLS sessions are NOT secure. ' +
                'Provide your own key/cert options in production.'
        );
    }

    connect(socket: net.Socket | tls.TLSSocket, socketOptions?: SMTPConnectionOptions | null): void {
        let connection = new SMTPConnection(this, socket, socketOptions);
        this.connections.add(connection);
        connection.on('error', err => this._onError(err));
        connection.on('connect', data => this._onClientConnect(data));
        connection.init();
    }

    /**
     * Start listening on selected port and interface
     */
    listen(port?: number, hostname?: string, backlog?: number, listeningListener?: () => void): net.Server;
    listen(port?: number, hostname?: string, listeningListener?: () => void): net.Server;
    listen(port?: number, backlog?: number, listeningListener?: () => void): net.Server;
    listen(port?: number, listeningListener?: () => void): net.Server;
    listen(path: string, backlog?: number, listeningListener?: () => void): net.Server;
    listen(path: string, listeningListener?: () => void): net.Server;
    listen(options: net.ListenOptions, listeningListener?: () => void): net.Server;
    listen(handle: any, backlog?: number, listeningListener?: () => void): net.Server;
    listen(handle: any, listeningListener?: () => void): net.Server;
    listen(...args: any[]): net.Server {
        return this.server.listen(...args);
    }

    /**
     * Closes the server
     *
     * @param callback Callback to run once the server is fully closed
     */
    close(callback?: (() => void) | null): void {
        let connections = this.connections.size;
        let timeout = this.options.closeTimeout || CLOSE_TIMEOUT;

        // stop accepting new connections
        this.server.close(() => {
            clearTimeout(this._closeTimeout || undefined);
            if (typeof callback === 'function') {
                return callback();
            }
        });

        // sockets still waiting for the PROXY header or the TLS handshake have no session
        // that could finish during the grace period, but would keep the server open
        // until their own timeout. Destroy the topmost socket, tearing a TLS wrap down
        // from below in the middle of a handshake crashes Node
        this._pendingSockets.forEach(topSocket => topSocket.destroy());

        // close active connections
        if (connections) {
            this.logger.info(
                {
                    tnx: 'close'
                },
                'Server closing with %s pending connection%s, waiting %s seconds before terminating',
                connections,
                connections !== 1 ? 's' : '',
                timeout / 1000
            );
        }

        this._closeTimeout = setTimeout(() => {
            connections = this.connections.size;
            if (connections) {
                this.logger.info(
                    {
                        tnx: 'close'
                    },
                    'Closing %s pending connection%s to close the server',
                    connections,
                    connections !== 1 ? 's' : ''
                );

                this.connections.forEach(connection => {
                    connection.send(421, 'Server shutting down');
                    connection.close();
                });
            }
            if (typeof callback === 'function') {
                const realCallback = callback;
                callback = null;
                realCallback();
                return;
            }
        }, timeout);

        // Unref timer so it doesn't prevent process exit if all connections close naturally
        this._closeTimeout.unref();
    }

    /**
     * Authentication handler. Override this
     *
     * @param auth Authentication options
     * @param session Session of the connection
     * @param callback Callback to run once the user is authenticated
     */
    onAuth(
        auth: SMTPServerAuthentication,
        session: SMTPServerSession,
        callback: (err: Error | null | undefined, response?: SMTPServerAuthenticationResponse) => void
    ): void {
        if (auth.method === 'XOAUTH2') {
            return callback(null, {
                data: {
                    status: '401',
                    schemes: 'bearer mac',
                    scope: 'https://mail.google.com/'
                }
            });
        }

        if (auth.method === 'XCLIENT') {
            return callback(undefined); // pass through
        }

        return callback(null, {
            message: 'Authentication not implemented'
        });
    }

    /** Connection handler. Override this */
    onConnect(session: SMTPServerSession, callback: (err?: Error | null) => void): void {
        setImmediate(callback);
    }

    /** MAIL FROM handler. Override this */
    onMailFrom(address: SMTPServerAddress, session: SMTPServerSession, callback: (err?: Error | null) => void): void {
        setImmediate(callback);
    }

    /** RCPT TO handler. Override this */
    onRcptTo(address: SMTPServerAddress, session: SMTPServerSession, callback: (err?: Error | null) => void): void {
        setImmediate(callback);
    }

    /** TLS handler, called once the TLS session is established. Override this */
    onSecure(socket: net.Socket | tls.TLSSocket, session: SMTPServerSession, callback: (err?: Error | null) => void): void {
        setImmediate(callback);
    }

    /** Message handler. Override this */
    onData(stream: SMTPServerDataStream, session: SMTPServerSession, callback: (err?: Error | null, message?: string | SMTPServerDataResult[]) => void): void {
        let chunklen = 0;

        stream.on('data', (chunk: Buffer) => {
            chunklen += chunk.length;
        });

        stream.on('end', () => {
            this.logger.info(
                {
                    tnx: 'message',
                    size: chunklen
                },
                '<received %s bytes>',
                chunklen
            );
            callback();
        });
    }

    /** Called once a connection is closed. Override this */
    onClose(_session: SMTPServerSession, _callback?: (err?: Error | null) => void): void {
        // do nothing
    }

    /**
     * Rebuilds the TLS contexts, with the given options merged into the server options first
     *
     * @param [options] TLS options to apply
     */
    updateSecureContext(options?: tls.TlsOptions | SMTPServerOptions | null): void {
        Object.keys(options || {}).forEach(key => {
            (this.options as unknown as Record<string, unknown>)[key] = (options as unknown as Record<string, unknown>)[key];
        });

        let defaultTlsOptions = tlsOptions(this.options);

        this.secureContext = new Map();
        this.secureContext.set('*', tls.createSecureContext(defaultTlsOptions));

        let ctxMap = this.options.sniOptions || {};
        // sniOptions is either an object or a Map with domain names as keys and TLS option objects as values
        if (ctxMap instanceof Map || typeof (ctxMap as unknown as Map<string, tls.TlsOptions>).get === 'function') {
            (ctxMap as unknown as Map<string, tls.TlsOptions>).forEach((ctx, servername) => {
                this.secureContext.set(this._normalizeHostname(servername), tls.createSecureContext(tlsOptions(ctx)));
            });
        } else {
            let ctxObject = ctxMap as unknown as Record<string, tls.TlsOptions>;
            Object.keys(ctxObject).forEach(servername => {
                this.secureContext.set(this._normalizeHostname(servername), tls.createSecureContext(tlsOptions(ctxObject[servername])));
            });
        }

        if (this.options.secure) {
            // appy changes

            Object.keys(defaultTlsOptions || {}).forEach(key => {
                if (!(key in this.options)) {
                    (this.options as unknown as Record<string, unknown>)[key] = (defaultTlsOptions as unknown as Record<string, unknown>)[key];
                }
            });
        }
    }

    // PRIVATE METHODS

    /**
     * Setup server event handlers
     */
    _setListeners(): void {
        let server = this.server;
        server.once('listening', () => this._onListening());
        server.once('close', () => this._onClose(server));
        server.on('error', (err: Error) => this._onError(err));
    }

    /**
     * Called when server started listening
     *
     * @event
     */
    _onListening(): void {
        let serverAddress = this.server.address();

        // address will be null if listener is using Unix socket
        let address: { address: string | null; port: number | null; family: string | null } =
            serverAddress && typeof serverAddress === 'object' ? serverAddress : { address: null, port: null, family: null };

        this.logger.info(
            //
            {
                tnx: 'listen',
                host: address.address,
                port: address.port,
                secure: !!this.options.secure,
                protocol: this.options.lmtp ? 'LMTP' : 'SMTP'
            },
            '%s%s Server listening on %s:%s',
            this.options.secure ? 'Secure ' : '',
            this.options.lmtp ? 'LMTP' : 'SMTP',
            address.family === 'IPv4' ? address.address : '[' + address.address + ']',
            address.port
        );
    }

    /**
     * Called when server is closed
     *
     * @event
     */
    _onClose(server: net.Server): void {
        this.logger.info(
            {
                tnx: 'closed'
            },
            (this.options.lmtp ? 'LMTP' : 'SMTP') + ' Server closed'
        );
        if (server !== this.server) {
            // older instance was closed
            return;
        }
        this.emit('close');
    }

    /**
     * Called when an error occurs with the server
     *
     * @event
     */
    _onError(err: Error): void {
        this.emit('error', err);
    }

    /**
     * Guards a freshly accepted socket until it is handed over to connect(). Until
     * then SMTPConnection's idle timeout and maxClients check do not cover it, so a
     * client that never sends the PROXY header or never completes the implicit TLS
     * handshake would otherwise hold the socket forever.
     *
     * @param socket Accepted socket
     * @param handshake true if an implicit TLS handshake precedes connect()
     * @returns Function that removes the guard, or false if the socket was refused
     */
    _acceptSocket(socket: net.Socket, handshake: boolean): (() => void) | false {
        if (!handshake && !this._expectsProxyHeader(socket)) {
            // plain sockets go straight to connect(), nothing to guard
            return () => {
                // nothing to release
            };
        }

        if (this.options.maxClients && this._pendingSockets.size >= this.options.maxClients) {
            // nothing meaningful can be written before the PROXY header or the TLS
            // handshake, so just drop the connection
            socket.on('error', () => false);
            socket.destroy();
            return false;
        }

        this._pendingSockets.set(socket, socket);

        let onTimeout = () => {
            this.logger.info(
                {
                    tnx: 'connection',
                    host: socket.remoteAddress
                },
                'Closing connection from %s, it did not reach the SMTP session in time',
                socket.remoteAddress
            );
            socket.destroy();
        };

        let released = false;
        let release = () => {
            if (released) {
                return;
            }
            released = true;
            this._pendingSockets.delete(socket);
            socket.removeListener('close', release);
            socket.removeListener('timeout', onTimeout);
            // SMTPConnection arms its own timeout on the socket it receives
            socket.setTimeout(0);
        };

        socket.once('close', release);
        socket.setTimeout(socketTimeout(this.options), onTimeout);

        return release;
    }

    /**
     * Checks if a PROXY protocol header is expected from this socket before the SMTP
     * session starts: from every peer with useProxy: true, from the listed peers only
     * with an array (addresses are normalized, so an IPv4 peer of a dual-stack listener
     * matches its IPv4 entry)
     *
     * @param socket Accepted socket
     * @returns true if the header is expected
     */
    _expectsProxyHeader(socket: net.Socket): boolean {
        return isAddressAllowed(this.options.useProxy, socket.remoteAddress);
    }

    _handleProxy(socket: net.Socket, callback: (err: Error | null, socketOptions?: SocketOptions) => void): void {
        let socketOptions: SocketOptions = {
            id: BigInt('0x' + crypto.randomBytes(10).toString('hex'))
                .toString(32)
                .padStart(16, '0')
        };

        if (!this._expectsProxyHeader(socket)) {
            socketOptions.ignore = this.options.ignoredHosts && this.options.ignoredHosts.includes(socket.remoteAddress as string);
            setImmediate(() => callback(null, socketOptions));
            return;
        }

        let chunks: Buffer[] = [];
        let chunklen = 0;
        let finished = false;

        // assigned below, cleanup() only runs once all of them are set
        let onError: (err: Error) => void;
        let onClose: () => void;
        let onEnd: () => void;
        let socketReader: () => void;

        let cleanup = (): void => {
            socket.removeListener('readable', socketReader);
            socket.removeListener('error', onError);
            socket.removeListener('close', onClose);
            socket.removeListener('end', onEnd);
        };

        let done = (err: Error | null, opts?: SocketOptions): void => {
            if (finished) {
                return;
            }
            finished = true;
            if (err) {
                // The socket is already closing/closed (RST/FIN seen, or we
                // issued socket.end() with a diagnostic). Attach a no-op 'error'
                // handler BEFORE removing ours, so the socket is never left
                // without one — a late in-flight error (e.g. EPIPE while
                // flushing "* BAD") must not surface as an uncaughtException.
                socket.on('error', () => {
                    // ignore
                });
            }
            cleanup();
            callback(err, opts);
        };

        onError = (err: Error): void => {
            // client may close the connection (RST/FIN) before sending the
            // PROXY header; surface the error through the callback instead of
            // letting it bubble up as an uncaught exception
            this.logger.info(
                {
                    tnx: 'proxy',
                    cid: socketOptions.id,
                    err
                },
                '[%s] PROXY socket error before header was received: %s',
                socketOptions.id,
                err.message
            );
            done(err);
        };

        onClose = (): void => {
            // socket closed before a full PROXY header arrived
            done(new Error('Socket closed before PROXY header was received'));
        };

        onEnd = (): void => {
            // client half-closed (FIN) before a full PROXY header arrived; with
            // allowHalfOpen the socket emits 'end' but never 'close', so without
            // this the connection would linger until socketTimeout
            done(new Error('Socket ended before PROXY header was received'));
        };

        // reject a malformed/non-PROXY header: deliver the diagnostic to the
        // client (best effort) and surface the failure through the single done()
        let rejectInvalid = (message?: string): void => {
            try {
                socket.end('* BAD Invalid PROXY header\r\n');
            } catch {
                // ignore
            }
            return done(new Error(message || 'Invalid PROXY header'));
        };

        socketReader = (): void => {
            let chunk: Buffer | null;
            while ((chunk = socket.read() as Buffer | null) !== null) {
                for (let i = 0, len = chunk.length; i < len; i++) {
                    let chr = chunk[i];
                    if (chr === 0x0a) {
                        if (chunklen + i + 1 > MAX_PROXY_HEADER_LENGTH) {
                            return rejectInvalid('PROXY header line too long');
                        }
                        chunks.push(chunk.subarray(0, i + 1));
                        chunklen += i + 1;
                        let remainder = chunk.subarray(i + 1);
                        if (remainder.length) {
                            socket.unshift(remainder);
                        }

                        let header = Buffer.concat(chunks, chunklen).toString().trim();

                        let params = header.split(' ');
                        let commandName = (params.shift() as string).toUpperCase();
                        if (commandName !== 'PROXY') {
                            return rejectInvalid();
                        }

                        if (params[1]) {
                            let proxiedAddress = params[1].trim().toLowerCase();

                            // The header is not authenticated in any way and the address it
                            // carries ends up in SMTP responses, log entries and Received
                            // headers. Anything that is not a plain IP address is malformed,
                            // and accepting it would reopen the injection paths that the
                            // hostname validation in SMTPConnection closes
                            if (!net.isIP(proxiedAddress)) {
                                return rejectInvalid('Invalid PROXY source address');
                            }

                            socketOptions.remoteAddress = proxiedAddress;

                            socketOptions.ignore = this.options.ignoredHosts && this.options.ignoredHosts.includes(socketOptions.remoteAddress);

                            try {
                                if (!socketOptions.ignore) {
                                    this.logger.info(
                                        {
                                            tnx: 'proxy',
                                            cid: socketOptions.id,
                                            proxy: socketOptions.remoteAddress
                                        },
                                        '[%s] PROXY from %s through %s (%s)',
                                        socketOptions.id,
                                        socketOptions.remoteAddress,
                                        params[2].trim().toLowerCase(),
                                        JSON.stringify(params)
                                    );
                                }
                            } catch {
                                return rejectInvalid();
                            }

                            if (params[3]) {
                                socketOptions.remotePort = Number(params[3].trim()) || socketOptions.remotePort;
                            }
                        }

                        return done(null, socketOptions);
                    }
                }
                chunks.push(chunk);
                chunklen += chunk.length;
                if (chunklen > MAX_PROXY_HEADER_LENGTH) {
                    return rejectInvalid('PROXY header line too long');
                }
            }
        };
        socket.on('readable', socketReader);
        socket.on('error', onError);
        socket.on('close', onClose);
        socket.on('end', onEnd);
    }

    /**
     * Called when a new connection is established. This might not be the same time the socket is opened
     *
     * @event
     */
    _onClientConnect(data: SMTPServerEvents['connect'][0]): void {
        this.emit('connect', data);
    }

    /**
     * Normalize hostname
     *
     * @event
     */
    _normalizeHostname(hostname: string): string {
        try {
            hostname = punycode.toUnicode((hostname || '').toString().trim()).toLowerCase();
        } catch (E) {
            let err = E as Error;
            this.logger.error(
                {
                    tnx: 'punycode'
                },
                'Failed to process punycode domain "%s". error=%s',
                hostname,
                err.message
            );
        }

        return hostname;
    }

    /**
     * SNICallback for sockets upgraded by the server itself (implicit TLS and STARTTLS).
     * Normalizes the requested name and resolves it with options.SNICallback if the
     * operator supplied one, or from sniOptions otherwise. Falls back to the default
     * context if no specific one was found
     *
     * @param servername Server name requested by the client
     * @param cb Callback to run with the secure context
     */
    _resolveSNI(servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void): void {
        servername = this._normalizeHostname(servername);

        if (typeof this.options.SNICallback !== 'function') {
            return cb(null, this.secureContext.get(servername) || this.secureContext.get('*'));
        }

        // eslint-disable-next-line new-cap
        this.options.SNICallback(servername, (err: Error | null, context?: tls.SecureContext) => {
            if (err) {
                this.logger.error(
                    {
                        tnx: 'sni',
                        servername,
                        err
                    },
                    'Failed to fetch SNI context for servername %s',
                    servername
                );
            }
            return cb(null, context || this.secureContext.get('*'));
        });
    }

    _upgrade(socket: net.Socket, callback: (err: TLSError | null, tlsSocket?: tls.TLSSocket) => void): void {
        let socketOptions: tls.TLSSocketOptions = {
            secureContext: this.secureContext.get('*'),
            isServer: true,
            server: this.server,
            SNICallback: (servername, cb) => this._resolveSNI(servername, cb)
        };

        // The same socket options STARTTLS applies. Without them requestCert and
        // rejectUnauthorized were silently ignored on an implicit TLS listener, so a
        // client certificate was never requested and mutual TLS never enforced there
        copyTLSSocketOptions(this.options, socketOptions);

        let returned = false;
        let tlsSocket: tls.TLSSocket | undefined;

        let onError = (rawErr?: TLSError | null): void => {
            if (returned) {
                return;
            }
            returned = true;

            let err = rawErr;
            const meta: TLSErrorMeta = {};
            if (tlsSocket) {
                meta.tlsProtocol = tlsSocket.getProtocol();
            }
            meta.protocol = 'smtp';
            meta.stage = 'connect';
            meta.remoteAddress = socket.remoteAddress;

            if (err) {
                err.meta = meta;
            }

            if (err && /SSL[23]*_GET_CLIENT_HELLO|ssl[23]*_read_bytes|ssl_bytes_to_cipher_list/i.test(err.message)) {
                let message = err.message;
                err.message = 'Failed to establish TLS session';
                err.responseCode = 500;
                err.code = err.code || 'TLSError';
                meta.message = message;
            }
            if (!err || !err.message) {
                err = new Error('Socket closed while initiating TLS');
                err.responseCode = 500;
                err.code = 'SocketError';
                err.report = false;
                err.meta = meta;
            }

            callback(err || new Error('Socket closed unexpectedly'));
        };

        // remove all listeners from the original socket besides the error handler
        socket.once('error', onError);

        // From here on the handshake deadline belongs to the TLS socket. The pre-connect guard
        // in _acceptSocket timed the raw socket, and destroying that underneath a handshake in
        // progress tears the TLS wrap down from below; tls.Server never does that either, its
        // handshakeTimeout runs on the TLSSocket. (handshakeTimeout is not an option that
        // new tls.TLSSocket() honours, so it has to be armed by hand.)
        socket.setTimeout(0);

        // upgrade connection
        const secureSocket = new tls.TLSSocket(socket, socketOptions);
        tlsSocket = secureSocket;
        if (this._pendingSockets.has(socket)) {
            this._pendingSockets.set(socket, secureSocket);
        }

        secureSocket.setTimeout(socketTimeout(this.options), () => {
            let err: TLSError = new Error('TLS handshake timeout');
            err.code = 'ERR_TLS_HANDSHAKE_TIMEOUT';
            secureSocket.destroy(err);
        });

        // 'close' passes a hadError flag, which is not an error
        let onClose = (): void => onError();

        secureSocket.once('close', onClose);
        secureSocket.once('error', onError);
        secureSocket.once('_tlsError', onError);
        secureSocket.once('clientError', onError);
        secureSocket.once('tlsClientError', onError);

        secureSocket.on('secure', () => {
            // SMTPConnection arms its own timeout on the socket it receives
            secureSocket.setTimeout(0);
            socket.removeListener('error', onError);
            secureSocket.removeListener('close', onClose);
            secureSocket.removeListener('error', onError);
            secureSocket.removeListener('_tlsError', onError);
            secureSocket.removeListener('clientError', onError);
            secureSocket.removeListener('tlsClientError', onError);
            if (returned) {
                try {
                    secureSocket.end();
                } catch {
                    //
                }
                return;
            }
            returned = true;

            // a client certificate was asked for and did not pass
            let verifyError: TLSError | null = verifyPeerCertificate(secureSocket, socketOptions);
            if (verifyError) {
                verifyError.meta = {
                    tlsProtocol: secureSocket.getProtocol(),
                    protocol: 'smtp',
                    stage: 'connect',
                    remoteAddress: socket.remoteAddress
                };
                secureSocket.destroy();
                return callback(verifyError);
            }

            return callback(null, secureSocket);
        });
    }
}

// Before the TypeScript build the package was CommonJS only, so a default import of it
// resolved to the exports object. The default export keeps that working
const smtpServer = { SMTPServer };
export default smtpServer;
