const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The unit tests import credential-lens from the source tree, which is present
// whether or not it was packaged. Only this test can tell that a .vsix would
// ship without it — the failure mode being an extension that loads fine and
// throws on the first Secret click.
suite('packaging', () => {

    test('.vscodeignore un-ignores the bundled credential-lens', () => {
        const ignore = fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8');
        assert.ok(
            /^!node_modules\/@nikolareljin\/credential-lens\/\*\*$/m.test(ignore),
            '.vscodeignore must un-ignore node_modules/@nikolareljin/credential-lens/**'
        );
        assert.ok(
            /^!node_modules\/@nikolareljin\/\*\*$/m.test(ignore),
            'the scope directory itself must be un-ignored, or the nested rule never applies'
        );
    });

    // tools/release-notes.js writes .release-notes.md, and publish.yml writes it
    // *before* packaging, so it exists exactly when the .vsix is built.
    // .gitignore covers it for the repository, but vsce stops reading .gitignore
    // once a .vscodeignore exists, so only this line keeps it out of the package.
    test('.vscodeignore excludes the generated release notes', () => {
        const ignore = fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8');
        assert.ok(
            /^\.release-notes\.md$/m.test(ignore),
            '.vscodeignore must exclude .release-notes.md'
        );
    });

    test('the dependency is pinned exactly, not to a range', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        assert.strictEqual(pkg.dependencies['@nikolareljin/credential-lens'], '0.3.0');
    });

    test('the lockfile records the reviewed bytes, not just a reviewed version number', () => {
        // A version pin says which release; only the integrity hash says which
        // bytes. package-lock.json is committed precisely so this hash lives in
        // the repository — without it, nothing repo-side pins what actually
        // gets packaged into the .vsix.
        const EXPECTED_INTEGRITY =
            'sha512-Ogyl71jZAiKW0QKpVMUSlT0hLxrlzx30l7jBix4MM0rhP2jdaWU3WASKDxEs5arl5mOGqqobhaggI5+JxpDzYA==';
        const lockPath = path.join(__dirname, '..', 'package-lock.json');
        assert.ok(fs.existsSync(lockPath), 'package-lock.json must be committed, not gitignored');

        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        const entry = lock.packages['node_modules/@nikolareljin/credential-lens'];
        assert.ok(entry, 'the lockfile must contain a credential-lens entry');
        assert.strictEqual(entry.version, '0.3.0');
        assert.strictEqual(
            entry.integrity,
            EXPECTED_INTEGRITY,
            'the vendored bytes changed: re-review the package before updating this constant'
        );
    });

    test('the installed tree matches the integrity the lockfile recorded', () => {
        // Guards the gap the lockfile alone leaves: the lockfile is a claim
        // about what should be on disk. This checks what IS on disk, so a
        // hand-edited or partially-installed node_modules fails here rather
        // than silently shipping.
        const lock = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8')
        );
        const expected = lock.packages['node_modules/@nikolareljin/credential-lens'].version;
        const installed = JSON.parse(fs.readFileSync(path.join(
            __dirname, '..', 'node_modules', '@nikolareljin', 'credential-lens', 'package.json'
        ), 'utf8'));
        assert.strictEqual(
            installed.version,
            expected,
            'node_modules does not match the lockfile — run `npm ci`'
        );
    });

    test('local agent and tooling state is excluded from the package', () => {
        // These are gitignored, but .vscodeignore is a separate mechanism: vsce
        // does not consult .gitignore when a .vscodeignore exists. publish.sh
        // packages locally, so without these rules a working copy ships its
        // session notes and local settings to the Marketplace.
        const ignore = fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8');
        for (const rule of ['.remember/**', '.claude/**', '.githooks/**']) {
            assert.ok(
                ignore.split('\n').some(line => line.trim() === rule),
                `.vscodeignore must exclude ${rule}`
            );
        }
    });

    test('the package is actually present on disk and has its entry point', () => {
        const entry = path.join(
            __dirname, '..', 'node_modules', '@nikolareljin', 'credential-lens', 'src', 'index.js'
        );
        assert.ok(fs.existsSync(entry), `expected credential-lens entry point at ${entry}`);
    });
});
