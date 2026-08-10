// Sidebar provider for dependency installation and directory selection
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
// The pinned Nosey Parker image. Checking or pulling `:latest` here while the scanner
// runs the pinned tag meant these two disagreed about which image mattered.
const scanEngineConfig = require('./scan-engine-config');
// The native engines answer "installed?" and "which version?" themselves, so the
// panel asks them rather than carrying a second detection path that can disagree.
const scanEngines = require('./scan-engines');
// Leak Lock runs Gitleaks and TruffleHog as local executables, so setup downloads the
// release binary per platform rather than pulling an image. Kept in its own module with
// no vscode import so the Windows naming, URLs and extraction are assertable anywhere.
const engineInstall = require('./engine-install');
// The container fallback, for a machine where a downloaded executable will not run but
// Docker will.
const engineDocker = require('./engine-docker');
// Keywords are user-supplied and land in both element text and attribute values,
// so they must be escaped before interpolation into the webview HTML. Shared with
// leakLockPanel.js so both webviews escape identically.
const { escapeHtml } = require('./html-escape');

/**
 * Java's version banner, from whichever stream it lands on.
 *
 * `java -version` prints to stderr, and the shell form `java -version 2>&1` redirects
 * it to stdout — so code that runs the redirected form and then reads `stderr` gets an
 * empty string and stores a blank version beside a ✅. Reading both streams makes the
 * answer independent of which one it arrived on, and execFile drops the shell entirely.
 *
 * @returns {Promise<string>} the first line of the banner
 * @throws if no JVM is present
 */
async function readJavaVersionBanner() {
    const execFileAsync = require('util').promisify(require('child_process').execFile);
    const { stdout, stderr } = await execFileAsync('java', ['-version'], { timeout: 15000 });
    return `${stderr || ''}${stdout || ''}`.trim().split('\n')[0] || 'installed, version not reported';
}

class LeakLockSidebarProvider {
    /**
     * @param {vscode.Uri} extensionUri
     * @param {vscode.Uri} [storageUri] global storage; engines are installed here
     *   rather than in the extension directory, which an update replaces wholesale.
     */
    constructor(extensionUri, storageUri) {
        this._extensionUri = extensionUri;
        this._engineInstallDir = engineInstall.engineInstallDir(
            (storageUri && storageUri.fsPath) || extensionUri.fsPath
        );
        // Register before any probe: a binary Leak Lock installed lives on no PATH, so
        // without this the extension could download an engine and still call it missing.
        scanEngines.addBinarySearchDir(this._engineInstallDir);
        // Per-engine install outcomes, keyed by engine id. Rendered next to the engine
        // rather than folded into one "dependencies installed" message, because a
        // partial install is the normal outcome and has to be visible as one.
        this._engineInstallResults = {};
        this._engineInstallInFlight = new Set();
        this._view = undefined;
        this._dependenciesInstalled = false;
        this._dependencyStatus = null;
        this._selectedDirectory = null;
        this._isInstalling = false;
        this._installProgress = null;
        this._workspaceGitRepo = null;
        this._showDependencyDetails = false;
        this._showGitHistorySection = false;
        // Native engine probe results. null until the details are opened, because
        // probing spawns a subprocess per engine and the compact view never shows it.
        this._engineStatus = null;
        this._engineProbeInFlight = false;
    }

    resolveWebviewView(webviewView, _context, _token) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview();

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'installDependencies':
                        // Same reasoning as installEngine below: nothing consumes this
                        // promise, so a rejection would vanish and the button would look
                        // like it did nothing.
                        this._installDependencies()
                            .catch(error => {
                                console.error('Dependency setup failed:', error);
                                // Belt and braces with the finally inside
                                // _installDependencies: whichever path a failure takes,
                                // the panel must not be left showing an install that is
                                // no longer running.
                                this._isInstalling = false;
                                this._updateView();
                                vscode.window.showErrorMessage(`Dependency setup failed: ${error.message}`);
                            });
                        break;
                    case 'installEngine':
                        // Per-tool, per-method and user-initiated: one engine failing
                        // must never stop another being installed or from scanning.
                        //
                        // Awaiting alone would not help — nothing consumes this
                        // handler's promise — so an unexpected rejection is caught and
                        // shown. A button that silently does nothing is the worst of the
                        // available outcomes, and the whole point of this release is
                        // that setup does not fail quietly.
                        this._installEngine(message.engineId, { method: message.method })
                            .catch(error => {
                                console.error('Engine installation failed:', error);
                                vscode.window.showErrorMessage(
                                    `Could not install ${message.engineId}: ${error.message}`
                                );
                            });
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
                        // Probing costs a subprocess per engine, so it happens on expand
                        // rather than on every render. The engine probes swallow their
                        // own errors, but the surrounding work does not, so the promise
                        // is still guarded — an unhandled rejection here would leave the
                        // block stuck on "Checking installed engines…" with no reason.
                        this._refreshEngineStatus()
                            .catch(error => console.error('Engine probe failed:', error));
                        break;
                    case 'hideDependencyDetails':
                        this._showDependencyDetails = false;
                        this._updateView();
                        break;
                    case 'openWebsite':
                        // Awaiting alone would not help: nothing consumes this
                        // handler's promise, so a rejection would go unhandled.
                        try {
                            await vscode.commands.executeCommand('leak-lock.openWebsite');
                        } catch (error) {
                            console.error('Failed to open the project website:', error);
                        }
                        break;
                    case 'openRemoveFiles':
                        // Open the main panel in Remove Files mode with current selection
                        vscode.commands.executeCommand('leak-lock.openRemoveFiles', {
                            directory: this._selectedDirectory || this._workspaceGitRepo || null
                        });
                        break;
                    case 'toggleGitHistorySection':
                        this._showGitHistorySection = !this._showGitHistorySection;
                        this._updateView();
                        break;
                    case 'updateGitHistorySetting': {
                        const cfg = vscode.workspace.getConfiguration('leakLock');
                        await cfg.update(
                            `gitHistoryKeywordSearch.${message.key}`,
                            message.value,
                            vscode.ConfigurationTarget.Global
                        );
                        this._updateView();
                        break;
                    }
                    case 'addGitHistoryKeyword': {
                        const keyword = (message.keyword || '').trim();
                        if (!keyword) break;
                        const cfg = vscode.workspace.getConfiguration('leakLock');
                        const current = cfg.get('gitHistoryKeywordSearch.keywords') || [];
                        if (!current.includes(keyword)) {
                            await cfg.update(
                                'gitHistoryKeywordSearch.keywords',
                                [...current, keyword],
                                vscode.ConfigurationTarget.Global
                            );
                        }
                        this._updateView();
                        break;
                    }
                    case 'removeGitHistoryKeyword': {
                        const keyword = (message.keyword || '').trim();
                        if (!keyword) break;
                        const cfg = vscode.workspace.getConfiguration('leakLock');
                        const current = cfg.get('gitHistoryKeywordSearch.keywords') || [];
                        await cfg.update(
                            'gitHistoryKeywordSearch.keywords',
                            current.filter(k => k !== keyword),
                            vscode.ConfigurationTarget.Global
                        );
                        this._updateView();
                        break;
                    }
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

