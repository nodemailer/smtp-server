'use strict';

var net = require('net');
var tls = require('tls');
var SMTPConnection = require('./smtp-connection').SMTPConnection;
var tlsOptions = require('./tls-options');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

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

    // apply TLS defaults if needed
    if (!!this.options.secure) {
        this.options = tlsOptions(this.options);
    }

    // setup disabled commands list
    this.options.disabledCommands = [].concat(this.options.disabledCommands || []).map(function(command) {
        return (command || '').toString().toUpperCase().trim();
    });

    // setup allowed auth methods
    this.options.authMethods = [].concat(this.options.authMethods || []).map(function(method) {
        return (method || '').toString().toUpperCase().trim();
    });

    if (!this.options.authMethods.length) {
        this.options.authMethods = ['LOGIN', 'PLAIN'];
    }

    // setup logger
    this.logger = this.options.logger || this._createDefaultLogger();

    ['onAuth', 'onMailFrom', 'onRcptTo', 'onData'].forEach(function(handler) {
        if (typeof this.options[handler] === 'function') {
            this[handler] = this.options[handler];
        }
    }.bind(this));

    this.connections = 0;

    this.server = (this.options.secure ? tls : net).createServer(this.options, function(socket) {
        var connection = new SMTPConnection(this, socket);
        connection.on('error', this._onError.bind(this));
    }.bind(this));

    this._setListeners();
}
util.inherits(SMTPServer, EventEmitter);

/**
 * Start listening on selected port and interface
 */
SMTPServer.prototype.listen = function( /* arguments */ ) {
    this.server.listen.apply(this.server, Array.prototype.slice.call(arguments));
};

/**
 * Closes the server
 *
 * @param {Function} callback Callback to run once the server is fully closed
 */
SMTPServer.prototype.close = function(callback) {
    this.server.close(callback);
};

/**
 * Authentication handler. Override this
 *
 * @param {Object} auth Authentication options
 * @param {Function} callback Callback to run once the user is authenticated
 */
SMTPServer.prototype.onAuth = function(auth, session, callback) {
    if (auth.method === 'XOAUTH2') {
        callback(null, {
            data: {
                status: '401',
                schemes: 'bearer mac',
                scope: 'https://mail.google.com/'
            }
        });
    } else {
        callback(null, {
            message: 'Authentication not implemented'
        });
    }
};

SMTPServer.prototype.onMailFrom = function(address, session, callback) {
    setImmediate(callback);
};

SMTPServer.prototype.onRcptTo = function(address, session, callback) {
    setImmediate(callback);
};

SMTPServer.prototype.onData = function(stream, session, callback) {
    var chunklen = 0;

    stream.on('data', function(chunk) {
        chunklen += chunk.length;
    }.bind(this));

    stream.on('end', function() {
        this.logger.info('<received %s bytes>', chunklen);
        callback();
    }.bind(this));
};

// PRIVATE METHODS

/**
 * Generates a bunyan-like logger that prints to console
 *
 * @returns {Object} Bunyan logger instance
 */
SMTPServer.prototype._createDefaultLogger = function() {

    var logger = {
        _print: function( /* level, message */ ) {
            var args = Array.prototype.slice.call(arguments);
            var level = args.shift();
            var message;

            if (args.length > 1) {
                message = util.format.apply(util, args);
            } else {
                message = args.shift();
            }

            console.log('[%s] %s: %s',
                new Date().toISOString().substr(0, 19).replace(/T/, ' '),
                level.toUpperCase(),
                message);
        }
    };

    logger.info = logger._print.bind(null, 'info');
    logger.debug = logger._print.bind(null, 'debug');
    logger.error = logger._print.bind(null, 'error');

    return logger;
};

/**
 * Setup server event handlers
 */
SMTPServer.prototype._setListeners = function() {
    this.server.on('listening', this._onListening.bind(this));
    this.server.on('close', this._onClose.bind(this));
    this.server.on('error', this._onError.bind(this));
};

/**
 * Called when server started listening
 *
 * @event
 */
SMTPServer.prototype._onListening = function() {
    var address = this.server.address();
    this.logger.info(
        '%sSMTP Server listening on %s:%s',
        this.options.secure ? 'Secure ' : '',
        address.family === 'IPv4' ? address.address : '[' + address.address + ']',
        address.port);
};

/**
 * Called when server is closed
 *
 * @event
 */
SMTPServer.prototype._onClose = function() {
    this.logger.info('SMTP Server closed');
};

/**
 * Called when an error occurs with the server
 *
 * @event
 */
SMTPServer.prototype._onError = function(err) {
    this.logger.error(err);
    this.emit('error', err);
};