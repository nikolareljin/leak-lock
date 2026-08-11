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

module.exports = { describeFindingPath };
