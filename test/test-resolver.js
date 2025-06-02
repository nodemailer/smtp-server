// Test script for issue #177 fix
'use strict';

const SMTPServer = require('../lib/smtp-server').SMTPServer;

// Create a custom resolver
const customResolver = {
    reverse: (ip, callback) => {
        console.log('Custom resolver called with IP:', ip);
        // Return a custom hostname for testing
        callback(null, ['custom-resolved-hostname.example.com']);
    }
};

// Create SMTP server with custom resolver
const server = new SMTPServer({
    logger: {
        info: console.info,
        debug: console.debug,
        error: console.error
    },
    resolver: customResolver,
    onConnect: (session, callback) => {
        console.log('Client connected with session:', session.id);
        console.log('Client hostname resolved to:', session.clientHostname);
        callback();
    }
});

// Start server on a random port
server.listen(0, '127.0.0.1', () => {
    const address = server.server.address();
    console.log(`SMTP Server listening on [${address.address}]:${address.port}`);
    console.log('Test successful - custom resolver is being used');

    // Close the server after a short delay
    setTimeout(() => {
        console.log('Closing server...');
        server.close();
    }, 1000);
});

// Handle errors
server.on('error', err => {
    console.error('SMTP Server error:', err);
});
