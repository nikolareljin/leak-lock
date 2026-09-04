// Where an external tool actually lives, when PATH cannot be trusted.
//
// A GUI-launched VS Code does not inherit the shell's PATH — on macOS it never
// does, and on Linux it depends on how the desktop entry was started. Every tool
// Leak Lock shells out to is therefore findable at an absolute location or not at
// all, and "not on PATH" is not the same fact as "not installed". Reporting the
// second when only the first is true sends the user off to install something they
// already have, which is what issue #121 described.
//
// This was solved once already, for the scan engines. It lives here now so the
// git-filter-repo and Java probes get the same answer instead of each carrying
// their own, narrower idea of where to look.
//
// No `vscode` import, and no `scan-engines` import, on purpose: this module sits
// underneath both and is unit-testable on its own.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const execFileAsync = util.promisify(execFile);

/**
 * Absolute locations searched before falling back to PATH.
 *
 * Mutated in place by `addBinarySearchDir`, and re-exported by `scan-engines` as
 * the same array object, so a directory registered through either name is visible
 * through both. Replacing this binding with a new array would silently split that
 * into two lists.
 */
const COMMON_BIN_DIRS = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), 'bin'),
    path.join(os.homedir(), 'go', 'bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/opt/homebrew/bin',      // Apple silicon Homebrew
    '/home/linuxbrew/.linuxbrew/bin',
    'C:\\Program Files\\gitleaks',
    'C:\\ProgramData\\chocolatey\\bin'
];

/**
 * Homebrew's `openjdk` is keg-only: `brew install openjdk` puts the JVM under
 * `opt/openjdk` and deliberately does NOT symlink `java` into `/opt/homebrew/bin`,
 * because macOS ships its own `java` stub. That is why issue #121 needed a
 * `~/.zshrc` edit to get a working install recognised. Probing the keg prefixes
 * directly makes the edit unnecessary.
 *
 * Versioned formulae are separate prefixes, so `brew install openjdk@21` lands
 * somewhere `openjdk` alone would not be found. Both Homebrew roots are listed:
 * `/opt/homebrew` on Apple silicon, `/usr/local` on Intel.
 */
const JAVA_KEG_BIN_DIRS = [];
for (const brewRoot of ['/opt/homebrew', '/usr/local']) {
    for (const formula of ['openjdk', 'openjdk@25', 'openjdk@21', 'openjdk@17', 'openjdk@11']) {
        JAVA_KEG_BIN_DIRS.push(path.join(brewRoot, 'opt', formula, 'bin'));
    }
}

const resolvedBinaries = new Map();

/**
 * Register a directory to search ahead of the common locations.
 *
 * Engines that Leak Lock installed itself land in extension storage, which is on no
 * PATH anywhere. Without this the extension could download a binary and then report
 * the engine as missing — the same silence the download was meant to end. Placed
 * first because a Leak-Lock-managed install is the one whose version Leak Lock knows;
 * an explicit `leakLock.<engine>.binaryPath` still wins over both, since `resolveBinary`
 * returns it before consulting any directory.
 */
function addBinarySearchDir(dir) {
    if (typeof dir !== 'string' || !dir) {
        return;
    }
    const existing = COMMON_BIN_DIRS.indexOf(dir);
    if (existing !== -1) {
        COMMON_BIN_DIRS.splice(existing, 1);
    }
    COMMON_BIN_DIRS.unshift(dir);
    // A new search location can change an answer already cached in this session —
    // including the "not installed" the user just acted on.
    resolvedBinaries.clear();
}

/**
 * Find `name` in one of `dirs`, or return null.
 *
 * Split out from `resolveBinary` so the Java lookup can search its own prefixes
 * without either polluting `COMMON_BIN_DIRS` for every other tool or duplicating
 * the accessSync/.exe handling.
 */
function findInDirs(name, dirs) {
    for (const dir of dirs) {
        if (!dir) {
            continue;
        }
        for (const candidate of [path.join(dir, name), path.join(dir, `${name}.exe`)]) {
            try {
                fs.accessSync(candidate, fs.constants.X_OK);
                return candidate;
            } catch {
                // Keep looking.
            }
        }
    }
    return null;
}

