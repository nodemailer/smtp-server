import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { normalizeIPv6 } from '../src/ipv6-normalize.js';

// Expected output of the ipv6-normalize package this helper replaced, recorded before it was
// removed. A parity run over 200 000 random addresses matched it everywhere except the two
// cases in the second table, where the old package corrupted the address.
const MATCHES_OLD_PACKAGE: Array<[string, string]> = [
    ['::', '::'],
    ['::1', '::1'],
    ['1::', '1::'],
    ['0:0:0:0:0:0:0:0', '::'],
    ['0:0:0:0:0:0:0:1', '::1'],
    ['2001:DB8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['2001:db8::0:1', '2001:db8::1'],
    ['2001:0db8:0000:0000:0000:ff00:0042:8329', '2001:db8::ff00:42:8329'],
    ['1:0:0:2:0:0:0:3', '1:0:0:2::3'],
    ['1:0:0:2:0:0:3:4', '1::2:0:0:3:4'],
    ['1:2:3:4:5:6:7::', '1:2:3:4:5:6:7:0'],
    ['::2:3:4:5:6:7:8', '0:2:3:4:5:6:7:8'],
    ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8'],
    ['::ffff:1.2.3.4', '::ffff:1.2.3.4'],
    ['::FFFF:192.0.2.1', '::ffff:192.0.2.1'],
    ['::1.2.3.4', '::1.2.3.4'],
    ['64:ff9b:0:0:0:0:192.0.2.33', '64:ff9b::192.0.2.33'],
    ['fe80::1%eth0', 'fe80::1%eth0'],
    ['FE80:0:0:0:0:0:0:1%ETH0', 'fe80::1%eth0'],
    ['fe80::0%eth0', 'fe80::%eth0']
];

const FIXES_OLD_PACKAGE: Array<[string, string, string]> = [
    // an IPv4 tail starting with a 0 octet lost that digit
    ['::ffff:0.64.0.1', '::ffff:0.64.0.1', '::ffff:.64.0.1'],
    ['0:3E00:0:5E00:0:0:0.64.0.0', '0:3e00:0:5e00::0.64.0.0', '0:3e00:0:5e00::.64.0.0'],
    // a zero group right before a zone index was dropped instead of written as 0
    ['b300:0:1700:0:0:7600:0:0%eth2', 'b300:0:1700::7600:0:0%eth2', 'b300:0:1700::7600:0:%eth2']
];

describe('normalizeIPv6', () => {
    for (const [input, expected] of MATCHES_OLD_PACKAGE) {
        it(`formats ${input} as ${expected}`, () => {
            assert.ok(net.isIPv6(input), `${input} should be a valid test input`);
            assert.strictEqual(normalizeIPv6(input), expected);
        });
    }

    for (const [input, expected, oldOutput] of FIXES_OLD_PACKAGE) {
        it(`formats ${input} as ${expected}, not ${oldOutput}`, () => {
            assert.ok(net.isIPv6(input), `${input} should be a valid test input`);
            assert.strictEqual(normalizeIPv6(input), expected);
        });
    }

    it('collapses the first of two equally long zero runs', () => {
        assert.strictEqual(normalizeIPv6('1:0:0:2:3:0:0:4'), '1::2:3:0:0:4');
    });

    it('produces output that is itself a fixed point and still valid', () => {
        for (const [input] of MATCHES_OLD_PACKAGE) {
            const once = normalizeIPv6(input);
            assert.ok(net.isIPv6(once), `${once} should stay valid`);
            assert.strictEqual(normalizeIPv6(once), once);
        }
    });

    it('returns input it cannot split into groups lowercased and otherwise unchanged', () => {
        assert.strictEqual(normalizeIPv6('1::2::3'), '1::2::3');
        assert.strictEqual(normalizeIPv6('NOT-AN-ADDRESS'), 'not-an-address');
        assert.strictEqual(normalizeIPv6('1:2:3'), '1:2:3');
    });
});
