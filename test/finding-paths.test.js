const assert = require('assert');
const { describeFindingPath } = require('../finding-paths');

suite('describeFindingPath', () => {

    test('a worktree finding resolves against the scan path', () => {
        const result = describeFindingPath({ file: 'src/config.js' }, '/home/u/repo');
        assert.strictEqual(result.absolutePath, '/home/u/repo/src/config.js');
        assert.strictEqual(result.tooltip, '/home/u/repo/src/config.js');
    });

    test('a history finding names the commit instead of implying a file on disk', () => {
        const result = describeFindingPath(
            { file: 'src/old.js', commitHash: 'abc1234567890abcdef1234567890abcdef1234' },
            '/home/u/repo'
        );
        assert.strictEqual(result.tooltip, '/home/u/repo/src/old.js (at commit abc1234)');
    });

    test('an already-absolute path is not joined twice', () => {
        const result = describeFindingPath({ file: '/elsewhere/a.js' }, '/home/u/repo');
        assert.strictEqual(result.absolutePath, '/elsewhere/a.js');
    });

    test('a missing scan path degrades to the relative path rather than throwing', () => {
        const result = describeFindingPath({ file: 'src/config.js' }, null);
        assert.strictEqual(result.absolutePath, null);
        assert.strictEqual(result.tooltip, 'src/config.js');
    });

    test('a finding with no file yields an empty tooltip, not the string "null"', () => {
        const result = describeFindingPath({}, '/home/u/repo');
        assert.strictEqual(result.absolutePath, null);
        assert.strictEqual(result.tooltip, '');
    });
});
