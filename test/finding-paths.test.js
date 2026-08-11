const assert = require('assert');
const path = require('path');
const { describeFindingPath, repoRelativePath } = require('../finding-paths');

// Absolute fixture paths are BUILT, never written as literals.
//
// These tests previously used a made-up placeholder ('/home/u/repo' — a fake
// path, never anyone's real directory) and that was wrong for a reason that has
// nothing to do with privacy: a hard-coded POSIX path is POSIX-only. On Windows
// path.relative would not treat it the way these assertions assume, so they
// would pass while testing fiction. Building the paths keeps them correct on
// every platform, and keeps real directory layouts out of the repository as a
// side effect.
const SCAN_ROOT = path.resolve(path.sep, 'scan-root');
const REPO = path.join(SCAN_ROOT, 'a-repo');
const OUTSIDE = path.resolve(path.sep, 'elsewhere');

suite('repoRelativePath', () => {

    // A finding's `file` is relative to the SCANNED directory. A permalink needs
    // it relative to the GIT ROOT. Scanning a folder above the repository makes
    // those differ, and every generated URL carried the repository's own
    // directory name as a bogus first segment:
    //   /blob/<sha>/leak-lock/test/a.js   ->  404
    //   /blob/<sha>/test/a.js             ->  correct

    test('strips the scan-directory prefix when the scan root is above the repo', () => {
        assert.strictEqual(
            repoRelativePath(path.join('a-repo', 'test', 'a.js'), SCAN_ROOT, REPO),
            'test/a.js'
        );
    });

    test('is a no-op when the scan root is the repo root', () => {
        assert.strictEqual(
            repoRelativePath(path.join('test', 'a.js'), REPO, REPO),
            'test/a.js'
        );
    });

    test('handles a scan root below the repo root', () => {
        assert.strictEqual(
            repoRelativePath('a.js', path.join(REPO, 'src'), REPO),
            'src/a.js'
        );
    });

    test('uses forward slashes, because a URL path is not a filesystem path', () => {
        const result = repoRelativePath(path.join('sub', 'a.js'), REPO, REPO);
        assert.ok(!result.includes('\\'), 'a backslash would break the URL on Windows');
    });

    test('a file outside the repository yields null rather than a ../ URL', () => {
        assert.strictEqual(
            repoRelativePath(path.join('..', 'outside', 'a.js'), REPO, REPO),
            null
        );
    });

    test('missing inputs fall back to the path as given, never throwing', () => {
        assert.strictEqual(repoRelativePath(path.join('test', 'a.js'), null, null), 'test/a.js');
        assert.strictEqual(repoRelativePath(path.join('test', 'a.js'), REPO, null), 'test/a.js');
        assert.strictEqual(repoRelativePath(null, REPO, REPO), null);
    });

    test('an absolute finding path is relativized against the repo root', () => {
        assert.strictEqual(
            repoRelativePath(path.join(REPO, 'test', 'a.js'), SCAN_ROOT, REPO),
            'test/a.js'
        );
    });
});

suite('describeFindingPath', () => {

    test('a worktree finding resolves against the scan path', () => {
        const result = describeFindingPath({ file: path.join('src', 'config.js') }, REPO);
        assert.strictEqual(result.absolutePath, path.join(REPO, 'src', 'config.js'));
        assert.strictEqual(result.tooltip, path.join(REPO, 'src', 'config.js'));
    });

    test('a history finding names the commit instead of implying a file on disk', () => {
        const result = describeFindingPath(
            { file: path.join('src', 'old.js'), commitHash: 'abc1234567890abcdef1234567890abcdef1234' },
            REPO
        );
        assert.strictEqual(result.tooltip, `${path.join(REPO, 'src', 'old.js')} (at commit abc1234)`);
    });

    test('an already-absolute path is not joined twice', () => {
        const result = describeFindingPath({ file: path.join(OUTSIDE, 'a.js') }, REPO);
        assert.strictEqual(result.absolutePath, path.join(OUTSIDE, 'a.js'));
    });

    test('a missing scan path degrades to the relative path rather than throwing', () => {
        const result = describeFindingPath({ file: path.join('src', 'config.js') }, null);
        assert.strictEqual(result.absolutePath, null);
        assert.strictEqual(result.tooltip, path.join('src', 'config.js'));
    });

    test('a finding with no file yields an empty tooltip, not the string "null"', () => {
        const result = describeFindingPath({}, REPO);
        assert.strictEqual(result.absolutePath, null);
        assert.strictEqual(result.tooltip, '');
    });
});
