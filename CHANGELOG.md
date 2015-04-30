# Changelog

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
