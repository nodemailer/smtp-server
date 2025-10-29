const prettier = require('eslint-config-prettier');

module.exports = [
    {
        ignores: ['node_modules/**', 'coverage/**', '*.min.js']
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                console: 'readonly',
                process: 'readonly',
                Buffer: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                module: 'readonly',
                require: 'readonly',
                exports: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                setImmediate: 'readonly',
                clearImmediate: 'readonly'
            }
        },
        rules: {
            // Possible Problems
            'for-direction': 'error',
            'no-await-in-loop': 'error',
            'no-duplicate-case': 'error',
            'no-empty': 'error',
            'no-empty-character-class': 'error',
            'no-fallthrough': 'error',
            'no-regex-spaces': 'error',
            'no-unused-vars': 'error',

            // Best Practices
            eqeqeq: 'error',
            'dot-notation': 'error',
            curly: 'error',
            'no-eval': 'error',
            'no-invalid-this': 'error',
            radix: ['error', 'always'],
            'no-use-before-define': ['error', 'nofunc'],
            'no-redeclare': ['error', { builtinGlobals: true }],
            'no-unused-expressions': ['error', { allowShortCircuit: true }],
            'no-div-regex': 'error',
            'no-new': 'error',
            'new-cap': 'error',

            // Node.js
            'handle-callback-err': 'error',
            'callback-return': ['error', ['callback', 'cb', 'done']],

            // Stylistic (non-formatting)
            'quote-props': ['error', 'as-needed'],

            // Strict Mode
            strict: ['error', 'global']
        }
    },
    // Apply prettier config to disable conflicting rules
    prettier
];
