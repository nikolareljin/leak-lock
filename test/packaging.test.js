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

    test('the dependency is pinned exactly, because package-lock.json is gitignored', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        assert.strictEqual(pkg.dependencies['@nikolareljin/credential-lens'], '0.3.0');
    });

    test('local agent and tooling state is excluded from the package', () => {
        // These are gitignored, but .vscodeignore is a separate mechanism: vsce
        // does not consult .gitignore when a .vscodeignore exists. publish.sh
        // packages locally, so without these rules a working copy ships its
        // session notes and local settings to the Marketplace.
        const ignore = fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8');
        for (const rule of ['.remember/**', '.claude/**']) {
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
