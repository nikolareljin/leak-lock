// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

const dockerImage = 'ghcr.io/praetorian-inc/noseyparker:latest';

/**
 * Check if dependencies are already installed
 */
async function checkDependencies() {
	const { exec } = require('child_process');
	const util = require('util');
	const execAsync = util.promisify(exec);
	const fs = require('fs');
	const path = require('path');
	
	const dependencies = {
		docker: false,
		noseyparker: false,
		bfg: false,
		java: false
	};
	
	try {
		// Check Docker
		await execAsync('docker --version');
		// await execAsync('docker info');
		dependencies.docker = true;
		
		// Check Nosey Parker image
		await execAsync('docker image inspect ghcr.io/praetorian-inc/noseyparker:latest');
		dependencies.noseyparker = true;
	} catch (error) {
		console.log('Docker or Nosey Parker not available');
	}
	
	try {
		// Check Java
		await execAsync('java -version');
		dependencies.java = true;
	} catch (error) {
		console.log('Java not available');
	}
	
	// Check BFG tool
	const bfgPath = path.join(__dirname, 'bfg.jar');
	if (fs.existsSync(bfgPath)) {
		dependencies.bfg = true;
	}
	
	return dependencies;
}

/**
 * Install the dependencies required for the extension.
 */
async function installDependencies(forceReinstall = false) {
	const { exec } = require('child_process');
	const util = require('util');
	const execAsync = util.promisify(exec);
	const path = require('path');
	
	try {
		// Check existing dependencies first
		if (!forceReinstall) {
			const deps = await checkDependencies();
			const missing = Object.entries(deps).filter(([key, value]) => !value).map(([key]) => key);
			
			if (missing.length === 0) {
				console.log('All dependencies already installed');
				return true;
			}
			
			console.log('Missing dependencies:', missing.join(', '));
		}
		
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Installing Leak Lock dependencies...",
			cancellable: false
		}, async (progress) => {
			
			progress.report({ increment: 10, message: "Checking system requirements..." });
			
			// Check Docker availability
			try {
				await execAsync('docker --version');
				await execAsync('docker info');
				progress.report({ increment: 20, message: "Docker is available ✓" });
			} catch (error) {
				throw new Error('Docker is not installed or not running. Please install Docker and start the daemon.');
			}
			
			// Check Java availability
			try {
				await execAsync('java -version');
				progress.report({ increment: 10, message: "Java is available ✓" });
			} catch (error) {
				vscode.window.showWarningMessage('Java is not installed. BFG tool may not work properly. Please install Java.');
			}
			
			progress.report({ increment: 20, message: "Downloading BFG tool..." });
			
			// Download BFG tool to extension directory
			const bfgPath = path.join(__dirname, 'bfg.jar');
			const bfgUrl = 'https://repo1.maven.org/maven2/com/madgag/bfg/1.14.0/bfg-1.14.0.jar';
			
			try {
				await execAsync(`curl -L -o "${bfgPath}" "${bfgUrl}"`);
				progress.report({ increment: 20, message: "BFG tool downloaded ✓" });
			} catch (error) {
				console.error('Failed to download BFG tool:', error);
				vscode.window.showWarningMessage('Failed to download BFG tool. You may need to download it manually.');
			}
			
			progress.report({ increment: 20, message: "Pulling Nosey Parker Docker image..." });
			
			// Pull Nosey Parker Docker image
			try {
				await execAsync('docker pull ghcr.io/praetorian-inc/noseyparker:latest');
				progress.report({ increment: 0, message: "Nosey Parker image ready ✓" });
			} catch (error) {
				console.error('Failed to pull Nosey Parker image:', error);
				throw new Error('Failed to pull Nosey Parker Docker image. Please check your internet connection.');
			}
		});
		
		vscode.window.showInformationMessage('✅ Leak Lock dependencies installed successfully!');
		return true;
		
	} catch (error) {
		console.error('Failed to install dependencies:', error);
		vscode.window.showErrorMessage(`❌ Failed to install dependencies: ${error.message}`);
		return false;
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
