'use strict';

// Loads the CommonJS build the way EmailEngine's @yao-pkg/pkg binary does. Run with
// --no-experimental-require-module (`npm run test:cjs`) so an ES module anywhere in the
// require() graph, including the runtime dependencies, fails here instead of being loaded
// through require(esm). The smoke run starts a server and delivers one message to it.

const assert = require('node:assert/strict');
const pkg = require('../package.json');

const { SMTPServer } = require('../' + pkg.exports['.'].require);
const nodemailer = require('nodemailer');

let delivered = false;
process.on('exit', () => assert.ok(delivered, 'the message was not delivered'));

const server = new SMTPServer({
    logger: false,
    disabledCommands: ['STARTTLS'],
    authOptional: true,
    onData(stream, session, callback) {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => {
            assert.strictEqual(session.envelope.mailFrom.address, 'sender@example.com');
            assert.deepStrictEqual(
                session.envelope.rcptTo.map(rcpt => rcpt.address),
                ['recipient@jõgeva.ee']
            );
            assert.match(Buffer.concat(chunks).toString(), /^Subject: CommonJS smoke test$/m);
            callback();
        });
    }
});

server.on('error', err => {
    throw err;
});

server.listen(0, '127.0.0.1', () => {
    const transport = nodemailer.createTransport({ host: '127.0.0.1', port: server.server.address().port, ignoreTLS: true });
    transport.sendMail({ from: 'sender@example.com', to: 'recipient@jõgeva.ee', subject: 'CommonJS smoke test', text: 'Hello' }, (err, info) => {
        transport.close();
        server.close(() => {
            assert.ifError(err);
            assert.match(info.response, /^250 /);
            delivered = true;
            console.log('CommonJS build loads and works without require(esm)');
        });
    });
});
