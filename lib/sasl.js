'use strict';

var SASL = module.exports = {

    SASL_PLAIN: function(args, callback) {
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

    SASL_LOGIN: function(args, callback) {
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

    SASL_XOAUTH2: function(args, callback) {
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

    PLAIN_token: function(canAbort, token, callback) {
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

        this._server.logger.info('[%s] Trying to authenticate "%s"', this._id, username);
        this._server.onAuth({
            method: 'PLAIN',
            username: username,
            password: password
        }, this.session, function(err, response) {

            if (err) {
                this._server.logger.info('[%s] Authentication error for "%s"\n%s', this._id, username, err.message);
                this.send(err.responseCode || 535, err.message);
                return callback();
            }

            if (!response.user) {
                this.send(response.responseCode || 535, response.message || 'Error: Authentication credentials invalid');
                return callback();
            }

            this.session.user = response.user;

            this.send(235, 'Authentication successful');
            callback();

        }.bind(this));
    },

    LOGIN_username: function(canAbort, username, callback) {
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

    LOGIN_password: function(username, password, callback) {
        password = (password || '').toString().trim();

        if (password === '*') {
            this.send(501, 'Authentication aborted');
            return callback();
        }

        password = new Buffer(password, 'base64').toString();

        this._server.logger.info('[%s] Trying to authenticate "%s"', this._id, username);
        this._server.onAuth({
            method: 'LOGIN',
            username: username,
            password: password
        }, this.session, function(err, response) {

            if (err) {
                this._server.logger.info('[%s] Authentication error for "%s"\n%s', this._id, username, err.message);
                this.send(err.responseCode || 535, err.message);
                return callback();
            }

            if (!response.user) {
                this.send(response.responseCode || 535, response.message || 'Error: Authentication credentials invalid');
                return callback();
            }

            this.session.user = response.user;

            this.send(235, 'Authentication successful');
            callback();

        }.bind(this));
    },

    XOAUTH2_token: function(canAbort, token, callback) {
        token = (token || '').toString().trim();

        if (canAbort && token === '*') {
            this.send(501, 'Authentication aborted');
            return callback();
        }

        var username;
        var accessToken;

        // Find username and access token from the input
        new Buffer(token, 'base64').toString().split('\x01').forEach(function(part) {
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

        this._server.logger.info('[%s] Trying to authenticate "%s"', this._id, username);
        this._server.onAuth({
            method: 'XOAUTH2',
            username: username,
            accessToken: accessToken
        }, this.session, function(err, response) {

            if (err) {
                this._server.logger.info('[%s] Authentication error for "%s"\n%s', this._id, username, err.message);
                this.send(err.responseCode || 535, err.message);
                return callback();
            }

            if (!response.user) {
                this._nextHandler = SASL.XOAUTH2_error.bind(this);
                this.send(response.responseCode || 334, new Buffer(JSON.stringify(response.data || {})).toString('base64'));
                return callback();
            }

            this.session.user = response.user;

            this.send(235, 'Authentication successful');
            callback();

        }.bind(this));
    },

    XOAUTH2_error: function(data, callback) {
        this.send(535, 'Error: Username and Password not accepted');
        return callback();
    }
};