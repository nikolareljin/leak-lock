// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

const dockerImage = 'ghcr.io/praetorian-inc/noseyparker:latest';

// Panel initialization delays (in milliseconds)
// These timeouts ensure the webview panel is fully initialized before calling methods on it
const PANEL_INIT_DELAY_MS = 50; // Delay for showRemoveFilesUI initialization
const PANEL_SCAN_INIT_DELAY_MS = 100; // Delay for startScanFromSidebar initialization

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
				// await execAsync('docker info');
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

	// Suppress known noisy runtime warnings from dependencies/host.
	process.on('warning', (warning) => {
		if (warning.code === 'DEP0040') {
			return;
		}
		if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message || '')) {
			return;
		}
		console.warn(warning.stack || warning.message || warning);
	});
	
	// Install dependencies on first activation
	installDependencies();

	// Import the LeakLockPanel
	const LeakLockPanel = require('./leakLockPanel');

	// Import and register the sidebar provider
	const { LeakLockSidebarProvider } = require('./leakLockSidebarProvider');
	const sidebarProvider = new LeakLockSidebarProvider(context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('leak-lock.sidebarView', sidebarProvider)
	);

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

	// Register scan repository command - now opens main area panel
	const scanRepositoryCommand = vscode.commands.registerCommand('leak-lock.scanRepository', function () {
		// Open the leak detection panel in main area
		LeakLockPanel.createOrShow(context.extensionUri);
		vscode.window.showInformationMessage('Leak Lock scanner opened in main area.');
	});

	// Register fix secrets command
	const fixSecretsCommand = vscode.commands.registerCommand('leak-lock.fixSecrets', function () {
		LeakLockPanel.createOrShow(context.extensionUri);
		vscode.window.showInformationMessage('Fix secrets functionality available in the Leak Lock panel.');
	});

	// Register open panel command
	const openPanelCommand = vscode.commands.registerCommand('leak-lock.openPanel', function () {
		LeakLockPanel.createOrShow(context.extensionUri);
	});

	// Update repo shown in Remove Files UI from sidebar selection
	const updateRemoveFilesRepoCommand = vscode.commands.registerCommand('leak-lock.updateRemoveFilesRepo', function (options) {
		if (LeakLockPanel.currentPanel && typeof LeakLockPanel.currentPanel.updateRemoveFilesRepoFromSidebar === 'function') {
			LeakLockPanel.currentPanel.updateRemoveFilesRepoFromSidebar(options?.directory);
		}
	});

	// Register command to open Remove Files flow
	const openRemoveFilesCommand = vscode.commands.registerCommand('leak-lock.openRemoveFiles', function (options) {
		LeakLockPanel.createOrShow(context.extensionUri);
		// Ensure panel is initialized before switching mode
		setTimeout(() => {
			if (LeakLockPanel.currentPanel && typeof LeakLockPanel.currentPanel.showRemoveFilesUI === 'function') {
				LeakLockPanel.currentPanel.showRemoveFilesUI(options?.directory);
			}
		}, PANEL_INIT_DELAY_MS);
	});

	// Register start scan command for sidebar integration
	const startScanCommand = vscode.commands.registerCommand('leak-lock.startScan', function (options) {
		// Open main panel and trigger scan with provided options
		LeakLockPanel.createOrShow(context.extensionUri);
		if (options) {
			// Use a slight delay to ensure panel is fully initialized
			setTimeout(() => {
				if (LeakLockPanel.currentPanel) {
					LeakLockPanel.currentPanel.startScanFromSidebar(options.directory, options.dependenciesReady);
				}
			}, PANEL_SCAN_INIT_DELAY_MS);
		}
	});

	// Register cleanup command for manual cleanup
	const cleanupCommand = vscode.commands.registerCommand('leak-lock.cleanup', async function () {
		const result = await vscode.window.showWarningMessage(
			'This will remove all Leak Lock dependencies including Docker images and tools. Continue?',
			{ modal: true },
			'Yes, Clean Up'
		);
		
		if (result === 'Yes, Clean Up') {
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "Cleaning up Leak Lock dependencies...",
				cancellable: false
			}, async () => {
				await cleanupDependencies();
			});
			vscode.window.showInformationMessage('Leak Lock cleanup completed!');
		}
	});

	// Make a call of project-scan.js for backward compatibility
	const projectScan = require('./project-scan');
	projectScan.activate(context);

	// Add all commands to subscriptions
	context.subscriptions.push(
		disposable,
		scanRepositoryCommand,
		fixSecretsCommand,
		openPanelCommand,
		openRemoveFilesCommand,
		updateRemoveFilesRepoCommand,
		startScanCommand,
		cleanupCommand,
		icon
	);

	// Register the legacy scan files command
	const scanFiles = vscode.commands.registerCommand('leak-lock.scanFiles', function () {
		vscode.window.showInformationMessage('Use the new "Scan Repository" command from the Leak Lock sidebar instead.');
	});

	context.subscriptions.push(scanFiles);
}

