# smtp-server

![Nodemailer](https://raw.githubusercontent.com/nodemailer/nodemailer/master/assets/nm_logo_200x136.png)

Node.JS module for creating SMTP and LMTP server instances on the fly.

See [smtp-server homepage](https://nodemailer.com/extras/smtp-server/) for documentation and terms.

## Using the SIZE extension

Set the `size` option to advertise a maximum message size to clients. Declared sizes in `MAIL FROM:<addr> SIZE=nnn` parameters are checked against the limit, but the actual transfer size is not enforced by the server itself — message data is streamed to the application, so it is up to the application to decide what to do with an oversized message. Check `stream.sizeExceeded` in your `onData` handler to detect oversized messages:

```js
const server = new SMTPServer({
    size: 1024 * 1024, // 1 MiB limit
    onData(stream, session, callback) {
        stream.on('end', () => {
            if (stream.sizeExceeded) {
                const err = new Error('Message too large');
                err.responseCode = 552;
                return callback(err);
            }
            callback(null, 'OK');
        });
        stream.resume(); // Consume the stream
    }
});
```

The `sizeExceeded` flag and the `byteLength` byte counter on the data stream are updated in real time while the message is being received, so a handler that wants to stop an oversized transfer early can also check the flag from a `data` event instead of waiting for `end`.
