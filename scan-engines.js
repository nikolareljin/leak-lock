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

// The container fallback. An engine that cannot be installed as a binary — blocked
// executable policy, no published build for the architecture — is still runnable on a
// machine that has Docker, and a working scanner beats an accurate excuse.
const engineDocker = require('./engine-docker');

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
    // `verified` and `verifiedAt` travel together: a verification status is
    // uninterpretable later without the moment it was taken. Only TruffleHog sets
    // verifiedAt, so without a null default the key is simply absent on findings from
    // the other engines — and JSON.stringify drops absent keys entirely, so the
    // exported schema would vary per finding depending on which engine found it.
    'verified', 'verifiedAt'
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

/* ------------------------------------------------------------------------- *
 * How an engine is invoked: native binary, or the project's container image.
 * ------------------------------------------------------------------------- */

/**
 * Choose a runtime from what is actually available.
 *
 * Pure, and separated from the probing, because the policy is the part worth asserting:
 * `auto` prefers the binary and falls back to the image, an explicit preference is
 * honoured even when the other runtime would work, and "neither" is a distinct answer
 * from "binary" so the caller can say which of the two ways to fix it applies.
 *
 * @returns {'binary'|'docker'|null}
 */
function chooseRuntime({ preference = 'auto', binaryAvailable = false, dockerAvailable = false } = {}) {
    if (preference === 'binary') {
        return binaryAvailable ? 'binary' : null;
    }
    if (preference === 'docker') {
        return dockerAvailable ? 'docker' : null;
    }
    if (binaryAvailable) {
        return 'binary';
    }
    return dockerAvailable ? 'docker' : null;
}

/**
 * Is the image already on this machine?
 *
 * Deliberately `image inspect` and never `run`: `docker run` silently pulls a missing
 * image, which would turn "check whether the fallback is available" into a multi-hundred
 * megabyte download in the middle of a scan the user thought had started.
 */
async function isDockerImagePresent(image, timeoutMs = 20000) {
    if (!image) {
        return false;
    }
    try {
        await runTool('docker', engineDocker.buildImageInspectArgs(image), { timeoutMs });
        return true;
    } catch {
        return false;
    }
}

/**
 * Resolve one engine to a concrete way of running it, or null if there is none.
 *
 * @returns {Promise<{mode: 'binary'|'docker', command: string, image: ?string}|null>}
 */
async function resolveExecution(engine, options = {}) {
    const binaryExecution = { mode: 'binary', command: resolveBinary(engine.binary, options.binary), image: null };
    const image = engineDocker.engineImage(engine.id, options.image);
    const dockerExecution = { mode: 'docker', command: 'docker', image };
    const preference = options.runtime || 'auto';

    // Probe only what the preference could select: an explicit `binary` must not pay
    // for a Docker round trip, and `docker` must not shell out to a binary probe.
    const binaryAvailable = preference === 'docker'
        ? false
        : await engine.probeExecution(binaryExecution);
    const dockerAvailable = (preference === 'binary' || (preference === 'auto' && binaryAvailable))
        ? false
        : (await isDockerImagePresent(image) && await engine.probeExecution(dockerExecution));

    const mode = chooseRuntime({ preference, binaryAvailable, dockerAvailable });
    if (mode === 'binary') {
        return binaryExecution;
    }
    return mode === 'docker' ? dockerExecution : null;
}

/**
 * Run engine arguments through whichever runtime was resolved.
 *
 * Adapters below build one argument list and hand it here; only the paths inside it
 * differ per runtime, and those come from `buildScanMounts` so a mount and its rewritten
 * path cannot drift apart.
 */
