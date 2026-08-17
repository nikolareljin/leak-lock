/**
 * Reading a previously exported scan report back in, and answering the one question
 * the export was always missing: *were those findings actually resolved?*
 *
 * Leak Lock could write a report and never read one. After a cleanup the only way to
 * check the work was to scan again and compare two JSON files by eye, which is exactly
 * the kind of manual diff that quietly misses the one value the rewrite skipped.
 *
 * Two rules govern everything here:
 *
 *  1. **Unknown is never resolved.** A report exported with redaction carries no value
 *     to search for, and a value an engine *decoded* out of a blob is not the bytes the
 *     blob holds. Both are reported as unverifiable. A green tick that means "we could
 *     not check" is worse than no tick at all, because the whole point of importing a
 *     report is to trust the answer.
 *
 *  2. **Presence is measured against the repository, not against a scanner.** A history
 *     rewrite removes a value from every reachable commit, so a pickaxe over `--all` is
 *     direct evidence and needs no engine installed. Agreement with a current scan is a
 *     second, separate signal.
 *
 * No `vscode` import (same rule as git-rewrite.js, redaction-rules.js and
 * scan-engines.js) so all of this is unit-testable outside a VS Code host.
 */

// What `_buildScanExportPayload` writes in place of a value when the user exports with
// redaction. Matched exactly: a finding whose real value happened to be this string
// would be unverifiable anyway, so there is no useful distinction to preserve.
const REDACTED_SECRET = '[REDACTED_SECRET]';
const REDACTED_PATH = '[REDACTED_PATH]';

// Verification is one pickaxe walk over the whole history per value. On a large history
// with a large report that is minutes of work, so it is bounded, and the bound is
// reported rather than applied silently - a partial verification that reads as complete
// is the same failure as a truncated scan that reads as clean.
const DEFAULT_VERIFY_LIMIT = 250;

// Every read that decides whether a value is gone runs against the real objects.
// `git filter-repo` leaves a `refs/replace/<old commit>` entry for every commit it
// rewrites, and git honours those refs everywhere: a pickaxe would then walk the
// rewritten history, find nothing, and report a value as resolved while the original
// objects still hold it. That is a false all-clear in the exact workflow this feature
// exists for - importing a report straight after a cleanup. Same rule as git-rewrite.js
// and scan-engines.js, applied here in the argument list so it is directly assertable.
const RAW_OBJECT_FLAGS = Object.freeze(['--no-replace-objects']);

const STATUS = Object.freeze({
    RESOLVED: 'resolved',
    PRESENT: 'present',
    UNVERIFIABLE: 'unverifiable'
});

/**
 * Parse an exported report.
 *
 * Returns a result object rather than throwing: the input is a file the user picked,
 * so a wrong or truncated one is an expected outcome, not an exceptional one.
 */
