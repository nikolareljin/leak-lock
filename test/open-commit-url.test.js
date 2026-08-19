const assert = require('assert');
const path = require('path');
const { buildCommitUrl, isPermalinkUrl } = require('../git-permalink');
const LeakLockPanel = require('../leakLockPanel');

// _resolveCommitUrl is a small method on the panel class. Rather than boot a
// webview, exercise the same resolution the handler performs, against the same
// guards. The point of the test is that an index the webview supplies can never
// widen into an arbitrary URL.
function resolveCommitUrl(scanResults, remoteInfo, findingIndex) {
    if (!Number.isInteger(findingIndex) || findingIndex < 0 || findingIndex >= scanResults.length) {
        return null;
    }
    const finding = scanResults[findingIndex];
    const url = buildCommitUrl(remoteInfo, {
        commitHash: finding.commitHash,
        file: finding.file,
        line: finding.line
    });
    return url && isPermalinkUrl(url, remoteInfo) ? url : null;
}

const SHA = 'abc1234567890abcdef1234567890abcdef12345';
const REMOTE = { host: 'github.com', owner: 'o', repo: 'r', platform: 'github' };
const RESULTS = [{ commitHash: SHA, file: 'src/a.js', line: 5 }];

suite('openCommitUrl resolution', () => {

    test('resolves a valid index to the permalink', () => {
        assert.strictEqual(
            resolveCommitUrl(RESULTS, REMOTE, 0),
            `https://github.com/o/r/blob/${SHA}/src/a.js#L5`
        );
    });

    test('an out-of-range index resolves to null', () => {
        assert.strictEqual(resolveCommitUrl(RESULTS, REMOTE, 99), null);
        assert.strictEqual(resolveCommitUrl(RESULTS, REMOTE, -1), null);
    });

    test('a non-integer index resolves to null', () => {
        assert.strictEqual(resolveCommitUrl(RESULTS, REMOTE, '0'), null);
        assert.strictEqual(resolveCommitUrl(RESULTS, REMOTE, 1.5), null);
        assert.strictEqual(resolveCommitUrl(RESULTS, REMOTE, null), null);
    });

    test('no resolvable remote means no URL, not a broken one', () => {
        assert.strictEqual(resolveCommitUrl(RESULTS, null, 0), null);
    });

    test('a finding with no commit resolves to null', () => {
        assert.strictEqual(resolveCommitUrl([{ file: 'a.js', line: 1 }], REMOTE, 0), null);
    });

    test('omits a scanner-repeated repository directory from an inline permalink', () => {
        const repoRoot = path.join(path.sep, 'tmp', 'damn-vulnerable-repo');
        const panel = new LeakLockPanel({ fsPath: path.join(path.sep, 'tmp', 'extension') });
        panel._scanPath = repoRoot;
        panel._scanRepoRoot = repoRoot;
        panel._remoteInfo = REMOTE;
        panel._scanResults = [{
            commitHash: SHA,
            file: 'damn-vulnerable-repo/leaklock-fixture/experiment.py',
            line: 1
        }];

        assert.strictEqual(
            panel._resolveCommitUrl(0),
            `https://github.com/o/r/blob/${SHA}/leaklock-fixture/experiment.py#L1`
        );
    });

    test('a finding whose directory has no repository above it falls back to the scan root', async () => {
        // findGitRoot returns null for a path that no longer exists on disk — a
        // history finding for a deleted file, say. The scanned repository is still
        // known, so the permalink must not be dropped.
        const repoRoot = path.join(path.sep, 'tmp', 'no-such-repo-anywhere');
        const panel = new LeakLockPanel({ fsPath: path.join(path.sep, 'tmp', 'extension') });
        panel._scanPath = repoRoot;
        panel._scanRepoRoot = repoRoot;
        panel._remoteInfo = REMOTE;
        panel._scanResults = [{ commitHash: SHA, file: 'deleted/secrets.env', line: 3 }];

        assert.strictEqual(
            await panel._resolveCommitUrlVerified(0),
            `https://github.com/o/r/blob/${SHA}/deleted/secrets.env#L3`
        );
    });

    test('priming repository info walks the tree once per directory, not once per finding', async () => {
        // findGitRoot does an existsSync per level, and this runs on the scan's
        // critical path. A 2,000-row scan through five directories must cost five
        // walks, not two thousand.
        const fs = require('fs');
        const os = require('os');
        const cp = require('child_process');

        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'leaklock-prime-'));
        try {
            cp.execFileSync('git', ['init', '--quiet', repo]);
            const dirs = ['a', 'b', 'c', 'd', 'e'];
            for (const dir of dirs) {
                fs.mkdirSync(path.join(repo, dir));
            }
            const results = [];
            for (let i = 0; i < 2000; i++) {
                results.push({ file: path.join(dirs[i % dirs.length], `f${i}.js`), commitHash: SHA, line: 1 });
            }

            const realExistsSync = fs.existsSync;
            let gitLookups = 0;
            fs.existsSync = (target) => {
                if (String(target).endsWith(`${path.sep}.git`)) {
                    gitLookups++;
                }
                return realExistsSync(target);
            };
            const panel = new LeakLockPanel({ fsPath: path.join(path.sep, 'tmp', 'extension') });
            try {
                await panel._primeFindingRepoInfo(results, repo);
            } finally {
                fs.existsSync = realExistsSync;
            }

            assert.ok(gitLookups <= dirs.length * 2,
                `expected one walk per directory, saw ${gitLookups} .git probes for ${results.length} findings`);
            // Memoising must not change the answer.
            assert.ok(results.every(r => r.repoRoot === repo),
                'every finding is still attributed to the repository that owns it');
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });
});
