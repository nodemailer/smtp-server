'use strict';

const SMTPStream = require('./smtp-stream').SMTPStream;
const dns = require('dns');
const tls = require('tls');
const net = require('net');
const ipv6normalize = require('ipv6-normalize');
const sasl = require('./sasl');
const crypto = require('crypto');
const os = require('os');
const punycode = require('punycode');
const EventEmitter = require('events');
const base32 = require('base32.js');

const SOCKET_TIMEOUT = 60 * 1000;

/**
 * Creates a handler for new socket
 *
 * @constructor
 * @param {Object} server Server instance
 * @param {Object} socket Socket instance
 */
class SMTPConnection extends EventEmitter {
    constructor(server, socket, options) {
        super();

        options = options || {};
        // Random session ID, used for logging
        this.id = options.id || base32.encode(crypto.randomBytes(10)).toLowerCase();

        this.ignore = options.ignore;

        this._server = server;
        this._socket = socket;

        // session data (envelope, user etc.)
        this.session = this.session = {
            id: this.id
        };

        // how many messages have been processed
        this._transactionCounter = 0;

        // Do not allow input from client until initial greeting has been sent
        this._ready = false;

        // If true then the connection is currently being upgraded to TLS
        this._upgrading = false;

        // Set handler for incoming command and handler bypass detection by command name
        this._nextHandler = false;

        // Parser instance for the incoming stream
        this._parser = new SMTPStream();

        // Set handler for incoming commands
        this._parser.oncommand = (...args) => this._onCommand(...args);

        // if currently in data mode, this stream gets the content of incoming message
        this._dataStream = false;

        // If true, then the connection is using TLS
        this.session.secure = this.secure = !!this._server.options.secure;

        this.needsUpgrade = !!this._server.options.needsUpgrade;

        this.tlsOptions = this.secure && !this.needsUpgrade && this._socket.getCipher ? this._socket.getCipher() : false;

        // Store local and remote addresses for later usage
        this.localAddress = (options.localAddress || this._socket.localAddress || '').replace(/^::ffff:/, '');
        this.localPort = Number(options.localPort || this._socket.localPort) || 0;
        this.remoteAddress = (options.remoteAddress || this._socket.remoteAddress || '').replace(/^::ffff:/, '');
        this.remotePort = Number(options.remotePort || this._socket.remotePort) || 0;

        // normalize IPv6 addresses
        if (this.localAddress && net.isIPv6(this.localAddress)) {
            this.localAddress = ipv6normalize(this.localAddress);
        }
        if (this.remoteAddress && net.isIPv6(this.remoteAddress)) {
            this.remoteAddress = ipv6normalize(this.remoteAddress);
        }

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
    init() {
        // Setup event handlers for the socket
        this._setListeners(() => {
            // Check that connection limit is not exceeded
            if (this._server.options.maxClients && this._server.connections.size > this._server.options.maxClients) {
                return this.send(421, this.name + ' Too many connected clients, try again in a moment');
            }

            // Keep a small delay for detecting early talkers
            setTimeout(() => this.connectionReady(), 100);
        });
    }

    connectionReady(next) {
        // Resolve hostname for the remote IP
        let reverseCb = (err, hostnames) => {
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

            this.clientHostname = (hostnames && hostnames.shift()) || '[' + this.remoteAddress + ']';

            this._resetSession();

            this._server.onConnect(this.session, err => {
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
                    this.send(err.responseCode || 554, err.message);
                    return this.close();
                }

                this._ready = true; // Start accepting data from input

                if (!this._server.options.useXClient && !this._server.options.useXForward) {
                    this.emitConnection();
                }

                this.send(
                    220,
                    this.name + ' ' + (this._server.options.lmtp ? 'LMTP' : 'ESMTP') + (this._server.options.banner ? ' ' + this._server.options.banner : '')
                );

                if (typeof next === 'function') {
                    next();
                }
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
        try {
            // dns.reverse throws on invalid input, see https://github.com/nodejs/node/issues/3112
            dns.reverse(this.remoteAddress.toString(), (...args) => {
                clearTimeout(reverseTimer);
                if (greetingSent) {
                    return;
                }
                greetingSent = true;
                reverseCb(...args);
            });
        } catch (E) {
            clearTimeout(reverseTimer);
            if (greetingSent) {
                return;
            }
            greetingSent = true;
            reverseCb(E);
        }
    }

    /**
     * Send data to socket
     *
     * @param {Number} code Response code
     * @param {String|Array} data If data is Array, send a multi-line response
     */
    send(code, data) {
        let payload;

        if (Array.isArray(data)) {
            payload = data.map((line, i, arr) => code + (i < arr.length - 1 ? '-' : ' ') + line).join('\r\n');
        } else {
            payload = []
                .concat(code || [])
                .concat(data || [])
                .join(' ');
        }

        if (code >= 400) {
            this.session.error = payload;
        }

        // Ref. https://datatracker.ietf.org/doc/html/rfc4954#section-4
        if (code === 334 && payload === '334') {
            payload += ' ';
        }

        if (this._socket && !this._socket.destroyed && this._socket.readyState === 'open') {
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
            this.close();
        }
    }

    /**
     * Close socket
     */
    close() {
        if (!this._socket.destroyed && this._socket.writable) {
            this._socket.end();
        }

        this._server.connections.delete(this);

        this._closing = true;
    }

    // PRIVATE METHODS

    /**
     * Setup socket event handlers
     */
    _setListeners(callback) {
        this._socket.on('close', hadError => this._onCloseEvent(hadError));
        this._socket.on('error', err => this._onError(err));
        this._socket.setTimeout(this._server.options.socketTimeout || SOCKET_TIMEOUT, () => this._onTimeout());
        this._socket.pipe(this._parser);
        if (!this.needsUpgrade) {
            return callback();
        }
        this.upgrade(() => false, callback);
    }

    _onCloseEvent(hadError) {
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
    _onClose(/* hadError */) {
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
        setImmediate(() => this._server.onClose(this.session));
    }

    /**
     * Fired when an error occurs with the socket
     *
     * @event
     * @param {Error} err Error object
     */
    _onError(err) {
        err.remote = this.remoteAddress;
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
    _onTimeout() {
        this.send(421, 'Timeout - closing connection');
    }

    /**
     * Checks if a selected command is available and ivokes it
     *
     * @param {Buffer} command Single line of data from the client
     * @param {Function} callback Callback to run once the command is processed
     */
    _onCommand(command, callback) {
        let commandName = (command || '').toString().split(' ').shift().toUpperCase();
        this._server.logger.debug(
            {
                tnx: 'command',
                cid: this.id,
                command: commandName,
                user: (this.session.user && this.session.user.username) || this.session.user
            },
            'C:',
            (command || '').toString()
        );

        let handler;

        if (!this._ready) {
            // block spammers that send payloads before server greeting
            return this.send(421, this.name + ' You talk too soon');
        }

        // block malicious web pages that try to make SMTP calls from an AJAX request
        if (/^(OPTIONS|GET|HEAD|POST|PUT|DELETE|TRACE|CONNECT) \/.* HTTP\/\d\.\d$/i.test(command)) {
            return this.send(421, 'HTTP requests not allowed');
        }

        callback = callback || (() => false);

        if (this._upgrading) {
            // ignore any commands before TLS upgrade is finished
            return callback();
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
                        this.send(500, 'Error: ' + commandName + ' not allowed in LMTP server');
                        return setImmediate(callback);
                    case 'LHLO':
                        commandName = 'EHLO';
                        break;
                }
            }
            if (this._isSupported(commandName)) {
                handler = this['handler_' + commandName];
            }
        }

        if (!handler) {
            // if the user makes more
            this._unrecognizedCommands++;
            if (this._unrecognizedCommands >= 10) {
                return this.send(421, 'Error: too many unrecognized commands');
            }

            this.send(500, 'Error: command not recognized');
            return setImmediate(callback);
        }

        // block users that try to fiddle around without logging in
        if (!this.session.user && this._isSupported('AUTH') && commandName !== 'AUTH' && this._maxAllowedUnauthenticatedCommands !== false) {
            this._unauthenticatedCommands++;
            if (this._unauthenticatedCommands >= this._maxAllowedUnauthenticatedCommands) {
                return this.send(421, 'Error: too many unauthenticated commands');
            }
        }

        if (!this.hostNameAppearsAs && commandName && ['MAIL', 'RCPT', 'DATA', 'AUTH'].includes(commandName)) {
            this.send(503, 'Error: send ' + (this._server.options.lmtp ? 'LHLO' : 'HELO/EHLO') + ' first');
            return setImmediate(callback);
        }

        // Check if authentication is required
        if (!this.session.user && this._isSupported('AUTH') && ['MAIL', 'RCPT', 'DATA'].includes(commandName) && !this._server.options.authOptional) {
            this.send(530, 'Error: authentication Required');
            return setImmediate(callback);
        }

        handler.call(this, command, callback);
    }

    /**
     * Checks that a command is available and is not listed in the disabled commands array
     *
     * @param {String} command Command name
     * @returns {Boolean} Returns true if the command can be used
     */
    _isSupported(command) {
        command = (command || '').toString().trim().toUpperCase();
        return !this._server.options.disabledCommands.includes(command) && typeof this['handler_' + command] === 'function';
    }

    /**
     * Parses commands like MAIL FROM and RCPT TO. Returns an object with the address and optional arguments.
     *
     * @param {[type]} name Address type, eg 'mail from' or 'rcpt to'
     * @param {[type]} command Data payload to parse
     * @returns {Object|Boolean} Parsed address in the form of {address:, args: {}} or false if parsing failed
     */
    _parseAddressCommand(name, command) {
        command = (command || '').toString();
        name = (name || '').toString().trim().toUpperCase();

        let parts = command.split(':');
        command = parts.shift().trim().toUpperCase();
        parts = parts.join(':').trim().split(/\s+/);

        let address = parts.shift();
        let args = false;
        let invalid = false;

        if (name !== command) {
            return false;
        }

        if (!/^<[^<>]*>$/.test(address)) {
            invalid = true;
        } else {
            address = address.substr(1, address.length - 2);
        }

        parts.forEach(part => {
            part = part.split('=');
            let key = part.shift().toUpperCase();
            let value = part.join('=') || true;

            if (typeof value === 'string') {
                // decode 'xtext'
                value = value.replace(/\+([0-9A-F]{2})/g, (match, hex) => unescape('%' + hex));
            }

            if (!args) {
                args = {};
            }

            args[key] = value;
        });

        if (address) {
            // enforce unycode
            address = address.split('@');
            if (address.length !== 2 || !address[0] || !address[1]) {
                // really bad e-mail address validation. was not able to use joi because of the missing unicode support
                invalid = true;
            } else {
                try {
                    address = [address[0] || '', '@', punycode.toUnicode(address[1] || '')].join('');
                } catch (E) {
                    this._server.logger.error(
                        {
                            tnx: 'punycode',
                            cid: this.id,
                            user: (this.session.user && this.session.user.username) || this.session.user
                        },
                        'Failed to process punycode domain "%s". error=%s',
                        address[1],
                        E.message
                    );
                    address = [address[0] || '', '@', address[1] || ''].join('');
                }
            }
        }

        return invalid
            ? false
            : {
                  address,
                  args
              };
    }

    /**
     * Resets or sets up a new session. We reuse existing session object to keep
     * application specific data.
     */
    _resetSession() {
        let session = this.session;

        // reset data that might be overwritten
        session.localAddress = this.localAddress;
        session.localPort = this.localPort;
        session.remoteAddress = this.remoteAddress;
        session.remotePort = this.remotePort;
        session.clientHostname = this.clientHostname;
        session.openingCommand = this.openingCommand;
        session.hostNameAppearsAs = this.hostNameAppearsAs;
        session.xClient = this._xClient;
        session.xForward = this._xForward;
        session.transmissionType = this._transmissionType();

        session.tlsOptions = this.tlsOptions;

        // reset transaction properties
        session.envelope = {
            mailFrom: false,
            rcptTo: []
        };

        session.transaction = this._transactionCounter + 1;
    }

    /**
     * Returns current transmission type
     *
     * @return {String} Transmission type
     */
    _transmissionType() {
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

    emitConnection() {
        if (!this._canEmitConnection) {
            return;
        }
        this._canEmitConnection = false;
        this.emit('connect', {
            id: this.id,
            localAddress: this.localAddress,
            localPort: this.localPort,
            remoteAddress: this.remoteAddress,
            remotePort: this.remotePort,
            hostNameAppearsAs: this.hostNameAppearsAs,
            clientHostname: this.clientHostname
        });
    }

    // COMMAND HANDLERS

    /**
     * Processes EHLO. Requires valid hostname as the single argument.
     */
    handler_EHLO(command, callback) {
        let parts = command.toString().trim().split(/\s+/);
        let hostname = parts[1] || '';

        if (parts.length !== 2) {
            this.send(501, 'Error: syntax: ' + (this._server.options.lmtp ? 'LHLO' : 'EHLO') + ' hostname');
            return callback();
        }

        this.hostNameAppearsAs = hostname.toLowerCase();

        let features = ['PIPELINING', '8BITMIME', 'SMTPUTF8'].filter(feature => !this._server.options['hide' + feature]);

        if (this._server.options.authMethods.length && this._isSupported('AUTH') && !this.session.user) {
            features.push(['AUTH'].concat(this._server.options.authMethods).join(' '));
        }

        if (!this.secure && this._isSupported('STARTTLS') && !this._server.options.hideSTARTTLS) {
            features.push('STARTTLS');
        }

        if (this._server.options.size) {
            features.push('SIZE' + (this._server.options.hideSize ? '' : ' ' + this._server.options.size));
        }

        // XCLIENT ADDR removes any special privileges for the client
        if (!this._xClient.has('ADDR') && this._server.options.useXClient && this._isSupported('XCLIENT')) {
            features.push('XCLIENT NAME ADDR PORT PROTO HELO LOGIN');
        }

        // If client has already issued XCLIENT ADDR then it does not have privileges for XFORWARD anymore
        if (!this._xClient.has('ADDR') && this._server.options.useXForward && this._isSupported('XFORWARD')) {
            features.push('XFORWARD NAME ADDR PORT PROTO HELO IDENT SOURCE');
        }

        this._resetSession(); // EHLO is effectively the same as RSET
        this.send(250, [this.name + ' Nice to meet you, ' + this.clientHostname].concat(features || []));

        callback();
    }

    /**
     * Processes HELO. Requires valid hostname as the single argument.
     */
    handler_HELO(command, callback) {
        let parts = command.toString().trim().split(/\s+/);
        let hostname = parts[1] || '';

        if (parts.length !== 2) {
            this.send(501, 'Error: Syntax: HELO hostname');
            return callback();
        }

        this.hostNameAppearsAs = hostname.toLowerCase();

        this._resetSession(); // HELO is effectively the same as RSET
        this.send(250, this.name + ' Nice to meet you, ' + this.clientHostname);

        callback();
    }

    /**
     * Processes QUIT. Closes the connection
     */
    handler_QUIT(command, callback) {
        this.send(221, 'Bye');
        this.close();
        callback();
    }

    /**
     * Processes NOOP. Does nothing but keeps the connection alive
     */
    handler_NOOP(command, callback) {
        this.send(250, 'OK');
        callback();
    }

    /**
     * Processes RSET. Resets user and session info
     */
    handler_RSET(command, callback) {
        this._resetSession();

        this.send(250, 'Flushed');
        callback();
    }

    /**
     * Processes HELP. Responds with url to RFC
     */
    handler_HELP(command, callback) {
        this.send(214, 'See https://tools.ietf.org/html/rfc5321 for details');
        callback();
    }

    /**
     * Processes VRFY. Does not verify anything
     */
    handler_VRFY(command, callback) {
        this.send(252, 'Try to send something. No promises though');
        callback();
    }

    /**
     * Overrides connection info
     * http://www.postfix.org/XCLIENT_README.html
     *
     * TODO: add unit tests
     */
    handler_XCLIENT(command, callback) {
        // check if user is authorized to perform this command
        if (this._xClient.has('ADDR') || !this._server.options.useXClient) {
            this.send(550, 'Error: Not allowed');
            return callback();
        }

        // not allowed to change properties if already processing mail
        if (this.session.envelope.mailFrom) {
            this.send(503, 'Error: Mail transaction in progress');
            return callback();
        }

        let allowedKeys = ['NAME', 'ADDR', 'PORT', 'PROTO', 'HELO', 'LOGIN'];
        let parts = command.toString().trim().split(/\s+/);
        let key, value;
        let data = new Map();
        parts.shift(); // remove XCLIENT prefix

        if (!parts.length) {
            this.send(501, 'Error: Bad command parameter syntax');
            return callback();
        }

        let loginValue = false;

        // parse and validate arguments
        for (let i = 0, len = parts.length; i < len; i++) {
            value = parts[i].split('=');
            key = value.shift();
            if (value.length !== 1 || !allowedKeys.includes(key.toUpperCase())) {
                this.send(501, 'Error: Bad command parameter syntax');
                return callback();
            }
            key = key.toUpperCase();

            // value is xtext
            value = (value[0] || '').replace(/\+([0-9A-F]{2})/g, (match, hex) => unescape('%' + hex));

            if (['[UNAVAILABLE]', '[TEMPUNAVAIL]'].includes(value.toUpperCase())) {
                value = false;
            }

            if (data.has(key)) {
                // ignore duplicate keys
                continue;
            }

            data.set(key, value);

            switch (key) {
                // handled outside the switch
                case 'LOGIN':
                    loginValue = value;
                    break;
                case 'ADDR':
                    if (value) {
                        value = value.replace(/^IPV6:/i, ''); // IPv6 addresses are prefixed with "IPv6:"

                        if (!net.isIP(value)) {
                            this.send(501, 'Error: Bad command parameter syntax. Invalid address');
                            return callback();
                        }

                        if (net.isIPv6(value)) {
                            value = ipv6normalize(value);
                        }

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

                    this.clientHostname = value.toLowerCase();
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

                    this.remotePort = value;
                    break;
                default:
                // other values are not relevant
            }
            this._xClient.set(key, value);
        }

        let checkLogin = done => {
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
            let method = 'SASL_XCLIENT';
            sasl[method].call(this, [loginValue], err => {
                if (err) {
                    this.send(550, err.message);
                    this.close();
                    return;
                }
                done();
            });
        };

        // Use [ADDR] if NAME was empty
        if (this.remoteAddress && !this.clientHostname) {
            this.clientHostname = '[' + this.remoteAddress + ']';
        }

        if (data.has('ADDR')) {
            this.emitConnection();
        }

        checkLogin(() => {
            // success
            this.send(
                220,
                this.name + ' ' + (this._server.options.lmtp ? 'LMTP' : 'ESMTP') + (this._server.options.banner ? ' ' + this._server.options.banner : '')
            );
            callback();
        });
    }

    /**
     * Processes XFORWARD data
     * http://www.postfix.org/XFORWARD_README.html
     *
     * TODO: add unit tests
     */
    handler_XFORWARD(command, callback) {
        // check if user is authorized to perform this command
        if (!this._server.options.useXForward) {
            this.send(550, 'Error: Not allowed');
            return callback();
        }

        // not allowed to change properties if already processing mail
        if (this.session.envelope.mailFrom) {
            this.send(503, 'Error: Mail transaction in progress');
            return callback();
        }

        let allowedKeys = ['NAME', 'ADDR', 'PORT', 'PROTO', 'HELO', 'IDENT', 'SOURCE'];
        let parts = command.toString().trim().split(/\s+/);
        let key, value;
        let data = new Map();
        let hasAddr = false;
        parts.shift(); // remove XFORWARD prefix

        if (!parts.length) {
            this.send(501, 'Error: Bad command parameter syntax');
            return callback();
        }

        // parse and validate arguments
        for (let i = 0, len = parts.length; i < len; i++) {
            value = parts[i].split('=');
            key = value.shift();
            if (value.length !== 1 || !allowedKeys.includes(key.toUpperCase())) {
                this.send(501, 'Error: Bad command parameter syntax');
                return callback();
            }
            key = key.toUpperCase();
            if (data.has(key)) {
                // ignore duplicate keys
                continue;
            }

            // value is xtext
            value = (value[0] || '').replace(/\+([0-9A-F]{2})/g, (match, hex) => unescape('%' + hex));

            if (value.toUpperCase() === '[UNAVAILABLE]') {
                value = false;
            }

            data.set(key, value);

            switch (key) {
                case 'ADDR':
                    if (value) {
                        value = value.replace(/^IPV6:/i, ''); // IPv6 addresses are prefixed with "IPv6:"

                        if (!net.isIP(value)) {
                            this.send(501, 'Error: Bad command parameter syntax. Invalid address');
                            return callback();
                        }

                        if (net.isIPv6(value)) {
                            value = ipv6normalize(value);
                        }

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
                        if (!this._xClient.has('ADDR:DEFAULT')) {
                            this._xClient.set('ADDR:DEFAULT', this.remoteAddress);
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
                    this.clientHostname = value.toLowerCase();
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
                    value = Number(value) || 0;
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
    handler_STARTTLS(command, callback) {
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
    handler_AUTH(command, callback) {
        let args = command.toString().trim().split(/\s+/);
        let method;
        let handler;

        args.shift(); // remove AUTH
        method = (args.shift() || '').toString().toUpperCase(); // get METHOD and keep additional arguments in the array
        handler = sasl['SASL_' + method];
        handler = handler ? handler.bind(this) : handler;

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
     * Processes MAIL FROM command, parses address and extra arguments
     */
    handler_MAIL(command, callback) {
        let parsed = this._parseAddressCommand('mail from', command);

        // in case we still haven't informed about the new connection emit it
        this.emitConnection();

        // sender address can be empty, so we only check if parsing failed or not
        if (!parsed) {
            this.send(501, 'Error: Bad sender address syntax');
            return callback();
        }

        if (this.session.envelope.mailFrom) {
            this.send(503, 'Error: nested MAIL command');
            return callback();
        }

        if (!this._server.options.hideSize && this._server.options.size && parsed.args.SIZE && Number(parsed.args.SIZE) > this._server.options.size) {
            this.send(552, 'Error: message exceeds fixed maximum message size ' + this._server.options.size);
            return callback();
        }

        this._server.onMailFrom(parsed, this.session, err => {
            if (err) {
                this.send(err.responseCode || 550, err.message);
                return callback();
            }

            this.session.envelope.mailFrom = parsed;

            this.send(250, 'Accepted');
            callback();
        });
    }

    /**
     * Processes RCPT TO command, parses address and extra arguments
     */
    handler_RCPT(command, callback) {
        let parsed = this._parseAddressCommand('rcpt to', command);

        // recipient address can not be empty
        if (!parsed || !parsed.address) {
            this.send(501, 'Error: Bad recipient address syntax');
            return callback();
        }

        if (!this.session.envelope.mailFrom) {
            this.send(503, 'Error: need MAIL command');
            return callback();
        }

        this._server.onRcptTo(parsed, this.session, err => {
            if (err) {
                this.send(err.responseCode || 550, err.message);
                return callback();
            }

            // check if the address is already used, if so then overwrite
            for (let i = 0, len = this.session.envelope.rcptTo.length; i < len; i++) {
                if (this.session.envelope.rcptTo[i].address.toLowerCase() === parsed.address.toLowerCase()) {
                    this.session.envelope.rcptTo[i] = parsed;
                    parsed = false;
                    break;
                }
            }

            if (parsed) {
                this.session.envelope.rcptTo.push(parsed);
            }

            this.send(250, 'Accepted');
            callback();
        });
    }

    /**
     * Processes DATA by forwarding incoming stream to the onData handler
     */
    handler_DATA(command, callback) {
        if (!this.session.envelope.rcptTo.length) {
            this.send(503, 'Error: need RCPT command');
            return callback();
        }

        if (!this._parser) {
            return callback();
        }

        this._dataStream = this._parser.startDataMode(this._server.options.size);

        let close = (err, message) => {
            let i, len;

            this._server.logger.debug(
                {
                    tnx: 'data',
                    cid: this.id,
                    bytes: this._parser.dataBytes,
                    user: (this.session.user && this.session.user.username) || this.session.user
                },
                'C: <%s bytes of DATA>',
                this._parser.dataBytes
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
                        this.send(response.responseCode || 450, response.message);
                    } else {
                        this.send(250, typeof response === 'string' ? response : 'OK: message accepted');
                    }
                });
            } else if (this._server.options.lmtp) {
                // separate success response for every recipient when using LMTP
                for (i = 0, len = this.session.envelope.rcptTo.length; i < len; i++) {
                    this.send(250, typeof message === 'string' ? message : 'OK: message accepted');
                }
            } else {
                // single success response when using SMTP
                this.send(250, typeof message === 'string' ? message : 'OK: message queued');
            }

            this._transactionCounter++;

            this._unrecognizedCommands = 0; // reset unrecognized commands counter
            this._resetSession(); // reset session state

            if (typeof this._parser === 'object' && this._parser) {
                this._parser.continue();
            }
        };

        this._server.onData(this._dataStream, this.session, (err, message) => {
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
    handler_WIZ(command, callback) {
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
    handler_SHELL(command, callback) {
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
    handler_KILL(command, callback) {
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

    upgrade(callback, secureCallback) {
        this._socket.unpipe(this._parser);
        this._upgrading = true;
        setImmediate(callback); // resume input stream

        let secureContext = this._server.secureContext.get('*');
        let socketOptions = {
            secureContext,
            isServer: true,
            server: this._server.server,

            SNICallback: this._server.options.SNICallback
        };

        // Apply additional socket options if these are set in the server options
        ['requestCert', 'rejectUnauthorized', 'NPNProtocols', 'SNICallback', 'session', 'requestOCSP'].forEach(key => {
            if (key in this._server.options) {
                socketOptions[key] = this._server.options[key];
            }
        });

        // remove all listeners from the original socket besides the error handler
        this._socket.removeAllListeners();
        this._socket.on('error', err => this._onError(err));

        // upgrade connection
        let secureSocket = new tls.TLSSocket(this._socket, socketOptions);

        secureSocket.once('close', hadError => this._onCloseEvent(hadError));
        secureSocket.once('error', err => this._onError(err));
        secureSocket.once('_tlsError', err => this._onError(err));
        secureSocket.once('clientError', err => this._onError(err));

        secureSocket.setTimeout(this._server.options.socketTimeout || SOCKET_TIMEOUT, () => this._onTimeout());

        secureSocket.on('secure', () => {
            this.session.secure = this.secure = true;
            this._socket = secureSocket;
            this._upgrading = false;

            this.session.tlsOptions = this.tlsOptions = this._socket.getCipher();
            let cipher = this.session.tlsOptions && this.session.tlsOptions.name;
            this._server.logger.info(
                {
                    tnx: 'starttls',
                    cid: this.id,
                    user: (this.session.user && this.session.user.username) || this.session.user,
                    cipher
                },
                'Connection upgraded to TLS using ',
                cipher || 'N/A'
            );
            this._socket.pipe(this._parser);
            if (typeof secureCallback === 'function') {
                secureCallback();
            }
        });
    }
}
// Expose to the world
module.exports.SMTPConnection = SMTPConnection;
