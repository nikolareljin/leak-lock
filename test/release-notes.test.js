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

    test('VERSION is strict SemVer without wildcards or ranges', () => {
        const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
        assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/);
        assert.doesNotMatch(version, /[v*xX~^<>=|]/);
    });

    test('RELEASE_NOTES.md is for the current version, with optional title prefix', () => {
        const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
        const releaseNotes = fs.readFileSync(path.join(root, 'RELEASE_NOTES.md'), 'utf8');
        assert.match(releaseNotes, new RegExp(`^#\\s+Release notes,\\s+v?${version.replace(/\\./g, '\\\\.')}(?:\\s|$)`, 'i'));
    });

    test('generator writes version-specific release body', () => {
        const outputPath = path.join(root, '.release-notes.md');
        try {
            execFileSync(process.execPath, ['tools/release-notes.js'], { cwd: root, stdio: 'pipe' });
            const generated = fs.readFileSync(outputPath, 'utf8');
            const releaseNotes = fs.readFileSync(path.join(root, 'RELEASE_NOTES.md'), 'utf8')
                .replace(/^#\s*/, '## ');
            const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
            assert.ok(generated.startsWith(`## Release notes, v${version}`));
            assert.strictEqual(generated, `${releaseNotes.trim()}\n`);
        } finally {
            fs.rmSync(outputPath, { force: true });
        }
    });

    test('publish workflow uses generated notes for tags and releases', () => {
        const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
        assert.ok(workflow.includes('run: node tools/release-notes.js'));
        assert.ok(workflow.includes('run: node tools/release-notes.js --check'));
        assert.ok(workflow.includes('git tag -a "v${FINAL_VERSION}" -F .release-notes.md'));
        assert.ok(workflow.includes('body_path: .release-notes.md'));
        assert.ok(workflow.includes("version=\"$(node -p \"require('./package.json').version\")\""));
        assert.ok(workflow.includes('strict SemVer like 0.9.0, with no wildcards or ranges'));
        assert.ok(workflow.includes("printf 'version=%s\\n' \"$version\" >> \"$GITHUB_OUTPUT\""));
        assert.ok(workflow.includes('Update VERSION, package.json, and RELEASE_NOTES.md together'));
        assert.ok(!workflow.includes('cat VERSION)" >> $GITHUB_OUTPUT'));
        assert.ok(!workflow.includes('npm version patch'));
    });

    test('generator rejects release notes with executable syntax', () => {
        const outputPath = path.join(root, '.release-notes.md');
        const releaseNotesPath = path.join(root, 'RELEASE_NOTES.md');
        const originalReleaseNotes = fs.readFileSync(releaseNotesPath, 'utf8');
        const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
        const badLines = [
            '- Run `node tools/release-notes.js` before publishing.',
            '- Run $(touch SHOULD_NOT_EXIST) before publishing.',
            '- Read ${process.env.HOME} before publishing.',
            '- Use ${{ github.sha }} before publishing.',
            '- Call require("fs") before publishing.',
            '- Run node tools/release-notes.js before publishing.',
            '- Redirect echo hi > out.txt before publishing.',
            '- Redirect cmd < in.txt before publishing.'
        ];
        try {
            for (const line of badLines) {
                fs.rmSync(outputPath, { force: true });
                fs.writeFileSync(
                    releaseNotesPath,
                    [`# Release notes, ${version}`, '', '## Fixed', line].join('\n'),
                    'utf8'
                );
                assert.throws(
                    () => execFileSync(process.execPath, ['tools/release-notes.js'], { cwd: root, stdio: 'pipe' }),
                    /RELEASE_NOTES.md must not contain|unsafe markdown link target/
                );
                assert.ok(!fs.existsSync(outputPath));
            }
        } finally {
            fs.writeFileSync(releaseNotesPath, originalReleaseNotes, 'utf8');
            fs.rmSync(outputPath, { force: true });
            fs.rmSync(path.join(root, 'SHOULD_NOT_EXIST'), { force: true });
        }
    });

    test('generator rejects unsafe release note links', () => {
        const outputPath = path.join(root, '.release-notes.md');
        const releaseNotesPath = path.join(root, 'RELEASE_NOTES.md');
        const originalReleaseNotes = fs.readFileSync(releaseNotesPath, 'utf8');
        const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
        try {
            fs.writeFileSync(
                releaseNotesPath,
                [`# Release notes, ${version}`, '', '## Fixed', '- [Open release](javascript:alert(1))'].join('\n'),
                'utf8'
            );
            assert.throws(
                () => execFileSync(process.execPath, ['tools/release-notes.js'], { cwd: root, stdio: 'pipe' }),
                /unsafe markdown link target/
            );
            assert.ok(!fs.existsSync(outputPath));
        } finally {
            fs.writeFileSync(releaseNotesPath, originalReleaseNotes, 'utf8');
            fs.rmSync(outputPath, { force: true });
        }
    });

    test('generator allows safe autolinks and rejects unsafe autolinks', () => {
        const outputPath = path.join(root, '.release-notes.md');
        const releaseNotesPath = path.join(root, 'RELEASE_NOTES.md');
        const originalReleaseNotes = fs.readFileSync(releaseNotesPath, 'utf8');
        const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
        try {
            fs.writeFileSync(
                releaseNotesPath,
                [`# Release notes, ${version}`, '', '## Fixed', '- See <https://example.com/releases>.'].join('\n'),
                'utf8'
            );
            execFileSync(process.execPath, ['tools/release-notes.js'], { cwd: root, stdio: 'pipe' });
            fs.rmSync(outputPath, { force: true });
            fs.writeFileSync(
                releaseNotesPath,
                [`# Release notes, ${version}`, '', '## Fixed', '- See <javascript:alert(1)>.'].join('\n'),
                'utf8'
            );
            assert.throws(
                () => execFileSync(process.execPath, ['tools/release-notes.js'], { cwd: root, stdio: 'pipe' }),
                /unsafe markdown autolink target/
            );
        } finally {
            fs.writeFileSync(releaseNotesPath, originalReleaseNotes, 'utf8');
            fs.rmSync(outputPath, { force: true });
        }
    });

    test('generator rejects raw HTML in release notes', () => {
        const outputPath = path.join(root, '.release-notes.md');
        const releaseNotesPath = path.join(root, 'RELEASE_NOTES.md');
        const originalReleaseNotes = fs.readFileSync(releaseNotesPath, 'utf8');
        const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
        try {
            for (const rawHtml of [
                '<script>alert(1)</script>',
                '<svg/onload=alert(1)>',
                '<!-- hidden release note -->',
                '<!DOCTYPE html>',
                '<?xml version="1.0"?>'
            ]) {
                fs.writeFileSync(
                    releaseNotesPath,
                    [`# Release notes, ${version}`, '', '## Fixed', `- Hide ${rawHtml}.`].join('\n'),
                    'utf8'
                );
                assert.throws(
                    () => execFileSync(process.execPath, ['tools/release-notes.js'], { cwd: root, stdio: 'pipe' }),
                    /raw HTML/
                );
                assert.ok(!fs.existsSync(outputPath));
            }
        } finally {
            fs.writeFileSync(releaseNotesPath, originalReleaseNotes, 'utf8');
            fs.rmSync(outputPath, { force: true });
        }
    });

    test('generator accepts release note titles without v and normalizes output', () => {
        const outputPath = path.join(root, '.release-notes.md');
        const releaseNotesPath = path.join(root, 'RELEASE_NOTES.md');
        const originalReleaseNotes = fs.readFileSync(releaseNotesPath, 'utf8');
        const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
        try {
            fs.writeFileSync(
                releaseNotesPath,
                [`# Release notes, ${version}`, '', '## Fixed', '- Keep release source checks strict.'].join('\n'),
                'utf8'
            );
            execFileSync(process.execPath, ['tools/release-notes.js'], { cwd: root, stdio: 'pipe' });
            const generated = fs.readFileSync(outputPath, 'utf8');
            assert.ok(generated.startsWith(`## Release notes, v${version}`));
        } finally {
            fs.writeFileSync(releaseNotesPath, originalReleaseNotes, 'utf8');
            fs.rmSync(outputPath, { force: true });
        }
    });

    test('generator rejects wildcard and range versions before release processing', () => {
        const versionPath = path.join(root, 'VERSION');
        const originalVersion = fs.readFileSync(versionPath, 'utf8');
        const badVersions = ['1.2.*', 'v1.2.3', '01.2.3', '1.2.3 || 2.0.0', '^1.2.3'];
        try {
            for (const badVersion of badVersions) {
                fs.writeFileSync(versionPath, `${badVersion}\n`, 'utf8');
                assert.throws(
                    () => execFileSync(process.execPath, ['tools/release-notes.js', '--check'], { cwd: root, stdio: 'pipe' }),
                    /strict SemVer/
                );
            }
        } finally {
            fs.writeFileSync(versionPath, originalVersion, 'utf8');
        }
    });

    test('pre-commit hook runs the shared release source validator', () => {
        const hook = fs.readFileSync(path.join(root, '.githooks', 'pre-commit'), 'utf8');
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        assert.ok(hook.includes('node tools/release-notes.js --check'));
        assert.strictEqual(pkg.scripts.prepare, 'node tools/install-git-hooks.js');
        assert.strictEqual(pkg.scripts['check:release'], 'node tools/release-notes.js --check');
    });

    test('sync mode nests release sections under the changelog version heading', () => {
        const outputPath = path.join(root, '.release-notes.md');
        const changelogPath = path.join(root, 'CHANGELOG.md');
        const originalChangelog = fs.readFileSync(changelogPath, 'utf8');
        const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
        try {
            execFileSync(process.execPath, ['tools/release-notes.js', '--sync-changelog'], { cwd: root, stdio: 'pipe' });
            const changelog = fs.readFileSync(changelogPath, 'utf8');
            const currentSection = changelog.slice(changelog.indexOf(`v${version}`));
            const nextRelease = currentSection.search(/\n## .*\bv?\d+\.\d+\.\d+\b/);
            const section = nextRelease === -1 ? currentSection : currentSection.slice(0, nextRelease);
            assert.ok(section.includes('\n### Added\n'));
            assert.ok(section.includes('\n### Changed\n'));
            assert.ok(section.includes('\n### Fixed\n'));
            assert.ok(!section.includes('\n## Added\n'));
        } finally {
            fs.writeFileSync(changelogPath, originalChangelog, 'utf8');
            fs.rmSync(outputPath, { force: true });
        }
    });

    test('sync mode reports a missing changelog clearly', () => {
        const script = fs.readFileSync(path.join(root, 'tools', 'release-notes.js'), 'utf8');
        assert.ok(script.includes("throw new Error('CHANGELOG.md is missing.')"));
    });

});
