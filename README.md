# smtp-server

Create SMTP and LMTP server instances on the fly. This is not a full-blown server application like [Haraka](https://haraka.github.io/) but an easy way to add custom SMTP listeners to your app. This module is the successor for the server part of the (now deprecated) SMTP module [simplesmtp](https://www.npmjs.com/package/simplesmtp). For matching SMTP client see [smtp-connection](https://www.npmjs.com/package/smtp-connection).

> **NB!** this module does not make any email deliveries by itself. smtp-server allows you to listen on ports 25/24/465/587/etc using SMTP protocol and that's it. Your own application is responsible of accepting and delivering the message to destination.

[![Build Status](https://secure.travis-ci.org/andris9/smtp-server.svg)](http://travis-ci.org/andris9/Nodemailer)
[![npm version](https://badge.fury.io/js/smtp-server.svg)](http://badge.fury.io/js/smtp-server)

Requires Node v0.12 or iojs. The module does not run on Node v0.10 as it uses [Buffer.compare](http://nodejs.org/api/buffer.html#buffer_class_method_buffer_compare_buf1_buf2) and [TLSSocket](http://nodejs.org/api/tls.html#tls_new_tls_tlssocket_socket_options).

## Other similar packages you might be interested in

  * **[nodemailer](https://github.com/nodemailer/nodemailer)** – all in one package to send email from Node.js
  * **[smtp-server](https://github.com/andris9/smtp-server)** – add SMTP server interface to your application
  * **[smtp-server](https://github.com/nodemailer/smtp-connection)** – connect to SMTP servers from your application
  * **[zone-mta](https://github.com/zone-eu/zone-mta)** – full featured outbound MTA built using smtp-connection and smtp-server modules

## Support smtp-server development

[![Donate to author](https://www.paypalobjects.com/en_US/i/btn/btn_donate_SM.gif)](https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=DB26KWR2BQX5W)

## Usage

Install with npm

    npm install smtp-server

Require in your script

    var SMTPServer = require('smtp-server').SMTPServer;

### Create SMTPServer instance

```javascript
var server = new SMTPServer(options);
```

Where

  * **options** defines the behavior of the server
    * **options.secure** if `true`, the connection will use TLS. The default is `false`. If the server doesn't start in TLS mode, it is still possible to upgrade clear text socket to TLS socket with the STARTTLS command (unless you disable support for it). If secure is `true`, [additional tls options for tls.createServer](http://nodejs.org/api/tls.html#tls_tls_createserver_options_secureconnectionlistener) can be added directly onto this options object.
    * **options.name** optional hostname of the server, used for identifying to the client (defaults to `os.hostname()`)
    * **options.banner** optional greeting message. This message is appended to the default ESMTP response.
    * **options.size** optional maximum allowed message size in bytes, see details [here](#using-size-extension)
    * **options.authMethods** optional array of allowed authentication methods, defaults to `['PLAIN', 'LOGIN']`. Only the methods listed in this array are allowed, so if you set it to `['XOAUTH2']` then PLAIN and LOGIN are not available. Use `['PLAIN', 'LOGIN', 'XOAUTH2']` to allow all three. Authentication is only allowed in secure mode (either the server is started with `secure: true` option or STARTTLS command is used)
    * **options.authOptional** allow authentication, but do not require it
    * **options.disabledCommands** optional array of disabled commands (see all supported commands [here](#commands)). For example if you want to disable authentication, use `['AUTH']` as this value. If you want to allow authentication in clear text, set it to `['STARTTLS']`.
    * **options.hideSTARTTLS** optional boolean, if set to true then allow using STARTTLS but do not advertise or require it. It only makes sense when creating integration test servers for testing the scenario where you want to try STARTTLS even when it is not advertised
    * **options.hidePIPELINING** optional boolean, if set to true then does not show PIPELINING in feature list
    * **options.hide8BITMIME** optional boolean, if set to true then does not show 8BITMIME in features list
    * **options.hideSMTPUTF8** optional boolean, if set to true then does not show SMTPUTF8 in features list
    * **options.allowInsecureAuth** optional boolean, if set to true allows authentication even if connection is not secured first
    * **options.disableReverseLookup** optional boolean, if set to true then does not try to reverse resolve client hostname
    * **options.sniOptions** optional [Map](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map) or an object of TLS options for SNI where servername is the key. Overrided by SNICallback.
    * **options.logger** optional [bunyan](https://github.com/trentm/node-bunyan) compatible logger instance. If set to `true` then logs to console. If value is not set or is `false` then nothing is logged
    * **options.maxClients** sets the maximum number of concurrently connected clients, defaults to `Infinity`
    * **options.useProxy** boolean, if set to true expects to be behind a proxy that emits a [PROXY header](http://www.haproxy.org/download/1.5/doc/proxy-protocol.txt) (version 1 only)
    * **options.useXClient** boolean, if set to true, enables usage of [XCLIENT](http://www.postfix.org/XCLIENT_README.html) extension to override connection properties. See `session.xClient` (Map object) for the details provided by the client
    * **options.useXForward** boolean, if set to true, enables usage of [XFORWARD](http://www.postfix.org/XFORWARD_README.html) extension. See `session.xForward` (Map object) for the details provided by the client
    * **options.lmtp** boolean, if set to true use LMTP protocol instead of SMTP
    * **options.socketTimeout** how many milliseconds of inactivity to allow before disconnecting the client (defaults to 1 minute)
    * **options.closeTimeout** how many millisceonds to wait before disconnecting pending connections once server.close() has been called (defaults to 30 seconds)
    * **options.onAuth** is the callback to handle authentications (see details [here](#handling-authentication))
    * **options.onConnect** is the callback to handle the client connection. (see details [here](#validating-client-connection))
    * **options.onMailFrom** is the callback to validate MAIL FROM commands (see details [here](#validating-sender-addresses))
    * **options.onRcptTo** is the callback to validate RCPT TO commands (see details [here](#validating-recipient-addresses))
    * **options.onData** is the callback to handle incoming messages (see details [here](#processing-incoming-message))
    * **options.onClose** is the callback that informs about closed client connection

Additionally you can use the options from [net.createServer](http://nodejs.org/api/net.html#net_net_createserver_options_connectionlistener) and [tls.createServer](http://nodejs.org/api/tls.html#tls_tls_createserver_options_secureconnectionlistener) (applies if `secure` is set to true)

#### Server Methods

The `server` object returned from `new SMTPServer` has the following methods:

  * **listen(port)** - Begins listening on the given port
  * **close(callback)** - Stops the server from accepting new connections. `callback` is invoked once all client connections are closed

### TLS and STARTLS notice

If you use `secure: true` option or you do not disable STARTTLS command then you SHOULD also define the `key`, `cert` and possibly `ca` properties to use a proper certificate. If you do no specify your own certificate then a pregenerated self-signed certificate for 'localhost' is used. Any respectful client refuses to accept such certificate.

**Example**

```javascript
// This example starts a SMTP server using TLS with your own certificate and key
var server = new SMTPServer({
    secure: true,
    key: fs.readFileSync('private.key'),
    cert: fs.readFileSync('server.crt')
});
server.listen(465);
```

### Start the server instance

```javascript
server.listen(port[,host][,callback]);
```

Where

  * **port** is the port number to bound to
  * **host** is the optional host to bound to
  * **callback** is called once the server is bound

## Handling errors

Errors can be handled by setting an 'error' event listener to the server instance

```javascript
server.on('error', function(err){
    console.log('Error %s', err.message);
});
```

## Handling Authentication

Authentication calls can be handled with `onAuth` handler

```javascript
var server = new SMTPServer({
    onAuth: function(auth, session, callback){}
});
```

Where

  * **auth** is an authentication object
    * **method** indicates the authentication method used, 'PLAIN', 'LOGIN' or 'XOAUTH2'
    * **username** is the username of the user
    * **password** is the password if LOGIN or PLAIN was used
    * **accessToken** is the OAuth2 bearer access token if 'XOAUTH2' was used as the authentication method
    * **validatePassword** is a function for validating CRAM-MD5 challenge responses. Takes the password of the user as an argument and returns `true` if the response matches the password
  * **session** includes information about the session like `remoteAddress` for the remote IP, see details [here](#session-object)
  * **callback** is the function to run once the user is authenticated. Takes 2 arguments: `(error, response)`
    * **error** is an error to return if authentication failed. If you want to set custom error code, set `responseCode` to the error object
    * **response** is an object with the authentication results
      * **user** can be any value - if this is set then the user is considered logged in and this value is used later with the session data to identify the user. If this value is empty, then the authentication is considered failed
      * **data** is an object to return if XOAUTH2 authentication failed (do not set the error object in this case). This value is serialized to JSON and base64 encoded automatically, so you can just return the object

This module supports `CRAM-MD5` but the use of it is discouraged as it requires access to unencrypted user passwords during the authentication process. You shouldn't store passwords unencrypted.

### Examples

#### Password based authentication

```javascript
var server = new SMTPServer({
    onAuth: function(auth, session, callback){
        if(auth.username !== 'abc' || auth.password !== 'def'){
            return callback(new Error('Invalid username or password'));
        }
        callback(null, {user: 123}); // where 123 is the user id or similar property
    }
});
```

#### OAuth2 authentication

XOAUTH2 support needs to enabled with the `authMethods` array option as it is disabled by default.
If you support multiple authentication mechanisms, then you can check the used mechanism from the `method` property.

```javascript
var server = new SMTPServer({
    authMethods: ['XOAUTH2'], // XOAUTH2 is not enabled by default
    onAuth: function(auth, session, callback){
        if(auth.method !== 'XOAUTH2'){
            // should never occur in this case as only XOAUTH2 is allowed
            return callback(new Error('Expecting XOAUTH2'));
        }
        if(auth.username !== 'abc' || auth.accessToken !== 'def'){
            return callback(null, {
                data: {
                    status: '401',
                    schemes: 'bearer mac',
                    scope: 'my_smtp_access_scope_name'
                }
            });
        }
        callback(null, {user: 123}); // where 123 is the user id or similar property
    }
});
```

#### CRAM-MD5 authentication

CRAM-MD5 support needs to enabled with the `authMethods` array option as it is disabled by default.
If you support multiple authentication mechanisms, then you can check the used mechanism from the `method` property.

This authentication method does not return a password with the username but a response to a challenge. To validate the returned challenge response, the authentication object includes a method `validatePassword` that takes the actual plaintext password as an argument and returns either `true` if the password matches with the challenge response or `false` if it does not.

```javascript
var server = new SMTPServer({
    authMethods: ['CRAM-MD5'], // CRAM-MD5 is not enabled by default
    onAuth: function(auth, session, callback){
        if(auth.method !== 'CRAM-MD5'){
            // should never occur in this case as only CRAM-MD5 is allowed
            return callback(new Error('Expecting CRAM-MD5'));
        }

        // CRAM-MD5 does not provide a password but a challenge response
        // that can be validated against the actual password of the user
        if(auth.username !== 'abc' || !auth.validatePassword('def')){
            return callback(new Error('Invalid username or password'));
        }

        callback(null, {user: 123}); // where 123 is the user id or similar property
    }
});
```

## Validating client connection

By default any client connection is allowed. If you want to check the remoteAddress or clientHostname before
any other command, you can set a handler for it with `onConnect`


```javascript
var server = new SMTPServer({
    onConnect: function(session, callback){}
});
```

Where

  * **session** includes the `remoteAddress` and `clientHostname` values
  * **callback** is the function to run after validation. If you return an error object, the connection is rejected, otherwise it is accepted

```javascript
var server = new SMTPServer({
    onConnect: function(session, callback){
        if(session.remoteAddress === '127.0.0.1'){
            return callback(new Error('No connections from localhost allowed'));
        }
        return callback(); // Accept the connection
    }
});
```

If you also need to detect when a connection is closed use `onClose`. This method does not expect you to run a callback function as it is purely informational.

```javascript
var server = new SMTPServer({
    onClose: function(session){}
});
```

## Validating sender addresses

By default all sender addresses (as long as these are in valid email format) are allowed. If you want to check
the address before it is accepted you can set a handler for it with `onMailFrom`

```javascript
var server = new SMTPServer({
    onMailFrom: function(address, session, callback){}
});
```

Where

  * **address** is an [address object](#address-object) with the provided email address from `MAIL FROM:` command
  * **session** includes the `envelope` object and `user` data if logged in, see details [here](#session-object)
  * **callback** is the function to run after validation. If you return an error object, the address is rejected, otherwise it is accepted

```javascript
var server = new SMTPServer({
    onMailFrom: function(address, session, callback){
        if(address.address !== 'allowed@example.com'){
            return callback(new Error('Only allowed@example.com is allowed to send mail'));
        }
        return callback(); // Accept the address
    }
});
```

## Validating recipient addresses

By default all recipient addresses (as long as these are in valid email format) are allowed. If you want to check
the address before it is accepted you can set a handler for it with `onRcptTo`

```javascript
var server = new SMTPServer({
    onRcptTo: function(address, session, callback){}
});
```

Where

  * **address** is an [address object](#address-object) with the provided email address from `RCPT TO:` command
  * **session** includes the `envelope` object and `user` data if logged in, see details [here](#session-object)
  * **callback** is the function to run after validation. If you return an error object, the address is rejected, otherwise it is accepted

```javascript
var server = new SMTPServer({
    onRcptTo: function(address, session, callback){
        if(address.address !== 'allowed@example.com'){
            return callback(new Error('Only allowed@example.com is allowed to receive mail'));
        }
        return callback(); // Accept the address
    }
});
```

## Processing incoming message

You can get the stream for the incoming message with `onData` handler

```javascript
var server = new SMTPServer({
    onData: function(stream, session, callback){}
});
```

Where

  * **stream** is a readable stream for the incoming message
  * **session** includes the `envelope` object and `user` data if logged in, see details [here](#session-object)
  * **callback** is the function to run once the stream is ended and you have processed the outcome. If you return an error object, the message is rejected, otherwise it is accepted

```javascript
var server = new SMTPServer({
    onData: function(stream, session, callback){
        stream.pipe(process.stdout); // print message to console
        stream.on('end', callback);
    }
});
```

This module does not prepend `Received` or any other header field to the streamed message. The entire message is streamed as-is with no modifications whatsoever. For compliancy you should add the Received data to the message yourself, see [rfc5321 4.4. Trace Information](https://tools.ietf.org/html/rfc5321#section-4.4) for details.

## Using SIZE extension

When creating the server you can define maximum allowed message size with the `size` option, see [RFC1870](https://tools.ietf.org/html/rfc1870) for details. This is not a strict limitation, the client is informed about the size limit but the client can still send a larger message than allowed, it is up to your application to reject or accept the oversized message. To check if the message was oversized, see `stream.sizeExceeded` property.

```javascript
var server = new SMTPServer({
    size: 1024, // allow messages up to 1 kb
    onData: function(stream, session, callback){
        stream.pipe(process.stdout); // print message to console
        stream.on('end', function(){
            var err;
            if(stream.sizeExceeded){
                err = new Error('Message exceeds fixed maximum message size');
                err.responseCode = 552;
                return callback(err);
            }
            callback(null, 'Message queued as abcdef');
        });
    }
});
```

## Using LMTP

If `lmtp` option is set to true when starting the server, then LMTP protocol is used instead of SMTP. The main
difference between these two is how multiple recipients are handled. In case of SMTP the message either fails or succeeds
but in LMTP the message might fail and succeed individually for every recipient.

If your LMTP server application does not distinguish between different recipients then you do not need to care about it.
On the other hand if you want to report results separately for every recipient you can do this by providing an array
of responses instead of a single error or success message. The array must contain responses in the same order as in the
envelope rcptTo array.

```javascript
var server = new SMTPServer({
    lmtp: true,
    onData: function(stream, session, callback){
        stream.pipe(process.stdout); // print message to console
        stream.on('end', function(){
            // reject every other recipient
            var response = session.envelope.rcptTo.map(function (rcpt, i) {
                if (i % 2) {
                    return new Error('<' + rcpt.address + '> Not accepted');
                } else {
                    return '<' + rcpt.address + '> Accepted';
                }
            });
            callback(null, response);
        });
    }
});
```

If you provide a single error by invoking `callback(err)` or single success message `callback(null, 'OK')` like when dealing with SMTP then every recipient gets the same response.

## Session object

Session object that is passed to the handler functions includes the following properties

  * **id** random string identificator generated when the client connected
  * **remoteAddress** the IP address for the connected client
  * **clientHostname** reverse resolved hostname for *remoteAddress*
  * **openingCommand** the opening SMTP command (HELO/EHLO/LHLO)
  * **hostNameAppearsAs** hostname the client provided with HELO/EHLO call
  * **envelope** includes denvelope data
    * **mailFrom** includes an address object or is set to false
    * **rcptTo** includes an array of address objects
  * **user** includes the `user` value returned with the authentication handler
  * **transaction** number of the current transaction. 1 is for the first message, 2 is for the 2nd message etc.
  * **transmissionType** indicates the current protocol type for the received header (SMTP, ESMTP, ESMTPA etc.)

## Address object

Address object in the `mailFrom` and `rcptTo` values include the following properties

  * **address** is the address provided with the MAIL FROM or RCPT TO command
  * **args** is an object with additional arguments (all key names are uppercase)

For example if the client runs the following commands:

    C: MAIL FROM:<sender@example.com> SIZE=12345 RET=HDRS
    C: RCPT TO:<recipient@example.com> NOTIFY=NEVER

then the envelope object is going go look like this:

```json
{
  "mailFrom": {
    "address": "sender@example.com",
    "args": {
      "SIZE": "12345",
      "RET": "HDRS"
    }
  },
  "rcptTo": [
    {
      "address": "receiver@example.com",
      "args": {
        "NOTIFY": "NEVER"
      }
    }
  ]
}
```

## Supported SMTP commands

### Commands

  * **AUTH LOGIN**
  * **AUTH PLAIN**
  * **AUTH XOAUTH2** not enabled by default, add to `authMethods: ['XOAUTH2']` to enable
  * **EHLO**
  * **DATA**
  * **HELO**
  * **HELP** returns URL to RFC5321
  * **MAIL**
  * **NOOP**
  * **QUIT**
  * **RCPT**
  * **RSET** clears session info but does not renegotiate TLS session
  * **STARTTLS**
  * **VRFY** always returns positive 252 response

### Extensions

  * **PIPELINING**
  * **8BITMIME** allows 8bit message content
  * **SMTPUTF8** accepts unicode e-mail addresses like *δοκιμή@παράδειγμα.δοκιμή*
  * **SIZE** limits maximum message size

Most notably, the **ENHANCEDSTATUSCODES** extension is not supported, all response codes use the standard three digit format and nothing else. I might change this in the future if I have time to revisit all responses and find the appropriate response codes.

**CHUNKING** is also missing. I might add support for it in the future but not at this moment since DATA already accepts a stream and CHUNKING is not supported everywhere.

## License

**MIT**
