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