# Postfix reference server for compare/compare.js. Configured to show plain
# protocol behavior: HELO required and strict RFC 5321 envelopes like
# smtp-server, no relaying, no error sleeps or disconnects, XCLIENT and XFORWARD
# allowed for the Docker network the comparison client connects from (so an
# XCLIENT ADDR outside of it drops the privilege), SASL PLAIN/LOGIN for
# user/pass, and every accepted message is discarded.
FROM alpine:3.22

RUN apk add --no-cache postfix cyrus-sasl cyrus-sasl-login

RUN postconf -e \
        'myhostname = postfix.example.com' \
        'mydomain = example.com' \
        'mydestination = example.com, localhost' \
        'mynetworks = 127.0.0.0/8' \
        'smtpd_banner = $myhostname ESMTP' \
        'local_recipient_maps =' \
        'local_transport = discard:' \
        'default_transport = discard:' \
        'message_size_limit = 1048576' \
        'smtpd_peername_lookup = no' \
        'smtpd_helo_required = yes' \
        'strict_rfc821_envelopes = yes' \
        'smtpd_error_sleep_time = 0' \
        'smtpd_soft_error_limit = 1000' \
        'smtpd_hard_error_limit = 1000' \
        'smtpd_junk_command_limit = 1000' \
        'smtpd_recipient_limit = 1000' \
        'smtpd_authorized_xclient_hosts = 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16' \
        'smtpd_authorized_xforward_hosts = 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16' \
        'smtpd_sasl_auth_enable = yes' \
        'smtpd_sasl_type = cyrus' \
        'smtpd_sasl_path = smtpd' \
        'smtpd_sasl_security_options = noanonymous' \
        'smtpd_relay_restrictions = permit_sasl_authenticated, reject_unauth_destination' \
        'maillog_file = /dev/stdout' \
    && mkdir -p /etc/sasl2 \
    && printf 'pwcheck_method: auxprop\nauxprop_plugin: sasldb\nmech_list: PLAIN LOGIN\nsasldb_path: /etc/sasl2/sasldb2\n' > /etc/sasl2/smtpd.conf \
    && echo pass | saslpasswd2 -p -c -f /etc/sasl2/sasldb2 -u postfix.example.com user \
    && chown postfix:postfix /etc/sasl2/sasldb2 \
    && newaliases

EXPOSE 25

CMD ["postfix", "start-fg"]
