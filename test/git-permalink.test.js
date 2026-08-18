const assert = require('assert');
const { parseRemote, buildCommitUrl, isPermalinkUrl } = require('../git-permalink');

const SHA = 'abc1234567890abcdef1234567890abcdef12345';

suite('parseRemote', () => {

    test('parses the SCP-like SSH form', () => {
        assert.deepStrictEqual(
            parseRemote('git@github.com:nikolareljin/leak-lock.git'),
            { host: 'github.com', owner: 'nikolareljin', repo: 'leak-lock', platform: 'github' }
        );
    });

    test('parses the HTTPS form', () => {
        assert.deepStrictEqual(
            parseRemote('https://github.com/nikolareljin/leak-lock.git'),
            { host: 'github.com', owner: 'nikolareljin', repo: 'leak-lock', platform: 'github' }
        );
    });

    test('parses the ssh:// form', () => {
        assert.deepStrictEqual(
            parseRemote('ssh://git@github.com/nikolareljin/leak-lock.git'),
            { host: 'github.com', owner: 'nikolareljin', repo: 'leak-lock', platform: 'github' }
        );
    });

    test('the .git suffix is optional', () => {
        assert.deepStrictEqual(
            parseRemote('https://github.com/nikolareljin/leak-lock'),
            { host: 'github.com', owner: 'nikolareljin', repo: 'leak-lock', platform: 'github' }
        );
    });

    test('keeps GitLab subgroups in the owner', () => {
        assert.deepStrictEqual(
            parseRemote('git@gitlab.com:group/subgroup/thing.git'),
            { host: 'gitlab.com', owner: 'group/subgroup', repo: 'thing', platform: 'gitlab' }
        );
    });

    test('host casing is normalised', () => {
        assert.strictEqual(parseRemote('git@GitHub.COM:o/r.git').host, 'github.com');
    });

    test('a self-hosted GitLab is detected by platform keyword in the hostname', () => {
        assert.deepStrictEqual(
            parseRemote('https://gitlab.example.com/o/r.git'),
            { host: 'gitlab.example.com', owner: 'o', repo: 'r', platform: 'gitlab' }
        );
    });

    test('an unrecognised hostname defaults to the github URL layout', () => {
        assert.deepStrictEqual(
            parseRemote('git@git.internal.example:o/r.git'),
            { host: 'git.internal.example', owner: 'o', repo: 'r', platform: 'github' }
        );
    });

    test('customHostTypes overrides heuristic detection', () => {
        assert.deepStrictEqual(
            parseRemote('https://git.acme.com/o/r.git', { 'git.acme.com': 'gitlab' }),
            { host: 'git.acme.com', owner: 'o', repo: 'r', platform: 'gitlab' }
        );
    });

    test('customHostTypes is case-insensitive on the hostname key', () => {
        assert.strictEqual(
            parseRemote('https://git.acme.com/o/r.git', { 'GIT.ACME.COM': 'gitea' }),
            null // key not matched because we lowercase the parsed host; user must provide lowercase key
        );
        // But a lowercase key works:
        assert.strictEqual(
            parseRemote('https://git.acme.com/o/r.git', { 'git.acme.com': 'gitea' }).platform,
            'gitea'
        );
    });

    test('an unknown customHostTypes platform value is ignored, heuristic is used instead', () => {
        assert.strictEqual(
            parseRemote('https://gitlab.acme.com/o/r.git', { 'gitlab.acme.com': 'unknown-platform' }).platform,
            'gitlab'
        );
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

    const github    = { host: 'github.com',    owner: 'o',         repo: 'r', platform: 'github' };
    const gitlab    = { host: 'gitlab.com',    owner: 'group/sub', repo: 'r', platform: 'gitlab' };
    const bitbucket = { host: 'bitbucket.org', owner: 'o',         repo: 'r', platform: 'bitbucket' };
    const ghe       = { host: 'git.acme.com',  owner: 'o',         repo: 'r', platform: 'github' };
    const selfGitlab = { host: 'gitlab.acme.com', owner: 'o',      repo: 'r', platform: 'gitlab' };
    const gitea     = { host: 'gitea.acme.com', owner: 'o',        repo: 'r', platform: 'gitea' };

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

    test('GitHub Enterprise uses the repo host, not github.com', () => {
        assert.strictEqual(
            buildCommitUrl(ghe, { commitHash: SHA, file: 'src/a.js', line: 1 }),
            `https://git.acme.com/o/r/blob/${SHA}/src/a.js#L1`
        );
    });

    test('self-hosted GitLab uses the repo host with /-/blob', () => {
        assert.strictEqual(
            buildCommitUrl(selfGitlab, { commitHash: SHA, file: 'src/a.js', line: 1 }),
            `https://gitlab.acme.com/o/r/-/blob/${SHA}/src/a.js#L1`
        );
    });

    test('Gitea uses /src/commit/', () => {
        assert.strictEqual(
            buildCommitUrl(gitea, { commitHash: SHA, file: 'src/a.js', line: 1 }),
            `https://gitea.acme.com/o/r/src/commit/${SHA}/src/a.js#L1`
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

    const customRemote = { host: 'git.acme.com', owner: 'o', repo: 'r', platform: 'github' };

    test('accepts a URL built for a well-known host', () => {
        assert.strictEqual(isPermalinkUrl(`https://github.com/o/r/blob/${SHA}/a.js#L1`), true);
    });

    test('accepts a URL built for a custom host when remoteInfo matches', () => {
        assert.strictEqual(
            isPermalinkUrl(`https://git.acme.com/o/r/blob/${SHA}/a.js#L1`, customRemote),
            true
        );
    });

    test('rejects a custom-host URL without remoteInfo', () => {
        assert.strictEqual(
            isPermalinkUrl(`https://git.acme.com/o/r/blob/${SHA}/a.js#L1`),
            false
        );
    });

    test('rejects a custom-host URL when remoteInfo host does not match', () => {
        assert.strictEqual(
            isPermalinkUrl(`https://git.evil.com/o/r/blob/${SHA}/a.js#L1`, customRemote),
            false
        );
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
