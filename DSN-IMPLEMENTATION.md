# DSN (Delivery Status Notification) Implementation for smtp-server

## Overview

This patch adds comprehensive DSN (Delivery Status Notification) support to the smtp-server npm package. DSN allows SMTP clients to request delivery status notifications for their messages.

## Changes Made

### 1. EHLO Response Enhancement
- Added `DSN` extension to the EHLO response
- The extension can be hidden using the `hideDSN` option

### 2. MAIL FROM DSN Parameters
- **RET Parameter**: Accepts `FULL` or `HDRS` values
  - `RET=FULL`: Return full message in DSN
  - `RET=HDRS`: Return only headers in DSN
- **ENVID Parameter**: Accepts envelope ID for tracking purposes
- Both parameters are validated and stored in `session.envelope.dsn`

### 3. RCPT TO DSN Parameters
- **NOTIFY Parameter**: Accepts comma-separated values:
  - `SUCCESS`: Notify on successful delivery
  - `FAILURE`: Notify on delivery failure
  - `DELAY`: Notify on delivery delay
  - `NEVER`: Never send notifications (cannot be combined with others)
- **ORCPT Parameter**: Original recipient address for tracking
- Parameters are validated and stored in the recipient's `dsn` object

### 4. Session Data Structure
Enhanced the session envelope to include DSN information:

```javascript
session.envelope = {
    mailFrom: false,
    rcptTo: [
      {
        "address": "foo@foo.com",
        "args": {
          "NOTIFY": "SUCCESS,FAILURE,DELAY",
          "ORCPT": "rfc822;foo@foo.com"
        },
        "dsn": {
          "notify": [
            "SUCCESS",
            "FAILURE",
            "DELAY"
          ],
          "orcpt": "rfc822;foo@foo.com"
        },
        "name": ""
      }
    ],
    dsn: {
        ret: 'FULL',                      // RET parameter from MAIL FROM (FULL or HDRS)
        envid: 'TEST-ENVELOPE-IDENTIFIER' // ENVID parameter from MAIL FROM
    }
}
```

### 5. Parameter Validation
- RET parameter must be either "FULL" or "HDRS"
- NOTIFY parameter values must be valid (SUCCESS, FAILURE, DELAY, NEVER)
- NOTIFY=NEVER cannot be combined with other values
- All DSN parameters are only processed when DSN extension is supported

## Files Modified

1. **lib/smtp-connection.js**
   - Added DSN to EHLO response
   - Enhanced `_resetSession()` to include DSN data structure
   - Modified `handler_MAIL()` to process RET and ENVID parameters
   - Modified `handler_RCPT()` to process NOTIFY and ORCPT parameters
   - Added comprehensive parameter validation

2. **test/dsn-test.js** (NEW)
   - Comprehensive test suite for DSN functionality
   - Tests for EHLO response with DSN
   - Tests for MAIL FROM DSN parameter validation
   - Tests for RCPT TO DSN parameter validation
   - Unit tests for parameter parsing

## Usage Examples

### Basic DSN Usage
```
EHLO client.example.com
MAIL FROM:<sender@example.com> RET=FULL ENVID=tracking123
RCPT TO:<recipient@example.com> NOTIFY=SUCCESS,FAILURE ORCPT=rfc822;original@example.com
DATA
...
```

### Hiding DSN Extension
```javascript
const server = new SMTPServer({
    hideDSN: true,
    // ... other options
});
```

## Backward Compatibility

This implementation maintains full backward compatibility:
- Existing code will continue to work without changes
- DSN parameters are optional and ignored if DSN is not advertised
- All existing SMTP functionality remains unchanged

## RFC Compliance

This implementation follows RFC 3461 (SMTP Service Extension for Delivery Status Notifications) specifications:
- Proper parameter validation
- Correct error responses
- Standard DSN parameter handling

## Testing

Run the DSN tests with:
```bash
npx mocha test/dsn-test.js
```

Run all tests with:
```bash
npm test
```

## Notes

- DSN parameters are automatically parsed by the existing `_parseAddressCommand` method
- The implementation stores DSN data in the session for use by application handlers
- Error responses follow SMTP standards with appropriate response codes
- The implementation is designed to be extensible for future DSN enhancements
