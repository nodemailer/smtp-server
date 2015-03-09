# Changelog

## v1.1.0 2015-03-09

  * Added support for `hideSTARTTLS` option that hides STARTTLS while still allowing to use it (useful for integration test scenarios but not for production use)
  * Changed `logger` option behavior - if the value is `false` then no logging is used. If the value is missing, then output is logged to console
  * Fixed broken examples in the README
