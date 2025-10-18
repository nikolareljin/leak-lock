// Sidebar provider for dependency installation and directory selection
const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

class LeakLockSidebarProvider {
    constructor(extensionUri) {
        this._extensionUri = extensionUri;
        this._view = undefined;
        this._dependenciesInstalled = false;
        this._dependencyStatus = null;
        this._selectedDirectory = null;
        this._isInstalling = false;
        this._installProgress = null;
        this._workspaceGitRepo = null;
        this._showDependencyDetails = false;
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
                    case 'installDependencies':
                        this._installDependencies();
                        break;
                    case 'selectDirectory':
                        this._selectDirectory();
                        break;
                    case 'useGitRepo':
                        this._useGitRepository();
                        break;
                    case 'scanRepository':
                        // Notify main panel to start scanning
                        vscode.commands.executeCommand('leak-lock.startScan', {
                            directory: this._selectedDirectory,
                            dependenciesReady: this._dependenciesInstalled
                        });
                        break;
                    case 'showDependencyDetails':
                        this._showDependencyDetails = true;
                        this._updateView();
                        break;
                    case 'hideDependencyDetails':
                        this._showDependencyDetails = false;
                        this._updateView();
                        break;
                    case 'openRemoveFiles':
                        // Open the main panel in Remove Files mode
                        vscode.commands.executeCommand('leak-lock.openRemoveFiles');
                        break;
                }
            },
            undefined,
            []
        );

        // Check dependencies and git repository on initialization
        this._checkDependencies();
        this._detectGitRepository();
    }

    _getHtmlForWebview() {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Leak Lock Control Panel</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    color: var(--vscode-foreground);
                    background: var(--vscode-editor-background);
                    margin: 0;
                    padding: 10px;
                    line-height: 1.4;
                }
                
                .section {
                    margin-bottom: 20px;
                    padding: 15px;
                    background: var(--vscode-sideBar-background);
                    border: 1px solid var(--vscode-sideBar-border);
                    border-radius: 5px;
                }
                
                .section h3 {
                    margin-top: 0;
                    margin-bottom: 10px;
                    color: var(--vscode-sideBarSectionHeader-foreground);
                    font-size: 14px;
                    font-weight: 600;
                }
                
                .install-button, .select-button, .scan-button {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 8px 16px;
                    border-radius: 3px;
                    cursor: pointer;
                    font-size: 12px;
                    width: 100%;
                    margin-top: 5px;
                }
                
                .install-button:hover, .select-button:hover, .scan-button:hover {
                    background: var(--vscode-button-hoverBackground);
                }
                
                .install-button:disabled, .select-button:disabled, .scan-button:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                
                .status-item {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin: 5px 0;
                    font-size: 12px;
                }
                
                .status-icon {
                    font-size: 14px;
                    margin-right: 5px;
                }
                
                .spinner {
                    border: 2px solid var(--vscode-progressBar-background);
                    border-top: 2px solid var(--vscode-progressBar-foreground);
                    border-radius: 50%;
                    width: 12px;
                    height: 12px;
                    animation: spin 1s linear infinite;
                }
                
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                
                /* Installation Instructions Styles */
                .install-instructions {
                    margin: 8px 0 15px 20px;
                    padding: 12px;
                    background: var(--vscode-textCodeBlock-background);
                    border-radius: 6px;
                    border-left: 3px solid var(--vscode-inputValidation-errorBorder);
                }
                
                .error-message {
                    font-size: 11px;
                    color: var(--vscode-inputValidation-errorForeground);
                    margin-bottom: 10px;
                    font-weight: 600;
                }
                
                .warning-message {
                    font-size: 11px;
                    color: var(--vscode-inputValidation-warningForeground);
                    margin-bottom: 10px;
                    font-weight: 600;
                }
                
                .install-guide {
                    font-size: 10px;
                    line-height: 1.4;
                }
                
                .install-guide strong {
                    color: var(--vscode-foreground);
                    font-size: 11px;
                }
                
                .install-steps {
                    margin: 8px 0;
                }
                
                .install-platform {
                    margin: 8px 0;
                    padding: 6px;
                    background: var(--vscode-editor-background);
                    border-radius: 4px;
                }
                
                .install-platform strong {
                    display: block;
                    margin-bottom: 4px;
                    color: var(--vscode-textLink-foreground);
                }
                
                .install-platform ol {
                    margin: 4px 0;
                    padding-left: 16px;
                }
                
                .install-platform li {
                    margin: 2px 0;
                    line-height: 1.3;
                }
                
                .install-platform code {
                    background: var(--vscode-textCodeBlock-background);
                    padding: 1px 3px;
                    border-radius: 2px;
                    font-family: var(--vscode-editor-font-family);
                    font-size: 9px;
                }
                
                .help-links, .help-note {
                    margin-top: 8px;
                    padding-top: 6px;
                    border-top: 1px solid var(--vscode-panel-border);
                    font-size: 10px;
                }
                
                .help-note {
                    color: var(--vscode-descriptionForeground);
                    font-style: italic;
                }
                
                .install-instructions a {
                    color: var(--vscode-textLink-foreground);
                    text-decoration: none;
                }
                
                .install-instructions a:hover {
                    text-decoration: underline;
                }
                
                .selected-path {
                    font-family: monospace;
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    background: var(--vscode-textCodeBlock-background);
                    padding: 5px;
                    border-radius: 3px;
                    margin-top: 5px;
                    word-break: break-all;
                }
                
                .warning-text {
                    color: var(--vscode-inputValidation-warningForeground);
                    font-size: 11px;
                    margin-top: 5px;
                }
            </style>
        </head>
        <body>
            ${this._getDependenciesSection()}
            ${this._getDirectorySection()}
            ${this._getScanSection()}
            ${this._getRemoveFilesSection()}
            
            <script>
                const vscode = acquireVsCodeApi();
                
                function installDependencies() {
                    vscode.postMessage({ command: 'installDependencies' });
                }
                
                function selectDirectory() {
                    vscode.postMessage({ command: 'selectDirectory' });
                }
                
                function useGitRepo() {
                    vscode.postMessage({ command: 'useGitRepo' });
                }
                
                function scanRepository() {
                    vscode.postMessage({ command: 'scanRepository' });
                }
                
                function showDependencyDetails() {
                    vscode.postMessage({ command: 'showDependencyDetails' });
                }
                
                function hideDependencyDetails() {
                    vscode.postMessage({ command: 'hideDependencyDetails' });
                }

                function openRemoveFiles() {
                    vscode.postMessage({ command: 'openRemoveFiles' });
                }
            </script>
        </body>
        </html>`;
    }

    _getDependenciesSection() {
        // If all dependencies are met and details not requested, show compact status
        if (this._dependenciesInstalled && !this._isInstalling && !this._showDependencyDetails) {
            return `
                <div class="section" style="padding: 10px 15px;">
                    <div style="display: flex; align-items: center; justify-content: space-between;">
                        <span style="color: var(--vscode-gitDecoration-addedResourceForeground); font-size: 12px;">
                            ✅ Dependencies ready
                        </span>
                        <button class="install-button" onclick="showDependencyDetails()" 
                                style="width: auto; padding: 4px 8px; font-size: 11px; margin: 0;">
                            Details
                        </button>
                    </div>
                </div>
            `;
        }
        
        // Show detailed dependency information when not all are met or installing
        const installButtonText = this._isInstalling ? 'Installing...' : 'Install Dependencies';
        const showSpinner = this._isInstalling;
        
        // Get status for each dependency
        const dockerStatus = this._dependencyStatus?.docker?.installed ? '✅' : '❌';
        const noseyparkerStatus = this._dependencyStatus?.noseyparker?.installed ? '✅' : '❌';
        const javaStatus = this._dependencyStatus?.java?.installed ? '✅' : '⚠️';
        const bfgStatus = this._dependencyStatus?.bfg?.installed ? '✅' : '⚠️';
        
        return `
            <div class="section">
                <h3>🔧 Dependencies Setup</h3>
                
                <div style="margin-bottom: 15px; font-size: 11px; color: var(--vscode-descriptionForeground);">
                    <strong>Required for scanning:</strong>
                </div>
                
                <div class="status-item">
                    <span><span class="status-icon">${dockerStatus}</span>Docker Engine</span>
                    ${showSpinner && !this._dependencyStatus?.docker?.installed ? '<div class="spinner"></div>' : ''}
                </div>
                ${this._dependencyStatus?.docker?.error ? `
                    <div class="install-instructions">
                        <div class="error-message">❌ ${this._dependencyStatus.docker.error}</div>
                        <div class="install-guide">
                            <strong>📥 How to Install Docker:</strong>
                            <div class="install-steps">
                                <div class="install-platform">
                                    <strong>🖥️ Windows:</strong>
                                    <ol>
                                        <li>Download <a href="https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe" target="_blank">Docker Desktop for Windows</a></li>
                                        <li>Run installer and follow setup wizard</li>
                                        <li>Restart computer if prompted</li>
                                        <li>Start Docker Desktop from Start Menu</li>
                                    </ol>
                                </div>
                                <div class="install-platform">
                                    <strong>🍎 macOS:</strong>
                                    <ol>
                                        <li>Download <a href="https://desktop.docker.com/mac/main/amd64/Docker.dmg" target="_blank">Docker Desktop for Mac</a></li>
                                        <li>Double-click Docker.dmg and drag to Applications</li>
                                        <li>Launch Docker.app from Applications</li>
                                    </ol>
                                </div>
                                <div class="install-platform">
                                    <strong>🐧 Linux (Ubuntu/Debian):</strong>
                                    <ol>
                                        <li><code>curl -fsSL https://get.docker.com -o get-docker.sh</code></li>
                                        <li><code>sudo sh get-docker.sh</code></li>
                                        <li><code>sudo usermod -aG docker $USER</code></li>
                                        <li>Log out and back in, then <code>docker --version</code></li>
                                    </ol>
                                </div>
                            </div>
                            <div class="help-links">
                                🔗 <a href="https://docs.docker.com/get-docker/" target="_blank">Official Docker Installation Guide</a>
                            </div>
                        </div>
                    </div>
                ` : ''}
                ${this._dependencyStatus?.docker?.version ? `
                    <div style="font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: 20px; margin-bottom: 5px;">
                        ${this._dependencyStatus.docker.version}
                    </div>
                ` : ''}
                
                <div class="status-item">
                    <span><span class="status-icon">${noseyparkerStatus}</span>Nosey Parker Image</span>
                    ${showSpinner && this._dependencyStatus?.docker?.installed && !this._dependencyStatus?.noseyparker?.installed ? '<div class="spinner"></div>' : ''}
                </div>
                ${this._dependencyStatus?.noseyparker?.error ? `
                    <div style="font-size: 10px; color: var(--vscode-inputValidation-errorForeground); margin-left: 20px; margin-bottom: 5px;">
                        ${this._dependencyStatus.noseyparker.error}
                    </div>
                ` : ''}
                
                <div style="margin: 15px 0 10px 0; font-size: 11px; color: var(--vscode-descriptionForeground);">
                    <strong>Optional for BFG cleanup:</strong>
                </div>
                
                <div class="status-item">
                    <span><span class="status-icon">${javaStatus}</span>Java Runtime</span>
                </div>
                ${this._dependencyStatus?.java?.error ? `
                    <div class="install-instructions">
                        <div class="warning-message">⚠️ ${this._dependencyStatus.java.error}</div>
                        <div class="install-guide">
                            <strong>☕ How to Install Java Runtime:</strong>
                            <div class="install-steps">
                                <div class="install-platform">
                                    <strong>🖥️ Windows:</strong>
                                    <ol>
                                        <li>Download <a href="https://adoptium.net/temurin/releases/" target="_blank">Eclipse Temurin JDK</a></li>
                                        <li>Choose Latest LTS version (Java 21)</li>
                                        <li>Run the .msi installer</li>
                                        <li>Add to PATH when prompted</li>
                                        <li>Verify: Open Command Prompt → <code>java -version</code></li>
                                    </ol>
                                </div>
                                <div class="install-platform">
                                    <strong>🍎 macOS:</strong>
                                    <ol>
                                        <li>Using Homebrew: <code>brew install openjdk@21</code></li>
                                        <li>Or download from <a href="https://adoptium.net/temurin/releases/" target="_blank">Adoptium</a></li>
                                        <li>Verify: <code>java -version</code></li>
                                    </ol>
                                </div>
                                <div class="install-platform">
                                    <strong>🐧 Linux (Ubuntu/Debian):</strong>
                                    <ol>
                                        <li><code>sudo apt update</code></li>
                                        <li><code>sudo apt install openjdk-21-jdk</code></li>
                                        <li>Verify: <code>java -version</code></li>
                                    </ol>
                                </div>
                            </div>
                            <div class="help-note">
                                💡 <strong>Note:</strong> Java is optional - needed only for automated BFG cleanup. 
                                You can still scan for secrets without Java using manual commands.
                            </div>
                            <div class="help-links">
                                🔗 <a href="https://adoptium.net/installation/" target="_blank">Java Installation Guide</a>
                            </div>
                        </div>
                    </div>
                ` : ''}
                ${this._dependencyStatus?.java?.version ? `
                    <div style="font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: 20px; margin-bottom: 5px;">
                        ${this._dependencyStatus.java.version}
                    </div>
                ` : ''}
                
                <div class="status-item">
                    <span><span class="status-icon">${bfgStatus}</span>BFG Tool</span>
                    ${showSpinner && this._dependencyStatus?.java?.installed && !this._dependencyStatus?.bfg?.installed ? '<div class="spinner"></div>' : ''}
                </div>
                ${this._dependencyStatus?.bfg?.error ? `
                    <div style="font-size: 10px; color: var(--vscode-inputValidation-warningForeground); margin-left: 20px; margin-bottom: 5px;">
                        ${this._dependencyStatus.bfg.error} (manual commands available)
                    </div>
                ` : ''}
                
                <button class="install-button" onclick="installDependencies()" ${this._isInstalling ? 'disabled' : ''}>
                    ${installButtonText}
                </button>
                
                ${this._dependenciesInstalled && this._showDependencyDetails ? `
                    <button class="install-button" onclick="hideDependencyDetails()" 
                            style="background: var(--vscode-button-secondaryBackground); margin-top: 8px;">
                        Hide Details
                    </button>
                ` : ''}
                
                ${!this._dependenciesInstalled ? `
                    <div class="warning-text">
                        ⚠️ Docker and Nosey Parker are required for scanning
                    </div>
                ` : ''}
                
                <div style="font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 10px; line-height: 1.3;">
                    <strong>Prerequisites:</strong><br>
                    • Docker Engine must be running<br>
                    • Internet connection for image downloads<br>
                    • Java 8+ recommended for automated BFG execution
                </div>
            </div>
        `;
    }

    _getDirectorySection() {
        const hasDirectory = this._selectedDirectory !== null;
        const isGitRepo = this._workspaceGitRepo && this._selectedDirectory === this._workspaceGitRepo;
        
        let directoryDisplay = '';
        let statusInfo = '';
        
        if (hasDirectory) {
            // Show the selected path
            directoryDisplay = `<div class="selected-path">${this._selectedDirectory}</div>`;
            
            // Add status information
            if (isGitRepo) {
                statusInfo = '<div style="color: var(--vscode-gitDecoration-addedResourceForeground); font-size: 11px; margin-top: 5px;">📦 Git repository detected</div>';
            } else if (this._workspaceGitRepo) {
                statusInfo = `
                    <div style="color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 5px;">
                        ℹ️ Git repo available: <span style="font-family: monospace; font-size: 10px;">${path.basename(this._workspaceGitRepo)}</span>
                        <button onclick="useGitRepo()" style="margin-left: 5px; font-size: 10px; padding: 2px 6px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 2px; cursor: pointer;">Use Git Repo</button>
                    </div>
                `;
            }
        } else {
            if (this._workspaceGitRepo) {
                directoryDisplay = `
                    <div style="color: var(--vscode-descriptionForeground); margin-bottom: 10px;">
                        📦 Git repository detected: <br>
                        <code style="font-size: 0.9em; background: var(--vscode-textCodeBlock-background); padding: 2px 4px; border-radius: 2px;">${this._workspaceGitRepo}</code>
                    </div>
                    <button onclick="useGitRepo()" style="margin-bottom: 8px; width: 100%; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 6px 12px; border-radius: 3px; cursor: pointer; font-size: 12px;">
                        📦 Use Git Repository
                    </button>
                `;
            } else {
                directoryDisplay = '<div class="warning-text">No directory selected</div>';
            }
        }
            
        return `
            <div class="section">
                <h3>📁 Target Directory</h3>
                ${directoryDisplay}
                ${statusInfo}
                <button class="select-button" onclick="selectDirectory()">
                    ${hasDirectory ? '📂 Change Directory' : '📂 Select Directory'}
                </button>
            </div>
        `;
    }

    _getScanSection() {
        const canScan = this._dependenciesInstalled && this._selectedDirectory;
        const buttonText = canScan ? '🔍 Start Scan' : '🔍 Setup Required';
        const isGitRepo = this._workspaceGitRepo && this._selectedDirectory === this._workspaceGitRepo;
        
        let scanInfo = '';
        if (canScan) {
            const directoryName = path.basename(this._selectedDirectory);
            if (isGitRepo) {
                scanInfo = `<div style="color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 5px;">📦 Will scan git repository: <strong>${directoryName}</strong></div>`;
            } else {
                scanInfo = `<div style="color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 5px;">📁 Will scan directory: <strong>${directoryName}</strong></div>`;
            }
        }
        
        return `
            <div class="section">
                <h3>🚀 Scan Control</h3>
                <button class="scan-button" onclick="scanRepository()" ${!canScan ? 'disabled' : ''}>
                    ${buttonText}
                </button>
                ${!canScan ? '<div class="warning-text">Complete setup steps above first</div>' : scanInfo}
            </div>
        `;
    }

    _getRemoveFilesSection() {
        return `
            <div class="section">
                <h3>🗑️ Remove Files</h3>
                <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px;">
                    Remove unwanted files from git repository
                </div>
                <button class="scan-button" onclick="openRemoveFiles()">
                    🗑️ Remove files
                </button>
            </div>
        `;
    }

    async _checkDependencies() {
        const { exec } = require('child_process');
        const util = require('util');
        const execAsync = util.promisify(exec);
        
        this._dependencyStatus = {
            docker: { installed: false, version: null, error: null },
            noseyparker: { installed: false, error: null },
            java: { installed: false, version: null, error: null },
            bfg: { installed: false, path: null, error: null }
        };
        
        // Check Docker
        try {
            const dockerVersion = await execAsync('docker --version');
            this._dependencyStatus.docker.installed = true;
            this._dependencyStatus.docker.version = dockerVersion.stdout.trim();
            
            // Check if Docker daemon is running
            try {
                await execAsync('docker info');
            } catch (daemonError) {
                this._dependencyStatus.docker.error = 'Docker daemon not running';
                this._dependencyStatus.docker.installed = false;
            }
        } catch (error) {
            this._dependencyStatus.docker.error = 'Docker not installed or not in PATH';
        }
        
        // Check Nosey Parker image
        try {
            await execAsync('docker images ghcr.io/praetorian-inc/noseyparker:latest --format "table {{.Repository}}"');
            this._dependencyStatus.noseyparker.installed = true;
        } catch (error) {
            this._dependencyStatus.noseyparker.error = 'Nosey Parker Docker image not available';
        }
        
        // Check Java
        try {
            const javaVersion = await execAsync('java -version 2>&1');
            this._dependencyStatus.java.installed = true;
            this._dependencyStatus.java.version = javaVersion.stderr.split('\n')[0];
        } catch (error) {
            this._dependencyStatus.java.error = 'Java not installed or not in PATH';
        }
        
        // Check BFG tool
        const bfgPath = path.join(this._extensionUri.fsPath, 'bfg.jar');
        if (fs.existsSync(bfgPath)) {
            this._dependencyStatus.bfg.installed = true;
            this._dependencyStatus.bfg.path = bfgPath;
        } else {
            this._dependencyStatus.bfg.error = 'BFG tool not downloaded';
        }
        
        // Overall status - all core dependencies must be met
        this._dependenciesInstalled = this._dependencyStatus.docker.installed && 
                                      this._dependencyStatus.noseyparker.installed;
        
        this._updateView();
    }

    async _detectGitRepository() {
        try {
            // Check if there are workspace folders
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return;
            }

            // Check each workspace folder for git repository
            for (const folder of workspaceFolders) {
                const folderPath = folder.uri.fsPath;
                const gitPath = path.join(folderPath, '.git');
                
                try {
                    // Check if .git directory or file exists
                    if (fs.existsSync(gitPath)) {
                        const stat = fs.statSync(gitPath);
                        if (stat.isDirectory() || stat.isFile()) {
                            // This is a git repository
                            this._workspaceGitRepo = folderPath;
                            
                            // Auto-select if no directory is currently selected
                            if (!this._selectedDirectory) {
                                this._selectedDirectory = folderPath;
                            }
                            
                            this._updateView();
                            return;
                        }
                    }
                } catch (error) {
                    // Continue checking other folders
                    continue;
                }
            }
            
            // If no git repo found but workspace exists, offer first workspace folder
            if (!this._selectedDirectory && workspaceFolders.length > 0) {
                this._selectedDirectory = workspaceFolders[0].uri.fsPath;
                this._updateView();
            }
            
        } catch (error) {
            console.warn('Failed to detect git repository:', error.message);
        }
    }

    async _installDependencies() {
        this._isInstalling = true;
        this._updateView();

        try {
            // Show progress notification
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Installing dependencies...",
                cancellable: false
            }, async (progress) => {
                progress.report({ increment: 20, message: "Checking Docker..." });
                
                // Check if Docker is available
                const { exec } = require('child_process');
                const util = require('util');
                const execAsync = util.promisify(exec);
                
                try {
                    await execAsync('docker --version');
                } catch (error) {
                    throw new Error('Docker is not installed or not accessible. Please install Docker first.');
                }

                progress.report({ increment: 30, message: "Pulling Nosey Parker image..." });
                
                // Pull the Nosey Parker Docker image
                await execAsync('docker pull ghcr.io/praetorian-inc/noseyparker:latest', { timeout: 300000 });
                
                progress.report({ increment: 30, message: "Downloading BFG tool..." });
                
                // Download BFG tool
                try {
                    const bfgPath = path.join(this._extensionUri.fsPath, 'bfg.jar');
                    const bfgUrl = 'https://repo1.maven.org/maven2/com/madgag/bfg/1.14.0/bfg-1.14.0.jar';
                    await execAsync(`curl -L -o "${bfgPath}" "${bfgUrl}"`);
                } catch (bfgError) {
                    console.warn('Failed to download BFG tool:', bfgError.message);
                    // Continue without BFG - it's optional
                }
                
                progress.report({ increment: 20, message: "Verifying installation..." });
                
                // Recheck all dependencies
                await this._checkDependencies();
            });

            vscode.window.showInformationMessage('Dependencies installed successfully!');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to install dependencies: ${error.message}`);
            // Still recheck dependencies to get accurate status
            await this._checkDependencies();
        } finally {
            this._isInstalling = false;
            this._updateView();
        }
    }

    async _selectDirectory() {
        // Determine the best default directory
        let defaultUri;
        if (this._selectedDirectory) {
            defaultUri = vscode.Uri.file(this._selectedDirectory);
        } else if (this._workspaceGitRepo) {
            defaultUri = vscode.Uri.file(this._workspaceGitRepo);
        } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            defaultUri = vscode.workspace.workspaceFolders[0].uri;
        }

        const options = {
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Select Directory to Scan for Secrets',
            defaultUri: defaultUri
        };

        const result = await vscode.window.showOpenDialog(options);
        if (result && result[0]) {
            this._selectedDirectory = result[0].fsPath;
            this._updateView();
            
            // Show confirmation message
            const isGitRepo = this._workspaceGitRepo === result[0].fsPath;
            const message = isGitRepo 
                ? `Selected git repository: ${path.basename(result[0].fsPath)}`
                : `Selected directory: ${path.basename(result[0].fsPath)}`;
            vscode.window.showInformationMessage(message);
        }
    }

    _useGitRepository() {
        if (this._workspaceGitRepo) {
            this._selectedDirectory = this._workspaceGitRepo;
            this._updateView();
            vscode.window.showInformationMessage(`Selected git repository: ${path.basename(this._workspaceGitRepo)}`);
        }
    }

    _updateView() {
        if (this._view) {
            this._view.webview.html = this._getHtmlForWebview();
        }
    }

    // Public getters for main panel integration
    get selectedDirectory() {
        return this._selectedDirectory;
    }

    get dependenciesInstalled() {
        return this._dependenciesInstalled;
    }
}

module.exports = { LeakLockSidebarProvider };