// This method is called when your extension is deactivated
async function deactivate() {
	try {
		await cleanupDependencies();
	} catch (error) {
		console.error('Error during extension cleanup:', error);
	}
}

/**
 * Clean up all installed dependencies when extension is uninstalled
 */
async function cleanupDependencies() {
	const { exec } = require('child_process');
	const util = require('util');
	const execAsync = util.promisify(exec);
	const fs = require('fs');
	const path = require('path');
	
	console.log('Starting Leak Lock extension cleanup...');
	
	try {
		// 1. Remove Nosey Parker Docker image
		try {
			console.log('Removing Nosey Parker Docker image...');
			await execAsync('docker rmi ghcr.io/praetorian-inc/noseyparker:latest');
			console.log('✓ Nosey Parker Docker image removed');
		} catch (error) {
			console.log('Nosey Parker Docker image not found or already removed');
		}
		
		// 2. Remove BFG tool
		const bfgPath = path.join(__dirname, 'bfg.jar');
		if (fs.existsSync(bfgPath)) {
			try {
				fs.unlinkSync(bfgPath);
				console.log('✓ BFG tool removed');
			} catch (error) {
				console.log('Could not remove BFG tool:', error.message);
			}
		}
		
		// 3. Clean up temporary files and directories
		const tempPaths = [
			path.join(__dirname, 'temp'),
			path.join(__dirname, 'scan-results'),
			path.join(__dirname, 'replacements.txt'),
			path.join(__dirname, '.noseyparker')
		];
		
		for (const tempPath of tempPaths) {
			if (fs.existsSync(tempPath)) {
				try {
					if (fs.statSync(tempPath).isDirectory()) {
						fs.rmSync(tempPath, { recursive: true, force: true });
					} else {
						fs.unlinkSync(tempPath);
					}
					console.log(`✓ Cleaned up: ${tempPath}`);
				} catch (error) {
					console.log(`Could not clean up ${tempPath}:`, error.message);
				}
			}
		}
		
		// 4. Remove any Docker volumes created by the extension
		try {
			const { stdout } = await execAsync('docker volume ls -q --filter label=leak-lock');
			if (stdout.trim()) {
				const volumes = stdout.trim().split('\n');
				for (const volume of volumes) {
					try {
						await execAsync(`docker volume rm ${volume}`);
						console.log(`✓ Removed Docker volume: ${volume}`);
					} catch (error) {
						console.log(`Could not remove volume ${volume}:`, error.message);
					}
				}
			}
		} catch (error) {
			console.log('No Docker volumes to clean up or Docker not available');
		}
		
		console.log('✅ Leak Lock extension cleanup completed');
		
	} catch (error) {
		console.error('Error during cleanup:', error);
		// Don't throw error to avoid breaking extension deactivation
	}
}

module.exports = {
	activate,
	deactivate
}
