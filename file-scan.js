// Security scan in the currently edited file. 
// Scan using the TruffleHog Docker image and emit JSON results for the current file.
// In the currently edited file, show the results of the security scan as a decoration on the line number where the issue was found. The decoration should be a red squiggly underline.
// The decoration should be shown only when the file is saved.
// The decoration should be removed when the file is closed.
const vscode = require('vscode');

const dockerImage = 'trufflesecurity/trufflehog:latest';

/**
 * Perform Security Scan on the currently edited file.
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    let disposable = vscode.commands.registerCommand('leak-lock.fileScan', function () {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const document = editor.document;
        const filename = document.fileName;
        // Replace any spaces with underscores, forward slashes with underscores, dots with underscores, and colons with underscores.
        const key = filename.replace(/\s/g, '_').replace(/\//g, '_').replace(/\./g, '_').replace(/:/g, '_');
        const spawn = require('child_process').spawn;
        const date = new Date().toISOString().replace(/[:.]/g, '-');
        const args = ['run', '--rm', '-v', `${filename}:/scan/${key}`, dockerImage, 'filesystem', '/scan', '--json'];
        const docker = spawn('docker', args);
        docker.stdout.on('data', (data) => {
            console.log
            vscode.window.showInformationMessage(data.toString());
        }
        );
        docker.stderr.on('data', (data) => {
            console.error(data.toString());
        });
        docker.on('close', (code) => {
            console.log(`child process exited with code ${code}`);
        });
    }
    );
    context.subscriptions.push(disposable);

    const decorationType = vscode.window.createTextEditorDecorationType({
        textDecoration: 'underline wavy red'
    });

    vscode.workspace.onDidSaveTextDocument((document) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const filename = document.fileName;
        const key = filename.replace(/\s/g, '_');
        const data = context.globalState.get(key);
        if (data) {
            data.forEach((issue) => {
                const range = new vscode.Range(issue.line - 1, 0, issue.line - 1, 0);
                const decoration = { range, hoverMessage: issue.description };
                editor.setDecorations(decorationType, [decoration]);
            });
        }
    }
    );

    vscode.workspace.onDidCloseTextDocument((document) => {
        const filename = document.fileName;
        const key = filename.replace(/\s/g, '_');
        context.globalState.update(key, undefined);
    }
    );
}

module.exports = {
    activate
};
