// Run Praetorian on an entire Project.
// Show results in a right sidebar. In the sidebar, display: filename, line number, and description of the issue. 
// Display git hash of the commit that introduced the issue. Display the link that will take you to the line in the file where the issue was found.
// The sidebar should be updated every time the file is saved.
// If clicked, the link should open the file in the editor and scroll to the line where the issue was found. It should checkout specific commit in the git repository.
// Once the code gets changed in the editor, the sidebar should be updated.
// New commit should be prepared with the fix and the commit should be pushed to the repository after pressing the "Commit and Push" button.
// The sidebar should be closed when the project is closed.
// The sidebar should be closed when the extension is deactivated.
// The sidebar should be closed when the "Close Sidebar" button is clicked.
const vscode = require('vscode');

const dockerImage = 'ghcr.io/praetorian-inc/noseyparker:latest';

function scanProject() {
    const spawn = require('child_process').spawn;
    const docker = spawn('docker', ['run', '--rm', '-v', `${vscode.workspace.rootPath}:/scan`, dockerImage, 'project']);
    docker.stdout.on('data', (data) => {
        console.log(data.toString());
    });
    docker.stderr.on('data', (data) => {
        console.error(data.toString());
    });
    docker.on('close', (code) => {
        console.log(`child process exited with code ${code}`);
    });
}

// Display results in the right sidebar:
// - filename, line number, description of the issue, hash of the commit that introduced the issue, link to the line in the file where the issue was found
// - update the sidebar every time the file is saved
// - open the file in the editor and scroll to the line where the issue was found
// - checkout specific commit in the git repository
function showSidebar() {
    vscode.commands.executeCommand('setContext', 'leak-lock:sidebar', true);

    const panel = vscode.window.createWebviewPanel(
        'devToolsSidebar',
        'Dev Tools',
        vscode.ViewColumn.Two,
        {
            enableScripts: true
        }
    );

    const html = `
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
    panel.webview.html = html;

    panel.onDidDispose(() => {
        vscode.commands.executeCommand('setContext', 'leak-lock:sidebar', false);
    });

    panel.webview.onDidReceiveMessage((message) => {
        if (message.command === 'openFile') {
            const [filename, line] = message.data.split(':');
            const uri = vscode.Uri.file(filename);
            vscode.workspace.openTextDocument(uri).then((document) => {
                vscode.window.showTextDocument(document).then((editor) => {
                    editor.revealRange(new vscode.Range(+line - 1, 0, +line - 1, 0));
                });
            });
        }
    });

    return panel;
}

function deactivate() {
    vscode.commands.executeCommand('setContext', 'leak-lock:sidebar', false);
    vscode.commands.executeCommand('setContext', 'leak-lock:commit', false);
}

module.exports = {
    scanProject,
    deactivate
};