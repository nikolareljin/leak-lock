const assert = require('assert');
const gitRewrite = require('../git-rewrite');

// The PowerShell generator emits a DESTRUCTIVE script: it rewrites every ref and
// force-pushes. It arrived with no tests while its bash counterpart has several,
// and it cannot be exercised by running it — nothing here has a Windows host. So
// these assert on the emitted text, which is the artifact the user actually
// runs, and concentrate on the properties that would be dangerous to get wrong.

function ps(extra = {}) {
    return gitRewrite.buildRewriteScriptPs1({
        repoDir: 'C:\\repos\\thing',
        rewriteLines: ['& git filter-repo --force'],
        ...extra
    });
}

suite('psQuote', () => {

    test('wraps in single quotes', () => {
        assert.strictEqual(gitRewrite.psQuote('plain'), "'plain'");
    });

    test("doubles embedded single quotes, which is how PowerShell escapes them", () => {
        // The one that matters. PowerShell ends a single-quoted string at the
        // first quote; a path or replacement value containing one would close
        // the literal early and turn the remainder into executable code.
        assert.strictEqual(gitRewrite.psQuote("O'Brien"), "'O''Brien'");
        assert.strictEqual(gitRewrite.psQuote("a'; Remove-Item C:\\ -Recurse; '"),
            "'a''; Remove-Item C:\\ -Recurse; '''");
    });

    test('leaves backslashes alone — PowerShell single quotes are literal', () => {
        assert.strictEqual(gitRewrite.psQuote('C:\\a\\b'), "'C:\\a\\b'");
    });

    test('coerces non-strings rather than throwing', () => {
        assert.strictEqual(gitRewrite.psQuote(42), "'42'");
    });
});

suite('findPathInCommit', () => {

    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { execFileSync } = require('child_process');

    let repo;
    let sha;

    suiteSetup(() => {
        // A real repository, because the point of this function is that git —
        // not a heuristic — decides which path is real.
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'leaklock-commit-'));
        const run = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
        run('init', '--quiet');
        run('config', 'user.email', 'fixture@example.invalid');
        run('config', 'user.name', 'Fixture');
        fs.mkdirSync(path.join(repo, 'fixture'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'fixture', 'db.yml'), 'password: placeholder\n');
        run('add', '-A');
        run('commit', '--quiet', '-m', 'fixture');
        sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    });

    suiteTeardown(() => {
        if (repo) { fs.rmSync(repo, { recursive: true, force: true }); }
    });

    test('picks the candidate that exists at the commit, not the first offered', async () => {
        const found = await gitRewrite.findPathInCommit(repo, sha, [
            'some-repo/fixture/db.yml',   // the prefixed reading — not real
            'fixture/db.yml'              // the real one
        ]);
        assert.strictEqual(found, 'fixture/db.yml');
    });

    test('prefers the earlier candidate when both exist', async () => {
        const found = await gitRewrite.findPathInCommit(repo, sha, ['fixture/db.yml', 'fixture/db.yml']);
        assert.strictEqual(found, 'fixture/db.yml');
    });

    test('returns null when nothing matches, rather than guessing', async () => {
        // A guess here becomes a link that 404s, which reads as Leak Lock
        // pointing at the wrong commit.
        assert.strictEqual(await gitRewrite.findPathInCommit(repo, sha, ['nope/a.yml']), null);
        assert.strictEqual(await gitRewrite.findPathInCommit(repo, sha, []), null);
    });

    test('an unknown commit yields null rather than throwing', async () => {
        const missing = '0000000000000000000000000000000000000000';
        assert.strictEqual(await gitRewrite.findPathInCommit(repo, missing, ['fixture/db.yml']), null);
    });
});

