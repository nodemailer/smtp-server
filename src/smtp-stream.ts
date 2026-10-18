import { PassThrough, Writable, type WritableOptions } from 'node:stream';
import type { SMTPServerDataStream } from './types.js';

// How many pipelined commands to dispatch synchronously before yielding to the
// event loop. Keeps a single chunk full of commands from blocking everything else
const MAX_SYNC_COMMANDS = 100;

// the sequence that ends the DATA payload
const END_SEQUENCE = Buffer.from('\r\n.\r\n');

/** Options of SMTPStream, on top of the Writable stream options */
export interface SMTPStreamOptions extends WritableOptions {
    /** Max allowed length for a single command line */
    maxCommandLength?: number | undefined;
}

type Callback = (err?: Error | null) => void;

/**
 * Incoming SMTP stream parser. Detects and emits commands. If switched to
 * data mode, emits unescaped data events until final .
 */
export class SMTPStream extends Writable {
    /** How many bytes have been emitted to data stream */
    dataBytes: number;
    /** If true, the input is drained without being parsed */
    isClosed: boolean;
    _dataMode: boolean;
    _dataStream: SMTPServerDataStream | null;
    _maxBytes: number;
    _atDataStart: boolean;
    _continueCallback: (() => void) | boolean;
    _remainder: string;
    _lastBytes: Buffer | false;
    _maxCommandLength: number;

    constructor(options?: SMTPStreamOptions) {
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

        // Max allowed length for a single command line. 16 KB leaves room for AUTH lines
        // carrying a base64 XOAUTH2 blob with a multi-kilobyte access token
        this._maxCommandLength = (options && options.maxCommandLength) || 16 * 1024;

        this.isClosed = false;

        // once the input stream ends, flush all output without expecting the newline
        this.on('finish', () => this._flushData());
    }

    /**
     * Placeholder command handler. Override this with your own.
     */
    oncommand(_command: Buffer, _callback?: () => void): void {
        throw new Error('Command handler is not set');
    }

    /**
     * Switch to data mode and return output stream. The dots in the stream are unescaped.
     *
     * @param [maxBytes] Message size limit, sets sizeExceeded on the stream once it is exceeded
     * @returns Data stream
     */
    startDataMode(maxBytes?: number | string | null): SMTPServerDataStream {
        this._dataMode = true;
        this._maxBytes = (maxBytes && Number(maxBytes)) || Infinity;
        this.dataBytes = 0;
        this._atDataStart = true;
        let dataStream = new PassThrough() as SMTPServerDataStream;
        dataStream.byteLength = 0;
        dataStream.sizeExceeded = false;
        this._dataStream = dataStream;

        return dataStream;
    }

