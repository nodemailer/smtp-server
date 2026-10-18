import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseScenario, normalizeReply } from '../compare/compare.js';

describe('Postfix comparison tool', () => {
    it('should parse scenario steps', () => {
        let { steps, options } = parseScenario(
            ['# comment', '!server {"size": 10}', '', 'EHLO client.example.com', '> body\\r\\n.\\r\\n', '> NO\\x00OP\\r\\n', '!wait 50', '!reconnect'].join(
                '\n'
            )
        );
        assert.deepStrictEqual(options, { size: 10 });
        assert.deepStrictEqual(
            steps.map(step => step.type),
            ['send', 'send', 'send', 'wait', 'reconnect']
        );
        assert.strictEqual(steps[0]!.data!.toString(), 'EHLO client.example.com\r\n');
        assert.strictEqual(steps[1]!.data!.toString(), 'body\r\n.\r\n');
        assert.strictEqual(steps[2]!.data!.toString('binary'), 'NO\x00OP\r\n');
        assert.strictEqual(steps[3]!.ms, 50);
    });

    it('should reject unknown directives', () => {
        assert.throws(() => parseScenario('!foo'), /unknown directive/);
    });

    it('should reduce replies to the compared parts', () => {
        assert.strictEqual(normalizeReply('250 2.1.0 Accepted', {}), '250 2.1.0');
        assert.strictEqual(normalizeReply('250 2.1.0 Ok', {}), '250 2.1.0');
        assert.strictEqual(normalizeReply('501 Error: Syntax: HELO hostname', {}), '501');
        assert.strictEqual(normalizeReply('220 postfix.example.com ESMTP', { text: true }), '220 HOST ESMTP');
        assert.strictEqual(normalizeReply('(connection closed)', {}), '(connection closed)');
    });

    it('should compare EHLO capabilities only when asked', () => {
        let ehlo = '250-host.example.com\r\n250-SIZE 1024\r\n250 PIPELINING';
        assert.strictEqual(normalizeReply(ehlo, {}), '250 [capabilities]');
        assert.strictEqual(normalizeReply(ehlo, { capabilities: true }), '250 [PIPELINING, SIZE 1024]');
    });
});
