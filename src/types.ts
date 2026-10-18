import type net from 'node:net';
import type { PassThrough } from 'node:stream';
import type tls from 'node:tls';
import type { ExternalLogger } from 'nodemailer/lib/shared';

// Public data shapes of smtp-server. These replace the community maintained
// @types/smtp-server declarations, so the names and the shapes those use are kept:
// code written against them must keep compiling. Every optional property carries an
// explicit `| undefined` for consumers that compile with exactOptionalPropertyTypes.

/** Milliseconds */
export type ms = number;

/**
 * An error passed to one of the handler callbacks. `responseCode` sets the SMTP reply
 * code the client gets, the default depends on the command
 */
export interface SMTPServerError extends Error {
    responseCode?: number | undefined;
}

/** Parameters of a MAIL FROM or RCPT TO command, keys are upper case. A keyword without a value is `true` */
export type SMTPServerAddressArgs = Record<string, string | true>;

/** DSN parameters of a RCPT TO command (RFC 3461), set only when the DSN extension is enabled */
export interface SMTPServerRecipientDSN {
    /** NOTIFY values, upper case */
    notify?: string[] | undefined;
    /** ORCPT value as received */
    orcpt?: string | undefined;
}

export interface SMTPServerAddress {
    /**
     * the address provided with the MAIL FROM or RCPT TO command, an empty string for the null sender
     */
    address: string;
    /**
     * an object with additional arguments (all key names are uppercase), false if the command had none
     */
    args: SMTPServerAddressArgs | false;
    /**
     * DSN parameters of a recipient (RCPT TO only)
     */
    dsn?: SMTPServerRecipientDSN | undefined;
}

export type SMTPServerAuthenticationMethod = 'PLAIN' | 'LOGIN' | 'XOAUTH2' | 'CRAM-MD5' | 'XCLIENT';

export interface SMTPServerAuthentication {
    /**
     * indicates the authentication method used, 'PLAIN', 'LOGIN', 'XOAUTH2', 'CRAM-MD5' or
     * 'XCLIENT' (the LOGIN attribute of an XCLIENT command)
     */
    method: SMTPServerAuthenticationMethod;
    /**
     * the username of the user
     */
    username?: string | undefined;
    /**
     * the password if LOGIN or PLAIN was used (null for XCLIENT)
     */
    password?: string | null | undefined;
    /**
     * PLAIN only: the authentication identity of the token (RFC 4616)
     */
    authcid?: string | undefined;
    /**
     * PLAIN only: the authorization identity of the token (RFC 4616)
     */
    authzid?: string | undefined;
    /**
     * the OAuth2 bearer access token if 'XOAUTH2' was used as the authentication method
     */
    accessToken?: string | undefined;
    /**
     * CRAM-MD5 only: the challenge sent to the client
     */
    challenge?: string | undefined;
    /**
     * CRAM-MD5 only: the response of the client to the challenge
     */
    challengeResponse?: string | undefined;
    /**
     * a function for validating CRAM-MD5 challenge responses.
     * Takes the password of the user as an argument and returns true if the response matches the password
     */
    validatePassword(password: string): boolean;
}

export interface SMTPServerAuthenticationResponse {
    /**
     * can be any value - if this is set then the user is considered logged in
     * and this value is used later with the session data to identify the user.
     * If this value is empty, then the authentication is considered failed
     */
    user?: any;
    /**
     * an object to return if XOAUTH2 authentication failed (do not set the error object in this case).
     * This value is serialized to JSON and base64 encoded automatically, so you can just return the object
     */
    data?: object | undefined;
    /**
     * reply text when the authentication failed
     */
    message?: string | undefined;
    /**
     * reply code when the authentication failed
     */
    responseCode?: number | undefined;
}

/** DSN parameters of a MAIL FROM command (RFC 3461), set only when the DSN extension is enabled */
export interface SMTPServerEnvelopeDSN {
    /** RET parameter, FULL or HDRS */
    ret: string | null;
    /** ENVID parameter */
    envid: string | null;
}

