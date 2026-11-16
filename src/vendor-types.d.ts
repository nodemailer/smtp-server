// Minimal ambient declarations for the runtime dependencies that ship without types

declare module 'punycode.js' {
    const punycode: {
        toUnicode(input: string): string;
        toASCII(input: string): string;
    };
    export default punycode;
}
