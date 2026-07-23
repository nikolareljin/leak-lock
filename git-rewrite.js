// Ref-complete git history rewrite helpers.
//
// `git push --force --all` expands to refs/heads/* only. A branch that exists
// solely as refs/remotes/<remote>/* gets rewritten locally by a `-- --all`
// rewrite but is never pushed, so the old history survives on the server and
// comes back on the next fetch. Every function here exists to close that gap:
// materialise a local branch for each remote branch first, rewrite, push
// atomically, then verify each remote ref.
//
// No `vscode` import on purpose - this module is unit-testable on its own.

const { execFile, spawn } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);

const DEFAULT_REMOTE = 'origin';
// History rewrites on large repos produce a lot of output on stdout.
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Raised when local branches hold commits the remote does not have.
 * Materialising remote branches force-resets local branches, which would
 * discard those commits, so the rewrite is blocked instead.
 */
class AheadBranchesError extends Error {
    constructor(branches) {
        const list = branches.map(b => `${b.branch} (+${b.count})`).join(', ');
        super(`Local branches have unpushed commits that a history rewrite would discard: ${list}`);
        this.name = 'AheadBranchesError';
        this.branches = branches;
    }
}

async function git(repoDir, args, options = {}) {
    return execFileAsync('git', args, { cwd: repoDir, maxBuffer: MAX_BUFFER, ...options });
}

async function gitLines(repoDir, args) {
    const { stdout } = await git(repoDir, args);
    return stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

/** POSIX single-quote escaping, for values embedded in a generated shell script. */
function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Escape a literal so it can sit inside a `grep -E` pattern. */
function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function hasRemote(repoDir, remote = DEFAULT_REMOTE) {
    const remotes = await gitLines(repoDir, ['remote']);
    return remotes.includes(remote);
}

async function getRemoteUrl(repoDir, remote = DEFAULT_REMOTE) {
    try {
        const { stdout } = await git(repoDir, ['remote', 'get-url', remote]);
        return stdout.trim() || null;
    } catch {
        return null;
    }
}

/**
 * `git filter-repo` deletes the origin remote by design, so the push stage
 * would fail right after a successful rewrite. Re-add it when it went missing.
 */
async function ensureRemote(repoDir, remote, url) {
    if (!url) {
        return false;
    }
    if (await hasRemote(repoDir, remote)) {
        return false;
    }
    await git(repoDir, ['remote', 'add', remote, url]);
    return true;
}

/** Refresh every ref. Unlike a best-effort fetch, failures reject. */
async function fetchAllRefs(repoDir, remote = DEFAULT_REMOTE) {
    await git(repoDir, ['fetch', '--prune', '--tags', remote]);
}

/** Current branch name, or null when HEAD is detached. */
async function getCurrentBranch(repoDir) {
    try {
        const { stdout } = await git(repoDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
        return stdout.trim() || null;
    } catch {
        return null;
    }
}

async function listLocalBranches(repoDir) {
    return gitLines(repoDir, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads']);
}

async function listRemoteBranches(repoDir, remote = DEFAULT_REMOTE) {
    const refs = await gitLines(repoDir, [
        'for-each-ref',
        '--format=%(refname:strip=3)',
        `refs/remotes/${remote}`
    ]);
    // The symbolic refs/remotes/<remote>/HEAD is not a branch.
    return refs.filter(name => name !== 'HEAD');
}

async function listTags(repoDir) {
    return gitLines(repoDir, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/tags']);
}

/**
 * Classify local branches against the remote.
 * `ahead` blocks the rewrite (those commits would be discarded);
 * `localOnly` is informational (the push creates them on the remote).
 */
async function findUnsafeLocalBranches(repoDir, remote = DEFAULT_REMOTE) {
    const [locals, remotes] = await Promise.all([
        listLocalBranches(repoDir),
        listRemoteBranches(repoDir, remote)
    ]);
    const remoteSet = new Set(remotes);
    const ahead = [];
    const localOnly = [];

    for (const branch of locals) {
        if (!remoteSet.has(branch)) {
            localOnly.push(branch);
            continue;
        }
        const { stdout } = await git(repoDir, [
            'rev-list',
            '--count',
            `${remote}/${branch}..${branch}`
        ]);
        const count = parseInt(stdout.trim(), 10);
        if (Number.isFinite(count) && count > 0) {
            ahead.push({ branch, count });
        }
    }

    return { ahead, localOnly };
}

/**
 * Ref-by-ref preview of what the push will do, so the user reviews an explicit
 * plan instead of trusting a blanket `git push --force --all`.
 */
async function buildPushPlan(repoDir, remote = DEFAULT_REMOTE) {
    const [locals, remotes, tags] = await Promise.all([
        listLocalBranches(repoDir),
        listRemoteBranches(repoDir, remote),
        listTags(repoDir)
    ]);
    const localSet = new Set(locals);

    return {
        remote,
        // Every remote branch is force-updated: the ones missing locally are
        // materialised first precisely so they are not skipped.
        forceUpdate: remotes.slice().sort(),
        remoteOnly: remotes.filter(b => !localSet.has(b)).sort(),
        create: locals.filter(b => !remotes.includes(b)).sort(),
        tags: tags.slice().sort()
    };
}

/**
 * Reset every local branch to its remote counterpart and create the missing
 * ones. HEAD is detached first because git refuses to force-update the branch
 * that is currently checked out.
 */
async function materializeRemoteBranches(repoDir, remote = DEFAULT_REMOTE) {
    const currentBranch = await getCurrentBranch(repoDir);
    if (currentBranch) {
        await git(repoDir, ['checkout', '--detach', '--quiet']);
    }
    const branches = await listRemoteBranches(repoDir, remote);
    for (const branch of branches) {
        await git(repoDir, [
            'branch',
            '--force',
            '--no-track',
            branch,
            `refs/remotes/${remote}/${branch}`
        ]);
    }
    return { detachedFrom: currentBranch, materialized: branches };
}

async function restoreBranch(repoDir, branch) {
    if (!branch) {
        return;
    }
    await git(repoDir, ['checkout', '--quiet', branch]);
}

/** Delete the refs/original/* backups that filter-branch leaves behind. */
async function dropOriginalRefs(repoDir) {
    const { stdout } = await git(repoDir, [
        'for-each-ref',
        '--format=delete %(refname)',
        'refs/original/'
    ]);
    if (!stdout.trim()) {
        return 0;
    }
    // execFile has no stdin plumbing - spawn is required to pipe the ref list in.
    await new Promise((resolve, reject) => {
        const proc = spawn('git', ['update-ref', '--stdin'], { cwd: repoDir });
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`git update-ref failed with exit code ${code}`));
            }
        });
        proc.stdin.on('error', reject);
        proc.stdin.write(stdout);
        proc.stdin.end();
    });
    return stdout.trim().split('\n').length;
}

