'use strict';

// Replays the same SMTP commands against smtp-server and a Postfix reference
// server and shows where the replies differ. This is a development aid for
// checking what RFC compliant replies look like, not a test suite: Postfix has
// its own policies and extensions, so a difference is a hint to check the RFC,
// not proof that smtp-server is wrong.
//
// Usage: node compare/compare.js [options] compare/scenarios/*.txt
//
//   --help          show this text
//   --text          compare the reply text too, not only the reply and enhanced codes
//   --capabilities  compare the EHLO capability lists (they differ by design)
//   --all           also print the steps where both servers agree
//   --host HOST     Postfix host (default 127.0.0.1)
//   --port PORT     Postfix port (default 32025, see compare/postfix.sh)
//   --timeout MS    how long to wait for a reply (default 3000)
//   --settle MS     how long to wait for more replies after one arrived (default 150)
//
// Scenario files have one step per line:
//
//   # comment         ignored, as are empty lines
//   COMMAND ARGS      sent with CRLF, the replies are recorded
//   > raw text        sent as is without a CRLF; \r, \n, \t and \xHH are unescaped
//   !wait MS          pause
//   !reconnect        close the connection and open a new one
//   !server {json}    smtp-server options for this scenario (first lines only)

const fs = require('fs');
const net = require('net');
const path = require('path');
const { parseArgs } = require('util');
const { SMTPServer } = require('../lib/smtp-server');

const HOSTNAMES = /\b(?:postfix|smtp-server)\.example\.com\b/gi;

// smtp-server configured to match compare/Dockerfile as closely as possible
const SERVER_OPTIONS = {
    name: 'smtp-server.example.com',
    logger: false,
    disableReverseLookup: true,
    size: 1048576,
    hideENHANCEDSTATUSCODES: false,
    hideDSN: false,
    disabledCommands: ['STARTTLS'],
    useXClient: true,
    useXForward: true,
    authMethods: ['PLAIN', 'LOGIN'],
    authOptional: true,
    allowInsecureAuth: true,
    onAuth(auth, session, callback) {
        if (auth.username === 'user' && auth.password === 'pass') {
            return callback(null, { user: auth.username });
        }
        let err = new Error('Error: authentication failed');
        err.responseCode = 535;
        callback(err);
    },
    onData(stream, session, callback) {
        stream.on('data', () => false);
        stream.on('end', () => callback());
    }
};

/**
 * Parses a scenario file into steps
 */
function parseScenario(text) {
    let steps = [];
    let options = {};
    text.split(/\r?\n/).forEach((line, i) => {
        let number = i + 1;
        if (!line.trim() || /^\s*#/.test(line)) {
            return;
        }
        let directive = line.match(/^!(\w+)\s*(.*)$/);
        if (directive) {
            switch (directive[1]) {
                case 'wait':
                    return steps.push({ type: 'wait', ms: Number(directive[2]) || 0, line: number, label: line });
                case 'reconnect':
                    return steps.push({ type: 'reconnect', line: number, label: line });
                case 'server':
                    options = Object.assign(options, JSON.parse(directive[2]));
                    return;
            }
            throw new Error('Line ' + number + ': unknown directive ' + directive[1]);
        }
        if (line.startsWith('>')) {
            let raw = line
                .slice(1)
                .replace(/^ /, '')
                .replace(
                    /\\(r|n|t|x[0-9a-fA-F]{2}|\\)/g,
                    (m, c) => ({ r: '\r', n: '\n', t: '\t', '\\': '\\' })[c] || String.fromCharCode(parseInt(c.slice(1), 16))
                );
            return steps.push({ type: 'send', raw: true, data: Buffer.from(raw, 'binary'), line: number, label: line });
        }
        steps.push({ type: 'send', data: Buffer.from(line + '\r\n', 'binary'), line: number, label: line });
    });
    return { steps, options };
}

/**
 * A connection that collects complete reply blocks
 */
class Session {
    constructor(socket) {
        this.socket = socket;
        this.buffer = '';
        this.replies = [];
        this.closed = false;
        this.reportedClose = false;
        this.onChange = () => false;

        socket.on('data', chunk => {
            this.buffer += chunk.toString('binary');
            let match;
            while ((match = this.buffer.match(/^(?:\d{3}-[^\n]*\n)*\d{3}(?: [^\n]*)?\r?\n/))) {
                this.replies.push(
                    Buffer.from(match[0], 'binary')
                        .toString()
                        .replace(/\r?\n$/, '')
                );
                this.buffer = this.buffer.slice(match[0].length);
            }
            this.onChange();
        });
        socket.on('error', () => false);
        socket.on('close', () => {
            this.closed = true;
            this.onChange();
        });
    }

    static connect(host, port) {
        return new Promise((resolve, reject) => {
            let socket = net.connect(port, host, () => {
                socket.removeListener('error', reject);
                resolve(new Session(socket));
            });
            socket.once('error', reject);
        });
    }

    /**
     * Resolves with the replies that arrive until the connection is quiet for
     * `settle` ms after at least one reply, or until `timeout` without any
     */
    collect(timeout, settle) {
        return new Promise(resolve => {
            let timer;
            let finish = () => {
                clearTimeout(timer);
                this.onChange = () => false;
                let replies = this.replies;
                this.replies = [];
                if (this.closed && !this.reportedClose) {
                    this.reportedClose = true;
                    replies.push('(connection closed)');
                }
                resolve(replies);
            };
            let arm = () => {
                clearTimeout(timer);
                timer = setTimeout(finish, this.replies.length || this.closed ? settle : timeout);
            };
            this.onChange = arm;
            arm();
        });
    }

