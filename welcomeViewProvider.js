// Welcome view provider for the activity bar that launches the main panel
const vscode = require('vscode');

class WelcomeViewProvider {
    constructor(extensionUri) {
        this._extensionUri = extensionUri;
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
                    case 'openMainPanel':
                        // Import and open the main panel
                        const LeakLockPanel = require('./leakLockPanel');
                        LeakLockPanel.createOrShow(this._extensionUri);
                        break;
                }
            }
        );
    }

    _getHtmlForWebview() {
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
                        padding: 15px;
                        margin: 0;
                        text-align: center;
                    }
                    .welcome-section {
                        padding: 20px;
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 6px;
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
                        margin-bottom: 15px;
                    }
                    .main-button {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 12px 20px;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 1em;
                        font-weight: bold;
                        width: 100%;
                        margin: 10px 0;
                    }
                    .main-button:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }
                    .icon {
                        font-size: 2em;
                        margin-bottom: 15px;
                    }
                    .description {
                        font-size: 0.9em;
                        color: var(--vscode-descriptionForeground);
                        margin: 10px 0;
                        line-height: 1.4;
                    }
                </style>
            </head>
            <body>
                <div class="welcome-section">
                    <div class="icon">🛡️</div>
                    <h3>Leak Lock Scanner</h3>
                    <div class="description">
                        Secure your code repositories by detecting and removing sensitive information from git history.
                    </div>
                    <button class="main-button" onclick="openMainPanel()">
                        🚀 Open Scanner
                    </button>
                    <div class="description" style="margin-top: 15px; font-size: 0.85em;">
                        Click to open the full scanner interface in the main editor area.
                    </div>
                </div>
                
                <script>
                    const vscode = acquireVsCodeApi();
                    
                    function openMainPanel() {
                        vscode.postMessage({ command: 'openMainPanel' });
                    }
                </script>
            </body>
            </html>
        `;
    }

    static get viewType() {
        return 'leak-lock.welcome';
    }
}

module.exports = WelcomeViewProvider;