function parseImportedReport(text, options = {}) {
    const sourceName = options.sourceName || null;
    let raw;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        return { ok: false, error: `Not valid JSON: ${error.message}` };
    }

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: 'Not a Leak Lock scan report: the file does not contain a JSON object.' };
    }
    if (!Array.isArray(raw.findings)) {
        return {
            ok: false,
            error: 'Not a Leak Lock scan report: no "findings" array. Export one with the Export JSON button.'
        };
    }

    const warnings = [];
    if (!raw.generatedAt) {
        warnings.push('The report does not record when it was generated, so "new since" is relative to an unknown time.');
    }

    const findings = raw.findings
        .filter(finding => finding && typeof finding === 'object')
        .map((finding, index) => normalizeImportedFinding(finding, index));

    const dropped = raw.findings.length - findings.length;
    if (dropped > 0) {
        warnings.push(`${dropped} entr${dropped === 1 ? 'y was' : 'ies were'} not an object and could not be read.`);
    }
    if (Number.isFinite(raw.totalFindings) && raw.totalFindings !== findings.length) {
        warnings.push(
            `The report says it holds ${raw.totalFindings} finding(s) but ${findings.length} could be read. ` +
            'It may have been edited or truncated.'
        );
    }
    // What the file says about itself and what it contains are different facts, and a
    // hand-edited one can disagree. Statuses were always derived from the values
    // themselves; the warnings now are too, so the text on screen cannot claim values
    // are unsearchable while the file carries them in plaintext, or the reverse.
    const redactedFindings = findings.filter(f => f.secret === REDACTED_SECRET).length;
    const declaredRedacted = Boolean(raw.redacted);
    if (redactedFindings > 0) {
        warnings.push(
            `${redactedFindings} of ${findings.length} finding(s) carry a redacted value, which cannot be searched for. `
            + 'Those are reported as unverifiable, never as resolved.'
        );
    }
    if (declaredRedacted && redactedFindings === 0 && findings.length > 0) {
        warnings.push('This report is marked as redacted but carries readable values. Treat the file as holding secrets, whatever it says about itself.');
    }
    if (!declaredRedacted && redactedFindings > 0) {
        warnings.push('This report is not marked as redacted, yet some of its values are. It may have been edited after export.');
    }
    if (raw.coverage && raw.coverage.incomplete) {
        warnings.push('The scan behind this report did not complete, so it is not a full list of what was there.');
    }

    return {
        ok: true,
        report: {
            sourceName,
            generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : null,
            scanPath: typeof raw.scanPath === 'string' ? raw.scanPath : null,
            selectedDirectory: typeof raw.selectedDirectory === 'string' ? raw.selectedDirectory : null,
            redacted: declaredRedacted,
            // Counted from the values, not from the flag: this is what the UI states.
            redactedFindings,
            // Which repository this report is about. Recorded since 0.9.0; an older
            // report has none, which is an unknown identity rather than a mismatch.
            repository: raw.repository && typeof raw.repository === 'object'
                ? {
                    remote: typeof raw.repository.remote === 'string' ? raw.repository.remote : null,
                    rootCommits: Array.isArray(raw.repository.rootCommits)
                        ? raw.repository.rootCommits.filter(hash => typeof hash === 'string')
                        : [],
                    path: typeof raw.repository.path === 'string' ? raw.repository.path : null
                }
                : null,
            totalFindings: findings.length,
            coverage: raw.coverage && typeof raw.coverage === 'object' ? raw.coverage : null,
            findings,
            warnings
        }
    };
}

/**
 * Reduce an exported finding to the fields this comparison uses, and decide up front
 * whether its value can be searched for at all.
 *
 * Unexpected keys are dropped rather than carried through: everything here reaches a
 * webview, and the narrower the shape the smaller the surface.
 */
function normalizeImportedFinding(finding, index) {
    const secret = typeof finding.secret === 'string' ? finding.secret : null;
    const valueIsLiteral = finding.valueIsLiteral !== false;
    const decoder = typeof finding.decoder === 'string' && finding.decoder ? finding.decoder : null;

    let unverifiableReason = null;
    if (!secret) {
        unverifiableReason = 'the report carries no value for this finding';
    } else if (secret === REDACTED_SECRET) {
        unverifiableReason = 'the report was exported with redaction, so the value is not in it';
    } else if (!valueIsLiteral || decoder) {
        unverifiableReason = decoder
            ? `the engine reported a ${decoder} decoding rather than the bytes stored in the file`
            : 'the engine reported a decoded value rather than the bytes stored in the file';
    }

    return {
        id: `imported:${index}`,
        file: typeof finding.file === 'string' ? finding.file : null,
        line: Number.isFinite(finding.line) ? finding.line : null,
        secret,
        secretDisplay: typeof finding.secretDisplay === 'string' ? finding.secretDisplay : (secret || ''),
        description: typeof finding.description === 'string' ? finding.description : '',
        severity: typeof finding.severity === 'string' ? finding.severity : 'info',
        ruleName: typeof finding.ruleName === 'string' ? finding.ruleName : null,
        engine: typeof finding.engine === 'string' ? finding.engine : null,
        engines: Array.isArray(finding.engines) ? finding.engines.filter(e => typeof e === 'string') : [],
        fingerprint: typeof finding.fingerprint === 'string' && finding.fingerprint ? finding.fingerprint : null,
        commitHash: typeof finding.commitHash === 'string' ? finding.commitHash : null,
        commitDate: typeof finding.commitDate === 'string' ? finding.commitDate : null,
        isGitHistory: Boolean(finding.isGitHistory),
        isUntracked: Boolean(finding.isUntracked),
        isDependency: Boolean(finding.isDependency),
        valueIsLiteral,
        decoder,
        verifiable: !unverifiableReason,
        unverifiableReason
    };
}

