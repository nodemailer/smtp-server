module.exports = {
    upgrade: true,
    reject: [
        // Block package upgrades that moved to ESM
        'chai',
        'mocha'
    ]
};
