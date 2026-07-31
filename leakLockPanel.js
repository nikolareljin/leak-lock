// Main area panel provider that uses the Webview API to display security issues in the main editor area.

const vscode = require('vscode');
const { exec, spawn, execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');
const path = require('path');
const fs = require('fs');
const os = require('os');
const gitRewrite = require('./git-rewrite');
const scanEngineConfig = require('./scan-engine-config');
const scanEngines = require('./scan-engines');
const redactionRules = require('./redaction-rules');
const hostCapacity = require('./host-capacity');

// Configuration constants
const MAX_PATH_LENGTH = 4096; // Maximum allowed path length to prevent DoS attacks
const MAX_VOLUME_NAME_LENGTH = 255; // Maximum Docker volume name length
const DOCKER_PULL_TIMEOUT = 120000; // Docker pull timeout in milliseconds (2 minutes)
// Fallback only; the effective value comes from leakLock.scan.timeoutSeconds so a large
// repository is not forced to fail. See _getScanEngineSettings().
const SCAN_TIMEOUT = scanEngineConfig.DEFAULT_SCAN_TIMEOUT_MS;
const SECRET_TRUNCATE_LENGTH = 50; // Length to truncate secrets for display
const GIT_MAX_BUFFER = 64 * 1024 * 1024; // History rewrites emit a lot of stdout
const REMOTE_HEAD_FILTER_PATTERN = /\bHEAD$/; // Pattern to filter out remote HEAD refs

// Cross-platform sensitive system directories
const SENSITIVE_DIRECTORIES = {
    // Unix-like systems (Linux, macOS, etc.)
    unix: [
        '/etc',
        '/usr/bin',
        '/bin',
        '/sbin',
        '/root',
        '/var/run',
        '/var/log',
        '/sys',
        '/proc',
        '/boot',
        '/dev'
    ],
    // Windows systems
    windows: [
        'C:\\Windows',
        'C:\\Program Files',
        'C:\\Program Files (x86)',
        'C:\\ProgramData',
        'C:\\System Volume Information',
        'C:\\Boot',
        'C:\\Recovery',
        'C:\\$Recycle.Bin',
        'C:\\hiberfil.sys',
        'C:\\pagefile.sys',
        // Common system user directories
        'C:\\Users\\Administrator',
        'C:\\Users\\Default',
        'C:\\Users\\Public'
    ]
};

// Helper function to safely escape shell arguments
function escapeShellArg(arg) {
    if (typeof arg !== 'string') {
        throw new Error('Shell argument must be a string');
    }
    // Escape single quotes by ending the current quote, adding an escaped quote, and starting a new quote
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}

// Helper function to safely construct Docker commands using spawn instead of exec
//
// `timeout` terminates the container rather than only abandoning the promise. The
// previous Promise.race wrapper left the scan container running after a timeout, so a
// repository that timed out kept consuming CPU with nothing reading its output.
function runDockerCommand(args, options = {}) {
    const { timeout, ...spawnOptions } = options;
    return new Promise((resolve, reject) => {
        const dockerProcess = spawn('docker', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            ...spawnOptions
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let timer = null;

        if (Number.isFinite(timeout) && timeout > 0) {
            timer = setTimeout(() => {
                timedOut = true;
                try {
                    dockerProcess.kill('SIGTERM');
                } catch {
                    // Process may already have exited; the close handler still fires.
                }
            }, timeout);
        }

        const clearTimer = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        };

        dockerProcess.stdout?.on('data', (data) => {
            stdout += data.toString();
        });

        dockerProcess.stderr?.on('data', (data) => {
            stderr += data.toString();
        });

        dockerProcess.on('close', (code) => {
            clearTimer();
            if (timedOut) {
                const error = new Error(`Docker command timed out after ${Math.round(timeout / 1000)}s`);
                error.timedOut = true;
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
                return;
            }
            if (code === 0) {
                resolve({ stdout, stderr, code });
            } else {
                const error = new Error(`Docker command failed with code ${code}`);
                error.code = code;
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
            }
        });

        dockerProcess.on('error', (error) => {
            clearTimer();
            reject(error);
        });
    });
}

/**
 * Turn a raw `git fetch` failure into something a user can act on.
 *
 * Git dumps a multi-line wall of remote output on auth failures. Surfacing that
 * verbatim in a toast tells the user a command they never asked to run has failed,
 * without telling them what to do about it.
 *
 * @returns {{kind: string, message: string, detail: string}}
 */
function summarizeGitRemoteError(error) {
    const raw = `${error && error.message ? error.message : ''}\n${error && error.stderr ? error.stderr : ''}`;
    const detail = raw.replace(/\s+/g, ' ').trim();

    let kind = 'unreachable';
    let message = 'Could not reach the remote to refresh refs.';

    if (/SAML SSO|single sign-on|single-sign-on/i.test(raw)) {
        kind = 'sso';
        message =
            'The remote requires SAML SSO authorisation. Authorise your token or SSH key for the organisation, ' +
            'then prepare again.';
    } else if (/Authentication failed|could not read Username|Permission denied|access rights|403/i.test(raw)) {
        kind = 'auth';
        message =
            'Authentication to the remote failed. Check your credentials or SSH key, then prepare again.';
    } else if (/Could not resolve host|Network is unreachable|Connection timed out|timed out/i.test(raw)) {
        kind = 'network';
        message = 'The remote is unreachable — check your network or VPN, then prepare again.';
    }

    return { kind, message, detail };
}

// HTML escaping function to prevent XSS
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') {
        return String(unsafe);
    }
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// JSON escaping for data attributes
function escapeJsonAttribute(obj) {
    return escapeHtml(JSON.stringify(obj));
}

// Get platform-appropriate sensitive directories
function getSensitiveDirectories() {
    const isWindows = process.platform === 'win32';

    if (isWindows) {
        // On Windows, also check for case variations and different drive letters
        const windowsDirs = [...SENSITIVE_DIRECTORIES.windows];

        // Add variations for other common drive letters
        const driveLetters = ['D:', 'E:', 'F:'];
        driveLetters.forEach(drive => {
            windowsDirs.push(
                `${drive}\\Windows`,
                `${drive}\\Program Files`,
                `${drive}\\Program Files (x86)`,
                `${drive}\\ProgramData`
            );
        });

        return windowsDirs;
    } else {
        // Unix-like systems (Linux, macOS, etc.)
        return SENSITIVE_DIRECTORIES.unix;
    }
}

// Security validation functions
function validatePath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') {
        throw new Error('Path must be a non-empty string');
    }

    // Check for dangerous characters in the original input BEFORE normalization
    if (inputPath.includes('\0')) {
        throw new Error('Path contains null bytes');
    }

    // Check for path length limits
    if (inputPath.length > MAX_PATH_LENGTH) {
        throw new Error(`Path is too long (max ${MAX_PATH_LENGTH} characters)`);
    }

    // Check for suspicious patterns in the original input
    const suspiciousPatterns = [
        /\.\.[/\\]/,     // ../ or ..\
        /^\.\.$/,        // exactly ".."
        /[/\\]\.\.$/,    // ends with /.. or \..
        /^\.\.(?:[/\\]|$)/, // starts with ../ or ..\ or is just ".."
        /[/\\]\.\.(?:[/\\]|$)/, // contains /../ or \..\
    ];

    for (const pattern of suspiciousPatterns) {
        if (pattern.test(inputPath)) {
            throw new Error(`Path contains directory traversal attempt: ${inputPath}`);
        }
    }

    // Normalize the path to resolve any relative components
    const normalizedPath = path.resolve(inputPath);

    // Instead of restricting to current working directory, protect against
    // access to sensitive system directories only
    if (path.isAbsolute(normalizedPath)) {
        const sensitiveDirectories = getSensitiveDirectories();
        const isWindows = process.platform === 'win32';

        const isSensitive = sensitiveDirectories.some(sensitiveDir => {
            // Normalize both paths for comparison
            const normalizedSensitiveDir = path.resolve(sensitiveDir);

            if (isWindows) {
                // Case-insensitive comparison for Windows
                const normalizedPathLower = normalizedPath.toLowerCase();
                const sensitivePathLower = normalizedSensitiveDir.toLowerCase();

                return normalizedPathLower === sensitivePathLower ||
                    normalizedPathLower.startsWith(sensitivePathLower + path.sep);
            } else {
                // Case-sensitive comparison for Unix-like systems
                return normalizedPath === normalizedSensitiveDir ||
                    normalizedPath.startsWith(normalizedSensitiveDir + path.sep);
            }
        });

        if (isSensitive) {
            throw new Error(`Access to sensitive system directory not allowed: ${normalizedPath}`);
        }
    }

    return normalizedPath;
}

function validateDockerPath(inputPath, allowedBasePaths = []) {
    const validatedPath = validatePath(inputPath);

    // Ensure the path exists and is accessible
    if (!fs.existsSync(validatedPath)) {
        // For directories that don't exist yet, check if parent exists
        const parentDir = path.dirname(validatedPath);
        if (!fs.existsSync(parentDir)) {
            throw new Error(`Parent directory does not exist: ${parentDir}`);
        }
    }

    // If allowed base paths are specified, ensure the path is within them
    if (allowedBasePaths.length > 0) {
        const isAllowed = allowedBasePaths.some(basePath => {
            try {
                // Resolve both paths to handle symlinks and relative paths properly
                const normalizedBase = path.resolve(basePath);
                const normalizedValidated = path.resolve(validatedPath);

                // Use path.relative to check containment more robustly
                const relativePath = path.relative(normalizedBase, normalizedValidated);

                // If relative path is empty, it's the same directory (allowed)
                // If it doesn't start with .., it's within the base path (allowed)
                // If it starts with .., it's outside the base path (not allowed)
                return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
            } catch (error) {
                // If path resolution fails, deny access
                return false;
            }
        });

        if (!isAllowed) {
            throw new Error(`Path is outside allowed directories: ${validatedPath}`);
        }
    }

    return validatedPath;
}

function sanitizeDockerVolumeName(name) {
    if (!name || typeof name !== 'string') {
        throw new Error('Volume name must be a non-empty string');
    }

    // Allow only alphanumeric characters, hyphens, underscores, and dots
    // This prevents command injection through volume names
    const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '');

    if (sanitized !== name) {
        throw new Error(`Volume name contains invalid characters: ${name}`);
    }

    if (sanitized.length === 0 || sanitized.length > MAX_VOLUME_NAME_LENGTH) {
        throw new Error(`Volume name is invalid length: ${sanitized.length}`);
    }

    return sanitized;
}

// Webview panel provider for main area display
class LeakLockPanel {
    constructor(extensionUri) {
        this._extensionUri = extensionUri;
        // Flipped once createOrShow has assigned the initial webview.html.
        // Until then _updateWebviewContent must not render.
        this._initialRenderDone = false;
        this._scanResults = [];
        this._replacementValues = {};
        this._selectedDirectory = null;
        this._isScanning = false;
        this._scanProgress = null;
        this._scanPath = null;
        this._scanRepoRoot = null;
        this._trackedFiles = null;
        this._scanCleanup = {
            preparedCommand: null,
            preparedMode: null, // 'bfg' | 'git'
            replacements: null,
            replacementsFile: null,
            preparing: false,
            running: false,
            // Selection and replacement text live here, not in the webview DOM:
            // every prepare/refresh rebuilds the HTML, which would otherwise
            // reset the user's choices back to "everything checked".
            selection: null, // Set<number>; null = seed with all eligible findings
            replacementValues: {}, // { [findingIndex]: string }
            // User-authored "source text -> replace with" rules, for content no
            // scanner flagged. Unlike selection these are not tied to _scanResults
            // indices, so they survive a re-scan and a completed push.
            customRules: [], // { id, source, mode: 'literal'|'regex', replaceWith }
            customRulePreviews: {}, // { [ruleId]: { commits, files, branches, truncated } }
            pushPlan: null, // ref-by-ref preview of the force-push
            blockedBranches: null, // local branches with unpushed commits
            blockedReason: null, // 'unpushed-commits' | 'no-remote' | null
            verifyResult: null, // offending refs reported after a run
            // After the LOCAL rewrite runs, this holds everything needed to
            // force-push. The panel shows a persistent confirmation and the push
            // only happens once the user confirms it here. null = nothing staged.
            pendingPush: null, // { repoDir, remote, verify, label, refCount }
            // Repository the prepared plan targets. The executors use this rather than
            // re-deriving a path, so a cleanup can only ever run where it was planned.
            preparedRepo: null,
            // Set when the plan-time ref refresh failed (SSO, auth, offline). The
            // script is still generated; the in-panel run is withheld.
            refreshError: null,
            // Set when Nosey Parker is enabled but Docker is missing, so the scan
            // degrades to the remaining engines instead of failing outright.
            noseyParkerUnavailable: null
        };
        // What the last scan actually covered. "No findings" is only meaningful
        // alongside this, so it is rendered with the results rather than logged.
        this._scanCoverage = null; // see _buildScanCoverage()
        this._dependenciesInstalled = false;
        this._panel = null;

        // View mode: 'scan' | 'removeFiles'
        this._viewMode = 'scan';
        this._removalState = {
            repoDir: null,
            targets: [], // { path, type: 'file'|'directory', base }
            preparedCommand: null,
            preparedIndexFilter: null, // For git filter-branch execution
            preparedMode: null,
            preparing: false,
            running: false,
            combineMode: 'combined', // 'combined' | 'individual'
            details: [], // per-target info after prepare
            deletionMode: 'bfg', // 'bfg' | 'git'
            preview: null, // { branches/remotes/tags }
            lastFetchAt: null,
            pushPlan: null, // ref-by-ref preview of the force-push
            blockedBranches: null, // local branches with unpushed commits
            blockedReason: null, // 'unpushed-commits' | 'no-remote' | null
            verifyResult: null // offending refs reported after a run
        };
        // Fetch timestamps keyed by repo path. The scan view and the Remove Files
        // view can point at different repositories, so a single shared timestamp
        // would let one view's "Refs status" describe the other's repo.
        this._lastFetchAtByRepo = {};
    }

    /** Repo the scan-cleanup actions operate on (matches _prepareScanReplacementCommand). */
    _scanCleanupRepo() {
        return this._scanPath || this._selectedDirectory
            || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
    }

    _recordFetchAt(repoDir, iso) {
        if (repoDir) {
            this._lastFetchAtByRepo[repoDir] = iso || new Date().toISOString();
        }
    }

    _getLastFetchAt(repoDir) {
        return repoDir ? (this._lastFetchAtByRepo[repoDir] || null) : null;
    }

    static get currentPanel() {
        return LeakLockPanel._currentPanel;
    }

    static set currentPanel(panel) {
        LeakLockPanel._currentPanel = panel;
    }