/**
 * Identity keys, most specific first.
 *
 * Matching on `file|line` alone would report a finding as resolved because the line
 * moved, which is the one wrong answer this feature must not give. Gitleaks supplies a
 * stable `fingerprint`; the other engines do not, so the value itself carries identity
 * for them.
 */
function findingIdentityKeys(finding) {
    const keys = [];
    if (finding.fingerprint) {
        keys.push(`fp\u0000${finding.fingerprint}`);
    }
    const value = finding.secret || finding.fullSecret || null;
    if (value && value !== REDACTED_SECRET) {
        if (finding.file && finding.ruleName) {
            keys.push(`vfr\u0000${value}\u0000${finding.file}\u0000${finding.ruleName}`);
        }
        keys.push(`v\u0000${value}`);
    }
    return keys;
}

/**
 * Index current scan results by every key they answer to, so a lookup can try the
 * specific keys before falling back to the value.
 */
function indexCurrentFindings(currentFindings) {
    const index = new Map();
    (currentFindings || []).forEach((result, position) => {
        const identity = {
            fingerprint: result.fingerprint,
            secret: result.fullSecret || result.secret,
            file: result.file,
            ruleName: result.ruleName
        };
        for (const key of findingIdentityKeys(identity)) {
            if (!index.has(key)) {
                index.set(key, { result, position });
            }
        }
    });
    return index;
}

/** The current-scan finding matching an imported one, or null. */
function matchInCurrentScan(importedFinding, currentIndex) {
    for (const key of findingIdentityKeys(importedFinding)) {
        const hit = currentIndex.get(key);
        if (hit) {
            return hit;
        }
    }
    return null;
}

/**
 * Current findings the imported report does not contain: what appeared since it was
 * written. This is the half that turns two scans into a history rather than two
 * unrelated snapshots.
 */
function findingsNewSince(importedFindings, currentFindings) {
    const importedKeys = new Set();
    for (const finding of importedFindings || []) {
        for (const key of findingIdentityKeys(finding)) {
            importedKeys.add(key);
        }
    }
    return (currentFindings || []).map((result, position) => ({ result, position }))
        .filter(({ result }) => {
            const keys = findingIdentityKeys({
                fingerprint: result.fingerprint,
                secret: result.fullSecret || result.secret,
                file: result.file,
                ruleName: result.ruleName
            });
            // A finding with no usable identity - no fingerprint and no value - cannot
            // be shown to be absent from the report, so it is not claimed as new.
            return keys.length > 0 && !keys.some(key => importedKeys.has(key));
        });
}

/**
 * Decide a status from the evidence gathered for one imported finding.
 *
 * `presence` is `{ inHistory, inWorkingTree, checked }`; `checked` false means the
 * content search did not run (bound reached, or no repository), which is not the same
 * as searching and finding nothing.
 */
function resolveStatus(finding, { presence, currentMatch } = {}) {
    if (currentMatch) {
        return {
            status: STATUS.PRESENT,
            reason: 'still reported by the current scan'
        };
    }
    if (!finding.verifiable) {
        return {
            status: STATUS.UNVERIFIABLE,
            reason: finding.unverifiableReason
        };
    }
    if (!presence || !presence.checked) {
        return {
            status: STATUS.UNVERIFIABLE,
            reason: (presence && presence.reason) || 'the value was not searched for'
        };
    }
    if (presence.inHistory || presence.inWorkingTree) {
        const where = [
            presence.inHistory ? 'git history' : null,
            presence.inWorkingTree ? 'the working tree' : null
        ].filter(Boolean).join(' and ');
        return { status: STATUS.PRESENT, reason: `still found in ${where}` };
    }
    return { status: STATUS.RESOLVED, reason: 'not found in git history or the working tree' };
}

function summarize(entries, extra = {}) {
    const counts = { resolved: 0, present: 0, unverifiable: 0 };
    for (const entry of entries || []) {
        if (Object.prototype.hasOwnProperty.call(counts, entry.status)) {
            counts[entry.status] += 1;
        }
    }
    return {
        total: (entries || []).length,
        ...counts,
        newFindings: extra.newFindings || 0,
        // True when the verification bound stopped the run short. Rendered, never
        // swallowed: a bounded check that reads as a complete one is a false all-clear.
        bounded: Boolean(extra.bounded),
        verifyLimit: extra.verifyLimit || null
    };
}