export interface SMTPServerEnvelope {
    /**
     * includes an address object or is set to false
     */
    mailFrom: SMTPServerAddress | false;
    /**
     * includes an array of address objects
     */
    rcptTo: SMTPServerAddress[];
    /**
     * RFC 8689: the client requires TLS for the entire delivery chain
     */
    requireTLS?: boolean | undefined;
    /**
     * RFC 6152: message body type, '7bit' or '8bitmime'
     */
    bodyType?: string | undefined;
    /**
     * RFC 6531: the client asked for SMTPUTF8
     */
    smtpUtf8?: boolean | undefined;
    /**
     * DSN parameters, present only when the DSN extension is enabled (hideDSN: false)
     */
    dsn?: SMTPServerEnvelopeDSN | undefined;
}

export interface SMTPServerSession {
    /**
     * random string identificator generated when the client connected
     */
    id: string;
    /**
     * local IP address for the connected client
     */
    localAddress: string;
    /**
     * local port number for the connected client
     */
    localPort: number;
    /**
     * remote IP address for the connected client
     */
    remoteAddress: string;
    /**
     * remote port number for the connected client
     */
    remotePort: number;
    /**
     * reverse resolved hostname for remoteAddress, or the address as an [ip] literal
     */
    clientHostname: string;
    /**
     * the opening SMTP command (HELO/EHLO/LHLO). false until the client has sent one,
     * typed as a string for compatibility with the earlier type declarations
     */
    openingCommand: string;
    /**
     * hostname the client provided with HELO/EHLO call. false until the client has sent
     * one, typed as a string for compatibility with the earlier type declarations
     */
    hostNameAppearsAs: string;
    /**
     * Envelope Object
     */
    envelope: SMTPServerEnvelope;
    /**
     *  If true, then the connection is using TLS
     */
    secure: boolean;
    /**
     * the protocol for a Received header, eg. ESMTPSA
     */
    transmissionType: string;
    /**
     * cipher of the TLS connection, false for a cleartext one
     */
    tlsOptions: tls.CipherNameAndProtocol | false;
    /**
     * the server name the client asked for with SNI
     */
    servername?: string | false | null | undefined;
    /**
     * Optional parameter that is added to the session object if provided to the onAuth callback
     */
    user?: any;
    /**
     * values from XCLIENT, keys are upper case
     */
    xClient: Map<string, string | number | false>;
    /**
     * values from XFORWARD, keys are upper case
     */
    xForward: Map<string, string | number | false>;
    /**
     * ordinal number of the current mail transaction of the connection
     */
    transaction: number;
    /**
     * the last error reply sent to the client
     */
    error?: string | undefined;
    /**
     * true after the sendmail WIZ command
     */
    isWizard?: boolean | undefined;
}

export interface SMTPServerDataStream extends PassThrough {
    /**
     * number of bytes read from DATA stream
     */
    byteLength: number;
    /**
     * boolean, if set to true, the message was oversized.
     * When creating the server you can define maximum allowed message size with
     * the size option, see RFC1870 for details.
     */
    sizeExceeded: boolean;
}

/** Connection details emitted with the 'connect' event of the server */
export interface SMTPServerConnectionInfo {
    id: string;
    localAddress: string;
    localPort: number;
    remoteAddress: string;
    remotePort: number;
    hostNameAppearsAs: string | false;
    clientHostname: string | false;
}

/** A custom reverse DNS resolver, see the `resolver` option */
export interface SMTPServerResolver {
    reverse(ip: string, callback: (err: Error | null, hostnames?: string[]) => void): void;
}

/** Error passed to the onData callback, or one entry of the per-recipient LMTP result array */
export type SMTPServerDataResult = string | Error;