async function expireReflogAndGc(repoDir) {
    await git(repoDir, ['reflog', 'expire', '--expire=now', '--all']);
    await git(repoDir, ['gc', '--prune=now', '--aggressive']);
}

/**
 * --atomic makes the server reject the whole push if any single ref fails
 * (a protected branch, say) instead of leaving the remote half-rewritten.
 */
async function pushRewritten(repoDir, remote = DEFAULT_REMOTE) {
    await git(repoDir, ['push', '--force', '--atomic', '--all', remote]);
    await git(repoDir, ['push', '--force', '--atomic', '--tags', remote]);
}

/**
 * Re-fetch and confirm the leak is gone from every remote ref, not just the
 * one that happened to be checked out.
 * @param {object} criteria { pathPattern?: RegExp source string, literals?: string[] }
 * @returns {Promise<Array<{ref: string, reason: string, match: string}>>} offending refs
 */
async function verifyRemoteRefs(repoDir, remote = DEFAULT_REMOTE, criteria = {}) {
    await fetchAllRefs(repoDir, remote);
    const refs = await gitLines(repoDir, [
        'for-each-ref',
        '--format=%(refname)',
        `refs/remotes/${remote}`,
        'refs/tags'
    ]);
    const offenders = [];
    const pathRegex = criteria.pathPattern ? new RegExp(criteria.pathPattern) : null;
    const literals = Array.isArray(criteria.literals) ? criteria.literals : [];

    for (const ref of refs) {
        if (ref.endsWith('/HEAD')) {
            continue;
        }
        if (pathRegex) {
            const files = await gitLines(repoDir, ['ls-tree', '-r', '--name-only', ref]);
            const hit = files.find(file => pathRegex.test(file));
            if (hit) {
                offenders.push({ ref, reason: 'path still present', match: hit });
                continue;
            }
        }
        for (const literal of literals) {
            try {
                await git(repoDir, ['grep', '--quiet', '--fixed-strings', '-e', literal, ref]);
                offenders.push({ ref, reason: 'secret still present', match: literal });
                break;
            } catch {
                // Non-zero exit from `git grep` means "not found" - the goal.
            }
        }
    }

    return offenders;
}

