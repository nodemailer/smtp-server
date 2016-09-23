'use strict';

var net = require('net');
var tls = require('tls');
var SMTPConnection = require('./smtp-connection').SMTPConnection;
var tlsOptions = require('./tls-options');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var shared = require('nodemailer-shared');

var CLOSE_TIMEOUT = 30 * 1000; // how much to wait until pending connections are terminated

// Expose to the world
module.exports.SMTPServer = SMTPServer;

/**
 * Creates a SMTP server instance.
 *
 * @constructor
 * @param {Object} options Connection and SMTP optionsž
 */
function SMTPServer(options) {
    EventEmitter.call(this);

    this.options = options || {};

    this.secureContext = new Map();
    this.secureContext.set('default', tls.createSecureContext(tlsOptions(this.options)));

    var ctxMap = this.options.sniOptions || {};
    if (typeof ctxMap.get === 'function') {
        ctxMap.forEach(function (ctx, servername) {
            this.secureContext.set(servername.toLowerCase().trim(), tls.createSecureContext(tlsOptions(ctx)));
        }.bind(this));
    } else {
        Object.keys(ctxMap).forEach(function (servername) {
            this.secureContext.set(servername.toLowerCase().trim(), tls.createSecureContext(tlsOptions(ctxMap[servername])));
        }.bind(this));
    }

    // apply TLS defaults if needed, only if there is not SNICallback.
    if (this.options.secure && typeof this.options.SNICallback !== 'function') {
        this.options = tlsOptions(this.options);
        this.options.SNICallback = function (servername, cb) {
            cb(null, this.secureContext.get(servername.toLowerCase().trim()) || this.secureContext.get('default'));
        }.bind(this);
    }

    // setup disabled commands list
    this.options.disabledCommands = [].concat(this.options.disabledCommands || []).map(function (command) {
        return (command || '').toString().toUpperCase().trim();
    });

    // setup allowed auth methods
    this.options.authMethods = [].concat(this.options.authMethods || []).map(function (method) {
        return (method || '').toString().toUpperCase().trim();
    });

    if (!this.options.authMethods.length) {
        this.options.authMethods = ['LOGIN', 'PLAIN'];
    }

    this.logger = shared.getLogger(this.options);

    // apply shorthand handlers
    ['onConnect', 'onAuth', 'onMailFrom', 'onRcptTo', 'onData', 'onClose'].forEach(function (handler) {
        if (typeof this.options[handler] === 'function') {
            this[handler] = this.options[handler];
        }
    }.bind(this));

    /**
     * Timeout after close has been called until pending connections are forcibly closed
     */
    this._closeTimeout = false;

    /**
     * A set of all currently open connections
     */
    this.connections = new Set();

    // setup server listener and connection handler
    this.server = (this.options.secure ? tls : net).createServer(this.options, function (socket) {
        var connection = new SMTPConnection(this, socket);
        this.connections.add(connection);
        connection.on('error', this._onError.bind(this));
        connection.on('connect', this._onClientConnect.bind(this));
        connection.init();
    }.bind(this));

    // ensure _sharedCreds, fixes an issue in node v4+ where STARTTLS fails because _sharedCreds does not exist
    this.server._sharedCreds = this.server._sharedCreds || this.secureContext.get('default');

    this._setListeners();
}
util.inherits(SMTPServer, EventEmitter);

/**
 * Start listening on selected port and interface
 */
SMTPServer.prototype.listen = function ( /* arguments */ ) {
    this.server.listen.apply(this.server, Array.prototype.slice.call(arguments));
};

/**
 * Closes the server
 *
 * @param {Function} callback Callback to run once the server is fully closed
 */
SMTPServer.prototype.close = function (callback) {
    var connections = this.connections.size;
    var timeout = this.options.closeTimeout || CLOSE_TIMEOUT;

    // stop accepting new connections
    this.server.close(function () {
        clearTimeout(this._closeTimeout);
        if (typeof callback === 'function') {
            return callback();
        }
    }.bind(this));

    // close active connections
    if (connections) {
        this.logger.info('Server closing with %s pending connection%s, waiting %s seconds before terminating', connections, connections !== 1 ? 's' : '', timeout / 1000);
    }

    this._closeTimeout = setTimeout(function () {
        connections = this.connections.size;
        if (connections) {
            this.logger.info('Closing %s pending connection%s to close the server', connections, connections !== 1 ? 's' : '');

            this.connections.forEach(function (connection) {
                connection.send(421, 'Server shutting down');
                connection.close();
            }.bind(this));
        }
    }.bind(this), timeout);
};

/**
 * Authentication handler. Override this
 *
 * @param {Object} auth Authentication options
 * @param {Function} callback Callback to run once the user is authenticated
 */
SMTPServer.prototype.onAuth = function (auth, session, callback) {
    if (auth.method === 'XOAUTH2') {
        return callback(null, {
            data: {
                status: '401',
                schemes: 'bearer mac',
                scope: 'https://mail.google.com/'
            }
        });
    }

    return callback(null, {
        message: 'Authentication not implemented'
    });
};

SMTPServer.prototype.onConnect = function (session, callback) {
    setImmediate(callback);
};

SMTPServer.prototype.onMailFrom = function (address, session, callback) {
    setImmediate(callback);
};

SMTPServer.prototype.onRcptTo = function (address, session, callback) {
    setImmediate(callback);
};

SMTPServer.prototype.onData = function (stream, session, callback) {
    var chunklen = 0;

    stream.on('data', function (chunk) {
        chunklen += chunk.length;
    }.bind(this));

    stream.on('end', function () {
        this.logger.info('<received %s bytes>', chunklen);
        callback();
    }.bind(this));
};

SMTPServer.prototype.onClose = function ( /* session */ ) {
    // do nothing
};

// PRIVATE METHODS

/**
 * Setup server event handlers
 */
SMTPServer.prototype._setListeners = function () {
    this.server.on('listening', this._onListening.bind(this));
    this.server.on('close', this._onClose.bind(this));
    this.server.on('error', this._onError.bind(this));
};

/**
 * Called when server started listening
 *
 * @event
 */
SMTPServer.prototype._onListening = function () {
    var address = this.server.address();
    this.logger.info(
        '%s%s Server listening on %s:%s',
        this.options.secure ? 'Secure ' : '',
        this.options.lmtp ? 'LMTP' : 'SMTP',
        address.family === 'IPv4' ? address.address : '[' + address.address + ']',
        address.port);
};

/**
 * Called when server is closed
 *
 * @event
 */
SMTPServer.prototype._onClose = function () {
    this.logger.info((this.options.lmtp ? 'LMTP' : 'SMTP') + ' Server closed');
    this.emit('close');
};

/**
 * Called when an error occurs with the server
 *
 * @event
 */
SMTPServer.prototype._onError = function (err) {
    this.emit('error', err);
};

/**
 * Called when a new connection is established. This might not be the same time the socket is opened
 *
 * @event
 */
SMTPServer.prototype._onClientConnect = function (data) {
    this.emit('connect', data);
};
