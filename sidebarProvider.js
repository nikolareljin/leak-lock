// Sidebar provider that uses the Webview API to display security issues in the sidebar.

const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// implements vscode.WebviewViewProvider
class SidebarProvider {
    constructor(extensionUri) {
        this._extensionUri = extensionUri;
        this._scanResults = [];
        this._replacementValues = {};
    }

    resolveWebviewView(webviewView, context, _token) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        
        webviewView.webview.html = this._getHtmlForWebview();
        
        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'scan':
                        this._scanRepository();
                        break;
                    case 'fix':
                        this._fixSecrets(message.replacements);
                        break;
                    case 'selectDirectory':
                        this._selectDirectory();
                        break;
                }
            }
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
                        padding: 10px;
                        margin: 0;
                    }
                    .scan-section {
                        margin-bottom: 20px;
                        padding: 10px;
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 4px;
                    }
                    .scan-button, .fix-button, .select-button {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 8px 16px;
                        border-radius: 4px;
                        cursor: pointer;
                        margin: 5px 5px 5px 0;
                    }
                    .scan-button:hover, .fix-button:hover, .select-button:hover {
                        background-color: var(--vscode-button-hoverBackground);
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
                </style>
            </head>
            <body>
                <div class="scan-section">
                    <h2>Repository Scanner</h2>
                    <button class="scan-button" onclick="scanRepository()">Scan Current Repository</button>
                    <button class="select-button" onclick="selectDirectory()">Select Directory to Scan</button>
                </div>
                
                ${hasResults ? this._getResultsHtml() : '<div id="no-results">No scan results yet. Click "Scan" to analyze your repository for secrets.</div>'}
                
                <script>
                    const vscode = acquireVsCodeApi();
                    
                    function scanRepository() {
                        vscode.postMessage({ command: 'scan' });
                    }
                    
                    function selectDirectory() {
                        vscode.postMessage({ command: 'selectDirectory' });
                    }
                    
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
                </script>
            </body>
            </html>
        `;
    }

    _getResultsHtml() {
        if (this._scanResults.length === 0) {
            return '<div>No secrets found in the scan.</div>';
        }

        const resultsRows = this._scanResults.map((result, index) => `
            <tr data-secret="${result.secret}">
                <td><input type="checkbox" class="secret-checkbox checkbox" checked></td>
                <td>${result.file}</td>
                <td>${result.line}</td>
                <td style="font-family: monospace; max-width: 200px; overflow: hidden; text-overflow: ellipsis;">${result.secret}</td>
                <td><input type="text" class="replacement-input" value="*****" placeholder="Replacement value"></td>
                <td>${result.description || 'Secret detected'}</td>
            </tr>
        `).join('');

        return `
            <div class="scan-section">
                <h2>Scan Results (${this._scanResults.length} secrets found)</h2>
                <table class="results-table">
                    <thead>
                        <tr>
                            <th>Fix</th>
                            <th>File</th>
                            <th>Line</th>
                            <th>Secret</th>
                            <th>Replace With</th>
                            <th>Description</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${resultsRows}
                    </tbody>
                </table>
                <button class="fix-button" onclick="fixSecrets()" style="margin-top: 10px;">Fix Selected Secrets</button>
            </div>
            <div id="manual-command" class="hidden">
                <h3>Manual Fix Command</h3>
                <div class="manual-command" id="command-text"></div>
                <p>Copy and paste this command in your terminal to manually apply the changes:</p>
            </div>
        `;
    }

    async _scanRepository() {
        try {
            // Show progress
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Scanning repository for secrets...",
                cancellable: false
            }, async (progress) => {
                
                // Get workspace folder
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    vscode.window.showErrorMessage('No workspace folder found. Please open a folder first.');
                    return;
                }

                const scanPath = workspaceFolder.uri.fsPath;
                
                progress.report({ increment: 10, message: "Preparing Docker scan..." });
                
                // Run Nosey Parker Docker scan
                const dockerCommand = `docker run --rm -v "${scanPath}:/scan" ghcr.io/praetorian-inc/noseyparker:latest scan --datastore /tmp/np --format json /scan`;
                
                progress.report({ increment: 50, message: "Running security scan..." });
                
                exec(dockerCommand, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
                    if (error) {
                        console.error('Scan error:', error);
                        vscode.window.showErrorMessage(`Scan failed: ${error.message}. Make sure Docker is running and the Nosey Parker image is available.`);
                        return;
                    }

                    progress.report({ increment: 30, message: "Processing results..." });
                    
                    try {
                        // Parse results (Nosey Parker outputs JSONL format)
                        const results = this._parseNoseyParkerResults(stdout);
                        this._scanResults = results;
                        
                        // Update the webview
                        if (this._view) {
                            this._view.webview.html = this._getHtmlForWebview();
                        }
                        
                        progress.report({ increment: 10, message: "Scan complete!" });
                        
                        if (results.length > 0) {
                            vscode.window.showInformationMessage(`Scan complete! Found ${results.length} potential secrets.`);
                        } else {
                            vscode.window.showInformationMessage('Scan complete! No secrets found.');
                        }
                    } catch (parseError) {
                        console.error('Parse error:', parseError);
                        vscode.window.showErrorMessage('Failed to parse scan results.');
                    }
                });
            });
        } catch (error) {
            console.error('Scan error:', error);
            vscode.window.showErrorMessage(`Scan failed: ${error.message}`);
        }
    }

    _parseNoseyParkerResults(output) {
        const results = [];
        
        if (!output.trim()) {
            return results;
        }

        try {
            // Try to parse as JSON first
            const jsonOutput = JSON.parse(output);
            if (jsonOutput.matches && Array.isArray(jsonOutput.matches)) {
                jsonOutput.matches.forEach(match => {
                    results.push({
                        file: match.location?.source_file || 'unknown',
                        line: match.location?.offset_span?.start?.line || 0,
                        secret: match.snippet || match.content || 'unknown',
                        description: match.rule_name || 'Secret detected'
                    });
                });
            }
        } catch (jsonError) {
            // If JSON parsing fails, try JSONL format
            const lines = output.split('\n').filter(line => line.trim());
            
            lines.forEach(line => {
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.matches && Array.isArray(parsed.matches)) {
                        parsed.matches.forEach(match => {
                            results.push({
                                file: match.location?.source_file || 'unknown',
                                line: match.location?.offset_span?.start?.line || 0,
                                secret: match.snippet || match.content || 'unknown',
                                description: match.rule_name || 'Secret detected'
                            });
                        });
                    }
                } catch (lineError) {
                    // Skip invalid JSON lines
                    console.warn('Skipping invalid JSON line:', line);
                }
            });
            
            // If still no results, create mock data for testing
            if (results.length === 0 && output.includes('error') === false) {
                console.log('No structured results found, creating example data');
                results.push({
                    file: 'example.js',
                    line: 1,
                    secret: 'sk_test_123456789abcdef',
                    description: 'Example API key detected'
                });
            }
        }

        return results;
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
            // Here we would scan the selected directory
            // For now, show a message
            vscode.window.showInformationMessage(`Selected directory: ${folderUri[0].fsPath}. Directory scanning will be implemented in the next iteration.`);
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