suite('buildRewriteScriptPs1', () => {

    test('a repo path containing a quote cannot break out of the literal', () => {
        const out = ps({ repoDir: "C:\\a'; Remove-Item C:\\ -Recurse; '" });
        assert.ok(
            out.includes("Set-Location 'C:\\a''; Remove-Item C:\\ -Recurse; '''"),
            'the path must be emitted as one escaped literal'
        );
    });

    test('stops on the first error instead of continuing through a half-rewrite', () => {
        assert.match(ps(), /\$ErrorActionPreference = 'Stop'/);
    });

    test('checks required commands before doing destructive work', () => {
        const out = ps({ requiredCommands: ['git', 'java'] });
        const checkAt = out.indexOf('Get-Command');
        const rewriteAt = out.indexOf('filter-repo --force');
        assert.ok(checkAt > -1, 'should check for required commands');
        assert.ok(checkAt < rewriteAt, 'the check must precede the rewrite, not follow it');
    });

    test('uses the standalone pip launcher when Git cannot discover filter-repo', () => {
        const out = ps({ requiredCommands: ['git-filter-repo'] });
        assert.match(out, /& git filter-repo --version/, 'tries Git\'s subcommand first');
        assert.match(out, /Get-Command git-filter-repo/, 'then looks for pip\'s PATH launcher');
        assert.match(out, /function Invoke-GitFilterRepo \{ & git-filter-repo @args \}/);
        // One install line everywhere — python3, and --user — so a machine without a
        // `python` shim is not told to run a command it does not have.
        assert.match(out, /python3 -m pip install --user git-filter-repo/,
            'and should say how to install it');
    });

    test('secret replacements go to a rule file, never inline in the script', () => {
        const out = ps({ replacementsContent: 'AKIAIOSFODNN7EXAMPLE==>REDACTED' });
        // In the git directory, not $env:TEMP: a confined git-filter-repo cannot read
        // a host temp path, and the git directory is outside the working tree, so the
        // raw values can never be staged.
        assert.match(out, /\$git_dir = \(& git rev-parse --absolute-git-dir\)/);
        assert.match(out, /\$replacement_dir = Join-Path \$git_dir 'leak-lock'/);
        assert.ok(!out.includes('GetTempFileName()'), 'no host temp path for the rule file');
        assert.match(out, /WriteAllText\(\$replacement_file/, 'written to the file');
        const setLocationAt = out.indexOf('Set-Location');
        assert.ok(setLocationAt > -1 && setLocationAt < out.indexOf('$git_dir ='),
            'the repository is entered first, so `git rev-parse` resolves');
    });

    test('the temp file is locked to the current user', () => {
        const out = ps({ replacementsContent: 'a==>b' });
        // The Windows equivalent of chmod 600: break inheritance, drop every
        // inherited rule, then grant only the current identity.
        assert.match(out, /SetAccessRuleProtection\(\$true, \$false\)/);
        assert.match(out, /RemoveAccessRule/);
        assert.match(out, /WindowsIdentity\]::GetCurrent\(\)\.Name/);
        assert.match(out, /Set-Acl \$replacement_file/);
    });

    test('the rule file survives a failed rewrite and is reported, not deleted', () => {
        const out = ps({ replacementsContent: 'a==>b', verifyLiterals: ['a'] });
        const finallyAt = out.indexOf('} finally {');
        const removeAt = out.indexOf('Remove-Item $replacement_file');
        assert.ok(finallyAt > -1, 'must have a finally block');
        // Deleting it in `finally` destroyed the only copy of what still had to be
        // redacted whenever the rewrite failed. It is removed on the happy path only.
        assert.ok(removeAt > -1 && removeAt < finallyAt, 'cleanup runs after a successful rewrite');
        assert.match(out, /Write-Warning "Replacement rules kept for a retry: \$replacement_file"/);
        assert.ok(out.indexOf('Write-Warning "Replacement rules kept') > finallyAt,
            'the retained path is reported from finally');
    });

    test('drops the alias refs a rewrite leaves behind, and verifies past them', () => {
        const out = ps({ replacementsContent: 'a==>b', verifyRulesFile: '$replacement_file' });
        assert.match(out, /refs\/original\/ refs\/replace\//, 'both ref namespaces are deleted');
        assert.match(out, /git --no-replace-objects grep --quiet/,
            'verification must bypass refs/replace, or a still-leaking ref reads as clean');
    });

    test('parses as valid PowerShell', function () {
        // The bash generator is checked with `bash -n`; this is the equivalent, and
        // the only way to catch a syntax error in the Windows script from a Linux
        // CI box. Skipped where PowerShell is unavailable rather than faked.
        const cp = require('child_process');
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const probe = cp.spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']);
        if (probe.error) { this.skip(); return; }

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaklock-ps1-'));
        const file = path.join(dir, 'cleanup.ps1');
        try {
            fs.writeFileSync(file, ps({
                replacementsContent: 'AKIA==>REDACTED',
                verifyRulesFile: '$replacement_file',
                requiredCommands: ['git', 'git-filter-repo'],
                restoreRemote: true,
                remoteUrl: 'git@example.com:repo.git'
            }));
            const parse = cp.spawnSync('pwsh', ['-NoProfile', '-Command',
                `$e = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$e); `
                + 'if ($e.Count) { $e | ForEach-Object { Write-Host $_.Message }; exit 1 }']);
            assert.strictEqual(parse.status, 0, parse.stdout.toString() + parse.stderr.toString());
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('no rule-file machinery when there are no replacements', () => {
        const out = ps();
        assert.ok(!out.includes('$replacement_file'), 'nothing to protect, nothing to create');
    });

    test('refreshes every ref before planning the rewrite', () => {
        assert.match(ps(), /& git fetch --prune --tags 'origin'/);
    });

    test('blocks when local branches hold commits the remote lacks', () => {
        // Materialising remote branches force-resets local ones, discarding them.
        const out = ps();
        assert.match(out, /\$unpushed/);
        assert.match(out, /rev-list --count/);
    });

    test('examining nothing is never reported as clean', () => {
        // The bash generator had this exact bug: a ref-less remote printed
        // "Verified clean on every remote ref" and exited 0.
        const out = ps({ verifyLiterals: ['sekret'] });
        const zeroAt = out.indexOf('$checked -eq 0');
        const cleanAt = out.indexOf('Verified clean on every remote ref');
        assert.ok(zeroAt > -1, 'must count refs actually examined');
        assert.ok(cleanAt > zeroAt, 'the clean claim must sit behind the examined-nothing guard');
        assert.match(out, /NOT VERIFIED/);
    });

    test('a verification literal containing a quote stays quoted', () => {
        const out = ps({ verifyLiterals: ["it's-a-secret"] });
        assert.ok(out.includes("-e 'it''s-a-secret'"), 'the literal must be escaped, not interpolated');
    });

    test('restores the original branch in finally, without double-restoring', () => {
        const out = ps();
        const finallyAt = out.indexOf('} finally {');
        assert.ok(finallyAt > -1, 'must have a finally block');

        // There are deliberately TWO restores: the happy path restores and then
        // clears $current_branch, so the finally only fires when the rewrite
        // died before reaching it. Searching from the start would find the
        // first one and prove nothing about failure handling.
        const inFinally = out.indexOf('git checkout --quiet $current_branch', finallyAt);
        assert.ok(inFinally > finallyAt, 'the branch must be restored even on failure');

        const happyPath = out.indexOf('git checkout --quiet $current_branch');
        assert.ok(happyPath < finallyAt, 'expected a happy-path restore too');
        assert.ok(
            out.indexOf("$current_branch = ''", happyPath) < finallyAt,
            'the happy path must clear $current_branch so finally does not check out twice'
        );
    });

    test('names itself and warns before anything runs', () => {
        const out = ps();
        assert.match(out, /^# Generated by Leak Lock/);
        assert.match(out, /destructive and cannot be undone/);
        assert.match(out, /ExecutionPolicy Bypass/, 'and says how to run it at all');
    });
});
