# Changelog

## v1.7.1 2015-10-27

  * Fixed an issue with empty NAME for XCLIENT

## v1.7.0 2015-10-27

  * Added support for XCLIENT with `useXClient` option
  * Fixed an issue with an empty space after EHLO (67acb1534 by AtlasDev)
  * Added dummy handlers for KILL, WIZ, SHELL

## v1.6.0 2015-09-29

  * Catch errors thrown by dns.reverse on invalid remoteAddress values
  * Added onConnect handler to block unwanted connections (66784aea by jleal52)

## v1.5.2 2015-09-18

  * Fixed regression with node v0.12 where STARTTLS connections were kept hanging around after close

## v1.5.1 2015-09-18

  * Fixed an issue where STARTTLS threw an error
  * Fixed an issue where using unknown auth schemes threw an error (a13f0bc8 by farmdog)

## v1.5.0 2015-08-21

  * Added support for PROXY protocol with `useProxy` option

## v1.4.0 2015-04-30

  * Added support for RFC1870 SIZE extension

## v1.3.1 2015-04-21

  * Added integration tests for CRAM-MD5 authentication
  * Exposed SNI support with `sniOptions` optional server option
  * Define used protocol for NPN as 'smtp'

## v1.3.0 2015-04-21

  * Added CRAM-MD5 authentication support

## v1.2.0 2015-03-11

  * Do not allow HTTP requests. If the client tries to send a command that looks like a HTTP request, then disconnect
  * Close connection after 10 unrecognized commands
  * Close connection after 10 unauthenticated commands
  * Close all pending connections after `server.close()` has been called. Default delay to wait is 30 sec. Can be changed with `closeTimeout` option

## v1.1.1 2015-03-11

  * Fixed an issue with parsing MAIL FROM and RCPT TO commands, if there was a space before or after the first colon

## v1.1.0 2015-03-09

  * Added support for `hideSTARTTLS` option that hides STARTTLS while still allowing to use it (useful for integration test scenarios but not for production use)
  * Changed `logger` option behavior - if the value is `false` then no logging is used. If the value is missing, then output is logged to console
  * Fixed broken examples in the README
