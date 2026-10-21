# smtp-server

![Nodemailer](https://raw.githubusercontent.com/nodemailer/nodemailer/master/assets/nm_logo_200x136.png)

Node.JS module for creating SMTP and LMTP server instances on the fly.

See [smtp-server homepage](https://nodemailer.com/extras/smtp-server/) for documentation and terms.

## Installation and module formats

```
npm install smtp-server
```

The package ships both an ES module build and a CommonJS build, with TypeScript type declarations for both, so there is no need for `@types/smtp-server` anymore. Use whichever module format your application uses:

```js
// ES modules
import { SMTPServer } from 'smtp-server';

// CommonJS
const { SMTPServer } = require('smtp-server');
```

The `smtp-server/lib/*` deep imports (for example `require('smtp-server/lib/smtp-connection')`) keep working as well. In TypeScript the public types, such as `SMTPServerOptions`, `SMTPServerSession`, `SMTPServerAddress` and `SMTPServerDataStream`, are exported from the package root.

## Using the SIZE extension

Set the `size` option to advertise a maximum message size to clients. Declared sizes in `MAIL FROM:<addr> SIZE=nnn` parameters are checked against the limit, but by default the actual transfer size is not enforced by the server itself. Message data is streamed to the application, so it is up to the application to decide what to do with an oversized message (or to set `rejectOversized`, see below). Check `stream.sizeExceeded` in your `onData` handler to detect oversized messages:

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

To have the server refuse oversized messages itself, set `rejectOversized: true`. A message that went over the `size` limit is then answered with `552 Error: message exceeds fixed maximum message size` (enhanced status code `5.3.4`, one reply per recipient with LMTP), whatever the `onData` callback reports. `onData` still receives the whole stream and still has to consume it. The option defaults to `false` and has no effect without `size`; it also applies when the limit is hidden with `hideSize`.

```js
const server = new SMTPServer({
    size: 1024 * 1024,
    rejectOversized: true,
    onData(stream, session, callback) {
        stream.pipe(storage);
        stream.on('end', () => callback(null, 'OK')); // a 552 replaces this reply if the message was too large
    }
});
```

## Trusting XCLIENT and XFORWARD

The `useXClient` and `useXForward` options enable the Postfix [XCLIENT](http://www.postfix.org/XCLIENT_README.html) and [XFORWARD](http://www.postfix.org/XFORWARD_README.html) commands, which let an SMTP proxy pass on the connection details (and, with `XCLIENT LOGIN`, the identity) of the client it is relaying. Anyone allowed to use them can impersonate any client address, so the commands should only be available to the proxies themselves. Set the option to `true` to allow every connecting client, or to an array of the IP addresses the proxies connect from. The address is compared with the one the connection was accepted from (the address from the PROXY protocol header when `useProxy` is used), and IPv4-mapped IPv6 addresses match their IPv4 form, so `['10.0.0.5']` also covers a client that a dual-stack listener reports as `::ffff:10.0.0.5`.

```js
const server = new SMTPServer({
    useXClient: ['10.0.0.5', '10.0.0.6'], // only these hosts may send XCLIENT
    useXForward: ['10.0.0.5', '10.0.0.6']
});
```

Other clients do not see the commands in the EHLO response and get a `550` reply if they try them anyway. `useProxy` takes the same `true` or array value for the PROXY protocol header.

## Disabling commands per session

The `disabledCommands` option applies to every connection. To decide per connection, set `session.disabledCommands` to an array of command names in `onConnect` (or any later handler). When it is set, it replaces the server wide list for that session, both for the commands the client may use and for the EHLO capability list, so for example `AUTH` and `STARTTLS` are not advertised when the session disables them. Command names are case insensitive, and setting the property back to `undefined` returns the session to the server wide list. Changing `server.options.disabledCommands` from a handler instead affects every open connection.

```js
const server = new SMTPServer({
    disabledCommands: ['AUTH'],
    onConnect(session, callback) {
        if (isTrustedNetwork(session.remoteAddress)) {
            session.disabledCommands = []; // offer AUTH to this client only
        }
        callback();
    }
});
```

## Limiting the number of recipients

By default a mail transaction can have any number of recipients. Set `maxRecipients` to cap the count. Once the limit is reached, further `RCPT TO` commands are answered with `452 Error: too many recipients` (enhanced status code `4.5.3`) as RFC 5321 section 4.5.3.1.10 prescribes, and the client can continue to `DATA` with the recipients that were accepted. A recipient that was already accepted does not count again.

```js
const server = new SMTPServer({
    maxRecipients: 100
});
```