/**
 * Emit the copy-pasteable equivalent of runRewrite(). The script and the
 * in-extension execution must stay in lockstep - both follow the sequence
 * documented here.
 * @param {object} options
 * @param {string} options.repoDir
 * @param {string} [options.remote]
 * @param {string[]} options.rewriteLines shell lines performing the actual rewrite
 * @param {string} [options.verifyRegex] grep -E pattern for the verification loop
 * @param {string[]} [options.verifyLiterals] fixed strings to grep for in each ref
 * @param {boolean} [options.restoreRemote] re-add the remote after the rewrite
 * @param {string} [options.remoteUrl]
 */
function buildRewriteScript(options) {
    const {
        repoDir,
        remote = DEFAULT_REMOTE,
        rewriteLines = [],
        verifyRegex = null,
        verifyLiterals = [],
        restoreRemote = false,
        remoteUrl = null
    } = options || {};

    const remoteQ = shellQuote(remote);
    const lines = [
        '#!/bin/bash',
        '# Generated by Leak Lock - rewrites git history across ALL refs.',
        '# Review before running. This is destructive and cannot be undone.',
        'set -euo pipefail',
        '',
        `cd ${shellQuote(repoDir)}`,
        '',
        '# 1. Refresh every ref before planning the rewrite.',
        `git fetch --prune --tags ${remoteQ}`,
        '',
        '# 2. Abort if any local branch holds commits the remote lacks - step 4',
        '#    force-resets local branches and would discard them.',
        'unpushed=""',
        `for branch in $(git for-each-ref --format='%(refname:strip=2)' refs/heads); do`,
        `\tif git rev-parse --verify --quiet "refs/remotes/${remote}/\${branch}" >/dev/null; then`,
        `\t\tcount="$(git rev-list --count "${remote}/\${branch}..\${branch}")"`,
        '\t\tif [ "$count" -gt 0 ]; then',
        '\t\t\tunpushed="${unpushed}\\n  ${branch} (+${count} commit(s))"',
        '\t\tfi',
        '\tfi',
        'done',
        'if [ -n "$unpushed" ]; then',
        '\techo "Refusing to rewrite - these local branches have unpushed commits:" >&2',
        '\tprintf "%b\\n" "$unpushed" >&2',
        '\techo "Push them first, then re-run." >&2',
        '\texit 1',
        'fi',
        '',
        '# 3. Detach HEAD: git refuses to force-update the checked-out branch.',
        `current_branch="$(git symbolic-ref --quiet --short HEAD || true)"`,
        'if [ -n "$current_branch" ]; then',
        '\t# Restore the branch on ANY exit (set -e aborts if e.g. a protected',
        '\t# branch rejects the push) so the repo is never left detached.',
        `\ttrap 'git checkout --quiet "$current_branch" 2>/dev/null || true' EXIT`,
        '\tgit checkout --detach --quiet',
        'fi',
        '',
        '# 4. Materialise a local branch for every remote branch. Without this,',
        '#    `git push --force --all` (refs/heads/* only) never touches',
        '#    remote-only branches and the old history survives on the server.',
        `for branch in $(git for-each-ref --format='%(refname:strip=3)' refs/remotes/${remote} | grep -v '^HEAD$'); do`,
        `\tgit branch --force --no-track "\${branch}" "refs/remotes/${remote}/\${branch}"`,
        'done',
        '',
        '# 5. Rewrite across ALL refs.'
    ];

    lines.push(...rewriteLines);

    lines.push(
        '',
        '# 6. Drop the rewrite backup refs and repack.',
        'git for-each-ref --format="delete %(refname)" refs/original/ | git update-ref --stdin',
        'git reflog expire --expire=now --all',
        'git gc --prune=now --aggressive'
    );

    if (restoreRemote && remoteUrl) {
        lines.push(
            '',
            '# git filter-repo removes the remote by design - put it back.',
            `git remote get-url ${remoteQ} >/dev/null 2>&1 || git remote add ${remoteQ} ${shellQuote(remoteUrl)}`
        );
    }

    lines.push(
        '',
        '# 7. --atomic: the server rejects the WHOLE push if any single ref fails',
        '#    (e.g. a protected branch) instead of leaving a half-rewritten remote.',
        `git push --force --atomic --all ${remoteQ}`,
        `git push --force --atomic --tags ${remoteQ}`,
        '',
        '# 8. Restore the branch that was checked out before the rewrite.',
        'if [ -n "$current_branch" ]; then',
        '\tgit checkout --quiet "$current_branch"',
        'fi'
    );

    if (verifyRegex || verifyLiterals.length > 0) {
        lines.push(
            '',
            '# 9. Verify the remote is actually clean on EVERY ref.',
            `git fetch --prune --tags ${remoteQ}`,
            'leftover=0',
            `for ref in $(git for-each-ref --format='%(refname)' refs/remotes/${remote} refs/tags | grep -v '/HEAD$'); do`
        );
        if (verifyRegex) {
            lines.push(
                `\tif git ls-tree -r --name-only "$ref" | grep -qE ${shellQuote(verifyRegex)}; then`,
                '\t\techo "STILL PRESENT (path): $ref"',
                '\t\tleftover=1',
                '\tfi'
            );
        }
        for (const literal of verifyLiterals) {
            lines.push(
                `\tif git grep --quiet --fixed-strings -e ${shellQuote(literal)} "$ref" 2>/dev/null; then`,
                '\t\techo "STILL PRESENT (secret): $ref"',
                '\t\tleftover=1',
                '\tfi'
            );
        }
        lines.push(
            'done',
            'if [ "$leftover" -eq 0 ]; then',
            '\techo "Verified clean on every remote ref."',
            'fi'
        );
    }

    lines.push('');
    return lines.join('\n');
}

