const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'tools', 'fixtures');
const codeIssues = require('../tools/fixtures/seed-code-issues');

function git(cwd, ...args) {
    return execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
            GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
    }).trim();
}

function tempRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-tools-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'user.email', 't@example.invalid');
    fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
    git(dir, 'add', 'README.md');
    git(dir, 'commit', '-q', '-m', 'init');
    return dir;
}

suite('Test-fixture generators stay fixture-only', () => {
    // Files allowed to name the generators: the folder itself, documentation, the two
    // scanner configs that exclude it, and the tests that check it.
    const ALLOWED = [
        /^tools\/fixtures\//, /^docs\//, /\.md$/, /^\.gitleaks\.toml$/, /^\.foxguard\.yml$/,
        /^test\/fixture-tools\.test\.js$/,
        // Reads seed-fake-leaks.sh as text to check its shell portability.
        /^test\/extension\.test\.js$/
    ];

    test('nothing outside the fixtures folder and its docs uses the generators', () => {
        const files = git(ROOT, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n');
        const offenders = files.filter(file => file && !ALLOWED.some(rule => rule.test(file)))
            .filter(file => {
                const full = path.join(ROOT, file);
                if (!fs.existsSync(full) || fs.statSync(full).size > 2_000_000) return false;
                return /tools\/fixtures|seed-fake-leaks|seed-code-issues/.test(fs.readFileSync(full, 'utf8'));
            });
        assert.deepStrictEqual(offenders, []);
    });

    test('the generators are not packaged into the extension', () => {
        const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split('\n').map(l => l.trim());
        assert.ok(ignore.includes('tools/**'));
    });

    test('both scanners skip the fixtures folder, and only it', () => {
        const gitleaks = fs.readFileSync(path.join(ROOT, '.gitleaks.toml'), 'utf8');
        assert.match(gitleaks, /useDefault = true/);
        assert.match(gitleaks, /'''\^tools\/fixtures\/'''/);
        const foxguard = fs.readFileSync(path.join(ROOT, '.foxguard.yml'), 'utf8');
        assert.match(foxguard, /exclude_paths:\n\s+- tools\/fixtures\n/);
        for (const [, file] of foxguard.matchAll(/- path: (\S+)/g)) {
            assert.ok(file.startsWith('tools/fixtures/'), `${file} is outside tools/fixtures`);
        }
    });
});

suite('seed-code-issues.js never touches a remote', () => {
    test('every remote-facing git subcommand is refused before git runs', () => {
        for (const sub of ['push', 'fetch', 'pull', 'clone', 'remote', 'ls-remote', 'submodule', 'send-pack']) {
            assert.throws(() => codeIssues.runGit(os.tmpdir(), [sub, 'origin']), /never touches a remote/, sub);
            // Options before the subcommand do not hide it.
            assert.throws(() => codeIssues.runGit(os.tmpdir(), ['-q', sub]), /never touches a remote/, sub);
        }
    });

    test('a throwaway repository is created under the temp directory with no remote', function () {
        this.timeout(20000);
        const repo = codeIssues.createThrowawayRepo();
        try {
            assert.ok(repo.startsWith(fs.realpathSync(os.tmpdir())) || repo.startsWith(os.tmpdir()));
            assert.strictEqual(git(repo, 'remote'), '');
            for (const file of Object.keys(codeIssues.SAMPLES)) {
                assert.ok(fs.existsSync(path.join(repo, codeIssues.DIR, file)), file);
            }
        } finally {
            fs.rmSync(path.dirname(repo), { recursive: true, force: true });
        }
    });

    test('--into commits locally and leaves the remote configuration alone', function () {
        this.timeout(20000);
        const repo = tempRepo();
        try {
            git(repo, 'remote', 'add', 'origin', 'https://example.invalid/owner/repo.git');
            codeIssues.seedExistingRepo(repo, { base: 'HEAD', reset: false });
            assert.strictEqual(git(repo, 'branch', '--show-current'), codeIssues.BRANCH);
            assert.strictEqual(git(repo, 'remote', '-v').split('\n').length, 2);
            assert.match(git(repo, 'remote', 'get-url', 'origin'), /example\.invalid/);
            assert.strictEqual(git(repo, 'for-each-ref', 'refs/remotes'), '');
            assert.throws(() => codeIssues.seedExistingRepo(repo, { base: 'HEAD', reset: false }), /already exists/);
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });

    test('--into refuses the Leak Lock repository itself', () => {
        assert.throws(() => codeIssues.seedExistingRepo(ROOT, { base: 'HEAD', reset: false }), /Leak Lock repository itself/);
    });
});

suite('seed-fake-leaks.sh pushes only to a remote on this disk', () => {
    test('a hosted origin is refused and the push commands are printed instead', function () {
        if (process.platform === 'win32') return this.skip();
        this.timeout(60000);
        const repo = tempRepo();
        try {
            git(repo, 'remote', 'add', 'origin', 'https://example.invalid/owner/repo.git');
            const run = spawnSync('bash', [path.join(FIXTURES, 'seed-fake-leaks.sh'), repo, '--push', '--github-safe'],
                { encoding: 'utf8' });
            assert.strictEqual(run.status, 2, run.stderr);
            assert.match(run.stderr, /refusing to push: origin is not a local path/);
            assert.match(run.stderr, /push -f origin leaklock-fixture\/main-leaks:leaklock-fixture\/main-leaks/);
            assert.strictEqual(git(repo, 'for-each-ref', 'refs/remotes'), '');
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });
});
