const assert = require('assert');
const fs = require('fs');
const os = require('os');
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

    test('accepts only the exact recorded native engine path', () => {
        // The ownership record must name the same engines directory used at install
        // time. A matching filename elsewhere must never be treated as removable.
        const engineDirectory = '/var/lib/code/User/globalStorage/nikolareljin.leak-lock/engines';
        assert.strictEqual(ownership.isRecordedEnginePath({
            path: `${engineDirectory}/gitleaks`, engineDirectory
        }), true);
        assert.strictEqual(ownership.isRecordedEnginePath({
            path: '/tmp/engines/gitleaks', engineDirectory
        }), false);
    });

    test('accepts Windows native engine paths only at the recorded directory', () => {
        const engineDirectory = 'C:\\Users\\test\\AppData\\Roaming\\Code\\User\\globalStorage\\nikolareljin.leak-lock\\engines';
        assert.strictEqual(ownership.isRecordedEnginePath({
            path: `${engineDirectory}\\gitleaks.exe`, engineDirectory
        }, { platform: 'win32' }), true);
        assert.strictEqual(ownership.isRecordedEnginePath({
            path: 'C:\\Users\\test\\Downloads\\engines\\gitleaks.exe', engineDirectory
        }, { platform: 'win32' }), false);
    });

    test('migrates a legacy engine record only at the active install directory', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-lock-ownership-'));
        try {
            const options = { home, env: {}, platform: 'linux' };
            const engineDirectory = '/var/lib/code/User/globalStorage/nikolareljin.leak-lock/engines';
            ownership.writeOwned([
                { id: 'engine:gitleaks', kind: 'engine-file', path: `${engineDirectory}/gitleaks` },
                { id: 'engine:trufflehog', kind: 'engine-file', path: '/tmp/engines/trufflehog' }
            ], options);

            assert.strictEqual(ownership.migrateOwnedEngineDirectories(engineDirectory, options), 1);
            const entries = ownership.readOwned(options);
            assert.strictEqual(entries[0].engineDirectory, engineDirectory);
            assert.strictEqual(entries[1].engineDirectory, undefined);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});
