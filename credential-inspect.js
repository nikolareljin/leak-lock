// The only place in leak-lock that touches @nikolareljin/credential-lens.
//
// leak-lock is CommonJS; credential-lens is ESM. The boundary is crossed here,
// once, via await import(). Confining it means the rest of the codebase stays
// synchronous-require and testable without the package loaded.
//
// Nothing in this module may throw into a scan. Credential inspection enriches
// findings that already exist; a scan must never fail because it was
// unavailable.
//
// On the report shape: docs/INTEGRATION.md in credential-lens describes
// `warnings` as "limitations a caller should display", which reads as strings.
// The running 0.3.0 library emits `warnings` as `{ code, message }` objects,
// plus an undocumented parallel `caveats` array of the same text as strings.
// The running library is what this code matches — a declined report therefore
// uses the object shape, so callers have exactly one thing to render.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { sniffCandidate } = require('./credential-sniff');
const { repoRelativeCandidates } = require('./finding-paths');

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const PACKAGE_ID = '@nikolareljin/credential-lens';

let modulePromise = null;

function defaultImporter() {
    // Kept as a call rather than a top-level import so a packaging failure
    // surfaces as a reported error, not as a module that will not load.
    return import(PACKAGE_ID);
}

function loadModule(importer = defaultImporter) {
    if (!modulePromise) {
        modulePromise = Promise.resolve().then(importer);
    }
    return modulePromise;
}

/** Reset between tests; not used by the extension. */
function _resetModuleCache() {
    modulePromise = null;
}

async function loadLibraryInfo({ importer } = {}) {
    try {
        if (importer) {
            await Promise.resolve().then(importer);
        } else {
            await loadModule();
        }
        const pkg = require(`${PACKAGE_ID}/package.json`);
        return { ok: true, version: pkg.version };
    } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) };
    }
}

/**
 * The Dependencies panel must not claim a bundled package is ready without
 * having loaded it — that would assert a fact it never checked, which is the
 * exact failure the packaging test exists to catch.
 */
async function describeCredentialLensStatus({ load = loadLibraryInfo } = {}) {
    const info = await load();
    return {
        installed: info.ok === true,
        bundled: true,
        version: info.ok ? info.version : undefined,
        error: info.ok ? null : info.error
    };
}

async function createSession(options = {}) {
    const { maxEntries = 1000, maxResultBytes = 4 * 1024 * 1024, importer } = options;
    const lib = await loadModule(importer || defaultImporter);
    return lib.createInspectionSession({ maxEntries, maxResultBytes });
}

function isBinary(buffer) {
    // A NUL byte in the first 8 KB is the conventional binary signal, and every
    // artifact credential-lens understands is text.
    const window = buffer.subarray(0, Math.min(buffer.length, 8192));
    return window.includes(0x00);
}

function declined(reason) {
    return {
        source: 'declined',
        kind: null,
        report: {
            credential: null,
            summary: {},
            claims: [],
            warnings: [{ code: 'LEAK_LOCK_DECLINED', message: reason }],
            caveats: [reason],
            cache: { hit: false }
        }
    };
}

function defaultReadFile(absolutePath) {
    return fs.readFileSync(absolutePath);
}

/**
 * `cwd` must be inside the repository. Scanning a directory ABOVE it makes the
 * scan root not a git repo at all, and `git show` then fails for every history
 * finding — turning valid inspections into declined reports.
 */
function defaultReadBlob(commitHash, file, cwd) {
    return new Promise((resolve, reject) => {
        execFile(
            'git', ['show', `${commitHash}:${file}`],
            { cwd, encoding: 'buffer', maxBuffer: MAX_ARTIFACT_BYTES + 1024 },
            (error, stdout) => (error ? reject(error) : resolve(stdout))
        );
    });
}

/**
 * Read the finding's file as it existed at its commit.
 *
 * Two things have to be right, and both were wrong: the command must run inside
 * the repository (the scan root may sit above it), and the path must be
 * repo-relative (a scan-relative path names nothing inside the repo). Where the
 * path has more than one plausible reading, each is tried in turn — the same
 * ambiguity the permalinks resolve, and git is again the one that settles it.
 */
async function readCommitBlob(finding, context) {
    const { scanPath, repoRoot } = context;
    const readBlob = context.readBlob || defaultReadBlob;
    const cwd = repoRoot || scanPath;

    const candidates = repoRelativeCandidates(finding.file, scanPath, repoRoot);
    // With no repo context there is nothing to re-base against; ask for the path
    // as reported rather than refusing outright.
    const paths = candidates.length > 0 ? candidates : [finding.file];

    let lastError = null;
    for (const candidate of paths) {
        try {
            return await readBlob(finding.commitHash, candidate, cwd);
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error('the file could not be read at that commit');
}

async function inspectFinding(finding, context) {
    const { session, scanPath } = context;
    const maxBytes = context.maxBytes || MAX_ARTIFACT_BYTES;
    const secret = typeof finding.fullSecret === 'string' ? finding.fullSecret : finding.secret;
    if (!session || typeof secret !== 'string' || !secret) {
        return null;
    }

    // 1. The snippet. Free after the first time: the session cache is keyed by
    //    the exact bytes, so the same key on five branches is inspected once.
    let snippetReport = null;
    try {
        snippetReport = await session.inspectBytes(Buffer.from(secret, 'utf8'));
    } catch {
        snippetReport = null;
    }
    if (snippetReport && snippetReport.credential) {
        return { source: 'snippet', kind: snippetReport.credential.kind || null, report: snippetReport };
    }

    // 2. Is the whole artifact worth reading?
    const kind = sniffCandidate(secret);
    if (!kind) {
        return null;
    }

    let bytes;
    try {
        if (finding.commitHash) {
            bytes = await readCommitBlob(finding, context);
        } else {
            const readFile = context.readFile || defaultReadFile;
            const absolutePath = path.isAbsolute(finding.file)
                ? finding.file
                : path.join(scanPath || '', finding.file);
            bytes = await readFile(absolutePath);
        }
    } catch {
        // The reason is deliberately generic: an error message must not carry a
        // path or any part of a secret.
        return declined('The file containing this finding could not be read, so the credential was not inspected.');
    }

    if (!Buffer.isBuffer(bytes)) {
        bytes = Buffer.from(bytes);
    }
    if (bytes.length > maxBytes) {
        return declined(`The file containing this finding is too large to inspect (over ${Math.round(maxBytes / 1024)} KB).`);
    }
    if (isBinary(bytes)) {
        return declined('The file containing this finding is binary, so it was not inspected.');
    }

    try {
        const report = await session.inspectBytes(bytes);
        return {
            source: finding.commitHash ? 'commit-blob' : 'file',
            kind: (report.credential && report.credential.kind) || kind,
            report
        };
    } catch {
        return declined('The credential could not be inspected.');
    }
}

module.exports = {
    MAX_ARTIFACT_BYTES,
    createSession,
    loadLibraryInfo,
    describeCredentialLensStatus,
    inspectFinding,
    _resetModuleCache
};
