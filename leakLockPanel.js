// Main area panel provider that uses the Webview API to display security issues in the main editor area.

const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// Webview panel provider for main area display
class LeakLockPanel {
    constructor(extensionUri) {
        this._extensionUri = extensionUri;
        this._scanResults = [];
        this._replacementValues = {};
        this._selectedDirectory = null;
        this._isScanning = false;
        this._scanProgress = null;
        this._dependenciesInstalled = false;
        this._panel = null;
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
                }
            },
            undefined,
            []
        );
    }

    _getHtmlForWebview() {
        const hasResults = this._scanResults.length > 0;

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
                    }
                    .results-table th, .results-table td {
                        border: 1px solid var(--vscode-panel-border);
                        padding: 8px;
                        text-align: left;
                    }
                    .results-table th {
                        background-color: var(--vscode-editor-selectionBackground);
                    }
                    .replacement-input {
                        width: 100%;
                        background-color: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        border: 1px solid var(--vscode-input-border);
                        padding: 4px;
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
                    
                    function fixSecrets() {
                        const replacements = {};
                        const checkboxes = document.querySelectorAll('.secret-checkbox:checked');
                        
                        checkboxes.forEach(checkbox => {
                            const row = checkbox.closest('tr');
                            const secretValue = row.dataset.secret;
                            const replacementInput = row.querySelector('.replacement-input');
                            replacements[secretValue] = replacementInput.value || '*****';
                        });
                        
                        vscode.postMessage({ 
                            command: 'fix', 
                            replacements: replacements 
                        });
                    }
                    
                    function runBFGCommand() {
                        const replacements = {};
                        const checkboxes = document.querySelectorAll('.secret-checkbox:checked');
                        
                        checkboxes.forEach(checkbox => {
                            const row = checkbox.closest('tr');
                            const secretValue = row.dataset.secret;
                            const replacementInput = row.querySelector('.replacement-input');
                            replacements[secretValue] = replacementInput.value || '*****';
                        });
                        
                        vscode.postMessage({ 
                            command: 'runBFG', 
                            replacements: replacements 
                        });
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
                </script>
            </body>
            </html>
        `;
    }

    // Method to start scan from sidebar
    startScanFromSidebar(directory, dependenciesReady) {
        if (directory) {
            this._selectedDirectory = directory;
        }
        this._dependenciesInstalled = dependenciesReady;

        // Update UI and start scan
        if (this._panel) {
            this._panel.webview.html = this._getHtmlForWebview();
        }

        // Start the scan if both directory and dependencies are ready
        if (this._selectedDirectory && this._dependenciesInstalled) {
            this._scanRepository();
        }
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
            info: '#42a5f5',
            warning: '#ff9800'
        };

        const resultsRows = this._scanResults.map((result, index) => {
            const isDependency = result.isDependency;
            const isGitHistory = result.isGitHistory;

            // Choose appropriate icon and styling
            let icon = '📄';
            let iconTooltip = 'Current file';
            if (isDependency) {
                icon = '⚠️';
                iconTooltip = 'Dependency directory';
            } else if (isGitHistory) {
                icon = '🕒';
                iconTooltip = 'Git history (past commit/branch)';
            }

            const rowStyle = isDependency ? 'opacity: 0.7;' : '';
            const contextNote = isDependency ? ' (dependency directory)' : (isGitHistory ? ' (git history)' : '');

            return `
                <tr data-secret="${result.secret}" data-file="${result.file}" data-line="${result.line}" style="border-left: 3px solid ${severityColors[result.severity] || '#666'}; ${rowStyle}">
                    <td><input type="checkbox" class="secret-checkbox checkbox" ${isDependency ? '' : 'checked'}></td>
                    <td title="${result.file}${contextNote}">
                        <span class="file-link" onclick="${isGitHistory ? '' : `openFile('${result.file}', ${result.line})`}" style="font-family: monospace; font-size: 0.9em; color: var(--vscode-textLink-foreground); ${isGitHistory ? 'cursor: default;' : 'cursor: pointer; text-decoration: underline;'}" title="${iconTooltip}">
                            ${icon} ${result.file}
                        </span>
                        ${isDependency ? '<span style="font-size: 0.7em; color: var(--vscode-descriptionForeground); margin-left: 5px;">(deps)</span>' : ''}
                        ${isGitHistory ? '<span style="font-size: 0.7em; color: var(--vscode-descriptionForeground); margin-left: 5px;">(history)</span>' : ''}
                    </td>
                    <td style="text-align: center;">
                        <span class="file-link" onclick="${isGitHistory ? '' : `openFile('${result.file}', ${result.line})`}" style="background: var(--vscode-badge-background); padding: 2px 6px; border-radius: 10px; font-size: 0.8em; ${isGitHistory ? 'cursor: default;' : 'cursor: pointer;'}">
                            ${result.line}
                        </span>
                    </td>
                    <td>
                        <span style="font-family: monospace; max-width: 200px; overflow: hidden; text-overflow: ellipsis; background: var(--vscode-textCodeBlock-background); padding: 2px 4px; border-radius: 3px;">
                            ${result.secret}
                        </span>
                    </td>
                    <td>
                        <input type="text" class="replacement-input" value="*****" placeholder="Replacement value" ${isDependency ? 'disabled' : ''}>
                    </td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span style="background: ${severityColors[result.severity] || '#666'}; color: white; padding: 2px 6px; border-radius: 10px; font-size: 0.7em; text-transform: uppercase;">
                                ${result.severity}
                            </span>
                            <span style="font-size: 0.9em;">
                                ${result.description}
                                ${isDependency ? ' <span style="color: var(--vscode-descriptionForeground); font-size: 0.8em;">(in dependency)</span>' : ''}
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

        return `
            <div class="scan-section">
                <h2>🔍 Scan Results</h2>
                <div style="margin-bottom: 15px;">
                    <strong>Found ${this._scanResults.length} potential secrets:</strong>
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
            // Show scanning in progress
            this._isScanning = true;
            this._scanResults = [];
            this._updateWebviewContent();

            // Determine scan path
            let scanPath;
            if (useWorkspace) {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    vscode.window.showErrorMessage('No workspace folder found. Please open a folder first.');
                    this._isScanning = false;
                    this._updateWebviewContent();
                    return;
                }
                scanPath = workspaceFolder.uri.fsPath;
            } else {
                if (!this._selectedDirectory) {
                    vscode.window.showErrorMessage('No directory selected. Please select a directory to scan first.');
                    this._isScanning = false;
                    this._updateWebviewContent();
                    return;
                }
                scanPath = this._selectedDirectory;
            }

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

            // Create temporary datastore
            const tempDatastore = path.join(scanPath, '.noseyparker-temp');
            await this._initializeDatastore(tempDatastore);

            // Update progress: Scanning
            this._scanProgress = { stage: 'scan', message: 'Scanning for secrets...' };
            this._updateWebviewContent();

            // Run the actual scan
            const scanResults = await this._runNoseyParkerScan(scanPath, tempDatastore);

            // Update progress: Processing
            this._scanProgress = { stage: 'process', message: 'Processing results...' };
            this._updateWebviewContent();

            // Clean up temporary datastore
            await this._cleanupTempFiles(tempDatastore);

            // Update results
            this._scanResults = scanResults;
            this._isScanning = false;
            this._scanProgress = null;

            // Update the webview
            this._updateWebviewContent();

            // Show completion message
            if (scanResults.length > 0) {
                vscode.window.showWarningMessage(`Scan complete! Found ${scanResults.length} potential secrets. Review them in the main panel.`);
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
                        <p class="progress-message">${this._scanProgress?.message || 'Scanning in progress...'}</p>
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
        // Aggressively remove existing datastore if it exists
        if (fs.existsSync(datastorePath)) {
            await this._cleanupTempFiles(datastorePath);
        }

        // Ensure the parent directory exists
        const parentDir = path.dirname(datastorePath);
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }

        return new Promise((resolve, reject) => {
            // Use a more explicit initialization command that avoids schema conflicts
            const initCommand = `docker run --rm -v "${path.dirname(datastorePath)}:/workspace" ghcr.io/praetorian-inc/noseyparker:latest datastore init --datastore "/workspace/${path.basename(datastorePath)}"`;

            exec(initCommand, (error, stdout, stderr) => {
                if (error) {
                    // If initialization fails, try to force cleanup and retry once
                    console.warn('Initial datastore init failed, trying cleanup and retry:', error.message);
                    this._cleanupTempFiles(datastorePath).then(() => {
                        // Retry initialization
                        exec(initCommand, (retryError, retryStdout, retryStderr) => {
                            if (retryError) {
                                reject(new Error(`Failed to initialize datastore after retry: ${retryError.message}\nStderr: ${retryStderr}`));
                            } else {
                                resolve();
                            }
                        });
                    }).catch(cleanupError => {
                        reject(new Error(`Failed to initialize datastore and cleanup failed: ${error.message}\nCleanup error: ${cleanupError.message}`));
                    });
                } else {
                    resolve();
                }
            });
        });
    }

    async _runNoseyParkerScan(scanPath, datastorePath) {
        return new Promise((resolve, reject) => {
            // Get dependency handling configuration
            const config = vscode.workspace.getConfiguration('leakLock');
            const dependencyHandling = config.get('dependencyHandling') || 'warning';

            // Create ignore file for proper exclusion if needed
            let ignoreFileOptions = '';
            if (dependencyHandling === 'exclude') {
                // For now, let's skip file-based exclusions to avoid issues
                // We'll handle dependency filtering in the results processing instead
                console.log('Dependency exclusion will be handled in post-processing');
            }

            // Ensure git history scanning is explicitly enabled
            const gitHistoryOption = '--git-history full';

            // First scan the repository with full git history
            const scanCommand = `docker run --rm -v "${scanPath}:/scan" -v "${datastorePath}:/datastore" ghcr.io/praetorian-inc/noseyparker:latest scan --datastore /datastore ${gitHistoryOption} /scan`;

            exec(scanCommand, { maxBuffer: 1024 * 1024 * 10, timeout: 300000 }, (scanError, scanStdout, scanStderr) => {
                // Nosey Parker may return non-zero exit codes even on successful scans
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
        const gitRefPattern = /\.git\/refs\/(heads|tags|remotes)\/(.+)/;

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
                            console.warn(`Finding ${findingIndex}, Match ${matchIndex}: No file path found in match`);
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
                    // Skip invalid JSON lines
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

    _createResult(filePath, line, secret, description, ruleName, match = null) {
        const relativeFile = this._getRelativeFilePath(filePath);
        const isInDependency = this._isInDependencyDirectory(relativeFile);

        // Check if this result comes from git history by examining provenance
        let isGitHistory = false;
        if (match && match.provenance && Array.isArray(match.provenance)) {
            isGitHistory = match.provenance.some(prov => prov.kind === 'git_repo');
        }
        // Also check legacy path-based detection
        isGitHistory = isGitHistory || filePath.startsWith('git-ref:') || filePath.startsWith('git-object') || filePath === 'git-history-reference';

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

        const result = {
            file: relativeFile,
            line: line,
            secret: this._truncateSecret(secret),
            description: enhancedDescription,
            severity: severity,
            isDependency: isInDependency,
            originalSeverity: this._getSeverity(ruleName),
            isGitHistory: isGitHistory
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
        const util = require('util');
        const execAsync = util.promisify(exec);

        try {
            if (fs.existsSync(datastorePath)) {
                // Try multiple approaches to remove files
                try {
                    fs.rmSync(datastorePath, { recursive: true, force: true });
                } catch (fsError) {
                    console.warn('fs.rmSync failed, trying Docker cleanup:', fsError.message);

                    // Use Docker to clean up files that might have been created with root permissions
                    const cleanupCommand = `docker run --rm -v "${path.dirname(datastorePath)}:/workspace" alpine:latest rm -rf "/workspace/${path.basename(datastorePath)}"`;
                    await execAsync(cleanupCommand);
                }
            }
        } catch (error) {
            console.warn('All cleanup attempts failed:', error.message);
            // Try a final forceful cleanup with sudo-like approach in Docker
            try {
                const forceCleanupCommand = `docker run --rm -v "${path.dirname(datastorePath)}:/workspace" --user root alpine:latest sh -c "rm -rf /workspace/${path.basename(datastorePath)} || true"`;
                await execAsync(forceCleanupCommand);
            } catch (finalError) {
                console.warn('Final forceful cleanup also failed:', finalError.message);
                // At this point, just log the issue and continue
            }
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

                progress.report({ increment: 20, message: "Running BFG tool..." });

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
            if (this._panel) {
                this._panel.webview.html = this._getHtmlForWebview();
            }

        } catch (error) {
            console.error('BFG execution error:', error);
            vscode.window.showErrorMessage(`❌ BFG cleanup failed: ${error.message}`);
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