async function invoke(execution, engineArgs, { mounts = [], timeoutMs, platform } = {}) {
    if (execution.mode === 'docker') {
        return runTool(
            'docker',
            engineDocker.buildDockerRunArgs({ image: execution.image, mounts, args: engineArgs, platform }),
            { timeoutMs }
        );
    }
    return runTool(execution.command, engineArgs, { timeoutMs });
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
    // Both separators, always. Under the container runtime the scan root is a POSIX
    // path (`/repo`) even when the host is Windows, so keying off path.sep alone would
    // leave every containerised working-tree finding showing as `/repo/src/...`.
    for (const separator of new Set([path.sep, '/'])) {
        const prefix = repoDir.endsWith(separator) ? repoDir : repoDir + separator;
        if (filePath.startsWith(prefix)) {
            return filePath.slice(prefix.length);
        }
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

    /** Does this specific runtime yield a usable Gitleaks? */
    async probeExecution(execution) {
        try {
            const { stdout } = await invoke(execution, ['--help'], { timeoutMs: 30000 });
            return detectGitleaksDialect(stdout) !== null;
        } catch {
            return false;
        }
    },

    async isAvailable(options = {}) {
        return await resolveExecution(this, options) !== null;
    },

    async version(options = {}) {
        try {
            const execution = options.execution || await resolveExecution(this, options);
            if (!execution) {
                return null;
            }
            const { stdout } = await invoke(execution, ['version'], { timeoutMs: 30000 });
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
    async scan({ repoDir, binary, runtime, image, timeoutMs, configPath, baselinePath, maxTargetMegabytes, includeWorkingTree = true } = {}) {
        const execution = await resolveExecution(this, { binary, runtime, image });
        if (!execution) {
            throw new Error('Gitleaks is available neither as a binary nor as a pulled Docker image.');
        }
        const { stdout: helpText } = await invoke(execution, ['--help'], { timeoutMs: 30000 });
        const dialect = detectGitleaksDialect(helpText);
        if (!dialect) {
            throw new Error('Could not determine the Gitleaks CLI dialect from --help output.');
        }

        const warnings = [];
        const surfaces = {};
        const findings = [];

        await withTempDir('leaklock-gitleaks-', async (dir) => {
            const containerised = execution.mode === 'docker';
            // The mounts and the paths written into the arguments come from one call:
            // a mount whose rewritten path drifted would scan an empty directory and
            // report zero findings, which is indistinguishable from a clean repository.
            const { mounts, paths } = containerised
                ? engineDocker.buildScanMounts({ repoDir, reportDir: dir, configPath, baselinePath })
                : { mounts: [], paths: { repoDir, reportDir: dir, configPath, baselinePath } };
            // Paths in the report are relative to whatever Gitleaks was pointed at, so
            // findings are relativised against that, not against the host path.
            const scanRoot = paths.repoDir;

            const passes = includeWorkingTree ? ['history', 'worktree'] : ['history'];
            for (const surface of passes) {
                const hostReportPath = path.join(dir, `${surface}.json`);
                const reportPath = containerised ? `${paths.reportDir}/${surface}.json` : hostReportPath;
                const args = buildGitleaksArgs(dialect, surface, {
                    repoDir: scanRoot,
                    reportPath,
                    configPath: paths.configPath,
                    baselinePath: paths.baselinePath,
                    maxTargetMegabytes
                });
                try {
                    await invoke(execution, args, { mounts, timeoutMs });
                    const raw = readJsonReport(hostReportPath);
                    surfaces[surface] = raw.length;
                    for (const item of raw) {
                        findings.push(mapGitleaksFinding(item, surface, scanRoot));
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
                        for (const item of readJsonReport(hostReportPath)) {
                            findings.push(mapGitleaksFinding(item, surface, scanRoot));
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

        return { findings, surfaces, warnings, dialect, runtime: execution.mode };
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
function buildTruffleHogArgs({ repoDir, repoUrl, verify, results }) {
    // `file://` + a raw path is not a URL on Windows: drive letters and backslashes
    // produce something TruffleHog cannot open, so scanning failed outright there.
    // Under the container runtime the caller supplies the in-container URL instead,
    // because converting the host path would name a directory the container cannot see.
    const url = repoUrl || pathToFileURL(repoDir).href;
    const args = ['git', url, '--json', '--no-update'];
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

    async probeExecution(execution) {
        try {
            await invoke(execution, ['--version'], { timeoutMs: 30000 });
            return true;
        } catch {
            return false;
        }
    },

    async isAvailable(options = {}) {
        return await resolveExecution(this, options) !== null;
    },

    async version(options = {}) {
        try {
            const execution = options.execution || await resolveExecution(this, options);
            if (!execution) {
                return null;
            }
            // TruffleHog prints its version banner on stderr.
            const { stdout, stderr } = await invoke(execution, ['--version'], { timeoutMs: 30000 });
            const text = `${stdout || ''}${stderr || ''}`.trim();
            const match = text.match(/\d+\.\d+\.\d+/);
            return match ? `v${match[0]}` : (text.split('\n')[0] || null);
        } catch {
            return null;
        }
    },

    async scan({ repoDir, binary, runtime, image, timeoutMs, verify = true, results = 'verified,unknown' } = {}) {
        const execution = await resolveExecution(this, { binary, runtime, image });
        if (!execution) {
            throw new Error('TruffleHog is available neither as a binary nor as a pulled Docker image.');
        }
        const containerised = execution.mode === 'docker';
        const { mounts } = containerised
            ? engineDocker.buildScanMounts({ repoDir })
            : { mounts: [] };
        const args = buildTruffleHogArgs({
            repoDir,
            // The container sees the repository at its mount point; the host path would
            // name a directory that does not exist inside it.
            repoUrl: containerised ? `file://${engineDocker.CONTAINER_REPO}` : undefined,
            verify,
            results
        });
        const warnings = [];
        let stdout = '';
        try {
            const output = await invoke(execution, args, { mounts, timeoutMs });
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
        return {
            findings,
            warnings,
            verified: findings.filter(f => f.verified === true).length,
            runtime: execution.mode
        };
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
    addBinarySearchDir,
    resolveBinary,
    resetBinaryCache,
    chooseRuntime,
    isDockerImagePresent,
    resolveExecution,
    invoke,
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
