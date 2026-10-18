import crypto from 'node:crypto';
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import ipv6normalize from 'ipv6-normalize';
import punycode from 'punycode.js';
import sasl, { type SASLMechanism } from './sasl.js';
import type { SMTPServer } from './smtp-server.js';
import { SMTPStream } from './smtp-stream.js';
import type {
    SMTPServerAddress,
    SMTPServerAddressArgs,
    SMTPServerConnectionInfo,
    SMTPServerDataResult,
    SMTPServerDataStream,
    SMTPServerEnvelopeDSN,
    SMTPServerError,
    SMTPServerOptions,
    SMTPServerSession
} from './types.js';

export const SOCKET_TIMEOUT = 60 * 1000;

// idle timeout for a socket, the configured value or the default
export const socketTimeout = (options?: { socketTimeout?: number | undefined } | null): number => (options && options.socketTimeout) || SOCKET_TIMEOUT;

// How long a connection the server has closed (QUIT, a 421) waits for the client to
// close its side before the socket is destroyed. Measured from close() and never
// extended, unlike the idle timeout, which any received byte resets
const HALF_CLOSE_TIMEOUT = 5 * 1000;

// RFC 5321 section 4.5.3.1.2 limits a domain to 255 octets and an address literal is
// shorter still, so the HELO/EHLO argument is bounded here, with a little slack. The
// value ends up in Received headers and logs, where 16 KB of garbage has no place
const MAX_HELO_HOSTNAME_LENGTH = 300;

// Socket options for a TLS socket the server creates itself, copied from the server
// options for STARTTLS and implicit TLS alike (the secure context carries the rest).
// Without requestCert and rejectUnauthorized a client certificate is never asked for
export const TLS_SOCKET_OPTIONS = ['requestCert', 'rejectUnauthorized', 'NPNProtocols', 'session', 'requestOCSP'];

/** Details attached to a TLS setup error as err.meta */
export interface TLSErrorMeta {
    tlsProtocol?: string | null | undefined;
    protocol?: string | undefined;
    stage?: string | undefined;
    remoteAddress?: string | undefined;
    message?: string | undefined;
}

/** An error of a TLS setup, with the properties the library adds to it */
export interface TLSError extends Error {
    code?: string | undefined;
    responseCode?: number | undefined;
    report?: boolean | undefined;
    meta?: TLSErrorMeta | undefined;
}

/**
 * Copies the TLS_SOCKET_OPTIONS that are set in the server options onto the options of
 * a TLS socket the server creates itself
 *
 * @param options Server options
 * @param socketOptions TLS socket options to extend
 */
export function copyTLSSocketOptions(options: SMTPServerOptions, socketOptions: tls.TLSSocketOptions): void {
    TLS_SOCKET_OPTIONS.forEach(key => {
        if (key in options) {
            (socketOptions as Record<string, unknown>)[key] = (options as Record<string, unknown>)[key];
        }
    });
}

// ESMTP parameters that only make sense with a value. _parseAddressCommand stores
// a bare keyword (or "KEY=") as boolean true, and the code that consumes these
// treats the value as a string
const MAIL_VALUE_PARAMS = ['BODY', 'SIZE', 'RET', 'ENVID'];
const RCPT_VALUE_PARAMS = ['NOTIFY', 'ORCPT'];

// Control characters have no legitimate use in command parameters. They end up in
// SMTP responses, log entries and Received headers, so a value containing one
// enables response splitting and log/header injection. Defined once in lib/sasl.js
const CONTROL_CHARS = sasl.CONTROL_CHARS;

// same class, used to scrub rather than to reject
const CONTROL_CHARS_GLOBAL = new RegExp(CONTROL_CHARS.source, 'g');

// Control characters plus the invisible Unicode formatting characters (zero-width
// space, word joiner, zero-width no-break space). None are ever legitimate in an
// address: they enable log/header injection and visually spoofed addresses. Zero
// width joiners (U+200C, U+200D) are absent as these do appear in IDNs of some scripts
// eslint-disable-next-line no-control-regex
const ADDRESS_UNSAFE_CHARS = /[\x00-\x1F\x7F-\x9F\u200B\u2060\uFEFF]/;

// RFC 1035 limits
const MAX_HOSTNAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

// a single DNS label: letters, digits and hyphens, plus the underscore that real
// ISPs do publish in PTR records even though RFC 1035 does not allow it
const HOSTNAME_LABEL = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/i;

/**
 * Checks that a hostname obtained from an untrusted source looks like an actual
 * hostname. DNS labels are binary safe, so a PTR record can contain CRLF or any
 * other byte the owner of the IP address feels like publishing.
 *
 * NB! the length is checked before the root terminating dot is stripped, so that
 * the limit applies to the value as it was received.
 *
 * @param {String} hostname Hostname to check
 * @returns {Boolean} true if the value is safe to use as a hostname
 */
function isValidHostname(hostname: unknown): hostname is string {
    if (!hostname || typeof hostname !== 'string' || hostname.length > MAX_HOSTNAME_LENGTH) {
        return false;
    }

    return hostname
        .replace(/\.$/, '')
        .split('.')
        .every(label => label.length && label.length <= MAX_LABEL_LENGTH && HOSTNAME_LABEL.test(label));
}

/**
 * Normalizes an IP address for comparisons: drops the IPv4-mapped prefix a dual-stack
 * listener reports for an IPv4 peer and canonicalizes IPv6 (case, zero compression)
 *
 * @param {String} address IP address as reported by a socket or written in an option
 * @returns {String} Normalized address
 */
function normalizeAddress(rawAddress: string | null | undefined): string {
    let address = (rawAddress || '')
        .toString()
        .trim()
        .replace(/^::ffff:/i, '');
    if (address && net.isIPv6(address)) {
        address = ipv6normalize(address);
    }
    return address.toLowerCase();
}

/**
 * Checks a peer address against a trust option (useProxy, useXClient, useXForward).
 * `true` trusts every peer, an array lists the trusted addresses ('*' for every peer).
 * Both sides are normalized, so an IPv4 peer of a dual-stack listener matches its
 * IPv4 entry even though the socket reports it as ::ffff:a.b.c.d
 *
 * @param {Boolean|String[]} option Option value
 * @param {String} address Peer address
 * @returns {Boolean} true if the peer is trusted
 */
export function isAddressAllowed(option: boolean | string[] | undefined, rawAddress: string | null | undefined): boolean {
    if (!option) {
        return false;
    }
    if (!Array.isArray(option) || option.includes('*')) {
        return true;
    }
    let address = normalizeAddress(rawAddress);
    return option.some(entry => normalizeAddress(entry) === address);
}

/**
 * Checks the argument of HELO/EHLO. The syntax stays permissive, real clients send
 * bare IP addresses, Windows machine names and worse, but control characters and
 * over-long values are refused: the value is not echoed in replies, but applications
 * put it in Received headers and logs
 *
 * @param {String} hostname HELO/EHLO argument
 * @returns {Boolean} true if the value can be stored
 */
function isAcceptableHeloHostname(hostname: string): boolean {
    return hostname.length <= MAX_HELO_HOSTNAME_LENGTH && !CONTROL_CHARS.test(hostname);
}

/**
 * Judges the client certificate once the handshake of a TLS socket the library
 * wrapped itself is done, the way tls.Server does it for the sockets it accepts.
 * OpenSSL only fails the handshake when a required certificate is missing; an
 * untrusted one is left for the server side to judge afterwards, so without this
 * `rejectUnauthorized` would admit any certificate and `socket.authorized` would
 * never be true. Nothing is done when no certificate was requested.
 *
 * @param {tls.TLSSocket} tlsSocket Socket whose handshake has completed
 * @param {Object} socketOptions Options the socket was created with
 * @returns {Error|null} Verification error if the connection has to be refused
 */
export function verifyPeerCertificate(tlsSocket: tls.TLSSocket, socketOptions: tls.TLSSocketOptions): Error | null {
    if (!socketOptions.requestCert) {
        return null;
    }

    // the verification result is only reachable through the handle, which is where
    // tls.Server reads it too. A runtime without it (Bun) keeps what it set itself
    let handle = (tlsSocket as tls.TLSSocket & { _handle?: { verifyError?: () => (Error & { code?: string }) | null } })._handle;
    if (!handle || typeof handle.verifyError !== 'function') {
        return null;
    }

    let verifyError = handle.verifyError();
    if (verifyError) {
        // a string code at runtime, whatever @types/node says
        (tlsSocket as unknown as { authorizationError: string | undefined }).authorizationError = verifyError.code;
        return socketOptions.rejectUnauthorized ? verifyError : null;
    }

    tlsSocket.authorized = true;
    return null;
}

/**
 * Parses the "key=value" arguments of an XCLIENT or XFORWARD command. Values are
 * xtext encoded. Nothing is applied to the connection here, so that a command with
 * an invalid argument can be rejected as a whole instead of leaving the connection
 * in a half updated state.
 *
 * @param {String[]} parts Command arguments
 * @param {String[]} allowedKeys Keys accepted by the command
 * @param {String[]} unavailableValues Values that stand for "not available"
 * @returns {Object} {params} with the accepted key/value pairs, or {error} to reject
 */
function parseProxyParameters(
    parts: string[],
    allowedKeys: string[],
    unavailableValues: string[]
): { params: Map<string, string | false>; error?: undefined } | { params?: undefined; error: string } {
    let params = new Map<string, string | false>();

    for (let part of parts) {
        let values = part.split('=');
        let key = (values.shift() || '').toUpperCase();

        if (values.length !== 1 || !allowedKeys.includes(key)) {
            return { error: 'Error: Bad command parameter syntax' };
        }

        // value is xtext
        let value: string | false = decodeXtext(values[0] || '');

        // Reject values with control characters, including CRLF sequences smuggled
        // through xtext encoding (eg. NAME=ab+0D+0Acd). These end up in SMTP
        // responses, logs and Received headers and enable response splitting and
        // log/header injection
        if (CONTROL_CHARS.test(value)) {
            return { error: 'Error: Bad command parameter syntax' };
        }

        if (unavailableValues.includes(value.toUpperCase())) {
            value = false;
        }

        if (key === 'ADDR' && value) {
            value = value.replace(/^IPV6:/i, ''); // IPv6 addresses are prefixed with "IPv6:"

            if (!net.isIP(value)) {
                return { error: 'Error: Bad command parameter syntax. Invalid address' };
            }

            if (net.isIPv6(value)) {
                value = ipv6normalize(value);
            }
        }

        // NAME becomes the client hostname, which is echoed in replies and used in
        // Received headers, so it gets the same check as a reverse resolved name
        if (key === 'NAME' && value && !isValidHostname(value)) {
            return { error: 'Error: Bad command parameter syntax. Invalid hostname' };
        }

        if (params.has(key)) {
            // ignore duplicate keys
            continue;
        }

        params.set(key, value);
    }

    return { params };
}

