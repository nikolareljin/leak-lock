const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const script = path.join(root, 'tools', 'release-notes.js');

// Every generator case runs against a throwaway fixture directory. These tests
// used to overwrite the repository's own VERSION, RELEASE_NOTES.md and
// CHANGELOG.md and put them back in a finally block, so an interrupted run left
// real release sources corrupted and two runs at once raced each other.
const fixtures = [];

function fixture({ version = '1.2.3', notes, changelog } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-lock-release-'));
    fixtures.push(dir);
    fs.writeFileSync(path.join(dir, 'VERSION'), `${version}\n`, 'utf8');
    fs.writeFileSync(
        path.join(dir, 'package.json'),
        `${JSON.stringify({ name: 'leak-lock-fixture', version }, null, 2)}\n`,
        'utf8'
    );
    if (notes !== undefined) {
        fs.writeFileSync(path.join(dir, 'RELEASE_NOTES.md'), notes, 'utf8');
    }
    if (changelog !== undefined) {
        fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog, 'utf8');
    }
    return dir;
}

function releaseNotes(bullet, { version = '1.2.3', section = 'Fixed' } = {}) {
    return [`# Release notes, ${version}`, '', `## ${section}`, bullet, ''].join('\n');
}

function generate(dir, extraArgs = []) {
    return execFileSync(process.execPath, [script, '--root', dir, ...extraArgs], { cwd: root, stdio: 'pipe' });
}

function generated(dir) {
    return path.join(dir, '.release-notes.md');
}

