const assert = require('assert');
const vscode = require('vscode');

suite('Leak Lock Extension Test Suite', () => {

	suiteSetup(async () => {
		// Ensure extension is activated
		const extension = vscode.extensions.getExtension('nikolareljin.leak-lock');
		if (extension && !extension.isActive) {
			await extension.activate();
		}
	});

	test('Extension should be present', () => {
		const extension = vscode.extensions.getExtension('nikolareljin.leak-lock');
		assert.ok(extension, 'Extension should be installed');
	});

	test('Extension should activate', async () => {
		const extension = vscode.extensions.getExtension('nikolareljin.leak-lock');
		if (extension) {
			await extension.activate();
			assert.ok(extension.isActive, 'Extension should be active');
		}
	});

	test('Commands should be registered', async () => {
		const commands = await vscode.commands.getCommands();
		const leakLockCommands = commands.filter(cmd => cmd.startsWith('leak-lock.'));
		assert.ok(leakLockCommands.length > 0, 'Leak Lock commands should be registered');

		// Check for specific commands
		assert.ok(commands.includes('leak-lock.scanRepository'), 'scanRepository command should be registered');
		assert.ok(commands.includes('leak-lock.openPanel'), 'openPanel command should be registered');
	});

	test('Basic JavaScript functionality', () => {
		// Basic sanity tests
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
		assert.strictEqual(true, typeof vscode !== 'undefined');
	});
});
