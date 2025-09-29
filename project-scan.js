// Legacy project scan functionality - now integrated into sidebarProvider.js
// This file maintains backward compatibility for existing command registrations
const vscode = require('vscode');

/**
 * Legacy project scan function - redirects to the new sidebar functionality
 */
function scanProject() {
    // Show the sidebar and trigger a scan
    vscode.commands.executeCommand('workbench.view.extension.leak-lock');
    vscode.window.showInformationMessage('Project scanning has been moved to the Leak Lock sidebar. Use the new interface for enhanced functionality.');
}

/**
 * Legacy activate method - now simplified for backward compatibility
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    // Register the legacy command to scan the project: leak-lock.projectScan
    let disposable = vscode.commands.registerCommand('leak-lock.projectScan', scanProject);
    context.subscriptions.push(disposable);
    
    console.log('Legacy project-scan.js activated (redirects to sidebar functionality)');
}

/**
 * Legacy showSidebar function - now redirects to the main sidebar
 * This maintains backward compatibility
 */
function showSidebar() {
    // Redirect to the new sidebar functionality
    vscode.commands.executeCommand('workbench.view.extension.leak-lock');
    return null; // Legacy return for compatibility
}

/**
 * Legacy deactivate method
 */
function deactivate() {
    console.log('Legacy project-scan.js deactivated');
}

module.exports = {
    scanProject,
    deactivate,
    activate
};