    /**
     * Call this once data mode is over and you have finished processing the data stream
     */
    continue(): void {
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
    _countDataBytes(len: number): void {
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
     * Drops the buffered command input and returns the error for an over-length line.
     * Applies to partial and complete lines alike, so the limit does not depend on
     * how the input was chunked
     */
    _commandTooLong(): Error {
        this._remainder = '';
        return new Error('Command line too long');
    }

    /**
     * Writable._write method.
     */
    override _write(chunk: Buffer, encoding: BufferEncoding | 'buffer', next: Callback): void {
        if (!chunk || !chunk.length) {
            return next();
        }

        let data: string;
        let pos = 0;
        let newlineRegex: RegExp;

        let called = false;
        let done: Callback = err => {
            if (called) {
                return;
            }
            called = true;
            next(err);
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

            let readLine = (): void => {
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
                            let buf = Buffer.from(data.slice(pos), 'binary');
                            this._remainder = '';
                            return this._write(buf, 'buffer', done);
                        }

                        // search for the next newline
                        // exec keeps count of the last match with lastIndex
                        // so it knows from where to start with the next iteration
                        let match = newlineRegex.exec(data);
                        if (!match) {
                            this._remainder = pos < data.length ? data.slice(pos) : '';
                            if (this._remainder.length > this._maxCommandLength) {
                                return done(this._commandTooLong());
                            }
                            return done();
                        }

                        let line = data.slice(pos, match.index);
                        pos += line.length + match[0].length;

                        if (line.length > this._maxCommandLength) {
                            return done(this._commandTooLong());
                        }

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
                            setImmediate(readLine);
                            return;
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
    _feedDataStream(chunk: Buffer, done: Callback): void {
        // only called in data mode, which always has a stream
        const dataStream = this._dataStream as SMTPServerDataStream;
        let i: number;
        let len: number;
        let handled: boolean;
        let buf: Buffer;

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
        if (this._atDataStart && len >= 3 && Buffer.compare(chunk.subarray(0, 3), Buffer.from('.\r\n')) === 0) {
            this._endDataMode(false, chunk.subarray(3), done);
            return;
        }

        // check if the first symbol is a escape dot
        if (this._atDataStart && len >= 2 && chunk[0] === 0x2e && chunk[1] === 0x2e) {
            chunk = chunk.subarray(1);
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
                if (Buffer.compare(chunk.subarray(i - 2, i + 3), END_SEQUENCE) === 0) {
                    // everything before the terminator is message content, including
                    // the CRLF that ends the last line. NB! the loop starts at i=2,
                    // so this always emits at least that trailing CRLF - skipping it
                    // when i is exactly 2 would silently truncate the body whenever
                    // the terminator happens to straddle a chunk boundary
                    buf = chunk.subarray(0, i);
                    this._countDataBytes(buf.length);
                    this._endDataMode(buf, chunk.subarray(i + 3), done);

                    return;
                }

                // check if the dot is an escape char and remove it
                if (chunk[i + 1] === 0x2e) {
                    buf = chunk.subarray(0, i);

                    this._lastBytes = false; // clear remainder bytes
                    this._countDataBytes(buf.length); // increment byte counter

                    // emit what we already have and continue without the dot
                    if (dataStream.writable) {
                        dataStream.write(buf);
                    }

                    let rest = chunk.subarray(i + 1);
                    setImmediate(() => this._feedDataStream(rest, done));
                    return;
                }
            }
        }

        // keep the last bytes
        if (chunk.length < 4) {
            this._lastBytes = chunk;
        } else {
            this._lastBytes = chunk.subarray(chunk.length - 4);
        }

        // if current chunk is longer than the remainder bytes we keep for later emit the available bytes
        if (this._lastBytes.length < chunk.length) {
            buf = chunk.subarray(0, chunk.length - this._lastBytes.length);
            this._countDataBytes(buf.length);

            // write to stream but stop if need to wait for drain
            if (dataStream.writable) {
                handled = dataStream.write(buf);
                if (!handled) {
                    dataStream.once('drain', done);
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
    _flushData(): void {
        let line: string;
        if (this._remainder && !this.isClosed) {
            line = this._remainder;
            this._remainder = '';
            this.oncommand(Buffer.from(line, 'binary'));
        }
    }

    /**
     * Ends data mode and returns to command mode. Stream is not resumed before #continue is called
     */
    _endDataMode(chunk: Buffer | false, remainder: Buffer, callback: Callback): void {
        const dataStream = this._dataStream as SMTPServerDataStream;
        if (this._continueCallback === true) {
            this._continueCallback = false;
            // wait until the stream is actually over and then continue
            dataStream.once('end', callback);
        } else {
            this._continueCallback = () => this._write(remainder, 'buffer', callback);
        }

        dataStream.byteLength = this.dataBytes;
        dataStream.sizeExceeded = this.dataBytes > this._maxBytes;

        if (chunk && chunk.length && dataStream.writable) {
            dataStream.end(chunk);
        } else {
            dataStream.end();
        }

        this._dataMode = false;
        this._remainder = '';
        this._dataStream = null;
    }
}
