// Test script for issue #181 fix
'use strict';

const SMTPServer = require('../lib/smtp-server').SMTPServer;
const net = require('net');

// Create SMTP server
const server = new SMTPServer({
    logger: {
        info: console.info,
        debug: console.debug,
        error: console.error
    },
    onConnect: (session, callback) => {
        console.log('Client connected with session:', session.id);
        callback();
    }
});

// Start server on a random port
server.listen(0, '127.0.0.1', () => {
    const address = server.server.address();
    console.log(`SMTP Server listening on [${address.address}]:${address.port}`);

    // Test the server shutdown behavior
    console.log('Starting server shutdown test...');

    // Connect a client
    const client = net.createConnection(address.port, address.address, () => {
        console.log('Client connected to server');

        // Set up data handler
        client.on('data', (data) => {
            const response = data.toString();
            console.log('Server response:', response);

            // After receiving the greeting, initiate server shutdown and try to send a command
            if (response.startsWith('220')) {
                console.log('Initiating server shutdown...');

                // Trigger server shutdown
                server.close(() => {
                    console.log('Server shutdown complete');
                });

                // Wait a moment and then try to send a command
                setTimeout(() => {
                    console.log('Sending HELO command during shutdown...');
                    client.write('HELO example.com\r\n');

                    // Wait for response and then close client
                    setTimeout(() => {
                        console.log('Test complete - client disconnecting');
                        client.end();
                    }, 500);
                }, 100);
            }
        });
    });

    client.on('close', () => {
        console.log('Client connection closed');
        process.exit(0);
    });

    client.on('error', (err) => {
        console.error('Client error:', err.message);
    });
});

// Handle errors
server.on('error', err => {
    console.error('SMTP Server error:', err);
});
