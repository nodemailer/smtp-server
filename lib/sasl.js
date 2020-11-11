'use strict';

const util = require('util');
const crypto = require('crypto');

const SASL = (module.exports = {
    SASL_PLAIN(args, callback) {
        if (args.length > 1) {
            this.send(501, 'Error: syntax: AUTH PLAIN token');
            return callback();
        }

        if (!args.length) {
            this._nextHandler = SASL.PLAIN_token.bind(this, true);
            this.send(334);
            return callback();
        }

        SASL.PLAIN_token.call(this, false, args[0], callback);
    },

    SASL_LOGIN(args, callback) {
        if (args.length > 1) {
            this.send(501, 'Error: syntax: AUTH LOGIN');
            return callback();
        }

        if (!args.length) {
            this._nextHandler = SASL.LOGIN_username.bind(this, true);
            this.send(334, 'VXNlcm5hbWU6');
            return callback();
        }

        SASL.LOGIN_username.call(this, false, args[0], callback);
    },

    SASL_XOAUTH2(args, callback) {
        if (args.length > 1) {
            this.send(501, 'Error: syntax: AUTH XOAUTH2 token');
            return callback();
        }

        if (!args.length) {
            this._nextHandler = SASL.XOAUTH2_token.bind(this, true);
            this.send(334);
            return callback();
        }

        SASL.XOAUTH2_token.call(this, false, args[0], callback);
    },

    'SASL_CRAM-MD5'(args, callback) {
        if (args.length) {
            this.send(501, 'Error: syntax: AUTH CRAM-MD5');
            return callback();
        }

        let challenge = util.format(
            '<%s%s@%s>',
            String(Math.random())
                .replace(/^[0.]+/, '')
                .substr(0, 8), // random numbers
            Math.floor(Date.now() / 1000), // timestamp
            this.name // hostname
        );

        this._nextHandler = SASL['CRAM-MD5_token'].bind(this, true, challenge);
        this.send(334, Buffer.from(challenge).toString('base64'));
        return callback();
    },

    PLAIN_token(canAbort, token, callback) {
        token = (token || '').toString().trim();

        if (canAbort && token === '*') {
            this.send(501, 'Authentication aborted');
            return callback();
        }

        let data = Buffer.from(token, 'base64').toString().split('\x00');

        if (data.length !== 3) {
            this.send(500, 'Error: invalid userdata');
            return callback();
        }

        let username = data[1] || data[0] || '';
        let password = data[2] || '';

        this._server.onAuth(
            {
                method: 'PLAIN',
                username,
                password
            },
            this.session,
            (err, response) => {
                if (err) {
                    this._server.logger.info(
                        {
                            err,
                            tnx: 'autherror',
                            cid: this.id,
                            method: 'PLAIN',
                            user: username
                        },
                        'Authentication error for %s using %s. %s',
                        username,
                        'PLAIN',
                        err.message
                    );
                    this.send(err.responseCode || 535, err.message);
                    return callback();
                }

                if (!response.user) {
                    this._server.logger.info(
                        {
                            tnx: 'authfail',
                            cid: this.id,
                            method: 'PLAIN',
                            user: username
                        },
                        'Authentication failed for %s using %s',
                        username,
                        'PLAIN'
                    );
                    this.send(response.responseCode || 535, response.message || 'Error: Authentication credentials invalid');
                    return callback();
                }

                this._server.logger.info(
                    {
                        tnx: 'auth',
                        cid: this.id,
                        method: 'PLAIN',
                        user: username
                    },
                    '%s authenticated using %s',
                    username,
                    'PLAIN'
                );
                this.session.user = response.user;
                this.session.transmissionType = this._transmissionType();

                this.send(235, 'Authentication successful');
                callback();
            }
        );
    },

    LOGIN_username(canAbort, username, callback) {
        username = (username || '').toString().trim();

        if (canAbort && username === '*') {
            this.send(501, 'Authentication aborted');
            return callback();
        }

        username = Buffer.from(username, 'base64').toString();

        if (!username) {
            this.send(500, 'Error: missing username');
            return callback();
        }

        this._nextHandler = SASL.LOGIN_password.bind(this, username);
        this.send(334, 'UGFzc3dvcmQ6');
        return callback();
    },

    LOGIN_password(username, password, callback) {
        password = (password || '').toString().trim();

        if (password === '*') {
            this.send(501, 'Authentication aborted');
            return callback();
        }

        password = Buffer.from(password, 'base64').toString();

        this._server.onAuth(
            {
                method: 'LOGIN',
                username,
                password
            },
            this.session,
            (err, response) => {
                if (err) {
                    this._server.logger.info(
                        {
                            err,
                            tnx: 'autherror',
                            cid: this.id,
                            method: 'LOGIN',
                            user: username
                        },
                        'Authentication error for %s using %s. %s',
                        username,
                        'LOGIN',
                        err.message
                    );
                    this.send(err.responseCode || 535, err.message);
                    return callback();
                }

                if (!response.user) {
                    this._server.logger.info(
                        {
                            tnx: 'authfail',
                            cid: this.id,
                            method: 'LOGIN',
                            user: username
                        },
                        'Authentication failed for %s using %s',
                        username,
                        'LOGIN'
                    );
                    this.send(response.responseCode || 535, response.message || 'Error: Authentication credentials invalid');
                    return callback();
                }

                this._server.logger.info(
                    {
                        tnx: 'auth',
                        cid: this.id,
                        method: 'PLAIN',
                        user: username
                    },
                    '%s authenticated using %s',
                    username,
                    'LOGIN'
                );
                this.session.user = response.user;
                this.session.transmissionType = this._transmissionType();

                this.send(235, 'Authentication successful');
                callback();
            }
        );
    },

    XOAUTH2_token(canAbort, token, callback) {
        token = (token || '').toString().trim();

        if (canAbort && token === '*') {
            this.send(501, 'Authentication aborted');
            return callback();
        }

        let username;
        let accessToken;

        // Find username and access token from the input
        Buffer.from(token, 'base64')
            .toString()
            .split('\x01')
            .forEach(part => {
                part = part.split('=');
                let key = part.shift().toLowerCase();
                let value = part.join('=').trim();

                if (key === 'user') {
                    username = value;
                } else if (key === 'auth') {
                    value = value.split(/\s+/);
                    if (value.shift().toLowerCase() === 'bearer') {
                        accessToken = value.join(' ');
                    }
                }
            });

        if (!username || !accessToken) {
            this.send(500, 'Error: invalid userdata');
            return callback();
        }

        this._server.onAuth(
            {
                method: 'XOAUTH2',
                username,
                accessToken
            },
            this.session,
            (err, response) => {
                if (err) {
                    this._server.logger.info(
                        {
                            err,
                            tnx: 'autherror',
                            cid: this.id,
                            method: 'XOAUTH2',
                            user: username
                        },
                        'Authentication error for %s using %s. %s',
                        username,
                        'XOAUTH2',
                        err.message
                    );
                    this.send(err.responseCode || 535, err.message);
                    return callback();
                }

                if (!response.user) {
                    this._server.logger.info(
                        {
                            tnx: 'authfail',
                            cid: this.id,
                            method: 'XOAUTH2',
                            user: username
                        },
                        'Authentication failed for %s using %s',
                        username,
                        'XOAUTH2'
                    );
                    this._nextHandler = SASL.XOAUTH2_error.bind(this);
                    this.send(response.responseCode || 334, Buffer.from(JSON.stringify(response.data || {})).toString('base64'));
                    return callback();
                }

                this._server.logger.info(
                    {
                        tnx: 'auth',
                        cid: this.id,
                        method: 'XOAUTH2',
                        user: username
                    },
                    '%s authenticated using %s',
                    username,
                    'XOAUTH2'
                );
                this.session.user = response.user;
                this.session.transmissionType = this._transmissionType();

                this.send(235, 'Authentication successful');
                callback();
            }
        );
    },

    XOAUTH2_error(data, callback) {
        this.send(535, 'Error: Username and Password not accepted');
        return callback();
    },

    'CRAM-MD5_token'(canAbort, challenge, token, callback) {
        token = (token || '').toString().trim();

        if (canAbort && token === '*') {
            this.send(501, 'Authentication aborted');
            return callback();
        }

        let tokenParts = Buffer.from(token, 'base64').toString().split(' ');
        let username = tokenParts.shift();
        let challengeResponse = (tokenParts.shift() || '').toLowerCase();

        this._server.onAuth(
            {
                method: 'CRAM-MD5',
                username,
                challenge,
                challengeResponse,
                validatePassword(password) {
                    let hmac = crypto.createHmac('md5', password);
                    return hmac.update(challenge).digest('hex').toLowerCase() === challengeResponse;
                }
            },
            this.session,
            (err, response) => {
                if (err) {
                    this._server.logger.info(
                        {
                            err,
                            tnx: 'autherror',
                            cid: this.id,
                            method: 'CRAM-MD5',
                            user: username
                        },
                        'Authentication error for %s using %s. %s',
                        username,
                        'CRAM-MD5',
                        err.message
                    );
                    this.send(err.responseCode || 535, err.message);
                    return callback();
                }

                if (!response.user) {
                    this._server.logger.info(
                        {
                            tnx: 'authfail',
                            cid: this.id,
                            method: 'CRAM-MD5',
                            user: username
                        },
                        'Authentication failed for %s using %s',
                        username,
                        'CRAM-MD5'
                    );
                    this.send(response.responseCode || 535, response.message || 'Error: Authentication credentials invalid');
                    return callback();
                }

                this._server.logger.info(
                    {
                        tnx: 'auth',
                        cid: this.id,
                        method: 'CRAM-MD5',
                        user: username
                    },
                    '%s authenticated using %s',
                    username,
                    'CRAM-MD5'
                );
                this.session.user = response.user;
                this.session.transmissionType = this._transmissionType();

                this.send(235, 'Authentication successful');
                callback();
            }
        );
    },

    // this is not a real auth but a username validation initiated by SMTP proxy
    SASL_XCLIENT(args, callback) {
        const username = ((args && args[0]) || '').toString().trim();
        this._server.onAuth(
            {
                method: 'XCLIENT',
                username,
                password: null
            },
            this.session,
            (err, response) => {
                if (err) {
                    this._server.logger.info(
                        {
                            err,
                            tnx: 'autherror',
                            cid: this.id,
                            method: 'XCLIENT',
                            user: username
                        },
                        'Authentication error for %s using %s. %s',
                        username,
                        'XCLIENT',
                        err.message
                    );
                    return callback(err);
                }

                if (!response.user) {
                    this._server.logger.info(
                        {
                            tnx: 'authfail',
                            cid: this.id,
                            method: 'XCLIENT',
                            user: username
                        },
                        'Authentication failed for %s using %s',
                        username,
                        'XCLIENT'
                    );
                    return callback(new Error('Authentication credentials invalid'));
                }

                this._server.logger.info(
                    {
                        tnx: 'auth',
                        cid: this.id,
                        method: 'XCLIENT',
                        user: username
                    },
                    '%s authenticated using %s',
                    username,
                    'XCLIENT'
                );

                this.session.user = response.user;
                this.session.transmissionType = this._transmissionType();

                callback();
            }
        );
    }
});
