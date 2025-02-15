// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

const dockerImage = 'ghcr.io/praetorian-inc/noseyparker:latest';

/**
 * Install the dependencies required for the extension.
 */
function installDependencies() {
	// command to download bfg tool from URL
	// curl -LJO https://repo1.maven.org/maven2/com/madgag/bfg/1.13.0/bfg-1.13.0.jar
	// Do this as JS command
	const { exec } = require('child_process');
	exec('curl -L -o bfg.jar https://search.maven.org/classic/remote_content?g=com.madgag&a=bfg&v=LATEST', (err, stdout, stderr) => {
		if (err) {
			console.error(err);
			return;
		}
		console.log(stdout);
	});

	// Prepare Praetorian Security Scanner (docker). Pull the image locally.
	// docker pull praetorianinc/security-scanner
	// Do this as JS command
	exec('docker pull ghcr.io/praetorian-inc/noseyparker:latest', (err, stdout, stderr) => {
		if (err) {
			console.error(err);
			return;
		}
		console.log(stdout);
	});
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	console.log('Activating extension "leak-lock" ... ');
	// Download locally bfg tool (jar file) and set symlink to "bfg" locally in the project
	// Add the following to the package.json:
	// "scripts": {
	// 	"bfg": "java -jar bfg.jar"
	// }

	// Import the SidebarProvider
	const SidebarProvider = require('./sidebarProvider');

	// Add SidebarProvider with custom icon.
	// const sidebarProvider = new SidebarProvider(context.extensionUri);

	// Register the SidebarProvider
	SidebarProvider.register(context);

	// Setup custom image for the extension in the Primary Sidebar
	const icon = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	icon.text = '$(shield)';
	icon.tooltip = 'Leak Lock';
	icon.command = 'leak-lock.projectScan';
	icon.show();

	
	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "leak-lock" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with  registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('leak-lock.helloWorld', function () {
		// The code you place here will be executed every time your command is executed

		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from leak-lock!');
	});

	// Make a call of security-scan.js
	// const fileScan = require('./file-scan');
	// fileScan.activate(context);

	const projectScan = require('./project-scan');
	projectScan.activate(context);

	context.subscriptions.push(disposable);

	// Register the command to scan the files: leak-lock.scanFiles
	// Register the command to scan the credentials: leak-lock.scanCredentials
	// Register the command to clean up the files: leak-lock.cleanUpFiles


	const scanFiles = vscode.commands.registerCommand('leak-lock.scanFiles', function () {
		// The code you place here will be executed
		// every time your command is executed
		vscode.window.showInformationMessage('Scanning files...');

		// // Call the file-scan.js
		// securityScan.scanFiles();

		// // Display a message box to the user
		// vscode.window.showInformationMessage('Files scanned!');
	});


	context.subscriptions.push(scanFiles);

}

// This method is called when your extension is deactivated
function deactivate() { }

module.exports = {
	activate,
	deactivate
}
