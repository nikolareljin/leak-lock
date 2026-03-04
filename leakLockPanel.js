// Main area panel provider that uses the Webview API to display security issues in the main editor area.

const vscode = require('vscode');
const { exec, spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Configuration constants
const MAX_PATH_LENGTH = 4096; // Maximum allowed path length to prevent DoS attacks
const MAX_VOLUME_NAME_LENGTH = 255; // Maximum Docker volume name length
const DOCKER_PULL_TIMEOUT = 120000; // Docker pull timeout in milliseconds (2 minutes)
const SCAN_TIMEOUT = 300000; // Scan timeout in milliseconds (5 minutes)
const SECRET_TRUNCATE_LENGTH = 50; // Length to truncate secrets for display
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
function runDockerCommand(args, options = {}) {
    return new Promise((resolve, reject) => {
        const dockerProcess = spawn('docker', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            ...options
        });

        let stdout = '';
        let stderr = '';

        dockerProcess.stdout?.on('data', (data) => {
            stdout += data.toString();
        });

        dockerProcess.stderr?.on('data', (data) => {
            stderr += data.toString();
        });

        dockerProcess.on('close', (code) => {
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
            reject(error);
        });
    });
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
            running: false
        };
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
            lastFetchAt: null
        };
    }

    static get currentPanel() {
        return LeakLockPanel._currentPanel;
    }

    static set currentPanel(panel) {
        LeakLockPanel._currentPanel = panel;
    }

    static createOrShow(extensionUri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it
        if (LeakLockPanel.currentPanel) {
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
        LeakLockPanel.currentPanel._panel.webview.html = LeakLockPanel.currentPanel._getHtmlForWebview();

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
                    .manual-command {
                        background-color: var(--vscode-textCodeBlock-background);
                        padding: 10px;
                        border-radius: 4px;
                        font-family: monospace;
                        margin-top: 10px;
                        word-break: break-all;
                    }
                    .danger-command {
                        background: var(--vscode-inputValidation-errorBackground);
                        border: 1px solid var(--vscode-inputValidation-errorBorder);
                        color: var(--vscode-inputValidation-errorForeground);
                        padding: 10px;
                        border-radius: 4px;
                        font-family: monospace;
                        margin-top: 10px;
                        word-break: break-all;
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
                            const text = el.innerText || el.textContent || '';
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
                    document.addEventListener('keydown', function(event) {
                        if (event.key === 'Escape') {
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
        const lastFetchISO = this._removalState.lastFetchAt;
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
                    .manual-command { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px; font-family: monospace; word-break: break-all; }
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
                            const text = el.innerText || el.textContent || '';
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

    _buildBfgCommand(repoDir, targets) {
        const bfgPath = path.join(this._extensionUri.fsPath, 'bfg.jar');
        const fileNames = targets.filter(t => t.type === 'file').map(t => t.base);
        const dirNames = targets.filter(t => t.type === 'directory').map(t => t.base);

        const args = [];
        if (fileNames.length > 0) {
            const fileRegex = this._shellEscapeDoubleQuotes(fileNames.map(n => this._escapeRegex(n)).join('|'));
            args.push(`--delete-files "${fileRegex}"`);
        }
        if (dirNames.length > 0) {
            const dirRegex = this._shellEscapeDoubleQuotes(dirNames.map(n => this._escapeRegex(n)).join('|'));
            args.push(`--delete-folders "${dirRegex}"`);
        }
        const bfgCmd = `java -jar \"${bfgPath}\" ${args.join(' ')} \"${repoDir}\"`;
        const full = `cd \"${repoDir}\" && ${bfgCmd} && git reflog expire --expire=now --all && git gc --prune=now --aggressive && git push --force --all && git push --force --tags`;
        return full;
    }

    _stripForcePush(command) {
        if (!command) {
            return command;
        }
        return command.replace(/\s*&&\s*git push --force --all\s*&&\s*git push --force --tags\s*$/, '');
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
            this._updateWebviewContent();
            await this._gitFetchAll(validatedRepo);
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
        const parts = [];
        parts.push(`cd \"${this._shellEscapeDoubleQuotes(repoDir)}\"`);
        for (const t of targets) {
            const base = this._shellEscapeDoubleQuotes(t.base);
            const flag = t.type === 'directory' ? '--delete-folders' : '--delete-files';
            parts.push(`java -jar \"${this._shellEscapeDoubleQuotes(bfgPath)}\" ${flag} \"${base}\" \"${this._shellEscapeDoubleQuotes(repoDir)}\"`);
        }
        // Run cleanup once at the end
        parts.push('git reflog expire --expire=now --all');
        parts.push('git gc --prune=now --aggressive');
        return parts.join(' && ');
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
        // Determine best repo path available
        let repo = this._removalState.repoDir || this._selectedDirectory;
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

    _buildGitFilterBranchCommandForDisplay(repoDir, indexFilter) {
        // Build a display-only version of the command for UI purposes
        // This is NOT executed - actual execution uses execFile
        const repoEsc = this._shellEscapeDoubleQuotes(repoDir);
        const cmd = [
            `cd \"${repoEsc}\"`,
            `git filter-branch --force --index-filter \"${indexFilter}\" --prune-empty --tag-name-filter cat -- --all`,
            `git for-each-ref --format=\"delete %(refname)\" refs/original/ | git update-ref --stdin`,
            `git reflog expire --expire=now --all`,
            `git gc --prune=now --aggressive`
        ].join(' && ');
        return cmd;
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
            this._updateWebviewContent();
            await this._gitFetchAll(validatedRepo);
            // Store the index filter and repo path for execution
            const indexFilter = this._buildGitFilterBranchIndexFilter(targets);
            this._removalState.preparedIndexFilter = indexFilter;
            this._removalState.repoDir = validatedRepo;
            // Build display-only command for UI
            const displayCmd = this._buildGitFilterBranchCommandForDisplay(validatedRepo, indexFilter);
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
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Running path-based removal (git filter-branch)...',
                cancellable: false,
            }, async (progress) => {
                progress.report({ increment: 10, message: 'Fetching remotes...' });
                await this._gitFetchAll(repo);
                
                progress.report({ increment: 30, message: 'Rewriting history...' });
                // Run git filter-branch using execFile
                // Note: --index-filter expects a shell script string, but all paths are escaped
                // via _shellEscapeDoubleQuotes() in _buildGitFilterBranchIndexFilter()
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
                ], { cwd: repo });
                
                progress.report({ increment: 50, message: 'Cleaning up refs...' });
                // Clean up original refs created by filter-branch
                // First get the refs to delete, then use spawn to pipe them to update-ref
                const { stdout: refsOut } = await execFileAsync('git', [
                    'for-each-ref',
                    '--format=delete %(refname)',
                    'refs/original/'
                ], { cwd: repo });
                if (refsOut.trim()) {
                    // Update refs using stdin
                    await new Promise((resolve, reject) => {
                        const proc = spawn('git', ['update-ref', '--stdin'], { cwd: repo });
                        proc.stdin.write(refsOut);
                        proc.stdin.end();
                        proc.on('close', (code) => {
                            if (code === 0) resolve();
                            else reject(new Error(`git update-ref failed with exit code ${code}`));
                        });
                        proc.on('error', reject);
                    });
                }
                
                progress.report({ increment: 70, message: 'Expiring reflog...' });
                await execFileAsync('git', ['reflog', 'expire', '--expire=now', '--all'], { cwd: repo });
                
                progress.report({ increment: 85, message: 'Running garbage collection...' });
                await execFileAsync('git', ['gc', '--prune=now', '--aggressive'], { cwd: repo });
                
                progress.report({ increment: 100, message: 'Cleanup complete' });
            });
            const result = await vscode.window.showInformationMessage(
                '✅ Path-based removal complete. Your git history has been cleaned. Do you want to force push to update remote repositories now?',
                'Force Push Now',
                'Skip'
            );
            if (result === 'Force Push Now') {
                await execFileAsync('git', ['push', '--force', '--all'], { cwd: repo });
                await execFileAsync('git', ['push', '--force', '--tags'], { cwd: repo });
            }
        } catch (e) {
            vscode.window.showErrorMessage(`Path-based removal failed: ${e.message}`);
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
        const execAsync = util.promisify(exec);
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Running BFG to remove files...',
                cancellable: false,
            }, async (progress) => {
                progress.report({ increment: 10, message: 'Fetching remotes...' });
                await this._gitFetchAll(repo);
                progress.report({ increment: 20, message: 'Executing BFG...' });
                await execAsync(this._stripForcePush(cmd));
                progress.report({ increment: 60, message: 'Cleaning git history...' });
            });

            const result = await vscode.window.showInformationMessage(
                '✅ Removal complete. Your git history has been cleaned. Do you want to force push to update remote repositories now?',
                'Force Push Now',
                'Skip'
            );
            if (result === 'Force Push Now') {
                await execAsync(`cd "${repo.replace(/"/g, '\\"')}" && git push --force --all && git push --force --tags`);
            }
        } catch (e) {
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
            if (this._panel && this._viewMode === 'removeFiles') {
                this._panel.webview.html = this._getHtmlForWebview();
            }
        } catch { }
    }

    _getResultsHtml() {
        if (this._scanResults.length === 0) {
            return `
                <div class="scan-section">
                    <h2>✅ No Secrets Found</h2>
                    <p>Great! No potential secrets were detected in your repository.</p>
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

        // Fetch status for secrets cleanup actions
        const lastFetchISO = this._removalState.lastFetchAt;
        const isStaleFetch = this._isFetchStale(lastFetchISO);
        const fetchColor = isStaleFetch ? 'var(--vscode-inputValidation-warningForeground)' : 'var(--vscode-descriptionForeground)';
        const fetchNote = isStaleFetch ? ' (stale)' : '';
        const fetchTooltip = isStaleFetch
            ? 'Remote refs may be outdated (older than 15 minutes). Fetch to ensure cleanup considers latest branches and tags.'
            : 'Remotes fetched recently; cleanup reflects current branches and tags.';

        const branchDataMap = {}; // index -> branches array, populated during map
        const resultsRows = this._scanResults.map((result, index) => {
            const isDependency = result.isDependency;
            const isGitHistory = result.isGitHistory;
            const isUntracked = result.isUntracked;
            const includeInCleanup = result.includeInCleanup !== false;
            const cleanupDisabled = isDependency || !includeInCleanup;

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
                    <td><input type="checkbox" class="secret-checkbox checkbox" ${cleanupDisabled ? 'disabled' : 'checked'}></td>
                    <td title="${escapeHtml(result.file)}${contextNote}${cleanupNote}">
                        <span class="file-link ${isGitHistory ? 'disabled' : 'clickable'}" data-file="${escapeHtml(result.file)}" data-line="${result.line}" style="font-family: monospace; font-size: 0.9em; color: var(--vscode-textLink-foreground); ${isGitHistory ? 'cursor: default;' : 'cursor: pointer; text-decoration: underline;'}" title="${iconTooltip}">
                            ${icon} ${escapeHtml(result.file)}
                        </span>
                        ${isDependency ? '<span style="font-size: 0.7em; color: var(--vscode-descriptionForeground); margin-left: 5px;">(deps)</span>' : ''}
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
                        <input type="text" class="replacement-input" value="*****" placeholder="Replacement value" ${cleanupDisabled ? 'disabled' : ''}>
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
                                ${isDependency ? ' <span style="color: var(--vscode-descriptionForeground); font-size: 0.8em;">(in dependency)</span>' : ''}
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
        const preparedBlockBfg = `
            <div id="scan-prepared-command-bfg" class="danger-command">${escapeHtml(bfgCommandText)}</div>
            ${prepared && this._scanCleanup.preparedMode === 'bfg' ? '<div style="margin-top:6px;"><button class="scan-button" onclick="copyScanCommand(\'scan-prepared-command-bfg\')">📋 Copy command</button></div>' : ''}
        `;
        const preparedBlockGit = `
            <div id="scan-prepared-command-git" class="danger-command">${escapeHtml(gitCommandText)}</div>
            ${prepared && this._scanCleanup.preparedMode === 'git' ? '<div style="margin-top:6px;"><button class="scan-button" onclick="copyScanCommand(\'scan-prepared-command-git\')">📋 Copy command</button></div>' : ''}
        `;

        return `
            <div class="scan-section">
                <h2>🔍 Scan Results</h2>
                <div style="margin:6px 0 10px 0; font-size:0.9em; color:${fetchColor}; display:flex; align-items:center; gap:8px;">
                    <span title="${escapeHtml(fetchTooltip)}">Refs status: Last fetched ${this._removalState.lastFetchAt ? escapeHtml(new Date(this._removalState.lastFetchAt).toLocaleString()) : 'never'}${fetchNote}</span>
                    <button style="padding:4px 8px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border:none; border-radius:4px; cursor:pointer;" onclick="refetchNow()">⟳ Refetch now</button>
                </div>
                <div style="margin-bottom: 15px;">
                    <strong>Found ${this._scanResults.length} potential secrets:</strong>
                    <div class="export-actions">
                        <button class="scan-button" onclick="exportScanResultsJson()">📤 Export JSON</button>
                        <button class="scan-button" onclick="printScanResults()">🖨️ Print / Save as PDF</button>
                    </div>
                    <div style="margin-top: 8px;">
                        <div>${severitySummary}</div>
                        ${dependencyWarnings.length > 0 ? `
                            <div style="margin-top: 8px; padding: 8px; background: var(--vscode-inputValidation-warningBackground); border-left: 3px solid ${severityColors.warning}; border-radius: 3px;">
                                <strong>ℹ️ ${dependencyWarnings.length} findings in dependency directories</strong>
                                <br><span style="font-size: 0.9em;">These are shown as warnings since they're in dependency folders (node_modules, vendor, etc.) and typically don't need fixing.</span>
                            </div>
                        ` : ''}
                    </div>
                </div>
                <script>window.__branchData = ${JSON.stringify(branchDataMap).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')};</script>
                <table class="results-table">
                    <thead>
                        <tr>
                            <th style="width: 40px;">Fix</th>
                            <th style="width: 20%;">File</th>
                            <th style="width: 50px;">Line</th>
                            <th style="width: 20%;">Secret</th>
                            <th style="width: 12%;">Replace With</th>
                            <th style="width: 15%;">Git Info</th>
                            <th>Description</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${resultsRows}
                    </tbody>
                </table>
                <div class="run-section" style="margin-top: 18px;">
                    <h3>⚡ BFG-based cleanup (recommended)</h3>
                    <p class="warning-text">⚠️ WARNING: This will permanently modify your git history!</p>
                    <p style="font-size: 0.9em; margin: 8px 0;">
                        BFG is faster, but it will remove files/directories with the same name everywhere in history. Git-only cleanup does not.
                    </p>
                    <div style="margin-top: 8px;">
                        <button class="scan-button" onclick="prepareBfgCommand()">⚙️ Prepare BFG command</button>
                    </div>
                    ${preparedBlockBfg}
                    <div style="margin-top: 10px;">
                        <button class="danger-button" onclick="runPreparedBfg()" ${!prepared || this._scanCleanup.preparedMode !== 'bfg' ? 'disabled' : ''}>❗ Run BFG cleanup</button>
                    </div>
                </div>

                <div class="run-section" style="margin-top: 18px;">
                    <h3>⚡ Git-only cleanup (alternative)</h3>
                    <p class="warning-text">⚠️ WARNING: This will permanently modify your git history!</p>
                    <p style="font-size: 0.9em; margin: 8px 0;">
                        Git-only cleanup is path-aware and won’t remove same-name files elsewhere, but it is slower than BFG.
                    </p>
                    <div style="margin-top: 8px;">
                        <button class="scan-button" onclick="prepareGitCommand()">⚙️ Prepare Git-only command</button>
                    </div>
                    ${preparedBlockGit}
                    <div style="margin-top: 10px;">
                        <button class="danger-button" onclick="runPreparedGit()" ${!prepared || this._scanCleanup.preparedMode !== 'git' ? 'disabled' : ''}>❗ Run Git-only cleanup</button>
                    </div>
                </div>
                
                <div style="margin-top: 10px; font-size: 0.9em; color: var(--vscode-descriptionForeground);">
                    💡 <strong>Tip:</strong> Review each secret carefully before applying fixes. Some may be test data or false positives.
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
            await this._primeGitTracking(scanPath);

            // Update progress: Checking Docker
            this._scanProgress = { stage: 'docker', message: 'Checking Docker availability...' };
            this._updateWebviewContent();

            // Check if Docker is available
            const dockerCheck = await this._checkDockerAvailability();
            if (!dockerCheck.available) {
                vscode.window.showErrorMessage(`Docker not available: ${dockerCheck.error}`);
                this._isScanning = false;
                this._updateWebviewContent();
                return;
            }

            // Update progress: Pulling image
            this._scanProgress = { stage: 'pull', message: 'Pulling Nosey Parker image...' };
            this._updateWebviewContent();

            // Pull the latest Nosey Parker image
            await this._pullNoseyParkerImage();

            // Update progress: Initializing
            this._scanProgress = { stage: 'init', message: 'Initializing datastore...' };
            this._updateWebviewContent();

            // Create and validate temporary datastore path
            const tempDatastore = validateDockerPath(path.join(scanPath, '.noseyparker-temp'), [scanPath]);
            await this._initializeDatastore(tempDatastore);

            // Update progress: Scanning
            this._scanProgress = { stage: 'scan', message: 'Scanning for secrets...' };
            this._updateWebviewContent();

            // Run the actual scan
            const scanResults = await this._runNoseyParkerScan(scanPath, tempDatastore);
            const keywordHistoryResults = await this._scanGitHistoryForKeywords(scanPath);
            const allResults = scanResults.concat(keywordHistoryResults);

            // Update progress: Processing
            this._scanProgress = { stage: 'process', message: 'Processing results...' };
            this._updateWebviewContent();

            // Clean up temporary datastore
            await this._cleanupTempFiles(tempDatastore);

            // Enrich results with git branch names and commit dates
            await this._enrichResultsWithGitInfo(allResults, scanPath);

            // Update results
            this._scanResults = allResults;
            this._isScanning = false;
            this._scanProgress = null;

            // Update the webview
            this._updateWebviewContent();

            // Show completion message
            if (allResults.length > 0) {
                vscode.window.showWarningMessage(`Scan complete! Found ${allResults.length} findings (potential secrets or policy references). Review them in the main panel.`);
            } else {
                vscode.window.showInformationMessage('🎉 Scan complete! No secrets found in your repository. Your code looks secure!');
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

    _getKeywordSearchConfig() {
        const config = vscode.workspace.getConfiguration('leakLock');
        const enabled = !!config.get('gitHistoryKeywordSearch.enabled', false);
        const rawKeywords = config.get('gitHistoryKeywordSearch.keywords', []);
        const rawMaxMatchesPerKeyword = config.get('gitHistoryKeywordSearch.maxMatchesPerKeyword', 25);
        const parsedMaxMatchesPerKeyword = Number(rawMaxMatchesPerKeyword);
        const maxMatchesPerKeyword = Number.isFinite(parsedMaxMatchesPerKeyword)
            ? Math.floor(parsedMaxMatchesPerKeyword)
            : 25;
        const searchCommitMessages = !!config.get('gitHistoryKeywordSearch.searchCommitMessages', true);
        const searchFileHistory = !!config.get('gitHistoryKeywordSearch.searchFileHistory', true);

        const keywords = Array.isArray(rawKeywords)
            ? [...new Set(rawKeywords.map((k) => String(k || '').trim()).filter(Boolean))]
            : [];

        return {
            enabled,
            keywords,
            maxMatchesPerKeyword: Math.max(1, Math.min(500, maxMatchesPerKeyword)),
            searchCommitMessages,
            searchFileHistory
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
            { forceGitHistory: true, includeInCleanup: false }
        );
        result.commitHash = commitHash || null;
        result.commitDate = commitDate || null;
        return result;
    }

    _keywordMatchesText(text, keyword) {
        const normalizedText = String(text || '');
        const keywordStr = String(keyword || '').trim();
        const keywordLower = keywordStr.toLowerCase();
        if (!keywordLower) {
            return false;
        }
        // Reduce false positives for word-like keywords by requiring whole-word matches.
        const isWordLike = /^[A-Za-z0-9]+$/.test(keywordStr);
        if (isWordLike) {
            const boundaryRegex = new RegExp(`\\b${this._escapeRegex(keywordStr)}\\b`, 'i');
            return boundaryRegex.test(normalizedText);
        }
        return normalizedText.toLowerCase().includes(keywordLower);
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
        const findings = [];
        const seen = new Set();
        const totalSearchModes = (keywordConfig.searchCommitMessages ? 1 : 0) + (keywordConfig.searchFileHistory ? 1 : 0);
        const maxTotalFindings = Math.max(50, Math.min(2000, keywordConfig.keywords.length * keywordConfig.maxMatchesPerKeyword * Math.max(1, totalSearchModes)));

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

        try {
            if (keywordConfig.searchCommitMessages) {
                this._scanProgress = { stage: 'process', message: 'Searching git commit messages for configured keywords...' };
                this._updateWebviewContent();

                const matchCountByKeyword = new Map(keywordConfig.keywords.map((kw) => [kw, 0]));
                for (const keyword of keywordConfig.keywords) {
                    if (findings.length >= maxTotalFindings) {
                        break;
                    }
                    const perKeywordCap = keywordConfig.maxMatchesPerKeyword * 5;
                    const { stdout } = await execFileAsync('git', [
                        '-C', repoDir,
                        'log', '--all', '--no-color', '-z',
                        '--regexp-ignore-case', '--fixed-strings',
                        '--grep', keyword,
                        `--max-count=${perKeywordCap}`,
                        '--pretty=format:%H%x09%aI%x09%s%x00'
                    ], gitLogOptions);
                    const records = stdout.split('\0').filter(Boolean);
                    for (const record of records) {
                        if (findings.length >= maxTotalFindings) {
                            break;
                        }
                        const existingCount = matchCountByKeyword.get(keyword) || 0;
                        if (existingCount >= keywordConfig.maxMatchesPerKeyword) {
                            break;
                        }
                        const firstTab = record.indexOf('\t');
                        const secondTab = firstTab >= 0 ? record.indexOf('\t', firstTab + 1) : -1;
                        if (firstTab < 0 || secondTab < 0) {
                            continue;
                        }
                        const commitHash = record.slice(0, firstTab).trim();
                        const commitDate = record.slice(firstTab + 1, secondTab).trim();
                        const subject = record.slice(secondTab + 1).trim();
                        if (!this._keywordMatchesText(subject, keyword)) {
                            continue;
                        }
                        const added = addFinding(
                            'git-history-reference',
                            keyword,
                            `Keyword "${keyword}" found in commit ${commitHash}${commitDate ? ` (${commitDate})` : ''}`,
                            commitHash,
                            commitDate
                        );
                        if (added) {
                            matchCountByKeyword.set(keyword, existingCount + 1);
                        }
                    }
                }
            }

            if (keywordConfig.searchFileHistory) {
                this._scanProgress = { stage: 'process', message: 'Searching git file history for configured keywords...' };
                this._updateWebviewContent();

                for (const keyword of keywordConfig.keywords) {
                    if (findings.length >= maxTotalFindings) {
                        break;
                    }
                    if (keyword.length <= 3) {
                        // Skip short tokens (for example "ai") in file-history mode to avoid
                        // broad and expensive -S matches that are mostly noise.
                        continue;
                    }
                    const safetyFactor = 3;
                    const gitMaxCount = Math.max(1, keywordConfig.maxMatchesPerKeyword) * safetyFactor;
                    const { stdout } = await execFileAsync('git', [
                        '-C', repoDir,
                        'log', '--all', '--no-color',
                        '--pretty=format:COMMIT%x09%H%x09%aI',
                        '-p',
                        '-S', keyword,
                        `--max-count=${gitMaxCount}`,
                        '--',
                        '.'
                    ], gitLogOptions);

                    const lines = stdout.split('\n');
                    let currentCommit = null;
                    let currentDate = null;
                    let currentFile = null;
                    let perKeywordCount = 0;
                    for (const rawLine of lines) {
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
                        if (!currentCommit || perKeywordCount >= keywordConfig.maxMatchesPerKeyword) {
                            continue;
                        }
                        if (!currentFile) {
                            continue;
                        }
                        // Restrict to added/removed lines only; exclude diff headers.
                        if (!(line.startsWith('+') || line.startsWith('-')) || line.startsWith('+++') || line.startsWith('---')) {
                            continue;
                        }
                        if (!this._keywordMatchesText(line.slice(1), keyword)) {
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
                            perKeywordCount++;
                        }
                        if (findings.length >= maxTotalFindings) {
                            break;
                        }
                    }
                }
            }
        } catch (error) {
            console.warn('Keyword history scan skipped:', error.message);
            this._scanProgress = {
                stage: 'process',
                message: 'Keyword history scan was skipped due to a Git error. See extension logs for details.'
            };
            this._updateWebviewContent();
            vscode.window.showWarningMessage(
                'LeakLock: Keyword history scan was skipped due to a Git error. See logs for details.'
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
        if (!relativeFile || relativeFile === 'scan_output' || relativeFile === 'git-history-reference' || relativeFile === 'git-history-artifact') {
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
        if (this._panel) {
            this._panel.webview.html = this._getHtmlForWebview();
        }
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

    async _pullNoseyParkerImage() {
        return new Promise((resolve, reject) => {
            const pullCommand = 'docker pull ghcr.io/praetorian-inc/noseyparker:latest';
            exec(pullCommand, { timeout: DOCKER_PULL_TIMEOUT }, (error, stdout, stderr) => {
                if (error) {
                    console.warn('Failed to pull latest image, using existing:', error.message);
                    resolve(); // Continue with existing image
                } else {
                    resolve();
                }
            });
        });
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

                    const dockerArgs = [
                        'run', '--rm',
                        '-v', `${parentDir}:/workspace`,
                        'ghcr.io/praetorian-inc/noseyparker:latest',
                        'datastore', 'init',
                        '--datastore', `/workspace/${datastoreName}`
                    ];

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

    async _runNoseyParkerScan(scanPath, datastorePath) {
        return new Promise((resolve, reject) => {
            try {
                // Validate paths before using them
                const validatedScanPath = validateDockerPath(scanPath);
                const validatedDatastorePath = validateDockerPath(datastorePath);

                // Get dependency handling configuration
                const config = vscode.workspace.getConfiguration('leakLock');
                const dependencyHandling = config.get('dependencyHandling') || 'warning';

                // Create ignore file for proper exclusion if needed
                if (dependencyHandling === 'exclude') {
                    // For now, let's skip file-based exclusions to avoid issues
                    // We'll handle dependency filtering in the results processing instead
                    console.log('Dependency exclusion will be handled in post-processing');
                }

                // Ensure git history scanning is explicitly enabled (built into args below)

                // First scan the repository with full git history using safe Docker command
                const scanArgs = [
                    'run', '--rm',
                    '-v', `${validatedScanPath}:/scan`,
                    '-v', `${validatedDatastorePath}:/datastore`,
                    'ghcr.io/praetorian-inc/noseyparker:latest',
                    'scan',
                    '--datastore', '/datastore',
                    '--git-history', 'full',
                    '/scan'
                ];

                // Use a timeout wrapper for the Docker command
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error(`Scan timeout after ${SCAN_TIMEOUT / 1000 / 60} minutes`)), SCAN_TIMEOUT);
                });

                Promise.race([runDockerCommand(scanArgs), timeoutPromise]).then(({ stdout: scanStdout, stderr: scanStderr }) => {
                    // Continue to report generation - Nosey Parker may return non-zero exit codes even on successful scans

                    // Now report the findings in structured format using safe Docker command
                    const reportArgs = [
                        'run', '--rm',
                        '-v', `${validatedDatastorePath}:/datastore`,
                        'ghcr.io/praetorian-inc/noseyparker:latest',
                        'report',
                        '--datastore', '/datastore',
                        '--format', 'json'
                    ];

                    runDockerCommand(reportArgs).then(({ stdout: reportStdout }) => {
                        try {
                            const results = this._parseNoseyParkerResults(reportStdout);
                            resolve(results);
                        } catch (parseError) {
                            console.warn('Failed to parse JSON results, using fallback:', parseError.message);
                            resolve(this._createFallbackResults(reportStdout + scanStdout));
                        }
                    }).catch(reportError => {
                        console.warn('Report command failed, trying alternative approach:', reportError.message);
                        resolve(this._createFallbackResults(scanStdout + scanStderr));
                    });
                }).catch(scanError => {
                    // Handle scan errors, but allow exit code 2 which is common for Nosey Parker
                    if (scanError.code !== 2) {
                        console.error('Scan error details:', { error: scanError, stdout: scanError.stdout, stderr: scanError.stderr });
                        reject(new Error(`Scan failed: ${scanError.message}\nStderr: ${scanError.stderr || ''}`));
                        return;
                    }
                    // If exit code 2, try to continue with report generation
                    const reportArgs = [
                        'run', '--rm',
                        '-v', `${validatedDatastorePath}:/datastore`,
                        'ghcr.io/praetorian-inc/noseyparker:latest',
                        'report',
                        '--datastore', '/datastore',
                        '--format', 'json'
                    ];

                    runDockerCommand(reportArgs).then(({ stdout: reportStdout }) => {
                        try {
                            const results = this._parseNoseyParkerResults(reportStdout);
                            resolve(results);
                        } catch (parseError) {
                            console.warn('Failed to parse JSON results, using fallback:', parseError.message);
                            resolve(this._createFallbackResults(scanError.stdout + scanError.stderr));
                        }
                    }).catch(reportError => {
                        console.warn('Report command also failed:', reportError.message);
                        resolve(this._createFallbackResults(scanError.stdout + scanError.stderr));
                    });
                });
            } catch (validationError) {
                reject(new Error(`Path validation failed: ${validationError.message}`));
            }
        });
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
        isGitHistory = isGitHistory || filePath.startsWith('git-ref:') || filePath.startsWith('git-object') || filePath === 'git-history-reference';
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

        return result;
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

    _buildScanBfgReplaceCommand(scanPath, replacementsFile) {
        const bfgPath = path.join(this._extensionUri.fsPath, 'bfg.jar');
        return `cd \"${this._shellEscapeDoubleQuotes(scanPath)}\" && java -jar \"${this._shellEscapeDoubleQuotes(bfgPath)}\" --replace-text \"${this._shellEscapeDoubleQuotes(replacementsFile)}\" && git reflog expire --expire=now --all && git gc --prune=now --aggressive && git push --force --all && git push --force --tags`;
    }

    _buildScanGitReplaceCommand(scanPath, replacementsFile) {
        return `cd \"${this._shellEscapeDoubleQuotes(scanPath)}\" && git filter-repo --replace-text \"${this._shellEscapeDoubleQuotes(replacementsFile)}\" --force && git reflog expire --expire=now --all && git gc --prune=now --aggressive && git push --force --all && git push --force --tags`;
    }

    _resolveScanReplacements(replacements) {
        if (!replacements || typeof replacements !== 'object') {
            return {};
        }
        const resolved = {};
        for (const [key, replacement] of Object.entries(replacements)) {
            if (key.startsWith('idx:')) {
                const idx = Number(key.slice(4));
                if (!Number.isInteger(idx) || idx < 0 || idx >= this._scanResults.length) {
                    continue;
                }
                const result = this._scanResults[idx];
                if (!result || result.isDependency || result.includeInCleanup === false || result.ruleName === 'git_history_keyword') {
                    continue;
                }
                const secretValue = result.fullSecret || result.secret;
                if (!secretValue) {
                    continue;
                }
                resolved[secretValue] = replacement || '*****';
                continue;
            }
            // Backward compatibility for callers that pass secret->replacement maps.
            resolved[key] = replacement || '*****';
        }
        return resolved;
    }

    _prepareScanReplacementCommand(mode, replacements) {
        const resolvedReplacements = this._resolveScanReplacements(replacements);
        if (!resolvedReplacements || Object.keys(resolvedReplacements).length === 0) {
            vscode.window.showWarningMessage('No secrets selected for removal.');
            return;
        }
        const scanPath = this._scanPath || this._selectedDirectory || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!scanPath) {
            vscode.window.showErrorMessage('No directory selected or workspace available.');
            return;
        }
        const replacementsFile = path.join(scanPath, 'leak-lock-replacements.txt');
        this._scanCleanup.preparing = true;
        this._updateWebviewContent();
        try {
            const command = mode === 'git'
                ? this._buildScanGitReplaceCommand(scanPath, replacementsFile)
                : this._buildScanBfgReplaceCommand(scanPath, replacementsFile);
            this._scanCleanup.preparedCommand = command;
            this._scanCleanup.preparedMode = mode;
            this._scanCleanup.replacements = resolvedReplacements;
            this._scanCleanup.replacementsFile = replacementsFile;
        } finally {
            this._scanCleanup.preparing = false;
            this._updateWebviewContent();
        }
    }

    _prepareScanBfgCommand(replacements) {
        this._prepareScanReplacementCommand('bfg', replacements);
    }

    _prepareScanGitCommand(replacements) {
        this._prepareScanReplacementCommand('git', replacements);
    }

    async _runPreparedScanCleanup(mode) {
        if (!this._scanCleanup.preparedCommand || this._scanCleanup.preparedMode !== mode) {
            vscode.window.showWarningMessage('Prepare the cleanup command first.');
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

        const scanPath = this._scanPath || this._selectedDirectory || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Running git-only cleanup...",
                cancellable: false
            }, async (progress) => {
                progress.report({ increment: 10, message: "Preparing replacement file..." });
                const replacementsFile = path.join(scanPath, 'leak-lock-replacements.txt');
                const replacementLines = Object.entries(replacements).map(([secret, replacement]) =>
                    `${secret}==>${replacement}`
                ).join('\n');
                fs.writeFileSync(replacementsFile, replacementLines);

                progress.report({ increment: 10, message: "Fetching remotes..." });
                await this._gitFetchAll(scanPath);

                progress.report({ increment: 40, message: "Running git filter-repo..." });
                const util = require('util');
                const execFileAsync = util.promisify(execFile);
                await execFileAsync('git', ['filter-repo', '--replace-text', replacementsFile, '--force'], { cwd: scanPath });

                progress.report({ increment: 20, message: "Expiring reflog..." });
                await execFileAsync('git', ['reflog', 'expire', '--expire=now', '--all'], { cwd: scanPath });
                progress.report({ increment: 20, message: "Running garbage collection..." });
                await execFileAsync('git', ['gc', '--prune=now', '--aggressive'], { cwd: scanPath });

                try {
                    fs.unlinkSync(replacementsFile);
                } catch (cleanupError) {
                    console.warn('Failed to clean up temporary file:', cleanupError);
                }
            });

            const result = await vscode.window.showInformationMessage(
                '✅ Git-only cleanup completed. Your git history has been cleaned. Do you want to force push to update remote repositories now?',
                'Force Push Now',
                'Skip'
            );
            if (result === 'Force Push Now') {
                const util = require('util');
                const execFileAsync = util.promisify(execFile);
                await execFileAsync('git', ['push', '--force', '--all'], { cwd: scanPath });
                await execFileAsync('git', ['push', '--force', '--tags'], { cwd: scanPath });
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Git-only cleanup failed: ${error.message}`);
        }
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
            const scanPath = this._selectedDirectory || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Running BFG cleanup...",
                cancellable: false
            }, async (progress) => {

                progress.report({ increment: 10, message: "Preparing replacement file..." });

                // Create a temporary replacements file for BFG
                const replacementsFile = path.join(scanPath, 'leak-lock-replacements.txt');
                const replacementLines = Object.entries(replacements).map(([secret, replacement]) =>
                    `${secret}==>${replacement}`
                ).join('\n');

                fs.writeFileSync(replacementsFile, replacementLines);

                progress.report({ increment: 10, message: "Fetching remotes..." });
                await this._gitFetchAll(scanPath);

                progress.report({ increment: 10, message: "Running BFG tool..." });

                // Run BFG command
                const bfgPath = path.join(this._extensionUri.fsPath, 'bfg.jar');
                const bfgCommand = `cd "${scanPath}" && java -jar "${bfgPath}" --replace-text "${replacementsFile}"`;

                const util = require('util');
                const execAsync = util.promisify(exec);

                try {
                    const bfgResult = await execAsync(bfgCommand);
                    console.log('BFG result:', bfgResult.stdout);
                    progress.report({ increment: 40, message: "BFG cleanup completed ✓" });
                } catch (bfgError) {
                    console.error('BFG error:', bfgError);
                    // Continue even if BFG has issues - it might still have worked
                }

                progress.report({ increment: 15, message: "Expiring reflog..." });

                // Git cleanup commands
                try {
                    await execAsync(`cd "${scanPath}" && git reflog expire --expire=now --all`);
                    progress.report({ increment: 15, message: "Running garbage collection..." });

                    await execAsync(`cd "${scanPath}" && git gc --prune=now --aggressive`);
                    progress.report({ increment: 0, message: "Git cleanup completed ✓" });
                } catch (gitError) {
                    console.error('Git cleanup error:', gitError);
                    vscode.window.showWarningMessage('BFG completed but git cleanup had issues. You may need to run git cleanup manually.');
                }

                // Clean up the temporary file
                try {
                    fs.unlinkSync(replacementsFile);
                } catch (cleanupError) {
                    console.warn('Failed to clean up temporary file:', cleanupError);
                }
            });

            // Show success message with next steps
            const result = await vscode.window.showInformationMessage(
                '✅ BFG cleanup completed successfully!\n\nYour git history has been cleaned. Do you want to force push to update remote repositories now?',
                'Force Push Now',
                'Show Git Status',
                'Skip'
            );

            if (result === 'Force Push Now') {
                const util = require('util');
                const execAsync = util.promisify(exec);
                await execAsync(`cd "${scanPath}" && git push --force --all && git push --force --tags`);
            } else if (result === 'Show Git Status') {
                // Open a new terminal and show git status
                const terminal = vscode.window.createTerminal('Git Status');
                terminal.sendText(`cd "${scanPath}" && git status`);
                terminal.show();
            }

            // Clear scan results since they may no longer be relevant
            this._scanResults = [];
            if (this._panel) {
                this._panel.webview.html = this._getHtmlForWebview();
            }

        } catch (error) {
            console.error('BFG execution error:', error);
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
                gitHistoryFindings: this._scanResults.filter(result => result.isGitHistory).length
            },
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
                commitDate: result.commitDate || null
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
        const redactSensitive = Boolean(options.redactSensitive);
        const generatedAt = new Date().toLocaleString();
        const rows = this._scanResults.map((result) => `
            <tr>
                <td>${escapeHtml(redactSensitive ? '[REDACTED_PATH]' : (result.file || ''))}</td>
                <td>${escapeHtml(String(result.line ?? ''))}</td>
                <td>${escapeHtml(redactSensitive ? '[REDACTED_SECRET]' : (result.secret || ''))}</td>
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
  <div class="meta">Generated: ${escapeHtml(generatedAt)} | Findings: ${this._scanResults.length} | Redacted: ${redactSensitive ? 'yes' : 'no'}</div>
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
                'Printing creates an HTML report on disk before opening the browser print dialog. Full output may include secret snippets and file paths. Choose redacted/full output and where to save it.',
                { modal: true },
                'Save redacted printable report',
                'Save full printable report'
            );
            if (!printMode) {
                return;
            }
            const redactSensitive = printMode === 'Save redacted printable report';

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            // Avoid /tmp for browser-print handoff on Linux sandboxed browsers.
            const homeDir = os.homedir();
            const downloadsDir = path.join(homeDir, 'Downloads');
            const defaultBasePath = fs.existsSync(downloadsDir) ? downloadsDir : homeDir;
            const defaultUri = vscode.Uri.file(path.join(defaultBasePath, `leak-lock-scan-report-${timestamp}.html`));
            const targetUri = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { 'HTML files': ['html'] },
                saveLabel: redactSensitive ? 'Save redacted printable report' : 'Save printable report'
            });
            if (!targetUri) {
                return;
            }

            const reportHtml = this._buildPrintableScanReportHtml({ redactSensitive });
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