export interface SMTPServerOptions extends tls.TlsOptions, net.ServerOpts {
    /**
     * if true, the connection will use TLS. The default is false.
     * If the server doesn't start in TLS mode,
     * it is still possible to upgrade clear text socket to
     * TLS socket with the STARTTLS command (unless you disable support for it).
     * If secure is true, additional tls options for tls.
     * createServer can be added directly onto this options object.
     */
    secure?: boolean | undefined;
    /** indicate an TLS server where TLS is handled upstream */
    secured?: boolean | undefined;
    /**
     * optional hostname of the server,
     * used for identifying to the client (defaults to os.hostname())
     */
    name?: string | undefined;
    /**
     * optional greeting message.
     * This message is appended to the default ESMTP response.
     */
    banner?: string | undefined;
    /**
     * optional format of the HELO/EHLO greeting line, the first %s is the server name and
     * the second one the client hostname
     */
    heloResponse?: string | undefined;
    /**
     * optional maximum allowed message size in bytes
     * ([see details](https://nodemailer.com/extras/smtp-server#using-the-size-extension))
     */
    size?: number | undefined;
    /**
     * Hide the SIZE limit from clients but still track `stream.sizeExceeded`
     */
    hideSize?: boolean | undefined;
    /**
     * optional array of allowed authentication methods, defaults to ['PLAIN', 'LOGIN'].
     * Only the methods listed in this array are allowed,
     * so if you set it to ['XOAUTH2'] then PLAIN and LOGIN are not available.
     * Use ['PLAIN', 'LOGIN', 'XOAUTH2'] to allow all three.
     * Authentication is only allowed in secure mode
     * (either the server is started with secure: true option or STARTTLS command is used)
     */
    authMethods?: string[] | undefined;
    /**
     * allow authentication, but do not require it
     */
    authOptional?: boolean | undefined;
    /**
     * reply text for MAIL, RCPT and DATA when authentication is required
     */
    authRequiredMessage?: string | undefined;
    /**
     * optional array of disabled commands (see all supported commands here).
     * For example if you want to disable authentication,
     * use ['AUTH'] as this value.
     * If you want to allow authentication in clear text, set it to ['STARTTLS'].
     */
    disabledCommands?: string[] | undefined;
    /**
     * optional boolean, if set to true then allow using STARTTLS
     * but do not advertise or require it. It only makes sense
     * when creating integration test servers for testing the scenario
     * where you want to try STARTTLS even when it is not advertised
     */
    hideSTARTTLS?: boolean | undefined;
    /**
     * optional boolean, if set to true then does not show PIPELINING in feature list
     */
    hidePIPELINING?: boolean | undefined;
    /**
     * optional boolean, if set to true then does not show 8BITMIME in features list
     */
    hide8BITMIME?: boolean | undefined;
    /**
     * optional boolean, if set to true then does not show SMTPUTF8 in features list
     */
    hideSMTPUTF8?: boolean | undefined;
    /**
     * Enable or disable the ENHANCEDSTATUSCODES capability in EHLO response.
     * Enhanced status codes are disabled by default.
     */
    hideENHANCEDSTATUSCODES?: boolean | undefined;
    /**
     * optional boolean, if set to true then does not show DSN in features list, by default DSN is disabled
     */
    hideDSN?: boolean | undefined;
    /**
     * optional boolean, if set to true then does not show REQUIRETLS in features list, by default REQUIRETLS is disabled
     */
    hideREQUIRETLS?: boolean | undefined;
    /**
     * optional boolean, if set to true allows authentication even if connection is not secured first
     */
    allowInsecureAuth?: boolean | undefined;
    /**
     * optional boolean, if set to true then does not try to reverse resolve client hostname
     */
    disableReverseLookup?: boolean | undefined;
    /**
     * optional custom DNS resolver for the reverse lookup of the client address
     */
    resolver?: SMTPServerResolver | undefined;
    /**
     * optional Map or an object of TLS options for SNI where servername is the key. Overrided by SNICallback.
     */
    sniOptions?: { [servername: string]: tls.TlsOptions } | Map<string, tls.TlsOptions> | undefined;
    /**
     * optional boolean, if set to true then upgrade sockets to TLS immediately after connection is established. Works with secure: true
     */
    needsUpgrade?: boolean | undefined;
    /**
     * optional bunyan compatible logger instance.
     * If set to true then logs to console.
     * If value is not set or is false then nothing is logged
     */
    logger?: ExternalLogger | boolean | undefined;
    /**
     * component name for the log entries, defaults to 'smtp-server'
     */
    component?: string | undefined;
    /**
     * sets the maximum number of concurrently connected clients, defaults to Infinity
     */
    maxClients?: number | undefined;
    /**
     * if set to true expects to be behind a proxy that emits a
     * [PROXY](http://www.haproxy.org/download/1.5/doc/proxy-protocol.txt) header (version 1 only),
     * an array lists the proxy addresses the header is expected from
     */
    useProxy?: boolean | string[] | undefined;
    /**
     * client addresses that are not logged (eg. the address of a load balancer health check)
     */
    ignoredHosts?: string[] | undefined;
    /**
     * if set to true, enables usage of
     * [XCLIENT](http://www.postfix.org/XCLIENT_README.html) extension to override connection properties,
     * an array lists the client addresses allowed to use it.
     * See session.xClient (Map object) for the details provided by the client
     */
    useXClient?: boolean | string[] | undefined;
    /**
     * if set to true, enables usage of [XFORWARD](http://www.postfix.org/XFORWARD_README.html) extension,
     * an array lists the client addresses allowed to use it.
     * See session.xForward (Map object) for the details provided by the client
     */
    useXForward?: boolean | string[] | undefined;
    /**
     * if set to true use LMTP protocol instead of SMTP
     */
    lmtp?: boolean | undefined;
    /**
     * How many milliseconds of inactivity to allow before disconnecting the client (defaults to 1 minute)
     */
    socketTimeout?: ms | undefined;
    /**
     * How many millisceonds to wait before disconnecting pending
     * connections once `server.close()` has been called (defaults to 30 seconds)
     */
    closeTimeout?: ms | undefined;
    /**
     * How many commands an unauthenticated client may send before it is disconnected
     * (defaults to 10), false for no limit
     */
    maxAllowedUnauthenticatedCommands?: number | false | undefined;
    /**
     * maximum length of a command line in bytes (defaults to 16 KB)
     */
    maxCommandLength?: number | undefined;
    /**
     * maximum number of recipients of a mail transaction, no limit by default
     */
    maxRecipients?: number | undefined;
    /**
     * if true, MAIL FROM and RCPT TO addresses get only a minimal syntax check
     */
    lenientAddressParsing?: boolean | undefined;
    /**
     * The callback to handle authentications ([see details](https://nodemailer.com/extras/smtp-server#handling-authentication-onauth))
     */
    onAuth?(
        auth: SMTPServerAuthentication,
        session: SMTPServerSession,
        callback: (err: Error | null | undefined, response?: SMTPServerAuthenticationResponse) => void
    ): void;
    /**
     * The callback to handle the client connection. ([see details](https://nodemailer.com/extras/smtp-server#validating-client-connection-onconnect--onclose))
     */
    onConnect?(session: SMTPServerSession, callback: (err?: Error | null) => void): void;
    /**
     * [see details](https://nodemailer.com/extras/smtp-server#validating-tls-information-onsecure)
     */
    onSecure?(socket: net.Socket | tls.TLSSocket, session: SMTPServerSession, callback: (err?: Error | null) => void): void;
    /**
     * the callback to validate MAIL FROM commands ([see details](https://nodemailer.com/extras/smtp-server#validating-sender-onmailfrom))
     */
    onMailFrom?(address: SMTPServerAddress, session: SMTPServerSession, callback: (err?: Error | null) => void): void;
    /**
     * The callback to validate RCPT TO commands ([see details](https://nodemailer.com/extras/smtp-server#validating-recipients-onrcptto))
     */
    onRcptTo?(address: SMTPServerAddress, session: SMTPServerSession, callback: (err?: Error | null) => void): void;
    /**
     * the callback to handle incoming messages ([see details](https://nodemailer.com/extras/smtp-server#processing-incoming-messages-ondata)).
     * An LMTP server can pass an array with one result per recipient as the second argument
     */
    onData?(stream: SMTPServerDataStream, session: SMTPServerSession, callback: (err?: Error | null, message?: string | SMTPServerDataResult[]) => void): void;
    /**
     * the callback that informs about closed client connection. The callback argument is
     * a no-op, there is nothing to wait for
     */
    onClose?(session: SMTPServerSession, callback: (err?: Error | null) => void): void;
}

/** Events of SMTPServer */
export interface SMTPServerEvents {
    /** the server stopped listening */
    close: [];
    /** a connection or the listener failed */
    error: [err: Error];
    /** a client connected, emitted once the client is known (after XCLIENT/XFORWARD when those are enabled) */
    connect: [info: SMTPServerConnectionInfo];
}
