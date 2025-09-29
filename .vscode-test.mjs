import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'test/**/*.test.js',
	version: '1.96.0',
	// Configure for CI environments
	mocha: {
		ui: 'tdd',
		timeout: 20000,
		color: true
	},
	// Add launch args for headless mode
	launchArgs: [
		'--disable-extensions',
		'--disable-gpu',
		'--no-sandbox',
		'--disable-dev-shm-usage',
		'--disable-web-security'
	]
});
