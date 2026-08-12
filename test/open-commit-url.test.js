const assert = require('assert');
const { buildCommitUrl, isPermalinkUrl } = require('../git-permalink');

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

    test('uses the child repository context when a scan starts above it', () => {
        const LeakLockPanel = require('../leakLockPanel');
        const path = require('path');
        const scanRoot = path.resolve(path.sep, 'workspace');
        const childRepo = path.join(scanRoot, 'fixture-repo');
        const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
        panel._scanPath = scanRoot;
        panel._scanRepoRoot = null;
        panel._remoteInfo = null;
        panel._scanResults = [{
            file: path.join('fixture-repo', 'src', 'a.js'),
            commitHash: SHA,
            line: 5,
            repoRoot: childRepo,
            remoteInfo: REMOTE
        }];

        assert.strictEqual(
            panel._resolveCommitUrl(0),
            `https://github.com/o/r/blob/${SHA}/src/a.js#L5`
        );
    });

    test('opens the verified permalink in the default browser', async () => {
        const vscode = require('vscode');
        const LeakLockPanel = require('../leakLockPanel');
        const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
        const expected = `https://github.com/o/r/blob/${SHA}/src/a.js#L5`;
        panel._resolveCommitUrlVerified = async () => expected;
        const original = vscode.env.openExternal;
        let opened = null;
        try {
            Object.defineProperty(vscode.env, 'openExternal', {
                value: async (uri) => { opened = uri.toString(); return true; },
                configurable: true
            });
            await panel._openCommitUrl(0);
        } finally {
            Object.defineProperty(vscode.env, 'openExternal', { value: original, configurable: true });
        }
        assert.strictEqual(opened, expected);
    });

    test('surfaces a browser-launch failure instead of leaving the link inert', async () => {
        const vscode = require('vscode');
        const LeakLockPanel = require('../leakLockPanel');
        const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
        panel._resolveCommitUrlVerified = async () => `https://github.com/o/r/blob/${SHA}/src/a.js#L5`;
        const originalOpen = vscode.env.openExternal;
        const originalPrompt = vscode.window.showWarningMessage;
        let prompt = null;
        try {
            Object.defineProperty(vscode.env, 'openExternal', { value: async () => false, configurable: true });
            Object.defineProperty(vscode.window, 'showWarningMessage', {
                value: async (message, action) => { prompt = { message, action }; return undefined; },
                configurable: true
            });
            await panel._openCommitUrl(0);
        } finally {
            Object.defineProperty(vscode.env, 'openExternal', { value: originalOpen, configurable: true });
            Object.defineProperty(vscode.window, 'showWarningMessage', { value: originalPrompt, configurable: true });
        }
        assert.match(prompt.message, /could not open/i);
        assert.strictEqual(prompt.action, 'Copy permalink');
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
});
