/**
 * Detection engine adapters.
 *
 * Leak Lock's original engine, Nosey Parker, was archived read-only upstream on
 * 2026-04-24 with its ruleset frozen at v0.24.0. This module adds maintained engines
 * alongside it and normalises their output into one shape.
 *
 * Two rules govern everything here:
 *
 *  1. **No loss of detail.** A finding from any engine must carry at least the fields a
 *     Nosey Parker finding carries. Where an engine cannot supply a field, it is
 *     declared in `capabilities.unavailable` and rendered as "not provided by this
 *     engine" — never left silently blank, because a blank cell meaning "nothing here"
 *     and one meaning "this engine can't tell you" are different facts.
 *
 *  2. **Shared post-processing.** Adapters do detection and mapping only. Severity,
 *     dependency classification, untracked detection, branch/tag enrichment and display
 *     truncation are applied afterwards, identically, to every engine's output — so two
 *     engines reporting the same secret cannot disagree about what it is.
 *
 * No `vscode` import (same rule as git-rewrite.js) so every adapter is unit-testable.
 */

const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const execFileAsync = util.promisify(execFile);

const DEFAULT_TIMEOUT_MS = 300000;
const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * The normalised finding shape every adapter produces.
 * Fields below `file`/`line`/`secret` are additive over what Nosey Parker supplies.
 */
const NORMALISED_FIELDS = Object.freeze([
    'file', 'line', 'secret', 'matchText', 'description', 'ruleId',
    'commitHash', 'commitDate', 'isGitHistory',
    'endLine', 'startColumn', 'endColumn',
    'entropy', 'fingerprint', 'author', 'authorEmail', 'commitMessage',
    'verified'
]);

function makeFinding(fields) {
    const finding = {};
    for (const key of NORMALISED_FIELDS) {
        finding[key] = Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : null;
    }
    return finding;
}

/**
 * Locate an engine binary.
 *
 * A GUI-launched VS Code does not inherit the shell's PATH on macOS, and on Linux it
 * frequently misses ~/.local/bin — so an engine the user has definitely installed is
 * reported "not installed" and silently skipped. Fall back to the places these tools
 * actually get installed before giving up.
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

const resolvedBinaries = new Map();

function resolveBinary(name, explicit) {
    if (explicit) {
        return explicit;
    }
    if (resolvedBinaries.has(name)) {
        return resolvedBinaries.get(name);
    }
    for (const dir of COMMON_BIN_DIRS) {
        for (const candidate of [path.join(dir, name), path.join(dir, `${name}.exe`)]) {
            try {
                fs.accessSync(candidate, fs.constants.X_OK);
                resolvedBinaries.set(name, candidate);
                return candidate;
            } catch {
                // Keep looking.
            }
        }
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

async function runTool(command, args, options = {}) {
    return execFileAsync(command, args, {
        timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        ...options
    });
}

/**
 * Read a report file an engine wrote, tolerating "no findings, no file".
 */
function readJsonReport(reportPath) {
    try {
        if (!fs.existsSync(reportPath)) {
            return [];
        }
        const raw = fs.readFileSync(reportPath, 'utf8').trim();
        if (!raw) {
            return [];
        }
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        throw new Error(`Could not read report at ${reportPath}: ${error.message}`);
    }
}

function withTempDir(prefix, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return Promise.resolve()
        .then(() => fn(dir))
        .finally(() => {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch {
                // Best effort; lives in the OS temp directory.
            }
        });
}

// ---------------------------------------------------------------------------
// Gitleaks
// ---------------------------------------------------------------------------

/**
 * Gitleaks renamed its subcommands in 8.19: `detect` became `git`, and `detect --no-git`
 * became `dir`. Distribution builds frequently report no version at all (Ubuntu's
 * package prints "version is set by build process"), so the CLI generation is probed
 * from `--help` rather than inferred from a version number.
 *
 * @returns {'modern'|'legacy'|null}
 */
function detectGitleaksDialect(helpText) {
    if (typeof helpText !== 'string' || !helpText) {
        return null;
    }
    if (/^\s+git\s+/m.test(helpText) && /^\s+dir\s+/m.test(helpText)) {
        return 'modern';
    }
    if (/^\s+detect\s+/m.test(helpText)) {
        return 'legacy';
    }
    return null;
}

/**
 * @param {'modern'|'legacy'} dialect
 * @param {'history'|'worktree'} surface
 */