                .toggle-row {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin: 6px 0;
                    font-size: 12px;
                }

                .toggle-btn {
                    width: 36px;
                    height: 18px;
                    border-radius: 9px;
                    border: none;
                    cursor: pointer;
                    position: relative;
                    transition: background 0.2s;
                    flex-shrink: 0;
                }

                .toggle-btn.on {
                    background: var(--vscode-button-background);
                }

                .toggle-btn.off {
                    background: var(--vscode-button-secondaryBackground);
                }

                .toggle-btn::after {
                    content: '';
                    position: absolute;
                    top: 2px;
                    width: 14px;
                    height: 14px;
                    border-radius: 50%;
                    background: var(--vscode-button-foreground);
                    transition: left 0.2s;
                }

                .toggle-btn.on::after { left: 20px; }
                .toggle-btn.off::after { left: 2px; }

                .keyword-list {
                    margin: 6px 0;
                    max-height: 120px;
                    overflow-y: auto;
                }

                .keyword-item {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 2px 4px;
                    margin: 2px 0;
                    background: var(--vscode-textCodeBlock-background);
                    border-radius: 3px;
                    font-size: 11px;
                    font-family: var(--vscode-editor-font-family);
                }

                .keyword-remove {
                    background: none;
                    border: none;
                    color: var(--vscode-inputValidation-errorForeground);
                    cursor: pointer;
                    font-size: 13px;
                    padding: 0 3px;
                    line-height: 1;
                }

                .keyword-remove:focus-visible {
                    outline: 1px solid var(--vscode-focusBorder);
                    outline-offset: 1px;
                    border-radius: 2px;
                }

                .keyword-add-row {
                    display: flex;
                    gap: 4px;
                    margin-top: 6px;
                }

                .keyword-input {
                    flex: 1;
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 3px;
                    padding: 3px 6px;
                    font-size: 11px;
                    font-family: var(--vscode-editor-font-family);
                    min-width: 0;
                }

                .keyword-add-btn {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    border-radius: 3px;
                    padding: 3px 8px;
                    cursor: pointer;
                    font-size: 11px;
                    white-space: nowrap;
                }

                .keyword-add-btn:hover {
                    background: var(--vscode-button-hoverBackground);
                }

                .number-input {
                    width: 60px;
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 3px;
                    padding: 3px 6px;
                    font-size: 11px;
                    text-align: right;
                }

