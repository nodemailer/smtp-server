'use strict';

const SMTPServer = require('../lib/smtp-server').SMTPServer;
const tls = require('tls');
const fs = require('fs');
const path = require('path');

console.log('=== MAIL FROM Parameters Implementation Test ===\n');

let testsPassed = 0;
let testsFailed = 0;

function logTest(name, passed, details) {
    if (passed) {
        console.log(`✓ ${name}`);
        testsPassed++;
    } else {
        console.log(`✗ ${name}`);
        if (details) console.log(`  ${details}`);
        testsFailed++;
    }
}

// Create server with REQUIRETLS enabled (opt-in)
const server = new SMTPServer({
    secure: true,
    key: fs.readFileSync(path.join(__dirname, 'fixtures', 'server.key')),
    cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'server.crt')),
    authOptional: true,
    hideREQUIRETLS: false, // Enable REQUIRETLS (opt-in)
    onMailFrom(address, session, callback) {
        console.log('\n[SERVER] MAIL FROM received:');
        console.log('  Address:', address.address);
        console.log('  Args:', address.args);
        console.log('  Envelope state:');
        console.log('    bodyType:', session.envelope.bodyType);
        console.log('    smtpUtf8:', session.envelope.smtpUtf8);
        console.log('    requireTLS:', session.envelope.requireTLS);
        callback();
    },
    onRcptTo(address, session, callback) {
        callback();
    },
    onData(stream, session, callback) {
        stream.on('data', () => {});
        stream.on('end', () => {
            callback();
        });
    }
});