/**
 * Decodes an xtext encoded value (RFC 3461), where "+XX" is a hex escape
 *
 * @param {String} value Encoded value
 * @returns {String} Decoded value
 */
function decodeXtext(value: string): string {
    return value.replace(/\+([0-9A-F]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

// Enhanced Status Code mappings based on RFC 3463
const ENHANCED_STATUS_CODES: Record<number, string> = {
    // Success codes (2xx)
    200: '2.0.0', // System status, or system help reply
    211: '2.0.0', // System status, or system help reply
    214: '2.0.0', // Help message
    220: '2.0.0', // Service ready
    221: '2.0.0', // Service closing transmission channel
    235: '2.7.0', // Authentication successful
    250: '2.0.0', // Requested mail action okay, completed
    251: '2.1.5', // User not local; will forward
    252: '2.1.5', // Cannot VRFY user, but will accept message
    334: '3.7.0', // Server challenge for authentication
    354: '2.0.0', // Start mail input; end with <CRLF>.<CRLF>

    // Temporary failure codes (4xx)
    420: '4.4.2', // Timeout or connection lost (non-standard, used by some servers)
    421: '4.4.2', // Service not available, closing transmission channel
    450: '4.2.1', // Requested mail action not taken: mailbox unavailable
    451: '4.3.0', // Requested action aborted: local error in processing
    452: '4.2.2', // Requested action not taken: insufficient system storage
    454: '4.7.0', // Temporary authentication failure

    // Permanent failure codes (5xx)
    500: '5.5.2', // Syntax error, command unrecognized
    501: '5.5.4', // Syntax error in parameters or arguments
    502: '5.5.1', // Command not implemented
    503: '5.5.1', // Bad sequence of commands
    504: '5.5.4', // Command parameter not implemented
    521: '5.3.2', // Machine does not accept mail
    523: '5.3.4', // Message size exceeds server limit (non-standard, used by some servers)
    530: '5.7.0', // Authentication required
    535: '5.7.8', // Authentication credentials invalid
    538: '5.7.0', // Must issue a STARTTLS command first (non-standard)
    550: '5.1.1', // Requested action not taken: mailbox unavailable
    551: '5.1.6', // User not local; please try forwarding
    552: '5.2.2', // Requested mail action aborted: exceeded storage allocation
    553: '5.1.3', // Requested action not taken: mailbox name not allowed
    554: '5.6.0', // Transaction failed
    555: '5.5.4', // MAIL FROM/RCPT TO parameters not recognized or not implemented
    556: '5.1.10', // RCPT TO syntax error (non-standard)
    557: '5.7.1', // Delivery not authorized (non-standard, used by some servers)
    558: '5.2.3' // Message too large for recipient (non-standard, used by some servers)
};

// Skip enhanced status codes for initial greeting and HELO/EHLO responses
const SKIPPED_COMMANDS_FOR_ENHANCED_STATUS_CODES = new Set(['HELO', 'EHLO', 'LHLO']);

// Context-specific enhanced status code mappings
const CONTEXTUAL_STATUS_CODES: Record<string, string> = {
    // Mail transaction specific codes
    MAIL_FROM_OK: '2.1.0', // Originator address valid
    RCPT_TO_OK: '2.1.5', // Destination address valid
    DATA_OK: '2.6.0', // Message accepted for delivery

    // Authentication specific codes
    AUTH_SUCCESS: '2.7.0', // Authentication successful
    AUTH_REQUIRED: '5.7.0', // Authentication required
    AUTH_INVALID: '5.7.8', // Authentication credentials invalid

    // Policy specific codes
    POLICY_VIOLATION: '5.7.1', // Delivery not authorized
    NOT_AUTHORIZED: '5.7.0', // Command not allowed for this client
    SPAM_REJECTED: '5.7.1', // Message refused

    // Mailbox specific codes
    MAILBOX_FULL: '4.2.2', // Mailbox full
    TOO_MANY_RECIPIENTS: '4.5.3', // Too many recipients
    MAILBOX_NOT_FOUND: '5.1.1', // Mailbox does not exist
    MAILBOX_SYNTAX_ERROR: '5.1.3', // Invalid mailbox syntax
    SENDER_SYNTAX_ERROR: '5.1.7', // Invalid sender mailbox syntax

    // System specific codes
    SYSTEM_ERROR: '4.3.0', // System error
    SYSTEM_FULL: '4.3.1', // System storage exceeded
    MESSAGE_TOO_BIG: '5.3.4', // Message too big for system

    // Network specific codes
    NETWORK_ERROR: '4.4.0', // Network routing error
    CONNECTION_TIMEOUT: '4.4.2' // Connection timeout
};

/** Connection details known before the SMTP session starts, eg. from a PROXY header */
export interface SMTPConnectionOptions {
    id?: string | undefined;
    ignore?: boolean | undefined;
    localAddress?: string | undefined;
    localPort?: number | undefined;
    remoteAddress?: string | undefined;
    remotePort?: number | undefined;
}

/** A command handler, called with the command line and a callback that resumes parsing */
type CommandHandler = (this: SMTPConnection, command: Buffer, callback: () => void) => void;

/** Result of _parseAddressCommand */
interface ParsedAddress extends SMTPServerAddress {
    duplicate?: string | undefined;
}

/** A parameter validation failure of MAIL FROM */
interface ParamError {
    code: number;
    message: string;
    enhancedCode: string | null;
}

/**
 * Creates a handler for new socket
 */
export class SMTPConnection extends EventEmitter {
    id: string;
    ignore: boolean | undefined;
    session: SMTPServerSession;
    secure: boolean;
    needsUpgrade: boolean;
    tlsOptions: tls.CipherNameAndProtocol | false;
    localAddress: string;
    localPort: number;
    remoteAddress: string;
    remotePort: number;
    name: string;
    clientHostname: string | false;
    openingCommand: string | false;
    hostNameAppearsAs: string | false;

    _server: SMTPServer;
    _socket: net.Socket | tls.TLSSocket;
    _transactionCounter: number;
    _ready: boolean;
    _upgrading: boolean;
    _nextHandler: CommandHandler | false;
    _parser: SMTPStream | false;
    _dataStream: SMTPServerDataStream | false | null;
    _originalRemoteAddress: string;
    _unauthenticatedCommands: number;
    _maxAllowedUnauthenticatedCommands: number | false;
    _unrecognizedCommands: number;
    _xClient: Map<string, string | number | false>;
    _xForward: Map<string, string | number | false>;
    _canEmitConnection: boolean;
    _closing: boolean;
    _closed: boolean;
    _closeTimer?: NodeJS.Timeout | undefined;
    _rcptIndex: Map<string, number> = new Map();

    constructor(server: SMTPServer, socket: net.Socket | tls.TLSSocket, options?: SMTPConnectionOptions | null) {
        super();

        options = options || {};
        // Random session ID, used for logging
        this.id =
            options.id ||
            BigInt('0x' + crypto.randomBytes(10).toString('hex'))
                .toString(32)
                .padStart(16, '0');

        this.ignore = options.ignore;

        this._server = server;
        this._socket = socket;

        // Replies are written whole, one per command. With Nagle on, the reply to a command a
        // client pipelined behind another one waits until the client acknowledged the previous
        // reply, and a client that delays its ACKs (Linux does by 40ms) waits that long for
        // every batch
        if (typeof socket.setNoDelay === 'function') {
            socket.setNoDelay(true);
        }

        // session data (envelope, user etc.)
        // the rest of the session is filled in by _resetSession() once the connection is ready
        this.session = {
            id: this.id
        } as SMTPServerSession;

        // how many messages have been processed
        this._transactionCounter = 0;

        // Do not allow input from client until initial greeting has been sent
        this._ready = false;

        // If true then the connection is currently being upgraded to TLS
        this._upgrading = false;

        // Set handler for incoming command and handler bypass detection by command name
        this._nextHandler = false;

        // Parser instance for the incoming stream
        this._parser = this._createParser();

        // if currently in data mode, this stream gets the content of incoming message
        this._dataStream = false;

        // If true, then the connection is using TLS
        this.session.secure = this.secure = !!this._server.options.secure;

        this.needsUpgrade = !!this._server.options.needsUpgrade;

        this.tlsOptions = this.secure && !this.needsUpgrade && (this._socket as tls.TLSSocket).getCipher ? (this._socket as tls.TLSSocket).getCipher() : false;

        // Store local and remote addresses for later usage
        this.localAddress = normalizeAddress(options.localAddress || this._socket.localAddress);
        this.localPort = Number(options.localPort || this._socket.localPort) || 0;
        this.remoteAddress = normalizeAddress(options.remoteAddress || this._socket.remoteAddress);
        this.remotePort = Number(options.remotePort || this._socket.remotePort) || 0;

        // The address the connection was accepted from (the PROXY protocol address when
        // useProxy is in use). XCLIENT and XFORWARD overwrite remoteAddress, the trust
        // lists for those commands are checked against this one
        this._originalRemoteAddress = this.remoteAddress;

        // Error counter - if too many commands in non-authenticated state are used, then disconnect
        this._unauthenticatedCommands = 0;

        // Max allowed unauthenticated commands
        this._maxAllowedUnauthenticatedCommands = this._server.options.maxAllowedUnauthenticatedCommands || 10;

        // Error counter - if too many invalid commands are used, then disconnect
        this._unrecognizedCommands = 0;

        // Server hostname for the greegins
        this.name = this._server.options.name || os.hostname();

        // Resolved hostname for remote IP address
        this.clientHostname = false;

        // The opening SMTP command (HELO, EHLO or LHLO)
        this.openingCommand = false;

        // The hostname client identifies itself with
        this.hostNameAppearsAs = false;

        // data passed from XCLIENT command
        this._xClient = new Map();

        // data passed from XFORWARD command
        this._xForward = new Map();

        // if true then can emit connection info
        this._canEmitConnection = true;

        // increment connection count
        this._closing = false;
        this._closed = false;
    }

    /**
     * Initiates the connection. Checks connection limits and reverse resolves client hostname. The client
     * is not allowed to send anything before init has finished otherwise 'You talk too soon' error is returned
     */
    init(): void {
        // Setup event handlers for the socket
        this._setListeners(() => {
            // Check that connection limit is not exceeded
            if (this._server.options.maxClients && this._server.connections.size > this._server.options.maxClients) {
                return this.send(421, this.name + ' Too many connected clients, try again in a moment', false);
            }

            // Keep a small delay for detecting early talkers
            let readyTimer = setTimeout(() => this.connectionReady(), 100);
            // Unref timer so connection init delay doesn't prevent process exit
            readyTimer.unref();
        });
    }

    connectionReady(next?: () => void): void {
        // Resolve hostname for the remote IP
        let reverseCb = (err?: Error | null, hostnames?: string[] | false): void => {
            if (err) {
                this._server.logger.error(
                    {
                        tnx: 'connection',
                        cid: this.id,
                        host: this.remoteAddress,
                        hostname: this.clientHostname,
                        err
                    },
                    'Reverse resolve for %s: %s',
                    this.remoteAddress,
                    err.message
                );
                // ignore resolve error
            }

            if (this._closing || this._closed) {
                return;
            }

            let resolvedHostname = (hostnames && hostnames.shift()) || '';

            // PTR records are controlled by the owner of the connecting IP address,
            // so only accept values that look like actual hostnames. Anything else
            // (eg. embedded CR/LF intended for SMTP response splitting, log forging
            // or Received header injection) falls back to the plain IP address
            if (resolvedHostname && !isValidHostname(resolvedHostname)) {
                this._server.logger.info(
                    {
                        tnx: 'connection',
                        cid: this.id,
                        host: this.remoteAddress,
                        hostname: resolvedHostname
                    },
                    'Discarded invalid reverse resolved hostname %s for %s',
                    JSON.stringify(resolvedHostname),
                    this.remoteAddress
                );
                resolvedHostname = '';
            }

            this._setClientHostname(resolvedHostname);

            this._resetSession();

            let onSecureIfNeeded = (next: () => void): void => {
                if (!this.session.secure) {
                    // no TLS
                    return next();
                }

                this.session.servername = (this._socket as tls.TLSSocket).servername;
                this._server.onSecure(this._socket, this.session, (err?: Error | null) => {
                    if (err) {
                        return this._onError(err);
                    }
                    next();
                });
            };

            this._server.onConnect(this.session, (err?: SMTPServerError | null) => {
                this._server.logger.info(
                    {
                        tnx: 'connection',
                        cid: this.id,
                        host: this.remoteAddress,
                        hostname: this.clientHostname
                    },
                    'Connection from %s',
                    this.clientHostname
                );

                if (err) {
                    this.send(err.responseCode || 554, err.message, false);
                    return this.close();
                }

                onSecureIfNeeded(() => {
                    this._ready = true; // Start accepting data from input

                    if (!this._server.options.useXClient && !this._server.options.useXForward) {
                        this.emitConnection();
                    }

                    this._sendGreeting();

                    if (typeof next === 'function') {
                        next();
                    }
                });
            });
        };

        // Skip reverse name resolution if disabled.
        if (this._server.options.disableReverseLookup) {
            return reverseCb(null, false);
        }

        // also make sure that we do not wait too long over the reverse resolve call
        let greetingSent = false;
        let reverseTimer = setTimeout(() => {
            clearTimeout(reverseTimer);
            if (greetingSent) {
                return;
            }
            greetingSent = true;
            reverseCb(new Error('Timeout'));
        }, 1500);
        // Unref timer so DNS timeout doesn't prevent process exit
        reverseTimer.unref();

        // Helper function to handle resolver results consistently
        const handleResolverResult = (err: Error | null, hostnames?: string[]): void => {
            clearTimeout(reverseTimer);
            if (greetingSent) {
                return;
            }
            greetingSent = true;
            reverseCb(err, hostnames);
        };

        try {
            // Use custom resolver if provided, otherwise use default dns.reverse
            if (this._server.options.resolver && typeof this._server.options.resolver.reverse === 'function') {
                this._server.options.resolver.reverse(this.remoteAddress.toString(), handleResolverResult);
            } else {
                // dns.reverse throws on invalid input, see https://github.com/nodejs/node/issues/3112
                dns.reverse(this.remoteAddress.toString(), handleResolverResult);
            }
        } catch (E) {
            clearTimeout(reverseTimer);
            if (greetingSent) {
                return;
            }
            greetingSent = true;
            reverseCb(E as Error);
        }
    }

    /**
     * Send data to socket
     *
     * @param code Response code
     * @param data If data is Array, send a multi-line response
     * @param context Optional context for enhanced status codes, false for none
     */
    send(code: number, data?: string | string[] | null, context?: string | false): void {
        let payload: string;
        let enhancedCode = this._getEnhancedStatusCode(code, context);

        // A response line must never contain a control character: this method also
        // emits application supplied text such as err.message from onAuth/onMailFrom,
        // which nothing else validates and which applications routinely build from
        // client provided values. Line breaks are added by this method alone, so a
        // control character reaching here can only split the response. This is a
        // backstop - untrusted values are rejected where they are parsed
        let sanitize = (line: unknown): string => (line === undefined || line === null ? '' : line.toString()).replace(CONTROL_CHARS_GLOBAL, ' ');

        if (Array.isArray(data)) {
            // Multi-line response - enhanced status code must appear on each line
            payload = data
                .map((line, i, arr) => {
                    let prefix = code + (i < arr.length - 1 ? '-' : ' ');
                    if (enhancedCode) {
                        prefix += enhancedCode + ' ';
                    }
                    return prefix + sanitize(line);
                })
                .join('\r\n');
        } else {
            // Single line response
            let parts: (number | string)[] = [code];
            if (enhancedCode) {
                parts.push(enhancedCode);
            }
            if (data) {
                parts.push(sanitize(data));
            }
            payload = parts.join(' ');
        }

        if (code >= 400) {
            this.session.error = payload;
        }

        // Ref. https://datatracker.ietf.org/doc/html/rfc4954#section-4
        if (code === 334 && payload === '334') {
            payload += ' ';
        }

        // NB! while the TLS handshake is in flight this._socket is still the raw
        // socket, so anything written here would be cleartext injected into the
        // middle of the record stream and would abort the handshake. This is the
        // single write site, so the invariant is enforced here rather than at each
        // of the callers (commands, socket timeouts, server shutdown)
        if (!this._upgrading && this._socket && !this._socket.destroyed && this._socket.readyState === 'open') {
            this._socket.write(payload + '\r\n');
            this._server.logger.debug(
                {
                    tnx: 'send',
                    cid: this.id,
                    user: (this.session.user && this.session.user.username) || this.session.user
                },
                'S:',
                payload
            );
        }

        if (code === 421) {
            // the connection still has to go away even if the response was suppressed
            this.close();
        }
    }

    /**
     * Sends the 220 greeting. A greeting carries no enhanced status code (RFC 2034 section 3)
     */
    _sendGreeting(): void {
        let options = this._server.options;
        this.send(220, this.name + ' ' + (options.lmtp ? 'LMTP' : 'ESMTP') + (options.banner ? ' ' + options.banner : ''), false);
    }

    /**
     * Close socket
     */
    close(): void {
        if (!this._socket.destroyed && this._socket.writable) {
            this._socket.end();
        }

        this._server.connections.delete(this);

        if (this._closing) {
            return;
        }
        this._closing = true;

        // Nothing the client sends from now on can be answered, so stop parsing it: a
        // command pipelined after QUIT must not run, and the connection no longer
        // counts against maxClients
        if (this._parser) {
            this._socket.unpipe(this._parser);
            this._parser.isClosed = true;
        }

        // The idle timeout alone does not bound a half-closed socket: any byte the
        // client trickles in resets it, so a client that never closes its side could
        // hold the descriptor for as long as it likes, outside the maxClients limit.
        // This deadline is measured from here and nothing extends it
        this._closeTimer = setTimeout(
            () => {
                if (!this._socket.destroyed) {
                    this._socket.destroy();
                }
            },
            Math.min(socketTimeout(this._server.options), HALF_CLOSE_TIMEOUT)
        );
        this._closeTimer.unref();
    }

    // PRIVATE METHODS

    /**
     * Creates a command parser for the socket. The TLS session after STARTTLS gets a
     * new one as well, see upgrade()
     *
     * @returns Parser wired to this connection
     */
    _createParser(): SMTPStream {
        let parser = new SMTPStream({
            maxCommandLength: this._server.options.maxCommandLength
        });

        parser.oncommand = (command, callback) => this._onCommand(command, callback);

        parser.on('error', err => {
            // if this fires on plaintext buffered before a STARTTLS handshake then
            // send() suppresses the response and only closes the connection
            this.send(421, 'Error: ' + err.message);
        });

        return parser;
    }

    /**
     * Setup socket event handlers
     */
    _setListeners(callback: () => void): void {
        this._socket.on('close', hadError => this._onCloseEvent(hadError));
        this._socket.on('error', err => this._onError(err));
        this._socket.setTimeout(socketTimeout(this._server.options), () => this._onTimeout());
        this._socket.pipe(this._parser as SMTPStream);
        if (!this.needsUpgrade) {
            return callback();
        }
        this.upgrade(() => false, callback);
    }

    _onCloseEvent(hadError?: boolean): void {
        this._server.logger.info(
            {
                tnx: 'close',
                cid: this.id,
                host: this.remoteAddress,
                user: (this.session.user && this.session.user.username) || this.session.user,
                hadError
            },
            '%s received "close" event from %s' + (hadError ? ' after error' : ''),
            this.id,
            this.remoteAddress
        );

        this._onClose();
    }

    /**
     * Fired when the socket is closed
     * @event
     */
    _onClose(): void {
        clearTimeout(this._closeTimer);

        if (this._parser) {
            this._parser.isClosed = true;
            this._socket.unpipe(this._parser);
            this._parser = false;
        }

        if (this._dataStream) {
            this._dataStream.unpipe();
            this._dataStream = null;
        }

        this._server.connections.delete(this);

        if (this._closed) {
            return;
        }

        this._closed = true;
        this._closing = false;

        this._server.logger.info(
            {
                tnx: 'close',
                cid: this.id,
                host: this.remoteAddress,
                user: (this.session.user && this.session.user.username) || this.session.user
            },
            'Connection closed to %s',
            this.clientHostname || this.remoteAddress
        );
        // the callback argument is a no-op, handlers written against the documented
        // signature may call it and there is nothing to wait for
        setImmediate(() => this._server.onClose(this.session, () => false));
    }

    /**
     * Fired when an error occurs with the socket
     *
     * @event
     * @param err Error object
     */
    _onError(err: Error & { code?: string | undefined; remoteAddress?: string | undefined }): void {
        err.remoteAddress = this.remoteAddress;
        this._server.logger.error(
            {
                err,
                tnx: 'error',
                user: (this.session.user && this.session.user.username) || this.session.user
            },
            '%s %s %s',
            this.id,
            this.remoteAddress,
            err.message
        );

        if ((err.code === 'ECONNRESET' || err.code === 'EPIPE') && (!this.session.envelope || !this.session.envelope.mailFrom)) {
            // We got a connection error outside transaction. In most cases it means dirty
            // connection ending by the other party, so we can just ignore it
            this.close(); // mark connection as 'closing'
            return;
        }

        this.emit('error', err);
    }

    /**
     * Fired when socket timeouts. Closes connection
     *
     * @event
     */
    _onTimeout(): void {
        if (this._closing) {
            // We already ended the socket and the client never closed its side, stop
            // waiting for it or the half-open socket would be kept forever. Besides
            // misbehaving clients this covers Bun, which unlike Node does not report
            // the client's FIN on a socket that was paused by a parser error unpipe
            this._socket.destroy();
            return;
        }
        this.send(421, 'Timeout - closing connection');
    }

    /**
     * Checks if a selected command is available and invokes it
     *
     * @param command Single line of data from the client
     * @param callback Callback to run once the command is processed
     */
    _onCommand(command: Buffer, callback?: () => void): void {
        let commandName = ((command || '').toString().split(' ').shift() as string).toUpperCase();
        let logged = this._redactCredentials(commandName, (command || '').toString());
        this._server.logger.debug(
            {
                tnx: 'command',
                cid: this.id,
                command: logged.commandName,
                user: (this.session.user && this.session.user.username) || this.session.user
            },
            'C:',
            logged.line
        );

        let handler: CommandHandler | undefined;
        const done: () => void = callback || (() => false);

        // Anything that was buffered while the TLS handshake is running arrived in
        // plaintext and must be discarded without a response. NB! this has to be
        // the very first check, every branch below writes to the socket, which at
        // this point is still the raw one - such a write would both leak plaintext
        // into the middle of the handshake and abort the upgrade
        if (this._upgrading) {
            return done();
        }

        // If server already closing then ignore commands
        if (this._server._closeTimeout) {
            return this.send(421, 'Server shutting down', commandName);
        }

        if (!this._ready) {
            // block spammers that send payloads before server greeting
            return this.send(421, this.name + ' You talk too soon', commandName);
        }

        // block malicious web pages that try to make SMTP calls from an AJAX request
        if (/^(OPTIONS|GET|HEAD|POST|PUT|DELETE|TRACE|CONNECT) \/.* HTTP\/\d\.\d$/i.test(command.toString())) {
            return this.send(421, 'HTTP requests not allowed', commandName);
        }

        if (this._nextHandler) {
            // If we already have a handler method queued up then use this
            handler = this._nextHandler;
            this._nextHandler = false;
        } else {
            // detect handler from the command name
            switch (commandName) {
                case 'HELO':
                case 'EHLO':
                case 'LHLO':
                    this.openingCommand = commandName;
                    break;
            }
            if (this._server.options.lmtp) {
                switch (commandName) {
                    case 'HELO':
                    case 'EHLO':
                        this.send(500, 'Error: ' + commandName + ' not allowed in LMTP server', false);
                        setImmediate(done);
                        return;
                    case 'LHLO':
                        commandName = 'EHLO';
                        break;
                }
            }
            if (this._isSupported(commandName)) {
                handler = this._getHandler(commandName);
            }
        }

        if (!handler) {
            // if the user makes more
            this._unrecognizedCommands++;
            if (this._unrecognizedCommands >= 10) {
                return this.send(421, 'Error: too many unrecognized commands', commandName);
            }

            this.send(500, 'Error: command not recognized', commandName);
            setImmediate(done);
            return;
        }

        // block users that try to fiddle around without logging in
        if (
            !this.session.user &&
            this._isSupported('AUTH') &&
            !this._server.options.authOptional &&
            commandName !== 'AUTH' &&
            this._maxAllowedUnauthenticatedCommands !== false
        ) {
            this._unauthenticatedCommands++;
            if (this._unauthenticatedCommands >= this._maxAllowedUnauthenticatedCommands) {
                return this.send(421, 'Error: too many unauthenticated commands', commandName);
            }
        }

        if (!this.hostNameAppearsAs && commandName && ['MAIL', 'RCPT', 'DATA', 'AUTH'].includes(commandName)) {
            this.send(503, 'Error: send ' + (this._server.options.lmtp ? 'LHLO' : 'HELO/EHLO') + ' first');
            setImmediate(done);
            return;
        }

        // Check if authentication is required
        if (!this.session.user && this._isSupported('AUTH') && ['MAIL', 'RCPT', 'DATA'].includes(commandName) && !this._server.options.authOptional) {
            this.send(
                530,
                typeof this._server.options.authRequiredMessage === 'string' ? this._server.options.authRequiredMessage : 'Error: authentication Required'
            );
            setImmediate(done);
            return;
        }

        // A handler bug must not escape into the socket data pipe, where it would
        // either kill the process or surface as a parser error with internal details
        let handlerDone = false;
        let handlerCallback = (): void => {
            handlerDone = true;
            return done();
        };
        try {
            handler.call(this, command, handlerCallback);
        } catch (E) {
            let err = E as Error;
            this._server.logger.error(
                {
                    err,
                    tnx: 'command',
                    cid: this.id,
                    command: commandName
                },
                '%s Failed to process %s command: %s',
                this.id,
                commandName,
                err.message
            );
            if (!handlerDone) {
                this.send(451, 'Error: internal server error');
                handlerCallback();
            }
        }
    }

    /**
     * Hides credentials from the command log. The argument of AUTH (a base64 PLAIN
     * blob, a LOGIN initial response, an XOAUTH2 token) and every continuation line
     * of an authentication exchange carry them, so those are logged the way the
     * Nodemailer client logs what it sends
     *
     * @param commandName Upper-cased command name
     * @param line Command line as received
     * @returns {commandName, line} safe to log
     */
    _redactCredentials(commandName: string, line: string): { commandName: string; line: string } {
        if (this._nextHandler) {
            // a continuation line of an AUTH exchange, its first token is not a command name
            return { commandName: 'AUTH', line: '/* secured */' };
        }

        if (commandName === 'AUTH') {
            let parts = line.trim().split(/\s+/);
            if (parts.length > 2) {
                line = parts.slice(0, 2).join(' ') + ' /* secured */';
            }
        }

        return { commandName, line };
    }

    /**
     * Rejects the command with a 501 if a parameter is given more than once or a
     * listed parameter is present without a value
     *
     * @param parsed Result of _parseAddressCommand
     * @param keys Parameter names that require a value
     * @param callback Command callback, called when the command is rejected
     * @returns true if the command was rejected
     */
    _rejectInvalidParams(parsed: ParsedAddress, keys: string[], callback: () => void): boolean {
        let args = parsed.args;
        let error: string | undefined;

        if (parsed.duplicate) {
            // a parameter can only be given once (RFC 3461 section 4 says so explicitly for DSN)
            error = 'Error: duplicate ' + parsed.duplicate + ' parameter';
        } else {
            let valueless = args && keys.find(key => args[key] !== undefined && (typeof args[key] !== 'string' || !args[key]));
            if (valueless) {
                error = 'Error: ' + valueless + ' parameter requires a value';
            }
        }

        if (!error) {
            return false;
        }
        this.send(501, error);
        callback();
        return true;
    }

    /**
     * Checks that a command is available and is not listed in the disabled commands array
     *
     * @param command Command name
     * @returns Returns true if the command can be used
     */
    _isSupported(command: string): boolean {
        command = (command || '').toString().trim().toUpperCase();
        return !this._server.options.disabledCommands.includes(command) && typeof this._getHandler(command) === 'function';
    }

    /**
     * Looks up the handler method of a command
     *
     * @param command Upper case command name
     * @returns The handler, if there is one
     */
    _getHandler(command: string): CommandHandler | undefined {
        return (this as unknown as Record<string, CommandHandler | undefined>)['handler_' + command];
    }

    /**
     * Determines if enhanced status codes should be used
     * @returns {Boolean} True if enhanced status codes should be included in responses
     */
    _useEnhancedStatusCodes(): boolean {
        return !this._server.options.hideENHANCEDSTATUSCODES;
    }

    /**
     * Gets the appropriate enhanced status code for a given SMTP response code and context
     * @param code SMTP response code
     * @param context Optional context for more specific status codes
     * @returns Enhanced status code or empty string if not applicable
     */
    _getEnhancedStatusCode(code: number, context?: string | false): string {
        if (context === false || !this._useEnhancedStatusCodes()) {
            return '';
        }

        // Skip 3xx responses as per RFC 2034
        if (code >= 300 && code < 400) {
            return '';
        }

        // Skip enhanced status codes for initial greeting and HELO/EHLO responses
        if (context && SKIPPED_COMMANDS_FOR_ENHANCED_STATUS_CODES.has(context)) {
            return '';
        }

        // Use contextual codes if available
        if (context && CONTEXTUAL_STATUS_CODES[context]) {
            return CONTEXTUAL_STATUS_CODES[context];
        }

        // Use default mapping
        if (ENHANCED_STATUS_CODES[code]) {
            return ENHANCED_STATUS_CODES[code];
        }

        // 2xx fallback
        if (code >= 200 && code < 300) {
            return '2.0.0';
        }

        // 4xx (transient failure)
        if (code >= 400 && code < 500) {
            return '4.0.0';
        }

        // 5xx (permanent failure)
        if (code >= 500) {
            return '5.0.0';
        }

        // safeguard (non-spec; but should never occur)
        return '';
    }

    /**
     * Parses commands like MAIL FROM and RCPT TO. Returns an object with the address and optional arguments.
     *
     * @param rawName Address type, eg 'mail from' or 'rcpt to'
     * @param rawCommand Data payload to parse
     * @returns Parsed address in the form of {address:, args: {}} or false if parsing failed
     */
    _parseAddressCommand(rawName: string, rawCommand: Buffer | string): ParsedAddress | false {
        let command = (rawCommand || '').toString();
        let name = (rawName || '').toString().trim().toUpperCase();

        let parts = command.split(':');
        command = (parts.shift() as string).trim().toUpperCase();
        parts = parts.join(':').trim().split(/\s+/);

        let address = parts.shift() as string;
        let args: SMTPServerAddressArgs | false = false;
        let duplicate: string | false = false;
        let invalid = false;

        if (name !== command) {
            return false;
        }

        if (!/^<[^<>]*>$/.test(address)) {
            invalid = true;
        } else {
            // RFC 5321 section 4.1.2 and appendix C: a source route ("@relay.example.com:")
            // must be accepted and should be ignored
            address = address.slice(1, -1).replace(/^@[^\s,:@]+(?:,@[^\s,:@]+)*:/, '');
        }

        parts.forEach(param => {
            let part = param.split('=');
            let key = (part.shift() as string).toUpperCase();
            let value: string | true = part.join('=') || true;

            // Skip parameters with empty keys
            if (!key || key.trim() === '') {
                return;
            }

            if (typeof value === 'string') {
                value = decodeXtext(value);

                // Reject parameter values with control characters, including CRLF
                // sequences smuggled through xtext encoding (eg. ENVID=ab+0D+0Acd).
                // These have no legitimate use and enable log/header injection
                if (CONTROL_CHARS.test(value)) {
                    invalid = true;
                    return;
                }
            }

            if (!args) {
                args = {};
            }

            if (key in args) {
                duplicate = key;
            }

            args[key] = value;
        });

        if (address && ADDRESS_UNSAFE_CHARS.test(address)) {
            // rejected even in lenient mode, see the constant for the rationale
            invalid = true;
        } else if (name === 'RCPT TO' && address.toLowerCase() === 'postmaster') {
            // RFC 5321 section 4.1.1.3: the domainless postmaster recipient must be accepted
        } else if (address) {
            // Validate email address format
            let addressParts = address.split('@');
            if (addressParts.length !== 2 || !addressParts[0] || !addressParts[1]) {
                invalid = true;
            } else {
                let localPart = addressParts[0];
                let domain = addressParts[1];

                if (this._server.options.lenientAddressParsing) {
                    // Minimal validation only (pre-v3.16 behavior). Many widely deployed
                    // senders (e.g. HPE iLO firmware that uses "user.@example.com") fail
                    // strict RFC 5321 syntax checks, so this mode keeps the address as-is
                    // and leaves any further validation to the application
                    try {
                        address = [localPart, '@', punycode.toUnicode(domain)].join('');
                    } catch (E) {
                        this._server.logger.error(
                            {
                                tnx: 'punycode',
                                cid: this.id,
                                user: (this.session.user && this.session.user.username) || this.session.user
                            },
                            'Failed to process punycode domain "%s". error=%s',
                            domain,
                            (E as Error).message
                        );
                        // keep the original domain if punycode conversion fails
                        address = [localPart, '@', domain].join('');
                    }
                } else if (localPart.length + 1 + domain.length > 253) {
                    // RFC 5321 Section 4.5.3.1.3: Path max is 256 octets (including < @ >)
                    // This means local-part + @ + domain must be ≤ 253 octets
                    // Note: Individual limits (local 64, domain 255) are contradictory with path limit
                    // We enforce the path limit to accept Gmail CAF forwarding addresses
                    invalid = true;
                } else {
                    // Validate local-part format - permissive validation
                    // Reject only clearly invalid patterns (dots at edges, consecutive dots)
                    // Allow common special characters used by email providers
                    if (localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..')) {
                        invalid = true;
                    }

                    // Check if domain is an IP literal (RFC 5321 Section 4.1.3)
                    // Format: [IPv4] or [IPv6:address]
                    let isIPLiteral = !invalid && domain.startsWith('[') && domain.endsWith(']');

                    if (isIPLiteral) {
                        // IP literal address handling
                        // Extract the IP address from brackets
                        let ipContent = domain.slice(1, -1);
                        let isValidIP = false;

                        // Check for IPv6 format: IPv6:address
                        if (ipContent.toUpperCase().startsWith('IPV6:')) {
                            let ipv6Addr = ipContent.slice(5);
                            // Validate IPv6 address
                            if (net.isIPv6(ipv6Addr)) {
                                isValidIP = true;
                                // Normalize IPv6 address
                                try {
                                    ipv6Addr = ipv6normalize(ipv6Addr);
                                    domain = '[IPv6:' + ipv6Addr + ']';
                                } catch {
                                    // Keep original if normalization fails
                                }
                            }
                        } else if (net.isIPv4(ipContent)) {
                            // Check for IPv4 format
                            isValidIP = true;
                        }

                        if (!isValidIP) {
                            invalid = true;
                        }

                        if (!invalid) {
                            // For IP literals, skip punycode conversion
                            address = [localPart, '@', domain].join('');
                        }
                    } else {
                        // Validate domain format (before punycode conversion)
                        // Reject clearly invalid patterns
                        if (
                            !invalid &&
                            (domain.startsWith('.') ||
                                domain.endsWith('.') ||
                                domain.includes('..') ||
                                domain.includes('.-') ||
                                domain.includes('-.') ||
                                !/^[a-zA-Z0-9\u0080-\uFFFF.-]+$/.test(domain))
                        ) {
                            invalid = true;
                        }

                        if (!invalid) {
                            try {
                                address = [localPart, '@', punycode.toUnicode(domain)].join('');
                            } catch (E) {
                                this._server.logger.error(
                                    {
                                        tnx: 'punycode',
                                        cid: this.id,
                                        user: (this.session.user && this.session.user.username) || this.session.user
                                    },
                                    'Failed to process punycode domain "%s". error=%s',
                                    domain,
                                    (E as Error).message
                                );
                                // If punycode conversion fails, treat as invalid
                                invalid = true;
                            }
                        }
                    }
                }
            }
        }

        if (invalid) {
            return false;
        }

        let parsed: ParsedAddress = { address, args };
        if (duplicate) {
            // rejected by the command handler, never reaches the application
            parsed.duplicate = duplicate;
        }
        return parsed;
    }

    /**
     * Resets or sets up a new session. We reuse existing session object to keep
     * application specific data.
     */
    _resetSession(): void {
        let session = this.session;

        // reset data that might be overwritten
        session.localAddress = this.localAddress;
        session.localPort = this.localPort;
        session.remoteAddress = this.remoteAddress;
        session.remotePort = this.remotePort;
        // false until known, the public type is a string for compatibility with the
        // earlier type declarations, see SMTPServerSession
        session.clientHostname = this.clientHostname as string;
        session.openingCommand = this.openingCommand as string;
        session.hostNameAppearsAs = this.hostNameAppearsAs as string;
        session.xClient = this._xClient;
        session.xForward = this._xForward;
        session.transmissionType = this._transmissionType();

        session.tlsOptions = this.tlsOptions;

        // reset transaction properties
        session.envelope = {
            mailFrom: false,
            rcptTo: [],
            /** @property {boolean} requireTLS - RFC 8689: Indicates client requires TLS for entire delivery chain */
            requireTLS: false,
            /** @property {string} bodyType - RFC 6152: Message body encoding type (7bit or 8bitmime) */
            bodyType: '7bit',
            /** @property {boolean} smtpUtf8 - RFC 6531: Indicates UTF-8 support is requested */
            smtpUtf8: false
        };

        if (!this._server.options.hideDSN) {
            session.envelope.dsn = {
                ret: null, // RET parameter from MAIL FROM (FULL or HDRS)
                envid: null // ENVID parameter from MAIL FROM
            };
        }

        session.transaction = this._transactionCounter + 1;

        // lower-cased recipient address to its position in envelope.rcptTo, so that a
        // repeated RCPT is found without scanning the list
        this._rcptIndex = new Map();
    }

    /**
     * Stores the hostname of the client. The value always comes from an untrusted
     * source (a PTR record, an XCLIENT/XFORWARD parameter), so normalization lives
     * here rather than at each of the call sites. An empty value falls back to the
     * remote IP address in the [addr] literal form used by Received headers.
     *
     * NB! this normalizes but does not validate - callers that can validate do so
     * before calling, as the accepted shapes differ per source.
     *
     * @param hostname Hostname to store
     */
    _setClientHostname(hostname: string | false | null | undefined): void {
        // hostnames are case insensitive, and a root terminated value is valid but
        // the trailing dot is not part of the name
        hostname = (hostname || '').toString().toLowerCase().replace(/\.$/, '');

        this.clientHostname = hostname || '[' + this.remoteAddress + ']';
    }

    /**
     * Returns current transmission type
     *
     * @return Transmission type
     */
    _transmissionType(): string {
        let type = this._server.options.lmtp ? 'LMTP' : 'SMTP';

        if (this.openingCommand === 'EHLO') {
            type = 'E' + type;
        }

        if (this.secure) {
            type += 'S';
        }

        if (this.session.user) {
            type += 'A';
        }

        return type;
    }

    emitConnection(): void {
        if (!this._canEmitConnection) {
            return;
        }
        this._canEmitConnection = false;
        let info: SMTPServerConnectionInfo = {
            id: this.id,
            localAddress: this.localAddress,
            localPort: this.localPort,
            remoteAddress: this.remoteAddress,
            remotePort: this.remotePort,
            hostNameAppearsAs: this.hostNameAppearsAs,
            clientHostname: this.clientHostname
        };
        this.emit('connect', info);
    }

    // COMMAND HANDLERS

    /**
     * Processes EHLO. Requires valid hostname as the single argument.
     */
    handler_EHLO(command: Buffer, callback: () => void): void {
        let parts = command.toString().trim().split(/\s+/);
        let hostname = parts[1] || '';

        if (parts.length !== 2) {
            this.send(501, 'Error: syntax: ' + (this._server.options.lmtp ? 'LHLO' : 'EHLO') + ' hostname', false);
            return callback();
        }

        if (!isAcceptableHeloHostname(hostname)) {
            this.send(501, 'Error: Bad hostname syntax', false);
            return callback();
        }

        this.hostNameAppearsAs = hostname.toLowerCase();

        let features = ['PIPELINING', '8BITMIME', 'SMTPUTF8', 'ENHANCEDSTATUSCODES', 'DSN'].filter(
            feature => !(this._server.options as unknown as Record<string, unknown>)['hide' + feature]
        );

        if (this._server.options.authMethods.length && this._isSupported('AUTH') && !this.session.user) {
            features.push(['AUTH'].concat(this._server.options.authMethods).join(' '));
        }

        if (!this.secure && this._isSupported('STARTTLS') && !this._server.options.hideSTARTTLS) {
            features.push('STARTTLS');
        }

        if (this.secure && !this._server.options.hideREQUIRETLS) {
            features.push('REQUIRETLS');
        }

        if (this._server.options.size) {
            features.push('SIZE' + (this._server.options.hideSize ? '' : ' ' + this._server.options.size));
        }

        if (this._proxyCommandAllowed('XCLIENT', 'useXClient')) {
            features.push('XCLIENT NAME ADDR PORT PROTO HELO LOGIN');
        }

        if (this._proxyCommandAllowed('XFORWARD', 'useXForward')) {
            features.push('XFORWARD NAME ADDR PORT PROTO HELO IDENT SOURCE');
        }

        this._resetSession(); // EHLO is effectively the same as RSET

        // Format HELO response using configured format or default
        let heloResponse = this._server.options.heloResponse || '%s Nice to meet you, %s';
        let replacements = [this.name, this.clientHostname];
        let replacementIndex = 0;
        let formattedResponse = heloResponse.replace(/%s/g, () => replacements[replacementIndex++] || '');

        this.send(250, [formattedResponse].concat(features || []), false);

        callback();
    }

    /**
     * Checks if a proxy command (XCLIENT or XFORWARD) is available. XCLIENT ADDR hands
     * the session over to the actual client, which must not be able to override its
     * own connection details after that, so both commands go away with it
     *
     * @param command Command name
     * @param option Server option that enables the command: true for every
     *     peer, or a list of the peer addresses allowed to use it
     * @returns true if the client may use the command
     */
    _proxyCommandAllowed(command: string, option: 'useXClient' | 'useXForward'): boolean {
        return !this._xClient.has('ADDR') && isAddressAllowed(this._server.options[option], this._originalRemoteAddress) && this._isSupported(command);
    }

    /**
     * Processes HELO. Requires valid hostname as the single argument.
     */
    handler_HELO(command: Buffer, callback: () => void): void {
        let parts = command.toString().trim().split(/\s+/);
        let hostname = parts[1] || '';

        if (parts.length !== 2) {
            this.send(501, 'Error: Syntax: HELO hostname', false);
            return callback();
        }

        if (!isAcceptableHeloHostname(hostname)) {
            this.send(501, 'Error: Bad hostname syntax', false);
            return callback();
        }

        this.hostNameAppearsAs = hostname.toLowerCase();

        this._resetSession(); // HELO is effectively the same as RSET

        // Format HELO response using configured format or default
        let heloResponse = this._server.options.heloResponse || '%s Nice to meet you, %s';
        let replacements = [this.name, this.clientHostname];
        let replacementIndex = 0;
        let formattedResponse = heloResponse.replace(/%s/g, () => replacements[replacementIndex++] || '');

        this.send(250, formattedResponse, false);

        callback();
    }

    /**
     * Processes QUIT. Closes the connection
     */
    handler_QUIT(command: Buffer, callback: () => void): void {
        this.send(221, 'Bye');
        this.close();
        callback();
    }

    /**
     * Processes NOOP. Does nothing but keeps the connection alive
     */
    handler_NOOP(command: Buffer, callback: () => void): void {
        this.send(250, 'OK');
        callback();
    }

    /**
     * Processes RSET. Resets user and session info
     */
    handler_RSET(command: Buffer, callback: () => void): void {
        this._resetSession();

        this.send(250, 'Flushed');
        callback();
    }

    /**
     * Processes HELP. Responds with url to RFC
     */
    handler_HELP(command: Buffer, callback: () => void): void {
        this.send(214, 'See https://tools.ietf.org/html/rfc5321 for details');
        callback();
    }

    /**
     * Processes VRFY. Does not verify anything
     */
    handler_VRFY(command: Buffer, callback: () => void): void {
        if (!command.toString().trim().split(/\s+/)[1]) {
            this.send(501, 'Error: Syntax: VRFY address');
            return callback();
        }
        this.send(252, 'Try to send something. No promises though');
        callback();
    }

    /**
     * Overrides connection info
     * http://www.postfix.org/XCLIENT_README.html
     */
    handler_XCLIENT(command: Buffer, callback: () => void): void {
        // check if user is authorized to perform this command
        if (!this._proxyCommandAllowed('XCLIENT', 'useXClient')) {
            this.send(550, 'Error: Not allowed', 'NOT_AUTHORIZED');
            return callback();
        }

        // not allowed to change properties if already processing mail
        if (this.session.envelope.mailFrom) {
            this.send(503, 'Error: Mail transaction in progress');
            return callback();
        }

        let allowedKeys = ['NAME', 'ADDR', 'PORT', 'PROTO', 'HELO', 'LOGIN'];
        let parts = command.toString().trim().split(/\s+/);
        parts.shift(); // remove XCLIENT prefix

        if (!parts.length) {
            this.send(501, 'Error: Bad command parameter syntax');
            return callback();
        }

        let loginValue: string | false = false;

        // Parse and validate every argument before applying any of them. A command
        // that is rejected halfway through would otherwise leave the connection with
        // partially updated state, eg. a spoofed remote address that also blocks any
        // further XCLIENT attempt
        let { params, error } = parseProxyParameters(parts, allowedKeys, ['[UNAVAILABLE]', '[TEMPUNAVAIL]']);
        if (!params) {
            this.send(501, error);
            return callback();
        }

        // arguments are valid, apply them
        for (let [key, rawValue] of params) {
            let value: string | number | false = rawValue;
            switch (key) {
                // handled outside the switch
                case 'LOGIN':
                    loginValue = rawValue;
                    break;
                case 'ADDR':
                    if (value) {
                        this._server.logger.info(
                            {
                                tnx: 'xclient',
                                cid: this.id,
                                xclientKey: 'ADDR',
                                xclient: value,
                                user: (this.session.user && this.session.user.username) || this.session.user
                            },
                            'XCLIENT from %s through %s',
                            value,
                            this.remoteAddress
                        );

                        // store original value for reference as ADDR:DEFAULT
                        if (!this._xClient.has('ADDR:DEFAULT')) {
                            this._xClient.set('ADDR:DEFAULT', this.remoteAddress);
                        }

                        this.remoteAddress = value;
                        this.hostNameAppearsAs = false; // reset client provided hostname, require HELO/EHLO

                        // the session now belongs to the forwarded client, which must not
                        // inherit an identity the proxy authenticated as. A LOGIN attribute
                        // in the same command is applied after this
                        this.session.user = false;
                    }
                    break;
                case 'NAME':
                    value = value || '';
                    this._server.logger.info(
                        {
                            tnx: 'xclient',
                            cid: this.id,
                            xclientKey: 'NAME',
                            xclient: value,
                            user: (this.session.user && this.session.user.username) || this.session.user
                        },
                        'XCLIENT hostname resolved as "%s"',
                        value
                    );

                    // store original value for reference as NAME:DEFAULT
                    if (!this._xClient.has('NAME:DEFAULT')) {
                        this._xClient.set('NAME:DEFAULT', this.clientHostname || '');
                    }

                    this._setClientHostname(value);
                    break;
                case 'PORT':
                    value = Number(value) || '';
                    this._server.logger.info(
                        {
                            tnx: 'xclient',
                            cid: this.id,
                            xclientKey: 'PORT',
                            xclient: value,
                            user: (this.session.user && this.session.user.username) || this.session.user
                        },
                        'XCLIENT remote port resolved as "%s"',
                        value
                    );

                    // store original value for reference as NAME:DEFAULT
                    if (!this._xClient.has('PORT:DEFAULT')) {
                        this._xClient.set('PORT:DEFAULT', this.remotePort || '');
                    }

                    // NB! an unparseable value is stored as an empty string, as it always has been
                    this.remotePort = value as number;
                    break;
                default:
                // other values are not relevant
            }
            this._xClient.set(key, value);
        }

        let checkLogin = (done: () => void): void => {
            if (typeof loginValue !== 'string') {
                return done();
            }
            if (!loginValue) {
                // clear authentication session?
                this._server.logger.info(
                    {
                        tnx: 'deauth',
                        cid: this.id,
                        user: (this.session.user && this.session.user.username) || this.session.user
                    },
                    'User deauthenticated using %s',
                    'XCLIENT'
                );
                this.session.user = false;
                return done();
            }
            sasl.SASL_XCLIENT.call(this, [loginValue], err => {
                if (err) {
                    this.send(550, err.message);
                    this.close();
                    // the command is over even though the connection is going away,
                    // the parser must be released or it would never see the close
                    return callback();
                }
                return done();
            });
        };

        // Use [ADDR] if NAME was empty
        if (this.remoteAddress && !this.clientHostname) {
            this._setClientHostname('');
        }

        if (params.has('ADDR')) {
            this.emitConnection();
        }

        checkLogin(() => {
            // success, the session starts over with a new greeting. The session is
            // refreshed right away rather than at the EHLO that follows, so that the
            // handlers see the forwarded client whatever the client does next
            this._resetSession();
            this._sendGreeting();
            callback();
        });
    }

    /**
     * Processes XFORWARD data
     * http://www.postfix.org/XFORWARD_README.html
     */
    handler_XFORWARD(command: Buffer, callback: () => void): void {
        // check if user is authorized to perform this command
        if (!this._proxyCommandAllowed('XFORWARD', 'useXForward')) {
            this.send(550, 'Error: Not allowed', 'NOT_AUTHORIZED');
            return callback();
        }

        // not allowed to change properties if already processing mail
        if (this.session.envelope.mailFrom) {
            this.send(503, 'Error: Mail transaction in progress');
            return callback();
        }

        let allowedKeys = ['NAME', 'ADDR', 'PORT', 'PROTO', 'HELO', 'IDENT', 'SOURCE'];
        let parts = command.toString().trim().split(/\s+/);
        let hasAddr = false;
        parts.shift(); // remove XFORWARD prefix

        if (!parts.length) {
            this.send(501, 'Error: Bad command parameter syntax');
            return callback();
        }

        // parse and validate every argument before applying any of them, see handler_XCLIENT
        let { params, error } = parseProxyParameters(parts, allowedKeys, ['[UNAVAILABLE]']);
        if (!params) {
            this.send(501, error);
            return callback();
        }

        // arguments are valid, apply them
        for (let [key, rawValue] of params) {
            let value: string | number | false = rawValue;
            switch (key) {
                case 'ADDR':
                    if (value) {
                        this._server.logger.info(
                            {
                                tnx: 'xforward',
                                cid: this.id,
                                xforwardKey: 'ADDR',
                                xforward: value,
                                user: (this.session.user && this.session.user.username) || this.session.user
                            },
                            'XFORWARD from %s through %s',
                            value,
                            this.remoteAddress
                        );

                        // store original value for reference as ADDR:DEFAULT
                        if (!this._xForward.has('ADDR:DEFAULT')) {
                            this._xForward.set('ADDR:DEFAULT', this.remoteAddress);
                        }

                        hasAddr = true;
                        this.remoteAddress = value;
                    }
                    break;
                case 'NAME':
                    value = value || '';
                    this._server.logger.info(
                        {
                            tnx: 'xforward',
                            cid: this.id,
                            xforwardKey: 'NAME',
                            xforward: value,
                            user: (this.session.user && this.session.user.username) || this.session.user
                        },
                        'XFORWARD hostname resolved as "%s"',
                        value
                    );
                    this._setClientHostname(value);
                    break;
                case 'PORT':
                    value = Number(value) || 0;
                    this._server.logger.info(
                        {
                            tnx: 'xforward',
                            cid: this.id,
                            xforwardKey: 'PORT',
                            xforward: value,
                            user: (this.session.user && this.session.user.username) || this.session.user
                        },
                        'XFORWARD port resolved as "%s"',
                        value
                    );
                    this.remotePort = value;
                    break;
                case 'HELO':
                    value = (value || '').toString().toLowerCase();
                    this._server.logger.info(
                        {
                            tnx: 'xforward',
                            cid: this.id,
                            xforwardKey: 'HELO',
                            xforward: value,
                            user: (this.session.user && this.session.user.username) || this.session.user
                        },
                        'XFORWARD HELO name resolved as "%s"',
                        value
                    );
                    this.hostNameAppearsAs = value;
                    break;
                default:
                // other values are not relevant
            }
            this._xForward.set(key, value);
        }

        // XFORWARD is not followed by a new EHLO, so the forwarded details go into the
        // session right away, or the handlers of this transaction would still see the proxy
        this._resetSession();

        if (hasAddr) {
            this._canEmitConnection = true;
            this.emitConnection();
        }

        // success
        this.send(250, 'OK');
        callback();
    }

    /**
     * Upgrades connection to TLS if possible
     */
    handler_STARTTLS(command: Buffer, callback: () => void): void {
        // RFC 3207: the STARTTLS command does not take any parameters
        if (command.toString().trim().split(/\s+/).length > 1) {
            this.send(501, 'Error: syntax: STARTTLS');
            return callback();
        }

        if (this.secure) {
            this.send(503, 'Error: TLS already active');
            return callback();
        }

        this.send(220, 'Ready to start TLS');

        this.upgrade(callback);
    }

    /**
     * Check if selected authentication is available and delegate auth data to SASL
     */
    handler_AUTH(command: Buffer, callback: () => void): void {
        let args = command.toString().trim().split(/\s+/);
        let method: string;
        let handler: ((args: string[], callback: () => void) => void) | undefined;

        args.shift(); // remove AUTH
        method = (args.shift() || '').toString().toUpperCase(); // get METHOD and keep additional arguments in the array
        let mechanism = (sasl as unknown as Record<string, SASLMechanism | undefined>)['SASL_' + method];
        handler = typeof mechanism === 'function' ? mechanism.bind(this) : undefined;

        if (!this.secure && this._isSupported('STARTTLS') && !this._server.options.hideSTARTTLS && !this._server.options.allowInsecureAuth) {
            this.send(538, 'Error: Must issue a STARTTLS command first');
            return callback();
        }

        if (this.session.user) {
            this.send(503, 'Error: No identity changes permitted');
            return callback();
        }

        if (!this._server.options.authMethods.includes(method) || typeof handler !== 'function') {
            this.send(504, 'Error: Unrecognized authentication type');
            return callback();
        }

        handler(args, callback);
    }

    /**
     * Validates MAIL FROM parameters
     * @param parsed - Parsed address command with args
     * @returns Returns error object {code, message, enhancedCode} if validation fails, null if successful
     */
    _validateMailParams(parsed: ParsedAddress): ParamError | null {
        // the parameters that take a value have been checked to have one, see MAIL_VALUE_PARAMS
        const args: Record<string, any> = parsed.args || {};
        // Validate SIZE parameter (RFC 1870): size-value ::= 1*20DIGIT
        if (args.SIZE) {
            if (!/^\d{1,20}$/.test(args.SIZE)) {
                return {
                    code: 501,
                    message: 'Error: Bad message size syntax',
                    enhancedCode: null
                };
            }
            if (!this._server.options.hideSize && this._server.options.size && Number(args.SIZE) > this._server.options.size) {
                return {
                    code: 552,
                    message: 'Error: message exceeds fixed maximum message size ' + this._server.options.size,
                    enhancedCode: 'MESSAGE_TOO_BIG'
                };
            }
        }

        // Validate BODY parameter (RFC 6152 - 8BITMIME)
        // Note: BINARYMIME is not supported as it requires BDAT command (RFC 3030)
        if (args.BODY) {
            const bodyType = args.BODY.toLowerCase();
            if (bodyType !== '7bit' && bodyType !== '8bitmime') {
                return {
                    code: 501,
                    message: 'Invalid BODY parameter value. Must be 7BIT or 8BITMIME',
                    enhancedCode: null
                };
            }
        }

        // Validate SMTPUTF8 parameter (RFC 6531)
        if (args.SMTPUTF8 !== undefined) {
            if (args.SMTPUTF8 !== true) {
                return {
                    code: 501,
                    message: 'Invalid SMTPUTF8 parameter. This flag does not accept a value',
                    enhancedCode: null
                };
            }
        }

        // Validate REQUIRETLS parameter (RFC 8689)
        if (args.REQUIRETLS !== undefined) {
            if (!this.secure) {
                return {
                    code: 530,
                    message: 'REQUIRETLS not permitted on non-TLS connections',
                    enhancedCode: null
                };
            }
            if (args.REQUIRETLS !== true) {
                return {
                    code: 501,
                    message: 'Invalid REQUIRETLS parameter. This flag does not accept a value',
                    enhancedCode: null
                };
            }
        }

        // Validate DSN parameters if DSN is supported
        if (!this._server.options.hideDSN) {
            if (args.RET) {
                const ret = args.RET.toUpperCase();
                if (ret !== 'FULL' && ret !== 'HDRS') {
                    return {
                        code: 501,
                        message: 'Invalid RET parameter value. Must be FULL or HDRS',
                        enhancedCode: null
                    };
                }
            }
        }

        return null; // All validations passed
    }

    /**
     * Applies validated MAIL FROM parameters to session envelope
     * @param parsed - Parsed address command with args
     */
    _applyMailParams(parsed: ParsedAddress): void {
        const args: Record<string, any> = parsed.args || {};
        const envelope = this.session.envelope;
        // Apply BODY parameter
        if (args.BODY) {
            envelope.bodyType = args.BODY.toLowerCase();
        }

        // Apply SMTPUTF8 parameter
        if (args.SMTPUTF8 === true) {
            envelope.smtpUtf8 = true;
        }

        // Apply REQUIRETLS parameter
        if (args.REQUIRETLS === true) {
            envelope.requireTLS = true;
        }

        // Apply DSN parameters
        if (!this._server.options.hideDSN) {
            if (args.RET) {
                (envelope.dsn as SMTPServerEnvelopeDSN).ret = args.RET.toUpperCase();
            }
            if (args.ENVID) {
                (envelope.dsn as SMTPServerEnvelopeDSN).envid = args.ENVID;
            }
        }
    }

    /**
     * Processes MAIL FROM command, parses address and extra arguments
     */
    handler_MAIL(command: Buffer, callback: () => void): void {
        let parsed = this._parseAddressCommand('mail from', command);

        // in case we still haven't informed about the new connection emit it
        this.emitConnection();

        // sender address can be empty, so we only check if parsing failed or not
        if (!parsed) {
            this.send(501, 'Error: Bad sender address syntax', 'SENDER_SYNTAX_ERROR');
            return callback();
        }

        if (this._rejectInvalidParams(parsed, MAIL_VALUE_PARAMS, callback)) {
            return;
        }

        if (this.session.envelope.mailFrom) {
            this.send(503, 'Error: nested MAIL command');
            return callback();
        }

        // Validate all MAIL FROM parameters
        const validationError = this._validateMailParams(parsed);
        if (validationError) {
            this.send(validationError.code, validationError.message, validationError.enhancedCode || undefined);
            return callback();
        }

        // Apply validated parameters to session envelope before calling onMailFrom
        // so the handler can access them
        this._applyMailParams(parsed);

        this._server.onMailFrom(parsed, this.session, (err?: SMTPServerError | null) => {
            if (err) {
                this.send(err.responseCode || 550, err.message);
                return callback();
            }

            this.session.envelope.mailFrom = parsed;

            this.send(250, 'Accepted', 'MAIL_FROM_OK');
            callback();
        });
    }

    /**
     * Processes RCPT TO command, parses address and extra arguments
     */
    handler_RCPT(command: Buffer, callback: () => void): void {
        let parsed = this._parseAddressCommand('rcpt to', command);

        // recipient address can not be empty
        if (!parsed || !parsed.address) {
            this.send(501, 'Error: Bad recipient address syntax', 'MAILBOX_SYNTAX_ERROR');
            return callback();
        }

        if (this._rejectInvalidParams(parsed, RCPT_VALUE_PARAMS, callback)) {
            return;
        }

        if (!this.session.envelope.mailFrom) {
            this.send(503, 'Error: need MAIL command');
            return callback();
        }

        // the parameters that take a value have been checked to have one, see RCPT_VALUE_PARAMS
        const args: Record<string, any> = parsed.args || {};

        // Process DSN parameters if DSN is supported
        if (!this._server.options.hideDSN) {
            // Validate NOTIFY parameter
            if (args.NOTIFY) {
                const notify = args.NOTIFY.toUpperCase();
                const validNotifyValues = ['NEVER', 'SUCCESS', 'FAILURE', 'DELAY'];
                const notifyValues: string[] = notify.split(',');

                for (let value of notifyValues) {
                    if (!validNotifyValues.includes(value)) {
                        this.send(501, 'Error: NOTIFY parameter must be NEVER, SUCCESS, FAILURE, or DELAY');
                        return callback();
                    }
                }

                // NEVER cannot be combined with other values
                if (notifyValues.includes('NEVER') && notifyValues.length > 1) {
                    this.send(501, 'Error: NOTIFY=NEVER cannot be combined with other values');
                    return callback();
                }

                parsed.dsn = parsed.dsn || {};
                parsed.dsn.notify = notifyValues;
            }

            // RFC 3461 section 4.2: ORCPT=addr-type;xtext
            if (args.ORCPT && !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+;./i.test(args.ORCPT)) {
                this.send(501, 'Error: Bad ORCPT parameter syntax');
                return callback();
            }

            // Store ORCPT parameter
            if (args.ORCPT) {
                parsed.dsn = parsed.dsn || {};
                parsed.dsn.orcpt = args.ORCPT;
            }
        }

        // addresses are compared case-insensitively, a repeated one replaces the earlier entry
        let addressKey = parsed.address.toLowerCase();

        let maxRecipients = Number(this._server.options.maxRecipients) || 0;
        if (maxRecipients && this.session.envelope.rcptTo.length >= maxRecipients && !this._rcptIndex.has(addressKey)) {
            this.send(452, 'Error: too many recipients', 'TOO_MANY_RECIPIENTS');
            return callback();
        }

        this._server.onRcptTo(parsed, this.session, (err?: SMTPServerError | null) => {
            if (err) {
                this.send(err.responseCode || 550, err.message);
                return callback();
            }

            let rcptTo = this.session.envelope.rcptTo;

            // The index makes this a constant time lookup instead of a scan of every
            // recipient so far, which let a long recipient list burn the event loop. The
            // entry is checked against the list itself in case a handler edited the list
            let index = this._rcptIndex.get(addressKey);
            if (index !== undefined && !(rcptTo[index] && rcptTo[index].address.toLowerCase() === addressKey)) {
                index = rcptTo.findIndex(rcpt => rcpt.address.toLowerCase() === addressKey);
            }

            if (index !== undefined && index >= 0) {
                rcptTo[index] = parsed;
            } else {
                rcptTo.push(parsed);
                this._rcptIndex.set(addressKey, rcptTo.length - 1);
            }

            this.send(250, 'Accepted', 'RCPT_TO_OK');
            callback();
        });
    }

    /**
     * Processes DATA by forwarding incoming stream to the onData handler
     */
    handler_DATA(command: Buffer, callback: () => void): void {
        if (!this.session.envelope.rcptTo.length) {
            this.send(503, 'Error: need RCPT command');
            return callback();
        }

        if (!this._parser) {
            return callback();
        }

        const parser = this._parser;
        this._dataStream = parser.startDataMode(this._server.options.size);

        let close = (err?: SMTPServerError | null, message?: string | SMTPServerDataResult[]): void => {
            let i: number, len: number;

            this._server.logger.debug(
                {
                    tnx: 'data',
                    cid: this.id,
                    bytes: parser.dataBytes,
                    user: (this.session.user && this.session.user.username) || this.session.user
                },
                'C: <%s bytes of DATA>',
                parser.dataBytes
            );

            if (typeof this._dataStream === 'object' && this._dataStream && this._dataStream.readable) {
                this._dataStream.removeAllListeners();
            }

            if (err) {
                if (this._server.options.lmtp) {
                    // separate error response for every recipient when using LMTP
                    for (i = 0, len = this.session.envelope.rcptTo.length; i < len; i++) {
                        this.send(err.responseCode || 450, err.message);
                    }
                } else {
                    // single error response when using SMTP
                    this.send(err.responseCode || 450, err.message);
                }
            } else if (Array.isArray(message)) {
                // separate responses for every recipient when using LMTP
                message.forEach(response => {
                    if (/Error\]$/i.test(Object.prototype.toString.call(response))) {
                        let error = response as SMTPServerError;
                        this.send(error.responseCode || 450, error.message);
                    } else {
                        this.send(250, typeof response === 'string' ? response : 'OK: message accepted', 'DATA_OK');
                    }
                });
            } else if (this._server.options.lmtp) {
                // separate success response for every recipient when using LMTP
                for (i = 0, len = this.session.envelope.rcptTo.length; i < len; i++) {
                    this.send(250, typeof message === 'string' ? message : 'OK: message accepted', 'DATA_OK');
                }
            } else {
                // single success response when using SMTP
                this.send(250, typeof message === 'string' ? message : 'OK: message queued', 'DATA_OK');
            }

            this._transactionCounter++;

            this._unrecognizedCommands = 0; // reset unrecognized commands counter
            this._resetSession(); // reset session state

            if (typeof this._parser === 'object' && this._parser) {
                this._parser.continue();
            }
        };

        this._server.onData(this._dataStream, this.session, (err?: SMTPServerError | null, message?: string | SMTPServerDataResult[]) => {
            // ensure _dataStream is an object and not set to null by premature closing
            // do not continue until the stream has actually ended
            if (typeof this._dataStream === 'object' && this._dataStream && this._dataStream.readable) {
                this._dataStream.on('end', () => close(err, message));
                return;
            }
            close(err, message);
        });

        this.send(354, 'End data with <CR><LF>.<CR><LF>');
        callback();
    }

    // Dummy handlers for some old sendmail specific commands

    /**
     * Processes sendmail WIZ command, upgrades to "wizard mode"
     */
    handler_WIZ(command: Buffer, callback: () => void): void {
        let args = command.toString().trim().split(/\s+/);
        let password;

        args.shift(); // remove WIZ
        password = (args.shift() || '').toString();

        // require password argument
        if (!password) {
            this.send(500, 'You are no wizard!');
            return callback();
        }

        // all passwords pass validation, so everyone is a wizard!
        this.session.isWizard = true;
        this.send(200, 'Please pass, oh mighty wizard');
        callback();
    }

    /**
     * Processes sendmail SHELL command, should return interactive shell but this is a dummy function
     * so no actual shell is provided to the client
     */
    handler_SHELL(command: Buffer, callback: () => void): void {
        this._server.logger.info(
            {
                tnx: 'shell',
                cid: this.id,
                user: (this.session.user && this.session.user.username) || this.session.user
            },
            'Client tried to invoke SHELL'
        );

        if (!this.session.isWizard) {
            this.send(500, 'Mere mortals must not mutter that mantra');
            return callback();
        }

        this.send(500, 'Error: Invoking shell is not allowed. This incident will be reported.');
        callback();
    }

    /**
     * Processes sendmail KILL command
     */
    handler_KILL(command: Buffer, callback: () => void): void {
        this._server.logger.info(
            {
                tnx: 'kill',
                cid: this.id,
                user: (this.session.user && this.session.user.username) || this.session.user
            },
            'Client tried to invoke KILL'
        );

        this.send(500, 'Can not kill Mom');
        callback();
    }

    upgrade(callback: () => void, secureCallback?: () => void): void {
        this._socket.unpipe(this._parser as SMTPStream);

        // Whatever the parser still holds (the rest of the chunk it is working on, the
        // chunks queued behind it, a partial line) arrived in plaintext after the
        // STARTTLS command. Dropping it while _upgrading is set is not enough: the parser
        // yields to the event loop every hundred pipelined lines, and if the handshake
        // completed during such a yield, the lines still queued would run inside the TLS
        // session ahead of the client's own commands (STARTTLS command injection). So the
        // parser is retired: closed, it drains what it holds without dispatching anything,
        // and the TLS session gets a new one that only ever sees bytes from the TLS socket
        (this._parser as SMTPStream).isClosed = true;
        this._parser = this._createParser();

        this._upgrading = true;
        setImmediate(callback); // resume, and so drain, the retired parser

        let secureSocket: tls.TLSSocket | undefined;

        let onError = (rawErr?: TLSError | null): void => {
            let err = rawErr;
            const meta: TLSErrorMeta = {};
            if (secureSocket) {
                meta.tlsProtocol = secureSocket.getProtocol();
            }
            meta.protocol = 'smtp';
            meta.stage = 'connect';

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

            // Node tears the socket down itself after a failed handshake, Bun does not,
            // and a connection whose upgrade failed has nothing left to do. The raw socket
            // goes with it, as on the implicit TLS path, so the listening server sees it leave
            if (secureSocket && !secureSocket.destroyed) {
                secureSocket.destroy();
            }
            if (this._socket !== secureSocket && !this._socket.destroyed) {
                this._socket.destroy();
            }

            this._onError(err);
        };

        let secureContext = this._server.secureContext.get('*');
        let socketOptions: tls.TLSSocketOptions = {
            secureContext,
            isServer: true,
            server: this._server.server,

            SNICallback: (servername, cb) => this._server._resolveSNI(servername, cb)
        };

        // Apply additional socket options if these are set in the server options
        copyTLSSocketOptions(this._server.options, socketOptions);

        // remove all listeners from the original socket besides the error handler
        this._socket.removeAllListeners();
        this._socket.on('error', err => this._onError(err));

        // upgrade connection
        const tlsSocket = new tls.TLSSocket(this._socket, socketOptions);
        secureSocket = tlsSocket;

        tlsSocket.once('close', (hadError: boolean) => this._onCloseEvent(hadError));
        tlsSocket.once('error', (err: TLSError) => onError(err));
        tlsSocket.once('_tlsError', (err: TLSError) => onError(err));
        tlsSocket.once('clientError', (err: TLSError) => onError(err));

        tlsSocket.setTimeout(socketTimeout(this._server.options), () => this._onTimeout());

        // NB! once() and not on(): a TLS 1.2 client can renegotiate at any time, which
        // makes the socket emit 'secure' again. Re-running this would pipe the socket
        // into the parser a second time (every later command dispatched twice) and
        // would wipe the session state in the middle of an established session
        tlsSocket.once('secure', () => {
            if (!this._parser) {
                // the connection was closed while the handshake was running
                return;
            }

            // a client certificate was asked for and did not pass, refuse the session
            let verifyError = verifyPeerCertificate(tlsSocket, socketOptions);
            if (verifyError) {
                tlsSocket.destroy(verifyError);
                return;
            }

            this.session.secure = this.secure = true;
            this._socket = tlsSocket;
            this._upgrading = false;

            // RFC 3207 section 4.2: once the TLS handshake completes, the server
            // must discard any knowledge obtained from the client before STARTTLS.
            // Clear the authenticated identity, the HELO/EHLO identity and any
            // in-progress mail transaction so that plaintext-established state can
            // not be reused under the protection (and trust) of the TLS session
            this.session.user = false;
            this.hostNameAppearsAs = false;
            this.openingCommand = false;
            this._resetSession();

            this.session.tlsOptions = this.tlsOptions = tlsSocket.getCipher();
            this.session.servername = tlsSocket.servername;
            let cipher = this.session.tlsOptions && this.session.tlsOptions.name;
            this._server.logger.info(
                {
                    tnx: 'starttls',
                    cid: this.id,
                    user: (this.session.user && this.session.user.username) || this.session.user,
                    cipher
                },
                'Connection upgraded to TLS using',
                cipher || 'N/A'
            );
            this._server.onSecure(this._socket, this.session, (err?: Error | null) => {
                if (!this._parser) {
                    // the client went away while the onSecure handler was running
                    return;
                }
                if (err) {
                    return this._onError(err);
                }
                this._socket.pipe(this._parser);
                if (typeof secureCallback === 'function') {
                    secureCallback();
                }
            });
        });
    }
}
