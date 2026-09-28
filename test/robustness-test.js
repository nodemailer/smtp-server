/* eslint no-unused-expressions:0, prefer-arrow-callback: 0 */

'use strict';

const chai = require('chai');
const net = require('net');
const SMTPServer = require('../lib/smtp-server').SMTPServer;

const expect = chai.expect;

chai.config.includeStack = true;

// a response block is complete once it ends with a final (non-continuation) line
const FINAL_RESPONSE = /^\d{3} .*\r\n$/m;

/**
 * Opens a plaintext connection, waits for the greeting and then sends each
 * command after the previous response block completed. Calls back with the
 * final line of every response block, the greeting included.
 */
function converse(port, commands, callback) {
    let socket = net.connect(port, '127.0.0.1');
    let data = '';
    let lines = [];
    let sent = 0;
    let finished = false;

    let finish = err => {
        if (finished) {
            return;
        }
        finished = true;
        socket.destroy();
        callback(err, lines);
    };

    socket.on('data', chunk => {
        data += chunk.toString();
        if (!FINAL_RESPONSE.test(data)) {
            return;
        }
        lines.push(data.trim().split(/\r\n/).pop());
        data = '';
        if (sent < commands.length) {
            return socket.write(commands[sent++] + '\r\n');
        }
        finish();
    });
    socket.on('error', finish);
    socket.on('close', () => finish());
}

/**
 * Connects and sends nothing (or only what is given). Calls back with the time
 * it took for the server to close the socket and whatever the server sent.
 */
function idleClient(port, payload, callback) {
    let start = Date.now();
    let socket = net.connect(port, '127.0.0.1');
    let received = '';
    socket.on('connect', () => {
        if (payload) {
            socket.write(payload);
        }
    });
    socket.on('data', chunk => {
        received += chunk.toString();
    });
    socket.on('error', () => false);
    socket.on('close', () => callback(Date.now() - start, received));
}

function listen(server, done) {
    server.listen(0, '127.0.0.1', () => done(server.server.address().port));
}

