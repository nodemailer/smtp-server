# Changelog

## v3.8.0 2020-11-13

-   Bump dependencies to latest
-   Access to challenge and challengeResponse (CRAM-MD5)

## v3.7.0 2020-06-25

-   Bump dependencies to latest

## v3.6.0 2020-03-15

-   Add remote address to any errors
-   Bump dependencies to latest

## v3.5.0 2019-01-04

-   Fix reverse resolving invalid hostname error where greeting was sent twice
-   Bump Nodemailer version to v5.0.0

## v3.4.5 2018-05-25

-   Expose connection id in 'connect' event

## v3.4.4 2018-05-04

-   Enclose punycode calls in try..catch

## v3.4.2 2018-03-16

-   handle missing address in listener handler

## v3.4.0 2017-12-01

-   Added new property `secured` to indicate an TLS server where TLS is handled upstream
-   Allow handling TLS after PROXY header

## v3.3.1 2017-11-28

-   Do not choke on overly long reverse DNS call

## v3.3.0 2017-10-05

-   Added new method updateSecureContext({key, cert}) to update TLS options live

## v3.2.0 2017-10-01

-   Return net.listen() value

## v3.1.0 2017-08-16

-   Added new server option `needsUpgrade` to upgrade sockets to TLS immediately after connection is established. Works with secure: true

## v3.0.0 2017-04-06

-   Reverted license back to MIT

## v2.0.3 2017-02-17

-   Expose `secure` state in session

## v2.0.2 2017-02-17

-   Fixad a bug where `server.onConnect(err)` did not close the connection

## v2.0.1 2017-02-04

-   Fixad a bug where `server.on('connect', data)` had missing `data`

## v2.0.0 2017-02-04

-   Changed license from MIT to EUPL-v1.1
-   Rewrite to use ES6, this means at least Node.js v6.0.0 is required to use smtp-server

## v1.16.1 2016-10-17

-   Allowed rewriting `connect` method

## v1.16.0 2016-10-17

-   Added new method `connect` to pass already established sockets to the server

## v1.15.0 2016-09-23

-   Added new connection property `remotePort`
-   Emit 'connect' event when all handshakes (including PROXY) have been completed

## v1.14.2 2016-09-02

-   Fix issue with invalidly resolved IPv4 addresses on IPv6 interface

## v1.14.1 2016-08-16

-   Ignore connection errors outside transaction

## v1.14.0 2016-08-09

-   Expose connection TLS cipher in the `tlsOptions` property

## v1.13.1 2016-07-29

-   Fixed remoteHostname resolving bug

## v1.13.0 2016-07-29

-   Added new option `disableReverseLookup` to skip reverse resolving client hostname on connection

## v1.12.0 2016-07-25

-   Added new property for session: `session.transmissionType` that identifies the current transmission (SMTP, ESMTP, ESMTPA etc.)

## v1.11.2 2016-07-15

-   Do not strip last linebreak

## v1.11.1 2016-07-12

-   this.server.options bug fix #58 (xpepermint)

## v1.11.0 2016-07-07

-   Added support for LMTP protocol. Set `lmtp` option to `true` in order to use it

## v1.10.0 2016-07-06

-   Added options `hidePIPELINING`, `hide8BITMIME` and `hideSMTPUTF8`

## v1.9.1 2016-04-26

-   Check that `connection._parser` exists before trying to use it in the DATA handler

## v1.9.0 2016-02-20

-   Added new connection method `onClose`
-   Preserve session object, do not re-create it for every transaction
-   Added new server option `allowInsecureAuth`

## v1.8.0-beta.0 2016-01-26

-   Fixed a bug with XCLIENT ADDR validation
-   Added support for XFORWARD command
-   Expose XCLIENT and XFORWARD data for the session object (session.xClient, session.xForward - both are Map objects where uppercase argument name is the key,
    eg. session.xClient.get('ADDR') to see the IP address of XCLIENT)

## v1.7.1 2015-10-27

-   Fixed an issue with empty NAME for XCLIENT

## v1.7.0 2015-10-27

-   Added support for XCLIENT with `useXClient` option
-   Fixed an issue with an empty space after EHLO (67acb1534 by AtlasDev)
-   Added dummy handlers for KILL, WIZ, SHELL

## v1.6.0 2015-09-29

-   Catch errors thrown by dns.reverse on invalid remoteAddress values
-   Added onConnect handler to block unwanted connections (66784aea by jleal52)

## v1.5.2 2015-09-18

-   Fixed regression with node v0.12 where STARTTLS connections were kept hanging around after close

## v1.5.1 2015-09-18

-   Fixed an issue where STARTTLS threw an error
-   Fixed an issue where using unknown auth schemes threw an error (a13f0bc8 by farmdog)

## v1.5.0 2015-08-21

-   Added support for PROXY protocol with `useProxy` option

## v1.4.0 2015-04-30

-   Added support for RFC1870 SIZE extension

## v1.3.1 2015-04-21

-   Added integration tests for CRAM-MD5 authentication
-   Exposed SNI support with `sniOptions` optional server option
-   Define used protocol for NPN as 'smtp'

## v1.3.0 2015-04-21

-   Added CRAM-MD5 authentication support

## v1.2.0 2015-03-11

-   Do not allow HTTP requests. If the client tries to send a command that looks like a HTTP request, then disconnect
-   Close connection after 10 unrecognized commands
-   Close connection after 10 unauthenticated commands
-   Close all pending connections after `server.close()` has been called. Default delay to wait is 30 sec. Can be changed with `closeTimeout` option

## v1.1.1 2015-03-11

-   Fixed an issue with parsing MAIL FROM and RCPT TO commands, if there was a space before or after the first colon

## v1.1.0 2015-03-09

-   Added support for `hideSTARTTLS` option that hides STARTTLS while still allowing to use it (useful for integration test scenarios but not for production use)
-   Changed `logger` option behavior - if the value is `false` then no logging is used. If the value is missing, then output is logged to console
-   Fixed broken examples in the README
