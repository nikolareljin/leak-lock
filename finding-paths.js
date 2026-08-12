// The File column shows a path relativized against the scan root (see
// `relativizePath` in scan-engines.js), so putting that same string in the
// tooltip told the user nothing they could not already read. The tooltip
// carries the absolute path instead.
//
// A history finding is deliberately worded differently: the file may have been
// deleted or renamed since that commit, and a bare absolute path would imply
// something openable on disk.
const fs = require('fs');
const path = require('path');

const SHORT_HASH_LENGTH = 7;

/** Walk up from `startDir` until a directory containing `.git` is found. */
function findGitRoot(startDir) {
    let dir = startDir;
    while (dir) {
        if (fs.existsSync(path.join(dir, '.git'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return null;
        }
        dir = parent;
    }
    return null;
}

function describeFindingPath(finding, scanPath) {
    const file = finding && typeof finding.file === 'string' ? finding.file : null;
    if (!file) {
        return { absolutePath: null, tooltip: '' };
    }

    let absolutePath = null;
    if (path.isAbsolute(file)) {
        absolutePath = file;
    } else if (scanPath) {
        absolutePath = path.join(scanPath, file);
    }

    const base = absolutePath || file;
    const commitHash = finding.commitHash;
    const tooltip = commitHash
        ? `${base} (at commit ${String(commitHash).slice(0, SHORT_HASH_LENGTH)})`
        : base;

    return { absolutePath, tooltip };
}

/**
 * The path to use when addressing a finding on a hosting provider.
 *
 * A finding's `file` is relative to the directory that was scanned; a permalink
 * needs it relative to the git root. Scanning a folder that contains the
 * repository makes those differ, and the difference is not cosmetic — every URL
 * gains the repository's own directory name as a leading segment and 404s:
 *
 *     /blob/<sha>/leak-lock/test/a.js   404
 *     /blob/<sha>/test/a.js             correct
 *
 * Resolving to absolute and re-relativizing against the git root is correct
 * whatever base the scanner used, including when they are the same directory.
 *
 * @returns {string|null} a forward-slash repo-relative path, or null when the
 *   file lies outside the repository
 */
function repoRelativePath(file, scanPath, repoRoot) {
    if (typeof file !== 'string' || !file) {
        return null;
    }

    const absolute = path.isAbsolute(file)
        ? file
        : (scanPath ? path.resolve(scanPath, file) : null);

    // Normalize repoRoot so path.relative receives native separators on every
    // platform — git outputs forward slashes on Windows (C:/...) while
    // path.resolve produces backslashes.
    let root = repoRoot ? path.normalize(repoRoot) : null;

    if (!root) {
        if (!absolute) {
            // No context at all: return file as-is (best-effort, caller decides).
            return file;
        }
        // repoRoot was not detected (e.g. scan ran on a parent directory that is
        // not itself a git repo). Walk up the filesystem to find it so the URL
        // segment is repo-relative rather than scan-relative.
        root = findGitRoot(path.dirname(absolute));
        if (!root) {
            return null;
        }
    }

    if (!absolute) {
        return null;
    }

    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        // Outside the repository: no commit of this repo can address it.
        return null;
    }
    // A URL path is always forward-slashed, whatever the host filesystem uses.
    return relative.split(path.sep).join('/');
}

/**
 * Every plausible repo-relative reading of a finding's path, best guess first.
 *
 * Some engines report a path already prefixed with the repository's own
 * directory name, even when the scan root IS the repository. Resolving that
 * against the scan root duplicates the segment and the URL 404s:
 *
 *     scanPath  /p/dvr
 *     file      dvr/leaklock-fixture/config/database.yml
 *     resolved  /p/dvr/dvr/leaklock-fixture/config/database.yml
 *
 * Stripping the repeated segment unconditionally would be wrong for a
 * repository that genuinely contains a top-level directory sharing its own
 * name — both readings are legitimate, and nothing in the path itself
 * distinguishes them. So both are returned in order and the caller asks git
 * which one exists at that commit. The repository is the authority; a guess
 * here would be a coin flip that silently produces a 404 when it loses.
 *
 * @returns {string[]} zero or more forward-slash repo-relative paths
 */
function repoRelativeCandidates(file, scanPath, repoRoot) {
    const primary = repoRelativePath(file, scanPath, repoRoot);
    if (!primary) {
        return [];
    }

    const candidates = [primary];

    const rootName = repoRoot ? path.basename(path.normalize(repoRoot)) : null;
    if (rootName && primary.startsWith(`${rootName}/`)) {
        const stripped = primary.slice(rootName.length + 1);
        if (stripped && !candidates.includes(stripped)) {
            candidates.push(stripped);
        }
    }

    return candidates;
}

module.exports = { describeFindingPath, repoRelativePath, repoRelativeCandidates };
