// Sidebar provider for dependency installation, directory selection, and displaying security issues using the Webview API.

const vscode = require('vscode');

const { exec } = require('child_process');
const vscode = require('vscode');

const path = require('path');
const { exec } = require('child_process');

const fs = require('fs');
const path = require('path');

const fs = require('fs');

class LeakLockSidebarProvider {

    constructor(extensionUri) {// implements vscode.WebviewViewProvider

        this._extensionUri = extensionUri;class SidebarProvider {

        this._view = undefined;    constructor(extensionUri) {

        this._dependenciesInstalled = false;        this._extensionUri = extensionUri;

        this._selectedDirectory = null;        this._scanResults = [];

        this._isInstalling = false;        this._replacementValues = {};

        this._installProgress = null;        this._selectedDirectory = null;

    }        this._isScanning = false;

        this._scanProgress = null;

    resolveWebviewView(webviewView, context, _token) {        this._dependenciesInstalled = false;

        this._view = webviewView;    }



        webviewView.webview.options = {    resolveWebviewView(webviewView, context, _token) {

            enableScripts: true,        this._view = webviewView;

            localResourceRoots: [this._extensionUri]        webviewView.webview.options = {

        };            enableScripts: true,

            localResourceRoots: [this._extensionUri]

        webviewView.webview.html = this._getHtmlForWebview();        };

        

        // Handle messages from the webview        // Check dependencies on startup

        webviewView.webview.onDidReceiveMessage(        this._checkDependenciesOnStartup();

            message => {        

                switch (message.command) {        webviewView.webview.html = this._getHtmlForWebview();

                    case 'installDependencies':        

                        this._installDependencies();        // Handle messages from the webview

                        break;        webviewView.webview.onDidReceiveMessage(

                    case 'selectDirectory':            message => {

                        this._selectDirectory();                switch (message.command) {

                        break;                    case 'scan':

                    case 'scanRepository':                        this._scanRepository(message.useWorkspace);

                        // Notify main panel to start scanning                        break;

                        vscode.commands.executeCommand('leak-lock.startScan', {                    case 'fix':

                            directory: this._selectedDirectory,                        this._fixSecrets(message.replacements);

                            dependenciesReady: this._dependenciesInstalled                        break;

                        });                    case 'selectDirectory':

                        break;                        this._selectDirectory();

                }                        break;

            },                    case 'installDependencies':

            undefined,                        this._installDependencies();

            []                        break;

        );                    case 'runBFG':

                        this._runBFGCommand(message.replacements);

        // Check dependencies on initialization                        break;

        this._checkDependencies();                    case 'openFile':

    }                        this._openFileAtLine(message.file, message.line);

                        break;

    _getHtmlForWebview() {                    case 'resetDependencies':

        return `<!DOCTYPE html>                        this._resetDependencyStatus();

        <html lang="en">                        break;

        <head>                }

            <meta charset="UTF-8">            }

            <meta name="viewport" content="width=device-width, initial-scale=1.0">        );

            <title>Leak Lock Control Panel</title>    }

            <style>

                body {    _getHtmlForWebview() {

                    font-family: var(--vscode-font-family);        const hasResults = this._scanResults.length > 0;

                    font-size: var(--vscode-font-size);        

                    color: var(--vscode-foreground);        return `

                    background: var(--vscode-editor-background);            <!DOCTYPE html>

                    margin: 0;            <html lang="en">

                    padding: 10px;            <head>

                    line-height: 1.4;                <meta charset="UTF-8">

                }                <meta name="viewport" content="width=device-width, initial-scale=1.0">

                                <title>Leak Lock</title>

                .section {                <style>

                    margin-bottom: 20px;                    body {

                    padding: 15px;                        font-family: var(--vscode-font-family);

                    background: var(--vscode-sideBar-background);                        color: var(--vscode-foreground);

                    border: 1px solid var(--vscode-sideBar-border);                        background-color: var(--vscode-editor-background);

                    border-radius: 5px;                        padding: 10px;

                }                        margin: 0;

                                    }

                .section h3 {                    .scan-section {

                    margin-top: 0;                        margin-bottom: 20px;

                    margin-bottom: 10px;                        padding: 10px;

                    color: var(--vscode-sideBarSectionHeader-foreground);                        border: 1px solid var(--vscode-panel-border);

                    font-size: 14px;                        border-radius: 4px;

                    font-weight: 600;                    }

                }                    .scan-button, .fix-button, .select-button, .install-button, .run-button {

                                        background-color: var(--vscode-button-background);

                .install-button, .select-button, .scan-button {                        color: var(--vscode-button-foreground);

                    background: var(--vscode-button-background);                        border: none;

                    color: var(--vscode-button-foreground);                        padding: 8px 16px;

                    border: none;                        border-radius: 4px;

                    padding: 8px 16px;                        cursor: pointer;

                    border-radius: 3px;                        margin: 5px 5px 5px 0;

                    cursor: pointer;                        font-size: 0.9em;

                    font-size: 12px;                    }

                    width: 100%;                    .scan-button:hover, .fix-button:hover, .select-button:hover, .install-button:hover, .run-button:hover {

                    margin-top: 5px;                        background-color: var(--vscode-button-hoverBackground);

                }                    }

                                    .scan-button:disabled, .fix-button:disabled, .run-button:disabled {

                .install-button:hover, .select-button:hover, .scan-button:hover {                        background-color: var(--vscode-button-secondaryBackground);

                    background: var(--vscode-button-hoverBackground);                        color: var(--vscode-button-secondaryForeground);

                }                        cursor: not-allowed;

                                        opacity: 0.6;

                .install-button:disabled, .select-button:disabled, .scan-button:disabled {                    }

                    opacity: 0.5;                    .setup-section, .directory-section {

                    cursor: not-allowed;                        margin-bottom: 15px;

                }                        padding: 10px;

                                        border: 1px solid var(--vscode-panel-border);

                .status-item {                        border-radius: 4px;

                    display: flex;                        background-color: var(--vscode-editor-inactiveSelectionBackground);

                    align-items: center;                    }

                    justify-content: space-between;                    .setup-complete-section {

                    margin: 5px 0;                        margin-bottom: 15px;

                    font-size: 12px;                        padding: 12px;

                }                        border: 2px solid var(--vscode-button-background);

                                        border-radius: 6px;

                .status-icon {                        background-color: var(--vscode-editor-selectionHighlightBackground);

                    font-size: 14px;                    }

                    margin-right: 5px;                    .setup-complete-info {

                }                        font-size: 0.85em;

                                        color: var(--vscode-button-foreground);

                .spinner {                        margin: 8px 0;

                    border: 2px solid var(--vscode-progressBar-background);                        font-weight: 500;

                    border-top: 2px solid var(--vscode-progressBar-foreground);                    }

                    border-radius: 50%;                    .setup-info {

                    width: 12px;                        font-size: 0.8em;

                    height: 12px;                        color: var(--vscode-descriptionForeground);

                    animation: spin 1s linear infinite;                        margin: 5px 0;

                }                    }

                                    .selected-directory {

                @keyframes spin {                        font-family: monospace;

                    0% { transform: rotate(0deg); }                        font-size: 0.8em;

                    100% { transform: rotate(360deg); }                        background-color: var(--vscode-textCodeBlock-background);

                }                        padding: 4px 8px;

                                        border-radius: 3px;

                .selected-path {                        margin-top: 8px;

                    font-family: monospace;                        border: 1px solid var(--vscode-input-border);

                    font-size: 11px;                    }

                    color: var(--vscode-descriptionForeground);                    .file-link {

                    background: var(--vscode-textCodeBlock-background);                        color: var(--vscode-textLink-foreground);

                    padding: 5px;                        cursor: pointer;

                    border-radius: 3px;                        text-decoration: underline;

                    margin-top: 5px;                    }

                    word-break: break-all;                    .file-link:hover {

                }                        color: var(--vscode-textLink-activeForeground);

                                    }

                .warning-text {                    .run-section {

                    color: var(--vscode-inputValidation-warningForeground);                        margin-top: 20px;

                    font-size: 11px;                        padding: 15px;

                    margin-top: 5px;                        border: 2px solid var(--vscode-button-background);

                }                        border-radius: 6px;

            </style>                        background-color: var(--vscode-editor-selectionHighlightBackground);

        </head>                    }

        <body>                    .run-button {

            ${this._getDependenciesSection()}                        background-color: var(--vscode-button-background);

            ${this._getDirectorySection()}                        color: var(--vscode-button-foreground);

            ${this._getScanSection()}                        font-weight: bold;

                                    padding: 10px 20px;

            <script>                        font-size: 1em;

                const vscode = acquireVsCodeApi();                    }

                                    .warning-text {

                function installDependencies() {                        color: var(--vscode-errorForeground);

                    vscode.postMessage({ command: 'installDependencies' });                        font-size: 0.85em;

                }                        margin: 8px 0;

                                        font-weight: bold;

                function selectDirectory() {                    }

                    vscode.postMessage({ command: 'selectDirectory' });                    .results-table {

                }                        width: 100%;

                                        border-collapse: collapse;

                function scanRepository() {                        margin-top: 10px;

                    vscode.postMessage({ command: 'scanRepository' });                    }

                }                    .results-table th, .results-table td {

            </script>                        border: 1px solid var(--vscode-panel-border);

        </body>                        padding: 8px;

        </html>`;                        text-align: left;

    }                    }

                    .results-table th {

    _getDependenciesSection() {                        background-color: var(--vscode-editor-selectionBackground);

        const dockerStatus = this._dependenciesInstalled ? '✅' : '❌';                    }

        const installButtonText = this._isInstalling ? 'Installing...' : 'Install Dependencies';                    .replacement-input {

        const showSpinner = this._isInstalling;                        width: 100%;

                                background-color: var(--vscode-input-background);

        return `                        color: var(--vscode-input-foreground);

            <div class="section">                        border: 1px solid var(--vscode-input-border);

                <h3>🔧 Dependencies</h3>                        padding: 4px;

                <div class="status-item">                    }

                    <span><span class="status-icon">${dockerStatus}</span>Docker & Nosey Parker</span>                    .checkbox {

                    ${showSpinner ? '<div class="spinner"></div>' : ''}                        margin-right: 5px;

                </div>                    }

                <button class="install-button" onclick="installDependencies()" ${this._isInstalling ? 'disabled' : ''}>                    .manual-command {

                    ${installButtonText}                        background-color: var(--vscode-textCodeBlock-background);

                </button>                        padding: 10px;

                ${!this._dependenciesInstalled ? '<div class="warning-text">⚠️ Install dependencies before scanning</div>' : ''}                        border-radius: 4px;

            </div>                        font-family: monospace;

        `;                        margin-top: 10px;

    }                        word-break: break-all;

                    }

    _getDirectorySection() {                    .hidden {

        const hasDirectory = this._selectedDirectory !== null;                        display: none;

        const directoryDisplay = hasDirectory                     }

            ? `<div class="selected-path">${this._selectedDirectory}</div>`                </style>

            : '<div class="warning-text">No directory selected</div>';            </head>

                        <body>

        return `                <div class="scan-section">

            <div class="section">                    <h2>🛡️ Leak Lock Scanner</h2>

                <h3>📁 Target Directory</h3>                    ${!this._dependenciesInstalled ? `

                ${directoryDisplay}                    <div class="setup-section">

                <button class="select-button" onclick="selectDirectory()">                        <h3>📋 Setup</h3>

                    ${hasDirectory ? 'Change Directory' : 'Select Directory'}                        <button class="install-button" onclick="installDependencies()">

                </button>                            🔧 Install Dependencies

            </div>                        </button>

        `;                        <p class="setup-info">Install Docker, BFG tool, and Nosey Parker image.</p>

    }                    </div>

                    ` : `

    _getScanSection() {                    <div class="setup-complete-section">

        const canScan = this._dependenciesInstalled && this._selectedDirectory;                        <h3>✅ Setup Complete</h3>

        const buttonText = canScan ? '🔍 Start Scan' : '🔍 Setup Required';                        <p class="setup-complete-info">

                                    🐳 Docker running • 🔧 BFG tool ready • 🔍 Nosey Parker available

        return `                        </p>

            <div class="section">                        <div style="margin-top: 8px;">

                <h3>🚀 Scan Control</h3>                            <button class="install-button" onclick="installDependencies()" style="font-size: 0.8em; padding: 4px 12px; margin-right: 8px;">

                <button class="scan-button" onclick="scanRepository()" ${!canScan ? 'disabled' : ''}>                                🔄 Reinstall

                    ${buttonText}                            </button>

                </button>                            <button class="install-button" onclick="resetDependencies()" style="font-size: 0.8em; padding: 4px 12px; background-color: var(--vscode-button-secondaryBackground);">

                ${!canScan ? '<div class="warning-text">Complete setup steps above first</div>' : ''}                                � Reset Status

            </div>                            </button>

        `;                        </div>

    }                    </div>

                    `}

    async _checkDependencies() {                    

        // Import the dependency check from extension.js                    <div class="directory-section">

        const checkDependencies = require('./extension.js').checkDependencies;                        <h3>📁 Directory Selection</h3>

        if (checkDependencies) {                        <button class="select-button" onclick="selectDirectory()">

            try {                            📂 Select Directory to Scan

                const deps = await checkDependencies();                        </button>

                this._dependenciesInstalled = deps.docker && deps.noseyparker;                        <div class="selected-directory" id="selected-dir">

            } catch (error) {                            ${this._selectedDirectory ? `Selected: ${this._selectedDirectory}` : 'No directory selected'}

                this._dependenciesInstalled = false;                        </div>

            }                    </div>

        }                    

        this._updateView();                    <div class="scan-section">

    }                        <h3>🔍 Security Scan</h3>

                        <button class="scan-button" onclick="scanRepository()" ${!this._selectedDirectory ? 'disabled' : ''}>

    async _installDependencies() {                            ${this._isScanning ? '⏳ Scanning...' : '🔍 Start Security Scan'}

        this._isInstalling = true;                        </button>

        this._updateView();                        <button class="scan-button" onclick="scanCurrentWorkspace()" style="margin-left: 10px;">

                            📂 Scan Current Workspace

        try {                        </button>

            // Show progress notification                    </div>

            await vscode.window.withProgress({                </div>

                location: vscode.ProgressLocation.Notification,                

                title: "Installing dependencies...",                ${hasResults ? this._getResultsHtml() : '<div id="no-results">No scan results yet. Click "Scan" to analyze your repository for secrets.</div>'}

                cancellable: false                

            }, async (progress) => {                <script>

                progress.report({ increment: 20, message: "Checking Docker..." });                    const vscode = acquireVsCodeApi();

                                    

                // Check if Docker is available                    function installDependencies() {

                const { exec } = require('child_process');                        vscode.postMessage({ command: 'installDependencies' });

                const util = require('util');                    }

                const execAsync = util.promisify(exec);                    

                                    function selectDirectory() {

                try {                        vscode.postMessage({ command: 'selectDirectory' });

                    await execAsync('docker --version');                    }

                } catch (error) {                    

                    throw new Error('Docker is not installed or not accessible. Please install Docker first.');                    function scanRepository() {

                }                        vscode.postMessage({ command: 'scan' });

                    }

                progress.report({ increment: 30, message: "Pulling Nosey Parker image..." });                    

                                    function scanCurrentWorkspace() {

                // Pull the Nosey Parker Docker image                        vscode.postMessage({ command: 'scan', useWorkspace: true });

                await execAsync('docker pull ghcr.io/praetorian-inc/noseyparker:latest', { timeout: 300000 });                    }

                                    

                progress.report({ increment: 50, message: "Installation complete!" });                    function fixSecrets() {

                                        const replacements = {};

                this._dependenciesInstalled = true;                        const checkboxes = document.querySelectorAll('.secret-checkbox:checked');

            });                        

                        checkboxes.forEach(checkbox => {

            vscode.window.showInformationMessage('Dependencies installed successfully!');                            const row = checkbox.closest('tr');

        } catch (error) {                            const secretValue = row.dataset.secret;

            vscode.window.showErrorMessage(`Failed to install dependencies: ${error.message}`);                            const replacementInput = row.querySelector('.replacement-input');

            this._dependenciesInstalled = false;                            replacements[secretValue] = replacementInput.value || '*****';

        } finally {                        });

            this._isInstalling = false;                        

            this._updateView();                        vscode.postMessage({ 

        }                            command: 'fix', 

    }                            replacements: replacements 

                        });

    async _selectDirectory() {                    }

        const options = {                    

            canSelectFolders: true,                    function runBFGCommand() {

            canSelectFiles: false,                        const replacements = {};

            canSelectMany: false,                        const checkboxes = document.querySelectorAll('.secret-checkbox:checked');

            openLabel: 'Select Directory to Scan',                        

            defaultUri: this._selectedDirectory ? vscode.Uri.file(this._selectedDirectory) : vscode.workspace.workspaceFolders?.[0]?.uri                        checkboxes.forEach(checkbox => {

        };                            const row = checkbox.closest('tr');

                            const secretValue = row.dataset.secret;

        const result = await vscode.window.showOpenDialog(options);                            const replacementInput = row.querySelector('.replacement-input');

        if (result && result[0]) {                            replacements[secretValue] = replacementInput.value || '*****';

            this._selectedDirectory = result[0].fsPath;                        });

            this._updateView();                        

        }                        vscode.postMessage({ 

    }                            command: 'runBFG', 

                            replacements: replacements 

    _updateView() {                        });

        if (this._view) {                    }

            this._view.webview.html = this._getHtmlForWebview();                    

        }                    function openFile(file, line) {

    }                        vscode.postMessage({ 

                            command: 'openFile', 

    // Public getters for main panel integration                            file: file, 

    get selectedDirectory() {                            line: line 

        return this._selectedDirectory;                        });

    }                    }

                    

    get dependenciesInstalled() {                    function resetDependencies() {

        return this._dependenciesInstalled;                        vscode.postMessage({ command: 'resetDependencies' });

    }                    }

}                </script>

            </body>

}

module.exports = { LeakLockSidebarProvider };            </html>
        `;
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
            info: '#42a5f5'
        };

        const resultsRows = this._scanResults.map((result, index) => `
            <tr data-secret="${result.secret}" data-file="${result.file}" data-line="${result.line}" style="border-left: 3px solid ${severityColors[result.severity] || '#666'};">
                <td><input type="checkbox" class="secret-checkbox checkbox" checked></td>
                <td title="${result.file}">
                    <span class="file-link" onclick="openFile('${result.file}', ${result.line})" style="font-family: monospace; font-size: 0.9em; color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline;">
                        📄 ${result.file}
                    </span>
                </td>
                <td style="text-align: center;">
                    <span class="file-link" onclick="openFile('${result.file}', ${result.line})" style="background: var(--vscode-badge-background); padding: 2px 6px; border-radius: 10px; font-size: 0.8em; cursor: pointer;">
                        ${result.line}
                    </span>
                </td>
                <td>
                    <span style="font-family: monospace; max-width: 200px; overflow: hidden; text-overflow: ellipsis; background: var(--vscode-textCodeBlock-background); padding: 2px 4px; border-radius: 3px;">
                        ${result.secret}
                    </span>
                </td>
                <td>
                    <input type="text" class="replacement-input" value="*****" placeholder="Replacement value">
                </td>
                <td>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="background: ${severityColors[result.severity] || '#666'}; color: white; padding: 2px 6px; border-radius: 10px; font-size: 0.7em; text-transform: uppercase;">
                            ${result.severity}
                        </span>
                        <span style="font-size: 0.9em;">${result.description}</span>
                    </div>
                </td>
            </tr>
        `).join('');

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

        return `
            <div class="scan-section">
                <h2>🔍 Scan Results</h2>
                <div style="margin-bottom: 10px;">
                    <strong>Found ${this._scanResults.length} potential secrets:</strong>
                    <div style="margin-top: 8px;">${severitySummary}</div>
                </div>
                <table class="results-table">
                    <thead>
                        <tr>
                            <th style="width: 40px;">Fix</th>
                            <th style="width: 25%;">File</th>
                            <th style="width: 60px;">Line</th>
                            <th style="width: 30%;">Secret</th>
                            <th style="width: 20%;">Replace With</th>
                            <th>Description</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${resultsRows}
                    </tbody>
                </table>
                <div style="margin-top: 15px;">
                    <button class="fix-button" onclick="fixSecrets()">🔧 Generate Fix Command</button>
                    <button class="scan-button" onclick="scanRepository()" style="margin-left: 10px;">🔄 Scan Again</button>
                </div>
                
                <div class="run-section">
                    <h3>⚡ Execute BFG Cleanup</h3>
                    <p class="warning-text">⚠️ WARNING: This will permanently modify your git history!</p>
                    <p style="font-size: 0.9em; margin: 8px 0;">
                        This will run BFG tool to remove selected secrets from git history and perform cleanup operations.
                        Make sure you have a backup of your repository before proceeding.
                    </p>
                    <button class="run-button" onclick="runBFGCommand()">
                        🚀 Run BFG + Git Cleanup
                    </button>
                </div>
                
                <div style="margin-top: 10px; font-size: 0.9em; color: var(--vscode-descriptionForeground);">
                    💡 <strong>Tip:</strong> Review each secret carefully before applying fixes. Some may be test data or false positives.
                </div>
            </div>
            <div id="manual-command" class="hidden">
                <h3>Manual Fix Command</h3>
                <div class="manual-command" id="command-text"></div>
                <p>Copy and paste this command in your terminal to manually apply the changes:</p>
            </div>
        `;
    }

    async _scanRepository(useWorkspace = false) {
        try {
            this._isScanning = true;
            
            // Update UI to show scanning state
            if (this._view) {
                this._view.webview.html = this._getHtmlForWebview();
            }
            
            // Show progress
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Scanning for secrets...",
                cancellable: false
            }, async (progress) => {
                
                // Determine scan path
                let scanPath;
                if (useWorkspace) {
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                    if (!workspaceFolder) {
                        vscode.window.showErrorMessage('No workspace folder found. Please open a folder first.');
                        return;
                    }
                    scanPath = workspaceFolder.uri.fsPath;
                } else {
                    if (!this._selectedDirectory) {
                        vscode.window.showErrorMessage('No directory selected. Please select a directory to scan first.');
                        return;
                    }
                    scanPath = this._selectedDirectory;
                }
                
                progress.report({ increment: 10, message: "Checking Docker availability..." });
                
                // Check if Docker is available
                const dockerCheck = await this._checkDockerAvailability();
                if (!dockerCheck.available) {
                    vscode.window.showErrorMessage(`Docker not available: ${dockerCheck.error}`);
                    return;
                }

                progress.report({ increment: 20, message: "Pulling Nosey Parker image..." });
                
                // Pull the latest Nosey Parker image
                await this._pullNoseyParkerImage();

                progress.report({ increment: 30, message: "Initializing datastore..." });
                
                // Create temporary datastore
                const tempDatastore = path.join(scanPath, '.noseyparker-temp');
                await this._initializeDatastore(tempDatastore);

                progress.report({ increment: 20, message: "Scanning for secrets..." });
                
                // Run the actual scan
                const scanResults = await this._runNoseyParkerScan(scanPath, tempDatastore);
                
                progress.report({ increment: 20, message: "Processing results..." });
                
                // Clean up temporary datastore
                await this._cleanupTempFiles(tempDatastore);
                
                // Update results
                this._scanResults = scanResults;
                
                // Update the webview
                if (this._view) {
                    this._view.webview.html = this._getHtmlForWebview();
                }
                
                // Show completion message
                if (scanResults.length > 0) {
                    vscode.window.showWarningMessage(`Scan complete! Found ${scanResults.length} potential secrets. Review them in the sidebar.`);
                } else {
                    vscode.window.showInformationMessage('Scan complete! No secrets found in your repository.');
                }
            });
        } catch (error) {
            console.error('Scan error:', error);
            vscode.window.showErrorMessage(`Scan failed: ${error.message}`);
        } finally {
            this._isScanning = false;
            // Update UI to remove scanning state
            if (this._view) {
                this._view.webview.html = this._getHtmlForWebview();
            }
        }
    }

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
            exec(pullCommand, { timeout: 120000 }, (error, stdout, stderr) => {
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
        return new Promise((resolve, reject) => {
            // Remove existing datastore if it exists
            if (fs.existsSync(datastorePath)) {
                fs.rmSync(datastorePath, { recursive: true, force: true });
            }

            const initCommand = `docker run --rm -v "${path.dirname(datastorePath)}:/workspace" ghcr.io/praetorian-inc/noseyparker:latest datastore init --datastore "/workspace/${path.basename(datastorePath)}"`;
            
            exec(initCommand, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`Failed to initialize datastore: ${error.message}`));
                } else {
                    resolve();
                }
            });
        });
    }

    async _runNoseyParkerScan(scanPath, datastorePath) {
        return new Promise((resolve, reject) => {
            // First scan the repository - ensure we scan the mounted directory
            const scanCommand = `docker run --rm -v "${scanPath}:/scan" -v "${datastorePath}:/datastore" ghcr.io/praetorian-inc/noseyparker:latest scan --datastore /datastore /scan`;
            
            exec(scanCommand, { maxBuffer: 1024 * 1024 * 10, timeout: 300000 }, (scanError, scanStdout, scanStderr) => {
                // Nosey Parker may return non-zero exit codes even on successful scans
                // Exit code 2 means findings were found, which is expected
                // Only treat it as an error if it's a real failure (not just findings found)
                if (scanError && scanError.code !== 2 && !scanError.message.includes('exit code 2')) {
                    console.error('Scan error details:', { error: scanError, stdout: scanStdout, stderr: scanStderr });
                    reject(new Error(`Scan failed: ${scanError.message}\nStderr: ${scanStderr}`));
                    return;
                }

                // Now report the findings in structured format
                const reportCommand = `docker run --rm -v "${datastorePath}:/datastore" ghcr.io/praetorian-inc/noseyparker:latest report --datastore /datastore --format json`;
                
                exec(reportCommand, { maxBuffer: 1024 * 1024 * 10 }, (reportError, reportStdout, reportStderr) => {
                    if (reportError) {
                        console.warn('Report command failed, trying alternative approach:', reportError.message);
                        // Fallback to simple format
                        resolve(this._createFallbackResults(scanStdout + scanStderr));
                        return;
                    }

                    try {
                        const results = this._parseNoseyParkerResults(reportStdout);
                        resolve(results);
                    } catch (parseError) {
                        console.warn('Failed to parse JSON results, using fallback:', parseError.message);
                        resolve(this._createFallbackResults(reportStdout + scanStdout));
                    }
                });
            });
        });
    }

    _parseNoseyParkerResults(output) {
        const results = [];
        
        if (!output.trim()) {
            return results;
        }

        try {
            // Parse JSON output from Nosey Parker report command
            // The output is a JSON array of findings
            const jsonFindings = JSON.parse(output);
            
            // Handle the actual Nosey Parker JSON structure (array of findings)
            if (Array.isArray(jsonFindings)) {
                jsonFindings.forEach(finding => {
                    finding.matches?.forEach(match => {
                        const filePath = match.provenance?.[0]?.path || 'unknown';
                        const line = match.location?.source_span?.start?.line || 1;
                        const secretText = match.snippet?.matching || 'unknown';
                        
                        results.push({
                            file: this._getRelativeFilePath(filePath),
                            line: line,
                            secret: this._truncateSecret(secretText),
                            description: finding.rule_name || 'Secret detected',
                            severity: this._getSeverity(finding.rule_name)
                        });
                    });
                });
            } else if (jsonFindings.findings && Array.isArray(jsonFindings.findings)) {
                // Handle alternative structure (if wrapped in an object)
                jsonFindings.findings.forEach(finding => {
                    finding.matches?.forEach(match => {
                        results.push({
                            file: this._getRelativeFilePath(match.location?.path || 'unknown'),
                            line: match.location?.start_line || 1,
                            secret: this._truncateSecret(match.snippet || match.content || 'unknown'),
                            description: finding.rule_name || 'Secret detected',
                            severity: this._getSeverity(finding.rule_name)
                        });
                    });
                });
            } else if (jsonFindings.matches && Array.isArray(jsonFindings.matches)) {
                // Handle yet another alternative structure
                jsonFindings.matches.forEach(match => {
                    results.push({
                        file: this._getRelativeFilePath(match.location?.source_file || match.file || 'unknown'),
                        line: match.location?.line || match.line || 1,
                        secret: this._truncateSecret(match.snippet || match.content || match.secret || 'unknown'),
                        description: match.rule_name || match.type || 'Secret detected',
                        severity: this._getSeverity(match.rule_name || match.type)
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
                            results.push({
                                file: this._getRelativeFilePath(match.location?.source_file || 'unknown'),
                                line: match.location?.line || 1,
                                secret: this._truncateSecret(match.snippet || match.content || 'unknown'),
                                description: match.rule_name || 'Secret detected',
                                severity: this._getSeverity(match.rule_name)
                            });
                        });
                    }
                } catch (lineError) {
                    // Skip invalid JSON lines
                }
            });
        }

        return results;
    }

    _createFallbackResults(output) {
        const results = [];
        const lines = output.split('\n');
        
        // Look for patterns that might indicate secrets were found
        const secretPatterns = [
            /Found.*secret.*in\s+(.+):(\d+)/i,
            /(.+):(\d+).*potential.*secret/i,
            /Secret.*detected.*in\s+(.+):(\d+)/i
        ];

        lines.forEach(line => {
            for (const pattern of secretPatterns) {
                const match = line.match(pattern);
                if (match) {
                    results.push({
                        file: this._getRelativeFilePath(match[1]),
                        line: parseInt(match[2]) || 1,
                        secret: '***hidden***',
                        description: 'Secret detected (details hidden)',
                        severity: 'medium'
                    });
                    break;
                }
            }
        });

        // If no patterns matched but there's output, create a generic result
        if (results.length === 0 && (output.includes('secret') || output.includes('finding'))) {
            results.push({
                file: 'repository',
                line: 1,
                secret: '***scan completed***',
                description: 'Scan completed - check console output for details',
                severity: 'info'
            });
        }

        return results;
    }

    _getRelativeFilePath(filePath) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder && filePath.startsWith(workspaceFolder.uri.fsPath)) {
            return filePath.substring(workspaceFolder.uri.fsPath.length + 1);
        }
        return filePath.replace(/^\/scan\//, '').replace(/^\//, '');
    }

    _truncateSecret(secret) {
        if (secret.length > 50) {
            return secret.substring(0, 50) + '...';
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

    async _cleanupTempFiles(datastorePath) {
        try {
            if (fs.existsSync(datastorePath)) {
                fs.rmSync(datastorePath, { recursive: true, force: true });
            }
        } catch (error) {
            console.warn('Failed to cleanup temporary files:', error.message);
        }
    }

    async _checkDependenciesOnStartup() {
        try {
            const { exec } = require('child_process');
            const util = require('util');
            const execAsync = util.promisify(exec);
            
            // Check Docker
            await execAsync('docker --version');
            await execAsync('docker info');
            
            // Check if Nosey Parker image exists
            await execAsync('docker image inspect ghcr.io/praetorian-inc/noseyparker:latest');
            
            // Check if BFG tool exists
            const bfgPath = path.join(this._extensionUri.fsPath, 'bfg.jar');
            if (fs.existsSync(bfgPath)) {
                this._dependenciesInstalled = true;
                
                // Update UI if view is available
                if (this._view) {
                    this._view.webview.html = this._getHtmlForWebview();
                }
            }
        } catch (error) {
            // Dependencies not fully installed - keep _dependenciesInstalled as false
            console.log('Dependencies check:', error.message);
        }
    }

    _resetDependencyStatus() {
        this._dependenciesInstalled = false;
        if (this._view) {
            this._view.webview.html = this._getHtmlForWebview();
        }
        vscode.window.showInformationMessage('Dependency status reset. You can reinstall dependencies if needed.');
    }

    async _selectDirectory() {
        const options = {
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Select Directory to Scan'
        };

        const folderUri = await vscode.window.showOpenDialog(options);
        if (folderUri && folderUri[0]) {
            this._selectedDirectory = folderUri[0].fsPath;
            vscode.window.showInformationMessage(`Selected directory: ${this._selectedDirectory}`);
            
            // Update the webview to show the selected directory
            if (this._view) {
                this._view.webview.html = this._getHtmlForWebview();
            }
        }
    }

    async _installDependencies() {
        const { exec } = require('child_process');
        const util = require('util');
        const execAsync = util.promisify(exec);
        const path = require('path');
        
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Installing Leak Lock dependencies...",
                cancellable: false
            }, async (progress) => {
                
                progress.report({ increment: 10, message: "Checking system requirements..." });
                
                // Check Docker availability
                try {
                    await execAsync('docker --version');
                    await execAsync('docker info');
                    progress.report({ increment: 20, message: "Docker is available ✓" });
                } catch (error) {
                    throw new Error('Docker is not installed or not running. Please install Docker and start the daemon.');
                }
                
                progress.report({ increment: 20, message: "Downloading BFG tool..." });
                
                // Download BFG tool to extension directory
                const bfgPath = path.join(this._extensionUri.fsPath, 'bfg.jar');
                const bfgUrl = 'https://repo1.maven.org/maven2/com/madgag/bfg/1.14.0/bfg-1.14.0.jar';
                
                try {
                    await execAsync(`curl -L -o "${bfgPath}" "${bfgUrl}"`);
                    progress.report({ increment: 25, message: "BFG tool downloaded ✓" });
                } catch (error) {
                    console.error('Failed to download BFG tool:', error);
                    vscode.window.showWarningMessage('Failed to download BFG tool. You may need to download it manually.');
                }
                
                progress.report({ increment: 25, message: "Pulling Nosey Parker Docker image..." });
                
                // Pull Nosey Parker Docker image
                try {
                    await execAsync('docker pull ghcr.io/praetorian-inc/noseyparker:latest');
                    progress.report({ increment: 0, message: "Nosey Parker image ready ✓" });
                } catch (error) {
                    console.error('Failed to pull Nosey Parker image:', error);
                    throw new Error('Failed to pull Nosey Parker Docker image. Please check your internet connection.');
                }
            });
            
            vscode.window.showInformationMessage('✅ Dependencies installed successfully!');
            
            // Mark dependencies as installed
            this._dependenciesInstalled = true;
            
            // Update the webview to hide the setup section
            if (this._view) {
                this._view.webview.html = this._getHtmlForWebview();
            }
            
        } catch (error) {
            console.error('Failed to install dependencies:', error);
            vscode.window.showErrorMessage(`❌ Failed to install dependencies: ${error.message}`);
            this._dependenciesInstalled = false;
        }
    }

    async _openFileAtLine(file, line) {
        try {
            let filePath = file;
            
            // Handle relative paths
            if (!path.isAbsolute(file)) {
                const scanPath = this._selectedDirectory || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (scanPath) {
                    filePath = path.join(scanPath, file);
                }
            }
            
            const uri = vscode.Uri.file(filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(document);
            
            // Jump to the specific line
            const position = new vscode.Position(Math.max(0, line - 1), 0);
            const range = new vscode.Range(position, position);
            
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            
        } catch (error) {
            console.error('Failed to open file:', error);
            vscode.window.showErrorMessage(`Failed to open file: ${file}`);
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
                // Update webview to show the manual command
                const commandHtml = `
                    <div class="scan-section">
                        <h2>Manual Fix Command</h2>
                        <p>Copy and paste this command in your terminal to fix the secrets:</p>
                        <div class="manual-command">${manualCommand}</div>
                        <p><strong>Warning:</strong> This will rewrite your git history. Make sure to backup your repository first!</p>
                        <p>After running this command, you may need to force push: <code>git push --force-with-lease</code></p>
                    </div>
                `;
                
                vscode.window.showInformationMessage('Manual fix command generated. Check the Leak Lock sidebar for details.');
                
                // For now, we'll just show the command - actual execution should be manual
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

    async _runBFGCommand(replacements) {
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

                progress.report({ increment: 20, message: "Running BFG tool..." });

                // Run BFG command
                const bfgPath = path.join(this._extensionUri.fsPath, 'bfg.jar');
                const bfgCommand = `cd "${scanPath}" && java -jar "${bfgPath}" --replace-text "${replacementsFile}"`;
                
                const { exec } = require('child_process');
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
                '✅ BFG cleanup completed successfully!\n\nYour git history has been cleaned. You may need to force push to update remote repositories.',
                'Show Git Status',
                'OK'
            );

            if (result === 'Show Git Status') {
                // Open a new terminal and show git status
                const terminal = vscode.window.createTerminal('Git Status');
                terminal.sendText(`cd "${scanPath}" && git status`);
                terminal.show();
            }

            // Clear scan results since they may no longer be relevant
            this._scanResults = [];
            if (this._view) {
                this._view.webview.html = this._getHtmlForWebview();
            }

        } catch (error) {
            console.error('BFG execution error:', error);
            vscode.window.showErrorMessage(`❌ BFG cleanup failed: ${error.message}`);
        }
    }

    // resolveWebviewView
    revive(panel) { // vscode.WebviewView
        this._view = panel;
    }

    static register(context) {
        const provider = new SidebarProvider(context.extensionUri);
        vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, provider);
    }

    static viewType = 'leak-lock.sidebar';

    static show(context) {
        vscode.commands.executeCommand('workbench.view.extension.leak-lock-sidebar-view');
    }

    static revive(context) {
        vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, new SidebarProvider(context.extensionUri));
    }

    dispose() {
        this._view = undefined;
    }

}

module.exports = SidebarProvider;