    /**
     * @param {vscode.Uri} extensionUri
     * @param {(panel: LeakLockPanel) => void} [initialize] Stages panel state
     *   (view mode, target directory, …) before the webview is rendered. It
     *   runs ahead of the single initial html assignment so the panel opens
     *   straight into the requested view instead of rendering the default one
     *   and replacing it a moment later — replacing it destroys the webview
     *   document and can abort VS Code's in-flight service worker
     *   registration.
     */
    static createOrShow(extensionUri, initialize) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it
        if (LeakLockPanel.currentPanel) {
            if (initialize) {
                initialize(LeakLockPanel.currentPanel);
            }
            LeakLockPanel.currentPanel._panel.reveal(column);
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            'leakLockPanel',
            'Leak Lock Scanner',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true
            }
        );

        LeakLockPanel.currentPanel = new LeakLockPanel(extensionUri);
        LeakLockPanel.currentPanel._panel = panel;
        LeakLockPanel.currentPanel._setupPanelListeners();
        if (initialize) {
            initialize(LeakLockPanel.currentPanel);
        }
        LeakLockPanel.currentPanel._panel.webview.html = LeakLockPanel.currentPanel._getHtmlForWebview();
        // Set only once the document actually exists, so the flag never claims
        // a render that has not happened. Both statements run in the same tick,
        // so no update can be missed in between.
        LeakLockPanel.currentPanel._initialRenderDone = true;

        // Handle messages from the webview
        panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'fix':
                        LeakLockPanel.currentPanel._generateFixCommand(message.replacements);
                        break;
                    case 'runBFG':
                        LeakLockPanel.currentPanel._runBFGCommand(message.replacements);
                        break;
                    case 'openFile':
                        LeakLockPanel.currentPanel._openFile(message.file, message.line);
                        break;
                    case 'requestNewScan':
                        // Trigger new scan via command
                        vscode.commands.executeCommand('leak-lock.startScan');
                        break;
                    case 'openSecurityGuide':
                        LeakLockPanel.currentPanel._openSecurityGuide();
                        break;
                    case 'scan.prepareBfg':
                        LeakLockPanel.currentPanel._prepareScanBfgCommand(message.replacements);
                        break;
                    case 'scan.prepareGit':
                        LeakLockPanel.currentPanel._prepareScanGitCommand(message.replacements);
                        break;
                    case 'scan.runBfg':
                        LeakLockPanel.currentPanel._runPreparedScanCleanup('bfg');
                        break;
                    case 'scan.runGit':
                        LeakLockPanel.currentPanel._runPreparedScanCleanup('git');
                        break;
                    case 'scan.confirmForcePush':
                        LeakLockPanel.currentPanel._confirmForcePush();
                        break;
                    case 'scan.cancelForcePush':
                        LeakLockPanel.currentPanel._cancelForcePush();
                        break;
                    case 'scan.setSelection':
                        LeakLockPanel.currentPanel._setScanSelection(message.index, message.selected);
                        break;
                    case 'scan.setAllSelection':
                        LeakLockPanel.currentPanel._setAllScanSelection(message.selected);
                        break;
                    case 'scan.setReplacement':
                        LeakLockPanel.currentPanel._setScanReplacement(message.index, message.value);
                        break;
                    case 'scan.addCustomRule':
                        LeakLockPanel.currentPanel._handleAddCustomRule(message.source, message.mode, message.replaceWith);
                        break;
                    case 'scan.removeCustomRule':
                        LeakLockPanel.currentPanel._removeCustomRule(message.id);
                        LeakLockPanel.currentPanel._updateWebviewContent();
                        break;
                    case 'scan.previewCustomRule':
                        LeakLockPanel.currentPanel._previewCustomRule(message.id);
                        break;
                    case 'scan.saveScript':
                        LeakLockPanel.currentPanel._saveCleanupScript();
                        break;
                    case 'scan.exportJson':
                        LeakLockPanel.currentPanel._exportScanResultsJson();
                        break;
                    case 'scan.printPdf':
                        LeakLockPanel.currentPanel._printScanResultsPdf();
                        break;
                    // Remove Files flow
                    case 'removeFiles.selectRepo':
                        LeakLockPanel.currentPanel._selectRepoForRemoval();
                        break;
                    case 'removeFiles.selectTargets':
                        LeakLockPanel.currentPanel._selectTargetsForRemoval(message.kind);
                        break;
                    case 'removeFiles.removeTarget':
                        LeakLockPanel.currentPanel._removeTargetForRemoval(message.path);
                        break;
                    case 'removeFiles.clearTargets':
                        LeakLockPanel.currentPanel._clearTargetsForRemoval();
                        break;
                    case 'removeFiles.prepare':
                        LeakLockPanel.currentPanel._prepareBfgRemovalCommand();
                        break;
                    case 'removeFiles.run':
                        LeakLockPanel.currentPanel._runBfgRemoval();
                        break;
                    case 'removeFiles.setCombineMode':
                        LeakLockPanel.currentPanel._setCombineMode(message.mode);
                        break;
                    case 'removeFiles.setDeletionMode':
                        LeakLockPanel.currentPanel._setDeletionMode(message.mode);
                        break;
                    case 'removeFiles.preview':
                        LeakLockPanel.currentPanel._previewMatchesAcrossBranches();
                        break;
                    case 'removeFiles.prepareGit':
                        LeakLockPanel.currentPanel._prepareGitRemovalCommand();
                        break;
                    case 'removeFiles.runGit':
                        LeakLockPanel.currentPanel._runGitRemoval();
                        break;
                    case 'removeFiles.refetch':
                        LeakLockPanel.currentPanel._manualRefetch();
                        break;
                }
            },
            undefined,
            []
        );
    }

    _getHtmlForWebview() {
        const hasResults = this._scanResults.length > 0;

        // If in Remove Files mode, render that UI instead
        if (this._viewMode === 'removeFiles') {
            return this._getRemoveFilesHtml();
        }

        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Leak Lock</title>
                <style>
                    body {
                        font-family: var(--vscode-font-family);
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-editor-background);
                        padding: 20px;
                        margin: 0;
                        max-width: 1200px;
                        margin: 0 auto;
                    }
                    .main-container {
                        display: flex;
                        flex-direction: column;
                        gap: 20px;
                    }
                    .scan-header {
                        margin-bottom: 20px;
                        padding: 15px;
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 6px;
                        background-color: var(--vscode-editor-background);
                    }
                    .scan-button, .fix-button, .run-button {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 8px 16px;
                        border-radius: 4px;
                        cursor: pointer;
                        margin: 5px 5px 5px 0;
                        font-size: 0.9em;
                    }
                    .scan-button:hover, .fix-button:hover, .run-button:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }
                    .scan-button:disabled, .fix-button:disabled, .run-button:disabled {
                        background-color: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                        cursor: not-allowed;
                        opacity: 0.6;
                    }
                    .run-button {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        font-weight: bold;
                        padding: 10px 20px;
                        font-size: 1em;
                    }
                    .danger-button {
                        background: #c62828;
                        color: #fff;
                        border: none;
                        padding: 10px 16px;
                        border-radius: 4px;
                        font-weight: bold;
                        cursor: pointer;
                    }
                    .danger-button:hover {
                        background: #b71c1c;
                    }
                    .danger-button:disabled {
                        opacity: 0.5;
                        cursor: not-allowed;
                    }
                    .warning-text {
                        color: var(--vscode-errorForeground);
                        font-size: 0.85em;
                        margin: 8px 0;
                        font-weight: bold;
                    }
                    .results-table {
                        width: 100%;
                        border-collapse: collapse;
                        margin-top: 10px;
                        table-layout: fixed;
                    }
                    .results-table th, .results-table td {
                        border: 1px solid var(--vscode-panel-border);
                        padding: 8px;
                        text-align: left;
                        overflow: hidden;
                        text-overflow: ellipsis;
                    }
                    .results-table th {
                        background-color: var(--vscode-editor-selectionBackground);
                    }
                    .replacement-input {
                        width: 100%;
                        box-sizing: border-box;
                        background-color: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        border: 1px solid var(--vscode-input-border);
                        padding: 4px;
                        position: relative;
                        z-index: 1;
                    }
                    .checkbox {
                        margin-right: 5px;
                    }
                    .selection-counter {
                        margin-top: 6px;
                        font-size: 0.85em;
                        color: var(--vscode-descriptionForeground);
                    }
                    /* Loud badge so a finding in third-party code (not the user's own
                       source) is unmistakable and its disabled checkbox is explained. */
                    .dep-badge {
                        display: inline-block;
                        margin-left: 6px;
                        padding: 1px 7px;
                        font-size: 0.68em;
                        font-weight: 700;
                        letter-spacing: 0.04em;
                        text-transform: uppercase;
                        border-radius: 8px;
                        vertical-align: middle;
                        white-space: nowrap;
                        color: var(--vscode-inputValidation-warningForeground, #6b5200);
                        background: var(--vscode-inputValidation-warningBackground, #fff3cd);
                        border: 1px solid var(--vscode-inputValidation-warningBorder, #d9b64a);
                    }
                    .rewrite-blocked {
                        margin-top: 12px;
                        padding: 10px;
                        border-radius: 4px;
                        background: var(--vscode-inputValidation-errorBackground);
                        border-left: 3px solid var(--vscode-inputValidation-errorBorder);
                    }
                    .verify-clean {
                        margin-top: 12px;
                        padding: 10px;
                        border-radius: 4px;
                        background: var(--vscode-inputValidation-infoBackground);
                        border-left: 3px solid var(--vscode-gitDecoration-addedResourceForeground);
                    }
                    /* Persistent force-push confirmation. Deliberately loud and never
                       auto-dismissed: the remote is only changed after the user acts here. */
                    .pending-push {
                        margin-top: 16px;
                        padding: 14px 16px;
                        border-radius: 6px;
                        background: var(--vscode-inputValidation-warningBackground, #fff3cd);
                        border: 2px solid var(--vscode-inputValidation-warningBorder, #d9b64a);
                    }
                    .pending-push code {
                        background: var(--vscode-textCodeBlock-background);
                        padding: 1px 5px;
                        border-radius: 3px;
                    }
                    .push-plan {
                        margin-top: 10px;
                        padding: 10px;
                        border-radius: 4px;
                        background: var(--vscode-textCodeBlock-background);
                        border-left: 3px solid var(--vscode-textLink-foreground);
                    }
                    .manual-command {
                        background-color: var(--vscode-textCodeBlock-background);
                        padding: 10px;
                        border-radius: 4px;
                        font-family: monospace;
                        margin-top: 10px;
                        /* Preserve the script's line breaks; without this the div
                           collapses every newline to a space and the copied text
                           becomes one unrunnable line. */
                        white-space: pre-wrap;
                        overflow-wrap: anywhere;
                    }
                    .danger-command {
                        background: var(--vscode-inputValidation-errorBackground);
                        border: 1px solid var(--vscode-inputValidation-errorBorder);
                        color: var(--vscode-inputValidation-errorForeground);
                        padding: 10px;
                        border-radius: 4px;
                        font-family: monospace;
                        margin-top: 10px;
                        white-space: pre-wrap;
                        overflow-wrap: anywhere;
                    }
                    .hidden {
                        display: none;
                    }
                    .spinner {
                        border: 2px solid var(--vscode-progressBar-background);
                        border-top: 2px solid var(--vscode-progressBar-foreground);
                        border-radius: 50%;
                        width: 16px;
                        height: 16px;
                        animation: spin 1s linear infinite;
                    }
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                    .scanning-indicator {
                        display: flex;
                        align-items: center;
                        padding: 10px;
                        background: var(--vscode-inputValidation-infoBackground);
                        border-left: 3px solid var(--vscode-inputValidation-infoBorder);
                        border-radius: 3px;
                        margin-bottom: 15px;
                    }
                    
                    /* Scanning Progress Styles */
                    .scanning-progress {
                        text-align: center;
                        padding: 30px;
                        background: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 8px;
                        margin: 20px 0;
                    }
                    
                    .progress-message {
                        margin: 15px 0;
                        font-size: 1.1em;
                        color: var(--vscode-foreground);
                    }
                    
                    .progress-stages {
                        display: flex;
                        justify-content: center;
                        gap: 10px;
                        margin-top: 20px;
                        flex-wrap: wrap;
                    }
                    
                    .stage {
                        padding: 4px 8px;
                        background: var(--vscode-button-secondaryBackground);
                        border-radius: 12px;
                        font-size: 0.8em;
                        opacity: 0.5;
                        transition: all 0.3s ease;
                    }
                    
                    .stage.active {
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        opacity: 1;
                        transform: scale(1.05);
                    }
                    
                    /* Empty Results Styles */
                    .empty-results {
                        text-align: center;
                        padding: 40px 20px;
                        background: var(--vscode-editor-background);
                        border: 2px dashed var(--vscode-panel-border);
                        border-radius: 12px;
                        margin: 20px 0;
                    }
                    
                    .empty-icon {
                        font-size: 4em;
                        margin-bottom: 20px;
                        opacity: 0.8;
                    }
                    
                    .empty-results h2 {
                        color: #4caf50;
                        margin-bottom: 15px;
                        font-size: 1.5em;
                    }
                    
                    .empty-results p {
                        margin-bottom: 30px;
                        color: var(--vscode-descriptionForeground);
                        font-size: 1.1em;
                        line-height: 1.5;
                    }
                    
                    .scan-summary {
                        display: grid;
                        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                        gap: 15px;
                        margin: 30px 0;
                        max-width: 600px;
                        margin-left: auto;
                        margin-right: auto;
                    }
                    
                    .summary-item {
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        padding: 10px;
                        background: var(--vscode-textCodeBlock-background);
                        border-radius: 6px;
                    }
                    
                    .summary-icon {
                        font-size: 1.2em;
                    }
                    
                    .next-steps {
                        margin: 40px auto;
                        max-width: 500px;
                        text-align: left;
                        background: var(--vscode-textCodeBlock-background);
                        padding: 20px;
                        border-radius: 8px;
                    }
                    
                    .next-steps h3 {
                        margin-bottom: 15px;
                        color: var(--vscode-foreground);
                    }
                    
                    .next-steps ul {
                        margin: 0;
                        padding-left: 20px;
                    }
                    
                    .next-steps li {
                        margin-bottom: 8px;
                        line-height: 1.4;
                    }
                    
                    .action-buttons {
                        display: flex;
                        gap: 15px;
                        justify-content: center;
                        flex-wrap: wrap;
                        margin-top: 30px;
                    }
                    
                    .secondary-button {
                        background: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                        border: none;
                        padding: 12px 24px;
                        border-radius: 6px;
                        cursor: pointer;
                        font-size: 1em;
                        transition: background-color 0.2s;
                    }
                    
                    .secondary-button:hover {
                        background: var(--vscode-button-secondaryHoverBackground);
                    }

                    /* Reusable detail dialog (overlay) */
                    .detail-dialog-overlay {
                        display: none;
                        position: fixed;
                        top: 0; left: 0; right: 0; bottom: 0;
                        background: rgba(0,0,0,0.5);
                        z-index: 9999;
                        align-items: center;
                        justify-content: center;
                        pointer-events: none;
                    }
                    .detail-dialog-overlay.visible {
                        display: flex;
                        pointer-events: auto;
                    }
                    .detail-dialog {
                        background: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, #454545));
                        border-radius: 8px;
                        padding: 20px;
                        min-width: 340px;
                        max-width: 560px;
                        max-height: 70vh;
                        display: flex;
                        flex-direction: column;
                        box-shadow: 0 8px 24px rgba(0,0,0,0.4);
                    }
                    .detail-dialog-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 12px;
                    }
                    .detail-dialog-header h3 {
                        margin: 0;
                        font-size: 1em;
                    }
                    .detail-dialog-close {
                        background: none;
                        border: none;
                        color: var(--vscode-foreground);
                        font-size: 1.2em;
                        cursor: pointer;
                        padding: 2px 6px;
                        border-radius: 4px;
                    }
                    .detail-dialog-close:hover {
                        background: var(--vscode-toolbar-hoverBackground);
                    }
                    .detail-dialog-body {
                        overflow-y: auto;
                        font-family: monospace;
                        font-size: 0.9em;
                        white-space: pre-wrap;
                        word-break: break-all;
                        padding: 8px;
                        background: var(--vscode-textCodeBlock-background);
                        border-radius: 4px;
                        margin-bottom: 12px;
                        max-height: 50vh;
                    }
                    .detail-dialog-actions {
                        display: flex;
                        gap: 8px;
                        justify-content: flex-end;
                    }
                    .detail-dialog-actions button {
                        padding: 6px 14px;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 0.9em;
                    }
                    .detail-dialog-copy {
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                    }
                    .detail-dialog-copy:hover {
                        background: var(--vscode-button-hoverBackground);
                    }
                    .detail-dialog-dismiss {
                        background: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                    }
                    .detail-dialog-dismiss:hover {
                        background: var(--vscode-button-secondaryHoverBackground);
                    }

                    .branch-link {
                        cursor: pointer;
                        text-decoration: underline;
                        text-decoration-style: dotted;
                    }
                    .branch-link:hover {
                        text-decoration-style: solid;
                    }
                    .export-actions {
                        margin: 12px 0;
                        display: flex;
                        gap: 8px;
                        flex-wrap: wrap;
                    }
                    @media print {
                        .scan-header,
                        .run-section,
                        .warning-text,
                        .secret-checkbox,
                        .replacement-input,
                        .selection-counter,
                        .push-plan,
                        .rewrite-blocked,
                        .verify-clean,
                        button,
                        #detail-dialog-overlay {
                            display: none !important;
                        }
                        body, .main-container, .scan-section {
                            padding: 0 !important;
                            margin: 0 !important;
                        }
                        .results-table {
                            width: 100%;
                            border-collapse: collapse;
                            table-layout: fixed;
                        }
                        .results-table th, .results-table td {
                            border: 1px solid #999;
                            color: #000;
                            font-size: 10pt;
                            padding: 6px;
                            word-break: break-word;
                        }
                        /* Hide action/replacement columns in print output for readability. */
                        .results-table th:nth-child(1),
                        .results-table td:nth-child(1),
                        .results-table th:nth-child(5),
                        .results-table td:nth-child(5) {
                            display: none !important;
                        }
                    }
                </style>
            </head>
            <body>
                <div class="main-container">
                    <div class="scan-header">
                        <h2>🛡️ Security Scan Results</h2>
                        <p style="color: var(--vscode-descriptionForeground); margin: 5px 0 15px 0; font-size: 0.9em;">
                            Use the <strong>Control Panel</strong> in the sidebar to install dependencies and select directories to scan.
                        </p>
                        ${this._isScanning ? `
                            <div class="scanning-indicator">
                                <div class="spinner" style="margin-right: 10px;"></div>
                                <span>🔍 Scanning in progress... Please wait.</span>
                            </div>
                        ` : ''}
                    </div>
                </div>
                
                ${this._getScanResultsSection()}
                
                <script>
                    const vscode = acquireVsCodeApi();
                    
                    // Dependency installation and directory selection 
                    // is now handled by the sidebar panel
                    
                    function collectReplacements() {
                        const replacements = {};
                        const checkboxes = document.querySelectorAll('.secret-checkbox:checked');
                        
                        checkboxes.forEach(checkbox => {
                            const row = checkbox.closest('tr');
                            const findingIndex = row.dataset.findingIndex;
                            const replacementInput = row.querySelector('.replacement-input');
                            if (typeof findingIndex !== 'undefined') {
                                replacements['idx:' + findingIndex] = replacementInput.value || '*****';
                            }
                        });
                        
                        return replacements;
                    }

                    // --- Selection state ---
                    // Every change is mirrored to the extension immediately, because
                    // any re-render (prepare, refetch, progress) rebuilds this DOM
                    // from extension state. Without the round-trip the user's
                    // choices would be silently reset to "everything checked".
                    function findingCheckboxes() {
                        return Array.prototype.slice.call(
                            document.querySelectorAll('.secret-checkbox:not([disabled])')
                        );
                    }

                    function refreshSelectionUi() {
                        const boxes = findingCheckboxes();
                        const selected = boxes.filter(b => b.checked).length;
                        const total = boxes.length;

                        const counter = document.getElementById('selection-counter');
                        if (counter) {
                            counter.textContent = selected + ' of ' + total +
                                ' cleanable finding' + (total === 1 ? '' : 's') + ' selected';
                        }

                        const master = document.getElementById('select-all-findings');
                        if (master) {
                            master.checked = total > 0 && selected === total;
                            // HTML has no "indeterminate" attribute - it is a property only.
                            master.indeterminate = selected > 0 && selected < total;
                        }

                        // Manual redaction rules are cleaned by the same mechanism as
                        // findings, so a rules-only cleanup must not be gated on the
                        // finding checkboxes.
                        const customRules = document.querySelectorAll('[data-rule-remove]').length;
                        ['prepare-bfg-button', 'prepare-git-button'].forEach(function (id) {
                            const btn = document.getElementById(id);
                            if (btn) {
                                btn.disabled = selected === 0 && customRules === 0;
                            }
                        });
                    }

                    function setAllFindings(selected) {
                        findingCheckboxes().forEach(function (box) {
                            box.checked = selected;
                        });
                        vscode.postMessage({ command: 'scan.setAllSelection', selected: !!selected });
                        refreshSelectionUi();
                    }

                    // Wire the bulk controls via addEventListener rather than inline
                    // onclick/onchange: it is the VS Code-recommended pattern and keeps
                    // working if a Content-Security-Policy (which blocks inline handlers)
                    // is ever added to this webview.
                    (function wireSelectionControls() {
                        const selectAllBtn = document.getElementById('ll-select-all');
                        if (selectAllBtn) { selectAllBtn.addEventListener('click', function () { setAllFindings(true); }); }
                        const clearAllBtn = document.getElementById('ll-clear-all');
                        if (clearAllBtn) { clearAllBtn.addEventListener('click', function () { setAllFindings(false); }); }
                        const masterBox = document.getElementById('select-all-findings');
                        if (masterBox) { masterBox.addEventListener('change', function () { setAllFindings(masterBox.checked); }); }
                    })();

                    function filterScanFindings() {
                        const search = document.getElementById("finding-search");
                        const count = document.getElementById("finding-search-count");
                        const rows = Array.prototype.slice.call(document.querySelectorAll("#scan-findings-body tr[data-finding-index]"));
                        if (!search) { return; }
                        const query = search.value.trim().toLowerCase();
                        let shown = 0;
                        rows.forEach(function (row) {
                            const matches = !query || row.textContent.toLowerCase().includes(query);
                            row.hidden = !matches;
                            if (matches) { shown += 1; }
                        });
                        if (count) { count.textContent = shown + " of " + rows.length + " shown"; }
                    }

                    (function wireFindingSearch() {
                        const search = document.getElementById("finding-search");
                        if (search) { search.addEventListener("input", filterScanFindings); }
                    })();

                    let replacementDebounce = null;

                    function postReplacement(input) {
                        vscode.postMessage({
                            command: 'scan.setReplacement',
                            index: input.getAttribute('data-finding-index'),
                            value: input.value
                        });
                    }

                    document.addEventListener('change', function (event) {
                        const box = event.target.closest('.secret-checkbox');
                        if (box && !box.disabled) {
                            vscode.postMessage({
                                command: 'scan.setSelection',
                                index: box.getAttribute('data-finding-index'),
                                selected: box.checked
                            });
                            refreshSelectionUi();
                            return;
                        }
                        // A replacement input fires 'change' when it loses focus - e.g. the
                        // moment the user clicks Prepare. Flush the pending debounce and post
                        // the value now so Prepare never reads a stale replacement.
                        const input = event.target.closest('.replacement-input');
                        if (input && !input.disabled) {
                            clearTimeout(replacementDebounce);
                            postReplacement(input);
                        }
                    });

                    document.addEventListener('input', function (event) {
                        const input = event.target.closest('.replacement-input');
                        if (!input || input.disabled) {
                            return;
                        }
                        clearTimeout(replacementDebounce);
                        replacementDebounce = setTimeout(function () {
                            postReplacement(input);
                        }, 200);
                    });

                    // --- Manual redaction rules ---
                    // Delegated listeners, so rules added after this script ran are
                    // wired without re-binding, and no inline handlers are needed.
                    function submitCustomRule() {
                        const source = document.getElementById('custom-rule-source');
                        const mode = document.getElementById('custom-rule-mode');
                        const replacement = document.getElementById('custom-rule-replacement');
                        if (!source || !source.value.trim()) {
                            return;
                        }
                        vscode.postMessage({
                            command: 'scan.addCustomRule',
                            source: source.value,
                            mode: mode ? mode.value : 'literal',
                            replaceWith: replacement ? replacement.value : ''
                        });
                        source.value = '';
                        if (replacement) { replacement.value = ''; }
                    }

                    document.addEventListener('click', function (event) {
                        if (event.target.closest('#custom-rule-add')) {
                            submitCustomRule();
                            return;
                        }
                        const removeBtn = event.target.closest('[data-rule-remove]');
                        if (removeBtn) {
                            vscode.postMessage({
                                command: 'scan.removeCustomRule',
                                id: removeBtn.getAttribute('data-rule-remove')
                            });
                            return;
                        }
                        const previewBtn = event.target.closest('[data-rule-preview]');
                        if (previewBtn) {
                            vscode.postMessage({
                                command: 'scan.previewCustomRule',
                                id: previewBtn.getAttribute('data-rule-preview')
                            });
                        }
                    });

                    document.addEventListener('keydown', function (event) {
                        if (event.key !== 'Enter') {
                            return;
                        }
                        const field = event.target.closest('#custom-rule-source, #custom-rule-replacement');
                        if (field) {
                            event.preventDefault();
                            submitCustomRule();
                        }
                    });

                    document.addEventListener('DOMContentLoaded', refreshSelectionUi);
                    refreshSelectionUi();

                    function saveScanScript() {
                        vscode.postMessage({ command: 'scan.saveScript' });
                    }

                    function prepareBfgCommand() {
                        vscode.postMessage({
                            command: 'scan.prepareBfg',
                            replacements: collectReplacements()
                        });
                    }

                    function prepareGitCommand() {
                        vscode.postMessage({
                            command: 'scan.prepareGit',
                            replacements: collectReplacements()
                        });
                    }

                    function runPreparedBfg() {
                        vscode.postMessage({ command: 'scan.runBfg' });
                    }

                    function runPreparedGit() {
                        vscode.postMessage({ command: 'scan.runGit' });
                    }

                    function confirmForcePush() {
                        vscode.postMessage({ command: 'scan.confirmForcePush' });
                    }

                    function cancelForcePush() {
                        vscode.postMessage({ command: 'scan.cancelForcePush' });
                    }

                    function exportScanResultsJson() {
                        vscode.postMessage({ command: 'scan.exportJson' });
                    }

                    function printScanResults() {
                        vscode.postMessage({ command: 'scan.printPdf' });
                    }

                    function copyScanCommand(id) {
                        try {
                            const el = document.getElementById(id);
                            if (!el) return;
                            // textContent preserves the raw newlines; innerText returns the
                            // rendered text, which would collapse them and yield a script
                            // that is one unrunnable line.
                            const text = el.textContent || el.innerText || '';
                            if (navigator.clipboard && navigator.clipboard.writeText) {
                                navigator.clipboard.writeText(text);
                            } else {
                                const ta = document.createElement('textarea');
                                ta.value = text;
                                document.body.appendChild(ta);
                                ta.select();
                                document.execCommand('copy');
                                document.body.removeChild(ta);
                            }
                        } catch (e) {}
                    }
                    
                    function openFile(file, line) {
                        vscode.postMessage({ 
                            command: 'openFile', 
                            file: file, 
                            line: line 
                        });
                    }
                    
                    function requestNewScan() {
                        vscode.postMessage({
                            command: 'requestNewScan'
                        });
                    }
                    
                    function openSecurityGuide() {
                        vscode.postMessage({
                            command: 'openSecurityGuide'
                        });
                    }
                    function refetchNow() {
                        vscode.postMessage({ command: 'removeFiles.refetch' });
                    }
                    
                    // --- Reusable detail dialog ---
                    function showDetailDialog(title, content) {
                        const overlay = document.getElementById('detail-dialog-overlay');
                        const titleEl = document.getElementById('detail-dialog-title');
                        const bodyEl = document.getElementById('detail-dialog-body');
                        titleEl.textContent = title;
                        bodyEl.textContent = content;
                        overlay.classList.add('visible');
                    }

                    function hideDetailDialog() {
                        const overlay = document.getElementById('detail-dialog-overlay');
                        overlay.classList.remove('visible');
                    }

                    function fallbackCopyToClipboard(textToCopy) {
                        const ta = document.createElement('textarea');
                        ta.value = textToCopy;
                        document.body.appendChild(ta);
                        ta.select();
                        try {
                            document.execCommand('copy');
                        } catch (e) {
                            console.error('Fallback copy to clipboard failed:', e);
                        } finally {
                            document.body.removeChild(ta);
                        }
                    }

                    function copyDetailDialogContent() {
                        const bodyEl = document.getElementById('detail-dialog-body');
                        const text = bodyEl.textContent || '';
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                            navigator.clipboard.writeText(text).then(() => {
                                const btn = document.getElementById('detail-dialog-copy-btn');
                                const orig = btn.textContent;
                                btn.textContent = 'Copied!';
                                setTimeout(() => { btn.textContent = orig; }, 1500);
                            }).catch(() => {
                                fallbackCopyToClipboard(text);
                            });
                        } else {
                            fallbackCopyToClipboard(text);
                        }
                    }

                    // Safe event delegation for file links and branch links
                    document.addEventListener('click', function(event) {
                        if (event.target.closest('.file-link.clickable')) {
                            const link = event.target.closest('.file-link');
                            const file = link.getAttribute('data-file');
                            const line = parseInt(link.getAttribute('data-line'));

                            if (file && line) {
                                openFile(file, line);
                            }
                        }

                        // Branch detail click
                        if (event.target.closest('.branch-link')) {
                            const el = event.target.closest('.branch-link');
                            const idx = el.getAttribute('data-branch-idx');
                            if (idx !== null && window.__branchData && window.__branchData[idx]) {
                                const branches = window.__branchData[idx];
                                showDetailDialog('Branches and tags containing this commit', branches.join('\\n'));
                            }
                        }

                        // Close dialog on overlay click (outside dialog box)
                        if (event.target.id === 'detail-dialog-overlay') {
                            hideDetailDialog();
                        }
                    });

                    // Close dialog on Escape
                    document.addEventListener("keydown", function(event) {
                        const search = document.getElementById("finding-search");
                        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f" && search) {
                            event.preventDefault();
                            search.focus();
                            search.select();
                            return;
                        }
                        if (event.key === "Escape") {
                            if (search && document.activeElement === search && search.value) {
                                search.value = "";
                                filterScanFindings();
                                event.preventDefault();
                                return;
                            }
                            hideDetailDialog();
                        }
                    });
                </script>

                <div id="detail-dialog-overlay" class="detail-dialog-overlay">
                    <div class="detail-dialog">
                        <div class="detail-dialog-header">
                            <h3 id="detail-dialog-title"></h3>
                            <button class="detail-dialog-close" onclick="hideDetailDialog()" title="Close">&times;</button>
                        </div>
                        <div id="detail-dialog-body" class="detail-dialog-body"></div>
                        <div class="detail-dialog-actions">
                            <button id="detail-dialog-copy-btn" class="detail-dialog-copy" onclick="copyDetailDialogContent()">Copy</button>
                            <button class="detail-dialog-dismiss" onclick="hideDetailDialog()">Close</button>
                        </div>
                    </div>
                </div>
            </body>
            </html>
        `;
    }

    // Public: switch to Remove Files UI
    showRemoveFilesUI(directory) {
        this._viewMode = 'removeFiles';
        // Prefer directory provided by sidebar selection
        if (directory) {
            try {
                const validated = validatePath(directory);
                this._removalState.repoDir = validated;
            } catch { }
        }
        // Fallback: workspace repo if available
        if (!this._removalState.repoDir) {
            try {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (workspaceFolder) {
                    const candidate = workspaceFolder.uri.fsPath;
                    if (fs.existsSync(path.join(candidate, '.git'))) {
                        this._removalState.repoDir = candidate;
                    }
                }
            } catch { }
        }
        this._updateWebviewContent();
    }

    // Public: switch to Scan UI
    showScanUI() {
        this._viewMode = 'scan';
        this._updateWebviewContent();
    }

    _getRemoveFilesHtml() {
        const repoDir = this._removalState.repoDir ? escapeHtml(this._removalState.repoDir) : 'No repository selected';
        const targets = this._removalState.targets;
        const hasTargets = targets.length > 0;
        const prepared = this._removalState.preparedCommand;
        const lastFetchISO = this._getLastFetchAt(this._removalState.repoDir) || this._removalState.lastFetchAt;
        const isStale = this._isFetchStale(lastFetchISO);
        const fetchColor = isStale ? 'var(--vscode-inputValidation-warningForeground)' : 'var(--vscode-descriptionForeground)';
        const fetchNote = isStale ? ' (stale)' : '';
        const fetchTooltip = isStale
            ? 'Remote refs may be outdated (older than 15 minutes). Fetch to ensure preview and deletions include latest branches and tags.'
            : 'Remotes fetched recently; preview reflects current branches and tags.';

        const targetsList = hasTargets ? `
            <ul style="margin: 8px 0 0 0; padding-left: 18px;">
                ${targets.map(t => `<li style="margin: 4px 0;">
                    <code>${escapeHtml(t.path)}</code>
                    <span style=\"background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 0 6px; border-radius: 10px; font-size: 0.8em;\">${t.type}</span>
                    <button class="button" style="margin-left: 8px; padding: 2px 8px;" onclick="removeTarget('${escapeHtml(t.path)}')">Remove</button>
                </li>`).join('')}
            </ul>
        ` : '<div style="color: var(--vscode-descriptionForeground);">No files or directories selected.</div>';

        const preparedBlockBfg = prepared && this._removalState.preparedMode === 'bfg' ? `
            <div id="prepared-command" class="manual-command" style="margin-top: 8px;">${escapeHtml(prepared)}</div>
            <div style="margin-top:6px;"><button class="button" onclick="copyPrepared()">📋 Copy command</button></div>
        ` : '';
        const preparedBlockGit = prepared && this._removalState.preparedMode === 'git' ? `
            <div id="prepared-command-git" class="manual-command" style="margin-top: 8px;">${escapeHtml(prepared)}</div>
            <div style="margin-top:6px;"><button class="button" onclick="copyPrepared()">📋 Copy command</button></div>
        ` : '';

        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Leak Lock - Remove Files</title>
                <style>
                    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background-color: var(--vscode-editor-background); padding: 20px; margin: 0; }
                    .section { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 16px; margin-bottom: 16px; }
                    .h1 { font-size: 1.3em; margin: 0 0 10px 0; }
                    .button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 14px; border-radius: 4px; cursor: pointer; }
                    .button:hover { background: var(--vscode-button-hoverBackground); }
                    .hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
                    .manual-command { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px; font-family: monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
                    .danger { color: var(--vscode-errorForeground); font-weight: bold; }
                    .danger-section { border: 1px solid var(--vscode-inputValidation-errorBorder); background: var(--vscode-inputValidation-errorBackground); padding: 12px; border-radius: 6px; }
                    .danger-button { background: #c62828; color: #fff; border: none; padding: 10px 16px; border-radius: 4px; font-weight: bold; cursor: pointer; }
                    .danger-button:hover { background: #b71c1c; }
                    .optional-frame { border: 1px dashed var(--vscode-panel-border); border-radius: 6px; padding: 12px; background: var(--vscode-editor-background); }
                    .button-margin-y { margin: 8px 0; }
                    .button-margin-top { margin-top: 8px; }
                    .preview-section { margin-top: 8px; }
                    .preview-header { font-size: 1.1em; }
                    .preview-subheader { font-size: 1.1em; margin-top: 10px; }
                    .branch-block { margin: 6px 0; }
                    .branch-files { margin: 4px 0 0 0; padding-left: 18px; }
                    .final-step-section { margin-top: 12px; }
                    .final-step-hint { margin-bottom: 8px; }
                </style>
            </head>
            <body>
                <div class="section">
                    <div class="h1">🗑️ Remove Unwanted Files</div>
                    <div class="hint">Remove unwanted files from git repository</div>
                </div>

                <div class="section">
                    <div class="h1">Repository</div>
                    <div class="hint" style="margin-bottom: 8px;">Using the directory selected in the sidebar.</div>
                    <div style="font-family: monospace; background: var(--vscode-textCodeBlock-background); padding: 6px; border-radius: 4px;">${repoDir}</div>
                    <div style="margin-top: 6px; font-size: 0.9em; color: ${fetchColor}; display:flex; align-items:center; gap:8px;">
                        <span title="${escapeHtml(fetchTooltip)}">Refs status: Last fetched ${this._removalState.lastFetchAt ? escapeHtml(new Date(this._removalState.lastFetchAt).toLocaleString()) : 'never'}${fetchNote}</span>
                        <button class="button" style="padding:4px 8px;" onclick="refetchNow()" ${!this._removalState.repoDir ? 'disabled' : ''}>⟳ Refetch now</button>
                    </div>
                    ${!this._removalState.repoDir ? `<div class="hint" style="margin-top:8px; color: var(--vscode-inputValidation-warningForeground);">Select a repository in the sidebar Control Panel.</div>` : ''}
                </div>

                <div class="section">
                    <div class="h1">Select Files or Directories</div>
                    <div class="hint">Select one or more files or directories within the repository.</div>
                    ${targetsList}
                    <div style="margin-top: 8px; display:flex; gap:8px; flex-wrap:wrap;">
                        <button class="button" onclick="selectTargets('both')">➕ Select files/directories</button>
                        <button class="button" onclick="selectTargets('files')">📄 Select files</button>
                        <button class="button" onclick="selectTargets('folders')">📁 Select directories</button>
                        <button class="button" onclick="clearTargets()" ${hasTargets ? '' : 'disabled'}>🧹 Clear selections</button>
                    </div>
                </div>

                <div class="section">
                    <div class="h1">BFG-based removal (recommended)</div>
                    <div class="hint">Choose how to group deletions, then generate the command.</div>
                    <div class="hint" style="margin-top: 6px; color: var(--vscode-inputValidation-warningForeground);">
                        BFG removes by name across the entire history. Any file with the same name anywhere in the repo will be deleted.
                    </div>
                    <div style="margin: 8px 0; display: flex; gap: 16px; align-items: center;">
                        <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                            <input type="radio" name="combineMode" value="combined" ${this._removalState.combineMode === 'combined' ? 'checked' : ''} onchange="setCombineMode('combined')"> Single combined command
                        </label>
                        <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                            <input type="radio" name="combineMode" value="individual" ${this._removalState.combineMode === 'individual' ? 'checked' : ''} onchange="setCombineMode('individual')"> One command per item
                        </label>
                    </div>
                    <div style="margin-top: 8px;"><button class="button" onclick="prepareCommand()" ${!hasTargets || !this._removalState.repoDir ? 'disabled' : ''}>⚙️ Prepare the bfg command</button></div>
                    ${preparedBlockBfg}
                    ${prepared && this._removalState.preparedMode === 'bfg' ? `
                        <div style=\"margin-top:12px;\">
                            <div class=\"h1\" style=\"font-size:1.1em;\">Deletion details</div>
                            <div class=\"hint\">BFG matches by name across history. Each target below shows the flag and pattern used.</div>
                            <ul style=\"margin:8px 0 0 0; padding-left:18px;\">
                                ${this._removalState.details.map(d => `<li><code>${escapeHtml(d.display)}</code> → <span style=\\\"background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 0 6px; border-radius: 10px; font-size: 0.8em;\\\">${d.flag}</span> <code>${escapeHtml(d.pattern)}</code></li>`).join('')}
                            </ul>
                        </div>
                    ` : ''}
                    <div class="danger-section" style="margin-top: 12px;">
                        <div class="h1 danger">Final Step: Rewrite Git History (BFG)</div>
                        <div class="hint" style="margin-bottom: 8px;">This will permanently rewrite git history using BFG.</div>
                        <button class="danger-button" onclick="runRemoval()" ${!prepared || this._removalState.preparedMode !== 'bfg' ? 'disabled' : ''}>❗ Confirm and run BFG removal</button>
                    </div>
                </div>

                <div class="section">
                    <div class="optional-frame">
                        <div class="h1">Optional: Path-based deletion (Git)</div>
                        <div class="hint">Alternative to BFG; uses exact repo paths across branches, remotes, and tags. Preview before running.</div>
                        <div class="button-margin-y"><button class="button" onclick="previewMatches()" ${!hasTargets || !this._removalState.repoDir ? 'disabled' : ''}>🔎 Preview matches (branches, remotes, tags)</button></div>
                        ${this._removalState.preview ? `
                            <div class="preview-section">
                                <div class="h1 preview-header">Local branches</div>
                                ${this._removalState.preview.branches.length === 0 ? '<div class=\\\'hint\\\'>No matches on local branches.</div>' : ''}
                                ${this._removalState.preview.branches.map(b => `<div class=\\\"branch-block\\\"><strong>${escapeHtml(b.name)}</strong><br>${b.files.length ? '<ul class=\\\"branch-files\\\">' + b.files.map(f => '<li><code>' + escapeHtml(f) + '</code></li>').join('') + '</ul>' : '<span class=\\\"hint\\\">No matches</span>'}</div>`).join('')}
                                <div class="h1 preview-subheader">Remote branches</div>
                                ${this._removalState.preview.remotes.length === 0 ? '<div class=\\\'hint\\\'>No matches on remote branches.</div>' : ''}
                                ${this._removalState.preview.remotes.map(b => `<div class=\\\"branch-block\\\"><strong>${escapeHtml(b.name)}</strong><br>${b.files.length ? '<ul class=\\\"branch-files\\\">' + b.files.map(f => '<li><code>' + escapeHtml(f) + '</code></li>').join('') + '</ul>' : '<span class=\\\"hint\\\">No matches</span>'}</div>`).join('')}
                                <div class="h1 preview-subheader">Tags</div>
                                ${this._removalState.preview.tags.length === 0 ? '<div class=\\\'hint\\\'>No matches on tags.</div>' : ''}
                                ${this._removalState.preview.tags.map(b => `<div class=\\\"branch-block\\\"><strong>${escapeHtml(b.name)}</strong><br>${b.files.length ? '<ul class=\\\"branch-files\\\">' + b.files.map(f => '<li><code>' + escapeHtml(f) + '</code></li>').join('') + '</ul>' : '<span class=\\\"hint\\\">No matches</span>'}</div>`).join('')}
                            </div>
                        ` : ''}
                        <div class="button-margin-top"><button class="button" onclick="prepareGit()" ${!hasTargets || !this._removalState.repoDir ? 'disabled' : ''}>⚙️ Prepare the git command</button></div>
                        ${preparedBlockGit}
                        <div class="danger-section final-step-section">
                            <div class="h1 danger">Final Step: Rewrite Git History (Git)</div>
                            <div class="hint final-step-hint">This will permanently rewrite git history using git filter-branch on exact paths across branches.</div>
                            <button class="danger-button" onclick="runPathRemoval()" ${!prepared || this._removalState.preparedMode !== 'git' ? 'disabled' : ''}>❗ Confirm and run path-based removal</button>
                        </div>
                    </div>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    // Repo selection is managed from the sidebar; no selection here
                    function selectTargets(kind) { vscode.postMessage({ command: 'removeFiles.selectTargets', kind }); }
                    function removeTarget(path) { vscode.postMessage({ command: 'removeFiles.removeTarget', path }); }
                    function clearTargets() { vscode.postMessage({ command: 'removeFiles.clearTargets' }); }
                    function prepareCommand() { vscode.postMessage({ command: 'removeFiles.prepare' }); }
                    function setCombineMode(mode) { vscode.postMessage({ command: 'removeFiles.setCombineMode', mode }); }
                    function previewMatches() { vscode.postMessage({ command: 'removeFiles.preview' }); }
                    function prepareGit() { vscode.postMessage({ command: 'removeFiles.prepareGit' }); }
                    function refetchNow() { vscode.postMessage({ command: 'removeFiles.refetch' }); }
                    function runRemoval() { vscode.postMessage({ command: 'removeFiles.run' }); }
                    function runPathRemoval() { vscode.postMessage({ command: 'removeFiles.runGit' }); }
                    function copyPrepared() {
                        try {
                            const el = document.getElementById('prepared-command') || document.getElementById('prepared-command-git');
                            if (!el) return;
                            // textContent keeps the raw newlines (innerText collapses them).
                            const text = el.textContent || el.innerText || '';
                            if (navigator.clipboard && navigator.clipboard.writeText) {
                                navigator.clipboard.writeText(text);
                            } else {
                                const ta = document.createElement('textarea');
                                ta.value = text;
                                document.body.appendChild(ta);
                                ta.select();
                                document.execCommand('copy');
                                document.body.removeChild(ta);
                            }
                        } catch (e) {}
                    }
                </script>
            </body>
            </html>
        `;
    }

    async _selectRepoForRemoval() {
        const options = {
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Select Git Repository Root',
            defaultUri: this._removalState.repoDir ? vscode.Uri.file(this._removalState.repoDir) : undefined
        };
        const result = await vscode.window.showOpenDialog(options);
        if (result && result[0]) {
            const repoPath = result[0].fsPath;
            try {
                const validated = validatePath(repoPath);
                if (!fs.existsSync(path.join(validated, '.git'))) {
                    vscode.window.showWarningMessage('Selected folder does not contain a .git directory.');
                }
                this._removalState.repoDir = validated;
                this._removalState.preparedCommand = null;
                this._removalState.preparedIndexFilter = null;
            } catch (e) {
                vscode.window.showErrorMessage(`Invalid repository path: ${e.message}`);
            }
            this._updateWebviewContent();
        }
    }

    async _selectTargetsForRemoval(kind = 'both') {
        if (!this._removalState.repoDir) {
            vscode.window.showErrorMessage('Please select a repository first.');
            return;
        }
        const normalized = typeof kind === 'string' ? kind : 'both';
        const canSelectFiles = normalized !== 'folders';
        const canSelectFolders = normalized !== 'files';
        const label = normalized === 'files'
            ? 'Select files to remove'
            : normalized === 'folders'
                ? 'Select directories to remove'
                : 'Select files and/or directories to remove';
        const options = {
            canSelectFolders,
            canSelectFiles,
            canSelectMany: true,
            openLabel: label,
            defaultUri: this._removalState.repoDir ? vscode.Uri.file(this._removalState.repoDir) : undefined
        };
        const result = await vscode.window.showOpenDialog(options);
        if (result && result.length > 0) {
            const repo = this._removalState.repoDir;
            const newTargets = [];
            for (const uri of result) {
                try {
                    const abs = validatePath(uri.fsPath);
                    const rel = path.relative(repo, abs);
                    if (rel.startsWith('..') || path.isAbsolute(rel)) {
                        vscode.window.showWarningMessage(`Skipping selection outside repository: ${abs}`);
                        continue;
                    }
                    const stat = fs.statSync(abs);
                    const type = stat.isDirectory() ? 'directory' : 'file';
                    newTargets.push({ path: rel.replace(/\\/g, '/'), type, base: path.basename(abs) });
                } catch (e) {
                    vscode.window.showWarningMessage(`Skipping invalid selection: ${uri.fsPath} (${e.message})`);
                }
            }
            const existing = new Map(this._removalState.targets.map(t => [t.path, t]));
            for (const t of newTargets) existing.set(t.path, t);
            this._removalState.targets = Array.from(existing.values());
            this._removalState.preparedCommand = null;
            this._removalState.preparedIndexFilter = null;
            this._updateWebviewContent();
        }
    }

    _removeTargetForRemoval(targetPath) {
        if (!targetPath) {
            return;
        }
        const beforeCount = this._removalState.targets.length;
        this._removalState.targets = this._removalState.targets.filter(t => t.path !== targetPath);
        if (this._removalState.targets.length !== beforeCount) {
            this._removalState.preparedCommand = null;
            this._removalState.preparedIndexFilter = null;
            this._removalState.preparedMode = null;
            this._removalState.details = [];
            this._updateWebviewContent();
        }
    }

    _clearTargetsForRemoval() {
        if (this._removalState.targets.length === 0) {
            return;
        }
        this._removalState.targets = [];
        this._removalState.preparedCommand = null;
        this._removalState.preparedIndexFilter = null;
        this._removalState.preparedMode = null;
        this._removalState.details = [];
        this._updateWebviewContent();
    }

    _escapeRegex(str) {
        // Escape all regex metacharacters so file/dir names are treated literally in BFG's Java-regex
        // patterns. This is security-sensitive: these names may come from user-controlled repository
        // content and are interpolated into a shell command. Escaping . * + ? ^ $ { } ( ) | [ ] and \
        // prevents an attacker from smuggling in regex operators that change which paths BFG deletes
        // or that break the surrounding command syntax.
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    _isFetchStale(lastFetchISO) {
        // Check if the last fetch timestamp is older than 15 minutes
        if (!lastFetchISO) {
            return true;
        }
        try {
            const last = new Date(lastFetchISO).getTime();
            return (Date.now() - last) > (15 * 60 * 1000);
        } catch {
            return true;
        }
    }

    /** BFG arguments for the selected targets, shared by script and execution. */
    _buildBfgArgs(targets) {
        const fileNames = targets.filter(t => t.type === 'file').map(t => t.base);
        const dirNames = targets.filter(t => t.type === 'directory').map(t => t.base);

        const args = [];
        if (fileNames.length > 0) {
            args.push('--delete-files', fileNames.map(n => this._escapeRegex(n)).join('|'));
        }
        if (dirNames.length > 0) {
            args.push('--delete-folders', dirNames.map(n => this._escapeRegex(n)).join('|'));
        }
        return args;
    }

    /** grep -E pattern matching any selected target basename, for verification. */
    /**
     * grep -E pattern for verifying a removal against `git ls-tree` output.
     * @param {object} [options]
     * @param {boolean} [options.exact] Match the full repo-relative path, anchored
     *   at the start. Use for Git path-based removal, which targets exact paths —
     *   otherwise removing `configs/secret.txt` would false-fail because
     *   `docs/secret.txt` shares the basename. BFG deletes by name, so it matches
     *   the basename anywhere (the default).
     */
    _buildTargetVerifyRegex(targets, options = {}) {
        const exact = !!options.exact;
        const parts = targets
            .map(t => this._escapeRegex(exact ? t.path : t.base))
            .filter(Boolean);
        if (parts.length === 0) {
            return null;
        }
        return exact
            ? `^(${parts.join('|')})(/|$)`
            : `(^|/)(${parts.join('|')})(/|$)`;
    }

    _buildBfgCommand(repoDir, targets) {
        const bfgPath = path.join(this._extensionUri.fsPath, 'bfg.jar');
        const args = this._buildBfgArgs(targets).map(a => gitRewrite.shellQuote(a)).join(' ');
        return gitRewrite.buildRewriteScript({
            repoDir,
            rewriteLines: [
                `java -jar ${gitRewrite.shellQuote(bfgPath)} ${args} ${gitRewrite.shellQuote(repoDir)}`
            ],
            verifyRegex: this._buildTargetVerifyRegex(targets)
        });
    }

    async _prepareBfgRemovalCommand() {
        const repo = this._removalState.repoDir;
        const targets = this._removalState.targets;
        if (!repo || !targets || targets.length === 0) {
            vscode.window.showErrorMessage('Select a repository and at least one file or directory.');
            return;
        }
        try {
            const validatedRepo = validatePath(repo);
            this._removalState.preparing = true;
            this._removalState.blockedBranches = null;
            this._removalState.blockedReason = null;
            this._removalState.verifyResult = null;
            this._updateWebviewContent();

            const preflight = await this._rewritePreflight(validatedRepo);
            if (preflight.blocked) {
                this._removalState.blockedBranches = preflight.ahead;
                this._removalState.blockedReason = preflight.reason;
                this._removalState.preparedCommand = null;
                this._removalState.preparedMode = null;
                return;
            }
            this._removalState.blockedReason = null;
            this._removalState.pushPlan = preflight.pushPlan;

            const mode = this._removalState.combineMode;
            let cmd;
            if (mode === 'combined') {
                cmd = this._buildBfgCommand(validatedRepo, targets);
            } else {
                cmd = this._buildIndividualBfgCommands(validatedRepo, targets);
            }
            // Build details for granular feedback
            this._removalState.details = targets.map(t => ({
                display: t.path,
                flag: t.type === 'directory' ? '--delete-folders' : '--delete-files',
                pattern: t.base
            }));
            this._removalState.preparedCommand = cmd;
            this._removalState.preparedMode = 'bfg';
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to prepare command: ${e.message}`);
        } finally {
            this._removalState.preparing = false;
            this._updateWebviewContent();
        }
    }

    _setCombineMode(mode) {
        if (mode !== 'combined' && mode !== 'individual') return;
        this._removalState.combineMode = mode;
        // Invalidate prepared command to force regeneration with new mode
        this._removalState.preparedCommand = null;
        this._removalState.preparedIndexFilter = null;
        this._removalState.preparedMode = null;
        this._updateWebviewContent();
    }

    _shellEscapeDoubleQuotes(s) {
        return String(s).replace(/"/g, '\\"');
    }

    _buildIndividualBfgCommands(repoDir, targets) {
        const bfgPath = path.join(this._extensionUri.fsPath, 'bfg.jar');
        const rewriteLines = targets.map(t => {
            const flag = t.type === 'directory' ? '--delete-folders' : '--delete-files';
            // BFG treats the argument as a pattern - escape metacharacters so a
            // name like `[old].env` matches literally, exactly as combined mode does.
            const pattern = gitRewrite.shellQuote(this._escapeRegex(t.base));
            return `java -jar ${gitRewrite.shellQuote(bfgPath)} ${flag} ${pattern} ${gitRewrite.shellQuote(repoDir)}`;
        });
        return gitRewrite.buildRewriteScript({
            repoDir,
            rewriteLines,
            verifyRegex: this._buildTargetVerifyRegex(targets)
        });
    }

    _setDeletionMode(mode) {
        if (mode !== 'bfg' && mode !== 'git') return;
        this._removalState.deletionMode = mode;
        // Clear previous prepared command/preview when switching
        this._removalState.preparedCommand = null;
        this._removalState.preparedIndexFilter = null;
        this._removalState.preparedMode = null;
        this._updateWebviewContent();
    }

    async _gitFetchAll(repoPath) {
        try {
            await new Promise((resolve, reject) => {
                const child = spawn('git', ['fetch', '--all', '--tags', '--prune'], {
                    cwd: repoPath
                });
                child.on('error', (err) => {
                    reject(err);
                });
                child.on('close', (code) => {
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`git fetch exited with code ${code}`));
                    }
                });
            });
            const ts = new Date().toISOString();
            this._removalState.lastFetchAt = ts;
            this._recordFetchAt(repoPath, ts);
            this._updateWebviewContent();
        } catch (e) {
            console.warn('git fetch failed or no remotes:', e.message);
        }
    }


    async _previewMatchesAcrossBranches() {
        const repo = this._removalState.repoDir;
        const targets = this._removalState.targets;
        if (!repo || !targets || targets.length === 0) {
            vscode.window.showErrorMessage('Select a repository and at least one file or directory.');
            return;
        }
        try {
            const util = require('util');
            const execFileAsync = util.promisify(execFile);
            // List refs
            const { stdout: brOut } = await execFileAsync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: repo });
            const { stdout: rmOut } = await execFileAsync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], { cwd: repo });
            const { stdout: tgOut } = await execFileAsync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/tags'], { cwd: repo });
            const branches = brOut.split('\n').map(s => s.trim()).filter(Boolean);
            const remotes = rmOut.split('\n').map(s => s.trim()).filter(Boolean).filter(n => !REMOTE_HEAD_FILTER_PATTERN.test(n));
            const tags = tgOut.split('\n').map(s => s.trim()).filter(Boolean);
            const pathspecs = targets.map(t => t.type === 'directory' ? `${t.path}/` : t.path);
            const results = [];
            for (const br of branches) {
                try {
                    const { stdout } = await execFileAsync('git', ['ls-tree', '-r', '--name-only', br, '--', ...pathspecs], { cwd: repo });
                    const files = stdout.split('\n').map(s => s.trim()).filter(Boolean);
                    results.push({ name: br, files });
                } catch (e) {
                    results.push({ name: br, files: [] });
                }
            }
            const remoteResults = [];
            for (const rb of remotes) {
                try {
                    const { stdout } = await execFileAsync('git', ['ls-tree', '-r', '--name-only', rb, '--', ...pathspecs], { cwd: repo });
                    const files = stdout.split('\n').map(s => s.trim()).filter(Boolean);
                    remoteResults.push({ name: rb, files });
                } catch (e) {
                    remoteResults.push({ name: rb, files: [] });
                }
            }
            const tagResults = [];
            for (const tag of tags) {
                try {
                    const { stdout } = await execFileAsync('git', ['ls-tree', '-r', '--name-only', `${tag}^{}`, '--', ...pathspecs], { cwd: repo });
                    const files = stdout.split('\n').map(s => s.trim()).filter(Boolean);
                    tagResults.push({ name: tag, files });
                } catch (e) {
                    tagResults.push({ name: tag, files: [] });
                }
            }
            this._removalState.preview = { branches: results, remotes: remoteResults, tags: tagResults };
            this._updateWebviewContent();
        } catch (e) {
            vscode.window.showErrorMessage(`Preview failed: ${e.message}`);
        }
    }

    async _manualRefetch() {
        // Fetch the repo the CURRENT view is about, so its "Refs status" updates.
        let repo = this._viewMode === 'removeFiles'
            ? (this._removalState.repoDir || this._selectedDirectory)
            : this._scanCleanupRepo();
        if (!repo && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            repo = vscode.workspace.workspaceFolders[0].uri.fsPath;
        }
        if (!repo) {
            vscode.window.showErrorMessage('Select a repository or open a workspace first.');
            return;
        }
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Fetching remotes...',
                cancellable: false
            }, async () => {
                await this._gitFetchAll(repo);
            });
            vscode.window.showInformationMessage('Fetch complete.');
        } catch (e) {
            vscode.window.showWarningMessage(`Fetch encountered issues: ${e.message}`);
        }
    }

    _buildGitFilterBranchIndexFilter(targets) {
        // Build the index filter script for git filter-branch
        // Note: git filter-branch's --index-filter inherently requires a shell script string
        // This is a limitation of the git filter-branch command itself
        // All paths are validated via validatePath() and escaped via _shellEscapeDoubleQuotes()
        // before being included in this filter
        const rmCmds = targets.map(t => {
            const p = this._shellEscapeDoubleQuotes(t.path);
            return `git rm -r --cached --ignore-unmatch \"${p}\"`;
        }).join('; ');
        return rmCmds.length ? rmCmds : 'echo no-op';
    }

    _buildGitFilterBranchCommandForDisplay(repoDir, indexFilter, targets = []) {
        // Display/copy version of the command. Execution goes through
        // gitRewrite.runRewrite(), which follows the exact same sequence.
        return gitRewrite.buildRewriteScript({
            repoDir,
            rewriteLines: [
                `git filter-branch --force --index-filter ${gitRewrite.shellQuote(indexFilter)} \\`,
                '\t--prune-empty --tag-name-filter cat -- --all'
            ],
            // Git path-based removal targets exact paths — verify exact paths too.
            verifyRegex: this._buildTargetVerifyRegex(targets, { exact: true })
        });
    }

    async _prepareGitRemovalCommand() {
        const repo = this._removalState.repoDir;
        const targets = this._removalState.targets;
        if (!repo || !targets || targets.length === 0) {
            vscode.window.showErrorMessage('Select a repository and at least one file or directory.');
            return;
        }
        try {
            const validatedRepo = validatePath(repo);
            this._removalState.preparing = true;
            this._removalState.blockedBranches = null;
            this._removalState.blockedReason = null;
            this._removalState.verifyResult = null;
            this._updateWebviewContent();

            const preflight = await this._rewritePreflight(validatedRepo);
            if (preflight.blocked) {
                this._removalState.blockedBranches = preflight.ahead;
                this._removalState.blockedReason = preflight.reason;
                this._removalState.preparedCommand = null;
                this._removalState.preparedMode = null;
                return;
            }
            this._removalState.blockedReason = null;
            this._removalState.pushPlan = preflight.pushPlan;

            // Store the index filter and repo path for execution
            const indexFilter = this._buildGitFilterBranchIndexFilter(targets);
            this._removalState.preparedIndexFilter = indexFilter;
            this._removalState.repoDir = validatedRepo;
            // Build display-only command for UI
            const displayCmd = this._buildGitFilterBranchCommandForDisplay(validatedRepo, indexFilter, targets);
            this._removalState.preparedCommand = displayCmd;
            this._removalState.preparedMode = 'git';
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to prepare git command: ${e.message}`);
        } finally {
            this._removalState.preparing = false;
            this._updateWebviewContent();
        }
    }

    async _runGitRemoval() {
        const repo = this._removalState.repoDir;
        const indexFilter = this._removalState.preparedIndexFilter;
        if (!repo || !indexFilter || this._removalState.preparedMode !== 'git') {
            vscode.window.showErrorMessage('Prepare the git command first.');
            return;
        }
        const proceed = await vscode.window.showWarningMessage(
            '⚠️ This will permanently rewrite git history using filter-branch to remove the selected paths across all branches. Ensure you have a backup.',
            { modal: true },
            'Proceed',
            'Cancel'
        );
        if (proceed !== 'Proceed') return;

        const util = require('util');
        const execFileAsync = util.promisify(execFile);
        let report = null;
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Running path-based removal (git filter-branch)...',
                cancellable: false,
            }, async (progress) => {
                report = await gitRewrite.runRewrite({
                    repoDir: repo,
                    progress: (message) => progress.report({ increment: 10, message }),
                    // Path-based removal targets exact paths, so verify exact paths.
                    verify: { pathPattern: this._buildTargetVerifyRegex(this._removalState.targets, { exact: true }) },
                    rewrite: async () => {
                        // --index-filter expects a shell script string, but all paths are
                        // escaped via _shellEscapeDoubleQuotes() in _buildGitFilterBranchIndexFilter()
                        await execFileAsync('git', [
                            'filter-branch',
                            '--force',
                            '--index-filter',
                            indexFilter,
                            '--prune-empty',
                            '--tag-name-filter',
                            'cat',
                            '--',
                            '--all'
                        ], { cwd: repo, maxBuffer: GIT_MAX_BUFFER });
                    }
                });
            });
            this._removalState.verifyResult = report ? report.offenders : null;
            this._reportRewriteOutcome('Path-based removal', report);
        } catch (e) {
            if (e instanceof gitRewrite.AheadBranchesError) {
                this._removalState.blockedBranches = e.branches;
            }
            vscode.window.showErrorMessage(`Path-based removal failed: ${e.message}`);
        } finally {
            this._updateWebviewContent();
        }
    }

    async _runBfgRemoval() {
        const repo = this._removalState.repoDir;
        const cmd = this._removalState.preparedCommand;
        if (!repo || !cmd) {
            vscode.window.showErrorMessage('Nothing to run. Prepare the command first.');
            return;
        }

        const proceed = await vscode.window.showWarningMessage(
            '⚠️ This will permanently rewrite git history to remove the selected files/directories. Ensure you have a backup.',
            { modal: true },
            'Proceed',
            'Cancel'
        );
        if (proceed !== 'Proceed') return;

        this._removalState.running = true;
        this._updateWebviewContent();

        const util = require('util');
        const execFileAsync = util.promisify(execFile);
        const bfgPath = path.join(this._extensionUri.fsPath, 'bfg.jar');
        const targets = this._removalState.targets;
        let report = null;
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Running BFG to remove files...',
                cancellable: false,
            }, async (progress) => {
                report = await gitRewrite.runRewrite({
                    repoDir: repo,
                    progress: (message) => progress.report({ increment: 10, message }),
                    verify: { pathPattern: this._buildTargetVerifyRegex(targets) },
                    rewrite: async () => {
                        const runs = this._removalState.combineMode === 'individual'
                            ? targets.map(t => [
                                t.type === 'directory' ? '--delete-folders' : '--delete-files',
                                // BFG reads this as a pattern; escape so the literal
                                // name is matched, matching combined mode's behavior.
                                this._escapeRegex(t.base)
                            ])
                            : [this._buildBfgArgs(targets)];
                        for (const args of runs) {
                            await execFileAsync(
                                'java',
                                ['-jar', bfgPath, ...args, repo],
                                { cwd: repo, maxBuffer: GIT_MAX_BUFFER }
                            );
                        }
                    }
                });
            });

            this._removalState.verifyResult = report ? report.offenders : null;
            this._reportRewriteOutcome('Removal', report);
        } catch (e) {
            if (e instanceof gitRewrite.AheadBranchesError) {
                this._removalState.blockedBranches = e.branches;
            }
            vscode.window.showErrorMessage(`Removal failed: ${e.message}`);
        } finally {
            this._removalState.running = false;
            this._updateWebviewContent();
        }
    }

    // Method to start scan from sidebar
    startScanFromSidebar(directory, dependenciesReady) {
        if (directory) {
            this._selectedDirectory = directory;
        }
        this._dependenciesInstalled = dependenciesReady;

        // Update UI and start scan
        this.showScanUI();

        // Start the scan if both directory and dependencies are ready
        if (this._selectedDirectory && this._dependenciesInstalled) {
            this._scanRepository();
        }
    }

    updateRemoveFilesRepoFromSidebar(directory) {
        if (!directory) {
            return;
        }
        try {
            const validated = validatePath(directory);
            this._selectedDirectory = validated;
            if (this._removalState.repoDir !== validated) {
                this._removalState.repoDir = validated;
                this._removalState.targets = [];
                this._removalState.preparedCommand = null;
                this._removalState.preparedMode = null;
                this._removalState.preview = null;
                this._removalState.details = [];
            }
            if (this._viewMode === 'removeFiles') {
                this._updateWebviewContent();
            }
        } catch { }
    }

    _getResultsHtml() {
        if (this._scanResults.length === 0) {
            return `
                <div class="scan-section">
                    <h2>✅ No Findings Found</h2>
                    <p>Great! No findings (potential secrets or policy references) were detected in your repository.</p>
                </div>
            `;
        }

        const severityColors = {
            high: '#ff6b6b',
            medium: '#ffa726',
            low: '#66bb6a',
            safe: '#4caf50',
            info: '#42a5f5',
            warning: '#ff9800'
        };

        // Fetch status for secrets cleanup actions — the scan repo's own fetch
        // time, not whatever the Remove Files view last fetched.
        const lastFetchISO = this._getLastFetchAt(this._scanCleanupRepo());
        const isStaleFetch = this._isFetchStale(lastFetchISO);
        const fetchColor = isStaleFetch ? 'var(--vscode-inputValidation-warningForeground)' : 'var(--vscode-descriptionForeground)';
        const fetchNote = isStaleFetch ? ' (stale)' : '';
        const fetchTooltip = isStaleFetch
            ? 'Remote refs may be outdated (older than 15 minutes). Fetch to ensure cleanup considers latest branches and tags.'
            : 'Remotes fetched recently; cleanup reflects current branches and tags.';

        const selection = this._ensureScanSelection();
        const eligibleIndexes = this._eligibleFindingIndexes();
        const selectedCount = eligibleIndexes.filter(i => selection.has(i)).length;

        const branchDataMap = {}; // index -> branches array, populated during map
        const resultsRows = this._scanResults.map((result, index) => {
            const isDependency = result.isDependency;
            const isGitHistory = result.isGitHistory;
            const isUntracked = result.isUntracked;
            const includeInCleanup = result.includeInCleanup !== false;
            // One predicate for "can be cleaned", so the checkbox never offers a
            // finding that the cleanup would silently skip.
            const cleanupDisabled = !this._isCleanupEligible(result);
            const isSelected = selection.has(index);

            // Choose appropriate icon and styling
            let icon = '📄';
            let iconTooltip = 'Current file';
            if (isGitHistory) {
                icon = '🕒';
                iconTooltip = 'Git history (past commit/branch)';
            } else if (isUntracked) {
                icon = '🟢';
                iconTooltip = 'Not committed (local only)';
            } else if (isDependency) {
                icon = '⚠️';
                iconTooltip = 'Dependency directory';
            }

            const rowStyle = isDependency ? 'opacity: 0.7;' : '';
            const contextNote = isGitHistory
                ? ' (git history)'
                : isUntracked
                    ? ' (not committed)'
                    : isDependency
                        ? ' (dependency directory)'
                        : '';
            const cleanupNote = includeInCleanup ? '' : ' (keyword history reference only)';

            // Build git info display for commit details
            const shortHash = result.commitHash ? result.commitHash.substring(0, 7) : null;

            // Parse git timestamp: NP uses gix format "<unix_seconds> <tz_offset>" e.g. "1705312200 -0500"
            // Also handle ISO 8601 strings as fallback
            let commitDateFormatted = null;
            if (result.commitDate) {
                const gitTsParts = String(result.commitDate).match(/^(\d+)\s+([+-]\d{4})$/);
                if (gitTsParts) {
                    const unixSeconds = parseInt(gitTsParts[1], 10);
                    const tzOffset = gitTsParts[2]; // e.g. "-0500"
                    if (!isNaN(unixSeconds) && typeof tzOffset === 'string') {
                        const sign = tzOffset[0] === '-' ? -1 : 1;
                        const hours = parseInt(tzOffset.substring(1, 3), 10) || 0;
                        const minutes = parseInt(tzOffset.substring(3, 5), 10) || 0;
                        const offsetMinutes = sign * (hours * 60 + minutes);
                        // Adjust UTC instant by commit's offset to get the commit's local wall-clock date
                        const adjustedMs = (unixSeconds + offsetMinutes * 60) * 1000;
                        const d = new Date(adjustedMs);
                        if (!isNaN(d.getTime())) {
                            commitDateFormatted = d.toLocaleDateString(undefined, {
                                year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC'
                            });
                        }
                    }
                } else {
                    const d = new Date(result.commitDate);
                    if (!isNaN(d.getTime())) {
                        commitDateFormatted = d.toLocaleDateString(undefined, {
                            year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC'
                        });
                    }
                }
            }

            // Build branch display: truncate to first branch, click to see all
            let branchHtml = '';
            if (result.commitBranches && result.commitBranches.length > 0) {
                const branches = result.commitBranches;
                const MAX_DISPLAY_BRANCHES = 1;
                const firstBranch = branches[0];
                if (branches.length <= MAX_DISPLAY_BRANCHES) {
                    branchHtml = `<span title="${escapeHtml(branches.join(', '))}" style="color: var(--vscode-gitDecoration-modifiedResourceForeground);">&#x1F33F; ${escapeHtml(firstBranch)}</span>`;
                } else {
                    branchDataMap[index] = branches;
                    branchHtml = `<span class="branch-link" data-branch-idx="${index}" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '||event.key==='Spacebar'){this.click();event.preventDefault();}" title="Click to see all ${branches.length} branches/tags" style="color: var(--vscode-gitDecoration-modifiedResourceForeground);">&#x1F33F; ${escapeHtml(firstBranch)} <span style="font-size: 0.8em; opacity: 0.8;">(+${branches.length - 1} more)</span></span>`;
                }
            }

            let gitInfoHtml = '';
            let gitInfoTooltip = '';
            if (result.commitHash || (result.commitBranches && result.commitBranches.length > 0) || result.commitDate) {
                const parts = [];
                const tooltipParts = [];
                if (branchHtml) {
                    parts.push(branchHtml);
                }
                if (result.commitBranches && result.commitBranches.length > 0) {
                    tooltipParts.push('Branch(es): ' + result.commitBranches.join(', '));
                }
                if (shortHash) {
                    parts.push(`<span title="Commit ${escapeHtml(result.commitHash)}" style="font-family: monospace; color: var(--vscode-textLink-foreground);">${escapeHtml(shortHash)}</span>`);
                    tooltipParts.push('Commit: ' + result.commitHash);
                }
                if (commitDateFormatted) {
                    parts.push(`<span title="Commit date" style="color: var(--vscode-descriptionForeground);">${escapeHtml(commitDateFormatted)}</span>`);
                    tooltipParts.push('Date: ' + commitDateFormatted);
                }
                gitInfoHtml = parts.join('<br>');
                gitInfoTooltip = tooltipParts.join('\n');
            } else {
                gitInfoHtml = '<span style="color: var(--vscode-descriptionForeground); font-size: 0.85em;">—</span>';
            }

            return `
                <tr data-finding-index="${index}" data-file="${escapeHtml(result.file)}" data-line="${result.line}" style="border-left: 3px solid ${severityColors[result.severity] || '#666'}; ${rowStyle}">
                    <td><input type="checkbox" class="secret-checkbox checkbox" data-finding-index="${index}" ${cleanupDisabled ? `disabled title="${escapeHtml(this._cleanupIneligibleReason(result))}"` : ''} ${!cleanupDisabled && isSelected ? 'checked' : ''}></td>
                    <td title="${escapeHtml(result.file)}${contextNote}${cleanupNote}">
                        <span class="file-link ${isGitHistory ? 'disabled' : 'clickable'}" data-file="${escapeHtml(result.file)}" data-line="${result.line}" style="font-family: monospace; font-size: 0.9em; color: var(--vscode-textLink-foreground); ${isGitHistory ? 'cursor: default;' : 'cursor: pointer; text-decoration: underline;'}" title="${iconTooltip}">
                            ${icon} ${escapeHtml(result.file)}
                        </span>
                        ${isDependency ? '<span class="dep-badge" title="This finding is inside a third-party dependency (node_modules, vendor, …), not your own code. Dependencies are not selectable for cleanup — fix them by updating the package, not by rewriting your history.">Dependency · not your code</span>' : ''}
                        ${isGitHistory ? '<span style="font-size: 0.7em; color: var(--vscode-descriptionForeground); margin-left: 5px;">(history)</span>' : ''}
                        ${isUntracked ? '<span style="font-size: 0.7em; color: var(--vscode-descriptionForeground); margin-left: 5px;">(local)</span>' : ''}
                    </td>
                    <td style="text-align: center;">
                        <span class="file-link ${isGitHistory ? 'disabled' : 'clickable'}" data-file="${escapeHtml(result.file)}" data-line="${result.line}" style="background: var(--vscode-badge-background); padding: 2px 6px; border-radius: 10px; font-size: 0.8em; ${isGitHistory ? 'cursor: default;' : 'cursor: pointer;'}">
                            ${result.line}
                        </span>
                    </td>
                    <td title="${escapeHtml(result.secret)}">
                        <span style="font-family: monospace; max-width: 200px; overflow: hidden; text-overflow: ellipsis; background: var(--vscode-textCodeBlock-background); padding: 2px 4px; border-radius: 3px;">
                            ${escapeHtml(result.secret)}
                        </span>
                    </td>
                    <td>
                        <input type="text" class="replacement-input" data-finding-index="${index}" value="${escapeHtml(this._getReplacementValue(index))}" placeholder="Replacement value" ${cleanupDisabled ? 'disabled' : ''}>
                    </td>
                    <td style="font-size: 0.85em; line-height: 1.5;">
                        ${this._renderEngineAttribution(result)}
                    </td>
                    <td title="${escapeHtml(gitInfoTooltip)}" style="font-size: 0.85em; line-height: 1.4; overflow: visible; white-space: normal; word-break: break-word;">
                        ${gitInfoHtml}
                    </td>
                    <td title="${escapeHtml(result.description)}">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span style="background: ${severityColors[result.severity] || '#666'}; color: white; padding: 2px 6px; border-radius: 10px; font-size: 0.7em; text-transform: uppercase;">
                                ${escapeHtml(result.severity)}
                            </span>
                            <span style="font-size: 0.9em;">
                                ${escapeHtml(result.description)}
                                ${isDependency ? ' <span style="color: var(--vscode-descriptionForeground); font-size: 0.8em;">— in a third-party dependency, not your code (not selectable)</span>' : ''}
                                ${isUntracked ? ' <span style="color: var(--vscode-gitDecoration-addedResourceForeground); font-size: 0.8em;">(not committed)</span>' : ''}
                                ${!includeInCleanup ? ' <span style="color: var(--vscode-descriptionForeground); font-size: 0.8em;">(excluded from cleanup)</span>' : ''}
                            </span>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        const severityCounts = this._scanResults.reduce((counts, result) => {
            counts[result.severity] = (counts[result.severity] || 0) + 1;
            return counts;
        }, {});

        const severitySummary = Object.entries(severityCounts)
            .map(([severity, count]) => `
                <span style="background: ${severityColors[severity]}; color: white; padding: 4px 8px; border-radius: 12px; font-size: 0.8em; margin-right: 8px;">
                    ${severity.toUpperCase()}: ${count}
                </span>
            `).join('');

        // Separate regular findings from dependency warnings
        const regularFindings = this._scanResults.filter(r => !r.isDependency);
        const dependencyWarnings = this._scanResults.filter(r => r.isDependency);
        const prepared = this._scanCleanup.preparedCommand;
        const bfgCommandText = prepared && this._scanCleanup.preparedMode === 'bfg'
            ? prepared
            : 'BFG command will appear here after preparation.';
        const gitCommandText = prepared && this._scanCleanup.preparedMode === 'git'
            ? prepared
            : 'Git-only command will appear here after preparation.';
        const renderPreparedActions = (id) => `
            <div style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap;">
                <button class="scan-button" onclick="copyScanCommand(&quot;${id}&quot;)">📋 Copy command</button>
                <button class="scan-button" onclick="saveScanScript()">💾 Save as .sh</button>
            </div>
            <div class="hint" style="margin-top:8px;">
                <strong>Run manually:</strong>
                <ol style="margin:6px 0 0 20px; padding:0;">
                    <li>Choose <strong>Save as .sh</strong> (or copy the script into <code>leak-lock-cleanup.sh</code>).</li>
                    <li>In a local terminal run <code>chmod 700 leak-lock-cleanup.sh</code>, then <code>./leak-lock-cleanup.sh</code>. The script changes to the selected repository itself.</li>
                    <li>Or use the red <strong>Run cleanup</strong> button below. Leak Lock stores replacement data in an owner-only OS temporary directory, removes it on success or failure, and asks separately before force-pushing.</li>
                </ol>
            </div>`;
        const preparedBlockBfg = `
            <div id="scan-prepared-command-bfg" class="danger-command">${escapeHtml(bfgCommandText)}</div>
            ${prepared && this._scanCleanup.preparedMode === "bfg" ? renderPreparedActions("scan-prepared-command-bfg") : ""}
        `;
        const preparedBlockGit = `
            <div id="scan-prepared-command-git" class="danger-command">${escapeHtml(gitCommandText)}</div>
            ${prepared && this._scanCleanup.preparedMode === "git" ? renderPreparedActions("scan-prepared-command-git") : ""}
        `;
        // Manual rules are cleaned by the same mechanism as findings, so they count
        // toward whether there is anything to prepare.
        const customRuleCount = this._getCustomRules().length;
        const noneSelected = selectedCount === 0 && customRuleCount === 0;
        const blockedBlock = this._renderBlockedBranches(this._scanCleanup.blockedBranches, this._scanCleanup.blockedReason);
        const refreshBlock = this._renderRefreshError(this._scanCleanup.refreshError);
        const pushPlanBlock = prepared ? this._renderPushPlan(this._scanCleanup.pushPlan) : '';
        const verifyBlock = this._renderVerifyResult(this._scanCleanup.verifyResult);
        const pendingPushBlock = this._renderPendingPush(this._scanCleanup.pendingPush);

        return `
            <div class="scan-section">
                <h2>🔍 Scan Results</h2>
                <div style="margin:6px 0 10px 0; font-size:0.9em; color:${fetchColor}; display:flex; align-items:center; gap:8px;">
                    <span title="${escapeHtml(fetchTooltip)}">Refs status: Last fetched ${this._removalState.lastFetchAt ? escapeHtml(new Date(this._removalState.lastFetchAt).toLocaleString()) : 'never'}${fetchNote}</span>
                    <button style="padding:4px 8px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border:none; border-radius:4px; cursor:pointer;" onclick="refetchNow()">⟳ Refetch now</button>
                </div>
                <div style="margin-bottom: 15px;">
                    <strong>Found ${this._scanResults.length} findings:</strong>
                    <div class="export-actions">
                        <button class="scan-button" id="ll-select-all" type="button">☑️ Select all</button>
                        <button class="scan-button" id="ll-clear-all" type="button">☐ Clear all</button>
                        <button class="scan-button" onclick="exportScanResultsJson()">📤 Export JSON</button>
                        <button class="scan-button" onclick="printScanResults()">🖨️ Print / Save as PDF</button>
                    </div>
                    <div id="selection-counter" class="selection-counter" data-selected="${selectedCount}" data-total="${eligibleIndexes.length}">
                        ${selectedCount} of ${eligibleIndexes.length} cleanable finding${eligibleIndexes.length === 1 ? '' : 's'} selected
                    </div>
                    <div style="margin-top:10px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                        <label for="finding-search"><strong>Search findings</strong></label>
                        <input id="finding-search" type="search" placeholder="File, secret, branch, severity, description…"
                            aria-controls="scan-findings-body" autocomplete="off"
                            style="min-width:280px; flex:1; padding:6px 8px; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border);">
                        <span id="finding-search-count" class="hint" aria-live="polite">${this._scanResults.length} shown</span>
                    </div>
                    <div class="hint" style="margin-top:4px;">Press Ctrl+F or Cmd+F to search these results.</div>
                    <div style="margin-top: 8px;">
                        <div>${severitySummary}</div>
                        ${dependencyWarnings.length > 0 ? `
                            <div style="margin-top: 8px; padding: 8px; background: var(--vscode-inputValidation-warningBackground); border-left: 3px solid ${severityColors.warning}; border-radius: 3px;">
                                <strong>ℹ️ ${dependencyWarnings.length} finding${dependencyWarnings.length === 1 ? '' : 's'} in third-party dependencies (not your code)</strong>
                                <br><span style="font-size: 0.9em;">These live in dependency folders (node_modules, vendor, etc.), not in your own source, so they are marked <strong>Dependency · not your code</strong> and can't be selected for history cleanup. Address them by updating or replacing the package.</span>
                            </div>
                        ` : ''}
                    </div>
                    ${this._renderScanCoverage()}
                </div>
                ${this._renderCustomRules()}
                <script>window.__branchData = ${JSON.stringify(branchDataMap).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')};</script>
                <table class="results-table">
                    <thead>
                        <tr>
                            <th style="width: 40px;" title="Select or clear every cleanable finding">
                                <input type="checkbox" id="select-all-findings" class="checkbox"
                                    ${eligibleIndexes.length === 0 ? 'disabled' : ''}
                                    ${selectedCount > 0 && selectedCount === eligibleIndexes.length ? 'checked' : ''}>
                            </th>
                            <th style="width: 20%;">File</th>
                            <th style="width: 50px;">Line</th>
                            <th style="width: 20%;">Secret</th>
                            <th style="width: 12%;">Replace With</th>
                            <th style="width: 10%;" title="Which engine reported this finding. A secret found by one engine and missed by another is visible here.">Engine</th>
                            <th style="width: 15%;">Git Info</th>
                            <th>Description</th>
                        </tr>
                    </thead>
                    <tbody id="scan-findings-body">
                        ${resultsRows}
                    </tbody>
                </table>
                ${pendingPushBlock}
                ${blockedBlock}
                ${refreshBlock}
                ${verifyBlock}
                <div class="run-section" style="margin-top: 18px;">
                    <h3>⚡ BFG-based cleanup (recommended)</h3>
                    <p class="warning-text">⚠️ WARNING: This will permanently modify your git history!</p>
                    <p style="font-size: 0.9em; margin: 8px 0;">
                        BFG is faster, but it will remove files/directories with the same name everywhere in history. Git-only cleanup does not.
                    </p>
                    <div style="margin-top: 8px;">
                        <button class="scan-button" id="prepare-bfg-button" onclick="prepareBfgCommand()" ${noneSelected ? 'disabled' : ''}>⚙️ Prepare BFG command</button>
                    </div>
                    ${preparedBlockBfg}
                    ${this._scanCleanup.preparedMode === 'bfg' ? pushPlanBlock : ''}
                    <div style="margin-top: 10px;">
                        <button class="danger-button" onclick="runPreparedBfg()" ${!prepared || this._scanCleanup.refreshError || this._scanCleanup.preparedMode !== 'bfg' ? 'disabled' : ''}>❗ Run BFG cleanup</button>
                    </div>
                </div>

                <div class="run-section" style="margin-top: 18px;">
                    <h3>⚡ Git-only cleanup (alternative)</h3>
                    <p class="warning-text">⚠️ WARNING: This will permanently modify your git history!</p>
                    <p style="font-size: 0.9em; margin: 8px 0;">
                        Git-only cleanup is path-aware and won’t remove same-name files elsewhere, but it is slower than BFG.
                    </p>
                    <div style="margin-top: 8px;">
                        <button class="scan-button" id="prepare-git-button" onclick="prepareGitCommand()" ${noneSelected ? 'disabled' : ''}>⚙️ Prepare Git-only command</button>
                    </div>
                    ${preparedBlockGit}
                    ${this._scanCleanup.preparedMode === 'git' ? pushPlanBlock : ''}
                    <div style="margin-top: 10px;">
                        <button class="danger-button" onclick="runPreparedGit()" ${!prepared || this._scanCleanup.refreshError || this._scanCleanup.preparedMode !== 'git' ? 'disabled' : ''}>❗ Run Git-only cleanup</button>
                    </div>
                </div>

                <div style="margin-top: 10px; font-size: 0.9em; color: var(--vscode-descriptionForeground);">
                    💡 <strong>Tip:</strong> Review each secret carefully before applying fixes. Some may be test data or false positives.
                </div>
            </div>
        `;
    }

    /** Write the prepared rewrite script to a file the user picks. */
    async _saveCleanupScript() {
        const script = this._scanCleanup.preparedCommand || this._removalState.preparedCommand;
        if (!script) {
            vscode.window.showWarningMessage('Prepare a cleanup command first.');
            return;
        }
        // Wrap the whole flow, including showSaveDialog, so a dialog rejection can
        // never surface as an unhandled promise rejection from the message handler.
        try {
            const target = await vscode.window.showSaveDialog({
                filters: { 'Shell script': ['sh'] },
                saveLabel: 'Save cleanup script'
            });
            if (!target) {
                return;
            }
            fs.writeFileSync(target.fsPath, script, { mode: 0o700 });
            let permissionNote = " with owner-only execute permission";
            try {
                fs.chmodSync(target.fsPath, 0o700);
            } catch (permissionError) {
                if (process.platform !== "win32") {
                    throw permissionError;
                }
                permissionNote = " (permissions are managed by Windows ACLs)";
            }
            vscode.window.showInformationMessage(`Cleanup script saved${permissionNote} to ${target.fsPath}. Run it locally with: bash ${gitRewrite.shellQuote(target.fsPath)}`);
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to save script: ${e.message}`);
        }
    }

    /** Blocking banner: a rewrite here would discard unpushed local commits. */
    /**
     * Explain a failed plan-time ref refresh without dumping git's raw remote output.
     *
     * The script is still available: it fetches and re-checks ahead-branches itself as
     * its first two steps, so running it by hand is safe even though the panel cannot
     * verify the plan from here.
     */
    _renderRefreshError(refreshError) {
        if (!refreshError) {
            return '';
        }
        return `
            <div style="margin-top: 12px; padding: 10px; border-radius: 4px;
                        background: var(--vscode-inputValidation-warningBackground);
                        border: 1px solid var(--vscode-editorWarning-foreground);">
                <strong>⚠️ Could not refresh refs from the remote — the script below was still generated.</strong>
                <div style="margin-top: 4px;">${escapeHtml(refreshError.message)}</div>
                <div style="margin-top: 6px; font-size: 0.9em;">
                    Running the cleanup <em>from this panel</em> is disabled, because Leak Lock cannot confirm your
                    local branches match the remote. <strong>Save as .sh</strong> and run it once the remote is
                    reachable — the script refreshes refs and re-checks for unpushed commits itself before it
                    rewrites anything.
                </div>
                <details style="margin-top: 6px;">
                    <summary style="cursor: pointer; font-size: 0.9em;">Show the git output</summary>
                    <pre style="white-space: pre-wrap; word-break: break-word; font-size: 0.85em; margin: 6px 0 0 0;">${escapeHtml(refreshError.detail)}</pre>
                </details>
            </div>
        `;
    }

    /** Test seam and single entry point for classifying a remote failure. */
    _classifyRemoteError(error) {
        return summarizeGitRemoteError(error);
    }

    _renderBlockedBranches(branches, reason) {
        if (reason === 'no-remote') {
            return `
            <div class="rewrite-blocked">
                <strong>⛔ Rewrite blocked — no remote configured</strong>
                <p style="margin: 6px 0; font-size: 0.9em;">
                    History cleanup fetches from and force-pushes to a remote, so it needs one.
                    Add a remote and prepare again:
                </p>
                <ul style="margin: 6px 0 6px 18px;"><li><code>git remote add origin &lt;url&gt;</code></li></ul>
            </div>
        `;
        }
        if (!branches || branches.length === 0) {
            return '';
        }
        const rows = branches
            .map(b => `<li><code>${escapeHtml(b.branch)}</code> — ${b.count} unpushed commit${b.count === 1 ? '' : 's'}</li>`)
            .join('');
        return `
            <div class="rewrite-blocked">
                <strong>⛔ Rewrite blocked — unpushed local commits</strong>
                <p style="margin: 6px 0; font-size: 0.9em;">
                    A ref-complete rewrite resets every local branch to its remote counterpart.
                    These branches would lose commits, so Leak Lock stopped before touching anything:
                </p>
                <ul style="margin: 6px 0 6px 18px;">${rows}</ul>
                <p style="margin: 6px 0; font-size: 0.9em;">Push them, then prepare again.</p>
            </div>
        `;
    }

    /** Explicit ref-by-ref push plan, instead of a blind `push --force --all`. */
    _renderPushPlan(plan) {
        if (!plan) {
            return '';
        }
        const list = (label, refs, hint) => {
            if (!refs || refs.length === 0) {
                return '';
            }
            return `<div style="margin-top:6px;"><strong>${label}</strong> <span style="font-size:0.85em; color: var(--vscode-descriptionForeground);">${hint}</span><div style="font-family: monospace; font-size:0.85em; margin-top:2px;">${refs.map(r => escapeHtml(r)).join(', ')}</div></div>`;
        };
        return `
            <div class="push-plan">
                <strong>📋 Push plan (${escapeHtml(plan.remote)})</strong>
                ${list('Force-updated branches:', plan.forceUpdate, '— rewritten history replaces the remote')}
                ${list('Remote-only branches:', plan.remoteOnly, '— materialised locally so they are not skipped')}
                ${list('Created on remote:', plan.create, '— exist locally only')}
                ${list('Tags:', plan.tags, '— force-updated')}
            </div>
        `;
    }

    /** Post-run verification: did the leak survive on any remote ref? */
    _renderVerifyResult(offenders) {
        if (!offenders) {
            return '';
        }
        if (offenders.length === 0) {
            return `
                <div class="verify-clean">
                    <strong>✅ Verified clean on every remote ref</strong>
                </div>
            `;
        }
        const rows = offenders
            .map(o => `<li><code>${escapeHtml(o.ref)}</code> — ${escapeHtml(o.reason)}: <code>${escapeHtml(o.match)}</code></li>`)
            .join('');
        return `
            <div class="rewrite-blocked">
                <strong>⚠️ Still present after the rewrite</strong>
                <ul style="margin: 6px 0 6px 18px;">${rows}</ul>
            </div>
        `;
    }

    /**
     * Persistent confirmation gate: the local rewrite is done, the remote is
     * NOT yet changed. This block stays on screen until the user confirms or
     * cancels the force-push — it is never auto-dismissed.
     */
    _renderPendingPush(pending) {
        if (!pending) {
            return '';
        }
        const remote = escapeHtml(pending.remote || 'origin');
        const refCount = Number(pending.refCount) || 0;
        const restoredNote = pending.remoteRestored
            ? '<p style="margin:6px 0;font-size:0.85em;">The remote was missing after the rewrite and was restored before this step.</p>'
            : '';
        return `
            <div class="pending-push">
                <strong>🛑 Confirm force-push — this will rewrite remote git history</strong>
                <p style="margin: 8px 0;">
                    Your <strong>local</strong> history has been rewritten and the secret removed, but
                    <strong>nothing has been pushed yet — the remote is unchanged</strong>.
                </p>
                <p style="margin: 8px 0;">
                    Confirming will <strong>force-push every branch and tag</strong>${refCount ? ` (${refCount} branch${refCount === 1 ? '' : 'es'} plus tags)` : ''}
                    to <code>${remote}</code> in a single atomic push, <strong>overwriting the history on the server</strong>.
                    This <strong>rewrites git history and cannot be undone</strong>: everyone with a clone must
                    re-clone or hard-reset afterward.
                </p>
                ${restoredNote}
                <p style="margin: 10px 0 8px; font-weight: 600;">Do you want to force-push the rewritten history now?</p>
                <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:6px;">
                    <button class="danger-button" onclick="confirmForcePush()">❗ Yes, force-push to ${remote}</button>
                    <button class="scan-button" onclick="cancelForcePush()">Cancel (keep remote unchanged)</button>
                </div>
            </div>
        `;
    }

    async _scanRepository(useWorkspace = false) {
        try {
            // Show scanning in progress
            this._isScanning = true;
            this._scanResults = [];
            this._scanCleanup.preparedCommand = null;
            this._scanCleanup.preparedMode = null;
            this._scanCleanup.replacements = null;
            this._scanCleanup.replacementsFile = null;
            this._scanCleanup.pushPlan = null;
            this._scanCleanup.blockedBranches = null;
            this._scanCleanup.blockedReason = null;
            this._scanCleanup.verifyResult = null;
            this._scanCleanup.pendingPush = null;
            this._scanCleanup.noseyParkerUnavailable = null;
            // Indices from the previous scan no longer refer to the same findings.
            this._resetScanSelection();
            this._updateWebviewContent();

            // Determine and validate scan path
            let scanPath;
            try {
                if (useWorkspace) {
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                    if (!workspaceFolder) {
                        vscode.window.showErrorMessage('No workspace folder found. Please open a folder first.');
                        this._isScanning = false;
                        this._updateWebviewContent();
                        return;
                    }
                    scanPath = validateDockerPath(workspaceFolder.uri.fsPath);
                } else {
                    if (!this._selectedDirectory) {
                        vscode.window.showErrorMessage('No directory selected. Please select a directory to scan first.');
                        this._isScanning = false;
                        this._updateWebviewContent();
                        return;
                    }
                    scanPath = validateDockerPath(this._selectedDirectory);
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Invalid scan path: ${error.message}`);
                this._isScanning = false;
                this._updateWebviewContent();
                return;
            }

            this._scanPath = scanPath;
            this._scanCoverage = null;
            await this._primeGitTracking(scanPath);

            const engineSettings = this._getScanEngineSettings();

            // Docker is only required by the Nosey Parker engine. Demanding it when
            // the user runs Gitleaks alone — a single binary with no runtime — would
            // block a scan that has no need of it.
            // Decide how hard to push this machine before committing to a plan.
            // Three scanners over a large history is real work; on a constrained host
            // it is better to run one lightweight engine well than three badly. Any
            // downgrade is reported, never silent — fewer engines means fewer findings.
            const strategy = this._chooseScanStrategy();
            const engineIds = strategy.engines;
            if (strategy.dropped.length > 0) {
                vscode.window.showWarningMessage(strategy.reason);
            }

            if (engineIds.includes('noseyparker')) {
                this._scanProgress = { stage: 'docker', message: 'Checking Docker availability...' };
                this._updateWebviewContent();

                const dockerCheck = await this._checkDockerAvailability();
                if (!dockerCheck.available) {
                    const others = engineIds.filter(id => id !== 'noseyparker');
                    if (others.length === 0) {
                        vscode.window.showErrorMessage(
                            `Docker not available: ${dockerCheck.error}. Nosey Parker is the only enabled engine and it requires Docker. ` +
                            'Enable Gitleaks in leakLock.scan.engines to scan without Docker.'
                        );
                        this._isScanning = false;
                        this._updateWebviewContent();
                        return;
                    }
                    // Degrade to the engines that can still run rather than failing the
                    // whole scan.
                    vscode.window.showWarningMessage(
                        `Docker not available (${dockerCheck.error}); skipping Nosey Parker. Scanning with: ${others.join(', ')}.`
                    );
                    this._scanCleanup.noseyParkerUnavailable = dockerCheck.error;
                }
            }

            // Refresh refs before scanning. A branch that exists only as an unfetched
            // remote ref is history the scan would never see, and reporting a
            // repository clean on that basis is the failure this guards against.
            this._scanProgress = { stage: 'refs', message: 'Refreshing git refs...' };
            this._updateWebviewContent();
            const refRefresh = await this._refreshRefsForScan(engineSettings);

            // Update progress: Pulling image
            this._scanProgress = { stage: 'pull', message: `Pulling ${engineSettings.image}...` };
            this._updateWebviewContent();

            const useNoseyParker = engineIds.includes('noseyparker')
                && !this._scanCleanup.noseyParkerUnavailable;

            let scanRun = { results: [], incomplete: false, incompleteReason: null };
            const engineReports = [];

            if (engineIds.includes('noseyparker') && this._scanCleanup.noseyParkerUnavailable) {
                engineReports.push({
                    id: 'noseyparker',
                    displayName: 'Nosey Parker',
                    version: null,
                    ok: false,
                    findings: 0,
                    note: `Skipped — Docker not available: ${this._scanCleanup.noseyParkerUnavailable}`
                });
            }

            // Each engine is an independent task. The strategy decides how many run at
            // once; a failing engine still cannot take the others down with it.
            const engineTasks = [];
            if (useNoseyParker) {
                engineTasks.push(() => this._runNoseyParkerEngine(scanPath, engineSettings));
            }
            for (const engineId of engineIds) {
                if (engineId === 'noseyparker') {
                    continue;
                }
                engineTasks.push(() => this._runExternalEngine(engineId, scanPath, engineSettings));
            }

            this._scanProgress = {
                stage: 'scan',
                message: strategy.mode === 'parallel'
                    ? `Scanning with ${engineIds.length} engines in parallel...`
                    : 'Scanning for secrets...'
            };
            this._updateWebviewContent();

            const outcomes = await hostCapacity.runWithConcurrency(
                engineTasks,
                strategy.mode === 'parallel' ? strategy.concurrency : 1
            );

            let pullResult = null;
            let engineVersion = null;
            const engineResults = [];
            for (const outcome of outcomes) {
                if (!outcome || outcome.error) {
                    console.warn('Engine task failed:', outcome && outcome.error && outcome.error.message);
                    continue;
                }
                if (outcome.report) {
                    engineReports.push(outcome.report);
                }
                if (outcome.results) {
                    engineResults.push(...outcome.results);
                }
                if (outcome.id === 'noseyparker') {
                    pullResult = outcome.pullResult;
                    engineVersion = outcome.version;
                    scanRun = outcome.scanRun || scanRun;
                }
            }

            const keywordHistoryResults = await this._scanGitHistoryForKeywords(scanPath);
            const allResults = this._deduplicateScanResults(
                engineResults.concat(keywordHistoryResults)
            );

            // Update progress: Processing
            this._scanProgress = { stage: 'process', message: 'Processing results...' };
            this._updateWebviewContent();

            // Enrich results with git branch names and commit dates
            await this._enrichResultsWithGitInfo(allResults, scanPath);

            // Update results
            this._scanResults = allResults;
            this._scanCoverage = await this._buildScanCoverage({
                scanPath,
                settings: engineSettings,
                engineVersion,
                engines: engineReports,
                strategy,
                pullResult,
                refRefresh,
                incomplete: scanRun.incomplete,
                incompleteReason: scanRun.incompleteReason
            });
            this._resetScanSelection();
            this._isScanning = false;
            this._scanProgress = null;

            // Update the webview
            this._updateWebviewContent();

            // Show completion message. An incomplete scan never reports "no findings"
            // as if the repository had been fully examined.
            if (scanRun.incomplete) {
                vscode.window.showWarningMessage(
                    `Scan incomplete — ${allResults.length} finding(s) so far. ${scanRun.incompleteReason || ''}`.trim()
                );
            } else if (allResults.length > 0) {
                vscode.window.showWarningMessage(`Scan complete! Found ${allResults.length} findings (potential secrets or policy references). Review them in the main panel.`);
            } else {
                vscode.window.showInformationMessage('🎉 Scan complete! No findings (potential secrets or policy references) were found in your repository.');
            }
        } catch (error) {
            console.error('Scan error:', error);
            this._isScanning = false;
            this._scanProgress = null;
            this._updateWebviewContent();
            vscode.window.showErrorMessage(`Scan failed: ${error.message}`);
        }
    }

    async _primeGitTracking(scanPath) {
        this._scanRepoRoot = null;
        this._trackedFiles = null;
        if (!scanPath) {
            return;
        }
        const util = require('util');
        const execFileAsync = util.promisify(execFile);
        try {
            const { stdout: rootOut } = await execFileAsync('git', ['-C', scanPath, 'rev-parse', '--show-toplevel']);
            const repoRoot = rootOut.trim();
            if (!repoRoot) {
                return;
            }
            const { stdout: filesOut } = await execFileAsync('git', ['-C', repoRoot, 'ls-files', '-z']);
            const tracked = filesOut.split('\0').filter(Boolean);
            this._scanRepoRoot = repoRoot;
            this._trackedFiles = new Set(tracked);
        } catch (e) {
            this._scanRepoRoot = null;
            this._trackedFiles = null;
        }
    }

    /**
     * Refresh every ref before scanning.
     *
     * The rewrite path has required this since 0.6.0 (a rewrite planned against stale
     * refs is unsafe). The scan path never did, which is the more dangerous omission:
     * an unfetched remote-only branch is history the scanner never sees, and the user
     * is told the repository is clean.
     *
     * Never throws — a fetch failure downgrades coverage, it does not cancel the scan.
     */
    async _refreshRefsForScan(settings) {
        const cfg = settings || this._getScanEngineSettings();
        const repoRoot = this._scanRepoRoot;
        if (!repoRoot) {
            return { attempted: false, ok: false, reason: 'not-a-git-repository' };
        }
        if (!cfg.refreshRefsBeforeScan) {
            return { attempted: false, ok: false, reason: 'disabled-by-setting' };
        }
        let remote;
        try {
            remote = await gitRewrite.hasRemote(repoRoot, gitRewrite.DEFAULT_REMOTE);
        } catch {
            remote = false;
        }
        if (!remote) {
            return { attempted: false, ok: false, reason: 'no-remote' };
        }
        try {
            await gitRewrite.fetchAllRefs(repoRoot, gitRewrite.DEFAULT_REMOTE);
            return { attempted: true, ok: true, reason: null };
        } catch (error) {
            return { attempted: true, ok: false, reason: error.message || 'fetch-failed' };
        }
    }

    /**
     * Record which engine produced a finding, so a result set can be reproduced and a
     * cross-engine discrepancy can be attributed rather than guessed at.
     */
    _stampEngine(result, engineVersion, engineId = 'noseyparker') {
        if (!result || typeof result !== 'object') {
            return result;
        }
        result.engine = result.engine || engineId;
        result.engineVersion = result.engineVersion || engineVersion || null;
        result.engines = Array.isArray(result.engines) && result.engines.length
            ? result.engines
            : [result.engine];
        return result;
    }

    /**
     * Describe what the scan actually covered.
     *
     * "No findings" only means something alongside this, so it is part of the result
     * rather than console output — the scan-side counterpart to the ref-by-ref push
     * plan that gates the rewrite.
     */
    async _buildScanCoverage({ scanPath, settings, engineVersion, engines, strategy, pullResult, refRefresh, incomplete, incompleteReason }) {
        const cfg = settings || this._getScanEngineSettings();
        const coverage = {
            scanPath,
            incomplete: Boolean(incomplete),
            incompleteReason: incompleteReason || null,
            engines: Array.isArray(engines) && engines.length
                ? engines
                : [{
                    id: 'noseyparker',
                    displayName: 'Nosey Parker',
                    version: engineVersion || null,
                    ok: true,
                    note: scanEngineConfig.NOSEYPARKER_ARCHIVED_NOTICE
                }],
            strategy: strategy
                ? {
                    mode: strategy.mode,
                    tier: strategy.tier,
                    concurrency: strategy.concurrency,
                    dropped: strategy.dropped,
                    reason: strategy.reason,
                    host: {
                        cpus: strategy.host.cpus,
                        totalMemGb: Number(strategy.host.totalMemGb.toFixed(1)),
                        memorySource: strategy.host.memorySource,
                        loadPerCore: strategy.host.loadPerCore
                    }
                }
                : null,
            image: cfg.image,
            imagePulled: pullResult ? pullResult.pulled : null,
            imagePullError: pullResult ? pullResult.error : null,
            rulesetMode: cfg.rulesetMode,
            maxFileSizeMb: cfg.maxFileSizeMb,
            timeoutSeconds: Math.round(cfg.timeoutMs / 1000),
            dependencyHandling: vscode.workspace.getConfiguration('leakLock').get('dependencyHandling') || 'warning',
            refRefresh: refRefresh || { attempted: false, ok: false, reason: 'unknown' },
            refs: { localBranches: 0, remoteBranches: 0, remoteOnlyBranches: [], tags: 0, stashes: 0 }
        };

        const repoRoot = this._scanRepoRoot;
        if (!repoRoot) {
            return coverage;
        }

        try {
            const [locals, remotes, tags] = await Promise.all([
                gitRewrite.listLocalBranches(repoRoot).catch(() => []),
                gitRewrite.listRemoteBranches(repoRoot, gitRewrite.DEFAULT_REMOTE).catch(() => []),
                gitRewrite.listTags(repoRoot).catch(() => [])
            ]);
            const localSet = new Set(locals);
            coverage.refs.localBranches = locals.length;
            coverage.refs.remoteBranches = remotes.length;
            coverage.refs.remoteOnlyBranches = remotes.filter(name => !localSet.has(name));
            coverage.refs.tags = tags.length;
            coverage.refs.stashes = await this._countStashEntries(repoRoot);
        } catch (error) {
            console.warn('Could not build ref coverage summary:', error.message);
        }

        return coverage;
    }

    async _countStashEntries(repoRoot) {
        const util = require('util');
        const execFileAsync = util.promisify(execFile);
        try {
            const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'stash', 'list'], { timeout: 10000 });
            return stdout.split('\n').filter(line => line.trim()).length;
        } catch {
            return 0;
        }
    }

    _getKeywordSearchConfig() {
        const config = vscode.workspace.getConfiguration('leakLock');
        const enabled = !!config.get('gitHistoryKeywordSearch.enabled', false);
        const rawKeywords = config.get('gitHistoryKeywordSearch.keywords', []);
        const rawMaxMatchesPerKeyword = config.get('gitHistoryKeywordSearch.maxMatchesPerKeyword', 25);
        const rawShortKeywordFileHistoryMaxCount = config.get('gitHistoryKeywordSearch.shortKeywordFileHistoryMaxCount', 300);
        const parsedMaxMatchesPerKeyword = Number(rawMaxMatchesPerKeyword);
        const parsedShortKeywordFileHistoryMaxCount = Number(rawShortKeywordFileHistoryMaxCount);
        const maxMatchesPerKeyword = Number.isFinite(parsedMaxMatchesPerKeyword)
            ? Math.floor(parsedMaxMatchesPerKeyword)
            : 25;
        const shortKeywordFileHistoryMaxCount = Number.isFinite(parsedShortKeywordFileHistoryMaxCount)
            ? Math.floor(parsedShortKeywordFileHistoryMaxCount)
            : 300;
        const searchCommitMessages = !!config.get('gitHistoryKeywordSearch.searchCommitMessages', true);
        const searchFileHistory = !!config.get('gitHistoryKeywordSearch.searchFileHistory', true);
        const searchFileNames = !!config.get('gitHistoryKeywordSearch.searchFileNames', false);

        const keywords = Array.isArray(rawKeywords)
            ? [...new Set(rawKeywords.map((k) => String(k || '').trim()).filter(Boolean))]
            : [];

        return {
            enabled,
            keywords,
            maxMatchesPerKeyword: Math.max(1, Math.min(500, maxMatchesPerKeyword)),
            shortKeywordFileHistoryMaxCount: Math.max(100, Math.min(5000, shortKeywordFileHistoryMaxCount)),
            searchCommitMessages,
            searchFileHistory,
            searchFileNames
        };
    }

    _createKeywordHistoryResult(filePath, keyword, description, commitHash, commitDate) {
        const result = this._createResult(
            filePath,
            1,
            keyword,
            description,
            'git_history_keyword',
            null,
            // Keyword-history matches are selectable and cleanable like any other
            // finding: selecting one redacts that string from history via BFG
            // --replace-text. They are checked by default alongside real secrets.
            { forceGitHistory: true, includeInCleanup: true }
        );
        result.commitHash = commitHash || null;
        result.commitDate = commitDate || null;
        return result;
    }

    /**
     * Collapse duplicates without losing information.
     *
     * Two passes with different intent:
     *
     *  - An exact repeat (same engine, rule, location and secret) is a duplicate and is
     *    dropped.
     *  - The same secret at the same location reported by a *different* engine is not a
     *    duplicate finding, it is corroboration. Those merge into one row whose
     *    `engines` list names every engine that found it — and, by omission, every
     *    enabled engine that did not. That attribution is the diagnostic that turns an
     *    unexplained gap against another tool into a checkable fact.
     *
     * Two rules from the same engine at one location stay separate, as before: they are
     * genuinely different detections.
     */
    _deduplicateScanResults(results) {
        const seen = new Set();
        const byLocation = new Map();
        const merged = [];

        for (const result of results) {
            const engine = result.engine || '';
            const exactKey = [
                result.file,
                result.line,
                result.fullSecret,
                result.commitHash || "",
                result.ruleName || "",
                engine
            ].join("\0");
            if (seen.has(exactKey)) {
                continue;
            }
            seen.add(exactKey);

            const locationKey = [
                result.file,
                result.line,
                result.fullSecret,
                result.commitHash || ""
            ].join("\0");
            const existing = byLocation.get(locationKey);

            if (existing && engine && existing.engine && engine !== existing.engine) {
                this._mergeCrossEngineResult(existing, result);
                continue;
            }

            merged.push(result);
            if (!existing) {
                byLocation.set(locationKey, result);
            }
        }

        return merged;
    }

    /**
     * Fold a second engine's view of the same secret into the surviving row.
     * Fields are only filled in, never overwritten — the merged record is the union of
     * what the engines supplied, so corroboration can never subtract detail.
     */
    _mergeCrossEngineResult(target, incoming) {
        const engines = new Set(target.engines || (target.engine ? [target.engine] : []));
        for (const id of incoming.engines || (incoming.engine ? [incoming.engine] : [])) {
            engines.add(id);
        }
        target.engines = Array.from(engines);

        for (const [key, value] of Object.entries(incoming)) {
            if (value === null || value === undefined || value === '') {
                continue;
            }
            if (key === 'engines' || key === 'engine' || key === 'unavailableFields') {
                continue;
            }
            if (target[key] === null || target[key] === undefined || target[key] === '') {
                target[key] = value;
            }
        }

        // A live-credential confirmation from any engine wins.
        if (incoming.verified === true) {
            target.verified = true;
            target.severity = target.isDependency || target.isUntracked ? target.severity : 'high';
        }

        // A field is only unavailable if it was unavailable from every engine that
        // reported this finding.
        const targetUnavailable = new Set(target.unavailableFields || []);
        const incomingUnavailable = new Set(incoming.unavailableFields || []);
        target.unavailableFields = Array.from(targetUnavailable).filter(f => incomingUnavailable.has(f));

        return target;
    }

    _stableHash(input) {
        const str = String(input || '');
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const charCode = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + charCode;
            hash |= 0;
        }
        return (hash >>> 0).toString(16);
    }

    _formatCommitMessagePathLabel(_commitMessage, commitHash) {
        const normalizedCommitHash = commitHash ? String(commitHash).trim() : '';
        // Derive the ID from commit hash only to avoid encoding any commit-message information.
        const hashSource = normalizedCommitHash || 'no-commit-hash';
        const messageID = this._stableHash(hashSource);
        if (normalizedCommitHash) {
            return `git-history:commit-message [id:${messageID} commit:${normalizedCommitHash}]`;
        }
        return `git-history:commit-message [id:${messageID}]`;
    }

    _buildKeywordMatcher(keyword, options = {}) {
        const matchFragments = !!options.matchFragments;
        const keywordStr = String(keyword || '').trim();
        const keywordLower = keywordStr.toLowerCase();
        if (!keywordLower) {
            return () => false;
        }
        if (matchFragments) {
            return (candidateText) => {
                if (candidateText && typeof candidateText === 'object' && typeof candidateText.lowerText === 'string') {
                    return candidateText.lowerText.includes(keywordLower);
                }
                return String(candidateText || '').toLowerCase().includes(keywordLower);
            };
        }
        // Reduce false positives for word-like keywords by requiring whole-word matches.
        const isWordLike = /^[A-Za-z0-9]+$/.test(keywordStr);
        if (isWordLike) {
            const boundaryRegex = new RegExp(`\\b${this._escapeRegex(keywordStr)}\\b`, 'i');
            return (candidateText) => boundaryRegex.test(String(candidateText || ''));
        }
        return (candidateText) => String(candidateText || '').toLowerCase().includes(keywordLower);
    }

    async _scanGitHistoryForKeywords(scanPath) {
        const keywordConfig = this._getKeywordSearchConfig();
        if (!keywordConfig.enabled || keywordConfig.keywords.length === 0) {
            return [];
        }

        const repoDir = this._scanRepoRoot || scanPath;
        const util = require('util');
        const execFileAsync = util.promisify(execFile);
        const gitLogOptions = { timeout: 20000, maxBuffer: 50 * 1024 * 1024 };
        // The file-content pass runs `git log -G … -p` (pickaxe over full patches),
        // which is the heaviest search and the most likely to hit a limit on a
        // large repository. Give it a bigger buffer and a longer timeout so it
        // does not silently fail on real-world histories.
        const fileHistoryLogOptions = { timeout: 60000, maxBuffer: 256 * 1024 * 1024 };
        const findings = [];
        const seen = new Set();
        const totalSearchModes =
            (keywordConfig.searchCommitMessages ? 1 : 0) +
            (keywordConfig.searchFileHistory ? 1 : 0) +
            (keywordConfig.searchFileNames ? 1 : 0);
        const maxTotalFindings = Math.max(50, Math.min(2000, keywordConfig.keywords.length * keywordConfig.maxMatchesPerKeyword * Math.max(1, totalSearchModes)));
        const maxCommitLogCount = 5000;
        const maxFileHistoryLogCount = Math.min(5000, keywordConfig.shortKeywordFileHistoryMaxCount ?? 3000);
        const maxFileNameHistoryLogCount = 4000;

        const addFinding = (filePath, keyword, description, commitHash, commitDate) => {
            if (findings.length >= maxTotalFindings) {
                return false;
            }
            const dedupeKey = [commitHash || '', filePath || '', keyword, description].join('|');
            if (seen.has(dedupeKey)) {
                return false;
            }
            seen.add(dedupeKey);
            findings.push(this._createKeywordHistoryResult(filePath, keyword, description, commitHash, commitDate));
            return true;
        };
        const commitModeMatchCountByKeyword = new Map(keywordConfig.keywords.map((kw) => [kw, 0]));
        const fileModeMatchCountByKeyword = new Map(keywordConfig.keywords.map((kw) => [kw, 0]));
        const fileNameModeMatchCountByKeyword = new Map(keywordConfig.keywords.map((kw) => [kw, 0]));
        const buildKeywordMatchers = (keywords, options = {}) => keywords.map((keyword) => ({
            keyword,
            matches: this._buildKeywordMatcher(keyword, options)
        }));
        // Commit-message prefilter uses git --grep substring semantics; keep JS matcher aligned.
        const commitKeywordMatchers = buildKeywordMatchers(keywordConfig.keywords, { matchFragments: true });
        // File CONTENT search must be literal substring: a secret is routinely
        // embedded inside a larger token (a URL, a base64 blob, a concatenated
        // identifier). `git log -G` already prefilters on the raw substring, so a
        // word-boundary JS matcher would find the commit via pickaxe and then
        // silently drop it — the exact "it's in the file but search misses it" bug.
        const fileHistoryKeywordMatchers = buildKeywordMatchers(keywordConfig.keywords, { matchFragments: true });
        const fileNameKeywordMatchers = buildKeywordMatchers(keywordConfig.keywords, { matchFragments: true });

        // Each pass is isolated: a failure in one (e.g. the content pass hitting a
        // time or output limit on a very large repository) must not discard the
        // findings from the others. Failed passes are reported, not swallowed.
        const passErrors = [];

        try {
            if (keywordConfig.searchCommitMessages) {
                this._scanProgress = { stage: 'process', message: 'Searching git commit messages for configured keywords...' };
                this._updateWebviewContent();
                const perKeywordCap = keywordConfig.maxMatchesPerKeyword * 5;
                const requestedMaxCount = Math.max(
                    perKeywordCap,
                    keywordConfig.keywords.length * perKeywordCap
                );
                const gitMaxCount = Math.min(maxCommitLogCount, requestedMaxCount);
                const grepArgs = keywordConfig.keywords.flatMap((keyword) => ['--grep', keyword]);
                const { stdout } = await execFileAsync('git', [
                    '-C', repoDir,
                    'log', '--all', '--no-color', '-z',
                    '--regexp-ignore-case', '--fixed-strings',
                    ...grepArgs,
                    `--max-count=${gitMaxCount}`,
                    '--pretty=format:%H%x09%aI%x09%B%x00'
                ], gitLogOptions);
                const records = stdout.split('\0').filter(Boolean);
                for (const record of records) {
                    if (findings.length >= maxTotalFindings) {
                        break;
                    }
                    const firstTab = record.indexOf('\t');
                    const secondTab = firstTab >= 0 ? record.indexOf('\t', firstTab + 1) : -1;
                    if (firstTab < 0 || secondTab < 0) {
                        continue;
                    }
                    const commitHash = record.slice(0, firstTab).trim();
                    const commitDate = record.slice(firstTab + 1, secondTab).trim();
                    const fullMessage = record.slice(secondTab + 1).trim();
                    const commitMessagePathLabel = this._formatCommitMessagePathLabel(fullMessage, commitHash);
                    for (const { keyword, matches } of commitKeywordMatchers) {
                        const existingCount = commitModeMatchCountByKeyword.get(keyword) || 0;
                        if (existingCount >= keywordConfig.maxMatchesPerKeyword) {
                            continue;
                        }
                        if (!matches(fullMessage)) {
                            continue;
                        }
                        const added = addFinding(
                            commitMessagePathLabel,
                            keyword,
                            `Keyword "${keyword}" found in commit ${commitHash}${commitDate ? ` (${commitDate})` : ''}`,
                            commitHash,
                            commitDate
                        );
                        if (added) {
                            commitModeMatchCountByKeyword.set(keyword, existingCount + 1);
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('git-history commit-message search failed:', e.message);
            passErrors.push('commit messages');
        }

        try {
            if (keywordConfig.searchFileHistory) {
                this._scanProgress = { stage: 'process', message: 'Searching git file history for configured keywords...' };
                this._updateWebviewContent();

                const fileHistoryKeywords = keywordConfig.keywords;
                if (fileHistoryKeywords.length > 0) {
                    const shortKeywords = [];
                    const longKeywords = [];
                    for (const keyword of fileHistoryKeywords) {
                        const normalized = String(keyword || '').trim();
                        if (!normalized) {
                            continue;
                        }
                        if (normalized.length <= 3) {
                            shortKeywords.push(normalized);
                        } else {
                            longKeywords.push(normalized);
                        }
                    }
                    const fileHistoryMatcherMap = new Map(fileHistoryKeywordMatchers.map((entry) => [entry.keyword, entry.matches]));

                    const runFileHistoryPass = async (passKeywords, options = {}) => {
                        if (!Array.isArray(passKeywords) || passKeywords.length === 0) {
                            return;
                        }
                        const combinedPattern = passKeywords
                            .map((keyword) => {
                                const escaped = this._escapeRegex(keyword);
                                // git log -G uses POSIX ERE (no \b word-boundary token).
                                // Keep the prefilter broad and rely on JS matchers for word semantics.
                                return escaped;
                            })
                            .join('|');
                        const commitSafetyFactor = 3;
                        const requestedMaxCount = Math.max(
                            100,
                            Math.max(1, keywordConfig.maxMatchesPerKeyword) *
                                Math.max(1, passKeywords.length) *
                                commitSafetyFactor
                        );
                        let gitMaxCount = Math.min(maxFileHistoryLogCount, requestedMaxCount);
                        if (Number.isFinite(options.maxCountCap) && options.maxCountCap > 0) {
                            gitMaxCount = Math.max(100, Math.min(gitMaxCount, options.maxCountCap));
                        }

                        const { stdout } = await execFileAsync('git', [
                            '-C', repoDir,
                            'log', '--all', '--no-color',
                            '--regexp-ignore-case',
                            '--extended-regexp',
                            '--pretty=format:COMMIT%x09%H%x09%aI',
                            '-p',
                            '-U0',
                            // `-G` already takes a regex; `--pickaxe-regex` only applies to
                            // `-S` and git aborts if both are given ("options '-G' and
                            // '--pickaxe-regex' cannot be used together"), which used to make
                            // the entire file-content history search fail silently.
                            '-G', combinedPattern,
                            `--max-count=${gitMaxCount}`,
                            '--',
                            '.'
                        ], fileHistoryLogOptions);

                        const lines = stdout.split('\n');
                        let currentCommit = null;
                        let currentDate = null;
                        let currentFile = null;
                        for (const rawLine of lines) {
                            if (findings.length >= maxTotalFindings) {
                                break;
                            }
                            const line = rawLine.trimEnd();
                            if (!line.trim()) {
                                continue;
                            }
                            if (line.startsWith('COMMIT\t')) {
                                const parts = line.split('\t');
                                currentCommit = parts[1] || null;
                                currentDate = parts[2] || null;
                                currentFile = null;
                                continue;
                            }
                            if (line.startsWith('diff --git ')) {
                                const match = rawLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
                                if (match) {
                                    currentFile = match[2];
                                }
                                continue;
                            }
                            if (!currentCommit || !currentFile) {
                                continue;
                            }
                            // Restrict to added/removed lines only; exclude diff headers.
                            if (!(line.startsWith('+') || line.startsWith('-')) || line.startsWith('+++') || line.startsWith('---')) {
                                continue;
                            }
                            const patchLine = line.slice(1);
                            for (const keyword of passKeywords) {
                                const existingCount = fileModeMatchCountByKeyword.get(keyword) || 0;
                                if (existingCount >= keywordConfig.maxMatchesPerKeyword) {
                                    continue;
                                }
                                const matches = fileHistoryMatcherMap.get(keyword);
                                if (!matches || !matches(patchLine)) {
                                    continue;
                                }
                                const added = addFinding(
                                    currentFile,
                                    keyword,
                                    `Keyword "${keyword}" found in historical file content changes`,
                                    currentCommit,
                                    currentDate
                                );
                                if (added) {
                                    fileModeMatchCountByKeyword.set(keyword, existingCount + 1);
                                }
                            }
                        }
                    };

                    // Process longer keywords with full history window.
                    await runFileHistoryPass(longKeywords);
                    // Process short/high-frequency keywords separately with a configurable git max-count cap.
                    await runFileHistoryPass(shortKeywords, {
                        maxCountCap: keywordConfig.shortKeywordFileHistoryMaxCount
                    });
                }
            }
        } catch (e) {
            console.warn('git-history file-content search failed:', e.message);
            passErrors.push('file content');
        }

        try {
            if (keywordConfig.searchFileNames) {
                this._scanProgress = { stage: 'process', message: 'Searching git history file names for configured keywords...' };
                this._updateWebviewContent();

                const perKeywordCap = keywordConfig.maxMatchesPerKeyword;
                const requestedMaxCount = Math.max(100, keywordConfig.keywords.length * perKeywordCap);
                const gitMaxCount = Math.min(maxFileNameHistoryLogCount, requestedMaxCount);
                const gitArgs = [
                    '-C', repoDir,
                    'log', '--all', '--no-color',
                    '--name-status',
                    '-z',
                    '--pretty=format:%H%x09%aI%x00',
                    `--max-count=${gitMaxCount}`,
                    '--',
                    '.'
                ];
                await new Promise((resolve, reject) => {
                    let currentCommit = null;
                    let currentDate = null;
                    let stdoutBuffer = '';
                    let stdoutBufferIndex = 0;
                    let stderrBuffer = '';
                    let pendingNameStatus = null;
                    let stoppedEarly = false;
                    let timedOut = false;
                    let settled = false;
                    const gitLog = spawn('git', gitArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
                    const stdoutDecoder = new StringDecoder('utf8');
                    const timeoutMs = Math.max(1000, gitLogOptions.timeout || 20000);
                    const timeoutHandle = setTimeout(() => {
                        timedOut = true;
                        gitLog.kill();
                    }, timeoutMs);

                    const settleResolve = () => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        clearTimeout(timeoutHandle);
                        resolve();
                    };

                    const settleReject = (error) => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        clearTimeout(timeoutHandle);
                        reject(error);
                    };

                    const emitFilePaths = (filePaths) => {
                        if (!Array.isArray(filePaths) || filePaths.length === 0) {
                            return;
                        }
                        for (const fileNamePath of filePaths) {
                            const fileNamePathLower = String(fileNamePath || '').toLowerCase();
                            for (const { keyword, matches } of fileNameKeywordMatchers) {
                                const existingCount = fileNameModeMatchCountByKeyword.get(keyword) || 0;
                                if (existingCount >= perKeywordCap) {
                                    continue;
                                }
                                if (!matches({ lowerText: fileNamePathLower })) {
                                    continue;
                                }
                                const added = addFinding(
                                    fileNamePath,
                                    keyword,
                                    `Keyword "${keyword}" found in historical file name`,
                                    currentCommit,
                                    currentDate
                                );
                                if (added) {
                                    fileNameModeMatchCountByKeyword.set(keyword, existingCount + 1);
                                }
                            }
                        }
                    };

                    const processNameStatusRecord = (rawRecord) => {
                        if (findings.length >= maxTotalFindings) {
                            if (!stoppedEarly) {
                                stoppedEarly = true;
                                gitLog.kill();
                            }
                            return;
                        }

                        // `git log --pretty=format:...` emits a newline between the
                        // commit header and its name-status list, so with -z the first
                        // status record arrives as "\nA" / "\nR100". That leading
                        // newline made the status-token check fail, so no file names
                        // were ever matched. Strip it.
                        const record = String(rawRecord || '').replace(/^\n+/, '');
                        if (!record) {
                            return;
                        }
                        // Detect commit headers by hash/date shape to avoid collisions with filenames.
                        let commitMatch = /^([0-9a-f]{40})\t([^\t]*)/i.exec(record);
                        if (!commitMatch) {
                            // Backward-compatible fallback for legacy markers.
                            commitMatch = /^COMMIT\t([0-9a-f]{40})\t([^\t]*)/i.exec(record);
                        }
                        if (commitMatch) {
                            currentCommit = commitMatch[1] || null;
                            currentDate = commitMatch[2] || null;
                            pendingNameStatus = null;
                            return;
                        }
                        if (!currentCommit) {
                            return;
                        }

                        if (pendingNameStatus) {
                            pendingNameStatus.paths.push(record);
                            if (pendingNameStatus.paths.length >= pendingNameStatus.expectedPathCount) {
                                emitFilePaths(pendingNameStatus.paths.slice(0, pendingNameStatus.expectedPathCount));
                                pendingNameStatus = null;
                            }
                            return;
                        }

                        const isNameStatusToken = (token) => /^[ACDMRTUXTB][0-9]*$/i.test(token);
                        let statusToken = '';
                        let initialPaths = [];
                        const tabIndex = record.indexOf('\t');
                        if (tabIndex !== -1) {
                            const maybeStatus = record.slice(0, tabIndex);
                            if (isNameStatusToken(maybeStatus)) {
                                statusToken = maybeStatus.toUpperCase();
                                const pathFromToken = record.slice(tabIndex + 1);
                                if (pathFromToken) {
                                    initialPaths.push(pathFromToken);
                                }
                            }
                        }
                        if (!statusToken && isNameStatusToken(record)) {
                            statusToken = record.toUpperCase();
                        }
                        if (!statusToken) {
                            return;
                        }

                        const expectedPathCount = (statusToken.startsWith('R') || statusToken.startsWith('C')) ? 2 : 1;
                        if (initialPaths.length >= expectedPathCount) {
                            emitFilePaths(initialPaths.slice(0, expectedPathCount));
                            return;
                        }
                        pendingNameStatus = {
                            expectedPathCount,
                            paths: initialPaths
                        };
                    };

                    const processStdoutBufferRecords = () => {
                        let nulIndex = stdoutBuffer.indexOf('\0', stdoutBufferIndex);
                        while (nulIndex !== -1) {
                            const record = stdoutBuffer.slice(stdoutBufferIndex, nulIndex);
                            stdoutBufferIndex = nulIndex + 1;
                            processNameStatusRecord(record);
                            nulIndex = stdoutBuffer.indexOf('\0', stdoutBufferIndex);
                        }

                        // Avoid unbounded growth while minimizing repeated string allocations.
                        if (stdoutBufferIndex > 1024 * 1024) {
                            stdoutBuffer = stdoutBuffer.slice(stdoutBufferIndex);
                            stdoutBufferIndex = 0;
                        }
                    };

                    gitLog.stdout.on('data', (chunk) => {
                        stdoutBuffer += stdoutDecoder.write(chunk);
                        processStdoutBufferRecords();
                    });

                    gitLog.stderr.on('data', (chunk) => {
                        stderrBuffer += chunk.toString();
                    });

                    gitLog.on('error', (error) => {
                        settleReject(error);
                    });

                    gitLog.on('close', (code, signal) => {
                        const flushText = stdoutDecoder.end();
                        if (flushText) {
                            stdoutBuffer += flushText;
                        }
                        processStdoutBufferRecords();
                        if (stdoutBufferIndex < stdoutBuffer.length) {
                            processNameStatusRecord(stdoutBuffer.slice(stdoutBufferIndex));
                        }
                        stdoutBuffer = '';
                        stdoutBufferIndex = 0;
                        if (stoppedEarly) {
                            settleResolve();
                            return;
                        }
                        if (timedOut) {
                            settleReject(new Error(`git log filename history timed out after ${timeoutMs}ms`));
                            return;
                        }
                        if (code === 0) {
                            settleResolve();
                            return;
                        }
                        const reason = signal ? `signal ${signal}` : `exit code ${code}`;
                        const stderrSnippet = stderrBuffer.trim();
                        const maxStderrLength = 600;
                        const truncatedStderr = stderrSnippet.length > maxStderrLength
                            ? `${stderrSnippet.slice(0, maxStderrLength)}...`
                            : stderrSnippet;
                        const context = `maxCount=${gitMaxCount}`;
                        const errorDetail = truncatedStderr ? `: ${truncatedStderr}` : '';
                        settleReject(new Error(`git log filename history failed (${reason}, ${context})${errorDetail}`));
                    });
                });
            }
        } catch (e) {
            console.warn('git-history file-name search failed:', e.message);
            passErrors.push('file names');
        }

        if (passErrors.length > 0) {
            const label = passErrors.join(', ');
            this._scanProgress = {
                stage: 'process',
                message: `Git-history keyword search could not finish for: ${label}.`
            };
            this._updateWebviewContent();
            vscode.window.showWarningMessage(
                `LeakLock: git-history keyword search could not finish for: ${label}. ` +
                'On a large repository this usually means the search hit its time or output limit. ' +
                'Any other passes still ran — see the logs for details.'
            );
        }

        return findings;
    }

    /**
     * Enrich scan results with git branch names (and commit dates as fallback).
     * Commit dates are primarily extracted from Nosey Parker provenance;
     * git commands are used for branch resolution and as a date fallback.
     * Batch-processes unique commit hashes to avoid redundant git calls.
     */
    async _enrichResultsWithGitInfo(results, scanPath) {
        if (!scanPath || !results || results.length === 0) {
            return;
        }

        const util = require('util');
        const execFileAsync = util.promisify(execFile);

        // Collect unique commit hashes (and track which need date fallback)
        const uniqueHashes = new Set();
        const needsDateFallback = new Set();
        for (const result of results) {
            if (result.commitHash) {
                uniqueHashes.add(result.commitHash);
                if (!result.commitDate) {
                    needsDateFallback.add(result.commitHash);
                }
            }
        }

        if (uniqueHashes.size === 0) {
            return;
        }

        // Limit enrichment work to keep git calls bounded on large result sets.
        const MAX_HASHES_TO_ENRICH = 200;
        const hashArray = [...uniqueHashes].slice(0, MAX_HASHES_TO_ENRICH);
        if (uniqueHashes.size > MAX_HASHES_TO_ENRICH) {
            console.warn(
                `[LeakLock] Git metadata enrichment limited to ${MAX_HASHES_TO_ENRICH} of ` +
                `${uniqueHashes.size} unique commit hashes. Some findings may not include branch/date metadata.`
            );
        }
        const repoDir = this._scanRepoRoot || scanPath;
        const commitInfo = new Map(); // hash -> { branches, fallbackDate }

        // Resolve commit metadata in parallel with limited concurrency
        const CONCURRENCY = 5;

        const resolveHash = async (hash) => {
            try {
                // Get commit date only if not already provided by Nosey Parker
                let commitDate = null;
                if (needsDateFallback.has(hash)) {
                    try {
                        const { stdout: dateOut } = await execFileAsync('git', [
                            '-C', repoDir,
                            'log', '-1', '--format=%aI', hash
                        ], { timeout: 5000 });
                        commitDate = dateOut.trim() || null;
                    } catch {
                        // commit may not exist locally
                    }
                }

                // Get branches containing this commit
                let branches = [];
                try {
                    const { stdout: branchOut } = await execFileAsync('git', [
                        '-C', repoDir,
                        'branch', '--no-color', '-a', '--contains', hash
                    ], { timeout: 10000 });
                    branches = branchOut.split('\n')
                        .map(b => b.trim().replace(/^\*\s*/, ''))
                        .filter(Boolean)
                        .filter(b =>
                            !b.includes('HEAD detached') &&
                            !b.includes('->') &&
                            !REMOTE_HEAD_FILTER_PATTERN.test(b)
                        );
                } catch {
                    // branch --contains can fail for orphaned commits
                }

                // Get tags that contain this commit (including git history)
                try {
                    const { stdout: tagOut } = await execFileAsync('git', [
                        '-C', repoDir,
                        'tag', '--contains', hash
                    ], { timeout: 10000 });
                    const tags = tagOut.split('\n')
                        .map(t => t.trim())
                        .filter(Boolean)
                        .map(t => `tag: ${t}`);
                    branches = branches.concat(tags);
                } catch {
                    // tag --contains can fail for orphaned commits
                }

                commitInfo.set(hash, { branches, fallbackDate: commitDate });
            } catch {
                // Commit may no longer exist in the repo (e.g., after rebase)
                commitInfo.set(hash, { branches: [], fallbackDate: null });
            }
        };

        // Process hashes in batches of CONCURRENCY
        for (let i = 0; i < hashArray.length; i += CONCURRENCY) {
            const batch = hashArray.slice(i, i + CONCURRENCY);
            await Promise.all(batch.map(resolveHash));
        }

        // Assign enriched info back to results
        for (const result of results) {
            if (result.commitHash && commitInfo.has(result.commitHash)) {
                const info = commitInfo.get(result.commitHash);
                result.commitBranches = info.branches.length > 0 ? info.branches : null;
                // Use NP-provided date first, fall back to git date
                if (!result.commitDate && info.fallbackDate) {
                    result.commitDate = info.fallbackDate;
                }
            }
        }
    }

    _isUntrackedWorkingTreeFile(filePath, relativeFile, isGitHistory) {
        if (isGitHistory) {
            return false;
        }
        if (!this._scanRepoRoot || !this._trackedFiles || !this._scanPath) {
            return false;
        }
        if (!relativeFile ||
            relativeFile === 'scan_output' ||
            relativeFile === 'git-history-reference' ||
            relativeFile === 'git-history-artifact' ||
            relativeFile.startsWith('git-history:')) {
            return false;
        }
        let absPath = filePath;
        if (!path.isAbsolute(absPath)) {
            absPath = path.join(this._scanPath, relativeFile);
        }
        if (!fs.existsSync(absPath)) {
            return false;
        }
        const relToRepo = path.relative(this._scanRepoRoot, absPath);
        if (!relToRepo || relToRepo.startsWith('..') || path.isAbsolute(relToRepo)) {
            return false;
        }
        const normalized = relToRepo.replace(/\\/g, '/');
        return !this._trackedFiles.has(normalized);
    }

    // Add method to update webview content
    _updateWebviewContent() {
        // Before the first render the caller is only staging state, and
        // createOrShow performs the single initial assignment. Assigning
        // webview.html tears down the iframe document and builds a new one;
        // doing that while VS Code's webview service worker is still
        // registering against the old document makes register() reject with
        // "InvalidStateError: The document is in an invalid state", which the
        // user sees as "Error loading webview: Could not register service
        // worker".
        if (this._panel && this._initialRenderDone) {
            this._panel.webview.html = this._getHtmlForWebview();
        }
    }

    _handleAddCustomRule(source, mode, replaceWith) {
        const outcome = this._addCustomRule(source, mode, replaceWith);
        if (!outcome.ok) {
            vscode.window.showErrorMessage(`Rule rejected: ${outcome.errors.join(' ')}`);
            return;
        }
        for (const warning of outcome.warnings) {
            vscode.window.showWarningMessage(warning);
        }
        this._updateWebviewContent();
    }

    /**
     * The manual redaction rule editor.
     *
     * Rendered whether or not the scan found anything, because the whole point is
     * content no scanner flags: an internal hostname, a private repository name, a
     * customer identifier. A clean scan is exactly when a user reaches for this.
     */
    _renderCustomRules() {
        const rules = this._getCustomRules();
        const previews = this._scanCleanup.customRulePreviews || {};

        const ruleRows = rules.map(rule => {
            const preview = previews[rule.id];
            let previewHtml = '';
            if (preview && preview.error) {
                previewHtml = `<div style="color: var(--vscode-editorWarning-foreground); font-size: 0.85em;">Preview failed: ${escapeHtml(preview.error)}</div>`;
            } else if (preview) {
                const zero = preview.commitCount === 0;
                previewHtml = `
                    <div style="font-size: 0.85em; margin-top: 4px; ${zero ? 'color: var(--vscode-editorWarning-foreground);' : 'color: var(--vscode-descriptionForeground);'}">
                        ${zero
                            ? '⚠️ Matches nothing in history. A rule that matches nothing is almost always a typo — check it before running a rewrite for it.'
                            : `Touches <strong>${preview.commitCount}${preview.truncated ? '+' : ''}</strong> commit(s), ${preview.files.length} file(s)${preview.branches.length ? `, on: <code>${escapeHtml(preview.branches.slice(0, 6).join(', '))}</code>` : ''}${preview.truncated ? ` — capped at ${preview.maxCount} commits, the real total is higher` : ''}`
                        }
                        ${preview.files.length ? `<div style="margin-top: 2px;">Files: <code>${escapeHtml(preview.files.slice(0, 8).join(', '))}</code>${preview.files.length > 8 ? ` and ${preview.files.length - 8} more` : ''}</div>` : ''}
                    </div>`;
            }

            return `
                <tr data-rule-id="${escapeHtml(rule.id)}">
                    <td style="font-family: monospace; word-break: break-all;">${escapeHtml(rule.source)}</td>
                    <td><span style="background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 1px 6px; border-radius: 8px; font-size: 0.8em;">${escapeHtml(rule.mode)}</span></td>
                    <td style="font-family: monospace;">${escapeHtml(rule.replaceWith)}</td>
                    <td style="white-space: nowrap;">
                        <button class="scan-button" data-rule-preview="${escapeHtml(rule.id)}" title="Show which commits, files and branches this rule touches — without changing anything.">🔍 Preview</button>
                        <button class="scan-button" data-rule-remove="${escapeHtml(rule.id)}">✕ Remove</button>
                    </td>
                </tr>
                ${previewHtml ? `<tr data-rule-id="${escapeHtml(rule.id)}"><td colspan="4">${previewHtml}</td></tr>` : ''}
            `;
        }).join('');

        return `
            <div class="scan-section" id="custom-rules-section" style="margin-top: 16px;">
                <h3 style="margin-bottom: 4px;">✏️ Manual redaction rules</h3>
                <p style="font-size: 0.9em; color: var(--vscode-descriptionForeground); margin-top: 0;">
                    Remove text no scanner flagged — an internal hostname, a private repository or team name, a
                    customer identifier, an old email domain. Rules run through the same reviewed, verified
                    cleanup as detected secrets: refs are refreshed, the push plan is shown, and the remote is
                    re-checked afterwards.
                </p>
                <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-end; margin: 10px 0;">
                    <label style="display: flex; flex-direction: column; font-size: 0.85em; flex: 2; min-width: 220px;">
                        Source text
                        <input type="text" id="custom-rule-source" placeholder="internal.corp.example.com" autocomplete="off"
                            style="padding: 6px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border);">
                    </label>
                    <label style="display: flex; flex-direction: column; font-size: 0.85em;">
                        Match
                        <select id="custom-rule-mode" style="padding: 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border);">
                            <option value="literal">literal</option>
                            <option value="regex">regex</option>
                        </select>
                    </label>
                    <label style="display: flex; flex-direction: column; font-size: 0.85em; flex: 1; min-width: 140px;">
                        Replace with
                        <input type="text" id="custom-rule-replacement" placeholder="${escapeHtml(redactionRules.DEFAULT_REPLACEMENT)}" autocomplete="off"
                            style="padding: 6px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border);">
                    </label>
                    <button class="scan-button" id="custom-rule-add">➕ Add rule</button>
                </div>
                ${rules.length === 0
                    ? '<p style="font-size: 0.85em; color: var(--vscode-descriptionForeground);">No manual rules yet. Rules persist across re-scans, because they are not tied to a scan result.</p>'
                    : `<table class="results-table">
                        <thead><tr><th>Source text</th><th style="width: 80px;">Match</th><th style="width: 20%;">Replace with</th><th style="width: 200px;">Actions</th></tr></thead>
                        <tbody>${ruleRows}</tbody>
                       </table>
                       <p style="font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-top: 6px;">
                           Preview each rule before running a cleanup. A history rewrite cannot be undone, and a
                           typed string arrives with none of the provenance a scan finding carries.
                       </p>`}
            </div>
        `;
    }

    /**
     * Per-finding engine attribution.
     *
     * Names the engines that found it and, just as importantly, the enabled engines
     * that did not. That single line is what turns "GitGuardian found more than you
     * did" from a mystery into a checkable fact.
     */
    _renderEngineAttribution(result) {
        const found = Array.isArray(result.engines) && result.engines.length
            ? result.engines
            : (result.engine ? [result.engine] : []);

        if (!found.length) {
            return '<span style="color: var(--vscode-descriptionForeground);">—</span>';
        }

        const labels = {
            gitleaks: 'Gitleaks',
            trufflehog: 'TruffleHog',
            noseyparker: 'Nosey Parker'
        };

        const badges = found.map(id => `
            <span style="display: inline-block; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 1px 6px; border-radius: 8px; font-size: 0.85em; margin: 1px 2px 1px 0;">
                ${escapeHtml(labels[id] || id)}
            </span>
        `).join('');

        const ranEngines = (this._scanCoverage?.engines || [])
            .filter(engine => engine.ok)
            .map(engine => engine.id);
        const missedBy = ranEngines.filter(id => !found.includes(id));
        const missedNote = missedBy.length
            ? `<div style="color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 2px;" title="These engines ran against the same repository and did not report this finding.">missed by ${escapeHtml(missedBy.map(id => labels[id] || id).join(', '))}</div>`
            : '';

        const verifiedBadge = result.verified === true
            ? `<div style="margin-top: 3px;"><span style="background: var(--vscode-testing-iconFailed, #d73a49); color: #fff; padding: 1px 6px; border-radius: 8px; font-size: 0.8em; font-weight: 600;" title="TruffleHog confirmed this credential is still live. Rotate it now — rewriting history does not revoke it.">VERIFIED LIVE</span></div>`
            : '';

        // A field nobody could supply is stated, so a blank cell meaning "nothing
        // here" is never confused with one meaning "this engine cannot tell you".
        const unavailable = Array.isArray(result.unavailableFields) && result.unavailableFields.length
            ? `<div style="color: var(--vscode-descriptionForeground); font-size: 0.8em; margin-top: 2px;" title="Not reported by the engine(s) that found this finding.">no ${escapeHtml(result.unavailableFields.join(', '))}</div>`
            : '';

        return `${badges}${verifiedBadge}${missedNote}${unavailable}`;
    }

    /**
     * What the scan actually covered.
     *
     * "No findings" is only meaningful next to this, so it is rendered with the
     * results — the scan-side counterpart to the ref-by-ref push plan that gates a
     * rewrite. Anything bounded says so; a silently truncated result set reads as
     * "we covered everything" when it did not.
     */
    _renderScanCoverage() {
        const coverage = this._scanCoverage;
        if (!coverage) {
            return '';
        }

        const engineRows = (coverage.engines || []).map(engine => {
            const status = engine.ok ? '✅' : '⚠️';
            const version = engine.version ? ` <code>${escapeHtml(engine.version)}</code>` : '';
            const findings = engine.ok ? ` — ${engine.findings} finding(s)` : '';
            const verified = engine.verified ? ` · <strong>${engine.verified} verified live</strong>` : '';
            const note = engine.note ? `<div style="color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-left: 20px;">${escapeHtml(engine.note)}</div>` : '';
            const warnings = (engine.warnings || []).map(w =>
                `<div style="color: var(--vscode-editorWarning-foreground); font-size: 0.9em; margin-left: 20px;">${escapeHtml(w)}</div>`
            ).join('');
            return `<li>${status} <strong>${escapeHtml(engine.displayName)}</strong>${version}${findings}${verified}${note}${warnings}</li>`;
        }).join('');

        const refs = coverage.refs || {};
        const remoteOnly = refs.remoteOnlyBranches || [];
        const refRefresh = coverage.refRefresh || {};
        const refreshNote = refRefresh.ok
            ? 'refs refreshed from origin before scanning'
            : `refs NOT refreshed (${escapeHtml(refRefresh.reason || 'unknown')}) — history that exists only on the remote may not have been scanned`;

        const incompleteBanner = coverage.incomplete
            ? `<div style="background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-editorWarning-foreground); padding: 10px; border-radius: 4px; margin-bottom: 10px;">
                    <strong>⚠️ Scan incomplete — these results are not exhaustive.</strong>
                    <div style="margin-top: 4px;">${escapeHtml(coverage.incompleteReason || '')}</div>
               </div>`
            : '';

        const strategy = coverage.strategy;
        const strategyHtml = strategy
            ? `<li>Execution: <strong>${escapeHtml(strategy.mode)}</strong>${strategy.mode === 'parallel' ? ` (${strategy.concurrency} at a time)` : ''} — ${escapeHtml(strategy.reason)}</li>`
            : '';
        const droppedHtml = strategy && strategy.dropped && strategy.dropped.length
            ? `<li style="color: var(--vscode-editorWarning-foreground);">⚠️ Engines skipped for host capacity: <code>${escapeHtml(strategy.dropped.join(', '))}</code>. Fewer engines means fewer findings — set <code>leakLock.scan.executionMode</code> to override.</li>`
            : '';

        const pullNote = coverage.imagePulled === false
            ? `<li>⚠️ Could not pull <code>${escapeHtml(coverage.image)}</code>; a cached image was used${coverage.imagePullError ? ` (${escapeHtml(coverage.imagePullError)})` : ''}</li>`
            : '';

        return `
            <div class="scan-coverage" style="margin: 12px 0; padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 4px;">
                ${incompleteBanner}
                <h3 style="margin: 0 0 8px 0; font-size: 1em;">📋 Scan coverage</h3>
                <p style="margin: 0 0 8px 0; font-size: 0.9em; color: var(--vscode-descriptionForeground);">
                    A result is only as good as what was examined. This is what this scan looked at.
                </p>
                <ul style="margin: 0; padding-left: 18px; font-size: 0.9em; line-height: 1.6;">
                    ${engineRows}
                    ${strategyHtml}
                    ${droppedHtml}
                    ${pullNote}
                    <li>Refs: ${refs.localBranches || 0} local branch(es), ${refs.remoteBranches || 0} remote branch(es), ${refs.tags || 0} tag(s), ${refs.stashes || 0} stash entr(ies) — ${refreshNote}</li>
                    ${remoteOnly.length ? `<li>Branches present only on the remote: <code>${escapeHtml(remoteOnly.join(', '))}</code></li>` : ''}
                    <li>Ruleset: <code>${escapeHtml(coverage.rulesetMode || 'default')}</code> · file-size limit: ${coverage.maxFileSizeMb ? `${coverage.maxFileSizeMb} MB` : 'none'} · timeout: ${coverage.timeoutSeconds}s · dependencies: <code>${escapeHtml(coverage.dependencyHandling)}</code></li>
                </ul>
            </div>
        `;
    }

    _getScanResultsSection() {
        // Show scanning progress
        if (this._isScanning) {
            return `
                <div class="scan-section">
                    <h2>🔍 Scanning Repository</h2>
                    <div class="scanning-progress">
                        <div class="spinner"></div>
                        <p class="progress-message">${escapeHtml(this._scanProgress?.message || 'Scanning in progress...')}</p>
                        <div class="progress-stages">
                            <span class="stage ${this._scanProgress?.stage === 'docker' ? 'active' : ''}">Docker Check</span>
                            <span class="stage ${this._scanProgress?.stage === 'pull' ? 'active' : ''}">Pull Image</span>
                            <span class="stage ${this._scanProgress?.stage === 'init' ? 'active' : ''}">Initialize</span>
                            <span class="stage ${this._scanProgress?.stage === 'scan' ? 'active' : ''}">Scan Files</span>
                            <span class="stage ${this._scanProgress?.stage === 'process' ? 'active' : ''}">Process Results</span>
                        </div>
                    </div>
                </div>
            `;
        }

        // Show results or empty state
        if (!this._scanResults || this._scanResults.length === 0) {
            return `
                <div class="scan-section">
                    <div class="empty-results">
                        <div class="empty-icon">🛡️</div>
                        <h2>No Security Issues Found!</h2>
                        <p>Great news! Your repository scan completed successfully with no secrets or credentials detected.</p>

                        ${this._renderScanCoverage()}
                        ${this._renderCustomRules()}

                        <div class="scan-summary">
                            <div class="summary-item">
                                <span class="summary-icon">✅</span>
                                <span>No API keys found</span>
                            </div>
                            <div class="summary-item">
                                <span class="summary-icon">✅</span>
                                <span>No passwords detected</span>
                            </div>
                            <div class="summary-item">
                                <span class="summary-icon">✅</span>
                                <span>No private keys found</span>
                            </div>
                            <div class="summary-item">
                                <span class="summary-icon">✅</span>
                                <span>No database credentials detected</span>
                            </div>
                        </div>

                        <div class="next-steps">
                            <h3>🎯 Keep Your Repository Secure</h3>
                            <ul>
                                <li>Run scans regularly, especially before commits</li>
                                <li>Set up pre-commit hooks for automatic scanning</li>
                                <li>Review dependency updates for potential secrets</li>
                                <li>Train your team on secure coding practices</li>
                            </ul>
                        </div>

                        <div class="action-buttons">
                            <button class="scan-button" onclick="requestNewScan()">
                                🔄 Scan Again
                            </button>
                            <button class="secondary-button" onclick="openSecurityGuide()">
                                📚 Security Best Practices
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }

        // Show actual results (existing logic)
        return this._getResultsHtml();
    }

    _generateFixCommand(replacements) {
        // This will handle the 'fix' command from webview
        this._fixSecrets(replacements);
    }

    _runBFGCommand(replacements) {
        // This will handle the 'runBFG' command from webview
        return this._executeBFGCleanup(replacements);
    }

    _openFile(file, line) {
        // Open file in editor
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            const filePath = path.isAbsolute(file) ? file : path.join(workspaceFolder.uri.fsPath, file);
            vscode.window.showTextDocument(vscode.Uri.file(filePath), {
                selection: new vscode.Range(line - 1, 0, line - 1, 0)
            });
        }
    }

    // Essential utility methods for scanning functionality
    async _checkDockerAvailability() {
        return new Promise((resolve) => {
            exec('docker --version', (error, stdout, stderr) => {
                if (error) {
                    resolve({ available: false, error: 'Docker not installed or not in PATH' });
                } else {
                    // Check if Docker daemon is running
                    exec('docker info', (daemonError) => {
                        if (daemonError) {
                            resolve({ available: false, error: 'Docker daemon not running' });
                        } else {
                            resolve({ available: true, version: stdout.trim() });
                        }
                    });
                }
            });
        });
    }

    /**
     * Read the scan engine settings from VS Code and normalise them.
     * All clamping lives in scan-engine-config so the values cannot drift from what
     * the engine will accept.
     */
    _getScanEngineSettings() {
        const config = vscode.workspace.getConfiguration('leakLock');
        return scanEngineConfig.normalizeScanSettings({
            image: config.get('noseyParker.image'),
            rulesetMode: config.get('noseyParker.ruleset'),
            suppressRedundant: config.get('noseyParker.suppressRedundant'),
            maxFileSizeMb: config.get('noseyParker.maxFileSizeMb'),
            includeIgnoredFiles: config.get('scan.includeIgnoredFiles'),
            refreshRefsBeforeScan: config.get('scan.refreshRefsBeforeScan'),
            timeoutSeconds: config.get('scan.timeoutSeconds')
        });
    }

    /**
     * Pull the pinned scanner image.
     *
     * A failed pull no longer resolves silently. Continuing with a cached image is
     * acceptable — doing it without telling anyone is how two machines running the same
     * extension version produced different findings on the same repository.
     *
     * @returns {Promise<{pulled: boolean, error: string|null}>}
     */
    async _pullNoseyParkerImage(settings) {
        const cfg = settings || this._getScanEngineSettings();
        return new Promise((resolve) => {
            execFile('docker', ['pull', cfg.image], { timeout: DOCKER_PULL_TIMEOUT }, (error) => {
                if (!error) {
                    resolve({ pulled: true, error: null });
                    return;
                }
                const message = error.message || String(error);
                console.warn(`Failed to pull ${cfg.image}, using cached image if present:`, message);
                vscode.window.showWarningMessage(
                    `Leak Lock could not pull ${cfg.image}. Scanning will continue with the locally cached image, ` +
                    'which may be a different version than expected.'
                );
                resolve({ pulled: false, error: message });
            });
        });
    }

    /**
     * Resolve the engine version actually in use, so it can be recorded on findings and
     * in exports. Never throws: an unknown version must not stop a scan.
     */
    async _resolveNoseyParkerVersion(settings) {
        const cfg = settings || this._getScanEngineSettings();
        try {
            const { stdout } = await runDockerCommand(
                scanEngineConfig.buildNoseyParkerVersionArgs({ settings: cfg }),
                { timeout: 30000 }
            );
            const firstLine = String(stdout || '').split('\n').map(l => l.trim()).filter(Boolean)[0];
            return firstLine || scanEngineConfig.NOSEYPARKER_PINNED_VERSION;
        } catch (error) {
            console.warn('Could not resolve Nosey Parker version:', error.message);
            return null;
        }
    }

    async _initializeDatastore(datastorePath) {
        try {
            // Validate the datastore path
            const validatedDatastorePath = validateDockerPath(datastorePath);

            // Aggressively remove existing datastore if it exists
            if (fs.existsSync(validatedDatastorePath)) {
                await this._cleanupTempFiles(validatedDatastorePath);
            }

            // Validate and ensure the parent directory exists
            const parentDir = validateDockerPath(path.dirname(validatedDatastorePath));
            if (!fs.existsSync(parentDir)) {
                fs.mkdirSync(parentDir, { recursive: true });
            }

            return new Promise((resolve, reject) => {
                try {
                    // Use safe Docker command construction with validation
                    const parentDir = validateDockerPath(path.dirname(validatedDatastorePath));
                    const datastoreName = sanitizeDockerVolumeName(path.basename(validatedDatastorePath));

                    const dockerArgs = scanEngineConfig.buildNoseyParkerDatastoreInitArgs({
                        parentMount: parentDir,
                        datastoreName,
                        settings: this._getScanEngineSettings()
                    });

                    runDockerCommand(dockerArgs).then(() => {
                        resolve();
                    }).catch(error => {
                        // If initialization fails, try to force cleanup and retry once
                        console.warn('Initial datastore init failed, trying cleanup and retry:', error.message);
                        this._cleanupTempFiles(validatedDatastorePath).then(() => {
                            // Retry initialization with same safe arguments
                            return runDockerCommand(dockerArgs);
                        }).then(() => {
                            resolve();
                        }).catch(retryError => {
                            reject(new Error(`Failed to initialize datastore after retry: ${retryError.message}\nStderr: ${retryError.stderr || ''}`));
                        });
                    });
                } catch (validationError) {
                    reject(new Error(`Path validation failed: ${validationError.message}`));
                }
            });
        } catch (error) {
            throw new Error(`Datastore initialization failed: ${error.message}`);
        }
    }

    /**
     * Which engines the user has enabled, in run order.
     * Gitleaks leads because it is the only maintained engine with a ruleset that can
     * still receive new detectors.
     */
    _getEnabledEngineIds() {
        const config = vscode.workspace.getConfiguration('leakLock');
        const configured = config.get('scan.engines');
        const ids = Array.isArray(configured) && configured.length
            ? configured
            : ['gitleaks', 'noseyparker'];
        const known = new Set(['gitleaks', 'trufflehog', 'noseyparker']);
        return ids.filter(id => known.has(id));
    }

    /**
     * How hard to push this machine.
     *
     * `auto` sizes the plan to the host; an explicit mode is honoured, because the user
     * knows their machine better than a heuristic does.
     */
    _chooseScanStrategy() {
        const config = vscode.workspace.getConfiguration('leakLock');
        return hostCapacity.chooseScanStrategy({
            engines: this._getEnabledEngineIds(),
            mode: config.get('scan.executionMode') || 'auto'
        });
    }

    /**
     * Nosey Parker as a self-contained engine task, so it can be scheduled alongside
     * the others rather than always running first.
     */
    async _runNoseyParkerEngine(scanPath, settings) {
        const cfg = settings || this._getScanEngineSettings();
        const pullResult = await this._pullNoseyParkerImage(cfg);
        const version = await this._resolveNoseyParkerVersion(cfg);

        // Datastore lives in the OS temp directory, never inside the tree being
        // scanned — otherwise the scanner enumerates its own SQLite database and
        // Leak Lock writes into the repository it is auditing.
        const datastoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'leaklock-datastore-'));
        const tempDatastore = validateDockerPath(path.join(datastoreRoot, 'noseyparker.np'), [datastoreRoot]);

        try {
            await this._initializeDatastore(tempDatastore);
            const scanRun = await this._runNoseyParkerScan(scanPath, tempDatastore, cfg);
            const results = (scanRun.results || []).map(
                result => this._stampEngine(result, version, 'noseyparker')
            );
            scanRun.results = results;
            return {
                id: 'noseyparker',
                results,
                scanRun,
                pullResult,
                version,
                report: {
                    id: 'noseyparker',
                    displayName: 'Nosey Parker',
                    version,
                    ok: !scanRun.incomplete,
                    findings: results.length,
                    note: scanEngineConfig.NOSEYPARKER_ARCHIVED_NOTICE
                }
            };
        } finally {
            await this._cleanupTempFiles(tempDatastore);
            try {
                fs.rmSync(datastoreRoot, { recursive: true, force: true });
            } catch {
                // Best effort; the directory lives in the OS temp directory.
            }
        }
    }

    /**
     * Run one external engine and map its findings through the shared post-processing.
     *
     * Never throws: a missing or failing engine disables that engine, never the scan,
     * and says so in the report the coverage panel renders.
     */
    async _runExternalEngine(engineId, scanPath, settings) {
        const cfg = settings || this._getScanEngineSettings();
        const config = vscode.workspace.getConfiguration('leakLock');
        const engine = scanEngines.getEngine(engineId);
        if (!engine) {
            return { id: engineId, results: [], report: null };
        }

        const binary = config.get(`${engineId}.binaryPath`) || undefined;
        let available = false;
        try {
            available = await engine.isAvailable({ binary });
        } catch {
            available = false;
        }
        if (!available) {
            return {
                id: engine.id,
                results: [],
                report: {
                    id: engine.id,
                    displayName: engine.displayName,
                    version: null,
                    ok: false,
                    findings: 0,
                    note: `Not installed or not on PATH. Install: ${engine.installHint}`
                }
            };
        }

        const version = await engine.version({ binary });

        try {
            const scanOptions = { repoDir: scanPath, binary, timeoutMs: cfg.timeoutMs };
            if (engine.id === 'gitleaks') {
                scanOptions.maxTargetMegabytes = cfg.maxFileSizeMb > 0 ? cfg.maxFileSizeMb : undefined;
                scanOptions.configPath = config.get('gitleaks.configPath') || undefined;
                scanOptions.baselinePath = config.get('gitleaks.baselinePath') || undefined;
            }
            if (engine.id === 'trufflehog') {
                // Verification makes read-only calls to third-party providers using
                // the discovered credential. Off unless the user asked for it.
                scanOptions.verify = config.get('trufflehog.verify') === true;
            }

            const outcome = await engine.scan(scanOptions);
            const results = (outcome.findings || []).map(finding =>
                this._createResultFromEngineFinding(finding, engine.id, version, engine.capabilities)
            );
            return {
                id: engine.id,
                results,
                report: {
                    id: engine.id,
                    displayName: engine.displayName,
                    version,
                    ok: true,
                    findings: results.length,
                    verified: outcome.verified || 0,
                    warnings: outcome.warnings || [],
                    note: engine.capabilities.verification && scanOptions.verify === false
                        ? 'Credential verification disabled; findings are unverified.'
                        : null
                }
            };
        } catch (error) {
            console.warn(`${engine.displayName} scan failed:`, error.message);
            return {
                id: engine.id,
                results: [],
                report: {
                    id: engine.id,
                    displayName: engine.displayName,
                    version,
                    ok: false,
                    findings: 0,
                    note: `Scan failed: ${error.message}`
                }
            };
        }
    }

    /**
     * True when the user asked for dependency directories to be excluded from scanning
     * rather than merely flagged.
     */
    _shouldExcludeDependencies() {
        const config = vscode.workspace.getConfiguration('leakLock');
        return (config.get('dependencyHandling') || 'warning') === 'exclude';
    }

    /**
     * Materialise the gitignore-syntax exclude file that backs
     * `dependencyHandling: "exclude"`. Written outside the scanned tree.
     *
     * @returns {{dir: string, file: string}|null}
     */
    _writeDependencyIgnoreFile() {
        try {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaklock-ignore-'));
            const file = path.join(dir, 'leaklock-ignore');
            fs.writeFileSync(file, scanEngineConfig.buildDependencyIgnoreFile(), { mode: 0o600 });
            return { dir, file };
        } catch (error) {
            console.warn('Could not write dependency ignore file:', error.message);
            return null;
        }
    }

    /**
     * Run the scan and produce the report.
     *
     * Returns `{ results, incomplete, incompleteReason }` rather than a bare array: a
     * timed-out scan now reports whatever the datastore already holds instead of
     * throwing everything away, and the caller has to know the difference between
     * "found nothing" and "stopped looking".
     */
    async _runNoseyParkerScan(scanPath, datastorePath, settings) {
        const cfg = settings || this._getScanEngineSettings();

        let validatedScanPath;
        let validatedDatastorePath;
        try {
            validatedScanPath = validateDockerPath(scanPath);
            validatedDatastorePath = validateDockerPath(datastorePath);
        } catch (validationError) {
            throw new Error(`Path validation failed: ${validationError.message}`);
        }

        const ignoreFile = this._shouldExcludeDependencies() ? this._writeDependencyIgnoreFile() : null;

        const scanArgs = scanEngineConfig.buildNoseyParkerScanArgs({
            scanMount: validatedScanPath,
            datastoreMount: validatedDatastorePath,
            ignoreFileMount: ignoreFile ? ignoreFile.file : null,
            settings: cfg
        });

        let scanStdout = '';
        let scanStderr = '';
        let incomplete = false;
        let incompleteReason = null;

        try {
            const result = await runDockerCommand(scanArgs, { timeout: cfg.timeoutMs });
            scanStdout = result.stdout;
            scanStderr = result.stderr;
        } catch (scanError) {
            scanStdout = scanError.stdout || '';
            scanStderr = scanError.stderr || '';
            if (scanError.timedOut) {
                // The datastore is written incrementally, so the report below still has
                // real findings in it. Surfacing those beats reporting zero.
                incomplete = true;
                incompleteReason =
                    `The scan was stopped after ${Math.round(cfg.timeoutMs / 1000)}s. ` +
                    'These results cover only the part of the repository that was scanned. ' +
                    'Raise leakLock.scan.timeoutSeconds and rescan for complete coverage.';
            } else if (scanError.code !== 2) {
                // Exit code 2 is routine for Nosey Parker and does not indicate failure.
                console.error('Scan error details:', {
                    message: scanError.message,
                    stdout: scanError.stdout,
                    stderr: scanError.stderr
                });
                throw new Error(`Scan failed: ${scanError.message}\nStderr: ${scanError.stderr || ''}`);
            }
        } finally {
            if (ignoreFile) {
                try {
                    fs.rmSync(ignoreFile.dir, { recursive: true, force: true });
                } catch {
                    // Best effort; the file lives in the OS temp directory.
                }
            }
        }

        const reportArgs = scanEngineConfig.buildNoseyParkerReportArgs({
            datastoreMount: validatedDatastorePath,
            settings: cfg
        });

        let results;
        try {
            const { stdout: reportStdout } = await runDockerCommand(reportArgs, { timeout: cfg.timeoutMs });
            try {
                results = this._parseNoseyParkerResults(reportStdout);
            } catch (parseError) {
                console.warn('Failed to parse JSON results, using fallback:', parseError.message);
                results = this._createFallbackResults(reportStdout + scanStdout);
                incomplete = true;
                incompleteReason = incompleteReason ||
                    'The scanner output could not be parsed as JSON, so findings were recovered from text and carry no secret values.';
            }
        } catch (reportError) {
            console.warn('Report command failed, falling back to text parsing:', reportError.message);
            results = this._createFallbackResults(scanStdout + scanStderr);
            incomplete = true;
            incompleteReason = incompleteReason ||
                `The report step failed (${reportError.message}), so findings were recovered from text and are not exhaustive.`;
        }

        return { results: results || [], incomplete, incompleteReason };
    }

    /**
     * Extract file path from Nosey Parker match object, trying multiple possible locations
     */
    _extractFilePathFromMatch(match) {
        // Try multiple possible locations for file path in order of preference
        const possiblePaths = [
            match.provenance?.[0]?.path,           // Standard provenance path
            match.location?.source_file,           // Alternative location field
            match.source?.file,                    // Another possible source field
            match.file_path,                       // Direct file path field
            match.location?.path,                  // Location path
            match.provenance?.[0]?.source_file,    // Alternative provenance source
            match.source_path,                     // Source path field
            match.path,                            // Simple path field
            match.location?.source_span?.source_id, // Source span ID
            match.provenance?.[0]?.source_id,      // Provenance source ID
            match.source_id                        // Direct source ID
        ];

        // Check for git repository provenance with blob path (git history only)
        if (match.provenance && Array.isArray(match.provenance)) {
            for (const prov of match.provenance) {
                if (prov.kind === 'git_repo' && prov.first_commit && prov.first_commit.blob_path) {
                    possiblePaths.unshift(prov.first_commit.blob_path); // Add to front of list
                }
            }
        }

        // Return the first non-null, non-undefined, non-empty path
        for (const path of possiblePaths) {
            if (path && typeof path === 'string' && path.trim() !== '') {
                let cleanPath = path.trim();

                // Clean up Docker mount path prefixes
                if (cleanPath.startsWith('/scan/')) {
                    cleanPath = cleanPath.substring(6);
                }

                // If still empty after cleaning, continue to next path
                if (cleanPath === '') {
                    continue;
                }

                return cleanPath;
            }
        }

        // Try to extract path from nested objects more aggressively
        if (match.location && typeof match.location === 'object') {
            const locationKeys = Object.keys(match.location);
            for (const key of locationKeys) {
                if (key.includes('file') || key.includes('path') || key.includes('source')) {
                    const value = match.location[key];
                    if (value && typeof value === 'string' && value.trim() !== '') {
                        let cleanPath = value.trim();
                        if (cleanPath.startsWith('/scan/')) {
                            cleanPath = cleanPath.substring(6);
                        }
                        if (cleanPath !== '') {
                            return cleanPath;
                        }
                    }
                }
            }
        }

        // Try to extract from provenance more aggressively
        if (match.provenance && Array.isArray(match.provenance) && match.provenance.length > 0) {
            const prov = match.provenance[0];
            if (prov && typeof prov === 'object') {
                const provKeys = Object.keys(prov);
                for (const key of provKeys) {
                    if (key.includes('file') || key.includes('path') || key.includes('source')) {
                        const value = prov[key];
                        if (value && typeof value === 'string' && value.trim() !== '') {
                            let cleanPath = value.trim();
                            if (cleanPath.startsWith('/scan/')) {
                                cleanPath = cleanPath.substring(6);
                            }
                            if (cleanPath !== '') {
                                return cleanPath;
                            }
                        }
                    }
                }
            }
        }

        // If still no valid path found, return a meaningful fallback
        // Log only non-sensitive metadata from match object
        return 'file_path_not_found';
    }

    /**
     * Extract actual file path from git history artifacts by analyzing git-related metadata
     */
    _extractActualPathFromGitHistory(match, finding) {
        // Try to extract file path from git commit or object information
        if (match.provenance && Array.isArray(match.provenance)) {
            for (const prov of match.provenance) {
                // Look for git repository information with first_commit data
                if (prov.kind === 'git_repo' && prov.first_commit) {
                    const firstCommit = prov.first_commit;
                    if (firstCommit.blob_path) {
                        return firstCommit.blob_path;
                    }
                }

                // Look for commit information that might contain file paths
                if (prov.commit_metadata) {
                    const commitInfo = prov.commit_metadata;
                    if (commitInfo.file_path || commitInfo.path) {
                        return commitInfo.file_path || commitInfo.path;
                    }
                }

                // Look for blob or tree information
                if (prov.blob_metadata) {
                    const blobInfo = prov.blob_metadata;
                    if (blobInfo.file_path || blobInfo.path) {
                        return blobInfo.file_path || blobInfo.path;
                    }
                }
            }
        }

        // Try to extract from finding metadata
        if (finding && finding.metadata) {
            if (finding.metadata.file_path || finding.metadata.path) {
                return finding.metadata.file_path || finding.metadata.path;
            }
        }

        // Try to extract from match location with git context
        if (match.location && match.location.source_span) {
            const sourceSpan = match.location.source_span;
            if (sourceSpan.file_path || sourceSpan.path) {
                return sourceSpan.file_path || sourceSpan.path;
            }
        }

        // If all else fails, try to parse git object paths
        const gitObjectPattern = /\.git\/objects\/[0-9a-f]{2}\/[0-9a-f]{38}/;
        const gitRefPattern = /\.git\/refs\/(heads|tags|remotes)\/([a-zA-Z0-9._/-]+)/;

        if (match.provenance?.[0]?.path) {
            const path = match.provenance[0].path;

            if (gitRefPattern.test(path)) {
                const refMatch = path.match(gitRefPattern);
                return `git-ref:${refMatch[2]} (${refMatch[1]})`;
            }

            if (gitObjectPattern.test(path)) {
                return 'git-object (commit/tree/blob)';
            }
        }

        return 'unknown';
    }

    _parseNoseyParkerResults(output) {
        const results = [];

        if (!output.trim()) {
            return results;
        }

        try {
            // Parse JSON output from Nosey Parker report command
            const jsonFindings = JSON.parse(output);

            // Debug logging for external directory scanning
            console.log(`Parsing Nosey Parker results. Selected directory: ${this._selectedDirectory}`);
            console.log(`Found ${Array.isArray(jsonFindings) ? jsonFindings.length : 0} findings`);

            if (Array.isArray(jsonFindings)) {
                jsonFindings.forEach((finding, findingIndex) => {
                    finding.matches?.forEach((match, matchIndex) => {
                        let filePath = this._extractFilePathFromMatch(match);

                        const line = match.location?.source_span?.start?.line ||
                            match.location?.line ||
                            match.line_number ||
                            1;
                        const secretText = match.snippet?.matching ||
                            match.snippet?.before ||
                            match.content ||
                            match.text ||
                            'content_unavailable';

                        // Debug logging for path extraction
                        if (filePath === 'file_path_not_found') {
                            console.warn('No file path found in match');
                        }

                        // Skip non-git version control artifacts, but allow git history results
                        if (filePath === 'version-control-artifact' || filePath.includes('/.svn/') || filePath.includes('/.hg/')) {
                            console.log(`Skipping non-git version control artifact: ${filePath}`);
                            return; // Skip this result
                        }

                        // For git history artifacts, try to extract meaningful file information
                        if (filePath === 'git-history-artifact' || (filePath.includes('/.git/') && !filePath.includes('(git-history)'))) {
                            console.log(`Found git history artifact, extracting file info: ${filePath}`);
                            // Try to get file path from git object or commit information
                            const actualPath = this._extractActualPathFromGitHistory(match, finding);
                            if (actualPath && actualPath !== 'unknown') {
                                filePath = actualPath;
                            } else {
                                // If we can't extract meaningful path, mark it as git history
                                filePath = 'git-history-reference';
                            }
                        }

                        const result = this._createResult(
                            filePath,
                            line,
                            secretText,
                            finding.rule_name || 'Secret detected',
                            finding.rule_name,
                            match
                        );
                        results.push(result);
                    });
                });
            }
        } catch (jsonError) {
            console.warn('JSON parsing failed, trying line-by-line:', jsonError.message);

            // Try parsing as JSONL (JSON Lines format)
            const lines = output.split('\n').filter(line => line.trim());

            lines.forEach(line => {
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.matches && Array.isArray(parsed.matches)) {
                        parsed.matches.forEach(match => {
                            let filePath = this._extractFilePathFromMatch(match);
                            const lineNumber = match.location?.line ||
                                match.line_number ||
                                match.location?.source_span?.start?.line ||
                                1;
                            const secretText = match.snippet ||
                                match.content ||
                                match.text ||
                                'content_unavailable';

                            // Skip non-git version control artifacts (JSONL parsing)
                            if (filePath === 'version-control-artifact' || filePath.includes('/.svn/') || filePath.includes('/.hg/')) {
                                console.log(`Skipping non-git version control artifact (JSONL): ${filePath}`);
                                return; // Skip this result
                            }

                            // Handle git history artifacts in JSONL parsing
                            if (filePath === 'git-history-artifact' || (filePath.includes('/.git/') && !filePath.includes('(git-history)'))) {
                                const actualPath = this._extractActualPathFromGitHistory(match, parsed);
                                if (actualPath && actualPath !== 'unknown') {
                                    filePath = actualPath;
                                } else {
                                    filePath = 'git-history-reference';
                                }
                            }

                            results.push(this._createResult(
                                filePath,
                                lineNumber,
                                secretText,
                                match.rule_name || parsed.rule_name || 'Secret detected',
                                match.rule_name || parsed.rule_name,
                                match
                            ));
                        });
                    }
                } catch (lineError) {
                    // Skip invalid JSON lines, but log for debugging
                    // Avoid logging full line content to prevent leaking sensitive data
                    console.warn('Failed to parse JSON line at index', lines.indexOf(line), '-', lineError.message);
                }
            });
        }

        return results;
    }

    _createFallbackResults(output) {
        const results = [];
        const lines = output.split('\n');

        // Improved patterns that might indicate secrets were found with better file path extraction
        const secretPatterns = [
            // Pattern for "Found secret in file:line"
            /Found.*secret.*in\s+([^\s:]+):(\d+)/i,
            // Pattern for "file:line potential secret"  
            /([^\s:]+):(\d+).*potential.*secret/i,
            // Pattern for "Secret detected in file:line"
            /Secret.*detected.*in\s+([^\s:]+):(\d+)/i,
            // Pattern for "/scan/path/to/file:line"
            /\/scan\/([^\s:]+):(\d+)/i,
            // Pattern for general file paths with line numbers
            /([a-zA-Z0-9\/_\-\.]+\.[a-zA-Z0-9]+):(\d+)/i
        ];

        lines.forEach(line => {
            for (const pattern of secretPatterns) {
                const match = line.match(pattern);
                if (match) {
                    let filePath = match[1];
                    // Clean up common Docker mount path prefixes
                    if (filePath.startsWith('/scan/')) {
                        filePath = filePath.substring(6);
                    }

                    // Skip non-git version control artifacts in fallback parsing
                    if (filePath.includes('/.svn/') || filePath.includes('/.hg/')) {
                        console.log(`Skipping non-git version control artifact (fallback): ${filePath}`);
                        continue; // Try next pattern
                    }

                    // Handle git artifacts in fallback parsing
                    if (filePath.includes('/.git/') || filePath.startsWith('.git/') || filePath === '.git') {
                        // In fallback parsing, we don't have detailed match info, so mark as git history
                        filePath = 'git-history-reference';
                    }

                    results.push(this._createResult(
                        filePath,
                        parseInt(match[2]) || 1,
                        '***hidden***',
                        'Secret detected (details hidden)',
                        'fallback_detection',
                        null
                    ));
                    break;
                }
            }
        });

        // If no patterns matched but there's output, create a generic result
        if (results.length === 0 && (output.includes('secret') || output.includes('finding'))) {
            results.push(this._createResult(
                'scan_output',
                1,
                '***scan completed***',
                'Scan completed - check console output for details',
                'info',
                null
            ));
        }

        console.log(`_parseNoseyParkerResults returning ${results.length} total results`);
        return results;
    }

    _getRelativeFilePath(filePath) {
        if (typeof filePath === 'string' && filePath.startsWith('git-history:')) {
            return filePath;
        }

        // If scanning external directory (not workspace), show relative path from selected directory
        if (this._selectedDirectory) {
            // If path is absolute and starts with selected directory, make it relative
            if (filePath.startsWith(this._selectedDirectory)) {
                return filePath.substring(this._selectedDirectory.length + 1);
            }

            // If it's a relative path already, prefix with selected directory name for context
            if (!filePath.startsWith('/') && !filePath.includes(':')) {
                const dirName = require('path').basename(this._selectedDirectory);
                return `${dirName}/${filePath}`;
            }
        }

        // Fallback to workspace-based path handling
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder && filePath.startsWith(workspaceFolder.uri.fsPath)) {
            return filePath.substring(workspaceFolder.uri.fsPath.length + 1);
        }

        // Clean up Docker mount paths and other prefixes
        let cleanPath = filePath.replace(/^\/scan\//, '').replace(/^\//, '');

        // Handle .git paths from git history scanning
        if (cleanPath.includes('/.git/') || cleanPath.startsWith('.git/')) {
            // Extract project name from .git paths for context
            const gitMatch = cleanPath.match(/^(.+?)\/\.git\/.+$/);
            if (gitMatch) {
                // For git history results, we'll get the actual file path from Nosey Parker's metadata
                // This is just a fallback - the main logic should extract proper paths
                return gitMatch[1] + '/.git (git-history)';
            }
            return 'git-history-artifact';
        }

        // Filter out other version control artifacts
        if (cleanPath.includes('/.svn/') || cleanPath.includes('/.hg/')) {
            return 'version-control-artifact';
        }

        // If path is still empty, return the original
        if (cleanPath === '') {
            return filePath;
        }

        return cleanPath;
    }

    _truncateSecret(secret) {
        if (secret.length > SECRET_TRUNCATE_LENGTH) {
            return secret.substring(0, SECRET_TRUNCATE_LENGTH) + '...';
        }
        return secret;
    }

    _getSeverity(ruleName) {
        if (!ruleName) return 'medium';

        const highRisk = ['api_key', 'secret_key', 'private_key', 'password', 'token'];
        const mediumRisk = ['url', 'connection_string', 'config'];

        const lower = ruleName.toLowerCase();
        if (highRisk.some(risk => lower.includes(risk))) return 'high';
        if (mediumRisk.some(risk => lower.includes(risk))) return 'medium';
        return 'low';
    }

    _createResult(filePath, line, secret, description, ruleName, match = null, options = null) {
        const normalizedOptions = options && typeof options === 'object' ? options : {};
        const relativeFile = this._getRelativeFilePath(filePath);
        const isInDependency = this._isInDependencyDirectory(relativeFile);

        // Check if this result comes from git history by examining provenance
        let isGitHistory = false;
        if (match && match.provenance && Array.isArray(match.provenance)) {
            isGitHistory = match.provenance.some(prov => prov.kind === 'git_repo');
        }
        // Also check legacy path-based detection
        isGitHistory = isGitHistory ||
            filePath.startsWith('git-ref:') ||
            filePath.startsWith('git-object') ||
            filePath.startsWith('git-history:') ||
            filePath === 'git-history-reference';
        if (normalizedOptions.forceGitHistory === true) {
            isGitHistory = true;
        }

        // Get dependency handling configuration
        const config = vscode.workspace.getConfiguration('leakLock');
        const dependencyHandling = config.get('dependencyHandling') || 'warning';

        // Enhanced description for git history results
        let enhancedDescription = description;
        if (isGitHistory) {
            enhancedDescription = `${description} (found in git history)`;
        }

        // Determine severity based on configuration
        let severity = this._getSeverity(ruleName);
        if (isInDependency && dependencyHandling === 'warning') {
            severity = 'warning';
        }

        const isUntracked = this._isUntrackedWorkingTreeFile(filePath, relativeFile, isGitHistory);
        if (isUntracked) {
            enhancedDescription = `${description} (not committed)`;
            severity = 'safe';
        }

        // Extract commit hash and date from Nosey Parker provenance metadata
        // NP structure: provenance[].first_commit.commit_metadata.{commit_id, committer_timestamp, author_timestamp}
        let commitHash = null;
        let commitDate = null;
        if (match && match.provenance && Array.isArray(match.provenance)) {
            for (const prov of match.provenance) {
                if (prov.kind === 'git_repo' && prov.first_commit) {
                    const meta = prov.first_commit.commit_metadata;
                    if (meta) {
                        if (meta.commit_id) {
                            commitHash = meta.commit_id;
                        }
                        commitDate = meta.author_timestamp || meta.committer_timestamp || null;
                    }
                    if (commitHash) {
                        break;
                    }
                }
            }
        }

        // Engines other than Nosey Parker carry provenance in their own JSON rather
        // than in an NP `match` object, so they supply it here. Everything below this
        // point is engine-agnostic: one severity rule, one dependency rule, one
        // truncation rule, for every engine.
        if (typeof normalizedOptions.commitHash === 'string' && normalizedOptions.commitHash) {
            commitHash = normalizedOptions.commitHash;
        }
        if (normalizedOptions.commitDate) {
            commitDate = normalizedOptions.commitDate;
        }

        const fullSecret = typeof secret === 'string' ? secret : String(secret);
        const displaySecret = this._truncateSecret(fullSecret);
        const includeInCleanup = normalizedOptions.includeInCleanup !== false;
        const result = {
            file: relativeFile,
            line: line,
            secret: displaySecret,
            fullSecret: fullSecret,
            isSecretTruncated: displaySecret !== fullSecret,
            description: enhancedDescription,
            severity: severity,
            isDependency: isInDependency,
            includeInCleanup: includeInCleanup,
            originalSeverity: this._getSeverity(ruleName),
            ruleName: ruleName || '',
            isGitHistory: isGitHistory,
            isUntracked: isUntracked,
            commitHash: commitHash,
            commitBranches: null,
            commitDate: commitDate
        };

        // Additive detail from engines that supply more than Nosey Parker does
        // (columns, entropy, author, fingerprint, live-credential verification).
        // Never overwrites a field above: parity is a floor, not a ceiling.
        if (normalizedOptions.extraFields && typeof normalizedOptions.extraFields === 'object') {
            for (const [key, value] of Object.entries(normalizedOptions.extraFields)) {
                if (value === null || value === undefined) {
                    continue;
                }
                if (!Object.prototype.hasOwnProperty.call(result, key)) {
                    result[key] = value;
                }
            }
        }

        // A credential confirmed live by TruffleHog outranks any rule-name heuristic.
        // Nothing in this repository matters more than a key that still works.
        if (result.verified === true && !isInDependency && !isUntracked) {
            result.severity = 'high';
            result.description = `${result.description} — VERIFIED LIVE credential`;
        }

        return result;
    }

    /**
     * Map one normalised engine finding onto the shared result shape.
     *
     * Deliberately routes through _createResult so a Gitleaks or TruffleHog finding is
     * classified, scored and truncated by exactly the same rules as a Nosey Parker one.
     */
    _createResultFromEngineFinding(finding, engineId, engineVersion, capabilities) {
        const filePath = finding.file || 'unknown';
        const secret = finding.secret || finding.matchText || '';
        const result = this._createResult(
            filePath,
            Number.isFinite(finding.line) ? finding.line : 1,
            secret,
            finding.description || finding.ruleId || 'Potential secret',
            finding.ruleId || '',
            null,
            {
                forceGitHistory: finding.isGitHistory === true,
                commitHash: finding.commitHash || null,
                commitDate: finding.commitDate || null,
                extraFields: {
                    endLine: finding.endLine,
                    startColumn: finding.startColumn,
                    endColumn: finding.endColumn,
                    entropy: finding.entropy,
                    fingerprint: finding.fingerprint,
                    author: finding.author,
                    authorEmail: finding.authorEmail,
                    commitMessage: finding.commitMessage,
                    verified: finding.verified,
                    verifiedAt: finding.verifiedAt
                }
            }
        );
        // Fields this engine cannot supply are marked, not left blank — a blank cell
        // meaning "nothing here" must not be confused with one meaning "unknown".
        result.unavailableFields = (capabilities && capabilities.unavailable) || [];
        return this._stampEngine(result, engineVersion, engineId);
    }

    _isInDependencyDirectory(filePath) {
        // Common dependency and build artifact directories to flag as warnings
        const dependencyPatterns = [
            'node_modules/', 'npm-cache/', '.npm/',
            'venv/', 'env/', '.venv/', '__pycache__/', '.tox/', 'site-packages/',
            'dist/', 'build/', '*.egg-info/',
            'target/', '.m2/', 'lib/', 'libs/',
            'vendor/', '.bundle/', 'gems/',
            'vendor/', 'composer/',
            'vendor/', 'go.sum',
            'target/', 'Cargo.lock',
            'packages/', 'bin/', 'obj/', 'nuget/',
            '.git/', '.svn/', '.hg/',
            'dist/', 'build/', 'out/', 'tmp/', 'temp/',
            'cache/', '.cache/', 'logs/', '.logs/',
            '.vscode/', '.idea/', '.eclipse/', '.settings/'
        ];

        return dependencyPatterns.some(pattern => {
            if (pattern.endsWith('/')) {
                return filePath.includes(pattern);
            }
            return filePath.includes('/' + pattern) || filePath.endsWith(pattern);
        });
    }

    async _cleanupTempFiles(datastorePath) {
        try {
            // Validate the datastore path before any operations
            const validatedDatastorePath = validateDockerPath(datastorePath);

            if (fs.existsSync(validatedDatastorePath)) {
                // Try multiple approaches to remove files
                try {
                    fs.rmSync(validatedDatastorePath, { recursive: true, force: true });
                } catch (fsError) {
                    console.warn('fs.rmSync failed, trying Docker cleanup:', fsError.message);

                    // Use Docker to clean up files that might have been created with root permissions
                    // But avoid using --user root for security
                    const parentDir = validateDockerPath(path.dirname(validatedDatastorePath));
                    const datastoreName = sanitizeDockerVolumeName(path.basename(validatedDatastorePath));

                    const cleanupArgs = [
                        'run', '--rm',
                        '-v', `${parentDir}:/workspace`,
                        'alpine:latest',
                        'rm', '-rf', `/workspace/${datastoreName}`
                    ];
                    await runDockerCommand(cleanupArgs);
                }
            }
        } catch (error) {
            console.warn('All cleanup attempts failed:', error.message);
            // Instead of using --user root (security risk), just log the failure
            // Files will be cleaned up when the container terminates or by the OS
            console.warn(`Unable to cleanup ${datastorePath}. Files may remain until container cleanup.`);
        }
    }

    /**
     * Accept either the legacy `{ source: replaceWith }` map or a list of rules, and
     * always produce rules. The map form has no way to express regex mode, so manual
     * rules carry it explicitly rather than having it inferred at the point of use.
     */
    _toRuleList(input) {
        if (Array.isArray(input)) {
            return input.map(rule => ({
                source: rule.source,
                mode: rule.mode === 'regex' ? 'regex' : 'literal',
                replaceWith: rule.replaceWith
            }));
        }
        if (input && typeof input === 'object') {
            return Object.entries(input).map(([source, replaceWith]) => ({
                source,
                mode: 'literal',
                replaceWith
            }));
        }
        return [];
    }

    _buildReplacementScriptSetup(replacements) {
        const replacementLines = this._toRuleList(replacements)
            .map(rule => redactionRules.formatRuleLine(rule))
            .join("\n");
        return {
            preambleLines: [
                "# Keep sensitive replacement data outside the repository.",
                "umask 077",
                'replacement_file="$(mktemp "${TMPDIR:-/tmp}/leak-lock-replacements.XXXXXX")"',
                "trap " + gitRewrite.shellQuote('rm -f "$replacement_file"') + " EXIT",
                'chmod 600 "$replacement_file"',
                `printf "%s" ${gitRewrite.shellQuote(replacementLines)} > "$replacement_file"`
            ],
            exitCleanupCommand: 'rm -f "$replacement_file"'
        };
    }

    async _withSecureReplacementsFile(replacements, callback) {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "leak-lock-"));
        try {
            try {
                fs.chmodSync(tempDir, 0o700);
            } catch (permissionError) {
                if (process.platform !== "win32") {
                    throw permissionError;
                }
            }
            const replacementsFile = path.join(tempDir, "replacements.txt");
            const replacementLines = this._toRuleList(replacements)
                .map(rule => redactionRules.formatRuleLine(rule))
                .join("\n");
            fs.writeFileSync(replacementsFile, replacementLines, { mode: 0o600, flag: "wx" });
            return await callback(replacementsFile);
        } finally {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (cleanupError) {
                console.warn("Failed to remove secure replacement directory:", cleanupError);
            }
        }
    }

    _buildScanBfgReplaceCommand(scanPath, replacements) {
        const bfgPath = path.join(this._extensionUri.fsPath, "bfg.jar");
        const secureSetup = this._buildReplacementScriptSetup(replacements);
        return gitRewrite.buildRewriteScript({
            repoDir: scanPath,
            remote: gitRewrite.DEFAULT_REMOTE,
            requiredCommands: ['git', 'java'],
            rewriteLines: [
                `java -jar ${gitRewrite.shellQuote(bfgPath)} --replace-text "$replacement_file"`
            ],
            // Verification re-reads the same rule file the rewrite consumed, so each
            // secret appears exactly once in the script — inside the owner-only temp
            // file — instead of being repeated in a grep line per rule. It also cannot
            // drift from what was actually rewritten.
            verifyRulesFile: '"$replacement_file"',
            ...secureSetup
        });
    }

    _buildScanGitReplaceCommand(scanPath, replacements, remoteUrl = null) {
        const secureSetup = this._buildReplacementScriptSetup(replacements);
        return gitRewrite.buildRewriteScript({
            repoDir: scanPath,
            remote: gitRewrite.DEFAULT_REMOTE,
            requiredCommands: ['git', 'git-filter-repo'],
            rewriteLines: [
                'git filter-repo --replace-text "$replacement_file" --force'
            ],
            verifyRulesFile: '"$replacement_file"',
            restoreRemote: true,
            remoteUrl,
            ...secureSetup
        });
    }

    /**
     * Single source of truth for "can this finding be cleaned?".
     * The row renderer and the replacement resolver used to disagree, so
     * git-history keyword hits rendered as selectable but were silently dropped.
     */
    _isCleanupEligible(result) {
        return !!result
            && !result.isDependency
            && result.includeInCleanup !== false;
    }

    /** Why a finding's checkbox is disabled - shown as its tooltip so the user
     *  understands why "Select all" leaves it unchecked. */
    _cleanupIneligibleReason(result) {
        if (!result) {
            return 'Not cleanable.';
        }
        if (result.isDependency) {
            return 'Third-party dependency (node_modules, vendor, …), not your code — not selectable. Fix it by updating the package, not by rewriting your history.';
        }
        if (result.includeInCleanup === false) {
            return 'Excluded from cleanup.';
        }
        return 'Not cleanable.';
    }

    /** Indices of every finding that can be cleaned. */
    _eligibleFindingIndexes() {
        const indexes = [];
        this._scanResults.forEach((result, index) => {
            if (this._isCleanupEligible(result)) {
                indexes.push(index);
            }
        });
        return indexes;
    }

    /** Lazily seeds the selection with all eligible findings (previous default). */
    _ensureScanSelection() {
        if (!this._scanCleanup.selection) {
            this._scanCleanup.selection = new Set(this._eligibleFindingIndexes());
        }
        return this._scanCleanup.selection;
    }

    /** Called whenever _scanResults is replaced - old indices no longer apply. */
    _resetScanSelection() {
        this._scanCleanup.selection = null;
        this._scanCleanup.replacementValues = {};
    }

    _getReplacementValue(index) {
        const stored = this._scanCleanup.replacementValues[index];
        return typeof stored === 'string' && stored.length > 0
            ? stored
            : redactionRules.DEFAULT_REPLACEMENT;
    }

    // ---- Manual redaction rules -------------------------------------------------
    //
    // Content no scanner flags — an internal hostname, a private repository name, a
    // customer identifier — is removed through the same reviewed, verified pipeline as
    // a detected secret rather than by hand-rolling BFG outside the extension.

    _nextCustomRuleId() {
        this._customRuleCounter = (this._customRuleCounter || 0) + 1;
        return `rule-${this._customRuleCounter}-${this._stableHash(String(this._customRuleCounter))}`;
    }

    _getCustomRules() {
        return Array.isArray(this._scanCleanup.customRules) ? this._scanCleanup.customRules : [];
    }

    /**
     * @returns {{ok: boolean, errors: string[], warnings: string[], rule: object|null}}
     */
    _addCustomRule(source, mode, replaceWith) {
        const candidate = {
            source: typeof source === 'string' ? source : '',
            mode: mode === 'regex' ? 'regex' : 'literal',
            replaceWith: typeof replaceWith === 'string' ? replaceWith : ''
        };
        const validation = redactionRules.validateRule(candidate);
        if (!validation.valid) {
            return { ok: false, errors: validation.errors, warnings: validation.warnings, rule: null };
        }
        const rule = redactionRules.normalizeRule(candidate, () => this._nextCustomRuleId());
        const existing = this._getCustomRules();
        // Re-adding the same source in the same mode edits it rather than producing a
        // second rule that silently shadows the first.
        const duplicate = existing.find(r => r.source === rule.source && r.mode === rule.mode);
        if (duplicate) {
            duplicate.replaceWith = rule.replaceWith;
            this._scanCleanup.customRulePreviews[duplicate.id] = null;
            return { ok: true, errors: [], warnings: validation.warnings, rule: duplicate };
        }
        existing.push(rule);
        this._scanCleanup.customRules = existing;
        return { ok: true, errors: [], warnings: validation.warnings, rule };
    }

    _removeCustomRule(id) {
        this._scanCleanup.customRules = this._getCustomRules().filter(rule => rule.id !== id);
        delete this._scanCleanup.customRulePreviews[id];
    }

    /**
     * Every rule the cleanup will apply: selected findings plus manual rules.
     *
     * Findings are always literal — the value is the secret itself. Manual rules carry
     * their own mode, which has to survive all the way to the rewrite-rule file.
     */
    _resolveCleanupRules(replacements) {
        const fromFindings = this._resolveScanReplacements(replacements);
        const rules = Object.entries(fromFindings).map(([source, replaceWith]) => ({
            source,
            mode: 'literal',
            replaceWith
        }));
        for (const rule of this._getCustomRules()) {
            // A manual rule for a string a scanner also found must not produce two
            // identical lines in the rewrite file.
            if (rules.some(r => r.source === rule.source && r.mode === rule.mode)) {
                continue;
            }
            rules.push({ source: rule.source, mode: rule.mode, replaceWith: rule.replaceWith });
        }
        return rules;
    }

    /**
     * Dry run: what would this rule actually touch?
     *
     * A finding arrives with provenance; a typed string arrives with none. Committing
     * to an irreversible rewrite without knowing whether a rule matches three commits
     * or three thousand is not something this product should ask of anyone — the same
     * reasoning behind the ref-by-ref push plan.
     */
    async _previewCustomRule(id) {
        const rule = this._getCustomRules().find(r => r.id === id);
        if (!rule) {
            return null;
        }
        const repoDir = this._scanPath || this._selectedDirectory || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!repoDir) {
            vscode.window.showErrorMessage('No repository selected to preview against.');
            return null;
        }

        const util = require('util');
        const execFileAsync = util.promisify(execFile);
        const maxCount = 200;
        try {
            const { stdout } = await execFileAsync(
                'git',
                ['-C', repoDir, ...redactionRules.buildPreviewArgs(rule, { maxCount })],
                { timeout: 60000, maxBuffer: GIT_MAX_BUFFER }
            );
            const parsed = redactionRules.parsePreviewOutput(stdout);
            const branches = await this._branchesContainingCommits(
                repoDir, parsed.commits.map(c => c.hash).slice(0, 25)
            );
            const preview = {
                commitCount: parsed.commits.length,
                commits: parsed.commits.slice(0, 20),
                files: parsed.files,
                branches,
                // A bounded preview says so; a silently truncated one reads as
                // "this is everything" when it is not.
                truncated: parsed.commits.length >= maxCount,
                maxCount
            };
            this._scanCleanup.customRulePreviews[id] = preview;
            this._updateWebviewContent();
            return preview;
        } catch (error) {
            console.warn('Rule preview failed:', error.message);
            this._scanCleanup.customRulePreviews[id] = { error: error.message };
            this._updateWebviewContent();
            return null;
        }
    }

    async _branchesContainingCommits(repoDir, hashes) {
        const util = require('util');
        const execFileAsync = util.promisify(execFile);
        const branches = new Set();
        for (const hash of hashes) {
            try {
                const { stdout } = await execFileAsync(
                    'git', ['-C', repoDir, 'branch', '--no-color', '-a', '--contains', hash],
                    { timeout: 10000 }
                );
                for (const line of stdout.split('\n')) {
                    const name = line.replace(/^[*+]?\s*/, '').trim();
                    if (name && !REMOTE_HEAD_FILTER_PATTERN.test(name)) {
                        branches.add(name);
                    }
                }
            } catch {
                // A branch listing failure degrades the preview; it must not stop it.
            }
        }
        return Array.from(branches);
    }

    _setScanSelection(index, selected) {
        const idx = Number(index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= this._scanResults.length) {
            return;
        }
        if (!this._isCleanupEligible(this._scanResults[idx])) {
            return;
        }
        const selection = this._ensureScanSelection();
        if (selected) {
            selection.add(idx);
        } else {
            selection.delete(idx);
        }
    }

    _setAllScanSelection(selected) {
        this._scanCleanup.selection = selected
            ? new Set(this._eligibleFindingIndexes())
            : new Set();
    }

    _setScanReplacement(index, value) {
        const idx = Number(index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= this._scanResults.length) {
            return;
        }
        this._scanCleanup.replacementValues[idx] = typeof value === 'string' ? value : '';
    }

    /**
     * Build the secret -> replacement map. Which findings are included comes
     * from persisted selection state (authoritative, so a dropped message can't
     * silently widen or narrow the cleanup). The replacement VALUE prefers the
     * prepare payload, which collectReplacements() reads live from the DOM at
     * click time — this beats the debounced state, so a value typed immediately
     * before clicking Prepare is never stale.
     */
    _resolveScanReplacements(replacements) {
        const resolved = {};
        const payloadByIdx = {};

        if (replacements && typeof replacements === 'object') {
            for (const [key, replacement] of Object.entries(replacements)) {
                if (key.startsWith('idx:')) {
                    payloadByIdx[key.slice(4)] = replacement;
                    continue;
                }
                // Backward compatibility for callers that pass secret->replacement maps.
                resolved[key] = replacement || '*****';
            }
        }

        const selection = this._ensureScanSelection();
        for (const idx of selection) {
            const result = this._scanResults[idx];
            if (!this._isCleanupEligible(result)) {
                continue;
            }
            const secretValue = result.fullSecret || result.secret;
            if (!secretValue) {
                continue;
            }
            const fresh = payloadByIdx[String(idx)];
            const value = (typeof fresh === 'string' && fresh.length > 0)
                ? fresh
                : this._getReplacementValue(idx);
            // Keep extension state in sync so a later re-render shows the same value.
            this._scanCleanup.replacementValues[idx] = value;
            resolved[secretValue] = value;
        }

        return resolved;
    }

    async _prepareScanReplacementCommand(mode, replacements) {
        // Manual rules count toward the cleanup: a user with three rules and no
        // selected findings is the exact case the feature exists for, and used to be
        // refused here.
        const resolvedReplacements = this._resolveCleanupRules(replacements);
        if (!resolvedReplacements || resolvedReplacements.length === 0) {
            vscode.window.showWarningMessage('Nothing selected for removal. Select a finding or add a manual redaction rule.');
            return;
        }
        const scanPath = this._scanPath || this._selectedDirectory || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!scanPath) {
            vscode.window.showErrorMessage('No directory selected or workspace available.');
            return;
        }
        this._scanCleanup.preparing = true;
        this._scanCleanup.blockedBranches = null;
        this._scanCleanup.blockedReason = null;
        this._scanCleanup.verifyResult = null;
        this._scanCleanup.refreshError = null;
        this._scanCleanup.preparedRepo = null;
        this._updateWebviewContent();
        try {
            // Preflight: refresh every ref, then refuse to plan a rewrite that
            // would discard unpushed local commits (LL-001).
            const preflight = await this._rewritePreflight(scanPath);
            if (preflight.blocked) {
                this._scanCleanup.blockedBranches = preflight.ahead;
                this._scanCleanup.blockedReason = preflight.reason;
                this._scanCleanup.preparedCommand = null;
                this._scanCleanup.preparedMode = null;
                return;
            }
            this._scanCleanup.blockedReason = null;

            const command = mode === "git"
                ? this._buildScanGitReplaceCommand(scanPath, resolvedReplacements, preflight.remoteUrl)
                : this._buildScanBfgReplaceCommand(scanPath, resolvedReplacements);
            this._scanCleanup.preparedCommand = command;
            this._scanCleanup.preparedMode = mode;
            this._scanCleanup.replacements = resolvedReplacements;
            this._scanCleanup.replacementsFile = null;
            this._scanCleanup.pushPlan = preflight.pushPlan;
            // Execute exactly what was planned. The BFG executor used to resolve its
            // own repository and could pick a different one than the plan and the push
            // plan the user reviewed.
            this._scanCleanup.preparedRepo = scanPath;
            // A script the user can read, save and run by hand is still produced when
            // refs could not be refreshed; only the in-panel run is withheld, because
            // that is the step LL-001 guards.
            this._scanCleanup.refreshError = preflight.refreshError || null;
            if (preflight.refreshError) {
                vscode.window.showWarningMessage(
                    `${preflight.refreshError.message} The cleanup script was still generated — you can save and run it ` +
                    'manually; it refreshes refs itself before rewriting anything.'
                );
            }
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to prepare cleanup: ${e.message}`);
        } finally {
            this._scanCleanup.preparing = false;
            this._updateWebviewContent();
        }
    }

    /**
     * Shared rewrite preflight: refresh all refs, build the ref-by-ref push
     * plan (LL-002), and detect local branches whose commits a rewrite would
     * discard (LL-001). Returns { blocked, ahead, pushPlan, remoteUrl }.
     */
    async _rewritePreflight(repoDir, remote = gitRewrite.DEFAULT_REMOTE) {
        const hasRemote = await gitRewrite.hasRemote(repoDir, remote);
        if (!hasRemote) {
            // The whole flow is remote-centric: runRewrite() fetches from and
            // force-pushes to the remote. Without one, every prepared plan would
            // fail on the first `git fetch ... ${remote}`. Block instead of
            // offering a script that cannot run.
            vscode.window.showErrorMessage(
                `No "${remote}" remote is configured. Add one (git remote add ${remote} <url>) and prepare again — ` +
                `history cleanup rewrites and pushes every remote branch and tag.`
            );
            return { blocked: true, reason: 'no-remote', ahead: [], pushPlan: null, remoteUrl: null, refreshError: null };
        }
        // Refreshing refs is required before a rewrite (LL-001), but it is a network
        // operation and it must not be a hard gate on *generating* the script. A
        // remote behind SSO, an expired token, being offline or on the wrong VPN would
        // otherwise leave the user with nothing at all — exactly when a script they can
        // run by hand is most useful. So: attempt it, record the failure, and let the
        // caller decide. Execution is gated separately.
        let refreshError = null;
        try {
            await gitRewrite.fetchAllRefs(repoDir, remote);
            const fetchedAt = new Date().toISOString();
            this._recordFetchAt(repoDir, fetchedAt);
            // Keep the Remove Files indicator in sync when this is its repo.
            if (repoDir === this._removalState.repoDir) {
                this._removalState.lastFetchAt = fetchedAt;
            }
        } catch (error) {
            refreshError = summarizeGitRemoteError(error);
        }

        const unsafe = await gitRewrite.findUnsafeLocalBranches(repoDir, remote);
        if (unsafe.ahead.length > 0) {
            vscode.window.showErrorMessage(
                `Cannot rewrite history: ${unsafe.ahead.length} local branch(es) have commits that are not on ${remote}. ` +
                `Push them first, then prepare again.`
            );
            return { blocked: true, reason: 'unpushed-commits', ahead: unsafe.ahead, pushPlan: null, remoteUrl: null, refreshError };
        }

        const pushPlan = await gitRewrite.buildPushPlan(repoDir, remote);
        const remoteUrl = await gitRewrite.getRemoteUrl(repoDir, remote);
        return { blocked: false, ahead: [], pushPlan, remoteUrl, localOnly: unsafe.localOnly, refreshError };
    }

    async _prepareScanBfgCommand(replacements) {
        await this._prepareScanReplacementCommand('bfg', replacements);
    }

    async _prepareScanGitCommand(replacements) {
        await this._prepareScanReplacementCommand('git', replacements);
    }

    async _runPreparedScanCleanup(mode) {
        if (!this._scanCleanup.preparedCommand || this._scanCleanup.preparedMode !== mode) {
            vscode.window.showWarningMessage('Prepare the cleanup command first.');
            return;
        }
        // LL-001 guards the *rewrite*, not the script. If refs could not be refreshed
        // the plan may be stale, so the in-panel run is refused — but the generated
        // script remains available to save and run by hand, and it refreshes refs
        // itself before touching anything.
        if (this._scanCleanup.refreshError) {
            vscode.window.showErrorMessage(
                `Cannot run the cleanup from the panel: ${this._scanCleanup.refreshError.message} ` +
                'Use "Save as .sh" and run the script once the remote is reachable, or fix access and prepare again.'
            );
            return;
        }
        const replacements = this._scanCleanup.replacements;
        if (!replacements || Object.keys(replacements).length === 0) {
            vscode.window.showWarningMessage('No secrets selected for removal.');
            return;
        }
        if (mode === 'git') {
            await this._executeGitCleanup(replacements);
        } else {
            await this._executeBFGCleanup(replacements);
        }
        this._scanCleanup.preparedCommand = null;
        this._scanCleanup.preparedMode = null;
        this._scanCleanup.replacements = null;
        this._scanCleanup.replacementsFile = null;
        this._updateWebviewContent();
    }

    async _executeGitCleanup(replacements) {
        if (!replacements || Object.keys(replacements).length === 0) {
            vscode.window.showWarningMessage('No secrets selected for removal.');
            return;
        }

        // The repository the plan and the push plan the user reviewed were built for.
        const scanPath = this._scanCleanup.preparedRepo
            || this._scanPath || this._selectedDirectory || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!scanPath) {
            vscode.window.showErrorMessage('No directory selected or workspace available.');
            return;
        }

        const proceed = await vscode.window.showWarningMessage(
            `⚠️ WARNING: This will permanently modify your git history!\n\nThis action will:\n• Remove ${Object.keys(replacements).length} secrets from git history\n• Run git cleanup operations\n• Cannot be undone easily\n\nMake sure you have a backup!`,
            { modal: true },
            'Proceed with Git Cleanup',
            'Cancel'
        );

        if (proceed !== 'Proceed with Git Cleanup') {
            return;
        }

        let report = null;
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Running git-only cleanup...",
                cancellable: false
            }, async (progress) => {
                progress.report({ increment: 10, message: "Preparing secure temporary replacement file..." });
                const util = require("util");
                const execFileAsync = util.promisify(execFile);

                report = await this._withSecureReplacementsFile(replacements, async (replacementsFile) =>
                    gitRewrite.runRewrite({
                        repoDir: scanPath,
                        push: false,
                        progress: (message) => progress.report({ increment: 10, message }),
                        rewrite: async () => {
                            await execFileAsync(
                                "git",
                                ["filter-repo", "--replace-text", replacementsFile, "--force"],
                                { cwd: scanPath, maxBuffer: GIT_MAX_BUFFER }
                            );
                        }
                    })
                );
            });

            this._stagePushForConfirmation(
                'Git-only cleanup', scanPath, report,
                redactionRules.partitionForVerification(this._toRuleList(replacements))
            );
        } catch (error) {
            if (error instanceof gitRewrite.AheadBranchesError) {
                this._scanCleanup.blockedBranches = error.branches;
                this._updateWebviewContent();
            }
            vscode.window.showErrorMessage(`Git-only cleanup failed: ${error.message}`);
        }
    }

    /**
     * Phase A finished: the LOCAL history has been rewritten but the remote is
     * untouched. Stage the force-push and surface a persistent confirmation in
     * the panel — nothing reaches the remote until the user confirms it there.
     */
    _stagePushForConfirmation(label, repoDir, report, verify) {
        this._scanCleanup.verifyResult = null;
        this._scanCleanup.pendingPush = {
            repoDir,
            remote: gitRewrite.DEFAULT_REMOTE,
            verify,
            label,
            refCount: report ? (report.materialized || []).length : 0,
            remoteRestored: report ? !!report.remoteRestored : false
        };
        for (const warning of (report && report.warnings) || []) {
            vscode.window.showWarningMessage(warning);
        }
        this._updateWebviewContent();
        vscode.window.showInformationMessage(
            `${label}: local history rewritten. Review the confirmation in the panel and confirm to force-push — the remote has not been changed yet.`
        );
    }

    /**
     * Phase B: the user confirmed in the panel. Force-push the rewritten history
     * and verify. Only now is the remote changed.
     */
    async _confirmForcePush() {
        const pending = this._scanCleanup.pendingPush;
        if (!pending) {
            vscode.window.showWarningMessage('Nothing staged to push. Run a cleanup first.');
            return;
        }
        let offenders = null;
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Force-pushing rewritten history...',
                cancellable: false
            }, async (progress) => {
                progress.report({ increment: 30, message: 'Force-pushing every branch and tag...' });
                await gitRewrite.pushRewritten(pending.repoDir, pending.remote);
                progress.report({ increment: 60, message: 'Verifying every remote ref...' });
                offenders = await gitRewrite.verifyRemoteRefs(pending.repoDir, pending.remote, pending.verify || {});
            });

            this._scanCleanup.verifyResult = offenders;
            this._scanCleanup.pendingPush = null;

            if (offenders && offenders.length > 0) {
                const refs = offenders.map(o => `${o.ref} (${o.reason})`).join(', ');
                vscode.window.showErrorMessage(
                    `⚠️ ${pending.label}: force-push done but the target is STILL PRESENT on: ${refs}`
                );
                this._updateWebviewContent();
            } else {
                vscode.window.showInformationMessage(
                    `✅ ${pending.label}: rewritten history force-pushed and verified clean on every remote ref. Everyone with a clone must now re-clone or hard-reset.`
                );
                // The findings no longer reflect the rewritten history.
                this._scanResults = [];
                this._resetScanSelection();
                this._updateWebviewContent();
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Force-push failed: ${error.message}`);
            this._updateWebviewContent();
        }
    }

    /** The user declined the force-push. The local rewrite stays; the remote is untouched. */
    _cancelForcePush() {
        if (!this._scanCleanup.pendingPush) {
            return;
        }
        this._scanCleanup.pendingPush = null;
        this._updateWebviewContent();
        vscode.window.showWarningMessage(
            'Force-push cancelled. Your LOCAL history was rewritten, but the remote was NOT changed. ' +
            'To discard the local rewrite, re-clone the repository; to push later, prepare and run the cleanup again.'
        );
    }

    /**
     * Surface what actually reached the remote: which refs were force-updated
     * and whether the leak survived anywhere.
     */
    _reportRewriteOutcome(label, report) {
        if (!report) {
            vscode.window.showInformationMessage(`✅ ${label} completed.`);
            return;
        }
        for (const warning of report.warnings || []) {
            vscode.window.showWarningMessage(warning);
        }
        if (report.remoteRestored) {
            const remoteName = report.remote || 'the remote';
            vscode.window.showInformationMessage(
                `The "${remoteName}" remote was missing after the rewrite (some rewrite tools drop it); Leak Lock restored it before pushing.`
            );
        }
        const refCount = (report.materialized || []).length;
        if (report.offenders && report.offenders.length > 0) {
            const refs = report.offenders.map(o => `${o.ref} (${o.reason})`).join(', ');
            vscode.window.showErrorMessage(
                `⚠️ ${label} finished but the target is STILL PRESENT on: ${refs}`
            );
            return;
        }
        vscode.window.showInformationMessage(
            `✅ ${label} completed. ${refCount} branch(es) plus tags force-pushed and verified clean on every remote ref.`
        );
    }

    async _fixSecrets(replacements) {
        if (!replacements || Object.keys(replacements).length === 0) {
            vscode.window.showWarningMessage('No secrets selected for fixing.');
            return;
        }

        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('No workspace folder found.');
                return;
            }

            // Create a temporary replacements file for BFG
            const replacementsFile = path.join(workspaceFolder.uri.fsPath, 'secrets-replacements.txt');
            const replacementLines = Object.entries(replacements).map(([secret, replacement]) =>
                `${secret}==>${replacement}`
            ).join('\n');

            fs.writeFileSync(replacementsFile, replacementLines);

            // Generate BFG command
            const bfgCommand = `java -jar bfg.jar --replace-text ${replacementsFile}`;
            const manualCommand = `cd ${workspaceFolder.uri.fsPath} && ${bfgCommand} && git reflog expire --expire=now --all && git gc --prune=now --aggressive`;

            // Show the manual command to the user
            const action = await vscode.window.showInformationMessage(
                `Ready to fix ${Object.keys(replacements).length} secrets. This will modify your git history.`,
                { modal: true },
                'Show Manual Command',
                'Cancel'
            );

            if (action === 'Show Manual Command') {
                vscode.window.showInformationMessage('Manual fix command generated.');

                // Create a document with the command
                const document = await vscode.workspace.openTextDocument({
                    content: `# Leak Lock - Manual Secret Fix Command\n\n${manualCommand}\n\n# Warning: This will rewrite git history!\n# Make sure to backup your repository first.\n# After running, you may need to force push with: git push --force-with-lease`,
                    language: 'bash'
                });

                vscode.window.showTextDocument(document);
            }

            // Clean up the temporary file
            try {
                fs.unlinkSync(replacementsFile);
            } catch (cleanupError) {
                console.warn('Failed to clean up temporary file:', cleanupError);
            }

        } catch (error) {
            console.error('Fix secrets error:', error);
            vscode.window.showErrorMessage(`Failed to generate fix command: ${error.message}`);
        }
    }

    async _executeBFGCleanup(replacements) {
        if (!replacements || Object.keys(replacements).length === 0) {
            vscode.window.showWarningMessage('No secrets selected for removal.');
            return;
        }

        try {
            // Was `this._selectedDirectory || workspaceFolders[0]`, which omitted the
            // scanned path entirely: a BFG cleanup could rewrite a repository that was
            // never scanned, planned, or shown in the push plan.
            const scanPath = this._scanCleanup.preparedRepo
                || this._scanPath || this._selectedDirectory || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!scanPath) {
                vscode.window.showErrorMessage('No directory selected or workspace available.');
                return;
            }

            // Show confirmation dialog
            const proceed = await vscode.window.showWarningMessage(
                `⚠️ WARNING: This will permanently modify your git history!\n\nThis action will:\n• Remove ${Object.keys(replacements).length} secrets from git history\n• Run git cleanup operations\n• Cannot be undone easily\n\nMake sure you have a backup!`,
                { modal: true },
                'Proceed with BFG Cleanup',
                'Cancel'
            );

            if (proceed !== 'Proceed with BFG Cleanup') {
                return;
            }

            let report = null;
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Running BFG cleanup...",
                cancellable: false
            }, async (progress) => {

                progress.report({ increment: 10, message: "Preparing secure temporary replacement file..." });
                const bfgPath = path.join(this._extensionUri.fsPath, "bfg.jar");
                const util = require("util");
                const execFileAsync = util.promisify(execFile);

                report = await this._withSecureReplacementsFile(replacements, async (replacementsFile) =>
                    gitRewrite.runRewrite({
                        repoDir: scanPath,
                        push: false,
                        progress: (message) => progress.report({ increment: 10, message }),
                        rewrite: async () => {
                            const bfgResult = await execFileAsync(
                                "java",
                                ["-jar", bfgPath, "--replace-text", replacementsFile],
                                { cwd: scanPath, maxBuffer: GIT_MAX_BUFFER }
                            );
                            console.log("BFG result:", bfgResult.stdout);
                        }
                    })
                );
            });

            this._stagePushForConfirmation(
                'BFG cleanup', scanPath, report,
                redactionRules.partitionForVerification(this._toRuleList(replacements))
            );

        } catch (error) {
            console.error('BFG execution error:', error);
            if (error instanceof gitRewrite.AheadBranchesError) {
                this._scanCleanup.blockedBranches = error.branches;
                this._updateWebviewContent();
            }
            vscode.window.showErrorMessage(`❌ BFG cleanup failed: ${error.message}`);
        }
    }

    _buildScanExportPayload(options = {}) {
        const redactSensitive = Boolean(options.redactSensitive);
        const severityCounts = this._scanResults.reduce((counts, result) => {
            counts[result.severity] = (counts[result.severity] || 0) + 1;
            return counts;
        }, {});

        return {
            generatedAt: new Date().toISOString(),
            scanPath: redactSensitive ? '[REDACTED_PATH]' : (this._scanPath || null),
            selectedDirectory: redactSensitive ? '[REDACTED_PATH]' : (this._selectedDirectory || null),
            totalFindings: this._scanResults.length,
            redacted: redactSensitive,
            summary: {
                severities: severityCounts,
                dependencyFindings: this._scanResults.filter(result => result.isDependency).length,
                gitHistoryFindings: this._scanResults.filter(result => result.isGitHistory).length,
                verifiedLiveCredentials: this._scanResults.filter(result => result.verified === true).length
            },
            // What the scan examined. An exported report that omits this cannot be
            // audited later: "no findings" means nothing without its scope, and an
            // incomplete scan must never be mistaken for a completed one.
            coverage: this._scanCoverage
                ? {
                    incomplete: Boolean(this._scanCoverage.incomplete),
                    incompleteReason: this._scanCoverage.incompleteReason,
                    engines: (this._scanCoverage.engines || []).map(engine => ({
                        id: engine.id,
                        displayName: engine.displayName,
                        version: engine.version,
                        ok: Boolean(engine.ok),
                        findings: engine.findings,
                        note: engine.note || null
                    })),
                    refs: this._scanCoverage.refs,
                    refsRefreshed: Boolean(this._scanCoverage.refRefresh?.ok),
                    strategy: this._scanCoverage.strategy || null,
                    rulesetMode: this._scanCoverage.rulesetMode,
                    maxFileSizeMb: this._scanCoverage.maxFileSizeMb,
                    timeoutSeconds: this._scanCoverage.timeoutSeconds,
                    dependencyHandling: this._scanCoverage.dependencyHandling
                }
                : null,
            findings: this._scanResults.map(result => ({
                file: result.file,
                line: result.line,
                secret: redactSensitive ? '[REDACTED_SECRET]' : (result.fullSecret || result.secret),
                secretDisplay: redactSensitive ? '[REDACTED_SECRET]' : result.secret,
                // Avoid leaking secret-length hints in redacted exports.
                isSecretDisplayTruncated: redactSensitive ? null : Boolean(result.isSecretTruncated),
                description: result.description,
                severity: result.severity,
                isDependency: Boolean(result.isDependency),
                isGitHistory: Boolean(result.isGitHistory),
                isUntracked: Boolean(result.isUntracked),
                commitHash: result.commitHash || null,
                commitBranches: result.commitBranches || null,
                commitDate: result.commitDate || null,
                // Engine attribution and the extra detail maintained engines supply.
                // Present for every finding so the export shape does not vary by engine;
                // null means "this engine did not report it", and unavailableFields says
                // which of those nulls are structural rather than absent.
                engine: result.engine || null,
                engines: result.engines || (result.engine ? [result.engine] : []),
                engineVersion: result.engineVersion || null,
                ruleName: result.ruleName || null,
                verified: typeof result.verified === 'boolean' ? result.verified : null,
                verifiedAt: result.verifiedAt || null,
                endLine: Number.isFinite(result.endLine) ? result.endLine : null,
                startColumn: Number.isFinite(result.startColumn) ? result.startColumn : null,
                endColumn: Number.isFinite(result.endColumn) ? result.endColumn : null,
                entropy: Number.isFinite(result.entropy) ? result.entropy : null,
                fingerprint: result.fingerprint || null,
                author: redactSensitive ? null : (result.author || null),
                authorEmail: redactSensitive ? null : (result.authorEmail || null),
                commitMessage: redactSensitive ? null : (result.commitMessage || null),
                unavailableFields: result.unavailableFields || []
            }))
        };
    }

    async _exportScanResultsJson() {
        try {
            if (!this._scanResults || this._scanResults.length === 0) {
                vscode.window.showInformationMessage('No scan results available to export.');
                return;
            }

            const exportMode = await vscode.window.showWarningMessage(
                'Export may include secret snippets and filesystem paths. Secret and path redaction hides secret values and top-level scan/selection paths, but per-finding file paths and related metadata remain visible in the exported JSON.',
                { modal: true },
                'Export with secret and path redaction',
                'Export with full findings'
            );
            if (!exportMode) {
                return;
            }
            const redactSensitive = exportMode === 'Export with secret and path redaction';

            const now = new Date();
            const timestamp = now.toISOString().replace(/[:.]/g, '-');
            const homeDir = os.homedir();
            const downloadsDir = path.join(homeDir, 'Downloads');
            const defaultBasePath = fs.existsSync(downloadsDir) ? downloadsDir : homeDir;
            const defaultUri = vscode.Uri.file(path.join(defaultBasePath, `leak-lock-scan-results-${timestamp}.json`));
            const targetUri = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { 'JSON files': ['json'] },
                saveLabel: 'Export scan results'
            });

            if (!targetUri) {
                return;
            }

            const exportPayload = this._buildScanExportPayload({ redactSensitive });
            await vscode.workspace.fs.writeFile(
                targetUri,
                Buffer.from(`${JSON.stringify(exportPayload, null, 2)}\n`, 'utf8')
            );
            vscode.window.showInformationMessage(`Exported scan results to ${targetUri.toString(true)}`);
        } catch (error) {
            console.error('Failed to export scan results:', error);
            vscode.window.showErrorMessage(`Failed to export scan results: ${error.message}`);
        }
    }

    _buildPrintableScanReportHtml(options = {}) {
        const redactSecrets = (typeof options.redactSecrets === 'boolean')
            ? options.redactSecrets
            : Boolean(options.redactSensitive);
        const generatedAt = new Date().toLocaleString();
        const rows = this._scanResults.map((result) => `
            <tr>
                <td>${escapeHtml(result.file || '')}</td>
                <td>${escapeHtml(String(result.line ?? ''))}</td>
                <td>${escapeHtml(redactSecrets ? '[REDACTED_SECRET]' : (result.secret || ''))}</td>
                <td>${escapeHtml(result.severity || '')}</td>
                <td>${escapeHtml(result.description || '')}</td>
            </tr>
        `).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Leak Lock Scan Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
    h1 { margin: 0 0 8px 0; font-size: 24px; }
    .meta { margin-bottom: 16px; color: #444; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #ccc; padding: 8px; font-size: 12px; text-align: left; vertical-align: top; word-break: break-word; }
    th { background: #f4f4f4; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Leak Lock Scan Report</h1>
  <div class="meta">Generated: ${escapeHtml(generatedAt)} | Findings: ${this._scanResults.length} | Secrets redacted: ${redactSecrets ? 'yes' : 'no'}</div>
  <table>
    <thead>
      <tr>
        <th>File</th>
        <th>Line</th>
        <th>Secret (display)</th>
        <th>Severity</th>
        <th>Description</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>`;
    }

    async _printScanResultsPdf() {
        try {
            if (!this._scanResults || this._scanResults.length === 0) {
                vscode.window.showInformationMessage('No scan results available to print.');
                return;
            }
            const printMode = await vscode.window.showWarningMessage(
                'Printing creates an HTML report on disk before opening the browser print dialog. Secret-redacted output hides secret values but still keeps file/message paths visible for remediation context.',
                { modal: true },
                'Save secret-redacted printable report',
                'Save full printable report'
            );
            if (!printMode) {
                return;
            }
            const redactSecrets = printMode === 'Save secret-redacted printable report';

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            // Avoid /tmp for browser-print handoff on Linux sandboxed browsers.
            const homeDir = os.homedir();
            const downloadsDir = path.join(homeDir, 'Downloads');
            const defaultBasePath = fs.existsSync(downloadsDir) ? downloadsDir : homeDir;
            const defaultUri = vscode.Uri.file(path.join(defaultBasePath, `leak-lock-scan-report-${timestamp}.html`));
            const targetUri = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { 'HTML files': ['html'] },
                saveLabel: redactSecrets ? 'Save secret-redacted printable report' : 'Save printable report'
            });
            if (!targetUri) {
                return;
            }

            const reportHtml = this._buildPrintableScanReportHtml({ redactSecrets });
            await vscode.workspace.fs.writeFile(targetUri, Buffer.from(reportHtml, 'utf8'));
            const opened = await vscode.env.openExternal(targetUri);
            if (!opened) {
                vscode.window.showWarningMessage(`Printable report saved to ${targetUri.toString(true)}, but could not be opened automatically.`);
                return;
            }
            vscode.window.showInformationMessage(`Opened printable scan report in your default browser: ${targetUri.toString(true)}`);
        } catch (error) {
            console.error('Failed to open printable scan report:', error);
            vscode.window.showErrorMessage(`Failed to prepare printable scan report: ${error.message}`);
        }
    }

    // Handle panel disposal
    _setupPanelListeners() {
        this._panel.onDidDispose(() => {
            this.dispose();
        }, null);
    }

    _openSecurityGuide() {
        const guideContent = `# 🛡️ Security Best Practices Guide

## Preventing Secrets in Code

### 1. Environment Variables
- Use \`.env\` files for local development
- Add \`.env\` to your \`.gitignore\` file
- Use environment variables in production

### 2. Configuration Management
- Use dedicated secret management tools (Azure Key Vault, AWS Secrets Manager, etc.)
- Separate configuration from code
- Use different configs for different environments

### 3. Pre-commit Hooks
- Set up git hooks to scan before commits
- Use tools like \`pre-commit\` with secret scanning
- Reject commits that contain secrets

### 4. Code Reviews
- Review all code changes for potential secrets
- Use pull request templates with security checklists
- Train team members on secret detection

### 5. Regular Scanning
- Run Leak Lock scans regularly
- Integrate security scanning in CI/CD pipelines
- Monitor for new secret patterns

### 6. Incident Response
- Have a plan for when secrets are discovered
- Rotate compromised credentials immediately
- Use BFG or similar tools to clean git history

## Tools and Resources
- [OWASP Security Guidelines](https://owasp.org/)
- [GitHub Secret Scanning](https://docs.github.com/en/code-security/secret-scanning)
- [Pre-commit Hooks](https://pre-commit.com/)
`;

        vscode.workspace.openTextDocument({
            content: guideContent,
            language: 'markdown'
        }).then(doc => {
            vscode.window.showTextDocument(doc);
        });
    }

    dispose() {
        if (this._panel) {
            this._panel.dispose();
        }

        // Clean up static reference
        if (LeakLockPanel.currentPanel === this) {
            LeakLockPanel.currentPanel = null;
        }
    }
}

// Initialize static property
LeakLockPanel._currentPanel = null;

module.exports = LeakLockPanel;
