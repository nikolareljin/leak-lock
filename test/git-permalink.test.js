const assert = require('assert');
const { parseRemote, buildCommitUrl, isPermalinkUrl } = require('../git-permalink');

const SHA = 'abc1234567890abcdef1234567890abcdef12345';

suite('parseRemote', () => {

    test('parses the SCP-like SSH form', () => {
        assert.deepStrictEqual(
            parseRemote('git@github.com:nikolareljin/leak-lock.git'),
            { host: 'github.com', owner: 'nikolareljin', repo: 'leak-lock' }
        );
    });

    test('parses the HTTPS form', () => {
        assert.deepStrictEqual(
            parseRemote('https://github.com/nikolareljin/leak-lock.git'),
            { host: 'github.com', owner: 'nikolareljin', repo: 'leak-lock' }
        );
    });

    test('parses the ssh:// form', () => {
        assert.deepStrictEqual(
            parseRemote('ssh://git@github.com/nikolareljin/leak-lock.git'),
            { host: 'github.com', owner: 'nikolareljin', repo: 'leak-lock' }
        );
    });

    test('the .git suffix is optional', () => {
        assert.deepStrictEqual(
            parseRemote('https://github.com/nikolareljin/leak-lock'),
            { host: 'github.com', owner: 'nikolareljin', repo: 'leak-lock' }
        );
    });

    test('keeps GitLab subgroups in the owner', () => {
        assert.deepStrictEqual(
            parseRemote('git@gitlab.com:group/subgroup/thing.git'),
            { host: 'gitlab.com', owner: 'group/subgroup', repo: 'thing' }
        );
    });

    test('host casing is normalised', () => {
        assert.strictEqual(parseRemote('git@GitHub.COM:o/r.git').host, 'github.com');
    });

    test('an unknown host is null, so no link is offered', () => {
        assert.strictEqual(parseRemote('git@git.internal.example:o/r.git'), null);
    });

    test('a self-hosted GitLab is null rather than guessed', () => {
        assert.strictEqual(parseRemote('https://gitlab.example.com/o/r.git'), null);
    });

    test('a path with no repo segment is null', () => {
        assert.strictEqual(parseRemote('https://github.com/onlyowner'), null);
    });

    test('junk input is null, not a throw', () => {
        assert.strictEqual(parseRemote(''), null);
        assert.strictEqual(parseRemote('   '), null);
        assert.strictEqual(parseRemote(null), null);
        assert.strictEqual(parseRemote(undefined), null);
        assert.strictEqual(parseRemote(42), null);
        assert.strictEqual(parseRemote('http://['), null);
    });

    test('a non-git scheme is refused', () => {
        assert.strictEqual(parseRemote('file:///home/u/repo'), null);
        assert.strictEqual(parseRemote('javascript:alert(1)'), null);
    });
});

suite('buildCommitUrl', () => {

    const github = { host: 'github.com', owner: 'o', repo: 'r' };
    const gitlab = { host: 'gitlab.com', owner: 'group/sub', repo: 'r' };
    const bitbucket = { host: 'bitbucket.org', owner: 'o', repo: 'r' };

    test('GitHub blob URL with a line anchor', () => {
        assert.strictEqual(
            buildCommitUrl(github, { commitHash: SHA, file: 'src/a.js', line: 12 }),
            `https://github.com/o/r/blob/${SHA}/src/a.js#L12`
        );
    });

    test('GitLab uses the /-/blob infix and keeps subgroups unescaped as separators', () => {
        assert.strictEqual(
            buildCommitUrl(gitlab, { commitHash: SHA, file: 'src/a.js', line: 12 }),
            `https://gitlab.com/group/sub/r/-/blob/${SHA}/src/a.js#L12`
        );
    });

    test('Bitbucket uses /src and a different anchor', () => {
        assert.strictEqual(
            buildCommitUrl(bitbucket, { commitHash: SHA, file: 'src/a.js', line: 12 }),
            `https://bitbucket.org/o/r/src/${SHA}/src/a.js#lines-12`
        );
    });

    test('no line means no anchor, not #L0 or #Lnull', () => {
        assert.strictEqual(
            buildCommitUrl(github, { commitHash: SHA, file: 'src/a.js', line: null }),
            `https://github.com/o/r/blob/${SHA}/src/a.js`
        );
    });

    test('path segments are encoded but the separators survive', () => {
        assert.strictEqual(
            buildCommitUrl(github, { commitHash: SHA, file: 'a dir/b#c.js', line: 1 }),
            `https://github.com/o/r/blob/${SHA}/a%20dir/b%23c.js#L1`
        );
    });

    test('a missing commit, file, or remote yields null', () => {
        assert.strictEqual(buildCommitUrl(github, { commitHash: null, file: 'a.js', line: 1 }), null);
        assert.strictEqual(buildCommitUrl(github, { commitHash: SHA, file: null, line: 1 }), null);
        assert.strictEqual(buildCommitUrl(null, { commitHash: SHA, file: 'a.js', line: 1 }), null);
    });

    test('a non-hex commit hash is refused, so nothing user-controlled reaches the path', () => {
        assert.strictEqual(
            buildCommitUrl(github, { commitHash: '../../evil', file: 'a.js', line: 1 }),
            null
        );
    });
});

suite('isPermalinkUrl', () => {

    test('accepts a URL this module built', () => {
        assert.strictEqual(isPermalinkUrl(`https://github.com/o/r/blob/${SHA}/a.js#L1`), true);
    });

    test('rejects a lookalike host', () => {
        assert.strictEqual(isPermalinkUrl('https://github.com.evil.example/o/r'), false);
    });

    test('rejects a non-https scheme', () => {
        assert.strictEqual(isPermalinkUrl('http://github.com/o/r'), false);
        assert.strictEqual(isPermalinkUrl('javascript:alert(1)'), false);
    });

    test('rejects junk', () => {
        assert.strictEqual(isPermalinkUrl(''), false);
        assert.strictEqual(isPermalinkUrl(null), false);
    });
});
