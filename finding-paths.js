// The File column shows a path relativized against the scan root (see
// `relativizePath` in scan-engines.js), so putting that same string in the
// tooltip told the user nothing they could not already read. The tooltip
// carries the absolute path instead.
//
// A history finding is deliberately worded differently: the file may have been
// deleted or renamed since that commit, and a bare absolute path would imply
// something openable on disk.
const path = require('path');

const SHORT_HASH_LENGTH = 7;

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
    if (!scanPath || !repoRoot) {
        // Nothing to re-base against; the caller's own guards decide whether a
        // link is offered at all.
        return file;
    }

    const absolute = path.isAbsolute(file) ? file : path.resolve(scanPath, file);
    const relative = path.relative(repoRoot, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        // Outside the repository: no commit of this repo can address it.
        return null;
    }
    // A URL path is always forward-slashed, whatever the host filesystem uses.
    return relative.split(path.sep).join('/');
}

module.exports = { describeFindingPath, repoRelativePath };
