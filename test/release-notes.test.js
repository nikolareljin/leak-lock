const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');

suite('release notes', () => {
    test('VERSION matches package.json', () => {
        const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        assert.strictEqual(version, pkg.version);
    });

    test('RELEASE_NOTES.md is for the current version', () => {
        const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
        const releaseNotes = fs.readFileSync(path.join(root, 'RELEASE_NOTES.md'), 'utf8');
        assert.match(releaseNotes, new RegExp(`^#\\s+Release notes,\\s+v${version.replace(/\\./g, '\\\\.')}(?:\\s|$)`, 'i'));
    });

    test('generator writes version-specific release body', () => {
        execFileSync(process.execPath, ['tools/release-notes.js'], { cwd: root, stdio: 'pipe' });
        const generated = fs.readFileSync(path.join(root, '.release-notes.md'), 'utf8');
        const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
        assert.ok(generated.startsWith(`## Release notes, v${version}`));
        assert.ok(generated.includes('Import a previous scan report'));
        assert.ok(!generated.includes('Enhanced dependency directory handling'));
    });

    test('publish workflow uses generated notes for tags and releases', () => {
        const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
        assert.ok(workflow.includes('run: node tools/release-notes.js'));
        assert.ok(workflow.includes('git tag -a "v${FINAL_VERSION}" -F .release-notes.md'));
        assert.ok(workflow.includes('body_path: .release-notes.md'));
        assert.ok(!workflow.includes('Enhanced dependency directory handling'));
    });

});
