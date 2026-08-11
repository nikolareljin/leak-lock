const assert = require('assert');
const { describeCredentialLensStatus } = require('../credential-inspect');

suite('describeCredentialLensStatus', () => {

    test('reports ready only from a successful load, never from assumption', async () => {
        const status = await describeCredentialLensStatus({
            load: async () => ({ ok: true, version: '0.3.0' })
        });
        assert.deepStrictEqual(status, {
            installed: true, bundled: true, version: '0.3.0', error: null
        });
    });

    test('a bundled-but-unloadable package reports the error, not readiness', async () => {
        const status = await describeCredentialLensStatus({
            load: async () => ({ ok: false, error: 'ERR_MODULE_NOT_FOUND' })
        });
        assert.strictEqual(status.installed, false);
        assert.strictEqual(status.bundled, true);
        assert.match(status.error, /ERR_MODULE_NOT_FOUND/);
    });

    test('never blocks: the status carries no gating flag', async () => {
        const status = await describeCredentialLensStatus({
            load: async () => ({ ok: false, error: 'x' })
        });
        assert.strictEqual(status.blocking, undefined);
    });

    test('against the really bundled package, it resolves', async () => {
        // The whole point of the row: it must reflect a load that happened, so
        // a .vsix built without the dependency shows as broken here rather than
        // at the user's first click.
        const status = await describeCredentialLensStatus();
        assert.strictEqual(status.installed, true, status.error || '');
        assert.match(status.version, /^\d+\.\d+\.\d+$/);
    });
});