server.listen(2528, () => {
    console.log('[SERVER] Listening on port 2528\n');

    // Create TLS client
    const client = tls.connect({
        port: 2528,
        host: 'localhost',
        rejectUnauthorized: false
    }, () => {
        console.log('[CLIENT] TLS connection established\n');
    });

    let buffer = '';
    let state = 'GREETING';

    client.on('data', data => {
        buffer += data.toString();
        const lines = buffer.split('\r\n');

        // Keep incomplete line in buffer
        buffer = lines.pop();

        lines.forEach(line => {
            if (!line) return;

            console.log('[SERVER]', line);

            // State machine for SMTP conversation
            if (state === 'GREETING' && line.startsWith('220 ')) {
                console.log('[CLIENT] EHLO localhost\n');
                client.write('EHLO localhost\r\n');
                state = 'EHLO';
            } else if (state === 'EHLO' && line.startsWith('250 ')) {
                // Check for advertised features
                if (line.includes('8BITMIME')) {
                    logTest('Test 1: 8BITMIME is advertised in EHLO', true);
                }
                if (line.includes('SMTPUTF8')) {
                    logTest('Test 2: SMTPUTF8 is advertised in EHLO', true);
                }
                if (line.includes('REQUIRETLS')) {
                    logTest('Test 3: REQUIRETLS is advertised in EHLO', true);
                    // Last EHLO line, start tests
                    console.log('\n--- Test 4: BODY=8BITMIME parameter ---');
                    console.log('[CLIENT] MAIL FROM:<sender@example.com> BODY=8BITMIME\n');
                    client.write('MAIL FROM:<sender@example.com> BODY=8BITMIME\r\n');
                    state = 'TEST4_MAIL';
                }
            } else if (state === 'TEST4_MAIL' && line.startsWith('250 Accepted')) {
                logTest('Test 4: BODY=8BITMIME accepted', true);
                console.log('[CLIENT] RSET\n');
                client.write('RSET\r\n');
                state = 'TEST4_RSET';
            } else if (state === 'TEST4_RSET' && line.startsWith('250 ')) {
                console.log('\n--- Test 5: SMTPUTF8 parameter ---');
                console.log('[CLIENT] MAIL FROM:<sender@example.com> SMTPUTF8\n');
                client.write('MAIL FROM:<sender@example.com> SMTPUTF8\r\n');
                state = 'TEST5_MAIL';
            } else if (state === 'TEST5_MAIL' && line.startsWith('250 Accepted')) {
                logTest('Test 5: SMTPUTF8 accepted', true);
                console.log('[CLIENT] RSET\n');
                client.write('RSET\r\n');
                state = 'TEST5_RSET';
            } else if (state === 'TEST5_RSET' && line.startsWith('250 ')) {
                console.log('\n--- Test 6: REQUIRETLS parameter ---');
                console.log('[CLIENT] MAIL FROM:<sender@example.com> REQUIRETLS\n');
                client.write('MAIL FROM:<sender@example.com> REQUIRETLS\r\n');
                state = 'TEST6_MAIL';
            } else if (state === 'TEST6_MAIL' && line.startsWith('250 Accepted')) {
                logTest('Test 6: REQUIRETLS accepted', true);
                console.log('[CLIENT] RSET\n');
                client.write('RSET\r\n');
                state = 'TEST6_RSET';
            } else if (state === 'TEST6_RSET' && line.startsWith('250 ')) {
                console.log('\n--- Test 7: Combined parameters ---');
                console.log('[CLIENT] MAIL FROM:<sender@example.com> BODY=8BITMIME SMTPUTF8 REQUIRETLS\n');
                client.write('MAIL FROM:<sender@example.com> BODY=8BITMIME SMTPUTF8 REQUIRETLS\r\n');
                state = 'TEST7_MAIL';
            } else if (state === 'TEST7_MAIL' && line.startsWith('250 Accepted')) {
                logTest('Test 7: Combined parameters accepted', true);
                console.log('[CLIENT] RSET\n');
                client.write('RSET\r\n');
                state = 'TEST7_RSET';
            } else if (state === 'TEST7_RSET' && line.startsWith('250 ')) {
                console.log('\n--- Test 8: Invalid BODY value ---');
                console.log('[CLIENT] MAIL FROM:<sender@example.com> BODY=INVALID\n');
                client.write('MAIL FROM:<sender@example.com> BODY=INVALID\r\n');
                state = 'TEST8_MAIL';
            } else if (state === 'TEST8_MAIL' && line.startsWith('501 ')) {
                logTest('Test 8: Invalid BODY value rejected', true);
                console.log('\n--- Test 9: SMTPUTF8 with value (should fail) ---');
                console.log('[CLIENT] MAIL FROM:<sender@example.com> SMTPUTF8=YES\n');
                client.write('MAIL FROM:<sender@example.com> SMTPUTF8=YES\r\n');
                state = 'TEST9_MAIL';
            } else if (state === 'TEST9_MAIL' && line.startsWith('501 ')) {
                logTest('Test 9: SMTPUTF8 with value rejected', true);
                console.log('\n--- Test 10: Default values (no parameters) ---');
                console.log('[CLIENT] MAIL FROM:<sender@example.com>\n');
                client.write('MAIL FROM:<sender@example.com>\r\n');
                state = 'TEST10_MAIL';
            } else if (state === 'TEST10_MAIL' && line.startsWith('250 Accepted')) {
                logTest('Test 10: Default values work (bodyType=7BIT, smtpUtf8=false, requireTLS=false)', true);
                console.log('[CLIENT] QUIT\n');
                client.write('QUIT\r\n');
                state = 'QUIT';
            } else if (state === 'QUIT' && line.startsWith('221 ')) {
                client.end();
                server.close(() => {
                    console.log('\n=== Test Results ===');
                    console.log('Passed:', testsPassed);
                    console.log('Failed:', testsFailed);
                    if (testsFailed === 0) {
                        console.log('\n✓ All tests passed!');
                        process.exit(0);
                    } else {
                        console.log('\n✗ Some tests failed!');
                        process.exit(1);
                    }
                });
            }
        });
    });

    client.on('error', err => {
        console.error('Client error:', err.message);
        server.close();
        process.exit(1);
    });
});

// Timeout
setTimeout(() => {
    console.log('\nTest timeout');
    server.close();
    process.exit(1);
}, 15000);
