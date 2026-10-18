// Minimal ambient declarations for the runtime dependencies that ship without types

declare module 'ipv6-normalize' {
    function ipv6normalize(address: string): string;
    export default ipv6normalize;
}

declare module 'punycode.js' {
    const punycode: {
        toUnicode(input: string): string;
        toASCII(input: string): string;
    };
    export default punycode;
}