suite('release notes', () => {

    teardown(() => {
        while (fixtures.length > 0) {
            fs.rmSync(fixtures.pop(), { recursive: true, force: true });
        }
    });

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
        const notes = fs.readFileSync(path.join(root, 'RELEASE_NOTES.md'), 'utf8');
        assert.match(notes, new RegExp(`^#\\s+Release notes,\\s+v?${version.replace(/\./g, '\\.')}(?:\\s|$)`, 'i'));
    });

    test('the checked-in release sources pass validation', () => {
        execFileSync(process.execPath, [script, '--check'], { cwd: root, stdio: 'pipe' });
    });

    test('generator writes version-specific release body', () => {
        const dir = fixture({ notes: releaseNotes('- Keep release source checks strict.') });
        generate(dir);
        const output = fs.readFileSync(generated(dir), 'utf8');
        assert.ok(output.startsWith('## Release notes, v1.2.3'));
        assert.ok(output.includes('\n## Fixed\n- Keep release source checks strict.\n'));
    });

    test('generator accepts release note titles without v and normalizes output', () => {
        const dir = fixture({ notes: releaseNotes('- Keep release source checks strict.') });
        generate(dir);
        assert.ok(fs.readFileSync(generated(dir), 'utf8').startsWith('## Release notes, v1.2.3'));
    });

    test('generator rejects syntax a shell or workflow would expand', () => {
        const cases = [
            ['- Run `node tools/release-notes.js` before publishing.', /backticks/],
            ['- Run $(touch SHOULD_NOT_EXIST) before publishing.', /shell command substitution/],
            ['- Read ${process.env.HOME} before publishing.', /template or workflow expression syntax/],
            ['- Use ${{ github.sha }} before publishing.', /template or workflow expression syntax/]
        ];
        for (const [bullet, expected] of cases) {
            const dir = fixture({ notes: releaseNotes(bullet) });
            assert.throws(() => generate(dir), expected, bullet);
            assert.ok(!fs.existsSync(generated(dir)), bullet);
            assert.ok(!fs.existsSync(path.join(dir, 'SHOULD_NOT_EXIST')), bullet);
        }
    });

    // The file is a `git tag -F` message, a GitHub Release body and a CHANGELOG
    // section. Nothing hands it to a shell, so rules that banned shell
    // metacharacters and command names only rejected ordinary release notes --
    // and because --check ran solely in publish.yml, they rejected them after
    // the merge, when they blocked the release rather than the change.
    test('generator accepts ordinary prose that is not markup', () => {
        const bullets = [
            '- Values < 10 are ignored.',
            '- Reduce startup to <100 ms.',
            '- Support Node >= 22.',
            '- Raise the per-engine timeout from 300 s to > 600 s.',
            '- Escape the < character in report output.',
            '- Rewrite history with git filter-repo.',
            '- Run npm ci before packaging.',
            '- Handle A && B correctly.',
            '- Contact <security@example.com> for reports.',
            '- See <https://example.com/releases> for details.',
            // URI schemes are case-insensitive, so an uppercase autolink is an
            // ordinary one and must not read as an unsupported scheme.
            '- See <HTTPS://example.com/releases> for details.',
            '- Mail <MAILTO:security@example.com> works too.',
            '- Read [the guide](https://example.com/guide).',
            '- Read [the guide](https://example.com/a%20b).',
            '- Read [the guide](https://example.com/100%25).',
            '- [ref]: https://example.com/releases',
            '- Ratio [a]: 3 to 1 after the change.'
        ];
        for (const bullet of bullets) {
            const dir = fixture({ notes: releaseNotes(bullet) });
            generate(dir);
            assert.ok(fs.readFileSync(generated(dir), 'utf8').includes(bullet), bullet);
        }
    });

    test('generator rejects unsafe release note link targets', () => {
        const bullets = [
            '- [Open release](javascript:alert(1))',
            // A single space after the opening paren used to walk straight past
            // the check, because the target had to sit flush against the paren.
            '- [Open release](  javascript:alert(1))',
            '- [Open release](<javascript:alert(1)>)',
            '- [Open release](file:///etc/passwd)',
            '- [Open release](//evil.example/release)',
            '- [Open release](DATA:text/html;base64,PHN2Zz4=)',
            // A renderer decodes these before it uses the href, so the raw text
            // and the decoded text have to agree about what the scheme is.
            '- [Open release](&#106;avascript:alert(1))',
            '- [Open release](&#x6A;avascript:alert(1))',
            '- [Open release](%6Aavascript:alert(1))',
            // A link reference definition carries a target the inline pattern
            // never sees, because it follows `]:` rather than `](`.
            '- [ref]: javascript:alert(1)',
            '- [ref]: //evil.example/release',
            '- [ref]: &#106;avascript:alert(1)'
        ];
        for (const bullet of bullets) {
            const dir = fixture({ notes: releaseNotes(bullet) });
            assert.throws(() => generate(dir), /unsafe markdown link target/, bullet);
            assert.ok(!fs.existsSync(generated(dir)), bullet);
        }
    });

    test('generator rejects unsafe autolinks and unsupported autolink schemes', () => {
        for (const bullet of [
            '- See <javascript:alert(1)>.',
            '- See <FILE:///etc/passwd>.',
            '- See <&#106;avascript:alert(1)>.',
            '- See <JAVASCRIPT:alert(1)>.'
        ]) {
            const dir = fixture({ notes: releaseNotes(bullet) });
            assert.throws(() => generate(dir), /unsafe markdown autolink target/, bullet);
        }
        for (const bullet of ['- See <ftp://example.com/x>.', '- See <FTP://example.com/x>.']) {
            const dir = fixture({ notes: releaseNotes(bullet) });
            assert.throws(() => generate(dir), /may only autolink http, https and mailto targets/, bullet);
        }
    });

    test('generator rejects raw HTML in release notes', () => {
        const markup = [
            '<script>alert(1)</script>',
            '</script>',
            '<svg/onload=alert(1)>',
            '<!-- hidden release note -->',
            '<!DOCTYPE html>',
            '<?xml version="1.0"?>',
            '<![CDATA[hidden]]>'
        ];
        for (const rawHtml of markup) {
            const dir = fixture({ notes: releaseNotes(`- Hide ${rawHtml}.`) });
            assert.throws(() => generate(dir), /raw HTML/, rawHtml);
            assert.ok(!fs.existsSync(generated(dir)), rawHtml);
        }
    });

    // A tag pattern bounded by [^>\n]* cannot see a tag that spans lines, and
    // Markdown renders one just the same.
    test('generator rejects a raw HTML tag split across lines', () => {
        const dir = fixture({
            notes: [
                '# Release notes, 1.2.3',
                '',
                '## Fixed',
                '- Hide <a',
                '  href="https://example.com"',
                '  title="click">this</a>.',
                ''
            ].join('\n')
        });
        assert.throws(() => generate(dir), /raw HTML/);
        assert.ok(!fs.existsSync(generated(dir)));
    });

    // A title-only file passed every content rule and produced an empty
    // annotated tag message and an empty GitHub Release body.
    test('generator rejects release notes with no bullets', () => {
        for (const notes of ['# Release notes, 1.2.3\n', '# Release notes, 1.2.3\n\n## Fixed\n']) {
            const dir = fixture({ notes });
            assert.throws(() => generate(dir), /at least one bullet/);
        }
    });

    test('generator rejects unsupported sections and non-bullet content', () => {
        const dir = fixture({ notes: '# Release notes, 1.2.3\n\n## Notes\n- One.\n' });
        assert.throws(() => generate(dir), /unsupported section "Notes"/);

        const loose = fixture({ notes: '# Release notes, 1.2.3\n\n## Fixed\nNot a bullet.\n' });
        assert.throws(() => generate(loose), /must be bullet items/);
    });

    test('generator rejects wildcard and range versions before release processing', () => {
        for (const badVersion of ['1.2.*', 'v1.2.3', '01.2.3', '1.2.3 || 2.0.0', '^1.2.3']) {
            const dir = fixture({ version: badVersion, notes: releaseNotes('- One.', { version: badVersion }) });
            assert.throws(() => generate(dir, ['--check']), /strict SemVer/, badVersion);
        }
    });

    test('generator reports a missing package.json clearly', () => {
        const dir = fixture({ notes: releaseNotes('- One.') });
        fs.rmSync(path.join(dir, 'package.json'));
        assert.throws(() => generate(dir, ['--check']), /package.json is missing/);
    });

    test('generator rejects a VERSION that disagrees with package.json', () => {
        const dir = fixture({ notes: releaseNotes('- One.') });
        fs.writeFileSync(path.join(dir, 'VERSION'), '1.2.4\n', 'utf8');
        assert.throws(() => generate(dir, ['--check']), /does not match package.json/);
    });

    test('sync mode nests release sections under the changelog version heading', () => {
        const dir = fixture({
            notes: ['# Release notes, 1.2.3', '', '## Added', '- New thing.', '', '## Fixed', '- Fixed thing.', ''].join('\n'),
            changelog: '# Change Log\n\n## 2026-01-01 — v1.2.2\n### Fixed\n- Older thing.\n'
        });
        generate(dir, ['--sync-changelog']);
        const changelog = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
        const section = changelog.slice(changelog.indexOf('v1.2.3'), changelog.indexOf('v1.2.2'));
        assert.ok(section.includes('\n### Added\n'));
        assert.ok(section.includes('\n### Fixed\n'));
        assert.ok(!section.includes('\n## Added\n'));
        assert.ok(changelog.includes('- Older thing.'), 'the earlier release must survive');
    });

    // A CHANGELOG entry is edited after it is generated, so replacing one with
    // the short release-note bullets is an unrecoverable loss. AGENTS.md tells
    // contributors to run this before every publish.
    test('sync mode refuses to overwrite an existing changelog section', () => {
        const changelog = '# Change Log\n\n## 2026-01-01 — v1.2.3\n### Fixed\n- Hand-written detail worth keeping.\n';
        const dir = fixture({ notes: releaseNotes('- Terse bullet.'), changelog });
        assert.throws(() => generate(dir, ['--sync-changelog']), /already has a v1\.2\.3 section/);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'), changelog);
        // The refusal happens before anything is written, so no generated file
        // is left behind to suggest the run succeeded.
        assert.ok(!fs.existsSync(generated(dir)));
    });

    test('sync mode replaces an existing changelog section only with --force', () => {
        const changelog = '# Change Log\n\n## 2026-01-01 — v1.2.3\n### Fixed\n- Superseded text.\n';
        const dir = fixture({ notes: releaseNotes('- Replacement text.'), changelog });
        generate(dir, ['--sync-changelog', '--force']);
        const updated = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
        assert.ok(updated.includes('- Replacement text.'));
        assert.ok(!updated.includes('- Superseded text.'));
    });

    test('sync mode reports a missing changelog clearly', () => {
        const dir = fixture({ notes: releaseNotes('- One.') });
        assert.throws(() => generate(dir, ['--sync-changelog']), /CHANGELOG.md is missing/);
    });

    test('--force is rejected without --sync-changelog', () => {
        const dir = fixture({ notes: releaseNotes('- One.') });
        assert.throws(() => generate(dir, ['--force']), /--force only applies to --sync-changelog/);
    });

    test('publish workflow uses generated notes for tags and releases', () => {
        const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
        assert.ok(workflow.includes('run: node tools/release-notes.js'));
        assert.ok(workflow.includes('run: node tools/release-notes.js --check'));
        // git tag defaults to --cleanup=strip, which deletes every line starting
        // with '#'. Without verbatim the annotated tag loses its title and every
        // '## Added' / '## Fixed' heading and keeps only bare bullets.
        assert.ok(workflow.includes('git tag -a "v${FINAL_VERSION}" --cleanup=verbatim -F .release-notes.md'));
        assert.ok(workflow.includes('body_path: .release-notes.md'));
        assert.ok(workflow.includes("version=\"$(node -p \"require('./package.json').version\")\""));
        assert.ok(workflow.includes('strict SemVer like 0.9.0, with no wildcards or ranges'));
        assert.ok(workflow.includes("printf 'version=%s\\n' \"$version\" >> \"$GITHUB_OUTPUT\""));
        assert.ok(workflow.includes('Update VERSION, package.json, and RELEASE_NOTES.md together'));
        assert.ok(!workflow.includes('cat VERSION)" >> $GITHUB_OUTPUT'));
        assert.ok(!workflow.includes('npm version patch'));
        // The version reaches the shell through the environment, never through
        // ${{ }} expansion inside a run: body.
        assert.ok(!/\$\{\{ steps\.version\.outputs\.version \}\}/.test(
            workflow.slice(workflow.indexOf('Check version tag is new'), workflow.indexOf('Generate release notes'))
                .replace(/VERSION: \$\{\{ steps\.version\.outputs\.version \}\}/, '')
        ));
        // Packaging must not delete files out of the checkout; .vscodeignore
        // already excludes the test tree.
        assert.ok(!workflow.includes('rm -f ./test'));
        // Lint failures must not be waved through on the release path.
        assert.ok(!workflow.includes('continue-on-error'));
        // RELEASE_NOTES.md is a release source: a merge that only changes it
        // still has to publish.
        assert.ok(!/paths-ignore:[\s\S]*'\*\.md'/.test(workflow));
    });

    test('CI gates pull requests into release branches and validates release sources', () => {
        const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
        // A pull request into release/0.9.0 reported no checks at all, so lint,
        // tests and packaging never ran until after the merge.
        assert.ok(/pull_request:[\s\S]*branches: \[ main, 'release\/\*\*' \]/.test(workflow));
        assert.ok(workflow.includes('npm run check:release'));
        assert.ok(workflow.includes('git tag -l "v$version"'));
    });

    test('pre-commit hook validates the staged release sources', () => {
        const hook = fs.readFileSync(path.join(root, '.githooks', 'pre-commit'), 'utf8');
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        // Checking the working tree let an unstaged fix pass a broken commit.
        assert.ok(hook.includes('git show'));
        assert.ok(hook.includes('node tools/release-notes.js --check --root'));
        // BSD mktemp (macOS) requires a template; a bare `mktemp -d` is GNU-only
        // and would fail the hook outright there.
        assert.match(hook, /mktemp -d "\$\{TMPDIR:-\/tmp\}\/[^"]*X{6,}"/);
        assert.strictEqual(pkg.scripts.prepare, 'node tools/install-git-hooks.js');
        assert.strictEqual(pkg.scripts['check:release'], 'node tools/release-notes.js --check');
    });

});
