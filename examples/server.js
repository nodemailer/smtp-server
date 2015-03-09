'use strict';

// Replace '../lib/smtp-server' with 'smtp-server' when running this script outside this directory
var SMTPServer = require('../lib/smtp-server').SMTPServer;

var SERVER_PORT = 1337;
var SERVER_HOST = '0.0.0.0';

// Connect to this example server by running
//   telnet localhost 1337
// or
//   nc -c localhost 1337

// Authenticate with this command (username is 'testuser' and password is 'testpass')
//   AUTH PLAIN dGVzdHVzZXIAdGVzdHVzZXIAdGVzdHBhc3M=

// Setup server
var server = new SMTPServer({

    // not required but nice-to-have
    banner: 'Welcome to My Awesome SMTP Server',

    // disable STARTTLS to allow authentication in clear text mode
    disabledCommands: ['STARTTLS'],

    // Setup authentication
    // Allow only users with username 'testuser' and password 'testpass'
    onAuth: function(auth, session, callback) {
        if (auth.username !== 'testuser' && auth.password !== 'testpass') {
            callback(new Error('Authentication failed'));
        }

        return callback(null, {
            user: 'userdata' // value could be an user id, or an user object etc. This value can be accessed from session.user afterwards
        });
    },

    // Validate MAIL FROM envelope address. Example allows all addresses that do not start with 'deny'
    // If this method is not set, all addresses are allowed
    onMailFrom: function(address, session, callback) {
        if (/^deny/i.test(address.address)) {
            return callback(new Error('Not accepted'));
        }
        callback();
    },

    // Validate RCPT TO envelope address. Example allows all addresses that do not start with 'deny'
    // If this method is not set, all addresses are allowed
    onRcptTo: function(address, session, callback) {
        if (/^deny/i.test(address.address)) {
            return callback(new Error('Not accepted'));
        }
        callback();
    },

    // Handle message stream
    onData: function(stream, session, callback) {
        stream.pipe(process.stdout);
        stream.on('end', callback); // accept the message once the stream is ended
    }
});

server.on('error', function(err) {
    console.log('Error occurred');
    console.log(err);
});

// start listening
server.listen(SERVER_PORT, SERVER_HOST);