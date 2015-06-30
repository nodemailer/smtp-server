'use strict';

var SMTPStream = require('./smtp-stream').SMTPStream;
var dns = require('dns');
var tls = require('tls');
var tlsOptions = require('./tls-options');
var sasl = require('./sasl');
var crypto = require('crypto');
var os = require('os');
var punycode = require('punycode');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var SOCKET_TIMEOUT = 60 * 1000;

// Expose to the world
module.exports.SMTPConnection = SMTPConnection;

/**
 * Creates a handler for new socket
 *
 * @constructor
 * @param {Object} server Server instance
 * @param {Object} socket Socket instance
 */
function SMTPConnection(server, socket) {
    EventEmitter.call(this);

    // Random session ID, used for logging
    this._id = crypto.randomBytes(9).toString('base64');

    this._server = server;
    this._socket = socket;

    // session data (envelope, user etc.)
    this.session = false;

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
    this._parser.oncommand = this._onCommand.bind(this);

    // if currently in data mode, this stream gets the content of incoming message
    this._dataStream = false;

    // If true, then the connection is using TLS
    this.secure = !!this._server.options.secure;

    // Store remote address for later usage
    this.remoteAddress = this._socket.remoteAddress;

    // Error counter - if too many commands in non-authenticated state are used, then disconnect
    this._unauthenticatedCommands = 0;

    // Error counter - if too many invalid commands are used, then disconnect
    this._unrecognizedCommands = 0;

    // Server hostname for the greegins
    this.name = this._server.options.name || os.hostname();

    // Resolved hostname for remote IP address
    this.clientHostname = false;

    // The hostname client identifies itself with
    this.hostNameAppearsAs = false;

    // increment connection count
    this._closing = false;
    this._closed = false;
}
util.inherits(SMTPConnection, EventEmitter);

/**
 * Initiates the connection. Checks connection limits and reverse resolves client hostname. The client
 * is not allowed to send anything before init has finished otherwise 'You talk too soon' error is returned
 */
SMTPConnection.prototype.init = function() {
    // Setup event handlers for the socket
    this._setListeners();

    // Check that connection limit is not exceeded
    if (this._server.options.maxClients && this._server.connections.size > this._server.options.maxClients) {
        this.send(421, this.name + ' Too many connected clients, try again in a moment');
        return this.close();
    }

    // Resolve hostname for the remote IP, keep a small delay for detecting early talkers
    setTimeout(function() {
        dns.reverse(this.remoteAddress, function(err, hostnames) {
            if (this._closing || this._closed) {
                return;
            }

            this.clientHostname = hostnames && hostnames.shift() || '[' + this.remoteAddress + ']';

            this._startSession();

            this._ready = true; // Start accepting data from input
            this._server.logger.info('[%s] Connection from %s', this._id, this.clientHostname);
            this.send(220, this.name + ' ESMTP' + (this._server.options.banner ? ' ' + this._server.options.banner : ''));
        }.bind(this));
    }.bind(this), 100);
};

/**
 * Send data to socket
 *
 * @param {Number} code Response code
 * @param {String|Array} data If data is Array, send a multi-line response
 */
SMTPConnection.prototype.send = function(code, data) {
    var payload;

    if (Array.isArray(data)) {
        payload = data.map(function(line, i, arr) {
            return code + (i < arr.length - 1 ? '-' : ' ') + line;
        }).join('\r\n');
    } else {
        payload = [].concat(code || []).concat(data || []).join(' ');
    }

    if (this._socket && this._socket.writable) {
        this._socket.write(payload + '\r\n');
        this._server.logger.debug('[%s] S:', this._id, payload);
    }
};

/**
 * Close socket
 */
SMTPConnection.prototype.close = function() {
    if (!this._socket.destroyed && this._socket.writable) {
        this._socket.end();
    }

    this._server.connections.delete(this);

    this._closing = true;
};

// PRIVATE METHODS

/**
 * Setup socket event handlers
 */
SMTPConnection.prototype._setListeners = function() {
    this._socket.on('close', this._onClose.bind(this));
    this._socket.on('error', this._onError.bind(this));
    this._socket.setTimeout(this._server.options.socketTimeout || SOCKET_TIMEOUT, this._onTimeout.bind(this));
    this._socket.pipe(this._parser);
};

/**
 * Fired when the socket is closed
 * @event
 */
