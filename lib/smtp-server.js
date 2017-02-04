'use strict';

const net = require('net');
const tls = require('tls');
const SMTPConnection = require('./smtp-connection').SMTPConnection;
const tlsOptions = require('./tls-options');
const EventEmitter = require('events');
const shared = require('nodemailer/lib/shared');

const CLOSE_TIMEOUT = 30 * 1000; // how much to wait until pending connections are terminated

/**
 * Creates a SMTP server instance.
 *
 * @constructor
 * @param {Object} options Connection and SMTP optionsž
 */
class SMTPServer extends EventEmitter {
    constructor(options) {
        super();

        this.options = options || {};

        this.secureContext = new Map();
        this.secureContext.set('default', tls.createSecureContext(tlsOptions(this.options)));

        let ctxMap = this.options.sniOptions || {};
        if (typeof ctxMap.get === 'function') {
            ctxMap.forEach((ctx, servername) => {
                this.secureContext.set(servername.toLowerCase().trim(), tls.createSecureContext(tlsOptions(ctx)));
            });
        } else {
            Object.keys(ctxMap).forEach(servername => {
                this.secureContext.set(servername.toLowerCase().trim(), tls.createSecureContext(tlsOptions(ctxMap[servername])));
            });
        }

        // apply TLS defaults if needed, only if there is not SNICallback.
        if (this.options.secure && typeof this.options.SNICallback !== 'function') {
            this.options = tlsOptions(this.options);
            this.options.SNICallback = (servername, cb) => {
                cb(null, this.secureContext.get(servername.toLowerCase().trim()) || this.secureContext.get('default'));
            };
        }

        // setup disabled commands list
        this.options.disabledCommands = [].concat(this.options.disabledCommands || [])
            .map(command => (command || '').toString().toUpperCase().trim());

        // setup allowed auth methods
        this.options.authMethods = [].concat(this.options.authMethods || [])
            .map(method => (method || '').toString().toUpperCase().trim());

        if (!this.options.authMethods.length) {
            this.options.authMethods = ['LOGIN', 'PLAIN'];
        }

        this.logger = shared.getLogger(this.options, {
            component: this.options.component || 'smtp-server'
        });

        // apply shorthand handlers
        ['onConnect', 'onAuth', 'onMailFrom', 'onRcptTo', 'onData', 'onClose'].forEach(handler => {
            if (typeof this.options[handler] === 'function') {
                this[handler] = this.options[handler];
            }
        });

        /**
         * Timeout after close has been called until pending connections are forcibly closed
         */
        this._closeTimeout = false;

        /**
         * A set of all currently open connections
         */
        this.connections = new Set();

        // setup server listener and connection handler
        this.server = (this.options.secure ? tls : net)
            .createServer(this.options, socket => this.connect(socket));

        // ensure _sharedCreds, fixes an issue in node v4+ where STARTTLS fails because _sharedCreds does not exist
        this.server._sharedCreds = this.server._sharedCreds || this.secureContext.get('default');

        this._setListeners();
    }

    connect(socket) {
        let connection = new SMTPConnection(this, socket);
        this.connections.add(connection);
        connection.on('error', err => this._onError(err));
        connection.on('connect', data => this._onClientConnect(data));
        connection.init();
    }

    /**
     * Start listening on selected port and interface
     */
    listen(...args) {
        this.server.listen(...args);
    }

    /**
     * Closes the server
     *
     * @param {Function} callback Callback to run once the server is fully closed
     */
    close(callback) {
        let connections = this.connections.size;
        let timeout = this.options.closeTimeout || CLOSE_TIMEOUT;

        // stop accepting new connections
        this.server.close(() => {
            clearTimeout(this._closeTimeout);
            if (typeof callback === 'function') {
                return callback();
            }
        });

        // close active connections
        if (connections) {
            this.logger.info({
                tnx: 'close'
            }, 'Server closing with %s pending connection%s, waiting %s seconds before terminating', connections, connections !== 1 ? 's' : '', timeout / 1000);
        }

        this._closeTimeout = setTimeout(() => {
            connections = this.connections.size;
            if (connections) {
                this.logger.info({
                    tnx: 'close'
                }, 'Closing %s pending connection%s to close the server', connections, connections !== 1 ? 's' : '');

                this.connections.forEach(connection => {
                    connection.send(421, 'Server shutting down');
                    connection.close();
                });
            }
        }, timeout);
    }

    /**
     * Authentication handler. Override this
     *
     * @param {Object} auth Authentication options
     * @param {Function} callback Callback to run once the user is authenticated
     */
    onAuth(auth, session, callback) {
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
    }

    onConnect(session, callback) {
        setImmediate(callback);
    }

    onMailFrom(address, session, callback) {
        setImmediate(callback);
    }

    onRcptTo(address, session, callback) {
        setImmediate(callback);
    }

    onData(stream, session, callback) {
        let chunklen = 0;

        stream.on('data', chunk => {
            chunklen += chunk.length;
        });

        stream.on('end', () => {
            this.logger.info({
                tnx: 'message',
                size: chunklen
            }, '<received %s bytes>', chunklen);
            callback();
        });
    }

    onClose( /* session */ ) {
        // do nothing
    }

    // PRIVATE METHODS

    /**
     * Setup server event handlers
     */
    _setListeners() {
        this.server.on('listening', () => this._onListening());
        this.server.on('close', () => this._onClose());
        this.server.on('error', err => this._onError(err));
    }

    /**
     * Called when server started listening
     *
     * @event
     */
    _onListening() {
        let address = this.server.address();
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
            address.port);
    }

    /**
     * Called when server is closed
     *
     * @event
     */
    _onClose() {
        this.logger.info({
            tnx: 'closed'
        }, (this.options.lmtp ? 'LMTP' : 'SMTP') + ' Server closed');
        this.emit('close');
    }

    /**
     * Called when an error occurs with the server
     *
     * @event
     */
    _onError(err) {
        this.emit('error', err);
    }

    /**
     * Called when a new connection is established. This might not be the same time the socket is opened
     *
     * @event
     */
    _onClientConnect(data) {
        this.emit('connect', data);
    }
}

// Expose to the world
module.exports.SMTPServer = SMTPServer;
