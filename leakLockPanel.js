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
                
                ${hasResults ? this._getResultsHtml() : '<div id="no-results">No scan results yet. Use the <strong>Control Panel</strong> in the sidebar to set up dependencies and start scanning.</div>'}
                
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
            const icon = isDependency ? '⚠️' : '📄';
            const rowStyle = isDependency ? 'opacity: 0.7;' : '';
            const dependencyNote = isDependency ? ' (dependency directory)' : '';
            
            return `
                <tr data-secret="${result.secret}" data-file="${result.file}" data-line="${result.line}" style="border-left: 3px solid ${severityColors[result.severity] || '#666'}; ${rowStyle}">
                    <td><input type="checkbox" class="secret-checkbox checkbox" ${isDependency ? '' : 'checked'}></td>
                    <td title="${result.file}${dependencyNote}">
                        <span class="file-link" onclick="openFile('${result.file}', ${result.line})" style="font-family: monospace; font-size: 0.9em; color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline;">
                            ${icon} ${result.file}
                        </span>
                        ${isDependency ? '<span style="font-size: 0.7em; color: var(--vscode-descriptionForeground); margin-left: 5px;">(deps)</span>' : ''}
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
            this._isScanning = true;
            
            // Update UI to show scanning state
            if (this._panel) {
                this._panel.webview.html = this._getHtmlForWebview();
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
                if (this._panel) {
                    this._panel.webview.html = this._getHtmlForWebview();
                }
                
                // Show completion message
                if (scanResults.length > 0) {
                    vscode.window.showWarningMessage(`Scan complete! Found ${scanResults.length} potential secrets. Review them in the panel.`);
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
            if (this._panel) {
                this._panel.webview.html = this._getHtmlForWebview();
            }
        }
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
        // Remove existing datastore if it exists
        if (fs.existsSync(datastorePath)) {
            await this._cleanupTempFiles(datastorePath);
        }

        return new Promise((resolve, reject) => {
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
            // Get dependency handling configuration
            const config = vscode.workspace.getConfiguration('leakLock');
            const dependencyHandling = config.get('dependencyHandling') || 'warning';
            
            // Build exclusion options for dependency directories if configured to exclude
            let excludeOptions = '';
            if (dependencyHandling === 'exclude') {
                const excludePaths = [
                    'node_modules', 'vendor', '.git', 'dist', 'build', 'target', 
                    'venv', 'env', '.venv', '__pycache__', '.tox', 'site-packages',
                    '.m2', 'lib', 'libs', '.bundle', 'gems', 'packages', 'bin', 'obj',
                    'out', 'tmp', 'temp', 'cache', '.cache', 'logs', '.logs',
                    '.vscode', '.idea', '.eclipse', '.settings'
                ];
                // Add exclusion flags for each directory
                excludeOptions = excludePaths.map(path => `--ignore="${path}"`).join(' ');
            }
            
            // First scan the repository
            const scanCommand = `docker run --rm -v "${scanPath}:/scan" -v "${datastorePath}:/datastore" ghcr.io/praetorian-inc/noseyparker:latest scan --datastore /datastore ${excludeOptions} /scan`;
            
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

    _parseNoseyParkerResults(output) {
        const results = [];
        
        if (!output.trim()) {
            return results;
        }

        try {
            // Parse JSON output from Nosey Parker report command
            const jsonFindings = JSON.parse(output);
            
            if (Array.isArray(jsonFindings)) {
                jsonFindings.forEach(finding => {
                    finding.matches?.forEach(match => {
                        const filePath = match.provenance?.[0]?.path || 'unknown';
                        const line = match.location?.source_span?.start?.line || 1;
                        const secretText = match.snippet?.matching || 'unknown';
                        
                        results.push(this._createResult(
                            filePath,
                            line,
                            secretText,
                            finding.rule_name || 'Secret detected',
                            finding.rule_name
                        ));
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
                            results.push(this._createResult(
                                match.location?.source_file || 'unknown',
                                match.location?.line || 1,
                                match.snippet || match.content || 'unknown',
                                match.rule_name || 'Secret detected',
                                match.rule_name
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
                    results.push(this._createResult(
                        match[1],
                        parseInt(match[2]) || 1,
                        '***hidden***',
                        'Secret detected (details hidden)',
                        'unknown'
                    ));
                    break;
                }
            }
        });

        // If no patterns matched but there's output, create a generic result
        if (results.length === 0 && (output.includes('secret') || output.includes('finding'))) {
            results.push(this._createResult(
                'repository',
                1,
                '***scan completed***',
                'Scan completed - check console output for details',
                'info'
            ));
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

    _createResult(filePath, line, secret, description, ruleName) {
        const relativeFile = this._getRelativeFilePath(filePath);
        const isInDependency = this._isInDependencyDirectory(relativeFile);
        
        // Get dependency handling configuration
        const config = vscode.workspace.getConfiguration('leakLock');
        const dependencyHandling = config.get('dependencyHandling') || 'warning';
        
        // Determine severity based on configuration
        let severity = this._getSeverity(ruleName);
        if (isInDependency && dependencyHandling === 'warning') {
            severity = 'warning';
        }
        
        return {
            file: relativeFile,
            line: line,
            secret: this._truncateSecret(secret),
            description: description,
            severity: severity,
            isDependency: isInDependency,
            originalSeverity: this._getSeverity(ruleName)
        };
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
            if (fs.existsSync(datastorePath)) {
                fs.rmSync(datastorePath, { recursive: true, force: true });
            }
        } catch (error) {
            console.warn('Failed to cleanup temporary files:', error.message);
            // Try using Docker to clean up the files
            try {
                const cleanupCommand = `docker run --rm -v "${path.dirname(datastorePath)}:/workspace" alpine:latest rm -rf "/workspace/${path.basename(datastorePath)}"`;
                const { exec } = require('child_process');
                const util = require('util');
                const execAsync = util.promisify(exec);
                await execAsync(cleanupCommand);
            } catch (dockerError) {
                console.warn('Docker cleanup also failed:', dockerError.message);
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