                .section-toggle-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    cursor: pointer;
                    margin: 0;
                    padding: 0;
                }

                .section-toggle-header h3 {
                    margin: 0;
                }

                .chevron {
                    font-size: 10px;
                    color: var(--vscode-descriptionForeground);
                }
            </style>
        </head>
        <body>
            ${this._getDependenciesSection()}
            ${this._getDirectorySection()}
            ${this._getScanSection()}
            ${this._getGitHistorySection()}
            ${this._getRemoveFilesSection()}
            
            <script>
                const vscode = acquireVsCodeApi();
                
                function installDependencies() {
                    vscode.postMessage({ command: 'installDependencies' });
                }

                // Delegated, like every other button that carries data: the engine id
                // travels in a data attribute rather than inside an inline handler.
                document.addEventListener('click', (e) => {
                    const btn = e.target instanceof Element
                        ? e.target.closest('[data-install-engine]')
                        : null;
                    if (!btn) return;
                    vscode.postMessage({
                        command: 'installEngine',
                        engineId: btn.dataset.installEngine,
                        method: btn.dataset.installMethod
                    });
                });
                
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

                function openWebsite() {
                    vscode.postMessage({ command: 'openWebsite' });
                }

                function toggleGitHistorySection() {
                    vscode.postMessage({ command: 'toggleGitHistorySection' });
                }

                function toggleGitHistorySetting(key, current) {
                    vscode.postMessage({ command: 'updateGitHistorySetting', key, value: !current });
                }

                function updateMaxMatches(value) {
                    const n = parseInt(value, 10);
                    if (!isNaN(n) && n >= 1 && n <= 500) {
                        vscode.postMessage({ command: 'updateGitHistorySetting', key: 'maxMatchesPerKeyword', value: n });
                    }
                }

                // Every keyword edit round-trips through the extension and comes back as
                // _updateView(), which replaces the whole document — scroll position and
                // focus do not survive that. vscode.setState() does, so an edit is flagged
                // before the message goes out and the next document restores the view.
                function markKeywordEdit(edit) {
                    const list = document.querySelector('.keyword-list');
                    vscode.setState({
                        ...(vscode.getState() || {}),
                        keywordEdit: { ...edit, scrollTop: list ? list.scrollTop : 0 }
                    });
                }

                function restoreKeywordFocus() {
                    const state = vscode.getState() || {};
                    const edit = state.keywordEdit;
                    if (!edit) return;
                    vscode.setState({ ...state, keywordEdit: null });

                    const list = document.querySelector('.keyword-list');
                    const input = document.getElementById('keyword-input');

                    // A removal leaves the list where it was: the item that shifted into
                    // the freed slot takes focus, so removing a run of keywords from the
                    // middle does not throw the list back to the top or the bottom.
                    if (edit.type === 'remove') {
                        if (list) list.scrollTop = edit.scrollTop;
                        const buttons = document.querySelectorAll('.keyword-remove');
                        if (buttons.length) {
                            const target = buttons[Math.min(edit.index, buttons.length - 1)];
                            target.focus({ preventScroll: true });
                            target.scrollIntoView({ block: 'nearest' });
                            return;
                        }
                    } else if (list) {
                        // Keywords are appended, so an addition lands at the end.
                        list.scrollTop = list.scrollHeight;
                    }

                    if (input) {
                        input.focus();
                        input.scrollIntoView({ block: 'nearest' });
                    }
                }

                function addKeyword() {
                    const input = document.getElementById('keyword-input');
                    const keyword = (input?.value || '').trim();
                    if (!keyword) return;
                    markKeywordEdit({ type: 'add' });
                    vscode.postMessage({ command: 'addGitHistoryKeyword', keyword });
                    if (input) input.value = '';
                }

                // Delegated: the keyword list is re-rendered on every _updateView(),
                // and passing the keyword through a data attribute avoids quoting it
                // into an inline onclick.
                document.addEventListener('click', (e) => {
                    const btn = e.target instanceof Element
                        ? e.target.closest('.keyword-remove')
                        : null;
                    if (!btn) return;
                    const buttons = Array.from(document.querySelectorAll('.keyword-remove'));
                    markKeywordEdit({ type: 'remove', index: buttons.indexOf(btn) });
                    vscode.postMessage({
                        command: 'removeGitHistoryKeyword',
                        keyword: btn.dataset.keyword
                    });
                });

                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && document.activeElement?.id === 'keyword-input') {
                        addKeyword();
                    }
                });

                restoreKeywordFocus();
            </script>
        </body>
        </html>`;
    }

    /**
     * Which Leak Lock is running.
     *
     * Read from the loaded extension rather than the checked-out package.json, so a
     * development host and an installed build cannot report the same number while
     * running different code. Falls back to the manifest when the extension host is
     * not available, which is the case in unit tests.
     *
     * Only rendered in the expanded block: the compact view is a status line, and a
     * version number there is noise until someone is actually diagnosing something.
     */
    _getInstalledVersionHtml() {
        let version;
        try {
            version = vscode.extensions.getExtension('nikolareljin.leak-lock')?.packageJSON?.version;
        } catch {
            version = undefined;
        }
        if (!version) {
            version = require('./package.json').version;
        }
        return `
            <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 12px;">
                <strong>Leak Lock</strong> v${escapeHtml(version)}
            </div>`;
    }

    /**
     * The engines that actually scan, with their installed versions.
     *
     * Rendered only inside the expanded block: the compact view is a one-line "ready"
     * summary, and probing three binaries to fill a line nobody opened is work for
     * nothing.
     */
    _getEngineStatusHtml() {
        const label = (text) =>
            `<div style="margin: 0 0 6px 0; font-size: 11px; color: var(--vscode-descriptionForeground);"><strong>${text}</strong></div>`;
        const note = (text, colour = 'var(--vscode-descriptionForeground)') =>
            `<div style="font-size: 10px; color: ${colour}; margin-left: 20px; margin-bottom: 5px;">${text}</div>`;

        if (this._engineProbeInFlight && !this._engineStatus) {
            return label('Scan engines:') + note('Checking installed engines…');
        }
        if (!this._engineStatus) {
            return '';
        }

        const rows = this._engineStatus.map(engine => {
            // An engine that is enabled but missing is the case worth flagging: the scan
            // still runs, reports fewer findings, and looks identical to a clean result.
            const icon = engine.installed ? '✅' : (engine.enabled ? '⚠️' : '➖');
            const name = escapeHtml(engine.displayName);
            const installable = engineInstall.INSTALLABLE_ENGINE_IDS.includes(engine.id);
            const installing = this._engineInstallInFlight.has(engine.id);
            let detail;
            if (engine.installed) {
                // Name the runtime. A container fallback that silently took over is
                // indistinguishable from the binary until a version differs.
                const via = engine.runtime === 'docker'
                    ? ` — running from the Docker image ${escapeHtml(engine.image || '')}`
                    : ' — native binary';
                detail = note(escapeHtml(engine.version || 'installed, version not reported')
                    + via
                    + (engine.enabled ? '' : ' — disabled in leakLock.scan.engines'));
            } else if (engine.enabled) {
                detail = note(
                    `Not installed, but enabled in leakLock.scan.engines — scans run without it. `
                    + `<a href="${escapeHtml(engine.installHint)}">Install ${name}</a>`,
                    'var(--vscode-inputValidation-warningForeground)'
                );
            } else {
                detail = note('Not installed, not enabled');
            }

            // Both ways of getting this engine, chosen per engine. "Install
            // Dependencies" takes the native binary and falls back to the image on its
            // own; these buttons are for picking one deliberately — a machine where
            // downloaded executables are blocked by policy wants the image directly,
            // and there is no way for Leak Lock to know that in advance.
            //
            // Nosey Parker has no buttons here: Leak Lock only ever runs it as an image,
            // so it belongs to the Docker section below.
            const method = (id, label, title) =>
                `<button class="install-button" data-install-engine="${escapeHtml(engine.id)}" data-install-method="${id}"
                         title="${escapeHtml(title)}"
                         style="width: auto; padding: 4px 8px; font-size: 11px; margin: 0 6px 0 0;"
                         ${installing ? 'disabled' : ''}>${label}</button>`;

            const buttons = installable && !engine.installed
                ? `<div style="margin-left: 20px; margin-bottom: 8px;">
                        ${installing ? `<span style="font-size: 11px;">Installing ${name}…</span>` : `
                            ${method('binary', 'Install binary', `Download the ${engine.displayName} release binary. No Docker required.`)}
                            ${method('docker', 'Use Docker image', `Pull ${engine.image || 'the official image'} and run ${engine.displayName} in a container.`)}
                        `}
                   </div>`
                : '';

            return `
                <div class="status-item">
                    <span><span class="status-icon">${icon}</span>${name}</span>
                </div>
                ${detail}
                ${buttons}
                ${this._getEngineInstallResultHtml(engine.id, note)}`;
        }).join('');

        return label('Scan engines:') + rows;
    }

    /**
     * The outcome of the last install attempt for one engine.
     *
     * Kept per engine and shown next to it. A single "Dependencies installed
     * successfully!" over a run where one of two engines failed is the exact defect
     * this release fixes, so the failure has to have somewhere of its own to appear.
     */
    _getEngineInstallResultHtml(engineId, note) {
        const result = this._engineInstallResults?.[engineId];
        if (!result) {
            return '';
        }
        if (!result.ok) {
            return note(escapeHtml(result.error || 'Installation failed.'),
                'var(--vscode-inputValidation-errorForeground)');
        }
        const warnings = (result.warnings || [])
            .map(text => note(escapeHtml(text), 'var(--vscode-inputValidation-warningForeground)'))
            .join('');
        const where = result.source === 'docker'
            ? `ready via the Docker image ${escapeHtml(result.path || '')}`
            : `installed to ${escapeHtml(result.path || '')}`;
        return note(`${escapeHtml(result.version || '')} ${where}`.trim()) + warnings;
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
        // BFG without a JVM is not a tool, it is a file. Marked unavailable rather than
        // merely "not downloaded", which would suggest downloading it would help.
        const javaMissing = !this._dependencyStatus?.java?.installed;
        const bfgStatus = javaMissing ? '🚫' : (this._dependencyStatus?.bfg?.installed ? '✅' : '⚠️');

        return `
            <div class="section">
                <h3>🔧 Dependencies Setup</h3>

                ${this._getInstalledVersionHtml()}

                ${this._getEngineStatusHtml()}

                <div style="margin: 15px 0 10px 0; font-size: 11px; color: var(--vscode-descriptionForeground);">
                    <!-- Docker is not required to scan any more: Gitleaks and TruffleHog are
                         native binaries. It is needed only by the optional Nosey Parker
                         engine, whose upstream is archived. Labelling it "required" told
                         users to install a container runtime they may not need at all. -->
                    <strong>Optional — only for the Nosey Parker engine:</strong>
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
                <div style="font-size: 10px; color: var(--vscode-inputValidation-warningForeground); margin-left: 20px; margin-bottom: 5px;">
                    <!-- Stated wherever the engine is offered, not only in the docs: a
                         frozen ruleset stops finding new classes of secret over time,
                         and that is not visible from a scan that completes cleanly. -->
                    ⚠️ ${escapeHtml(scanEngineConfig.NOSEYPARKER_ARCHIVED_NOTICE)} Runs as a Docker image only; Gitleaks and TruffleHog are maintained and do not need Docker.
                </div>
                ${this._dependencyStatus?.noseyparker?.installed ? `
                    <div style="font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: 20px; margin-bottom: 5px;">
                        ${escapeHtml(scanEngineConfig.NOSEYPARKER_PINNED_VERSION)} (pinned image)
                    </div>
                ` : ''}
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
                
                <div class="status-item" ${javaMissing ? 'style="opacity: 0.55;"' : ''}>
                    <span><span class="status-icon">${bfgStatus}</span>BFG Tool</span>
                    ${showSpinner && this._dependencyStatus?.java?.installed && !this._dependencyStatus?.bfg?.installed ? '<div class="spinner"></div>' : ''}
                </div>
                ${javaMissing ? `
                    <!-- BFG is a JAR. Without a JVM the downloaded file cannot run, so
                         showing it as an available tool would offer an action that
                         cannot succeed. Disabled and explained, rather than offered. -->
                    <div style="font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: 20px; margin-bottom: 5px;">
                        Unavailable — BFG is a Java program and no Java runtime was found. Install Java to enable automated history rewriting; the manual git commands are shown either way.
                    </div>
                ` : (this._dependencyStatus?.bfg?.error ? `
                    <div style="font-size: 10px; color: var(--vscode-inputValidation-warningForeground); margin-left: 20px; margin-bottom: 5px;">
                        ${this._dependencyStatus.bfg.error} (manual commands available)
                    </div>
                ` : '')}
                
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
                        <!-- Naming what is missing, rather than repeating a fixed list.
                             "Docker and Nosey Parker are required for scanning" was
                             wrong in both directions: neither is required when Gitleaks
                             and TruffleHog are the enabled engines, and neither being
                             present makes a scan possible when those two are absent. -->
                        ⚠️ Not ready to scan — missing: ${escapeHtml((this._dependencyStatus?.missing || []).join(', ') || 'a scan engine')}
                    </div>
                ` : ''}

                <div style="font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 10px; line-height: 1.3;">
                    <strong>Prerequisites:</strong><br>
                    • Internet connection to download the engine binaries<br>
                    • Docker Engine running — only for the optional Nosey Parker engine<br>
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

    _getGitHistorySection() {
        const cfg = vscode.workspace.getConfiguration('leakLock');
        const enabled = cfg.get('gitHistoryKeywordSearch.enabled', false);
        const searchCommitMessages = cfg.get('gitHistoryKeywordSearch.searchCommitMessages', true);
        const searchFileHistory = cfg.get('gitHistoryKeywordSearch.searchFileHistory', true);
        const maxMatches = cfg.get('gitHistoryKeywordSearch.maxMatchesPerKeyword', 25);
        const keywords = cfg.get('gitHistoryKeywordSearch.keywords', []);

        const chevron = this._showGitHistorySection ? '▲' : '▼';
        const enabledClass = enabled ? 'on' : 'off';
        const commitClass = searchCommitMessages ? 'on' : 'off';
        const fileHistClass = searchFileHistory ? 'on' : 'off';

        const keywordItems = keywords.map(k =>
            `<div class="keyword-item">
                <span>${escapeHtml(k)}</span>
                <button class="keyword-remove" data-keyword="${escapeHtml(k)}"
                    aria-label="Remove keyword ${escapeHtml(k)}" title="Remove keyword ${escapeHtml(k)}">✕</button>
            </div>`
        ).join('');

        const expandedContent = this._showGitHistorySection ? `
            <div style="margin-top: 12px;">
                <div class="toggle-row">
                    <span>Search commit messages</span>
                    <button class="toggle-btn ${commitClass}"
                        onclick="toggleGitHistorySetting('searchCommitMessages', ${searchCommitMessages})"
                        title="${searchCommitMessages ? 'Enabled' : 'Disabled'}">
                    </button>
                </div>
                <div class="toggle-row">
                    <span>Search file history</span>
                    <button class="toggle-btn ${fileHistClass}"
                        onclick="toggleGitHistorySetting('searchFileHistory', ${searchFileHistory})"
                        title="${searchFileHistory ? 'Enabled' : 'Disabled'}">
                    </button>
                </div>
                <div class="toggle-row" style="margin-top: 8px;">
                    <span>Max matches per keyword</span>
                    <input class="number-input" type="number" min="1" max="500" value="${maxMatches}"
                        onchange="updateMaxMatches(this.value)"
                        onblur="updateMaxMatches(this.value)" />
                </div>

                <div style="margin-top: 10px; font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px;">
                    Keywords (${keywords.length})
                </div>
                <div class="keyword-list">
                    ${keywordItems || '<div style="font-size:11px;color:var(--vscode-descriptionForeground);padding:4px;">No keywords configured</div>'}
                </div>
                <div class="keyword-add-row">
                    <input id="keyword-input" class="keyword-input" type="text" placeholder="Add keyword…" />
                    <button class="keyword-add-btn" onclick="addKeyword()">Add</button>
                </div>
            </div>
        ` : '';

        return `
            <div class="section">
                <div class="section-toggle-header" onclick="toggleGitHistorySection()">
                    <h3>🔎 Git History Search</h3>
                    <span class="chevron">${chevron}</span>
                </div>
                <div class="toggle-row" style="margin-top: 10px;">
                    <span style="font-weight: 600;">Enable git history scanning</span>
                    <button class="toggle-btn ${enabledClass}"
                        onclick="toggleGitHistorySetting('enabled', ${enabled})"
                        title="${enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}">
                    </button>
                </div>
                ${!enabled ? `<div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-top:4px;">Scans commit messages and file history for configured keywords.</div>` : ''}
                ${expandedContent}
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

            <div class="section">
                <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px;">
                    Guides, screenshots and install instructions
                </div>
                <button class="scan-button" onclick="openWebsite()">
                    <span aria-hidden="true">🌐</span> Open the Leak Lock website
                </button>
            </div>
        `;
    }

    async _checkDependencies() {
        // execFile, not exec: no shell means no quoting rules to get wrong and no PATH
        // resolution differences between platforms, and the image name travels as one
        // argument however it is written.
        const execFileAsync = require('util').promisify(require('child_process').execFile);

        this._dependencyStatus = {
            docker: { installed: false, version: null, error: null },
            noseyparker: { installed: false, error: null },
            java: { installed: false, version: null, error: null },
            bfg: { installed: false, path: null, error: null }
        };

        // Check Docker
        try {
            const dockerVersion = await execFileAsync('docker', ['--version']);
            this._dependencyStatus.docker.installed = true;
            this._dependencyStatus.docker.version = dockerVersion.stdout.trim();

            // Check if Docker daemon is running
            try {
                await execFileAsync('docker', ['info']);
            } catch {
                this._dependencyStatus.docker.error = 'Docker daemon not running';
                this._dependencyStatus.docker.installed = false;
            }
        } catch {
            this._dependencyStatus.docker.error = 'Docker not installed or not in PATH';
        }

        // Check Nosey Parker image.
        //
        // `docker images <ref>` exits 0 whether or not the image exists — it prints a
        // header and no rows — so this check passed on any machine that had Docker at
        // all, and the panel showed a ✅ beside an image that was never pulled. That is
        // the same defect as the rest of this release, one layer down. `image inspect`
        // exits non-zero when the image is absent, which is the question being asked.
        //
        // Not asked at all when Docker itself is unavailable: `image inspect` would then
        // fail for Docker reasons, and reporting that as "image not pulled" sends the
        // user pulling an image on a machine where no pull can work.
        if (!this._dependencyStatus.docker.installed) {
            this._dependencyStatus.noseyparker.error = 'Cannot tell — Docker is unavailable, so the image cannot be checked or pulled';
        } else {
            try {
                await execFileAsync('docker', engineDocker.buildImageInspectArgs(scanEngineConfig.NOSEYPARKER_IMAGE));
                this._dependencyStatus.noseyparker.installed = true;
            } catch {
                this._dependencyStatus.noseyparker.error = 'Nosey Parker Docker image not pulled';
            }
        }

        // Check Java. Same banner reader the BFG step uses, so the two cannot disagree
        // about whether a JVM exists — and so neither stores a blank version because it
        // read the stream Java did not print to.
        try {
            this._dependencyStatus.java.version = await readJavaVersionBanner();
            this._dependencyStatus.java.installed = true;
        } catch {
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

        // The engines that actually scan decide whether setup is complete.
        //
        // This used to be `docker && noseyparker`, which reported "Dependencies ready"
        // on a machine with neither Gitleaks nor TruffleHog — the two engines a default
        // scan runs — and reported "not ready" on a machine that had both but no Docker.
        // Probing here costs two subprocesses and buys the guarantee this release is
        // about: setup never claims success while a default engine is absent.
        await this._refreshEngineStatus();
        this._dependencyStatus.missing = this._missingRequiredDependencies();
        this._dependenciesInstalled = this._dependencyStatus.missing.length === 0;

        this._updateView();
    }

    /**
     * What is enabled but not usable, named.
     *
     * Docker and the Nosey Parker image count only when Nosey Parker is enabled: it is
     * the sole component that needs them, its upstream is archived, and demanding a
     * container runtime from someone who scans with Gitleaks alone is the same category
     * of wrong answer as claiming a missing engine is fine.
     */
    _missingRequiredDependencies() {
        const missing = [];
        for (const engine of this._engineStatus || []) {
            if (engine.enabled && !engine.installed) {
                missing.push(engine.displayName);
            }
        }
        if (this._isNoseyParkerEnabled()) {
            if (!this._dependencyStatus?.docker?.installed) {
                missing.push('Docker Engine');
            }
            if (!this._dependencyStatus?.noseyparker?.installed) {
                missing.push('Nosey Parker image');
            }
        }
        return missing;
    }

    _isNoseyParkerEnabled() {
        try {
            const configured = vscode.workspace.getConfiguration('leakLock').get('scan.engines');
            const engines = Array.isArray(configured) && configured.length
                ? configured
                : ['gitleaks', 'trufflehog', 'noseyparker'];
            return engines.includes('noseyparker');
        } catch {
            return true;
        }
    }

    /**
     * Probe the native scan engines for presence and version.
     *
     * Gitleaks and TruffleHog are the engines that actually run by default; Docker and
     * the Nosey Parker image are optional and belong to an archived upstream. The panel
     * described only the optional pair, so a user whose Gitleaks binary was missing had
     * nowhere to see it — which is the same silence the coverage panel exists to break.
     *
     * The engines already know how to answer both questions, so this asks them rather
     * than reimplementing detection. Deliberately lazy: one subprocess per engine, run
     * only when the block is expanded.
     */
    async _refreshEngineStatus() {
        if (this._engineProbeInFlight) {
            return;
        }
        this._engineProbeInFlight = true;
        this._updateView();

        try {
            const config = vscode.workspace.getConfiguration('leakLock');
            const configured = config.get('scan.engines');
            const enabled = new Set(
                Array.isArray(configured) && configured.length
                    ? configured
                    : ['gitleaks', 'trufflehog', 'noseyparker']
            );

            this._engineStatus = await Promise.all(
                Object.values(scanEngines.ENGINES).map(async engine => {
                    // Honours leakLock.<engine>.binaryPath, so a binary outside PATH
                    // reports as present here exactly as it does during a scan.
                    const binary = config.get(`${engine.id}.binaryPath`) || undefined;
                    const preference = config.get(`${engine.id}.runtime`) || 'auto';
                    const image = config.get(`${engine.id}.image`) || undefined;
                    let execution = null;
                    let version = null;
                    try {
                        // The same resolution a scan performs, so the panel cannot
                        // promise a runtime the scan will not use.
                        execution = await scanEngines.resolveExecution(engine, { binary, runtime: preference, image });
                        if (execution) {
                            version = await engine.version({ binary, execution });
                        }
                    } catch {
                        execution = null;
                    }
                    return {
                        id: engine.id,
                        displayName: engine.displayName,
                        installHint: engine.installHint,
                        enabled: enabled.has(engine.id),
                        installed: execution !== null,
                        // Which of the two ways it will actually run, so a fallback to
                        // the container image is visible rather than merely working.
                        runtime: execution ? execution.mode : null,
                        preference,
                        image: engineDocker.engineImage(engine.id, image),
                        version
                    };
                })
            );
        } finally {
            this._engineProbeInFlight = false;
            this._updateView();
        }
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
                } catch {
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

    /**
     * Set up every dependency, per component.
     *
     * Previously this pulled the Nosey Parker image, downloaded BFG and announced
     * success — while Gitleaks and TruffleHog, the engines a default scan actually
     * runs, had no installation step whatsoever. That is issue #104: the message was
     * true about what it did and silent about what it never attempted.
     *
     * Docker now fails soft. It serves only the optional, archived Nosey Parker engine,
     * so its absence must not abort the installation of the two engines that scan.
     */
    async _installDependencies() {
        this._isInstalling = true;
        this._updateView();

        let dockerError = null;
        const engineResults = [];

        // Only when something needs it. Nosey Parker is the sole component that does,
        // and pulling a several-hundred-megabyte image — or reporting a Docker error —
        // for an engine the user switched off is exactly the kind of unrelated failure
        // this release exists to stop. The same condition already governs whether Docker
        // counts as a missing dependency.
        if (this._isNoseyParkerEnabled()) {
            try {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Installing dependencies...",
                    cancellable: false
                }, async (progress) => {
                    progress.report({ increment: 20, message: "Checking Docker..." });

                    // execFile with an argument list, like every other subprocess in
                    // this flow: no shell, so no quoting or PATH-resolution differences.
                    const execFileAsync = require('util').promisify(require('child_process').execFile);

                    try {
                        await execFileAsync('docker', ['--version']);
                    } catch {
                        throw new Error('Docker is not installed or not accessible. Please install Docker first.');
                    }

                    progress.report({ increment: 30, message: "Pulling Nosey Parker image..." });

                    // Pull the Nosey Parker Docker image
                    await execFileAsync(
                        'docker',
                        engineDocker.buildImagePullArgs(scanEngineConfig.NOSEYPARKER_IMAGE),
                        { timeout: 300000 }
                    );

                    progress.report({ increment: 20, message: "Docker components ready." });
                });
            } catch (error) {
                // Docker's absence is no longer fatal to setup: it belongs to the
                // optional Nosey Parker engine only. Record it and carry on to the
                // native engines, which is the whole point of installing them per tool.
                dockerError = error.message;
            }
        }

        // Everything after the Docker step runs under a finally that clears the
        // installing flag. Without it, an unexpected throw anywhere below leaves the
        // panel permanently mid-install — spinner up, every button disabled — and only
        // a window reload recovers it. The failure is unlikely; the state it leaves is
        // unrecoverable, which is the combination worth guarding.
        try {
            // BFG depends on Java and on nothing else. Downloading it inside the Docker
            // block meant a missing Docker skipped it, which is the same "one component
            // failing cancels an unrelated one" defect this release exists to remove.
            await this._installBfg();

            // The native engines, each on its own. Reported per engine below rather than
            // rolled into one verdict — a run where Gitleaks installs and TruffleHog
            // does not is a partial success, and calling it either "installed" or
            // "failed" is a lie in one direction or the other.
            for (const engineId of engineInstall.INSTALLABLE_ENGINE_IDS) {
                const already = (this._engineStatus || []).find(e => e.id === engineId);
                if (already?.installed) {
                    continue;
                }
                engineResults.push(await this._installEngine(engineId, { silent: true }));
            }
        } finally {
            this._isInstalling = false;
        }

        await this._checkDependencies();
        this._reportSetupOutcome(dockerError, engineResults);
        this._updateView();
    }

    /**
     * Is there a JVM, asked rather than assumed?
     *
     * `_checkDependencies()` runs unawaited when the view resolves, so a user who presses
     * Install Dependencies immediately can arrive here while the Java probe is still in
     * flight and the cached answer is still its `false` default. Trusting that would skip
     * BFG on a machine that has Java — a wrong answer produced by a race, which is the
     * hardest kind to report as a bug. The cached true is honoured; only the negative is
     * re-checked, and the result is written back so the panel agrees.
     */
    async _hasJavaRuntime() {
        if (this._dependencyStatus?.java?.installed) {
            return true;
        }
        try {
            const banner = await readJavaVersionBanner();
            if (this._dependencyStatus?.java) {
                this._dependencyStatus.java.installed = true;
                this._dependencyStatus.java.version = banner;
                this._dependencyStatus.java.error = null;
            }
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Download BFG, if a JVM exists to run it.
     *
     * Independent of Docker and of the scan engines: it rewrites history, it does not
     * detect anything. Its only prerequisite is Java — without a JVM the download is a
     * file that cannot run, so fetching it would put a tick beside a tool that fails the
     * moment it is used.
     *
     * @returns {Promise<{ok: boolean, skipped: boolean, error: ?string}>}
     */
    async _installBfg() {
        if (!await this._hasJavaRuntime()) {
            return { ok: false, skipped: true, error: 'No Java runtime; BFG cannot run.' };
        }
        const bfgPath = path.join(this._extensionUri.fsPath, 'bfg.jar');
        // Already there: re-downloading on every setup run costs a fetch to overwrite a
        // known-good copy with an identical one, and turns a working offline setup into
        // a failing one. A zero-length file is a previous download that died mid-flight,
        // so that is retried rather than trusted.
        try {
            if (fs.statSync(bfgPath).size > 0) {
                return { ok: true, skipped: false, error: null, alreadyPresent: true };
            }
        } catch {
            // Not present; fall through and fetch it.
        }

        try {
            const bfgUrl = 'https://repo1.maven.org/maven2/com/madgag/bfg/1.14.0/bfg-1.14.0.jar';
            // fetch, not a shelled-out curl: the destination is an installation path
            // that can contain spaces or quotes, and interpolating it into a command
            // line makes the download depend both on a shell and on a tool that is not
            // guaranteed to exist. Same downloader the engine installs use.
            await engineInstall.downloadFile(bfgUrl, bfgPath);
            return { ok: true, skipped: false, error: null };
        } catch (error) {
            console.warn('Failed to download BFG tool:', error.message);
            // Optional: the manual git commands do the same work without it.
            return { ok: false, skipped: false, error: error.message };
        }
    }

    /**
     * One notification that states what happened, component by component.
     *
     * The old flow showed "Dependencies installed successfully!" whenever the Docker
     * steps completed, which is what let a setup with no scanning engine at all read as
     * done. Anything still missing is named here, and named again in the panel.
     */
    _reportSetupOutcome(dockerError, engineResults) {
        const installed = engineResults.filter(r => r?.ok).map(r => r.displayName);
        const failed = engineResults.filter(r => r && !r.ok).map(r => r.displayName);
        const missing = this._dependencyStatus?.missing || [];

        const parts = [];
        if (installed.length) {
            parts.push(`Installed ${installed.join(' and ')}.`);
        }
        if (failed.length) {
            parts.push(`Could not install ${failed.join(' and ')}.`);
        }
        if (dockerError) {
            // "Skipped" would be wrong: dockerError is only set when the Docker work was
            // attempted and failed. The step that is genuinely skipped — Nosey Parker
            // not being enabled — never sets it, and says nothing at all.
            parts.push(`The Docker step for Nosey Parker failed: ${dockerError}`);
        }

        if (!missing.length) {
            vscode.window.showInformationMessage(
                parts.length ? `Dependencies ready. ${parts.join(' ')}` : 'Dependencies ready.'
            );
            return;
        }
        vscode.window.showWarningMessage(
            `Dependency setup incomplete — still missing: ${missing.join(', ')}. ${parts.join(' ')}`.trim()
        );
    }

    /**
     * Pull the engine's container image.
     *
     * Same result shape as a binary install, so the panel renders one outcome per engine
     * regardless of how it was obtained — and a Docker failure reads as a Docker failure
     * rather than as `docker: command not found`.
     */
    async _pullEngineImage(engineId, progress) {
        const displayName = engineInstall.ENGINE_RELEASES[engineId].displayName;
        const config = vscode.workspace.getConfiguration('leakLock');
        const image = engineDocker.engineImage(engineId, config.get(`${engineId}.image`) || undefined);
        const result = {
            engineId, displayName, ok: false, version: null, path: null,
            source: 'docker', checksumVerified: false, warnings: [], error: null
        };

        try {
            progress?.report({ message: `Pulling ${image}…` });
            const { execFile } = require('child_process');
            const execFileAsync = require('util').promisify(execFile);
            await execFileAsync('docker', engineDocker.buildImagePullArgs(image), { timeout: 600000 });

            // Verified the same way a binary install is: by running it. A pulled image
            // that cannot execute here is not an installed engine.
            //
            // The execution is handed over concretely rather than as a preference: the
            // image was just pulled, so re-resolving would repeat an `image inspect` and
            // a probe run to rediscover what this line already knows.
            const engine = scanEngines.getEngine(engineId);
            const version = await engine.version({ execution: { mode: 'docker', command: 'docker', image } });
            if (!version) {
                throw new Error(`${image} was pulled but did not report a version when run`);
            }
            result.ok = true;
            result.version = version;
            result.path = image;
        } catch (error) {
            result.error = `Could not set up ${displayName} from Docker: ${engineDocker.describeDockerFailure(error.message)}`;
        }
        return result;
    }

    /**
     * Install one native engine.
     *
     * Never throws and never touches another engine's state: this is the "a failure for
     * one engine must not prevent another from scanning" rule, expressed as the shape of
     * the function rather than as a promise in a comment.
     *
     * @returns {Promise<object|null>} the install result, or null if not installable
     */
    async _installEngine(engineId, { method = 'auto', silent = false } = {}) {
        if (!engineInstall.INSTALLABLE_ENGINE_IDS.includes(engineId)) {
            return null;
        }
        if (this._engineInstallInFlight.has(engineId)) {
            return null;
        }
        this._engineInstallInFlight.add(engineId);
        this._updateView();

        const displayName = engineInstall.ENGINE_RELEASES[engineId].displayName;
        let result;
        try {
            result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Installing ${displayName}…`,
                cancellable: false
            }, async (progress) => {
                if (method === 'docker') {
                    return this._pullEngineImage(engineId, progress);
                }

                const binaryResult = await engineInstall.installEngine({
                    engineId,
                    installDir: this._engineInstallDir,
                    // Ask the engine adapter for the version, so what setup reports is
                    // produced by the same code path a scan uses to decide it exists.
                    verifyVersion: async (id, exePath) => {
                        const engine = scanEngines.getEngine(id);
                        return engine ? engine.version({ binary: exePath }) : null;
                    }
                });
                if (binaryResult.ok || method === 'binary') {
                    return binaryResult;
                }

                // The default: binary first, container image as the fallback. A machine
                // that refuses to run a downloaded executable, or has no published build
                // for its architecture, can still scan — and a working scanner is worth
                // more than a precise account of why there is none.
                progress.report({ message: 'Binary install failed; trying the Docker image…' });
                const dockerResult = await this._pullEngineImage(engineId, progress);
                if (dockerResult.ok) {
                    dockerResult.warnings = [
                        `The binary install failed (${binaryResult.error}); ${displayName} will run from its Docker image.`,
                        ...(dockerResult.warnings || [])
                    ];
                    return dockerResult;
                }
                // Report the binary failure, not the Docker one: the binary is what was
                // asked for, and its error is the actionable half.
                return {
                    ...binaryResult,
                    warnings: [...(binaryResult.warnings || []), `Docker fallback also failed: ${dockerResult.error}`]
                };
            });
        } catch (error) {
            // installEngine is written not to throw; if it ever does, the engine is
            // still reported as failed rather than the whole setup collapsing.
            result = {
                engineId,
                displayName,
                ok: false,
                warnings: [],
                error: error.message
            };
        } finally {
            this._engineInstallInFlight.delete(engineId);
        }

        this._engineInstallResults[engineId] = result;
        // A newly installed binary must be findable immediately, not next session.
        scanEngines.resetBinaryCache();

        if (!silent) {
            if (result.ok) {
                vscode.window.showInformationMessage(
                    `${displayName} ${result.version || ''} installed.`.replace('  ', ' ')
                );
            } else {
                vscode.window.showErrorMessage(
                    `${result.error} ${engineInstall.manualInstallGuidance(engineId)}`
                );
            }
            await this._checkDependencies();
        }
        this._updateView();
        return result;
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
            vscode.commands.executeCommand('leak-lock.updateRemoveFilesRepo', {
                directory: this._selectedDirectory
            });

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
            vscode.commands.executeCommand('leak-lock.updateRemoveFilesRepo', {
                directory: this._selectedDirectory
            });
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
