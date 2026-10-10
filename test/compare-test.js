'use strict';

const chai = require('chai');
const { parseScenario, normalizeReply } = require('../compare/compare');

const expect = chai.expect;

describe('Postfix comparison tool', function () {
    it('should parse scenario steps', function () {
        let { steps, options } = parseScenario(
            ['# comment', '!server {"size": 10}', '', 'EHLO client.example.com', '> body\\r\\n.\\r\\n', '> NO\\x00OP\\r\\n', '!wait 50', '!reconnect'].join(
                '\n'
            )
        );
        expect(options).to.deep.equal({ size: 10 });
        expect(steps.map(step => step.type)).to.deep.equal(['send', 'send', 'send', 'wait', 'reconnect']);
        expect(steps[0].data.toString()).to.equal('EHLO client.example.com\r\n');
        expect(steps[1].data.toString()).to.equal('body\r\n.\r\n');
        expect(steps[2].data.toString('binary')).to.equal('NO\x00OP\r\n');
        expect(steps[3].ms).to.equal(50);
    });

    it('should reject unknown directives', function () {
        expect(() => parseScenario('!foo')).to.throw(/unknown directive/);
    });

    it('should reduce replies to the compared parts', function () {
        expect(normalizeReply('250 2.1.0 Accepted', {})).to.equal('250 2.1.0');
        expect(normalizeReply('250 2.1.0 Ok', {})).to.equal('250 2.1.0');
        expect(normalizeReply('501 Error: Syntax: HELO hostname', {})).to.equal('501');
        expect(normalizeReply('220 postfix.example.com ESMTP', { text: true })).to.equal('220 HOST ESMTP');
        expect(normalizeReply('(connection closed)', {})).to.equal('(connection closed)');
    });

    it('should compare EHLO capabilities only when asked', function () {
        let ehlo = '250-host.example.com\r\n250-SIZE 1024\r\n250 PIPELINING';
        expect(normalizeReply(ehlo, {})).to.equal('250 [capabilities]');
        expect(normalizeReply(ehlo, { capabilities: true })).to.equal('250 [PIPELINING, SIZE 1024]');
    });
});