/**
 * `git log` arguments proving whether a literal value is anywhere in reachable history.
 *
 * `-S` is a pickaxe over diffs, so it finds content that was added and later removed,
 * which a working-tree grep cannot. `--all` matters for the same reason it matters to
 * the rewrite: a value surviving only on a branch not reachable from HEAD is exactly
 * the case this check exists to catch.
 */
function buildHistoryPresenceArgs(repoDir, value, options = {}) {
    const args = [...RAW_OBJECT_FLAGS, '-C', repoDir, 'log', '--all', '--max-count=1', '--format=%H'];
    if (options.reverse) {
        // `--reverse` is applied after the traversal, so it needs the walk to complete;
        // `--max-count=1` with it yields the *first* commit, which is what "when was
        // this introduced" asks for.
        args.push('--reverse');
    }
    // Attached form: a value beginning with `-` must not be read as another option.
    args.push(`-S${value}`);
    return args;
}

/** Arguments for the first commit that introduced a value, with its author date. */
function buildFirstCommitArgs(repoDir, value) {
    return [...RAW_OBJECT_FLAGS, '-C', repoDir, 'log', '--all', '--reverse', '--max-count=1', '--format=%H %aI', `-S${value}`];
}

/**
 * `git grep` arguments for the working tree, including untracked files.
 *
 * A value can be present on disk without ever having been committed - the local `.env`
 * case - and that needs deleting rather than a history rewrite, so it must not be
 * reported as resolved just because history is clean.
 */
function buildWorkingTreePresenceArgs(repoDir, value) {
    return [...RAW_OBJECT_FLAGS, '-C', repoDir, 'grep', '--fixed-strings', '--quiet', '--untracked', '-e', value];
}

/**
 * Describe a failed git call without repeating what it was searching for.
 *
 * `child_process.execFile` puts the whole command line into `error.message`, and these
 * commands carry the secret as `-S<value>` or `-e <value>`. Interpolating that into a
 * status would print the full value into the results table, past the truncation every
 * other surface applies. Only the exit status is reported, which is what a reader can
 * act on anyway.
 */
function describeGitFailure(error) {
    if (!error) {
        return 'unknown error';
    }
    if (error.killed || error.signal) {
        return error.signal ? `stopped by ${error.signal}` : 'stopped before it finished';
    }
    if (error.code === 'ENOENT') {
        return 'git was not found on this machine';
    }
    if (typeof error.code === 'number') {
        return `git exited with code ${error.code}`;
    }
    if (typeof error.code === 'string') {
        return `git failed with ${error.code}`;
    }
    return 'git failed';
}

/** Parse `<hash> <iso-date>` from the first-commit query. Tolerates an empty result. */
function parseFirstCommit(stdout) {
    const line = String(stdout || '').trim().split('\n')[0];
    if (!line) {
        return null;
    }
    const [hash, date] = line.split(' ');
    if (!hash) {
        return null;
    }
    return { hash, date: date || null };
}

/**
 * Does the imported report describe the repository it is being compared against?
 *
 * Every "resolved" produced against the wrong repository would be meaningless, so a
 * mismatch is stated before any status is shown. A redacted report recorded no path, so
 * the honest answer there is "unknown", not "mismatch".
 */
