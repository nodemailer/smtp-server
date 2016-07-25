'use strict';

var util = require('util');
var crypto = require('crypto');

var SASL = module.exports = {

    SASL_PLAIN: function (args, callback) {
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

    SASL_LOGIN: function (args, callback) {
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

    SASL_XOAUTH2: function (args, callback) {
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

    'SASL_CRAM-MD5': function (args, callback) {
        if (args.length) {
            this.send(501, 'Error: syntax: AUTH CRAM-MD5');
            return callback();
        }

        var challenge = util.format('<%s%s@%s>',
            String(Math.random()).replace(/^[0\.]+/, '').substr(0, 8), // random numbers
            Math.floor(Date.now() / 1000), // timestamp
            this.name // hostname
        );

        this._nextHandler = SASL['CRAM-MD5_token'].bind(this, true, challenge);
        this.send(334, new Buffer(challenge).toString('base64'));
        return callback();
    },

    PLAIN_token: function (canAbort, token, callback) {
        token = (token || '').toString().trim();

        if (canAbort && token === '*') {
            this.send(501, 'Authentication aborted');
            return callback();
        }

        var data = new Buffer(token, 'base64').toString().split('\x00');

        if (data.length !== 3) {
            this.send(500, 'Error: invalid userdata');
            return callback();
        }

        var username = data[1] || data[0] || '';
        var password = data[2] || '';

        this._server.onAuth({
            method: 'PLAIN',
            username: username,
            password: password
        }, this.session, function (err, response) {

            if (err) {
                this._server.logger.info('[%s] Authentication error for %s using %s\n%s', this._id, username, 'PLAIN', err.message);
                this.send(err.responseCode || 535, err.message);
                return callback();
            }

            if (!response.user) {
                this._server.logger.info('[%s] Authentication failed for %s using %s', this._id, username, 'PLAIN');
                this.send(response.responseCode || 535, response.message || 'Error: Authentication credentials invalid');
                return callback();
            }

            this._server.logger.info('[%s] %s authenticated using %s', this._id, username, 'PLAIN');
            this.session.user = response.user;
            this.session.transmissionType = this._transmissionType();

            this.send(235, 'Authentication successful');
            callback();

        }.bind(this));
    },

    LOGIN_username: function (canAbort, username, callback) {
        username = (username || '').toString().trim();

        if (canAbort && username === '*') {
            this.send(501, 'Authentication aborted');
            return callback();
        }

        username = new Buffer(username, 'base64').toString();

        if (!username) {
            this.send(500, 'Error: missing username');
            return callback();
        }

        this._nextHandler = SASL.LOGIN_password.bind(this, username);
        this.send(334, 'UGFzc3dvcmQ6');
        return callback();
    },

    LOGIN_password: function (username, password, callback) {
        password = (password || '').toString().trim();

        if (password === '*') {
            this.send(501, 'Authentication aborted');
            return callback();
        }

        password = new Buffer(password, 'base64').toString();

        this._server.onAuth({
            method: 'LOGIN',
            username: username,
            password: password
        }, this.session, function (err, response) {

            if (err) {
                this._server.logger.info('[%s] Authentication error for %s using %s\n%s', this._id, username, 'LOGIN', err.message);
                this.send(err.responseCode || 535, err.message);
                return callback();
            }

            if (!response.user) {
                this._server.logger.info('[%s] Authentication failed for %s using %s', this._id, username, 'LOGIN');
                this.send(response.responseCode || 535, response.message || 'Error: Authentication credentials invalid');
                return callback();
            }

            this._server.logger.info('[%s] %s authenticated using %s', this._id, username, 'LOGIN');
            this.session.user = response.user;
            this.session.transmissionType = this._transmissionType();

            this.send(235, 'Authentication successful');
            callback();

        }.bind(this));
    },

    XOAUTH2_token: function (canAbort, token, callback) {
        token = (token || '').toString().trim();

        if (canAbort && token === '*') {
            this.send(501, 'Authentication aborted');
            return callback();
        }

        var username;
        var accessToken;

        // Find username and access token from the input
        new Buffer(token, 'base64').toString().split('\x01').forEach(function (part) {
            part = part.split('=');
            var key = part.shift().toLowerCase();
            var value = part.join('=').trim();

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

        this._server.onAuth({
            method: 'XOAUTH2',
            username: username,
            accessToken: accessToken
        }, this.session, function (err, response) {

            if (err) {
                this._server.logger.info('[%s] Authentication error for %s using %s\n%s', this._id, username, 'XOAUTH2', err.message);
                this.send(err.responseCode || 535, err.message);
                return callback();
            }

            if (!response.user) {
                this._server.logger.info('[%s] Authentication failed for %s using %s', this._id, username, 'XOAUTH2');
                this._nextHandler = SASL.XOAUTH2_error.bind(this);
                this.send(response.responseCode || 334, new Buffer(JSON.stringify(response.data || {})).toString('base64'));
                return callback();
            }

            this._server.logger.info('[%s] %s authenticated using %s', this._id, username, 'XOAUTH2');
            this.session.user = response.user;
            this.session.transmissionType = this._transmissionType();

            this.send(235, 'Authentication successful');
            callback();

        }.bind(this));
    },

    XOAUTH2_error: function (data, callback) {
        this.send(535, 'Error: Username and Password not accepted');
        return callback();
    },

    'CRAM-MD5_token': function (canAbort, challenge, token, callback) {
        token = (token || '').toString().trim();

        if (canAbort && token === '*') {
            this.send(501, 'Authentication aborted');
            return callback();
        }

        var tokenParts = new Buffer(token, 'base64').toString().split(' ');
        var username = tokenParts.shift();
        var challengeResponse = (tokenParts.shift() || '').toLowerCase();

        this._server.onAuth({
            method: 'CRAM-MD5',
            username: username,
            validatePassword: function (password) {
                var hmac = crypto.createHmac('md5', password);
                return hmac.update(challenge).digest('hex').toLowerCase() === challengeResponse;
            }
        }, this.session, function (err, response) {

            if (err) {
                this._server.logger.info('[%s] Authentication error for %s using %s\n%s', this._id, username, 'CRAM-MD5', err.message);
                this.send(err.responseCode || 535, err.message);
                return callback();
            }

            if (!response.user) {
                this._server.logger.info('[%s] Authentication failed for %s using %s', this._id, username, 'CRAM-MD5');
                this.send(response.responseCode || 535, response.message || 'Error: Authentication credentials invalid');
                return callback();
            }

            this._server.logger.info('[%s] %s authenticated using %s', this._id, username, 'CRAM-MD5');
            this.session.user = response.user;
            this.session.transmissionType = this._transmissionType();

            this.send(235, 'Authentication successful');
            callback();

        }.bind(this));
    }
};
