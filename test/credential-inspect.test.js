const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
    createSession,
    loadLibraryInfo,
    inspectFinding,
    MAX_ARTIFACT_BYTES
} = require('../credential-inspect');

// Generated at runtime into the OS temp directory and deleted immediately.
// Nothing key-shaped is ever committed, and `-C ''` is mandatory: ssh-keygen
// stamps `username@hostname` into the key otherwise, which would put the
// machine's identity into a fixture and from there into a test run.
function makeThrowawayKey() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaklock-test-'));
    const keyPath = path.join(dir, 'k');
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', '', '-q', '-f', keyPath]);
    const bytes = fs.readFileSync(keyPath);
    fs.rmSync(dir, { recursive: true, force: true });
    return bytes;
}

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const TRUNCATED_PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blb';

let PEM_KEY_BYTES;

suite('loadLibraryInfo', () => {

    suiteSetup(() => { PEM_KEY_BYTES = makeThrowawayKey(); });

    test('reports the bundled version, because the panel must not claim ready without checking', async () => {
        const info = await loadLibraryInfo();
        assert.strictEqual(info.ok, true, info.ok ? '' : `import failed: ${info.error}`);
        assert.match(info.version, /^\d+\.\d+\.\d+$/);
    });

    test('a failing import is reported, not thrown', async () => {
        const info = await loadLibraryInfo({
            importer: () => Promise.reject(new Error('ERR_MODULE_NOT_FOUND'))
        });
        assert.strictEqual(info.ok, false);
        assert.match(info.error, /ERR_MODULE_NOT_FOUND/);
    });
});

suite('createSession', () => {

    test('inspects bytes and reports a cache hit the second time', async () => {
        const session = await createSession();
        try {
            const first = await session.inspectBytes(Buffer.from(JWT, 'utf8'));
            assert.strictEqual(first.cache.hit, false);
            const second = await session.inspectBytes(Buffer.from(JWT, 'utf8'));
            assert.strictEqual(second.cache.hit, true);
        } finally {
            session.dispose();
        }
    });

    test('a disposed session refuses further use rather than returning stale data', async () => {
        const session = await createSession();
        session.dispose();
        await assert.rejects(() => session.inspectBytes(Buffer.from(JWT, 'utf8')));
    });
});

suite('inspectFinding', () => {

    suiteSetup(() => { if (!PEM_KEY_BYTES) { PEM_KEY_BYTES = makeThrowawayKey(); } });

    test('resolves a JWT from the snippet alone, touching no disk', async () => {
        const session = await createSession();
        try {
            const readFile = () => { throw new Error('must not read the file'); };
            const result = await inspectFinding(
                { fullSecret: JWT, file: 'a.txt', line: 1 },
                { session, scanPath: '/repo', readFile }
            );
            assert.strictEqual(result.source, 'snippet');
            assert.ok(result.report.credential);
        } finally {
            session.dispose();
        }
    });

    test('falls back to the enclosing file when the snippet is a truncated key', async () => {
        const session = await createSession();
        try {
            const result = await inspectFinding(
                { fullSecret: TRUNCATED_PEM, file: 'id_ed25519', line: 1 },
                { session, scanPath: '/repo', readFile: () => PEM_KEY_BYTES }
            );
            assert.strictEqual(result.source, 'file');
            assert.ok(result.report.credential, 'the whole key should classify');
        } finally {
            session.dispose();
        }
    });

    test('a history finding reads the blob at its commit, never the working tree', async () => {
        const session = await createSession();
        const calls = [];
        try {
            await inspectFinding(
                {
                    fullSecret: TRUNCATED_PEM,
                    file: 'old_key',
                    line: 1,
                    commitHash: 'abc1234567890abcdef1234567890abcdef12345'
                },
                {
                    session,
                    scanPath: '/repo',
                    readFile: () => { throw new Error('must not read the working tree'); },
                    readBlob: (sha, file) => { calls.push([sha, file]); return PEM_KEY_BYTES; }
                }
            );
            assert.deepStrictEqual(calls, [['abc1234567890abcdef1234567890abcdef12345', 'old_key']]);
        } finally {
            session.dispose();
        }
    });

    test('an oversized artifact is declined with a stated reason, not silently skipped', async () => {
        const session = await createSession();
        try {
            const huge = Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x41);
            const result = await inspectFinding(
                { fullSecret: TRUNCATED_PEM, file: 'big.pem', line: 1 },
                { session, scanPath: '/repo', readFile: () => huge }
            );
            assert.strictEqual(result.source, 'declined');
            assert.match(result.report.warnings.map(w => w.message).join(' '), /too large/i);
        } finally {
            session.dispose();
        }
    });

    test('a binary artifact is declined rather than inspected', async () => {
        const session = await createSession();
        try {
            const result = await inspectFinding(
                { fullSecret: TRUNCATED_PEM, file: 'a.bin', line: 1 },
                { session, scanPath: '/repo', readFile: () => Buffer.from([0x00, 0x01, 0x02, 0x00]) }
            );
            assert.strictEqual(result.source, 'declined');
            assert.match(result.report.warnings.map(w => w.message).join(' '), /binary/i);
        } finally {
            session.dispose();
        }
    });

    test('an unreadable file degrades to a declined report, never a thrown scan', async () => {
        const session = await createSession();
        try {
            const result = await inspectFinding(
                { fullSecret: TRUNCATED_PEM, file: 'gone.pem', line: 1 },
                { session, scanPath: '/repo', readFile: () => { throw new Error('ENOENT'); } }
            );
            assert.strictEqual(result.source, 'declined');
        } finally {
            session.dispose();
        }
    });

    test('a declined report never leaks the path or the secret into its reason', async () => {
        const session = await createSession();
        try {
            const result = await inspectFinding(
                { fullSecret: TRUNCATED_PEM, file: 'secrets/prod_id_ed25519', line: 1 },
                { session, scanPath: '/home/someone/private', readFile: () => { throw new Error('ENOENT'); } }
            );
            const text = JSON.stringify(result.report);
            assert.ok(!text.includes('prod_id_ed25519'), 'must not echo the path');
            assert.ok(!text.includes('/home/someone/private'), 'must not echo the scan path');
            assert.ok(!text.includes('b3Blb'), 'must not echo the secret');
        } finally {
            session.dispose();
        }
    });

    test('an ordinary secret with no credential shape returns null', async () => {
        const session = await createSession();
        try {
            const result = await inspectFinding(
                { fullSecret: 'hunter2', file: 'a.txt', line: 1 },
                { session, scanPath: '/repo', readFile: () => { throw new Error('must not read'); } }
            );
            assert.strictEqual(result, null);
        } finally {
            session.dispose();
        }
    });
});