/**
 * Run the full ref-complete rewrite. The caller supplies only the rewrite step
 * itself (BFG / filter-branch / filter-repo); everything around it - the ref
 * refresh, the ahead-branch block, materialisation, cleanup, atomic push,
 * branch restore and verification - is shared.
 *
 * @param {object} options
 * @param {string} options.repoDir
 * @param {string} [options.remote]
 * @param {() => Promise<void>} options.rewrite
 * @param {(message: string) => void} [options.progress]
 * @param {object|null} [options.verify] criteria for verifyRemoteRefs
 * @param {boolean} [options.push] force-push after the rewrite (default true)
 */
async function runRewrite(options) {
    const {
        repoDir,
        remote = DEFAULT_REMOTE,
        rewrite,
        progress = () => { },
        verify = null,
        push = true
    } = options || {};

    if (!repoDir) {
        throw new Error('runRewrite requires a repository directory.');
    }
    if (typeof rewrite !== 'function') {
        throw new Error('runRewrite requires a rewrite callback.');
    }

    const report = {
        remote,
        materialized: [],
        detachedFrom: null,
        pushed: false,
        remoteRestored: false,
        offenders: null,
        warnings: []
    };

    progress('Refreshing all refs...');
    await fetchAllRefs(repoDir, remote);

    progress('Checking for unpushed local commits...');
    const unsafe = await findUnsafeLocalBranches(repoDir, remote);
    if (unsafe.ahead.length > 0) {
        throw new AheadBranchesError(unsafe.ahead);
    }
    report.localOnly = unsafe.localOnly;

    const remoteUrl = await getRemoteUrl(repoDir, remote);

    progress('Materialising remote branches...');
    const materialized = await materializeRemoteBranches(repoDir, remote);
    report.materialized = materialized.materialized;
    report.detachedFrom = materialized.detachedFrom;

    try {
        progress('Rewriting history across all refs...');
        await rewrite();

        progress('Dropping backup refs...');
        await dropOriginalRefs(repoDir);

        progress('Expiring reflog and repacking...');
        await expireReflogAndGc(repoDir);

        report.remoteRestored = await ensureRemote(repoDir, remote, remoteUrl);

        if (push) {
            progress('Force-pushing every branch and tag...');
            await pushRewritten(repoDir, remote);
            report.pushed = true;
        }
    } finally {
        if (materialized.detachedFrom) {
            try {
                await restoreBranch(repoDir, materialized.detachedFrom);
            } catch (e) {
                // Never mask the original failure with a checkout error.
                report.warnings.push(`Could not restore branch ${materialized.detachedFrom}: ${e.message}`);
            }
        }
    }

    if (report.pushed && verify) {
        progress('Verifying every remote ref...');
        report.offenders = await verifyRemoteRefs(repoDir, remote, verify);
    }

    return report;
}

module.exports = {
    DEFAULT_REMOTE,
    AheadBranchesError,
    shellQuote,
    escapeRegex,
    hasRemote,
    getRemoteUrl,
    ensureRemote,
    fetchAllRefs,
    getCurrentBranch,
    listLocalBranches,
    listRemoteBranches,
    listTags,
    findUnsafeLocalBranches,
    buildPushPlan,
    materializeRemoteBranches,
    restoreBranch,
    dropOriginalRefs,
    expireReflogAndGc,
    pushRewritten,
    verifyRemoteRefs,
    buildRewriteScript,
    runRewrite
};
