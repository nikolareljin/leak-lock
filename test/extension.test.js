const assert = require('assert');
const vscode = require('vscode');

// Every suite that drives commands or providers needs the extension running.
// Suites must not depend on an earlier suite having done it, or they break when
// run as a subset.
async function activateExtension() {
	const extension = vscode.extensions.getExtension('nikolareljin.leak-lock');
	// Fail here rather than letting a subset run collapse later with a
	// confusing "command not found".
	assert.ok(extension, 'the leak-lock extension must be installed to run these tests');
	if (!extension.isActive) {
		await extension.activate();
	}
}

suite('Leak Lock Extension Test Suite', () => {

	suiteSetup(activateExtension);

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

suite('Project website link', () => {
	const WEBSITE_URL = 'https://nikolareljin.github.io/leak-lock/';

	suiteSetup(activateExtension);

	test('registers a command that opens the project website', async () => {
		const commands = await vscode.commands.getCommands();
		assert.ok(
			commands.includes('leak-lock.openWebsite'),
			'openWebsite command should be registered'
		);
	});

	test('the website command is exposed in the Command Palette', () => {
		const pkg = require('../package.json');
		const entry = (pkg.contributes.commands || [])
			.find(c => c.command === 'leak-lock.openWebsite');
		assert.ok(entry, 'openWebsite should be declared in contributes.commands');
		assert.ok(entry.title && entry.title.trim().length > 0, 'it needs a palette title');
	});

	test('the site URL is defined once, in config', () => {
		// Every view links to the same place; a URL copied into each one drifts
		// and sends users to a dead link from whichever copy went stale.
		const config = require('../config');
		assert.strictEqual(config.WEBSITE_URL, WEBSITE_URL);
	});

	test('the Control Panel offers a way to reach the website', () => {
		const { LeakLockSidebarProvider } = require('../leakLockSidebarProvider');
		const provider = new LeakLockSidebarProvider(vscode.Uri.file(__dirname));
		const html = provider._getHtmlForWebview();

		// Assert on the control itself, not just the helper it calls: a bare
		// openWebsite() function would satisfy a looser check even after the
		// button was deleted from the markup.
		assert.ok(
			/<button[^>]*onclick="openWebsite\(\)"/.test(html),
			'the sidebar should render a button wired to openWebsite()'
		);
		assert.ok(
			html.includes('Open the Leak Lock website'),
			'that button needs a visible label'
		);
		assert.ok(
			html.includes("command: 'openWebsite'"),
			'the handler should post an openWebsite message to the extension'
		);
	});

	test('the command opens the published site in an external browser', async () => {
		const original = vscode.env.openExternal;
		let opened = null;
		try {
			Object.defineProperty(vscode.env, 'openExternal', {
				value: async (uri) => { opened = uri.toString(); return true; },
				configurable: true
			});
			await vscode.commands.executeCommand('leak-lock.openWebsite');
		} finally {
			Object.defineProperty(vscode.env, 'openExternal', {
				value: original,
				configurable: true
			});
		}

		assert.ok(opened, 'the command should hand the URL to the OS browser');
		assert.strictEqual(opened.replace(/\/$/, ''), WEBSITE_URL.replace(/\/$/, ''));
	});

	test('a browser that fails to open is reported, not left to reject', async () => {
		const originalOpen = vscode.env.openExternal;
		const originalShow = vscode.window.showErrorMessage;
		let shown = null;
		try {
			Object.defineProperty(vscode.env, 'openExternal', {
				value: async () => { throw new Error('no handler for https'); },
				configurable: true
			});
			Object.defineProperty(vscode.window, 'showErrorMessage', {
				value: (msg) => { shown = msg; return Promise.resolve(undefined); },
				configurable: true
			});
			// Must resolve: an unhandled rejection would leave the user with a
			// silently dead button.
			await vscode.commands.executeCommand('leak-lock.openWebsite');
		} finally {
			Object.defineProperty(vscode.env, 'openExternal', { value: originalOpen, configurable: true });
			Object.defineProperty(vscode.window, 'showErrorMessage', { value: originalShow, configurable: true });
		}

		// Resolving is not enough — swallowing the error silently would also
		// resolve. The user has to be told.
		assert.ok(shown, 'the failure should be surfaced to the user');
		assert.ok(shown.includes('no handler for https'), `message should carry the cause, got: ${shown}`);
	});

	test('a non-Error failure still produces a readable message', async () => {
		const originalOpen = vscode.env.openExternal;
		const originalShow = vscode.window.showErrorMessage;
		let shown = null;
		try {
			Object.defineProperty(vscode.env, 'openExternal', {
				// Not every rejection is an Error; reading .message off a
				// string yields undefined and a message that tells the user
				// nothing.
				value: async () => { throw 'protocol handler missing'; },
				configurable: true
			});
			Object.defineProperty(vscode.window, 'showErrorMessage', {
				value: (msg) => { shown = msg; return Promise.resolve(undefined); },
				configurable: true
			});
			await vscode.commands.executeCommand('leak-lock.openWebsite');
		} finally {
			Object.defineProperty(vscode.env, 'openExternal', { value: originalOpen, configurable: true });
			Object.defineProperty(vscode.window, 'showErrorMessage', { value: originalShow, configurable: true });
		}

		assert.ok(shown, 'the failure should be surfaced to the user');
		assert.ok(shown.includes('protocol handler missing'), `message should carry the cause, got: ${shown}`);
		assert.ok(!shown.includes('undefined'), `message should not read "undefined", got: ${shown}`);
	});
});

suite('Webview initialises with a single render', () => {
	const LeakLockPanel = require('../leakLockPanel');

	suiteSetup(activateExtension);

	teardown(() => {
		if (LeakLockPanel.currentPanel) {
			LeakLockPanel.currentPanel.dispose?.();
			LeakLockPanel.currentPanel = undefined;
		}
	});

	// Reassigning webview.html destroys the iframe document and builds a new
	// one. Doing that while VS Code's webview service worker is still
	// registering makes register() reject with
	// "InvalidStateError: The document is in an invalid state", surfaced as
	// "Error loading webview: Could not register service worker".
	// The panel must therefore open already in its target mode, rather than
	// rendering the default view and swapping it a few milliseconds later.
	test('Remove Files opens directly in removeFiles mode', async () => {
		await vscode.commands.executeCommand('leak-lock.openRemoveFiles');

		assert.ok(LeakLockPanel.currentPanel, 'a panel should exist');
		assert.strictEqual(
			LeakLockPanel.currentPanel._viewMode,
			'removeFiles',
			'the first render must already be the Remove Files view'
		);
	});

	test('a scan request applies its directory before the first render', async () => {
		// 'scan' is the default mode, so mode alone proves nothing here; the
		// directory handed over by the sidebar is what must already be in
		// place when the webview document is first built.
		const directory = __dirname;
		await vscode.commands.executeCommand('leak-lock.startScan', {
			directory,
			dependenciesReady: false
		});

		assert.ok(LeakLockPanel.currentPanel, 'a panel should exist');
		assert.strictEqual(
			LeakLockPanel.currentPanel._selectedDirectory,
			directory,
			'the directory must be applied before the panel renders'
		);
	});
});

suite('Ref-complete rewrite script', () => {
	const gitRewrite = require('../git-rewrite');

	function script(extra = {}) {
		return gitRewrite.buildRewriteScript({
			repoDir: '/tmp/repo',
			rewriteLines: ['git filter-branch --force -- --all'],
			verifyRegex: '(^|/)secret\\.txt$',
			...extra
		});
	}

	test('materialises a local branch for every remote branch', () => {
		const out = script();
		// Without this loop, remote-only branches keep the leaked history.
		assert.ok(out.includes("refs/remotes/origin"), 'should enumerate remote refs');
		assert.ok(out.includes('git branch --force --no-track'), 'should materialise remote branches');
		assert.ok(out.includes('git checkout --detach'), 'must detach before force-updating branches');
	});

	test('pushes branches and tags in one atomic transaction', () => {
		const out = script();
		const code = out.split('\n').filter(line => !line.trim().startsWith('#'));
		const pushes = code.filter(line => /git push/.test(line));
		// Exactly one push, covering both heads and tags atomically. Two pushes
		// (--all then --tags) could leave branches rewritten but tags stale if the
		// second is rejected.
		assert.strictEqual(pushes.length, 1, 'a single push command, not one per ref class');
		assert.ok(/git push --force --atomic/.test(pushes[0]), 'the push is atomic and forced');
		assert.ok(pushes[0].includes("'refs/heads/*:refs/heads/*'"), 'includes all branches');
		assert.ok(pushes[0].includes("'refs/tags/*:refs/tags/*'"), 'includes all tags');
		assert.ok(!/--force --(all|tags)\b/.test(pushes[0]), 'no non-atomic --all/--tags push remains');
	});

	test('blocks when local branches hold unpushed commits', () => {
		const out = script();
		assert.ok(out.includes('git rev-list --count'), 'compares local against remote');
		assert.ok(out.includes('Refusing to rewrite'), 'aborts instead of discarding commits');
		assert.ok(out.includes('exit 1'), 'non-zero exit on the blocked path');
	});

	test('restores the working branch on any exit, not only success', () => {
		const out = script();
		// A rejected push (protected branch) would abort under `set -e` before the
		// explicit restore; the trap guarantees the repo is never left detached.
		assert.ok(/trap '.*git checkout --quiet "\$current_branch".*' EXIT/.test(out),
			'installs an EXIT trap that restores the branch');
	});

	test('is emitted as a multi-line script, not a single line', () => {
		// The webview used to collapse the newlines; the raw script must contain
		// real line breaks so a copy of it is runnable.
		const out = script();
		assert.ok(out.split('\n').length > 20, 'script spans many lines');
		assert.ok(out.startsWith('#!/bin/bash\n'), 'shebang is on its own line');
	});

	test('iterates refs with read -r, not word-splitting for-loops', () => {
		const out = script();
		// Robust iteration over one ref per line (git forbids whitespace/globs in
		// ref names, but read -r is the correct idiom and the process substitution
		// keeps loop-mutated variables out of a subshell).
		assert.ok(out.includes('while IFS= read -r branch'), 'branch loops use read -r');
		assert.ok(out.includes('while IFS= read -r ref'), 'the verify loop uses read -r');
		assert.ok(!/for \w+ in \$\(/.test(out), 'no word-splitting for-in-$() loop remains');
		assert.ok(out.includes('done < <(git for-each-ref'), 'fed via process substitution');
	});

	test('verifies every remote ref after pushing', () => {
		const out = script();
		const verifyIndex = out.indexOf('git ls-tree -r --name-only');
		const pushIndex = out.indexOf('git push --force --atomic');
		assert.ok(verifyIndex > -1, 'emits a verification loop');
		assert.ok(verifyIndex > pushIndex, 'verification runs after the push');
		assert.ok(out.includes('STILL PRESENT'), 'reports refs that are still dirty');
	});

	test('verification surfaces git errors instead of treating them as clean', () => {
		const out = script({ verifyLiterals: ['sekret'] });
		// git grep exit 1 = clean; any other exit is a real failure that must be
		// reported, not swallowed by a bare `if git grep` under set -e.
		assert.ok(out.includes('grep_rc'), 'captures git grep exit code');
		assert.ok(out.includes('VERIFY FAILED (git grep exit'), 'reports grep failures');
		assert.ok(out.includes('ls_rc'), 'captures git ls-tree exit code');
		assert.ok(out.includes('VERIFY FAILED (git ls-tree exit'), 'reports ls-tree failures');
		assert.ok(!/if git grep .* 2>\/dev\/null; then/.test(out), 'no bare if-git-grep that hides errors');
	});

	test('the script exits non-zero when verification finds a problem', () => {
		const out = script({ verifyLiterals: ['sekret'] });
		// leftover=1 must produce a non-zero exit so automation/chaining sees it.
		assert.ok(/leftover" -eq 0 ]; then[\s\S]*else[\s\S]*exit 1/.test(out),
			'verification failure exits 1');
	});

	test('restores the remote that git filter-repo deletes', () => {
		const out = script({ restoreRemote: true, remoteUrl: 'git@github.com:acme/repo.git' });
		assert.ok(
			out.includes('git remote add') && out.includes('git@github.com:acme/repo.git'),
			're-adds the remote before pushing'
		);
		const addIndex = out.indexOf('git remote add');
		const pushIndex = out.indexOf('git push --force --atomic');
		assert.ok(addIndex < pushIndex, 'remote must be restored before the push');
	});

	test('shellQuote neutralises embedded quotes', () => {
		assert.strictEqual(gitRewrite.shellQuote("a'b"), `'a'\\''b'`);
		assert.strictEqual(gitRewrite.shellQuote('plain'), `'plain'`);
	});

	test('escapeRegex escapes regex metacharacters', () => {
		assert.strictEqual(gitRewrite.escapeRegex('a.b*c'), 'a\\.b\\*c');
	});

	test('AheadBranchesError names the branches that would lose commits', () => {
		const err = new gitRewrite.AheadBranchesError([{ branch: 'feature', count: 3 }]);
		assert.strictEqual(err.name, 'AheadBranchesError');
		assert.ok(err.message.includes('feature'));
		assert.deepStrictEqual(err.branches, [{ branch: 'feature', count: 3 }]);
	});
});

suite('Scan finding selection', () => {
	const LeakLockPanel = require('../leakLockPanel');

	function panelWith(results) {
		const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
		panel._scanResults = results;
		panel._resetScanSelection();
		return panel;
	}

	const FINDINGS = [
		{ fullSecret: 'aaa', severity: 'high' },                          // 0 eligible
		{ fullSecret: 'bbb', isDependency: true },                        // 1 dependency (never selectable)
		{ fullSecret: 'ccc', includeInCleanup: false },                   // 2 explicitly excluded
		{ fullSecret: 'ddd', ruleName: 'git_history_keyword', includeInCleanup: true }, // 3 keyword — now selectable
		{ fullSecret: 'eee' }                                             // 4 eligible
	];

	test('secrets and keyword-history hits are selectable by default; deps/excluded are not', () => {
		const panel = panelWith(FINDINGS);
		assert.deepStrictEqual(panel._eligibleFindingIndexes(), [0, 3, 4]);
		assert.deepStrictEqual([...panel._ensureScanSelection()], [0, 3, 4]);
	});

	test('git-history keyword hits are offered for cleanup', () => {
		const panel = panelWith(FINDINGS);
		// Keyword-history matches are now cleanable: selecting one redacts that
		// string from history via BFG --replace-text.
		assert.strictEqual(panel._isCleanupEligible(FINDINGS[3]), true);
		assert.ok(panel._ensureScanSelection().has(3), 'keyword hit is checked by default');
		const resolved = panel._resolveScanReplacements({});
		assert.strictEqual(resolved['ddd'], '*****', 'keyword string is included in the cleanup map');
	});

	test('dependency and explicitly-excluded findings stay non-selectable', () => {
		const panel = panelWith(FINDINGS);
		assert.strictEqual(panel._isCleanupEligible(FINDINGS[1]), false);
		assert.strictEqual(panel._isCleanupEligible(FINDINGS[2]), false);
		panel._setScanSelection(1, true);
		panel._setScanSelection(2, true);
		assert.ok(!panel._ensureScanSelection().has(1));
		assert.ok(!panel._ensureScanSelection().has(2));
	});

	test('deselecting a finding survives a re-render', () => {
		const panel = panelWith(FINDINGS);
		panel._setScanSelection(0, false);
		// _resolveScanReplacements reads persisted state, not the webview DOM,
		// so a prepare-triggered re-render cannot resurrect the finding.
		const resolved = panel._resolveScanReplacements({ 'idx:0': '*****', 'idx:4': '*****' });
		assert.deepStrictEqual(Object.keys(resolved).sort(), ['ddd', 'eee']);
	});

	test('clear all then select all round-trips', () => {
		const panel = panelWith(FINDINGS);
		panel._setAllScanSelection(false);
		assert.strictEqual(panel._ensureScanSelection().size, 0);
		assert.deepStrictEqual(panel._resolveScanReplacements({}), {});
		panel._setAllScanSelection(true);
		assert.deepStrictEqual([...panel._ensureScanSelection()], [0, 3, 4]);
	});

	test('a fresh replacement value from the prepare payload beats stale state', () => {
		const panel = panelWith(FINDINGS);
		// State holds an old value (as if the debounced post had not yet arrived)...
		panel._setScanReplacement(0, 'OLD');
		// ...but the prepare message carries the live DOM value for that row.
		const resolved = panel._resolveScanReplacements({ 'idx:0': 'FRESH' });
		assert.strictEqual(resolved['aaa'], 'FRESH', 'payload value wins over stale state');
		// And state is reconciled so a later re-render shows the fresh value.
		assert.strictEqual(panel._getReplacementValue(0), 'FRESH');
	});

	test('custom replacement values persist per finding', () => {
		const panel = panelWith(FINDINGS);
		panel._setScanReplacement(0, 'REDACTED');
		assert.strictEqual(panel._getReplacementValue(0), 'REDACTED');
		assert.strictEqual(panel._getReplacementValue(4), '*****');
		const resolved = panel._resolveScanReplacements({});
		assert.strictEqual(resolved['aaa'], 'REDACTED');
		assert.strictEqual(resolved['eee'], '*****');
	});

	test('a new scan drops selection from the previous result set', () => {
		const panel = panelWith(FINDINGS);
		panel._setAllScanSelection(false);
		panel._scanResults = [{ fullSecret: 'zzz' }];
		panel._resetScanSelection();
		assert.deepStrictEqual([...panel._ensureScanSelection()], [0]);
	});
});


suite("Git history keyword defaults", () => {
	const properties = require("../package.json").contributes.configuration.properties;

	test("keeps sensitive keyword scanning optional and includes common credential terms", () => {
		assert.strictEqual(properties["leakLock.gitHistoryKeywordSearch.enabled"].default, false);
		const keywords = properties["leakLock.gitHistoryKeywordSearch.keywords"].default;
		for (const keyword of ["ldap", "ldap_password", "bind_password", "token", "ssh_key", "private_key"]) {
			assert.ok(keywords.includes(keyword), "missing default history keyword: " + keyword);
		}
	});
});

suite("Scan result deduplication", () => {
	const LeakLockPanel = require("../leakLockPanel");

	test("preserves findings from different commits and rules", () => {
		const panel = new LeakLockPanel({ fsPath: "/tmp/ext" });
		const base = { file: "config.env", line: 1, fullSecret: "token" };
		const findings = panel._deduplicateScanResults([
			{ ...base, commitHash: "commit-a", ruleName: "git_history_keyword" },
			{ ...base, commitHash: "commit-a", ruleName: "git_history_keyword" },
			{ ...base, commitHash: "commit-b", ruleName: "git_history_keyword" },
			{ ...base, commitHash: "commit-a", ruleName: "another_rule" }
		]);
		assert.strictEqual(findings.length, 3);
	});
});

suite("Prepared cleanup scripts", () => {
	const LeakLockPanel = require("../leakLockPanel");
	const cp = require("child_process");
	const fs = require("fs");
	const os = require("os");
	const path = require("path");

	function panel() {
		return new LeakLockPanel({ fsPath: "/tmp/ext" });
	}

	test("manual scripts create and clean an owner-only temporary replacement file", () => {
		const script = panel()._buildScanGitReplaceCommand(
			"/repo with spaces",
			{ "secret-value": "redacted" },
			"git@example.com:repo.git"
		);
		assert.ok(script.includes('mktemp "${TMPDIR:-/tmp}/leak-lock-replacements.XXXXXX"'));
		assert.ok(script.includes("umask 077"));
		assert.ok(script.includes('chmod 600 "$replacement_file"'));
		assert.ok(script.includes("secret-value==>redacted"));
		assert.ok(/trap .*rm -f .*replacement_file.*git checkout.* EXIT/.test(script));
		assert.ok(script.includes('--replace-text "$replacement_file"'));

		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "leak-lock-script-test-"));
		const scriptPath = path.join(tempDir, "cleanup.sh");
		try {
			fs.writeFileSync(scriptPath, script, { mode: 0o700 });
			const bashCheck = cp.spawnSync("bash", ["-n", scriptPath]);
			if (bashCheck.error && bashCheck.error.code !== "ENOENT") {
				throw bashCheck.error;
			}
			if (!bashCheck.error) {
				assert.strictEqual(bashCheck.status, 0, bashCheck.stderr.toString());
			}
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("in-panel execution uses owner-only temp storage and always removes it", async () => {
		let tempDir;
		let tempFile;
		await assert.rejects(
			panel()._withSecureReplacementsFile({ secret: "redacted" }, async (file) => {
				tempFile = file;
				tempDir = path.dirname(file);
				if (process.platform !== "win32") {
					assert.strictEqual(fs.statSync(tempDir).mode & 0o777, 0o700);
					assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
				}
				assert.strictEqual(fs.readFileSync(file, "utf8"), "secret==>redacted");
				throw new Error("simulated cleanup failure");
			}),
			/simulated cleanup failure/
		);
		assert.strictEqual(fs.existsSync(tempFile), false);
		assert.strictEqual(fs.existsSync(tempDir), false);
	});
	test("both prepared modes show save and local-run instructions", () => {
		const p = panel();
		p._scanResults = [{ file: "config.env", line: 1, secret: "secret", fullSecret: "secret", severity: "high", description: "test" }];
		p._scanPath = "/repo";
		p._resetScanSelection();
		for (const mode of ["bfg", "git"]) {
			p._scanCleanup.preparedCommand = "#!/bin/bash\necho prepared";
			p._scanCleanup.preparedMode = mode;
			const html = p._getResultsHtml();
			assert.ok(html.includes("Save as .sh"));
			assert.ok(html.includes("chmod 700 leak-lock-cleanup.sh"));
			assert.ok(html.includes("owner-only OS temporary directory"));
			assert.ok(html.includes(`copyScanCommand(&quot;scan-prepared-command-${mode}&quot;)`));
		}
	});

});

suite("Scan result search", () => {
	const LeakLockPanel = require("../leakLockPanel");

	test("scan results expose a Ctrl/Cmd+F findings search", () => {
		const p = new LeakLockPanel({ fsPath: "/tmp/ext" });
		p._scanResults = [{ file: "ldap.env", line: 1, secret: "hidden", fullSecret: "hidden", severity: "high", description: "LDAP password" }];
		p._scanPath = "/repo";
		p._resetScanSelection();
		const resultsHtml = p._getResultsHtml();
		const webviewHtml = p._getHtmlForWebview();
		assert.ok(resultsHtml.includes('id="finding-search"'));
		assert.ok(resultsHtml.includes('id="scan-findings-body"'));
		assert.ok(resultsHtml.includes("Press Ctrl+F or Cmd+F"));
		assert.ok(webviewHtml.includes("event.ctrlKey || event.metaKey"));
		assert.ok(webviewHtml.includes("filterScanFindings"));
	});

});

suite('BFG target escaping', () => {
	const LeakLockPanel = require('../leakLockPanel');

	function panel() {
		return new LeakLockPanel({ fsPath: '/tmp/ext' });
	}

	// A name with regex metacharacters must not widen what BFG deletes. Both
	// combined and individual modes have to escape it the same way.
	const TARGETS = [{ path: '/repo/[old].env', type: 'file', base: '[old].env' }];

	test('combined mode escapes regex metacharacters', () => {
		const args = panel()._buildBfgArgs(TARGETS);
		assert.deepStrictEqual(args, ['--delete-files', '\\[old\\]\\.env']);
	});

	test('individual-mode script escapes each target the same way', () => {
		const script = panel()._buildIndividualBfgCommands('/repo', TARGETS);
		assert.ok(script.includes('--delete-files'), 'emits the delete flag');
		assert.ok(script.includes('\\[old\\]\\.env'), 'escapes the metacharacters');
		assert.ok(!/--delete-files '\[old\]\.env'/.test(script), 'raw unescaped name must not appear');
	});

	// BFG verifies by name (it deletes by name); Git path-based removal verifies
	// the exact repo-relative path, so a same-named file elsewhere is not a false
	// "STILL PRESENT" failure.
	const PATH_TARGETS = [{ path: 'configs/secret.txt', type: 'file', base: 'secret.txt' }];

	test('basename verification matches the name anywhere (BFG mode)', () => {
		const re = new RegExp(panel()._buildTargetVerifyRegex(PATH_TARGETS));
		assert.ok(re.test('configs/secret.txt'), 'matches the target');
		assert.ok(re.test('docs/secret.txt'), 'BFG deletes by name, so same name elsewhere matches');
	});

	test('exact verification matches only the target path (Git mode)', () => {
		const re = new RegExp(panel()._buildTargetVerifyRegex(PATH_TARGETS, { exact: true }));
		assert.ok(re.test('configs/secret.txt'), 'matches the exact target path');
		assert.strictEqual(re.test('docs/secret.txt'), false, 'a same-named file elsewhere is NOT a false match');
	});

	test('exact verification treats a directory target as a path prefix', () => {
		const re = new RegExp(panel()._buildTargetVerifyRegex(
			[{ path: 'configs/old', type: 'directory', base: 'old' }], { exact: true }));
		assert.ok(re.test('configs/old/keys.pem'), 'matches files under the directory');
		assert.strictEqual(re.test('other/old/keys.pem'), false, 'does not match a same-named dir elsewhere');
	});
});

suite('Git history keyword search (file content)', () => {
	const LeakLockPanel = require('../leakLockPanel');
	const cp = require('child_process');
	const fs = require('fs');
	const os = require('os');
	const path = require('path');

	let repo;

	function git(args) {
		cp.execFileSync('git', ['-C', repo, ...args], {
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
				GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.com',
				GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.com'
			}
		});
	}

	suiteSetup(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), 'leaklock-hist-'));
		cp.execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
		// The keyword SECRET123 is embedded inside a larger token — no word boundary.
		fs.writeFileSync(path.join(repo, 'config.ini'), 'url = https://api.example.com/xyzSECRET123def/callback\n');
		git(['add', '-A']); git(['commit', '-qm', 'add config']);
		fs.writeFileSync(path.join(repo, 'config.ini'), 'url = https://api.example.com/redacted/callback\n');
		git(['add', '-A']); git(['commit', '-qm', 'redact']);
		// A file whose NAME carries a keyword, for the filename-search path.
		fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
		fs.writeFileSync(path.join(repo, 'src', 'gammafile_marker.js'), 'noop\n');
		git(['add', '-A']); git(['commit', '-qm', 'add gamma file']);
	});

	suiteTeardown(() => {
		try { fs.rmSync(repo, { recursive: true, force: true }); } catch (e) { void e; }
	});

	function panelFor(keyword, mode) {
		const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
		panel._scanRepoRoot = repo;
		panel._updateWebviewContent = () => {};
		panel._getKeywordSearchConfig = () => ({
			enabled: true,
			keywords: [keyword],
			maxMatchesPerKeyword: 25,
			shortKeywordFileHistoryMaxCount: 300,
			searchCommitMessages: false,
			searchFileHistory: mode !== 'names',
			searchFileNames: mode === 'names'
		});
		return panel;
	}

	// Regression: `git log -G` combined with `--pickaxe-regex` is rejected by git,
	// which made the whole file-content search fail silently and find nothing.
	test('finds a keyword embedded inside a token in historical file content', async () => {
		const findings = await panelFor('SECRET123')._scanGitHistoryForKeywords(repo);
		assert.ok(findings.some(f => f.secret === 'SECRET123'), 'embedded keyword should be found in file history');
	});

	test('finds a keyword that is a substring of a larger word', async () => {
		const findings = await panelFor('api')._scanGitHistoryForKeywords(repo);
		assert.ok(findings.some(f => f.secret === 'api'), 'substring keyword should be found in file history');
	});

	// Regression: `git log --name-status -z --pretty=format:...` prefixes the first
	// status record with a newline ("\nA"), which defeated the status-token check,
	// so filename search found nothing.
	test('finds a keyword in a historical file name', async () => {
		const findings = await panelFor('gammafile', 'names')._scanGitHistoryForKeywords(repo);
		assert.ok(
			findings.some(f => f.secret === 'gammafile' && /gammafile_marker\.js/.test(f.file)),
			'filename keyword should be found via name-status parsing'
		);
	});

	test('finds a keyword that is a substring of a historical file name', async () => {
		const findings = await panelFor('marker', 'names')._scanGitHistoryForKeywords(repo);
		assert.ok(findings.some(f => f.secret === 'marker'), 'substring filename keyword should be found');
	});
});