function buildGitleaksArgs(dialect, surface, { repoDir, reportPath, configPath, baselinePath, maxTargetMegabytes }) {
    const common = [
        '--report-format', 'json',
        '--report-path', reportPath,
        // Findings are the expected outcome, not an error condition. Without this the
        // adapter would have to distinguish "leaks found" from "tool broke" by exit code.
        '--exit-code', '0',
        '--no-banner'
    ];
    if (configPath) {
        common.push('--config', configPath);
    }
    if (baselinePath) {
        common.push('--baseline-path', baselinePath);
    }
    if (Number.isFinite(maxTargetMegabytes) && maxTargetMegabytes > 0) {
        common.push('--max-target-megabytes', String(maxTargetMegabytes));
    }

    if (dialect === 'modern') {
        return surface === 'history'
            // --log-opts is passed through to `git log -p`; --all is what brings every
            // ref into scope rather than just the current branch.
            ? ['git', '--log-opts=--all', ...common, repoDir]
            : ['dir', ...common, repoDir];
    }

    return surface === 'history'
        ? ['detect', '--source', repoDir, '--log-opts=--all', ...common]
        : ['detect', '--source', repoDir, '--no-git', ...common];
}

/**
 * Gitleaks reports history paths relative to the repository but working-tree paths as
 * whatever was passed on the command line — an absolute path in our case. Normalising
 * here keeps the same file from appearing as two different rows depending on which pass
 * found it.
 */
function relativizePath(filePath, repoDir) {
    if (!filePath || !repoDir) {
        return filePath || null;
    }
    const normalisedRepo = repoDir.endsWith(path.sep) ? repoDir : repoDir + path.sep;
    if (filePath.startsWith(normalisedRepo)) {
        return filePath.slice(normalisedRepo.length);
    }
    return filePath;
}

function mapGitleaksFinding(raw, surface, repoDir) {
    const commit = raw.Commit || null;
    return makeFinding({
        file: relativizePath(raw.File || raw.SymlinkFile || null, repoDir),
        line: Number.isFinite(raw.StartLine) ? raw.StartLine : null,
        secret: raw.Secret || raw.Match || null,
        matchText: raw.Match || null,
        description: raw.Description || raw.RuleID || null,
        ruleId: raw.RuleID || null,
        commitHash: commit || null,
        commitDate: raw.Date || null,
        // `dir`/`--no-git` findings are working-tree only; `git`/`detect` walks history.
        isGitHistory: surface === 'history' && Boolean(commit),
        endLine: Number.isFinite(raw.EndLine) ? raw.EndLine : null,
        startColumn: Number.isFinite(raw.StartColumn) ? raw.StartColumn : null,
        endColumn: Number.isFinite(raw.EndColumn) ? raw.EndColumn : null,
        entropy: Number.isFinite(raw.Entropy) ? raw.Entropy : null,
        fingerprint: raw.Fingerprint || null,
        author: raw.Author || null,
        authorEmail: raw.Email || null,
        commitMessage: raw.Message || null,
        // Gitleaks does not verify credentials against providers.
        verified: null
    });
}

