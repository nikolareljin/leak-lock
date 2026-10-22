const assert = require('assert');
const path = require('path');
const ownership = require('../dependency-ownership');

suite('dependency ownership', () => {

    test('accepts a Leak Lock directory under Windows LocalAppData', () => {
        // Installers use LocalAppData. Cleanup must accept that exact root or a
        // selected BFG or credential-lens cleanup fails only on Windows.
        const env = { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' };
        const ownedPath = path.win32.join(env.LOCALAPPDATA, 'Leak Lock', 'credential-lens');
        assert.strictEqual(
            ownership.isManagedPath(ownedPath, { env, home: 'C:\\Users\\test', platform: 'win32' }),
            true
        );
    });

    test('refuses a path outside Leak Lock storage', () => {
        const env = { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' };
        assert.strictEqual(
            ownership.isManagedPath('C:\\Users\\test\\Downloads\\credential-lens', {
                env, home: 'C:\\Users\\test', platform: 'win32'
            }),
            false
        );
    });
});
