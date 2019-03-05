# Basic example
Basic usage example. Create `smtp.js`

``` javascript
// smtp.js
const {SMTPServer} = require('smtp-server');

const server = new SMTPServer({
    // disable STARTTLS to allow authentication in clear text mode
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: true,
    onData(stream, session, callback){
        stream.pipe(process.stdout); // print message to console
        stream.on('end', callback);
    },
});

server.listen(25);
```

Create file `email.txt`. This is email body.

```
Subject: Terminal Email Send

Email Content line 1
Email Content line 2
```

Run in console.

```bash
sudo node smtp.js &
sendmail test@localhost < email.txt
```

You will see something like this:

```
[2016-10-31 11:59:45] INFO: SMTP Server listening on 127.0.0.1:25
[2016-10-31 12:00:01] INFO: [65HrQZWSqi4G] Connection from [127.0.0.1]
[2016-10-31 12:00:01] DEBUG: [65HrQZWSqi4G] S: 220 ubuntu-xenial ESMTP
[2016-10-31 12:00:01] DEBUG: [65HrQZWSqi4G] C: EHLO ubuntu-xenial.localdomain
[2016-10-31 12:00:01] DEBUG: [65HrQZWSqi4G] S: 250-ubuntu-xenial Nice to meet you, [127.0.0.1]
250-PIPELINING
250-8BITMIME
250-SMTPUTF8
250-AUTH LOGIN PLAIN
250 STARTTLS
[2016-10-31 12:00:01] DEBUG: [65HrQZWSqi4G] C: STARTTLS
[2016-10-31 12:00:01] DEBUG: [65HrQZWSqi4G] S: 220 Ready to start TLS
[2016-10-31 12:00:01] INFO: [65HrQZWSqi4G] Connection upgraded to TLS
[2016-10-31 12:00:01] DEBUG: [65HrQZWSqi4G] C: EHLO ubuntu-xenial.localdomain
[2016-10-31 12:00:01] DEBUG: [65HrQZWSqi4G] S: 250-ubuntu-xenial Nice to meet you, [127.0.0.1]
250-PIPELINING
250-8BITMIME
250-SMTPUTF8
250 AUTH LOGIN PLAIN
[2016-10-31 12:00:01] DEBUG: [65HrQZWSqi4G] C: MAIL From:<ubuntu@ubuntu-xenial.localdomain> AUTH=ubuntu@ubuntu-xenial.localdomain
[2016-10-31 12:00:01] DEBUG: [65HrQZWSqi4G] S: 250 Accepted
[2016-10-31 12:00:01] DEBUG: [65HrQZWSqi4G] C: RCPT To:<test@ubuntu-xenial.localdomain>
[2016-10-31 12:00:01] DEBUG: [65HrQZWSqi4G] S: 250 Accepted
[2016-10-31 12:00:01] DEBUG: [65HrQZWSqi4G] C: DATA
[2016-10-31 12:00:01] DEBUG: [65HrQZWSqi4G] S: 354 End data with <CR><LF>.<CR><LF>
Received: (from ubuntu@localhost)
	by ubuntu-xenial.localdomain (8.15.2/8.15.2/Submit) id u9VC00kF021723
	for test@localhost; Mon, 31 Oct 2016 12:00:00 GMT
Date: Mon, 31 Oct 2016 12:00:00 GMT
From: Ubuntu <ubuntu@ubuntu-xenial.localdomain>
Message-Id: <201610311200.u9VC00kF021723@ubuntu-xenial.localdomain>
Subject: Terminal Email Send

Email Content line 1
Email Content line 2
[2016-10-31 12:00:01] DEBUG: [65HrQZWSqi4G] C: <390 bytes of DATA>
[2016-10-31 12:00:01] DEBUG: [65HrQZWSqi4G] S: 250 OK: message queued
[2016-10-31 12:00:01] DEBUG: [65HrQZWSqi4G] C: QUIT
[2016-10-31 12:00:01] DEBUG: [65HrQZWSqi4G] S: 221 Bye
[2016-10-31 12:00:01] INFO: [65HrQZWSqi4G] Connection closed to [127.0.0.1]
```
