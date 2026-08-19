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

const { execFile, execFileSync, spawn } = require('child_process');
const util = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

/**
 * git filter-repo leaves `refs/replace/<old> -> <new>` behind, and every git read
 * honours those refs: `git show`, `git log`, `git grep` and anything built on them
 * silently answer with the REWRITTEN commit when asked about the ORIGINAL one. A
 * verification that trusts plain git therefore reports a still-leaking ref as
 * clean - the exact false all-clear this product exists to prevent. Every read
 * that decides whether a secret is gone runs with replacement disabled.
 */
const RAW_OBJECT_ENV = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };

/**
 * git(), with object replacement disabled. Use for anything that verifies.
 *
 * A caller's `env` keeps child_process semantics - it is the environment, not an
 * overlay on this process's - but GIT_NO_REPLACE_OBJECTS is written on top of it
 * afterwards, so no call site can drop the one setting that stops a rewrite's
 * replacement alias from making a still-dirty ref read as clean.
 */
async function gitRaw(repoDir, args, options = {}) {
    const { env, ...rest } = options;
    return git(repoDir, args, {
        ...rest,
        env: { ...(env || process.env), GIT_NO_REPLACE_OBJECTS: '1' }
    });
}

/**
 * Absolute path of a repository's git directory. Git itself answers first: the
 * scanned path may be a subdirectory rather than the repository root, and `.git`
 * is a file, not a directory, in linked worktrees and submodules - a blind
 * path.join is wrong in both cases. The filesystem lookup stays as a fallback for
 * when git cannot be executed. Returns null when repoDir is not a repository.
 */
