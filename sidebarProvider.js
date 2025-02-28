// Sidebar provider that uses the Webview API to display security issues in the sidebar.

const vscode = require('vscode');

// const {
//     WebviewView,
//     WebviewViewProvider,
// } = vscode;

// implements vscode.WebviewViewProvider
class SidebarProvider {
    constructor(extensionUri) {
        this._extensionUri = extensionUri;
    }

    resolveWebviewView(webviewView, context, _token) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
        };
        webviewView.webview.html = this._getHtmlForWebview();
    }

    _getHtmlForWebview() {
        return `
            <html>
                <body>
                    <h1>Security Issues</h1>
                    <ul>
                        <li>
                            <a href="#">filename:line</a>
                            <p>Description of the issue</p>
                            <p>Commit hash: <a href="#">hash</a></p>
                        </li>
                    </ul>
                </body>
            </html>
        `;
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