const gitleaksEngine = {
    id: 'gitleaks',
    displayName: 'Gitleaks',
    binary: 'gitleaks',
    installHint: 'https://github.com/gitleaks/gitleaks#installing',
    capabilities: {
        gitHistory: true,
        workingTree: true,
        verification: false,
        // Everything Nosey Parker supplies, plus columns, entropy, author and a stable
        // fingerprint. Only verification is missing, and that is declared rather than
        // silently rendered as "not verified".
        unavailable: ['verified']
    },

    async isAvailable(options = {}) {
        try {
            const { stdout } = await runTool(resolveBinary(this.binary, options.binary), ['--help'], { timeoutMs: 15000 });
            return detectGitleaksDialect(stdout) !== null;
        } catch {
            return false;
        }
    },

    async version(options = {}) {
        try {
            const { stdout } = await runTool(resolveBinary(this.binary, options.binary), ['version'], { timeoutMs: 15000 });
            const text = String(stdout || '').trim();
            // Distribution builds print a placeholder — Ubuntu's package emits
            // "version is set by build process". Rendering that where a version
            // belongs is worse than admitting the version is unknown.
            const match = text.match(/\d+\.\d+\.\d+/);
            return match ? `v${match[0]}` : null;
        } catch {
            return null;
        }
    },

    /**
     * @returns {Promise<{findings: Array, surfaces: object, warnings: string[]}>}
     */
    async scan({ repoDir, binary, timeoutMs, configPath, baselinePath, maxTargetMegabytes, includeWorkingTree = true } = {}) {
        const bin = resolveBinary(this.binary, binary);
        const { stdout: helpText } = await runTool(bin, ['--help'], { timeoutMs: 15000 });
        const dialect = detectGitleaksDialect(helpText);
        if (!dialect) {
            throw new Error('Could not determine the Gitleaks CLI dialect from --help output.');
        }

        const warnings = [];
        const surfaces = {};
        const findings = [];

        await withTempDir('leaklock-gitleaks-', async (dir) => {
            const passes = includeWorkingTree ? ['history', 'worktree'] : ['history'];
            for (const surface of passes) {
                const reportPath = path.join(dir, `${surface}.json`);
                const args = buildGitleaksArgs(dialect, surface, {
                    repoDir,
                    reportPath,
                    configPath,
                    baselinePath,
                    maxTargetMegabytes
                });
                try {
                    await runTool(bin, args, { timeoutMs });
                    const raw = readJsonReport(reportPath);
                    surfaces[surface] = raw.length;
                    for (const item of raw) {
                        findings.push(mapGitleaksFinding(item, surface, repoDir));
                    }
                } catch (error) {
                    // One failing pass must not discard the other's results — the same
                    // isolation the git-history keyword passes already use.
                    //
                    // A pass that timed out or exited non-zero has often already
                    // written part of its report. Throwing that away loses real
                    // findings for no reason, which is the same mistake the scan
                    // timeout used to make.
                    let recovered = 0;
                    try {
                        for (const item of readJsonReport(reportPath)) {
                            findings.push(mapGitleaksFinding(item, surface, repoDir));
                            recovered += 1;
                        }
                    } catch {
                        // No usable partial report; the warning below still stands.
                    }
                    surfaces[surface] = recovered > 0 ? recovered : null;
                    warnings.push(
                        `Gitleaks ${surface} pass did not complete: ${error.message}` +
                        (recovered > 0
                            ? ` — ${recovered} finding(s) recovered from the partial report, so these results are not exhaustive.`
                            : '')
                    );
                }
            }
        });

        return { findings, surfaces, warnings, dialect };
    }
};

// ---------------------------------------------------------------------------
// TruffleHog
// ---------------------------------------------------------------------------

/**
 * TruffleHog is the only engine here that answers "is this credential still live?".
 * Verification makes read-only API calls to third-party providers using the discovered
 * credential, so it is opt-in and must never be enabled silently.
 */
function buildTruffleHogArgs({ repoDir, verify, results }) {
    // `file://` + a raw path is not a URL on Windows: drive letters and backslashes
    // produce something TruffleHog cannot open, so scanning failed outright there.
    const repoUrl = pathToFileURL(repoDir).href;
    const args = ['git', repoUrl, '--json', '--no-update'];
    if (verify === false) {
        args.push('--no-verification');
    } else {
        args.push(`--results=${results || 'verified,unknown'}`);
    }
    return args;
}

/**
 * TruffleHog emits JSON Lines, not a JSON array, and interleaves progress records.
 * Anything without a DetectorName is not a finding.
 */
