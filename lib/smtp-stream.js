'use strict';

const stream = require('stream');
const Writable = stream.Writable;
const PassThrough = stream.PassThrough;

// How many pipelined commands to dispatch synchronously before yielding to the
// event loop. Keeps a single chunk full of commands from blocking everything else
const MAX_SYNC_COMMANDS = 100;

// the sequence that ends the DATA payload
const END_SEQUENCE = Buffer.from('\r\n.\r\n');

/**
 * Incoming SMTP stream parser. Detects and emits commands. If switched to
 * data mode, emits unescaped data events until final .
 *
 * @constructor
 * @param {Object} [options] Optional Stream options object
 */
class SMTPStream extends Writable {
    constructor(options) {
        // init Writable
        super(options);

        // Indicates if the stream is currently in data mode
        this._dataMode = false;
        // Output stream for the current data mode
        this._dataStream = null;
        // How many bytes are allowed for a data stream
        this._maxBytes = Infinity;
        // How many bytes have been emitted to data stream
        this.dataBytes = 0;
        // True until the first payload byte of the current DATA command has been
        // consumed, either by emitting it or by stripping it as a dot-stuffing
        // escape. Only while this holds can a leading "." be an end-of-DATA
        // terminator rather than message content
        this._atDataStart = false;
        // Callback to run once data mode is finished
        this._continueCallback = false;
        // unprocessed chars from the last parsing iteration (used in command mode)
        this._remainder = '';
        // unprocessed bytes from the last parsing iteration (used in data mode)
        this._lastBytes = false;

        // Max allowed length for a single command line
        this._maxCommandLength = (options && options.maxCommandLength) || 4 * 1024;

        this.isClosed = false;

        // once the input stream ends, flush all output without expecting the newline
        this.on('finish', () => this._flushData());
    }

    /**
     * Placeholder command handler. Override this with your own.
     */
    oncommand(/* command, callback */) {
        throw new Error('Command handler is not set');
    }

    /**
     * Switch to data mode and return output stream. The dots in the stream are unescaped.
     *
     * @returns {Stream} Data stream
     */
    startDataMode(maxBytes) {
        this._dataMode = true;
        this._maxBytes = (maxBytes && Number(maxBytes)) || Infinity;
        this.dataBytes = 0;
        this._atDataStart = true;
        this._dataStream = new PassThrough();
        this._dataStream.byteLength = 0;
        this._dataStream.sizeExceeded = false;

        return this._dataStream;
    }

    /**
     * Call this once data mode is over and you have finished processing the data stream
     */
    continue() {
        if (typeof this._continueCallback === 'function') {
            this._continueCallback();
            this._continueCallback = false;
        } else {
            // indicate that the 'continue' was already called once the stream actually ends
            this._continueCallback = true;
        }
    }

    // PRIVATE METHODS

    /**
     * Counts emitted data bytes and keeps the byteLength/sizeExceeded
     * properties of the data stream up to date while the message is still
     * being received, so that applications can detect an oversized message
     * mid-transfer instead of only after the stream has ended
     */
    _countDataBytes(len) {
        if (len) {
            // the single funnel for "payload was consumed", so the start-of-DATA
            // marker is cleared here rather than at each emit site
            this._atDataStart = false;
        }
        this.dataBytes += len;
        if (this._dataStream) {
            this._dataStream.byteLength = this.dataBytes;
            if (this.dataBytes > this._maxBytes) {
                this._dataStream.sizeExceeded = true;
            }
        }
    }

    /**
     * Writable._write method.
     */
    _write(chunk, encoding, next) {
        if (!chunk || !chunk.length) {
            return next();
        }

        let data;
        let pos = 0;
        let newlineRegex;

        let called = false;
        let done = (...args) => {
            if (called) {
                return;
            }
            called = true;
            next(...args);
        };

        if (this.isClosed) {
            return done();
        }

        if (!this._dataMode) {
            newlineRegex = /\r?\n/g;
            data = this._remainder + chunk.toString('binary');

            let busy = false;
            let again = false;
            let processed = 0;

            let readLine = () => {
                // Command handlers may invoke the continuation callback
                // synchronously (eg. NOOP). Loop instead of recursing to
                // avoid unbounded stack growth on heavily pipelined input
                if (busy) {
                    again = true;
                    return;
                }

                busy = true;
                // NB! the loop must always leave 'busy' cleared, including when
                // a command handler throws, otherwise the parser would ignore
                // every later readLine() call and the connection would hang
                try {
                    while (true) {
                        again = false;

                        if (this.isClosed) {
                            // the connection went away while processing this chunk,
                            // do not dispatch anything that was pipelined after it
                            return done();
                        }

                        // check if the mode is not changed
                        if (this._dataMode) {
                            let buf = Buffer.from(data.substr(pos), 'binary');
                            this._remainder = '';
                            return this._write(buf, 'buffer', done);
                        }

                        // search for the next newline
                        // exec keeps count of the last match with lastIndex
                        // so it knows from where to start with the next iteration
                        let match = newlineRegex.exec(data);
                        if (!match) {
                            this._remainder = pos < data.length ? data.substr(pos) : '';
                            if (this._remainder.length > this._maxCommandLength) {
                                this._remainder = '';
                                return done(new Error('Command line too long'));
                            }
                            return done();
                        }

                        let line = data.substr(pos, match.index - pos);
                        pos += line.length + match[0].length;

                        this.oncommand(Buffer.from(line, 'binary'), readLine);

                        if (!again) {
                            // the handler is asynchronous, it will re-invoke
                            // readLine through the continuation callback
                            return;
                        }

                        // the handler completed synchronously. Yield to the event
                        // loop every now and then so that a chunk full of pipelined
                        // commands can not starve other connections or block the
                        // socket from flushing the responses we already generated
                        if (++processed >= MAX_SYNC_COMMANDS) {
                            processed = 0;
                            return setImmediate(readLine);
                        }
                    }
                } finally {
                    busy = false;
                }
            };

            // start reading lines
            readLine();
        } else {
            this._feedDataStream(chunk, done);
        }
    }

