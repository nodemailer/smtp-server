/**
 * Formats an IPv6 address in the canonical text form of RFC 5952: lowercase hex digits,
 * no leading zeros in a group, and the longest run of two or more all-zero groups
 * (the first one on a tie) collapsed to `::`.
 *
 * An embedded IPv4 tail (`::ffff:192.0.2.1`) stays in dotted form, as section 5 of the
 * RFC asks, and a zone index (`fe80::1%eth0`) is kept after the address. The input is
 * expected to have passed `net.isIPv6()`; anything that does not split into groups is
 * returned lowercased and otherwise unchanged.
 *
 * Replaces the `ipv6-normalize` package (unchanged since 2015), whose output this matches.
 *
 * @param address IPv6 address, as accepted by `net.isIPv6()`
 * @returns Canonical text form of the address
 */
export function normalizeIPv6(address: string): string {
    let rest = address.toLowerCase();

    let zone = '';
    const zoneStart = rest.indexOf('%');
    if (zoneStart >= 0) {
        zone = rest.slice(zoneStart);
        rest = rest.slice(0, zoneStart);
    }

    let ipv4 = '';
    const lastColon = rest.lastIndexOf(':');
    if (rest.indexOf('.', lastColon) >= 0) {
        ipv4 = rest.slice(lastColon + 1);
        rest = rest.slice(0, lastColon + 1);
        if (!rest.endsWith('::')) {
            rest = rest.slice(0, -1);
        }
    }

    const groups = expandGroups(rest, ipv4 ? 6 : 8);
    if (!groups) {
        return address.toLowerCase();
    }

    let result = compressGroups(groups);
    if (ipv4) {
        result += (result.endsWith(':') ? '' : ':') + ipv4;
    }
    return result + zone;
}

// Splits the hex part of an address into exactly `total` groups without leading zeros,
// expanding a `::`. Returns null for input that is not a valid group list.
function expandGroups(hex: string, total: number): string[] | null {
    const halves = hex.split('::');
    if (halves.length > 2) {
        return null;
    }

    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missing = total - head.length - tail.length;
    if (halves.length === 2 ? missing < 1 : missing !== 0) {
        return null;
    }

    const groups = [...head, ...new Array<string>(missing).fill('0'), ...tail];
    if (!groups.every(group => /^[0-9a-f]{1,4}$/.test(group))) {
        return null;
    }
    return groups.map(group => parseInt(group, 16).toString(16));
}

// Joins groups with `:`, collapsing the first longest run of two or more zero groups.
function compressGroups(groups: string[]): string {
    let bestStart = -1;
    let bestLength = 1;
    for (let start = 0; start < groups.length; start++) {
        let end = start;
        while (end < groups.length && groups[end] === '0') {
            end++;
        }
        if (end - start > bestLength) {
            bestStart = start;
            bestLength = end - start;
        }
        start = Math.max(start, end);
    }

    if (bestStart < 0) {
        return groups.join(':');
    }
    return groups.slice(0, bestStart).join(':') + '::' + groups.slice(bestStart + bestLength).join(':');
}