function describeRepoMatch(report, repoDir) {
    const recorded = report && (report.scanPath || report.selectedDirectory);
    if (!recorded || recorded === REDACTED_PATH) {
        return { known: false, matches: null, recorded: null };
    }
    if (!repoDir) {
        return { known: true, matches: null, recorded };
    }
    // Both separators, because a report exported on Windows is read on Linux and back:
    // `C:\repo\sub` and `C:/repo/sub` are one location, and comparing them raw reported
    // a location change that never happened. Windows paths are also case-insensitive.
    const isWindowsPath = (p) => /^[a-z]:[\\/]/i.test(p) || p.includes('\\');
    const foldCase = isWindowsPath(recorded) || isWindowsPath(repoDir);
    const normalize = (p) => {
        const unified = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
        return foldCase ? unified.toLowerCase() : unified;
    };
    const a = normalize(recorded);
    const b = normalize(repoDir);
    return {
        known: true,
        matches: a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`),
        recorded
    };
}

/**
 * Reduce a remote URL to the thing that identifies the repository.
 *
 * `git@github.com:acme/app.git`, `https://github.com/acme/app.git` and
 * `ssh://git@github.com/acme/app` are the same repository, and a comparison that said
 * otherwise would refuse an import that is perfectly valid.
 */
function normalizeRemoteUrl(url) {
    if (typeof url !== 'string' || !url.trim()) {
        return null;
    }
    let value = url.trim();
    // Whether a scheme was present decides what a `:` after the host means, and getting
    // that wrong is not cosmetic: `ssh://git@host:2222/acme/app` read as scp-style
    // becomes `host/2222/acme/app`, which no longer matches `git@host:acme/app` and
    // would refuse a perfectly valid import as a different repository.
    const hadScheme = /^[a-z+]+:\/\//i.test(value);
    value = value.replace(/^[a-z+]+:\/\//i, '');    // scheme
    value = value.replace(/^[^/@]+@/, '');          // user
    value = hadScheme
        ? value.replace(/^([^/:]+):\d+(?=\/|$)/, '$1')  // port, which is not identity
        : value.replace(/:(?=[^/])/, '/');              // scp-style host:path
    value = value.replace(/\.git$/i, '');
    value = value.replace(/\/+$/, '');
    return value.toLowerCase() || null;
}

/**
 * The identity of a repository, as recorded in an export and as read from disk.
 *
 * Root commits are the strong signal: every clone, fork and mirror of a repository
 * shares them, and no two unrelated repositories do. The remote is the second signal,
 * for the case where a report predates root-commit recording. The path is deliberately
 * *not* identity - a clone lives wherever the user put it, and two different
 * repositories can occupy the same path at different times.
 */
function describeRepositoryIdentity(recorded, current) {
    const rootsA = Array.isArray(recorded?.rootCommits) ? recorded.rootCommits.filter(Boolean) : [];
    const rootsB = Array.isArray(current?.rootCommits) ? current.rootCommits.filter(Boolean) : [];
    // Report the hash that actually matched, not the first of each list. A repository
    // with several roots would otherwise show two different hashes as the evidence for
    // saying they are the same repository, which reads as a contradiction.
    const sharedRoot = rootsA.find(hash => rootsB.includes(hash)) || null;
    if (sharedRoot) {
        return { verdict: 'match', basis: 'root commit', recorded: sharedRoot, current: sharedRoot };
    }

    const remoteA = normalizeRemoteUrl(recorded?.remote);
    const remoteB = normalizeRemoteUrl(current?.remote);
    if (remoteA && remoteB) {
        // Roots that disagree are not conclusive on their own. A rewrite that touched
        // the initial commit gives every commit after it a new hash, including the root,
        // so the repository a report was exported from an hour ago legitimately has
        // different roots now - and refusing there would break the one workflow this
        // feature exists for, importing a report straight after a cleanup. The remote
        // settles it: same remote, same repository.
        return {
            verdict: remoteA === remoteB ? 'match' : 'mismatch',
            basis: rootsA.length && rootsB.length ? 'remote (its history was rewritten)' : 'remote',
            recorded: recorded.remote,
            current: current.remote
        };
    }

    if (rootsA.length && rootsB.length) {
        // No remote to fall back on, so the differing roots are all there is.
        return { verdict: 'mismatch', basis: 'root commit', recorded: rootsA[0], current: rootsB[0] };
    }

    // Nothing comparable. A report exported before identity was recorded, or a
    // repository with no remote and no readable roots: say so rather than guessing,
    // because both a false match and a false mismatch are worse than an honest unknown.
    return {
        verdict: 'unknown',
        basis: null,
        recorded: recorded?.remote || (rootsA[0] || null),
        current: current?.remote || (rootsB[0] || null)
    };
}

module.exports = {
    REDACTED_SECRET,
    REDACTED_PATH,
    DEFAULT_VERIFY_LIMIT,
    RAW_OBJECT_FLAGS,
    STATUS,
    parseImportedReport,
    normalizeImportedFinding,
    findingIdentityKeys,
    indexCurrentFindings,
    matchInCurrentScan,
    findingsNewSince,
    resolveStatus,
    summarize,
    buildHistoryPresenceArgs,
    buildFirstCommitArgs,
    buildWorkingTreePresenceArgs,
    parseFirstCommit,
    describeGitFailure,
    describeRepoMatch,
    normalizeRemoteUrl,
    describeRepositoryIdentity
};
