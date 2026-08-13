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
    return url && isPermalinkUrl(url) ? url : null;
}

const SHA = 'abc1234567890abcdef1234567890abcdef12345';
const REMOTE = { host: 'github.com', owner: 'o', repo: 'r' };
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
});