    close() {
        this.socket.destroy();
    }
}

/**
 * Runs all steps against one server, resolves with the replies of every step
 */
async function runTarget(host, port, steps, options) {
    let session = await Session.connect(host, port);
    let results = [{ label: '(greeting)', replies: await session.collect(options.timeout, options.settle) }];

    for (let step of steps) {
        let replies = [];
        switch (step.type) {
            case 'wait':
                await new Promise(resolve => setTimeout(resolve, step.ms));
                continue;
            case 'reconnect':
                session.close();
                session = await Session.connect(host, port);
                replies = await session.collect(options.timeout, options.settle);
                break;
            case 'send':
                if (!session.closed) {
                    session.socket.write(step.data);
                }
                // a raw step may legitimately get no reply (message content)
                replies = await session.collect(step.raw ? options.settle * 2 : options.timeout, options.settle);
                break;
        }
        results.push({ label: step.label, replies });
    }

    session.close();
    return results;
}

/**
 * Reduces a reply to what is compared: the reply code and enhanced status code
 * of every line, plus the text if requested. EHLO capabilities are compared as
 * a sorted list since their order is not significant.
 */
function normalizeReply(reply, options) {
    if (reply.startsWith('(')) {
        return reply;
    }
    let lines = reply.split(/\r?\n/);
    let code = lines[0].slice(0, 3);
    if (lines.length > 1 && code === '250') {
        if (!options.capabilities) {
            return code + ' [capabilities]';
        }
        let capabilities = lines
            .slice(1)
            .map(line => line.slice(4).trim().toUpperCase())
            .sort();
        return code + ' [' + capabilities.join(', ') + ']';
    }
    return lines
        .map(line => {
            let match = line.match(/^(\d{3})[ -]?(\d\.\d{1,3}\.\d{1,3})?\s*(.*)$/);
            let parts = [match[1]];
            if (match[2]) {
                parts.push(match[2]);
            }
            if (options.text) {
                parts.push(match[3].replace(HOSTNAMES, 'HOST'));
            }
            return parts.join(' ');
        })
        .join(' | ');
}

async function compareScenario(file, options) {
    let { steps, options: serverOptions } = parseScenario(fs.readFileSync(file, 'utf-8'));

    let server = new SMTPServer(Object.assign({}, SERVER_OPTIONS, serverOptions));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    let ours;
    let theirs;
    try {
        [ours, theirs] = await Promise.all([
            runTarget('127.0.0.1', server.server.address().port, steps, options),
            runTarget(options.host, options.port, steps, options)
        ]);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }

    // collected and printed by the caller, scenarios run concurrently
    let output = [];
    let print = line => output.push(line);

    print('== ' + path.relative(process.cwd(), file));
    let differences = 0;
    ours.forEach((step, i) => {
        let a = step.replies.map(reply => normalizeReply(reply, options)).join(' || ') || '(no reply)';
        let b = theirs[i].replies.map(reply => normalizeReply(reply, options)).join(' || ') || '(no reply)';
        let label = step.label.length > 60 ? step.label.slice(0, 57) + '...' : step.label;
        if (a === b) {
            if (options.all) {
                print('  ok    ' + label.padEnd(60) + ' ' + a);
            }
            return;
        }
        differences++;
        print('  DIFF  ' + label);
        print('          smtp-server: ' + step.replies.join(' || ').replace(/\r?\n/g, ' / '));
        print('          postfix:     ' + theirs[i].replies.join(' || ').replace(/\r?\n/g, ' / '));
    });
    print('  ' + differences + ' of ' + ours.length + ' steps differ\n');
    return { output, differences };
}

async function main() {
    let { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            help: { type: 'boolean', default: false },
            text: { type: 'boolean', default: false },
            capabilities: { type: 'boolean', default: false },
            all: { type: 'boolean', default: false },
            host: { type: 'string', default: '127.0.0.1' },
            port: { type: 'string', default: process.env.SMTP_SERVER_POSTFIX_PORT || '32025' },
            timeout: { type: 'string', default: '3000' },
            settle: { type: 'string', default: '150' }
        }
    });

    if (values.help) {
        // the usage notes at the top of this file
        let usage = fs.readFileSync(__filename, 'utf-8').match(/^\/\/ Usage:[\s\S]*?(?=\n\n)/m)[0];
        return console.log(usage.replace(/^\/\/ ?/gm, ''));
    }

    let files = positionals.length ? positionals : fs.readdirSync(path.join(__dirname, 'scenarios')).map(file => path.join(__dirname, 'scenarios', file));
    let options = Object.assign({}, values, { port: Number(values.port), timeout: Number(values.timeout), settle: Number(values.settle) });

    let results = await Promise.all(
        files
            .filter(file => file.endsWith('.txt'))
            .sort()
            .map(file => compareScenario(file, options))
    );
    let total = 0;
    for (let { output, differences } of results) {
        console.log(output.join('\n'));
        total += differences;
    }
    console.log(total + ' difference' + (total === 1 ? '' : 's') + ' in total');
}

if (require.main === module) {
    main().catch(err => {
        console.error(err.message);
        if (err.code === 'ECONNREFUSED') {
            console.error('Is the reference server running? Start it with: npm run postfix:start');
        }
        process.exitCode = 1;
    });
}

module.exports = { parseScenario, normalizeReply };