function resolveBinary(name, explicit) {
    if (explicit) {
        return explicit;
    }
    if (resolvedBinaries.has(name)) {
        return resolvedBinaries.get(name);
    }
    const found = findInDirs(name, COMMON_BIN_DIRS);
    if (found) {
        resolvedBinaries.set(name, found);
        return found;
    }
    // Deliberately not cached. A negative result is only true until the user installs
    // the engine, and caching it would keep reporting "not installed" for the rest of
    // the session — including right after someone follows the install hint we just
    // showed them. Only a successful absolute resolution is worth remembering.
    return name;
}

/** Test seam: forget cached binary locations. */
function resetBinaryCache() {
    resolvedBinaries.clear();
}

/**
 * Directories to search for a JVM, most specific first.
 *
 * Pure: derived from `env` and `platform` alone and never touches the filesystem,
 * so the ordering is assertable in a test on any host. `JAVA_HOME` comes first
 * because a user who set it has stated which JVM they mean, and the keg prefixes
 * come before the generic bin directories because on macOS the generic
 * `/usr/bin/java` is a stub that reports no JVM rather than a real runtime.
 *
 * @param {object} [env] defaults to `process.env`
 * @param {string} [platform] defaults to `process.platform`
 */
function javaSearchDirs(env = process.env, platform = process.platform) {
    const dirs = [];
    if (env && env.JAVA_HOME) {
        dirs.push(path.join(env.JAVA_HOME, 'bin'));
    }
    if (platform === 'darwin') {
        dirs.push(...JAVA_KEG_BIN_DIRS);
    }
    dirs.push(...COMMON_BIN_DIRS);
    return dirs;
}

/**
 * Ask macOS itself where the JVM is.
 *
 * `/usr/libexec/java_home` is the OS's own resolver and knows about every JDK
 * installed under /Library/Java/JavaVirtualMachines — Temurin, Zulu, an Oracle
 * installer — none of which put anything on PATH. It is the authoritative answer
 * on darwin and costs one exec only when the cheaper directory scan has already
 * failed.
 *
 * @returns {Promise<string|null>} absolute path to a `java` executable, or null
 */
async function findJavaViaJavaHome() {
    try {
        const { stdout } = await execFileAsync('/usr/libexec/java_home', [], { timeout: 10000 });
        const home = String(stdout).trim();
        if (!home) {
            return null;
        }
        const candidate = path.join(home, 'bin', 'java');
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
    } catch {
        // No JDK registered, or not macOS. The caller falls back to PATH.
        return null;
    }
}

/**
 * The command to invoke for Java.
 *
 * Returns an absolute path when one can be found, and the bare name `java`
 * otherwise — never null, so a caller can always attempt the run and let the
 * failure carry the real message. A bare `java` is still correct on a machine
 * whose PATH is genuinely set up; it is only insufficient as the *only* strategy.
 *
 * @param {string} [explicit] the `leakLock.java.path` setting, which wins outright
 */
async function resolveJavaCommand(explicit) {
    if (explicit) {
        return explicit;
    }
    const found = findInDirs('java', javaSearchDirs());
    if (found) {
        return found;
    }
    if (process.platform === 'darwin') {
        const viaJavaHome = await findJavaViaJavaHome();
        if (viaJavaHome) {
            return viaJavaHome;
        }
    }
    return 'java';
}

/**
 * Where `pip install --user` puts executables on this platform.
 *
 * The Windows counterpart already existed, because a Scripts directory nobody
 * adds to PATH is an obvious trap. The POSIX case is the same trap with a more
 * familiar path: `~/.local/bin` is on the PATH of a login shell on most systems
 * and on the PATH of a Finder-launched VS Code on none of them.
 *
 * Asking sysconfig rather than assuming `~/.local/bin` covers a virtualenv, a
 * Homebrew Python with its own user base, and PYTHONUSERBASE.
 *
 * @returns {Promise<string|null>} absolute path to the scripts directory, or null
 */
async function findPosixUserScriptsDir() {
    const script = "import sysconfig; print(sysconfig.get_path('scripts', 'posix_user'))";
    for (const cmd of ['python3', 'python']) {
        try {
            const { stdout } = await execFileAsync(cmd, ['-c', script], { timeout: 10000 });
            const dir = String(stdout).trim();
            if (dir) {
                return dir;
            }
        } catch { /* try next interpreter */ }
    }
    return null;
}

module.exports = {
    COMMON_BIN_DIRS,
    JAVA_KEG_BIN_DIRS,
    addBinarySearchDir,
    findInDirs,
    resolveBinary,
    resetBinaryCache,
    javaSearchDirs,
    findJavaViaJavaHome,
    resolveJavaCommand,
    findPosixUserScriptsDir
};