suite('Two-phase cleanup: local rewrite, then confirmed force-push', () => {
	const gitRewrite = require('../git-rewrite');
	const LeakLockPanel = require('../leakLockPanel');
	const cp = require('child_process');
	const fs = require('fs');
	const os = require('os');
	const path = require('path');

	const env = {
		...process.env,
		GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
		GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.com',
		GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.com',
		FILTER_BRANCH_SQUELCH_WARNING: '1'
	};
	let base, origin, work;

	suiteSetup(() => {
		base = fs.mkdtempSync(path.join(os.tmpdir(), 'leaklock-2phase-'));
		origin = path.join(base, 'origin.git');
		work = path.join(base, 'work');
		cp.execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin], { env });
		cp.execFileSync('git', ['clone', '-q', origin, work], { env });
		// A second file so removing secret.txt does not leave an empty commit
		// that --prune-empty would drop (which would delete the branch entirely).
		fs.writeFileSync(path.join(work, 'README.md'), '# app\n');
		fs.writeFileSync(path.join(work, 'secret.txt'), 'token=SUPERSECRETVALUE123\n');
		const g = (args) => cp.execFileSync('git', ['-C', work, ...args], { env });
		g(['add', '-A']); g(['commit', '-qm', 'add secret']); g(['push', '-q', 'origin', 'main']);
	});

	suiteTeardown(() => {
		try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { void e; }
	});

	function serverHasSecret() {
		return cp.execFileSync('git', ['--git-dir=' + origin, 'log', '--all', '-S', 'SUPERSECRETVALUE123', '--oneline'], { env })
			.toString().trim().length > 0;
	}

	test('push:false rewrites locally and leaves the remote untouched', async () => {
		const report = await gitRewrite.runRewrite({
			repoDir: work,
			push: false,
			rewrite: async () => {
				cp.execFileSync('git', ['filter-branch', '--force', '--index-filter',
					'git rm -r --cached --ignore-unmatch secret.txt', '--prune-empty',
					'--tag-name-filter', 'cat', '--', '--all'], { cwd: work, env, maxBuffer: 64 * 1024 * 1024 });
			}
		});
		assert.strictEqual(report.pushed, false, 'runRewrite must not push when push:false');
		assert.strictEqual(serverHasSecret(), true, 'the remote is still untouched after the local rewrite');
	});

	test('the confirmed push then cleans and verifies the remote', async () => {
		await gitRewrite.pushRewritten(work, 'origin');
		const offenders = await gitRewrite.verifyRemoteRefs(work, 'origin', { literals: ['SUPERSECRETVALUE123'] });
		assert.deepStrictEqual(offenders, [], 'verification is clean after the confirmed push');
		assert.strictEqual(serverHasSecret(), false, 'the secret is gone from the remote after confirmation');
	});

	test('staging sets a pending push; cancel clears it without pushing', () => {
		const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
		panel._updateWebviewContent = () => {};
		panel._stagePushForConfirmation('Git-only cleanup', '/repo', { materialized: ['main', 'dev'] }, { literals: ['x'] });
		assert.ok(panel._scanCleanup.pendingPush, 'pendingPush is set after the local rewrite');
		assert.strictEqual(panel._scanCleanup.pendingPush.refCount, 2);
		const gate = panel._renderPendingPush(panel._scanCleanup.pendingPush);
		assert.ok(/rewrite remote git history/.test(gate), 'the gate explains it changes git history');
		assert.ok(/force-push the rewritten history now/.test(gate), 'the gate asks for confirmation');
		panel._cancelForcePush();
		assert.strictEqual(panel._scanCleanup.pendingPush, null, 'cancel clears the pending push');
	});
});