SMTPConnection.prototype._onClose = function( /* hadError */ ) {
    if (this._parser) {
        this._parser.closed = true;
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

    this._server.logger.info('[%s] Connection closed to %s', this._id, this.clientHostname || this.remoteAddress);
};

/**
 * Fired when an error occurs with the socket
 *
 * @event
 * @param {Error} err Error object
 */
SMTPConnection.prototype._onError = function(err) {
    if (err.code === 'ECONNRESET') {
        this.close(); // mark connection as 'closing'
        return;
    }

    this._server.logger.error('[%s]', this._id, err);
    this.emit('error', err);
};

/**
 * Fired when socket timeouts. Closes connection
 *
 * @event
 */
SMTPConnection.prototype._onTimeout = function() {
    this.send(451, 'Timeout - closing connection');
    this.close();
};

/**
 * Checks if a selected command is available and ivokes it
 *
 * @param {Buffer} command Single line of data from the client
 * @param {Function} callback Callback to run once the command is processed
 */
SMTPConnection.prototype._onCommand = function(command, callback) {
    this._server.logger.debug('[%s] C:', this._id, (command || '').toString());

    // block spammers that send payloads before server greeting
    if (!this._ready) {
        this.send(421, this.name + ' You talk too soon');
        return this.close();
    }

    // block malicious web pages that try to make SMTP calls from an AJAX request
    if (/^(OPTIONS|GET|HEAD|POST|PUT|DELETE|TRACE|CONNECT) \/.* HTTP\/\d\.\d$/i.test(command)) {
        this.send(554, 'HTTP requests not allowed');
        return this.close();
    }

    callback = callback || function() {};

    if (this._upgrading) {
        // ignore any commands before TLS upgrade is finished
        return callback();
    }

    var commandName;
    var handler;

    if (this._nextHandler) {
        // If we already have a handler method queued up then use this
        handler = this._nextHandler;
        this._nextHandler = false;
    } else {
        // detect handler from the command name
        commandName = (command || '').toString().split(' ').shift().toUpperCase();
        if (this._isSupported(commandName)) {
            handler = this['handler_' + commandName];
        }
    }

    if (!handler) {
        // if the user makes more
        this._unrecognizedCommands++;
        if (this._unrecognizedCommands >= 10) {
            this.send(554, 'Error: too many unrecognized commands');
            return this.close();
        }

        this.send(500, 'Error: command not recognized');
        return setImmediate(callback);
    }

    // block users that try to fiddle around without logging in
    if (!this.session.user && this._isSupported('AUTH') && commandName !== 'AUTH') {
        this._unauthenticatedCommands++;
        if (this._unauthenticatedCommands >= 10) {
            this.send(554, 'Error: too many unauthenticated commands');
            return this.close();
        }
    }

    if (!this.hostNameAppearsAs && commandName &&
        ['MAIL', 'RCPT', 'DATA', 'AUTH'].indexOf(commandName) >= 0) {
        this.send(503, 'Error: send HELO/EHLO first');
        return setImmediate(callback);
    }

    // Check if authentication is required
    if (!this.session.user && this._isSupported('AUTH') &&
        ['MAIL', 'RCPT', 'DATA'].indexOf(commandName) >= 0) {
        this.send(530, 'Error: authentication Required');
        return setImmediate(callback);
    }

    handler.call(this, command, callback);
};

/**
 * Checks that a command is available and is not listed in the disabled commands array
 *
 * @param {String} command Command name
 * @returns {Boolean} Returns true if the command can be used
 */
SMTPConnection.prototype._isSupported = function(command) {
    command = (command || '').toString().trim().toUpperCase();
    return this._server.options.disabledCommands.indexOf(command) < 0 &&
        typeof this['handler_' + command] === 'function';
};

/**
 * Parses commands like MAIL FROM and RCPT TO. Returns an object with the address and optional arguments.
 *
 * @param {[type]} name Address type, eg 'mail from' or 'rcpt to'
 * @param {[type]} command Data payload to parse
 * @returns {Object|Boolean} Parsed address in the form of {address:, args: {}} or false if parsing failed
 */
SMTPConnection.prototype._parseAddressCommand = function(name, command) {
    command = (command || '').toString();
    name = (name || '').toString().trim().toUpperCase();

    var parts = command.split(':');
    command = parts.shift().trim().toUpperCase();
    parts = parts.join(':').trim().split(/\s+/);

    var address = parts.shift();
    var args = false;
    var invalid = false;

    if (name !== command) {
        return false;
    }

    if (!/^<[^<>]*>$/.test(address)) {
        invalid = true;
    } else {
        address = address.substr(1, address.length - 2);
    }

    parts.forEach(function(part) {
        part = part.split('=');
        var key = part.shift().toUpperCase();
        var value = part.join('=') || true;

        if (!args) {
            args = {};
        }

        args[key] = value;
    });

    if (address) {
        // enforce unycode
        address = address.split('@');
        if (address.length !== 2 || !address[0] || !address[1]) { // really bad e-mail address validation. was not able to use joi because of the missing unicode support
            invalid = true;
        } else {
            address = [address[0] || '', '@', punycode.toUnicode(address[1] || '')].join('');
        }
    }

    return invalid ? false : {
        address: address,
        args: args
    };
};

/**
 * Sets up a new session
 */
SMTPConnection.prototype._startSession = function() {
    var user = this.session.user || false;

    this.session = {
        id: this._id,
        remoteAddress: this.remoteAddress,
        clientHostname: this.clientHostname,
        hostNameAppearsAs: this.hostNameAppearsAs,
        envelope: {
            mailFrom: false,
            rcptTo: []
        },
        user: user,
        transaction: this._transactionCounter + 1
    };
};

// COMMAND HANDLERS

/**
 * Processes EHLO. Requires valid hostname as the single argument.
 */
SMTPConnection.prototype.handler_EHLO = function(command, callback) {
    var parts = command.toString().split(/\s+/);
    var hostname = parts[1] || '';

    if (parts.length !== 2) {
        this.send(501, 'Error: syntax: EHLO hostname');
        return callback();
    }

    this.hostNameAppearsAs = hostname.toLowerCase();

    var features = ['PIPELINING', '8BITMIME', 'SMTPUTF8'];

    if (this._server.options.authMethods.length && this._isSupported('AUTH')) {
        features.push(['AUTH'].concat(this._server.options.authMethods).join(' '));
    }

    if (!this.secure && this._isSupported('STARTTLS') && !this._server.options.hideSTARTTLS) {
        features.push('STARTTLS');
    }

    if (this._server.options.size) {
        features.push('SIZE ' + this._server.options.size);
    }

    this._startSession(); // EHLO is effectively the same as RSET
    this.send(250, ['OK: Nice to meet you ' + this.clientHostname].concat(features || []));

    callback();
};

/**
 * Processes HELO. Requires valid hostname as the single argument.
 */
SMTPConnection.prototype.handler_HELO = function(command, callback) {
    var parts = command.toString().split(/\s+/);
    var hostname = parts[1] || '';

    if (parts.length !== 2) {
        this.send(501, 'Error: Syntax: HELO hostname');
        return callback();
    }

    this.hostNameAppearsAs = hostname.toLowerCase();

    this._startSession(); // HELO is effectively the same as RSET
    this.send(250, 'OK: Nice to meet you ' + this.clientHostname);

    callback();
};

/**
 * Processes QUIT. Closes the connection
 */
SMTPConnection.prototype.handler_QUIT = function(command, callback) {
    this.send(221, 'Bye');
    this.close();
    callback();
};

/**
 * Processes NOOP. Does nothing but keeps the connection alive
 */
SMTPConnection.prototype.handler_NOOP = function(command, callback) {
    this.send(250, 'OK');
    callback();
};

/**
 * Processes RSET. Resets user and session info
 */
SMTPConnection.prototype.handler_RSET = function(command, callback) {
    this._startSession();

    this.send(250, 'Flushed');
    callback();
};

/**
 * Processes HELP. Responds with url to RFC
 */
SMTPConnection.prototype.handler_HELP = function(command, callback) {
    this.send(214, 'See https://tools.ietf.org/html/rfc5321 for details');
    callback();
};

/**
 * Processes VRFY. Does not verify anything
 */
SMTPConnection.prototype.handler_VRFY = function(command, callback) {
    this.send(252, 'Try to send something. No promises though');
    callback();
};

/**
 * Upgrades connection to TLS if possible
 */
SMTPConnection.prototype.handler_STARTTLS = function(command, callback) {

    if (this.secure) {
        this.send(554, 'Error: TLS already active');
        return callback();
    }

    this.send(220, 'Ready to start TLS');
    this._socket.unpipe(this._parser);
    this._upgrading = true;
    callback(); // resume input stream

    var secureContext = tls.createSecureContext(tlsOptions(this._server.options));
    var socketOptions = {
        secureContext: secureContext,
        isServer: true,
        server: this._server.server,

        SNICallback: function(servername, cb) {
            var ctxMap = this._server.options.sniOptions || {};
            var ctx;
            if (typeof ctxMap.get === 'function') {
                ctx = ctxMap.get(servername);
            } else {
                ctx = ctxMap[servername];
            }
            cb(null, ctx && tls.createSecureContext(tlsOptions(ctx)) || secureContext);
        }.bind(this)
    };

    // Apply additional socket options if these are set in the server options
    ['requestCert', 'rejectUnauthorized', 'NPNProtocols', 'SNICallback', 'session'].forEach(function(key) {
        if (key in this._server.options) {
            socketOptions[key] = this._server.options[key];
        }
    }.bind(this));

    // remove all listeners from the original socket besides the error handler
    this._socket.removeAllListeners();
    this._socket.on('error', this._onError.bind(this));

    // upgrade connection
    var secureSocket = new tls.TLSSocket(this._socket, socketOptions);

    secureSocket.on('close', this._onClose.bind(this));
    secureSocket.on('error', this._onError.bind(this));
    secureSocket.on('clientError', this._onError.bind(this));
    secureSocket.setTimeout(this._server.options.socketTimeout || SOCKET_TIMEOUT, this._onTimeout.bind(this));

    secureSocket.on('secure', function() {
        this.secure = true;
        this._socket = secureSocket;
        this._upgrading = false;

        this._server.logger.info('[%s] Connection upgraded to TLS', this._id);
        this._socket.pipe(this._parser);
    }.bind(this));
};

/**
 * Check if selected authentication is available and delegate auth data to SASL
 */
SMTPConnection.prototype.handler_AUTH = function(command, callback) {
    var args = command.toString().trim().split(/\s+/);
    var method;
    var handler;

    args.shift(); // remove AUTH
    method = (args.shift() || '').toString().toUpperCase(); // get METHOD and keep additional arguments in the array
    handler = sasl['SASL_' + method].bind(this);

    if (!this.secure && this._isSupported('STARTTLS') && !this._server.options.hideSTARTTLS) {
        this.send(538, 'Error: Must issue a STARTTLS command first');
        return callback();
    }

    if (this.session.user) {
        this.send(503, 'Error: No identity changes permitted');
        return callback();
    }

    if (this._server.options.authMethods.indexOf(method) < 0 || typeof handler !== 'function') {
        this.send(504, 'Error: Unrecognized authentication type');
        return callback();
    }

    handler(args, callback);
};

/**
 * Processes MAIL FROM command, parses address and extra arguments
 */
SMTPConnection.prototype.handler_MAIL = function(command, callback) {
    var parsed = this._parseAddressCommand('mail from', command);

    // sender address can be empty, so we only check if parsing failed or not
    if (!parsed) {
        this.send(501, 'Error: Bad sender address syntax');
        return callback();
    }

    if (this.session.envelope.mailFrom) {
        this.send(503, 'Error: nested MAIL command');
        return callback();
    }

    if (this._server.options.size && parsed.args.SIZE && Number(parsed.args.SIZE) > this._server.options.size) {
        this.send(552, 'Error: message exceeds fixed maximum message size ' + this._server.options.size);
        return callback();
    }

    this._server.onMailFrom(parsed, this.session, function(err) {
        if (err) {
            this.send(err.responseCode || 550, err.message);
            return callback();
        }

        this.session.envelope.mailFrom = parsed;

        this.send(250, 'Accepted');
        callback();
    }.bind(this));
};


/**
 * Processes RCPT TO command, parses address and extra arguments
 */
SMTPConnection.prototype.handler_RCPT = function(command, callback) {
    var parsed = this._parseAddressCommand('rcpt to', command);

    // recipient address can not be empty
    if (!parsed || !parsed.address) {
        this.send(501, 'Error: Bad recipient address syntax');
        return callback();
    }

    if (!this.session.envelope.mailFrom) {
        this.send(503, 'Error: need MAIL command');
        return callback();
    }

    this._server.onRcptTo(parsed, this.session, function(err) {
        if (err) {
            this.send(err.responseCode || 550, err.message);
            return callback();
        }

        // check if the address is already used, if so then overwrite
        for (var i = 0, len = this.session.envelope.rcptTo.length; i < len; i++) {
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
    }.bind(this));
};

/**
 * Processes DATA by forwarding incoming stream to the onData handler
 */
SMTPConnection.prototype.handler_DATA = function(command, callback) {
    if (!this.session.envelope.rcptTo.length) {
        this.send(503, 'Error: need RCPT command');
        return callback();
    }

    this._dataStream = this._parser.startDataMode(this._server.options.size);

    var close = function(err, message) {
        this._server.logger.debug('[%s] C: <%s bytes of DATA>', this._id, this._parser.dataBytes);

        this._dataStream.removeAllListeners();

        if (err) {
            this.send(err.responseCode || 554, err.message);
        } else {
            this.send(250, typeof message === 'string' ? message : 'OK: message queued');
        }

        this._transactionCounter++;

        this._unrecognizedCommands = 0; // reset unrecognized commands counter
        this._startSession(); // reset session state
        this._parser.continue();
    }.bind(this);

    this._server.onData(this._dataStream, this.session, function(err, message) {
        // do not continue until the stream has actually ended
        if (this._dataStream.readable) {
            this._dataStream.on('end', function() {
                close(err, message);
            });
            return;
        }
        close(err, message);
    }.bind(this));

    this.send(354, 'End data with <CR><LF>.<CR><LF>');
    callback();
};