describe('Robustness', function () {
    this.timeout(10 * 1000); // eslint-disable-line no-invalid-this

    describe('Parameters without a value', function () {
        let server;
        let port;

        before(function (done) {
            server = new SMTPServer({
                logger: false,
                disabledCommands: ['AUTH', 'STARTTLS'],
                hideDSN: false,
                size: 1024
            });
            listen(server, p => {
                port = p;
                done();
            });
        });

        after(function (done) {
            server.close(done);
        });

        for (let param of ['BODY', 'BODY=', 'RET', 'ENVID', 'SIZE']) {
            it('should answer 501 to MAIL FROM with a valueless ' + param + ' and keep serving', function (done) {
                converse(port, ['EHLO x', 'MAIL FROM:<a@b.c> ' + param, 'MAIL FROM:<a@b.c>', 'QUIT'], (err, lines) => {
                    expect(err).to.not.exist;
                    expect(lines[2]).to.match(/^501 /);
                    expect(lines[3]).to.match(/^250 /);
                    expect(lines[4]).to.match(/^221 /);
                    done();
                });
            });
        }

        for (let param of ['NOTIFY', 'ORCPT']) {
            it('should answer 501 to RCPT TO with a valueless ' + param + ' and keep serving', function (done) {
                converse(port, ['EHLO x', 'MAIL FROM:<a@b.c>', 'RCPT TO:<x@y.z> ' + param, 'RCPT TO:<x@y.z>', 'QUIT'], (err, lines) => {
                    expect(err).to.not.exist;
                    expect(lines[3]).to.match(/^501 /);
                    expect(lines[4]).to.match(/^250 /);
                    expect(lines[5]).to.match(/^221 /);
                    done();
                });
            });
        }

        it('should still accept valueless flags such as SMTPUTF8', function (done) {
            converse(port, ['EHLO x', 'MAIL FROM:<a@b.c> SMTPUTF8', 'QUIT'], (err, lines) => {
                expect(err).to.not.exist;
                expect(lines[2]).to.match(/^250 /);
                done();
            });
        });
    });

    describe('Command handler that throws', function () {
        let server;
        let port;
        let errors = [];

        before(function (done) {
            server = new SMTPServer({
                logger: {
                    info: () => false,
                    debug: () => false,
                    warn: () => false,
                    trace: () => false,
                    fatal: () => false,
                    error: (...args) => errors.push(args)
                },
                disabledCommands: ['AUTH', 'STARTTLS'],
                onMailFrom(address) {
                    if (address.address === 'throw@b.c') {
                        throw new Error('Handler bug');
                    }
                    return arguments[2]();
                }
            });
            listen(server, p => {
                port = p;
                done();
            });
        });

        after(function (done) {
            server.close(done);
        });

        it('should answer 451 and keep the server and the connection up', function (done) {
            converse(port, ['EHLO x', 'MAIL FROM:<throw@b.c>', 'MAIL FROM:<ok@b.c>', 'QUIT'], (err, lines) => {
                expect(err).to.not.exist;
                expect(lines[2]).to.match(/^451 /);
                expect(lines[3]).to.match(/^250 /);
                expect(lines[4]).to.match(/^221 /);
                expect(errors.some(args => args.some(arg => typeof arg === 'string' && /Handler bug/.test(arg)))).to.be.true;

                // a fresh connection still works
                converse(port, ['EHLO x', 'QUIT'], (err, lines) => {
                    expect(err).to.not.exist;
                    expect(lines[0]).to.match(/^220 /);
                    expect(lines[2]).to.match(/^221 /);
                    done();
                });
            });
        });
    });

    describe('Command line length', function () {
        let server;
        let port;

        before(function (done) {
            server = new SMTPServer({
                logger: false,
                disabledCommands: ['AUTH', 'STARTTLS']
            });
            listen(server, p => {
                port = p;
                done();
            });
        });

        after(function (done) {
            server.close(done);
        });

        it('should reject an over-long command line that arrives complete in one chunk', function (done) {
            let socket = net.connect(port, '127.0.0.1');
            let received = '';
            let written = false;
            socket.on('data', chunk => {
                received += chunk.toString();
                if (!written && /^220 /m.test(received)) {
                    written = true;
                    // a single write so the line, CRLF included, reaches the parser as one chunk
                    socket.write('NOOP ' + 'x'.repeat(17000) + '\r\n');
                }
            });
            socket.on('error', () => false);
            socket.on('close', () => {
                expect(received).to.match(/Command line too long/);
                done();
            });
        });

        it('should accept a line at the limit', function (done) {
            converse(port, ['EHLO x', 'NOOP ' + 'x'.repeat(16000), 'QUIT'], (err, lines) => {
                expect(err).to.not.exist;
                expect(lines[2]).to.match(/^250 /);
                done();
            });
        });
    });

    describe('Sockets that never reach the SMTP session', function () {
        for (let [label, payload] of [
            ['never sends the header', false],
            ['sends a partial header slowly', 'PROXY TCP4 ']
        ]) {
            it('should drop a PROXY client that ' + label, function (done) {
                let server = new SMTPServer({
                    logger: false,
                    useProxy: true,
                    socketTimeout: 300
                });
                listen(server, port => {
                    idleClient(port, payload, (elapsed, received) => {
                        expect(elapsed).to.be.below(3000);
                        expect(received).to.equal('');
                        server.close(done);
                    });
                });
            });
        }

        it('should drop an implicit TLS client that never completes the handshake', function (done) {
            let server = new SMTPServer({
                logger: false,
                secure: true,
                socketTimeout: 300
            });
            server.on('error', () => false);
            listen(server, port => {
                // a partial record header, the handshake can never finish
                idleClient(port, Buffer.from([0x16, 0x03]), elapsed => {
                    expect(elapsed).to.be.below(3000);
                    server.close(done);
                });
            });
        });

        it('should drop an implicit TLS client that trickles a handshake that never completes', function (done) {
            let server = new SMTPServer({
                logger: false,
                secure: true,
                socketTimeout: 500
            });
            server.on('error', () => false);
            listen(server, port => {
                let start = Date.now();
                let socket = net.connect(port, '127.0.0.1');
                // a record header announcing a large ClientHello, then one byte at a
                // time so the idle timeout of the raw socket never fires
                let timer;
                socket.on('connect', () => {
                    socket.write(Buffer.from([0x16, 0x03, 0x01, 0x40, 0x00]));
                    timer = setInterval(() => socket.write(Buffer.from([0x00])), 100);
                });
                socket.on('error', () => false);
                socket.on('close', () => {
                    clearInterval(timer);
                    expect(Date.now() - start).to.be.below(3000);
                    server.close(done);
                });
            });
        });

        it('should keep a working session after the PROXY header arrived', function (done) {
            let server = new SMTPServer({
                logger: false,
                useProxy: true,
                disabledCommands: ['AUTH', 'STARTTLS'],
                socketTimeout: 300
            });
            listen(server, port => {
                idleClient(port, 'PROXY TCP4 198.51.100.22 203.0.113.7 35646 25\r\n', (elapsed, received) => {
                    // the session timeout (421) is what closed it, not the pre-connect guard
                    expect(received).to.match(/^220 /);
                    expect(received).to.match(/421 Timeout/);
                    server.close(done);
                });
            });
        });

        it('should not guard plain sockets that go straight to the SMTP session', function (done) {
            let server = new SMTPServer({
                logger: false,
                disabledCommands: ['AUTH', 'STARTTLS']
            });
            let pendingOnAccept = [];
            // runs right after the accept handler, before connect() is reached
            server.server.on('connection', () => pendingOnAccept.push(server._pendingSockets.size));
            listen(server, port => {
                idleClient(port, 'QUIT\r\n', () => {
                    expect(pendingOnAccept).to.deep.equal([0]);
                    server.close(done);
                });
            });
        });

        it('should limit sockets waiting for the PROXY header to maxClients', function (done) {
            let server = new SMTPServer({
                logger: false,
                useProxy: true,
                maxClients: 2,
                socketTimeout: 2000
            });
            listen(server, port => {
                let sockets = [];
                let opened = 0;
                for (let i = 0; i < 2; i++) {
                    let socket = net.connect(port, '127.0.0.1', () => {
                        if (++opened === 2) {
                            // wait until the server registered both before opening the third
                            let deadline = Date.now() + 3000;
                            let poll = () => {
                                if (server._pendingSockets.size < 2) {
                                    if (Date.now() > deadline) {
                                        return done(new Error('server did not register both pending sockets'));
                                    }
                                    return setTimeout(poll, 10);
                                }
                                idleClient(port, false, elapsed => {
                                    // refused at once, not after the socket timeout
                                    expect(elapsed).to.be.below(1000);
                                    sockets.forEach(s => s.destroy());
                                    server.close(done);
                                });
                            };
                            poll();
                        }
                    });
                    socket.on('error', () => false);
                    sockets.push(socket);
                }
            });
        });
    });
});
