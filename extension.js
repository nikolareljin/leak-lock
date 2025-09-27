// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

const dockerImage = 'ghcr.io/praetorian-inc/noseyparker:latest';

/**
 * Install the dependencies required for the extension.
 */
async function installDependencies() {
	const { exec } = require('child_process');
	const util = require('util');
	const execAsync = util.promisify(exec);
	
	try {
		vscode.window.showInformationMessage('Installing Leak Lock dependencies...');
		
		// Download BFG tool
		console.log('Downloading BFG tool...');
		await execAsync('curl -L -o bfg.jar https://repo1.maven.org/maven2/com/madgag/bfg/1.14.0/bfg-1.14.0.jar');
		console.log('BFG tool downloaded successfully');
		
		// Pull Nosey Parker Docker image
		console.log('Pulling Nosey Parker Docker image...');
		await execAsync('docker pull ghcr.io/praetorian-inc/noseyparker:latest');
		console.log('Nosey Parker Docker image pulled successfully');
		
		vscode.window.showInformationMessage('Leak Lock dependencies installed successfully!');
	} catch (error) {
		console.error('Failed to install dependencies:', error);
		vscode.window.showWarningMessage(`Failed to install some dependencies: ${error.message}. You can install them manually.`);
	}
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	console.log('Activating extension "leak-lock" ... ');
	
	// Install dependencies on first activation
	installDependencies();

	// Import the SidebarProvider
	const SidebarProvider = require('./sidebarProvider');

	// Register the SidebarProvider
	SidebarProvider.register(context);

	// Setup custom icon for the extension in the Status Bar
	const icon = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	icon.text = '$(shield)';
	icon.tooltip = 'Leak Lock - Click to scan repository';
	icon.command = 'leak-lock.scanRepository';
	icon.show();

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "leak-lock" is now active!');

	// Register commands
	const disposable = vscode.commands.registerCommand('leak-lock.helloWorld', function () {
		vscode.window.showInformationMessage('Hello World from leak-lock!');
	});

	// Register scan repository command
	const scanRepositoryCommand = vscode.commands.registerCommand('leak-lock.scanRepository', function () {
		// Show the sidebar view
		vscode.commands.executeCommand('workbench.view.extension.leak-lock');
		vscode.window.showInformationMessage('Repository scanning started. Check the Leak Lock sidebar for results.');
	});

	// Register fix secrets command
	const fixSecretsCommand = vscode.commands.registerCommand('leak-lock.fixSecrets', function () {
		vscode.window.showInformationMessage('Fix secrets functionality available in the Leak Lock sidebar.');
	});

	// Make a call of project-scan.js for backward compatibility
	const projectScan = require('./project-scan');
	projectScan.activate(context);

	// Add all commands to subscriptions
	context.subscriptions.push(
		disposable,
		scanRepositoryCommand,
		fixSecretsCommand,
		icon
	);

	// Register the legacy scan files command
	const scanFiles = vscode.commands.registerCommand('leak-lock.scanFiles', function () {
		vscode.window.showInformationMessage('Use the new "Scan Repository" command from the Leak Lock sidebar instead.');
	});

	context.subscriptions.push(scanFiles);
}

// This method is called when your extension is deactivated
function deactivate() { }

module.exports = {
	activate,
	deactivate
}