    /**
     * Processes a chunk in data mode. Escape dots are removed and final dot ends the data mode.
     */
    _feedDataStream(chunk, done) {
        let i;
        let len;
        let handled;
        let buf;

        if (this._lastBytes && this._lastBytes.length) {
            chunk = Buffer.concat([this._lastBytes, chunk], this._lastBytes.length + chunk.length);
            this._lastBytes = false;
        }

        len = chunk.length;

        // Check if the data does not start with the end terminator. NB! this must
        // test _atDataStart and not just dataBytes: if the first DATA line is a
        // single dot (transmitted dot-stuffed as "..") and it arrived as its own
        // chunk, then the escape dot was already stripped and the remaining "." is
        // content, not a terminator, even though nothing has been emitted yet.
        // Otherwise an attacker can end DATA early by controlling TCP segmentation
        // and smuggle additional SMTP commands into the data phase
        if (this._atDataStart && len >= 3 && Buffer.compare(chunk.slice(0, 3), Buffer.from('.\r\n')) === 0) {
            this._endDataMode(false, chunk.slice(3), done);
            return;
        }

        // check if the first symbol is a escape dot
        if (this._atDataStart && len >= 2 && chunk[0] === 0x2e && chunk[1] === 0x2e) {
            chunk = chunk.slice(1);
            len--;
            // the escape dot is consumed payload, so the leading dot from now on is
            // content and never a terminator
            this._atDataStart = false;
        }

        // seek for the stream ending
        for (i = 2; i < len - 2; i++) {
            // if the dot is the first char in a line
            if (chunk[i] === 0x2e && chunk[i - 1] === 0x0a) {
                // if the dot matches end terminator
                if (Buffer.compare(chunk.slice(i - 2, i + 3), END_SEQUENCE) === 0) {
                    // everything before the terminator is message content, including
                    // the CRLF that ends the last line. NB! the loop starts at i=2,
                    // so this always emits at least that trailing CRLF - skipping it
                    // when i is exactly 2 would silently truncate the body whenever
                    // the terminator happens to straddle a chunk boundary
                    buf = chunk.slice(0, i);
                    this._countDataBytes(buf.length);
                    this._endDataMode(buf, chunk.slice(i + 3), done);

                    return;
                }

                // check if the dot is an escape char and remove it
                if (chunk[i + 1] === 0x2e) {
                    buf = chunk.slice(0, i);

                    this._lastBytes = false; // clear remainder bytes
                    this._countDataBytes(buf.length); // increment byte counter

                    // emit what we already have and continue without the dot
                    if (this._dataStream.writable) {
                        this._dataStream.write(buf);
                    }

                    return setImmediate(() => this._feedDataStream(chunk.slice(i + 1), done));
                }
            }
        }

        // keep the last bytes
        if (chunk.length < 4) {
            this._lastBytes = chunk;
        } else {
            this._lastBytes = chunk.slice(chunk.length - 4);
        }

        // if current chunk is longer than the remainder bytes we keep for later emit the available bytes
        if (this._lastBytes.length < chunk.length) {
            buf = chunk.slice(0, chunk.length - this._lastBytes.length);
            this._countDataBytes(buf.length);

            // write to stream but stop if need to wait for drain
            if (this._dataStream.writable) {
                handled = this._dataStream.write(buf);
                if (!handled) {
                    this._dataStream.once('drain', done);
                } else {
                    return done();
                }
            } else {
                return done();
            }
        } else {
            // nothing to emit, continue with the input stream
            return done();
        }
    }

    /**
     * Flushes remaining bytes
     */
    _flushData() {
        let line;
        if (this._remainder && !this.isClosed) {
            line = this._remainder;
            this._remainder = '';
            this.oncommand(Buffer.from(line, 'binary'));
        }
    }

    /**
     * Ends data mode and returns to command mode. Stream is not resumed before #continue is called
     */
    _endDataMode(chunk, remainder, callback) {
        if (this._continueCallback === true) {
            this._continueCallback = false;
            // wait until the stream is actually over and then continue
            this._dataStream.once('end', callback);
        } else {
            this._continueCallback = () => this._write(remainder, 'buffer', callback);
        }

        this._dataStream.byteLength = this.dataBytes;
        this._dataStream.sizeExceeded = this.dataBytes > this._maxBytes;

        if (chunk && chunk.length && this._dataStream.writable) {
            this._dataStream.end(chunk);
        } else {
            this._dataStream.end();
        }

        this._dataMode = false;
        this._remainder = '';
        this._dataStream = null;
    }
}

// Expose to the world
module.exports.SMTPStream = SMTPStream;
