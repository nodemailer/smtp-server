'use strict';

const net = require('net');
const tls = require('tls');
const SMTPConnection = require('./smtp-connection').SMTPConnection;
const tlsOptions = require('./tls-options');
const EventEmitter = require('events');
const shared = require('nodemailer/lib/shared');
const punycode = require('punycode');
const crypto = require('crypto');
const base32 = require('base32.js');

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

        this.updateSecureContext();

        // setup disabled commands list
        this.options.disabledCommands = [].concat(this.options.disabledCommands || []).map(command => (command || '').toString().toUpperCase().trim());

        // setup allowed auth methods
        this.options.authMethods = [].concat(this.options.authMethods || []).map(method => (method || '').toString().toUpperCase().trim());

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
        if (this.options.secure && !this.options.needsUpgrade) {
            this.server = net.createServer(this.options, socket => {
                this._handleProxy(socket, (err, socketOptions) => {
                    if (err) {
                        // ignore, should not happen
                    }
                    if (this.options.secured) {
                        return this.connect(socket, socketOptions);
                    }
                    this._upgrade(socket, (err, tlsSocket) => {
                        if (err) {
                            return this._onError(err);
                        }
                        this.connect(tlsSocket, socketOptions);
                    });
                });
            });
        } else {
            this.server = net.createServer(this.options, socket =>
                this._handleProxy(socket, (err, socketOptions) => {
                    if (err) {
                        // ignore, should not happen
                    }
                    this.connect(socket, socketOptions);
                })
            );
        }

        this._setListeners();
    }

    connect(socket, socketOptions) {
        let connection = new SMTPConnection(this, socket, socketOptions);
        this.connections.add(connection);
        connection.on('error', err => this._onError(err));
        connection.on('connect', data => this._onClientConnect(data));
        connection.init();
    }

    /**
     * Start listening on selected port and interface
     */
    listen(...args) {
        return this.server.listen(...args);
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
                return realCallback();
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

        if (auth.method === 'XCLIENT') {
            return callback(); // pass through
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

    onClose(/* session */) {
        // do nothing
    }

    updateSecureContext(options) {
        Object.keys(options || {}).forEach(key => {
            this.options[key] = options[key];
        });

        let defaultTlsOptions = tlsOptions(this.options);

        this.secureContext = new Map();
        this.secureContext.set('*', tls.createSecureContext(defaultTlsOptions));

        let ctxMap = this.options.sniOptions || {};
        // sniOptions is either an object or a Map with domain names as keys and TLS option objects as values
        if (typeof ctxMap.get === 'function') {
            ctxMap.forEach((ctx, servername) => {
                this.secureContext.set(this._normalizeHostname(servername), tls.createSecureContext(tlsOptions(ctx)));
            });
        } else {
            Object.keys(ctxMap).forEach(servername => {
                this.secureContext.set(this._normalizeHostname(servername), tls.createSecureContext(tlsOptions(ctxMap[servername])));
            });
        }

        if (this.options.secure) {
            // appy changes

            Object.keys(defaultTlsOptions || {}).forEach(key => {
                if (!(key in this.options)) {
                    this.options[key] = defaultTlsOptions[key];
                }
            });

            // ensure SNICallback method
            if (typeof this.options.SNICallback !== 'function') {
                // create default SNI handler
                this.options.SNICallback = (servername, cb) => {
                    cb(null, this.secureContext.get(servername));
                };
            }
        }
    }

    // PRIVATE METHODS

    /**
     * Setup server event handlers
     */
    _setListeners() {
        let server = this.server;
        server.once('listening', (...args) => this._onListening(...args));
        server.once('close', (...args) => this._onClose(server, ...args));
        server.on('error', (...args) => this._onError(...args));
    }

    /**
     * Called when server started listening
     *
     * @event
     */
    _onListening() {
        let address = this.server.address();

        // address will be null if listener is using Unix socket
        if (address === null) {
            address = { address: null, port: null, family: null };
        }

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
    _onClose(server) {
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
    _onError(err) {
        this.emit('error', err);
    }

    _handleProxy(socket, callback) {
        let socketOptions = {
            id: base32.encode(crypto.randomBytes(10)).toLowerCase()
        };

        if (
            !this.options.useProxy ||
            (Array.isArray(this.options.useProxy) && !this.options.useProxy.includes(socket.remoteAddress) && !this.options.useProxy.includes('*'))
        ) {
            socketOptions.ignore = this.options.ignoredHosts && this.options.ignoredHosts.includes(socket.remoteAddress);
            return setImmediate(() => callback(null, socketOptions));
        }

        let chunks = [];
        let chunklen = 0;
        let socketReader = () => {
            let chunk;
            while ((chunk = socket.read()) !== null) {
                for (let i = 0, len = chunk.length; i < len; i++) {
                    let chr = chunk[i];
                    if (chr === 0x0a) {
                        socket.removeListener('readable', socketReader);
                        chunks.push(chunk.slice(0, i + 1));
                        chunklen += i + 1;
                        let remainder = chunk.slice(i + 1);
                        if (remainder.length) {
                            socket.unshift(remainder);
                        }

                        let header = Buffer.concat(chunks, chunklen).toString().trim();

                        let params = (header || '').toString().split(' ');
                        let commandName = params.shift().toUpperCase();
                        if (commandName !== 'PROXY') {
                            try {
                                socket.end('* BAD Invalid PROXY header\r\n');
                            } catch (E) {
                                // ignore
                            }
                            return;
                        }

                        if (params[1]) {
                            socketOptions.remoteAddress = params[1].trim().toLowerCase();

                            socketOptions.ignore = this.options.ignoredHosts && this.options.ignoredHosts.includes(socketOptions.remoteAddress);

                            if (!socketOptions.ignore) {
                                this.logger.info(
                                    {
                                        tnx: 'proxy',
                                        cid: socketOptions.id,
                                        proxy: params[1].trim().toLowerCase()
                                    },
                                    '[%s] PROXY from %s through %s (%s)',
                                    socketOptions.id,
                                    params[1].trim().toLowerCase(),
                                    params[2].trim().toLowerCase(),
                                    JSON.stringify(params)
                                );
                            }

                            if (params[3]) {
                                socketOptions.remotePort = Number(params[3].trim()) || socketOptions.remotePort;
                            }
                        }

                        return callback(null, socketOptions);
                    }
                }
                chunks.push(chunk);
                chunklen += chunk.length;
            }
        };
        socket.on('readable', socketReader);
    }

    /**
     * Called when a new connection is established. This might not be the same time the socket is opened
     *
     * @event
     */
    _onClientConnect(data) {
        this.emit('connect', data);
    }

    /**
     * Normalize hostname
     *
     * @event
     */
    _normalizeHostname(hostname) {
        try {
            hostname = punycode.toUnicode((hostname || '').toString().trim()).toLowerCase();
        } catch (E) {
            this.logger.error(
                {
                    tnx: 'punycode'
                },
                'Failed to process punycode domain "%s". error=%s',
                hostname,
                E.message
            );
        }

        return hostname;
    }

    _upgrade(socket, callback) {
        let socketOptions = {
            secureContext: this.secureContext.get('*'),
            isServer: true,
            server: this.server,
            SNICallback: (servername, cb) => {
                // eslint-disable-next-line new-cap
                this.options.SNICallback(this._normalizeHostname(servername), (err, context) => {
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
        };

        let returned = false;
        let onError = err => {
            if (returned) {
                return;
            }
            returned = true;
            callback(err || new Error('Socket closed unexpectedly'));
        };

        // remove all listeners from the original socket besides the error handler
        socket.once('error', onError);

        // upgrade connection
        let tlsSocket = new tls.TLSSocket(socket, socketOptions);

        tlsSocket.once('close', onError);
        tlsSocket.once('error', onError);
        tlsSocket.once('_tlsError', onError);
        tlsSocket.once('clientError', onError);
        tlsSocket.once('tlsClientError', onError);

        tlsSocket.on('secure', () => {
            socket.removeListener('error', onError);
            tlsSocket.removeListener('close', onError);
            tlsSocket.removeListener('error', onError);
            tlsSocket.removeListener('_tlsError', onError);
            tlsSocket.removeListener('clientError', onError);
            tlsSocket.removeListener('tlsClientError', onError);
            if (returned) {
                try {
                    tlsSocket.end();
                } catch (E) {
                    //
                }
                return;
            }
            returned = true;
            return callback(null, tlsSocket);
        });
    }
}

// Expose to the world
module.exports.SMTPServer = SMTPServer;