function parseTruffleHogJsonl(stdout) {
    const findings = [];
    for (const line of String(stdout || '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed[0] !== '{') {
            continue;
        }
        let record;
        try {
            record = JSON.parse(trimmed);
        } catch {
            continue;
        }
        if (!record || !record.DetectorName) {
            continue;
        }
        findings.push(record);
    }
    return findings;
}

/**
 * Coerce a line number without letting `|| null` swallow a legitimate 0.
 * Line numbers are 1-based in practice, but a coercion that silently discards a
 * valid value is wrong regardless of whether the value shows up today.
 */
function toLineNumber(value) {
    if (Number.isFinite(value)) {
        return value;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function mapTruffleHogFinding(raw) {
    // The Git metadata moved under SourceMetadata.Data.Git in v3; older builds put it
    // directly under SourceMetadata.Git. Accept both rather than silently losing the
    // commit and file for one of them.
    const git = raw.SourceMetadata?.Data?.Git || raw.SourceMetadata?.Git || {};
    const timestamp = git.timestamp || null;
    return makeFinding({
        file: git.file || null,
        line: toLineNumber(git.line),
        secret: raw.Raw || raw.RawV2 || null,
        matchText: raw.RawV2 || raw.Raw || null,
        description: describeTruffleHogDetector(raw.DetectorName),
        ruleId: raw.DetectorName || null,
        commitHash: git.commit || null,
        commitDate: timestamp,
        isGitHistory: Boolean(git.commit),
        authorEmail: git.email || null,
        verified: raw.Verified === true
    });
}

function describeTruffleHogDetector(detectorName) {
    if (!detectorName) {
        return null;
    }
    // TruffleHog emits a detector name but no human description. Deriving one keeps the
    // Description column populated rather than blank for this engine.
    const spaced = String(detectorName).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    return `${spaced} credential detected by TruffleHog`;
}

const truffleHogEngine = {
    id: 'trufflehog',
    displayName: 'TruffleHog',
    binary: 'trufflehog',
    installHint: 'https://github.com/trufflesecurity/trufflehog#installation',
    // AGPL-3.0. Invoked as a subprocess only — no bundling, no linking. Leak Lock
    // stays MIT.
    licence: 'AGPL-3.0 (invoked as an external process)',
    capabilities: {
        gitHistory: true,
        workingTree: false,
        verification: true,
        // TruffleHog reports no end line, no column range, no entropy and no
        // fingerprint. Declared so the UI marks them unavailable instead of empty.
        unavailable: ['endLine', 'startColumn', 'endColumn', 'entropy', 'fingerprint', 'commitMessage', 'author']
    },

    async isAvailable(options = {}) {
        try {
            await runTool(resolveBinary(this.binary, options.binary), ['--version'], { timeoutMs: 15000 });
            return true;
        } catch {
            return false;
        }
    },

    async version(options = {}) {
        try {
            // TruffleHog prints its version banner on stderr.
            const { stdout, stderr } = await runTool(resolveBinary(this.binary, options.binary), ['--version'], { timeoutMs: 15000 });
            const text = `${stdout || ''}${stderr || ''}`.trim();
            const match = text.match(/\d+\.\d+\.\d+/);
            return match ? `v${match[0]}` : (text.split('\n')[0] || null);
        } catch {
            return null;
        }
    },

    async scan({ repoDir, binary, timeoutMs, verify = true, results = 'verified,unknown' } = {}) {
        const bin = resolveBinary(this.binary, binary);
        const args = buildTruffleHogArgs({ repoDir, verify, results });
        const warnings = [];
        let stdout = '';
        try {
            const output = await runTool(bin, args, { timeoutMs });
            stdout = output.stdout;
        } catch (error) {
            // TruffleHog exits non-zero when it finds secrets with --fail, and some
            // builds exit non-zero on partial source errors. Its stdout is still valid
            // JSONL, so parse it rather than discarding real findings.
            stdout = error.stdout || '';
            if (!stdout) {
                throw error;
            }
            warnings.push(`TruffleHog exited non-zero; parsed partial output: ${error.message}`);
        }

        // "Verified live" is a claim about a moment in time — a credential valid last
        // week may have been rotated since. Stamp when the check actually ran.
        // Stamped on every finding a verifying run produced, not only the live ones.
        // "Checked, not live" is equally a claim about a moment in time — the key may
        // have been rotated back since — and a status with no timestamp cannot be
        // interpreted later.
        const verifiedAt = verify === false ? null : new Date().toISOString();
        const findings = parseTruffleHogJsonl(stdout).map(raw => {
            const finding = mapTruffleHogFinding(raw);
            if (verifiedAt) {
                finding.verifiedAt = verifiedAt;
            } else {
                // With --no-verification TruffleHog still emits Verified:false, but
                // that means "not checked", not "checked and not live". Reporting it
                // as false would tell the user a credential was validated against its
                // provider when nothing of the sort happened.
                finding.verified = null;
            }
            return finding;
        });
        return { findings, warnings, verified: findings.filter(f => f.verified === true).length };
    }
};

const ENGINES = Object.freeze({
    [gitleaksEngine.id]: gitleaksEngine,
    [truffleHogEngine.id]: truffleHogEngine
});

function getEngine(id) {
    return ENGINES[id] || null;
}

module.exports = {
    NORMALISED_FIELDS,
    makeFinding,
    toLineNumber,
    COMMON_BIN_DIRS,
    resolveBinary,
    resetBinaryCache,
    detectGitleaksDialect,
    buildGitleaksArgs,
    mapGitleaksFinding,
    relativizePath,
    buildTruffleHogArgs,
    parseTruffleHogJsonl,
    mapTruffleHogFinding,
    describeTruffleHogDetector,
    gitleaksEngine,
    truffleHogEngine,
    ENGINES,
    getEngine
};