function resolveGitDir(repoDir) {
    if (!repoDir) {
        return null;
    }
    try {
        const out = execFileSync('git', ['rev-parse', '--absolute-git-dir'],
            { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (out) {
            return out;
        }
    } catch {
        // Not a repository, or no git on PATH - fall through to the filesystem.
    }
    const dotGit = path.join(repoDir, '.git');
    let stats = null;
    try {
        stats = fs.statSync(dotGit);
    } catch {
        return null;
    }
    if (stats.isDirectory()) {
        return dotGit;
    }
    try {
        const pointer = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
        if (!pointer) {
            return null;
        }
        const target = pointer[1].trim();
        return path.isAbsolute(target) ? target : path.resolve(repoDir, target);
    } catch {
        return null;
    }
}

/**
 * Create the owner-only rule file that `--replace-text` reads.
 *
 * It lives inside the repository's git directory, never $TMPDIR. Sandboxed
 * git-filter-repo builds - the snap ships strict confinement - get a private
 * /tmp namespace and cannot open a path under the host's, which surfaced as
 * `FileNotFoundError: /tmp/leak-lock-XXXXXX/replacements.txt` the moment
 * "Run Git-only cleanup" was pressed. The git directory is by definition
 * reachable by the tool rewriting that repository, and it is not part of the
 * working tree, so the values can never be staged or committed by accident.
 *
 * The caller removes it with removeRulesFile() *after* the rewrite finished.
 * On failure the file is deliberately kept so the run can be retried without
 * re-deriving every rule.
 *
 * Everything lands under `<git dir>/leak-lock/`, the same directory the generated
 * scripts use, so the path quoted in an error and the path documented in the user
 * guide are one place, not two.
 *
 * @returns {{dir: string, file: string, parent: string, insideGitDir: boolean}}
 */
const RULES_DIR_NAME = 'leak-lock';

function createRulesFile(repoDir, contents, options = {}) {
    const prefix = options.prefix || 'run-';
    const fileName = options.fileName || 'replacements.txt';
    const gitDir = resolveGitDir(repoDir);
    const parent = gitDir ? path.join(gitDir, RULES_DIR_NAME) : os.tmpdir();
    if (gitDir) {
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    }
    const dir = fs.mkdtempSync(path.join(parent, prefix));
    for (const target of gitDir ? [parent, dir] : [dir]) {
        try {
            fs.chmodSync(target, 0o700);
        } catch (permissionError) {
            if (process.platform !== 'win32') {
                throw permissionError;
            }
        }
    }
    const file = path.join(dir, fileName);
    fs.writeFileSync(file, contents, { mode: 0o600, flag: 'wx' });
    return { dir, file, parent: gitDir ? parent : null, insideGitDir: Boolean(gitDir) };
}

/** Remove a createRulesFile() handle. Never throws - cleanup is best effort. */
function removeRulesFile(handle) {
    if (!handle || !handle.dir) {
        return false;
    }
    try {
        fs.rmSync(handle.dir, { recursive: true, force: true });
        if (handle.parent) {
            // Only when this was the last run: another cleanup may have kept its
            // own rules after failing, and those are deliberately not ours to drop.
            try {
                fs.rmdirSync(handle.parent);
            } catch { /* not empty, or already gone */ }
        }
        return true;
    } catch (cleanupError) {
        console.warn('Failed to remove secure replacement directory:', cleanupError);
        return false;
    }
}

/**
 * A snap-packaged git-filter-repo runs under strict confinement: it sees a
 * private /tmp and only non-hidden paths under $HOME, so it cannot read a rule
 * file elsewhere - nor a repository outside $HOME at all. The Python traceback
 * it prints ("FileNotFoundError", "PermissionError") reads like a Leak Lock bug,
 * so translate it into the one action that fixes it.
 */
function describeSandboxedFilterRepo(output, rulesPath) {
    if (!/\/snap\/[^\s]*git-filter-repo/.test(output || '')) {
        return null;
    }
    if (!/(FileNotFoundError|PermissionError)/.test(output)) {
        return null;
    }
    return [
        'git-filter-repo is installed as a snap, and snaps are confined: this one cannot read',
        rulesPath ? `the replacement rule file (${rulesPath})` : 'the replacement rule file',
        'or any repository outside your home directory.',
        'Install the unconfined tool instead: "python3 -m pip install --user git-filter-repo"',
        '(optionally "sudo snap remove git-filter-repo" first), then restart VS Code so its',
        'PATH picks up the new binary.'
    ].join(' ');
}

/**
 * Resolve the Python user scripts directory on Windows.
 *
 * `pip install --user` places executables in the per-user Scripts directory
 * (e.g. %APPDATA%\Python\Python312\Scripts), which is NOT added to PATH by the
 * Python installer by default.  Asking sysconfig for the path is the only
 * reliable way to find it without guessing a version number.
 *
 * Tries the same Python interpreters that the install command may have used, in
 * the same priority order, so what we find matches what pip wrote.
 *
 * @returns {Promise<string|null>} Absolute path to the Scripts directory, or null.
 */
async function findWindowsUserScriptsDir() {
    const script = "import sysconfig; print(sysconfig.get_path('scripts', 'nt_user'))";
    for (const cmd of ['python', 'py', 'python3']) {
        try {
            const { stdout } = await execFileAsync(cmd, ['-c', script],
                { maxBuffer: MAX_BUFFER, timeout: 10000 });
            const dir = String(stdout).trim();
            if (dir) {
                return dir;
            }
        } catch { /* try next interpreter */ }
    }
    return null;
}

/**
 * Which form of git-filter-repo this machine has, if any.
 *
 * Two installations are both valid and neither implies the other: pip drops a
 * `git-filter-repo` launcher on PATH, while a distribution package usually puts
 * it in git's exec-path so `git filter-repo` resolves. Probing both is the only
 * way to answer "can a Git-only cleanup run here", which is what the setup panel
 * needs to state before the user selects anything.
 *
 * On Windows, pip's `--user` install lands in a per-version Scripts directory
 * (%APPDATA%\Python\PythonXY\Scripts) that is not on PATH by default. When
 * neither standard probe succeeds, the user Scripts directory is searched as a
 * last resort so the tool is reported as available rather than missing.
 *
 * @returns {Promise<{installed: boolean, form: string|null, version: string|null,
 *                    path: string|null, confined: boolean, error: string|null}>}
 */
async function detectFilterRepo() {
    const readVersion = async (command, args) => {
        const { stdout, stderr } = await execFileAsync(command, args, { maxBuffer: MAX_BUFFER });
        return String(stdout || stderr || '').trim().split('\n')[0] || null;
    };

    let subcommandError = null;
    try {
        const version = await readVersion('git', ['filter-repo', '--version']);
        return { installed: true, form: 'git subcommand', version, path: null, confined: false, error: null };
    } catch (error) {
        subcommandError = failureText(error);
    }

    try {
        const version = await readVersion('git-filter-repo', ['--version']);
        let resolved = null;
        try {
            const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where' : 'which',
                ['git-filter-repo'], { maxBuffer: MAX_BUFFER });
            resolved = String(stdout).trim().split('\n')[0] || null;
        } catch { /* the launcher answered --version; its path is a nicety */ }
        return {
            installed: true,
            form: 'PATH launcher',
            version,
            path: resolved,
            // A snap build runs confined: it cannot read a repository outside $HOME,
            // so "installed" alone would overstate what it can do here.
            confined: Boolean(resolved && resolved.startsWith('/snap/')),
            error: null
        };
    } catch (launcherError) {
        const output = failureText(launcherError);

        // On Windows, pip --user installs to a Scripts directory that is often not
        // on PATH. Try to find the launcher there before reporting it as missing.
        if (process.platform === 'win32' && /ENOENT|not found/i.test(output)) {
            try {
                const scriptsDir = await findWindowsUserScriptsDir();
                if (scriptsDir) {
                    const launcherPath = path.join(scriptsDir, 'git-filter-repo.exe');
                    if (fs.existsSync(launcherPath)) {
                        const version = await readVersion(launcherPath, ['--version']);
                        return {
                            installed: true,
                            form: 'pip --user launcher',
                            version,
                            path: launcherPath,
                            confined: false,
                            error: null
                        };
                    }
                }
            } catch { /* probe failed, fall through to the not-installed report */ }
        }

        return {
            installed: false,
            form: null,
            version: null,
            path: null,
            confined: false,
            error: /ENOENT|not found/i.test(output)
                ? 'git-filter-repo is not installed or is not on PATH'
                : (output.split('\n')[0] || subcommandError || 'git-filter-repo could not be run')
        };
    }
}

/**
 * The command that installs git-filter-repo, as argv rather than a shell string.
 *
 * `--user` keeps it out of a system prefix, so no elevation is needed and a
 * managed Python (Debian's PEP 668 marker) does not refuse the install.
 */
function buildFilterRepoInstallCommand(python = null) {
    const interpreter = python || (process.platform === 'win32' ? 'python' : 'python3');
    return { command: interpreter, args: ['-m', 'pip', 'install', '--user', '--upgrade', 'git-filter-repo'] };
}

/**
 * Everything git-filter-repo said, as text.
 *
 * `stderr` is a string under execFile's default encoding, but a caller passing
 * `encoding: 'buffer'` makes it a Buffer, and both matchers below decide whether
 * the user sees an actionable message or a raw Python traceback. Normalise once
 * rather than depending on where implicit stringification happens to apply.
 */
function failureText(error) {
    if (!error) {
        return '';
    }
    return [error.message, error.stderr]
        .filter(Boolean)
        .map(part => (typeof part === 'string' ? part : String(part)))
        .join('\n');
}

/**
 * Run git-filter-repo regardless of how pip installed it. Git discovers
 * subcommands from its exec-path, while pip commonly installs the standalone
 * `git-filter-repo` launcher on PATH. The latter is fully supported by the
 * upstream tool but `git filter-repo` cannot always see it.
 */
async function runGitFilterRepo(repoDir, args, options = {}) {
    // indexOf returns -1 when the flag is absent, and args[0] is not the rule file,
    // so the lookup is guarded rather than offset-adjusted.
    const replaceTextAt = args.indexOf('--replace-text');
    const rulesPath = replaceTextAt >= 0 ? (args[replaceTextAt + 1] || null) : null;
    const withSandboxHint = (error) => {
        const hint = describeSandboxedFilterRepo(failureText(error), rulesPath);
        if (!hint) {
            return error;
        }
        const wrapped = new Error(hint);
        wrapped.cause = error;
        wrapped.stderr = error.stderr;
        return wrapped;
    };

    try {
        return await git(repoDir, ['filter-repo', ...args], options);
    } catch (gitError) {
        if (!/['"]filter-repo['"] is not a git command|git: filter-repo:.*not a git command/i.test(failureText(gitError))) {
            throw withSandboxHint(gitError);
        }

        try {
            return await execFileAsync('git-filter-repo', args, {
                cwd: repoDir,
                maxBuffer: MAX_BUFFER,
                ...options
            });
        } catch (launcherError) {
            if (launcherError.code !== 'ENOENT') {
                throw withSandboxHint(launcherError);
            }

            // On Windows, pip --user installs git-filter-repo.exe into a Scripts
            // directory that is typically not on PATH. Try to find and invoke it
            // directly before giving up, so the rewrite works without the user
            // having to modify their environment.
            if (process.platform === 'win32') {
                try {
                    const scriptsDir = await findWindowsUserScriptsDir();
                    if (scriptsDir) {
                        const launcherPath = path.join(scriptsDir, 'git-filter-repo.exe');
                        if (fs.existsSync(launcherPath)) {
                            return await execFileAsync(launcherPath, args, {
                                cwd: repoDir,
                                maxBuffer: MAX_BUFFER,
                                ...options
                            });
                        }
                    }
                } catch (userPathError) {
                    if (userPathError.code !== 'ENOENT') {
                        throw withSandboxHint(userPathError);
                    }
                }
            }

            // Named for the platform this is actually running on: Windows has no
            // python3 shim by default, so quoting one turns a missing dependency
            // into a second dead end.
            const installHint = process.platform === 'win32'
                ? 'py -3 -m pip install --user git-filter-repo'
                : 'python3 -m pip install --user git-filter-repo';
            throw new Error(
                `git-filter-repo is not installed or is not on PATH. Install it with "${installHint}", ` +
                'then restart VS Code so its environment picks up the installation.'
            );
        }
    }
}

async function gitLines(repoDir, args, options = {}) {
    const { stdout } = await git(repoDir, args, options);
    // Strip only a trailing CR (Windows line endings), never trim: file paths
    // from `git ls-tree` can legitimately contain leading/trailing spaces, and
    // trimming them would corrupt the "verified clean" path check. Ref names
    // carry no whitespace, so this is a no-op for them.
    return stdout.split('\n').map(line => line.replace(/\r$/, '')).filter(Boolean);
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

/**
 * Refresh every ref. Unlike a best-effort fetch, failures reject.
 *
 * `prune` deletes local remote-tracking refs that no longer exist on the remote. That
 * is wanted immediately before a rewrite, so the plan matches the server. It is not
 * wanted during a read-only planning check, where deleting refs is a side effect the
 * user did not ask for — pass `{ prune: false }` there.
 *
 * @param {object} [options]
 * @param {boolean} [options.prune=true]
 * @returns {Promise<{args: string[], command: string}>} the exact command that ran,
 *   so callers can name it in an error rather than describing it vaguely.
 */
async function fetchAllRefs(repoDir, remote = DEFAULT_REMOTE, options = {}) {
    const prune = options.prune !== false;
    const args = prune
        ? ['fetch', '--prune', '--tags', remote]
        : ['fetch', '--tags', remote];
    await git(repoDir, args);
    return { args, command: `git ${args.join(' ')}` };
}

/** The command fetchAllRefs would run, without running it. */
function describeFetchCommand(remote = DEFAULT_REMOTE, options = {}) {
    const prune = options.prune !== false;
    return prune
        ? `git fetch --prune --tags ${remote}`
        : `git fetch --tags ${remote}`;
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

/**
 * Delete the backup and alias refs a rewrite leaves behind.
 *
 * `refs/original/*` is filter-branch's backup: it keeps the pre-rewrite commits
 * reachable, so the secret survives a rewrite that otherwise worked.
 *
 * `refs/replace/*` is worse, because it hides rather than keeps. git filter-repo
 * writes one per rewritten commit, and every git read honours them: ask for the
 * ORIGINAL commit and git hands back the REWRITTEN one. A repository whose remote
 * still holds the leak then reads as clean locally - `git show`, `git log -S`,
 * `git grep`, a re-scan, and the extension's own verification all agree that the
 * secret is gone while it is still on the server. The rewrite is meant to remove
 * the history, not to alias it, so both namespaces go.
 */
async function dropOriginalRefs(repoDir) {
    const { stdout } = await git(repoDir, [
        'for-each-ref',
        '--format=delete %(refname)',
        'refs/original/',
        'refs/replace/'
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
    // One atomic transaction over every branch AND tag. Two separate pushes
    // (--all then --tags) are each atomic on their own, but if the first
    // succeeds and the second is rejected (e.g. a protected tag), the remote is
    // left with rewritten branches but stale, still-leaking tags. A single push
    // with both wildcard refspecs is genuinely all-or-nothing.
    await git(repoDir, [
        'push', '--force', '--atomic', remote,
        'refs/heads/*:refs/heads/*',
        'refs/tags/*:refs/tags/*'
    ]);
}

/**
 * Was this push refused because a ref is protected on the server?
 *
 * This is the single most likely way a real cleanup fails, and the raw git output is
 * actively misleading about it: `--atomic` means one protected ref rejects *every*
 * ref, so the user sees eight or nine "[remote rejected]" lines and reasonably
 * concludes the whole rewrite is broken. Only one line is the actual cause; the rest
 * say "atomic transaction failed", which is git reporting the transaction it rolled
 * back, not nine separate problems.
 *
 * Separating cause from collateral is the whole point: the fix is a one-line change to
 * one branch's protection rule, and nothing about the raw output suggests that.
 *
 * @returns {null|{protectedRefs: string[], collateralRefs: string[], provider: string|null}}
 */
function parseProtectedRefRejection(error) {
    const raw = [
        error && error.message ? error.message : '',
        error && error.stderr ? error.stderr : ''
    ].filter(Boolean).join('\n');

    // GH006 is GitHub's code; the hook wordings cover GitHub rulesets, GitLab,
    // Bitbucket and self-hosted setups that enforce protection in a pre-receive hook.
    const looksProtected =
        /GH006|protected branch|Cannot force-push|force push|pre-receive hook declined|protected branch hook declined/i
            .test(raw);
    if (!looksProtected) {
        return null;
    }

    const protectedRefs = [];
    const collateralRefs = [];
    // ! [remote rejected] <src> -> <dst> (<reason>)
    const rejectionLine = /^\s*!\s*\[remote rejected\]\s+(\S+)\s+->\s+(\S+)\s+\((.+)\)\s*$/;
    for (const line of raw.split('\n')) {
        const match = line.match(rejectionLine);
        if (!match) {
            continue;
        }
        const [, , dst, reason] = match;
        // "atomic transaction failed" means this ref was fine — it was rolled back
        // because a different ref was refused. Listing it as a problem sends the user
        // looking for protection rules that do not exist.
        if (/atomic transaction failed/i.test(reason)) {
            collateralRefs.push(dst);
        } else {
            protectedRefs.push(dst);
        }
    }

    // GitHub names the offending ref explicitly. When it does, that is authoritative:
    // a server-side hook can reject every ref with identical generic wording, which
    // would otherwise make all of them look like separate protected branches and send
    // the user hunting for rules that do not exist.
    const named = [];
    for (const m of raw.matchAll(/Protected branch update failed for refs\/heads\/(\S+?)\.?\s*$/gim)) {
        if (!named.includes(m[1])) {
            named.push(m[1]);
        }
    }
    if (named.length > 0) {
        const collateral = [...new Set([
            ...collateralRefs,
            ...protectedRefs.filter(r => !named.includes(r))
        ])];
        return { protectedRefs: named, collateralRefs: collateral, provider: detectRemoteProvider(raw) };
    }

    return {
        protectedRefs: protectedRefs.filter(r => !collateralRefs.includes(r)),
        collateralRefs,
        provider: detectRemoteProvider(raw)
    };
}

/** Best-effort host identification, so the remediation steps can name the real UI. */
function detectRemoteProvider(text) {
    if (/GH006|github\.com/i.test(text)) {
        return 'github';
    }
    if (/gitlab/i.test(text)) {
        return 'gitlab';
    }
    if (/bitbucket/i.test(text)) {
        return 'bitbucket';
    }
    return null;
}

/**
 * Re-fetch and confirm the leak is gone from every remote ref, not just the
 * one that happened to be checked out.
 * @param {object} criteria { pathPattern?: RegExp source string, literals?: string[], patterns?: string[] }
 * @returns {Promise<Array<{ref: string, reason: string, match: string, notVerified?: boolean}>>}
 *          offending refs; a single `notVerified` entry when nothing could be checked
 */
async function verifyRemoteRefs(repoDir, remote = DEFAULT_REMOTE, criteria = {}) {
    const pathRegex = criteria.pathPattern ? new RegExp(criteria.pathPattern) : null;
    const literals = Array.isArray(criteria.literals) ? criteria.literals : [];
    // Regex redaction rules cannot be verified with --fixed-strings: the rewrite would
    // succeed and verification would then report clean for the wrong reason, because
    // the literal pattern text was never in the history to begin with.
    const patterns = Array.isArray(criteria.patterns) ? criteria.patterns : [];

    const searches = [
        ...literals.map(value => ({ value, args: ['--fixed-strings'] })),
        ...patterns.map(value => ({ value, args: ['--extended-regexp'] }))
    ];

    // An empty result means "clean" to every caller, and the panel turns that into
    // "verified clean on every remote ref" and then discards the findings. So a
    // verification that examined *nothing* must never return an empty array — that
    // is a false all-clear on the one screen where the user decides the leak is gone.
    // `_confirmScanPush` passes `pending.verify || {}`, so empty criteria is reachable.
    if (!pathRegex && searches.length === 0) {
        return [notVerified(remote, 'no search criteria were supplied, so nothing was checked')];
    }

    await fetchAllRefs(repoDir, remote);
    // Every read below is a raw one: a leftover `refs/replace/*` from the rewrite
    // makes plain git answer with the rewritten commit for a ref that still holds
    // the original, and this loop would report the leak as cleaned.
    const refs = await gitLines(repoDir, [
        'for-each-ref',
        '--format=%(refname)',
        `refs/remotes/${remote}`,
        'refs/tags'
    ], { env: RAW_OBJECT_ENV });
    const offenders = [];
    let examined = 0;

    for (const ref of refs) {
        if (ref.endsWith('/HEAD')) {
            continue;
        }
        examined++;
        if (pathRegex) {
            const files = await gitLines(repoDir, ['ls-tree', '-r', '--name-only', ref], { env: RAW_OBJECT_ENV });
            const hit = files.find(file => pathRegex.test(file));
            if (hit) {
                offenders.push({ ref, reason: 'path still present', match: hit });
                continue;
            }
        }
        for (const search of searches) {
            try {
                await gitRaw(repoDir, ['grep', '--quiet', ...search.args, '-e', search.value, ref]);
                offenders.push({ ref, reason: 'secret still present', match: search.value });
                break;
            } catch (e) {
                // git grep exits 1 for "not found" (the clean case). Any other
                // exit (e.g. 128 for a bad ref/object) is a real failure - never
                // treat it as clean, or verification silently lies. Surface it.
                if (!e || e.code !== 1) {
                    offenders.push({
                        ref,
                        reason: `verification failed (git grep exit ${e && e.code !== undefined ? e.code : 'unknown'})`,
                        match: search.value
                    });
                    break;
                }
                // exit 1: value not present in this ref - keep checking.
            }
        }
    }

    // Zero refs examined is not a clean bill of health either — it means the fetch
    // produced nothing under refs/remotes/<remote>, so no ref was ever looked at.
    if (examined === 0) {
        return [notVerified(remote, `no refs were found under refs/remotes/${remote}, so no ref was checked`)];
    }

    return offenders;
}

/**
 * Which of many strings occur at the tip of any ref - in ONE command.
 *
 * The pickaxe (`git log --all -S<value>`) walks the entire history per value, so
 * checking twenty rules in nine encodings is a few hundred full walks and minutes
 * of waiting. `git grep` takes many patterns at once and searches each ref's tree
 * once, and `-o` makes it report which pattern matched - so a single invocation
 * answers "which of these strings exist" for every rule and every encoding.
 *
 * It sees only what each ref currently contains, which is why it is a fast path
 * rather than the answer: content that exists solely in an older commit needs the
 * pickaxe. Callers use this first and fall back for whatever it does not find.
 *
 * @param {string} repoDir
 * @param {string[]} needles
 * @returns {Promise<Set<string>>} the needles that occur somewhere
 */
async function findStringsInRefs(repoDir, needles) {
    const wanted = [...new Set((needles || []).filter(needle => typeof needle === 'string' && needle))];
    if (wanted.length === 0) {
        return new Set();
    }
    let refs = [];
    try {
        refs = await gitLines(repoDir, ['for-each-ref', '--format=%(refname)'], { env: RAW_OBJECT_ENV });
    } catch {
        return new Set();
    }
    if (refs.length === 0) {
        return new Set();
    }
    const args = ['grep', '--no-color', '-I', '-F', '-o', '-h'];
    for (const needle of wanted) {
        args.push('-e', needle);
    }
    args.push(...refs);
    try {
        const { stdout } = await gitRaw(repoDir, args, { timeout: 120000 });
        const found = new Set();
        for (const line of String(stdout).split('\n')) {
            // `-o -h` prints "<ref>:<path>:<match>" per hit; the match is what follows
            // the last colon that precedes a known needle, so compare directly.
            for (const needle of wanted) {
                if (line.endsWith(needle)) {
                    found.add(needle);
                }
            }
        }
        return found;
    } catch (error) {
        // Exit 1 is "no matches", which is an answer, not a failure.
        if (error && error.code === 1) {
            return new Set();
        }
        return new Set();
    }
}

/**
 * Which of many strings occur anywhere in the object store - in ONE pass.
 *
 * The pickaxe answers this per string by walking the whole history, so N strings
 * cost N walks. `git cat-file --batch-all-objects --batch` streams every object
 * once instead, and every needle is checked against that one stream: the cost is
 * a single read of the repository regardless of how many values are being looked
 * for. Commit messages are objects too, so a secret quoted in one is covered by
 * the same pass.
 *
 * Chunks are joined by an overlap of the longest needle minus one byte, so a value
 * split across a read boundary is still found. Search stops as soon as every needle
 * is accounted for, and a time budget bounds a pathological repository - `complete`
 * says which of the two happened, so a caller never reports a partial search as a
 * clean one.
 *
 * @returns {Promise<{found: Set<string>, complete: boolean}>}
 */
function findStringsInObjects(repoDir, needles, options = {}) {
    const wanted = [...new Set((needles || []).filter(needle => typeof needle === 'string' && needle))];
    if (wanted.length === 0) {
        return Promise.resolve({ found: new Set(), complete: true });
    }
    const timeoutMs = options.timeoutMs || 120000;
    const overlap = Math.max(...wanted.map(needle => needle.length)) - 1;

    return new Promise((resolve) => {
        const found = new Set();
        let complete = true;
        let carry = '';
        let settled = false;

        const child = spawn('git', ['cat-file', '--batch-all-objects', '--batch', '--buffer'], {
            cwd: repoDir,
            env: RAW_OBJECT_ENV,
            stdio: ['ignore', 'pipe', 'ignore']
        });

        const finish = (wasComplete) => {
            if (settled) {
                return;
            }
            settled = true;
            complete = wasComplete;
            clearTimeout(timer);
            try {
                child.kill();
            } catch { /* already gone */ }
            resolve({ found, complete });
        };

        const timer = setTimeout(() => finish(false), timeoutMs);

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            const haystack = carry + chunk;
            for (const needle of wanted) {
                if (!found.has(needle) && haystack.includes(needle)) {
                    found.add(needle);
                }
            }
            if (found.size === wanted.length) {
                finish(true);
                return;
            }
            carry = overlap > 0 ? haystack.slice(-overlap) : '';
        });
        child.on('error', () => finish(false));
        child.on('close', () => finish(true));
    });
}

/**
 * Which rules did NOT take effect, after a rewrite that reported success.
 *
 * `git filter-repo --replace-text` exits 0 whether it replaced ten thousand
 * occurrences or none: a rule whose text does not match the bytes in history is
 * not an error to it. So the only way to know a value is actually gone is to look
 * for it afterwards, with replacement refs disabled, across every ref.
 *
 * @param {string} repoDir
 * @param {Array<{source: string, mode?: string}>} rules
 * @returns {Promise<Array<{source: string, mode: string, commit: string}>>}
 */
async function findUnremovedRules(repoDir, rules, options = {}) {
    // A rule that matches nothing walks the whole history before saying so, which is
    // the slow case and the one worth bounding. A timeout is reported as "could not
    // be checked" rather than as "clean" - the safe direction for both callers.
    const timeout = options.timeoutMs || 60000;
    const remaining = [];
    for (const rule of Array.isArray(rules) ? rules : []) {
        if (!rule || !rule.source) {
            continue;
        }
        const selector = rule.mode === 'regex' ? `-G${rule.source}` : `-S${rule.source}`;
        try {
            const { stdout } = await gitRaw(repoDir, [
                'log', '--all', '--oneline', '--max-count=1', selector
            ], { timeout });
            const hit = String(stdout).trim().split('\n')[0];
            if (hit) {
                remaining.push({ source: rule.source, mode: rule.mode || 'literal', commit: hit, surface: 'content' });
                continue;
            }
            // A secret can be in a commit message rather than in a file, and the two
            // need different flags: --replace-text rewrites blobs, --replace-message
            // rewrites messages. Reporting "matches nothing" for a value that is
            // plainly in the history - because only blobs were searched - is how a
            // cleanup ends up doing nothing while the scan keeps finding it.
            const { stdout: messageHit } = await gitRaw(repoDir, [
                'log', '--all', '--oneline', '--max-count=1',
                rule.mode === 'regex' ? '--extended-regexp' : '--fixed-strings',
                '--grep', rule.source
            ], { timeout });
            const message = String(messageHit).trim().split('\n')[0];
            if (message) {
                remaining.push({ source: rule.source, mode: rule.mode || 'literal', commit: message, surface: 'message' });
            }
        } catch (error) {
            // A failed search is not a clean result. Report it as unremoved with the
            // reason attached, so it cannot be mistaken for "this rule worked".
            remaining.push({
                source: rule.source,
                mode: rule.mode || 'literal',
                commit: `could not be checked: ${failureText(error).split('\n')[0]}`
            });
        }
    }
    return remaining;
}

/**
 * The marker returned when verification could not examine anything.
 *
 * It rides the offenders channel deliberately: every caller already treats a non-empty
 * result as "do not tell the user this is clean", so an unverifiable outcome inherits
 * that safety automatically rather than depending on each call site to remember it.
 * `notVerified` lets callers word the message accurately — "could not verify" is not
 * the same claim as "the secret is still there".
 */
function notVerified(remote, reason) {
    return {
        ref: `refs/remotes/${remote}/*`,
        reason: `not verified: ${reason}`,
        match: '',
        notVerified: true
    };
}

/**
 * Which of `candidates` actually exists at `commitHash`.
 *
 * A finding's path can have more than one plausible repo-relative reading (see
 * repoRelativeCandidates); the repository itself is the only authority on which
 * is real, and `git cat-file -e` answers it exactly. Guessing instead produces a
 * link that 404s, which looks like Leak Lock pointing at the wrong commit.
 *
 * @returns {Promise<string|null>} the first candidate present in that commit,
 *   or null when none is — never a fallback guess.
 */
async function findPathInCommit(repoDir, commitHash, candidates = []) {
    for (const candidate of candidates) {
        try {
            await git(repoDir, ['cat-file', '-e', `${commitHash}:${candidate}`]);
            return candidate;
        } catch {
            // Not at that commit; try the next reading.
        }
    }
    return null;
}

/** Single-quote a string for PowerShell (no interpolation; embedded ' doubled). */
function psQuote(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Emit a PowerShell (.ps1) equivalent of buildRewriteScript() for Windows hosts.
 * Accepts the same conceptual options but uses `replacementsContent` instead of
 * `replacementsContent` for the rule-file setup instead of
 * `preambleLines`/`finalCleanupCommand`.
 *
 * @param {object} options
 * @param {string} options.repoDir
 * @param {string} [options.remote]
 * @param {string[]} options.rewriteLines PowerShell lines for the actual rewrite step
 * @param {string} [options.verifyRegex] .NET regex pattern for the verification loop
 * @param {string[]} [options.verifyLiterals] fixed strings to git-grep for in each ref
 * @param {string[]} [options.verifyPatterns] regex patterns to git-grep for in each ref
 * @param {string} [options.verifyRulesFile] PS expression for the replacement rules file
 *   (e.g. '$replacement_file')
 * @param {string[]} [options.requiredCommands] commands checked before any destructive work
 * @param {boolean} [options.restoreRemote] re-add the remote after filter-repo removes it
 * @param {string} [options.remoteUrl]
 * @param {string|null} [options.replacementsContent] raw text to write into a
 *   owner-only temp file ($replacement_file) before the rewrite runs
 */
function buildRewriteScriptPs1(options) {
    const {
        repoDir,
        remote = DEFAULT_REMOTE,
        rewriteLines = [],
        verifyRegex = null,
        verifyLiterals = [],
        verifyPatterns = [],
        verifyRulesFile = null,
        requiredCommands = [],
        restoreRemote = false,
        remoteUrl = null,
        replacementsContent = null,
    } = options || {};

    const remoteQ = psQuote(remote);
    const hasReplacements = replacementsContent !== null;
    const regularCmds = requiredCommands.filter(c => c !== 'git-filter-repo');
    const needsFilterRepo = requiredCommands.includes('git-filter-repo');

    const lines = [
        '# Generated by Leak Lock - rewrites git history across ALL refs.',
        '# Review before running. This is destructive and cannot be undone.',
        '#',
        '# Run from PowerShell or Windows Terminal:',
        '#   Set-ExecutionPolicy Bypass -Scope Process; .\\cleanup.ps1',
        '# or:',
        '#   powershell -ExecutionPolicy Bypass -File .\\cleanup.ps1',
        '#',
        '# Running the cleanup in WSL or Git Bash instead? Leak Lock generates the same',
        '# cleanup as a bash .sh - save that one and run it there.',
        ...(requiredCommands.includes('git-filter-repo') ? [
            '#',
            '# Requires git filter-repo (Python). Install if needed:',
            '#   py -3 -m pip install --user git-filter-repo',
            '# (or "python -m pip ..." - Windows has no python3 shim by default)',
        ] : []),
        '',
        '$ErrorActionPreference = \'Stop\'',
        '$env:LC_ALL = \'C\'',
        '',
    ];

    // `pip install git-filter-repo` commonly creates git-filter-repo on PATH rather
    // than placing it in Git's exec-path. Support both upstream installation forms.

    if (regularCmds.length > 0) {
        lines.push(
            '# Fail immediately with a clear message rather than midway through a rewrite.',
            `foreach ($cmd in @(${regularCmds.map(psQuote).join(', ')})) {`,
            '    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {',
            '        Write-Error "Required command not found on PATH: $cmd"',
            '        exit 1',
            '    }',
            '}',
            ''
        );
    }

    if (needsFilterRepo) {
        lines.push(
            '# Prefer Git\'s subcommand, then fall back to pip\'s PATH launcher.',
            '& git filter-repo --version *>$null',
            'if ($LASTEXITCODE -eq 0) {',
            '    function Invoke-GitFilterRepo { & git filter-repo @args }',
            '} elseif (Get-Command git-filter-repo -ErrorAction SilentlyContinue) {',
            '    function Invoke-GitFilterRepo { & git-filter-repo @args }',
            '} else {',
            '    Write-Host "git filter-repo is not installed." -ForegroundColor Red',
            '    Write-Host ""',
            '    Write-Host "Install it with pip (requires Python 3):"',
            '    Write-Host "    py -3 -m pip install --user git-filter-repo"',
            '    Write-Host "    (or: python -m pip install --user git-filter-repo)"',
            '    Write-Host ""',
            '    Write-Host "Or download the script and place it in git\'s exec-path:"',
            '    Write-Host "    https://github.com/newren/git-filter-repo"',
            "    Write-Host \"    Place git-filter-repo in: $(& git --exec-path)\"",
            '    exit 1',
            '}',
            ''
        );
    }

    // Declared before `try` so the `finally` block can always read them.
    if (hasReplacements) {
        lines.push('$replacement_file = \'\'', '');
    }
    lines.push('$current_branch = \'\'', '', 'try {');

    lines.push(`    Set-Location ${psQuote(repoDir)}`, '');

    if (hasReplacements) {
        lines.push(
            '    # The rule file lives in the repository\'s git directory, not $env:TEMP:',
            '    # sandboxed git-filter-repo builds cannot read a host temp path, and the',
            '    # git directory is never part of the working tree, so it cannot be committed.',
            '    $git_dir = (& git rev-parse --absolute-git-dir)',
            '    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
            '    $replacement_dir = Join-Path $git_dir \'leak-lock\'',
            '    $null = New-Item -ItemType Directory -Force -Path $replacement_dir',
            '    $replacement_file = Join-Path $replacement_dir "replacements-$([System.IO.Path]::GetRandomFileName()).txt"',
            '    $null = New-Item -ItemType File -Force -Path $replacement_file',
            '',
            '    # Restrict the rule file to the current user only (equivalent to chmod 600).',
            '    $acl = Get-Acl $replacement_file',
            '    $acl.SetAccessRuleProtection($true, $false)',
            '    foreach ($rule in @($acl.Access)) { $null = $acl.RemoveAccessRule($rule) }',
            '    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(',
            '        [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,',
            '        \'FullControl\', \'Allow\'))',
            '    Set-Acl $replacement_file $acl',
            `    [System.IO.File]::WriteAllText($replacement_file, ${psQuote(replacementsContent)}, [System.Text.Encoding]::UTF8)`,
            ''
        );
    }

    lines.push(
        '    # 1. Refresh every ref before planning the rewrite.',
        `    & git fetch --prune --tags ${remoteQ}`,
        '    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        '',
        '    # 2. Abort if any local branch holds commits the remote lacks - step 4',
        '    #    force-resets local branches and would discard them.',
        '    $unpushed = [System.Collections.Generic.List[string]]::new()',
        `    foreach ($branch in @(& git for-each-ref --format='%(refname:strip=2)' refs/heads)) {`,
        `        $null = & git rev-parse --verify --quiet "refs/remotes/${remote}/$($branch)" 2>$null`,
        '        if ($LASTEXITCODE -eq 0) {',
        `            $count = [int](& git rev-list --count "${remote}/$($branch)..$($branch)")`,
        '            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        '            if ($count -gt 0) { $unpushed.Add("  $branch (+$count commit(s))") }',
        '        }',
        '    }',
        '    if ($unpushed.Count -gt 0) {',
        '        Write-Error ("Refusing to rewrite - these local branches have unpushed commits:`n" + ($unpushed -join "`n") + "`nPush them first, then re-run.")',
        '        exit 1',
        '    }',
        '',
        '    # 3. Detach HEAD: git refuses to force-update the checked-out branch.',
        '    $sym = & git symbolic-ref --quiet --short HEAD 2>$null',
        '    if ($LASTEXITCODE -eq 0 -and $sym) { $current_branch = $sym }',
        '    if ($current_branch) {',
        '        & git checkout --detach --quiet',
        '        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        '    }',
        '',
        '    # 4. Materialise a local branch for every remote branch. Without this,',
        '    #    remote-only branches survive the push with old history intact.',
        `    foreach ($branch in @(& git for-each-ref --format='%(refname:strip=3)' "refs/remotes/${remote}")) {`,
        '        if ($branch -eq \'HEAD\') { continue }',
        `        & git branch --force --no-track $branch "refs/remotes/${remote}/$($branch)"`,
        '        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        '    }',
        '',
        '    # 5. Rewrite across ALL refs.'
    );

    lines.push(...rewriteLines.map(l => '    ' + l));

    lines.push(
        '',
        '    # 6. Drop the rewrite backup refs and repack.',
        '    #    refs/original/* keeps the pre-rewrite commits reachable, and',
        '    #    refs/replace/* (written by git filter-repo) makes git answer for the',
        '    #    OLD commit with the REWRITTEN one - a ref that still carries the',
        '    #    secret would then read as clean, here and in any later scan.',
        '    & git for-each-ref --format="delete %(refname)" refs/original/ refs/replace/ | & git update-ref --stdin',
        '    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        '    & git reflog expire --expire=now --all',
        '    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        '    & git gc --prune=now --aggressive',
        '    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'
    );

    if (restoreRemote && remoteUrl) {
        lines.push(
            '',
            '    # git filter-repo removes the remote by design - put it back.',
            `    $null = & git remote get-url ${remoteQ} 2>$null`,
            `    if ($LASTEXITCODE -ne 0) { & git remote add ${remoteQ} ${psQuote(remoteUrl)}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }`
        );
    }

    lines.push(
        '',
        '    # 7. --atomic over branches AND tags in ONE push: the server rejects the',
        '    #    whole push if any single ref fails, so the remote is never left with',
        '    #    rewritten branches but stale tags.',
        `    $push_out = & git push --force --atomic ${remoteQ} 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*' 2>&1`,
        '    $push_rc = $LASTEXITCODE',
        '    $push_out | ForEach-Object { Write-Host "$_" }',
        '    if ($push_rc -ne 0) {',
        '        $push_text = ($push_out | ForEach-Object { "$_" }) -join "`n"',
        '        if ($push_text -match \'GH006|[Pp]rotected branch|Cannot force-push|pre-receive hook declined\') {',
        '            Write-Host ""',
        '            Write-Host "=============================================================="',
        '            Write-Host "The remote refused the push because a branch is PROTECTED."',
        '            Write-Host ""',
        '            Write-Host "NOTHING WAS PUSHED. The remote is unchanged, which also means"',
        '            Write-Host "the secret is STILL on it. Local history is already rewritten;"',
        '            Write-Host "only the push is left."',
        '            Write-Host ""',
        '            Write-Host "Refs listed as (atomic transaction failed) are NOT separate"',
        '            Write-Host "problems - the push is all-or-nothing, so one protected branch"',
        '            Write-Host "rolls back every ref. Fix that one and they all go through."',
        '            Write-Host ""',
        '            Write-Host "To finish: allow force-pushes on the protected branch"',
        '            Write-Host "(GitHub: Settings > Branches, or Rules > Rulesets), re-run this"',
        '            Write-Host "script, then turn the protection back on immediately."',
        '            Write-Host "=============================================================="',
        '        }',
        '        exit $push_rc',
        '    }',
        '',
        '    # 8. Restore the branch that was checked out before the rewrite.',
        '    if ($current_branch) {',
        '        & git checkout --quiet $current_branch',
        '        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        '        $current_branch = \'\'',
        '    }'
    );

    if (verifyRegex || verifyLiterals.length > 0 || verifyPatterns.length > 0 || verifyRulesFile) {
        lines.push(
            '',
            '    # 9. Verify the remote is actually clean on EVERY ref.',
            `    & git fetch --prune --tags ${remoteQ}`,
            '    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
            '    $leftover = 0',
            '    $checked = 0',
            `    foreach ($ref in @(& git for-each-ref --format='%(refname)' "refs/remotes/${remote}" refs/tags)) {`,
            '        if ($ref -match \'/HEAD$\') { continue }',
            '        $checked++'
        );

        if (verifyRegex) {
            lines.push(
                '        $files = & git --no-replace-objects ls-tree -r --name-only $ref 2>$null',
                '        $ls_rc = $LASTEXITCODE',
                '        if ($ls_rc -ne 0) {',
                '            Write-Host "VERIFY FAILED (git ls-tree exit $ls_rc): $ref"',
                '            $leftover = 1',
                `        } elseif ($files | Select-String -Pattern ${psQuote(verifyRegex)} -Quiet) {`,
                '            Write-Host "STILL PRESENT (path): $ref"',
                '            $leftover = 1',
                '        }'
            );
        }

        if (verifyRulesFile) {
            lines.push(
                `        foreach ($rule_line in @(Get-Content ${verifyRulesFile} | Where-Object { $_ })) {`,
                '            $grep_flag = \'--fixed-strings\'',
                '            $needle = $rule_line',
                '            if ($rule_line -match \'^regex:\') {',
                '                $grep_flag = \'--extended-regexp\'',
                '                $needle = $rule_line -replace \'^regex:\'',
                '            }',
                '            $needle = ($needle -split \'==>\')[0]',
                '            if (-not $needle) { continue }',
                '            & git --no-replace-objects grep --quiet $grep_flag -e $needle $ref 2>$null',
                '            $grep_rc = $LASTEXITCODE',
                '            if ($grep_rc -eq 0) {',
                '                Write-Host "STILL PRESENT (secret): $ref"',
                '                $leftover = 1',
                '                break',
                '            } elseif ($grep_rc -ne 1) {',
                '                Write-Host "VERIFY FAILED (git grep exit $grep_rc): $ref"',
                '                $leftover = 1',
                '                break',
                '            }',
                '        }'
            );
        }

        const verifySearches = [
            ...verifyLiterals.map(value => ({ value, flag: '--fixed-strings' })),
            ...verifyPatterns.map(value => ({ value, flag: '--extended-regexp' }))
        ];
        for (const search of verifySearches) {
            lines.push(
                `        & git --no-replace-objects grep --quiet ${search.flag} -e ${psQuote(search.value)} $ref 2>$null`,
                '        $grep_rc = $LASTEXITCODE',
                '        if ($grep_rc -eq 0) {',
                '            Write-Host "STILL PRESENT (secret): $ref"',
                '            $leftover = 1',
                '        } elseif ($grep_rc -ne 1) {',
                '            Write-Host "VERIFY FAILED (git grep exit $grep_rc): $ref"',
                '            $leftover = 1',
                '        }'
            );
        }

        lines.push(
            '    }',
            '    if ($checked -eq 0) {',
            `        Write-Host "NOT VERIFIED: no refs were found under refs/remotes/${remote}, so nothing was checked."`,
            '        Write-Host "This is NOT a clean result -- check the remote yourself."',
            '        exit 1',
            '    } elseif ($leftover -eq 0) {',
            '        Write-Host "Verified clean on every remote ref ($checked checked)."',
            '    } else {',
            '        Write-Error "Verification failed: see STILL PRESENT / VERIFY FAILED above."',
            '        exit 1',
            '    }'
        );
    }

    if (hasReplacements) {
        lines.push(
            '',
            '    # 10. Everything above succeeded - only now is the rule file no longer',
            '    #     needed. Any earlier exit keeps it; `finally` says where it is.',
            '    Remove-Item $replacement_file -Force -ErrorAction SilentlyContinue',
            '    if (-not (Get-ChildItem -Force $replacement_dir -ErrorAction SilentlyContinue)) {',
            '        Remove-Item $replacement_dir -Force -ErrorAction SilentlyContinue',
            '    }',
            '    $replacement_file = \'\''
        );
    }

    lines.push(
        '',
        '} finally {',
        '    if ($current_branch) {',
        '        & git checkout --quiet $current_branch 2>$null',
        '    }'
    );

    if (hasReplacements) {
        // Never delete it here: on a failed run this file is the only copy of what
        // still has to be redacted, so it is kept and reported instead.
        lines.push(
            '    if ($replacement_file -and (Test-Path $replacement_file)) {',
            '        Write-Warning "Replacement rules kept for a retry: $replacement_file"',
            '        Write-Warning "They contain the values you asked to redact - delete the file once you are done."',
            '    }'
        );
    }

    lines.push('}', '');

    return lines.join('\n');
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
 * @param {string[]} [options.verifyPatterns] regex sources to grep for in each ref.
 *   A regex redaction rule cannot be verified with --fixed-strings: the pattern text
 *   was never in the history, so a literal grep would report clean regardless of
 *   whether the rewrite worked.
 * @param {string} [options.verifyRulesFile] shell expression for the --replace-text rule
 *   file (e.g. '"$replacement_file"'). When given, verification re-reads that file
 *   instead of repeating every secret inline once per rule: one list, one place, and
 *   the sensitive values never appear in the script body.
 * @param {string[]} [options.requiredCommands] commands checked with `command -v`
 *   before anything destructive runs, so a missing tool fails immediately with a clear
 *   message instead of halfway through a rewrite.
 * @param {boolean} [options.restoreRemote] re-add the remote after the rewrite
 * @param {string} [options.remoteUrl]
 * @param {string[]} [options.preambleLines] setup lines run inside the repository,
 *   before the rewrite. They may call git: the script has already cd'd in.
 * @param {string} [options.finalCleanupCommand] cleanup run once the rewrite, the
 *   push and the verification have all succeeded - never from the EXIT trap, so a
 *   failed run keeps the rule file for a retry instead of destroying it
 * @param {string} [options.retainedPathExpr] shell expression naming a file the
 *   failure path should point the user at (e.g. '"$replacement_file"')
 */
function buildRewriteScript(options) {
    const {
        repoDir,
        remote = DEFAULT_REMOTE,
        rewriteLines = [],
        verifyRegex = null,
        verifyLiterals = [],
        verifyPatterns = [],
        verifyRulesFile = null,
        requiredCommands = [],
        restoreRemote = false,
        remoteUrl = null,
        preambleLines = [],
        finalCleanupCommand = null,
        retainedPathExpr = null
    } = options || {};

    const remoteQ = shellQuote(remote);
    const regularCmds = requiredCommands.filter(c => c !== 'git-filter-repo');
    const needsFilterRepo = requiredCommands.includes('git-filter-repo');
    const lines = [
        '#!/usr/bin/env bash',
        '# Generated by Leak Lock - rewrites git history across ALL refs.',
        '# Review before running. This is destructive and cannot be undone.',
        '#',
        '# Portability: bash 3.2+ (macOS ships 3.2, so no associative arrays, no',
        '# mapfile, no ${var,,}), and no GNU-only tool flags - BSD grep, sed, mktemp',
        '# and readlink behave differently, so nothing here depends on them.',
        '# On Windows run this from WSL or Git Bash; cmd.exe and PowerShell cannot run',
        '# it. Leak Lock also generates the same cleanup as a PowerShell .ps1 - use',
        '# whichever matches the shell you actually run.',
        '# /usr/bin/env locates bash on macOS Homebrew and Git Bash, where it is not',
        '# necessarily at /bin/bash.',
        'set -euo pipefail',
        // Byte-wise matching, so verification does not depend on the user's locale.
        'export LC_ALL=C',
        '',
        ...(regularCmds.length > 0
            ? [
                '# Fail immediately with a clear message rather than midway through a rewrite.',
                `for cmd in ${regularCmds.map(shellQuote).join(' ')}; do`,
                '\tif ! command -v "$cmd" >/dev/null 2>&1; then',
                '\t\techo "Required command not found on PATH: $cmd" >&2',
                '\t\texit 1',
                '\tfi',
                'done',
                ''
            ]
            : []),
        ...(needsFilterRepo
            ? [
                '# Prefer Git\'s subcommand, then fall back to pip\'s PATH launcher.',
                'git_filter_repo() {',
                '\tif git filter-repo --version >/dev/null 2>&1; then',
                '\t\tgit filter-repo "$@"',
                '\telif command -v git-filter-repo >/dev/null 2>&1; then',
                '\t\tgit-filter-repo "$@"',
                '\telse',
                '\t\techo "git-filter-repo is not installed or is not on PATH." >&2',
                '\t\techo "Install it with: python3 -m pip install --user git-filter-repo" >&2',
                '\t\texit 1',
                '\tfi',
                '}',
                '',
                '# Probe it now, not at step 5. The `command -v` loop above cannot check',
                '# this one - it is valid either as a git subcommand or as a PATH launcher -',
                '# so without this the script would detach HEAD and force-reset every local',
                '# branch to its remote before discovering the tool is missing.',
                'if ! git filter-repo --version >/dev/null 2>&1 \\',
                '\t&& ! command -v git-filter-repo >/dev/null 2>&1; then',
                '\techo "git-filter-repo is not installed or is not on PATH." >&2',
                '\techo "Install it with: python3 -m pip install --user git-filter-repo" >&2',
                '\texit 1',
                'fi',
                ''
            ]
            : []),
        `cd ${shellQuote(repoDir)}`,
        '',
        // The rule file is created here, inside the repository, rather than in
        // $TMPDIR: a snap-packaged git-filter-repo has a private /tmp and cannot
        // read a host temp path, which failed the rewrite before it started.
        ...preambleLines,
        ...(preambleLines.length > 0 ? [''] : []),
        '# 1. Refresh every ref before planning the rewrite.',
        `git fetch --prune --tags ${remoteQ}`,
        '',
        '# 2. Abort if any local branch holds commits the remote lacks - step 4',
        '#    force-resets local branches and would discard them.',
        'unpushed=""',
        '# Iterate one ref per line with read -r; process substitution (not a pipe)',
        '# keeps $unpushed in this shell rather than a subshell.',
        'while IFS= read -r branch; do',
        `\tif git rev-parse --verify --quiet "refs/remotes/${remote}/\${branch}" >/dev/null; then`,
        `\t\tcount="$(git rev-list --count "${remote}/\${branch}..\${branch}")"`,
        '\t\tif [ "$count" -gt 0 ]; then',
        '\t\t\tunpushed="${unpushed}\\n  ${branch} (+${count} commit(s))"',
        '\t\tfi',
        '\tfi',
        `done < <(git for-each-ref --format='%(refname:strip=2)' refs/heads)`,
        'if [ -n "$unpushed" ]; then',
        '\techo "Refusing to rewrite - these local branches have unpushed commits:" >&2',
        '\tprintf "%b\\n" "$unpushed" >&2',
        '\techo "Push them first, then re-run." >&2',
        '\texit 1',
        'fi',
        '',
        '# 3. Detach HEAD: git refuses to force-update the checked-out branch.',
        `current_branch="$(git symbolic-ref --quiet --short HEAD || true)"`,
        'push_log=""',
        '# One EXIT trap for the whole script. It restores the branch and removes the',
        '# push log, but it deliberately does NOT remove the replacement rule file: on a',
        '# failed run that file is the only copy of what still has to be redacted, so it',
        '# is kept and reported, and removed only after the rewrite is verified.',
        'cleanup_on_exit() {',
        '\trc=$?',
        '\tif [ -n "${push_log:-}" ]; then',
        '\t\trm -f "$push_log"',
        '\tfi',
        '\tif [ -n "${current_branch:-}" ]; then',
        '\t\tgit checkout --quiet "$current_branch" 2>/dev/null || true',
        '\tfi',
        ...(retainedPathExpr
            ? [
                `\tif [ "$rc" -ne 0 ] && [ -f ${retainedPathExpr} ]; then`,
                `\t\techo "Replacement rules kept for a retry: ${retainedPathExpr.replace(/^"|"$/g, '')}" >&2`,
                '\t\techo "They contain the values you asked to redact - delete the file once you are done." >&2',
                '\tfi'
            ]
            : []),
        '\treturn "$rc"',
        '}',
        'trap cleanup_on_exit EXIT',
        'if [ -n "$current_branch" ]; then',
        '\tgit checkout --detach --quiet',
        'fi',
        '',
        '# 4. Materialise a local branch for every remote branch. Without this,',
        '#    `git push --force --all` (refs/heads/* only) never touches',
        '#    remote-only branches and the old history survives on the server.',
        'while IFS= read -r branch; do',
        '\tif [ "$branch" = "HEAD" ]; then continue; fi',
        `\tgit branch --force --no-track "\${branch}" "refs/remotes/${remote}/\${branch}"`,
        `done < <(git for-each-ref --format='%(refname:strip=3)' refs/remotes/${remote})`,
        '',
        '# 5. Rewrite across ALL refs.'
    ];

    lines.push(...rewriteLines);

    lines.push(
        '',
        '# 6. Drop the rewrite backup refs and repack.',
        '#    refs/original/* keeps the pre-rewrite commits reachable. refs/replace/*',
        '#    is what git filter-repo writes to alias each old commit to its rewritten',
        '#    one: while those exist, git answers for the OLD commit with the NEW one,',
        '#    so a ref that still carries the secret reads as clean - here and in any',
        '#    later scan. A rewrite removes history; it must not alias it.',
        'git for-each-ref --format="delete %(refname)" refs/original/ refs/replace/ | git update-ref --stdin',
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
        '# 7. --atomic over branches AND tags in ONE push: the server rejects the',
        '#    WHOLE push if any single ref fails (a protected branch or tag), so',
        '#    the remote is never left with rewritten branches but stale tags.',
        '#    The flip side is that one protected branch rejects every ref, which',
        '#    reads as though the whole rewrite failed. Explain that if it happens.',
        // Assigned, never re-trapped: a second `trap ... EXIT` here used to replace
        // cleanup_on_exit outright, so the branch was never restored.
        'push_log="$(mktemp "${TMPDIR:-/tmp}/leaklock-push.XXXXXX")"',
        'push_rc=0',
        `git push --force --atomic ${remoteQ} ${shellQuote('refs/heads/*:refs/heads/*')} ${shellQuote('refs/tags/*:refs/tags/*')} >"$push_log" 2>&1 || push_rc=$?`,
        'cat "$push_log"',
        'if [ "$push_rc" -ne 0 ]; then',
        `\tif grep -qE 'GH006|[Pp]rotected branch|Cannot force-push|pre-receive hook declined' "$push_log"; then`,
        '\t\techo ""',
        '\t\techo "=============================================================="',
        '\t\techo "The remote refused the push because a branch is PROTECTED."',
        '\t\techo ""',
        '\t\techo "NOTHING WAS PUSHED. The remote is unchanged, which also means"',
        '\t\techo "the secret is STILL on it. Local history is already rewritten;"',
        '\t\techo "only the push is left."',
        '\t\techo ""',
        '\t\techo "Refs listed as (atomic transaction failed) are NOT separate"',
        '\t\techo "problems - the push is all-or-nothing, so one protected branch"',
        '\t\techo "rolls back every ref. Fix that one and they all go through."',
        '\t\techo ""',
        '\t\techo "To finish: allow force-pushes on the protected branch"',
        '\t\techo "(GitHub: Settings > Branches, or Rules > Rulesets), re-run this"',
        '\t\techo "script, then turn the protection back on immediately."',
        '\t\techo "=============================================================="',
        '\tfi',
        '\texit "$push_rc"',
        'fi',
        '',
        '# 8. Restore the branch that was checked out before the rewrite.',
        'if [ -n "$current_branch" ]; then',
        '\tgit checkout --quiet "$current_branch"',
        'fi'
    );

    if (verifyRegex || verifyLiterals.length > 0 || verifyPatterns.length > 0 || verifyRulesFile) {
        lines.push(
            '',
            '# 9. Verify the remote is actually clean on EVERY ref.',
            `git fetch --prune --tags ${remoteQ}`,
            'leftover=0',
            // Count refs actually examined. A zero-iteration loop leaves leftover=0,
            // which would print "Verified clean on every remote ref" having checked
            // nothing at all -- the same false all-clear the in-extension
            // verifyRemoteRefs guards against. The script must not be able to make a
            // claim the loop never tested.
            'checked=0',
            'while IFS= read -r ref; do',
            '\tcase "$ref" in */HEAD) continue;; esac',
            '\tchecked=$((checked + 1))'
        );
        if (verifyRegex) {
            lines.push(
                // Capture git ls-tree's exit separately: a failure (bad ref/object)
                // must be reported, not mistaken for "clean" the way a bare
                // `if git ls-tree | grep` under set -e would.
                '\tls_rc=0',
                '\tfiles="$(git --no-replace-objects ls-tree -r --name-only "$ref" 2>/dev/null)" || ls_rc=$?',
                '\tif [ "$ls_rc" -ne 0 ]; then',
                '\t\techo "VERIFY FAILED (git ls-tree exit $ls_rc): $ref"',
                '\t\tleftover=1',
                `\telif printf '%s\\n' "$files" | grep -qE ${shellQuote(verifyRegex)}; then`,
                '\t\techo "STILL PRESENT (path): $ref"',
                '\t\tleftover=1',
                '\tfi'
            );
        }
        if (verifyRulesFile) {
            // Verification reads the same rule file the rewrite consumed, rather than
            // repeating every secret inline once per rule. One list, one place: the
            // script cannot drift from what was actually rewritten, and the sensitive
            // values appear exactly once — in an owner-only temporary file that the
            // EXIT trap removes — instead of being pasted through the script body.
            lines.push(
                `\twhile IFS= read -r rule_line || [ -n "$rule_line" ]; do`,
                '\t\t[ -n "$rule_line" ] || continue',
                '\t\tcase "$rule_line" in',
                '\t\t\tregex:*)',
                '\t\t\t\tgrep_flag="--extended-regexp"',
                '\t\t\t\tneedle="${rule_line#regex:}"',
                '\t\t\t\t;;',
                '\t\t\t*)',
                '\t\t\t\tgrep_flag="--fixed-strings"',
                '\t\t\t\tneedle="$rule_line"',
                '\t\t\t\t;;',
                '\t\tesac',
                '\t\t# Everything before the first "==>" is what was searched for.',
                '\t\tneedle="${needle%%==>*}"',
                '\t\t[ -n "$needle" ] || continue',
                // git grep exits 1 for "not found" (clean); any other exit (e.g.
                // 128 for a bad ref) is a real failure and must be surfaced, not
                // swallowed as clean.
                '\t\tgrep_rc=0',
                '\t\tgit --no-replace-objects grep --quiet "$grep_flag" -e "$needle" "$ref" 2>/dev/null || grep_rc=$?',
                '\t\tif [ "$grep_rc" -eq 0 ]; then',
                '\t\t\techo "STILL PRESENT (secret): $ref"',
                '\t\t\tleftover=1',
                '\t\t\tbreak',
                '\t\telif [ "$grep_rc" -ne 1 ]; then',
                '\t\t\techo "VERIFY FAILED (git grep exit $grep_rc): $ref"',
                '\t\t\tleftover=1',
                '\t\t\tbreak',
                '\t\tfi',
                `\tdone < ${verifyRulesFile}`
            );
        }

        const verifySearches = [
            ...verifyLiterals.map(value => ({ value, flag: '--fixed-strings' })),
            ...verifyPatterns.map(value => ({ value, flag: '--extended-regexp' }))
        ];
        for (const search of verifySearches) {
            lines.push(
                '\tgrep_rc=0',
                `\tgit --no-replace-objects grep --quiet ${search.flag} -e ${shellQuote(search.value)} "$ref" 2>/dev/null || grep_rc=$?`,
                '\tif [ "$grep_rc" -eq 0 ]; then',
                '\t\techo "STILL PRESENT (secret): $ref"',
                '\t\tleftover=1',
                '\telif [ "$grep_rc" -ne 1 ]; then',
                '\t\techo "VERIFY FAILED (git grep exit $grep_rc): $ref"',
                '\t\tleftover=1',
                '\tfi'
            );
        }
        lines.push(
            `done < <(git for-each-ref --format='%(refname)' refs/remotes/${remote} refs/tags)`,
            'if [ "$checked" -eq 0 ]; then',
            `\techo "NOT VERIFIED: no refs were found under refs/remotes/${remote}, so nothing was checked."`,
            '\techo "This is NOT a clean result -- check the remote yourself."',
            '\texit 1',
            'elif [ "$leftover" -eq 0 ]; then',
            '\techo "Verified clean on every remote ref ($checked checked)."',
            'else',
            // Exit non-zero so the failure is visible to automation / command
            // chaining, not just printed. The EXIT trap still restores the branch.
            '\techo "Verification failed: see STILL PRESENT / VERIFY FAILED above." >&2',
            '\texit 1',
            'fi'
        );
    }

    if (finalCleanupCommand) {
        lines.push(
            '',
            '# 10. Everything above succeeded - only now is the rule file no longer',
            '#     needed. Any earlier exit keeps it, and the EXIT trap says where.',
            finalCleanupCommand
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
    resolveGitDir,
    createRulesFile,
    removeRulesFile,
    describeSandboxedFilterRepo,
    runGitFilterRepo,
    detectFilterRepo,
    buildFilterRepoInstallCommand,
    hasRemote,
    getRemoteUrl,
    ensureRemote,
    fetchAllRefs,
    describeFetchCommand,
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
    findUnremovedRules,
    findStringsInRefs,
    findStringsInObjects,
    parseProtectedRefRejection,
    detectRemoteProvider,
    buildRewriteScript,
    buildRewriteScriptPs1,
    findPathInCommit,
    psQuote,
    runRewrite
};
