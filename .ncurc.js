module.exports = {
    upgrade: true,
    reject: [
        // Block package upgrades that moved to ESM
        'chai',
        // API changes in newer eslint versions
        'grunt-eslint',
        'eslint-config-prettier',
        'mocha'
    ]
};
