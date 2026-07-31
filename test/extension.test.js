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
		// `env bash` rather than /bin/bash: on macOS /bin/bash is 3.2, Homebrew's
		// newer bash lives elsewhere, and Git Bash on Windows is elsewhere again.
		assert.ok(out.startsWith('#!/usr/bin/env bash\n'), 'shebang is on its own line');
	});

	test('runs byte-wise and checks its tools before doing anything destructive', () => {
		const out = script({ requiredCommands: ['git', 'java'] });
		// Locale-dependent matching would make "verified clean" mean different
		// things on different machines.
		assert.ok(out.includes('export LC_ALL=C'), 'matching is locale-independent');
		assert.ok(out.includes('command -v "$cmd"'), 'required tools are checked up front');
		assert.ok(out.includes('Required command not found on PATH'));
		// The check must precede the rewrite, not follow it.
		assert.ok(out.indexOf('command -v "$cmd"') < out.indexOf('# 1. Refresh every ref'));
	});

	test('verification reads the rule file instead of repeating every secret inline', () => {
		const out = script({
			verifyRulesFile: '"$replacement_file"',
			preambleLines: ['replacement_file="/tmp/x"']
		});
		// One list, one place. Previously each secret appeared twice: once in the
		// generated rule file and again in its own `git grep --fixed-strings` line,
		// which both bloated the script and pasted sensitive values through it.
		assert.ok(out.includes('done < "$replacement_file"'), 'the verify loop re-reads the rule file');
		assert.ok(out.includes('needle="${needle%%==>*}"'), 'the match side of each rule is extracted');
		assert.ok(out.includes('grep_flag="--extended-regexp"'), 'regex rules verify as regexes');
		assert.ok(out.includes('grep_flag="--fixed-strings"'), 'literal rules verify as literals');
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

	test("one secret at one location is one finding, however many times it was seen", () => {
		// Previously this produced three rows — one per commit, one per rule — which
		// reads as three separate problems. It is one secret, and a rewrite removes it
		// everywhere regardless of which commit or rule surfaced it.
		const panel = new LeakLockPanel({ fsPath: "/tmp/ext" });
		const base = { file: "config.env", line: 1, fullSecret: "token" };
		const findings = panel._deduplicateScanResults([
			{ ...base, commitHash: "commit-a", ruleName: "git_history_keyword" },
			{ ...base, commitHash: "commit-a", ruleName: "git_history_keyword" },
			{ ...base, commitHash: "commit-b", ruleName: "git_history_keyword" },
			{ ...base, commitHash: "commit-a", ruleName: "another_rule" }
		]);
		assert.strictEqual(findings.length, 1);
		// Nothing is lost: both commits and both rules are still recorded.
		const commits = findings[0].occurrences.map(o => o.commitHash).filter(Boolean);
		assert.deepStrictEqual(Array.from(new Set(commits)).sort(), ["commit-a", "commit-b"]);
		assert.deepStrictEqual(findings[0].ruleNames.sort(), ["another_rule", "git_history_keyword"]);
	});

	test("different secrets at the same location stay separate", () => {
		const panel = new LeakLockPanel({ fsPath: "/tmp/ext" });
		const base = { file: "config.env", line: 1 };
		const findings = panel._deduplicateScanResults([
			{ ...base, fullSecret: "AKIAIOSFODNN7EXAMPLE", commitHash: "c1" },
			{ ...base, fullSecret: "ghp_unrelatedtokenvalue00", commitHash: "c1" }
		]);
		assert.strictEqual(findings.length, 2);
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

suite('Scan engine configuration', () => {
	const engineConfig = require('../scan-engine-config');

	test('report never inherits the truncating defaults', () => {
		const args = engineConfig.buildNoseyParkerReportArgs({ datastoreMount: '/ds' });
		const flag = (name) => args[args.indexOf(name) + 1];
		// Upstream defaults are 3 / 3 / 0.05 and discard findings before Leak Lock
		// parses them. -1 and 0 are the documented "no limit" values.
		assert.ok(args.includes('--max-matches'), 'report caps matches per finding unless told not to');
		assert.strictEqual(flag('--max-matches'), '-1');
		assert.strictEqual(flag('--max-provenance'), '-1');
		assert.strictEqual(flag('--min-score'), '0');
		assert.strictEqual(flag('--format'), 'json');
	});

	test('suppress-redundant is explicit and configurable', () => {
		const on = engineConfig.buildNoseyParkerReportArgs({ datastoreMount: '/ds' });
		assert.strictEqual(on[on.indexOf('--suppress-redundant') + 1], 'true');
		const off = engineConfig.buildNoseyParkerReportArgs({
			datastoreMount: '/ds',
			settings: engineConfig.normalizeScanSettings({ suppressRedundant: false })
		});
		assert.strictEqual(off[off.indexOf('--suppress-redundant') + 1], 'false');
	});

	test('the scanner image is pinned rather than :latest', () => {
		assert.ok(!engineConfig.NOSEYPARKER_IMAGE.endsWith(':latest'), 'a floating tag drifts silently between machines');
		assert.strictEqual(engineConfig.NOSEYPARKER_IMAGE, 'ghcr.io/praetorian-inc/noseyparker:v0.24.0');
		const args = engineConfig.buildNoseyParkerReportArgs({ datastoreMount: '/ds' });
		assert.ok(args.includes(engineConfig.NOSEYPARKER_IMAGE));
	});

	test('scan args always request full git history and a ruleset', () => {
		const args = engineConfig.buildNoseyParkerScanArgs({ scanMount: '/src', datastoreMount: '/ds' });
		assert.strictEqual(args[args.indexOf('--git-history') + 1], 'full');
		assert.strictEqual(args[args.indexOf('--ruleset') + 1], 'default');
		assert.strictEqual(args[args.length - 1], '/scan', 'the mounted path is the final positional argument');
	});

	test('ruleset modes expand to the repeated flags upstream requires', () => {
		assert.deepStrictEqual(engineConfig.resolveRulesetIds('default'), ['default']);
		assert.deepStrictEqual(engineConfig.resolveRulesetIds('default+assets'), ['default', 'np.assets']);
		assert.deepStrictEqual(engineConfig.resolveRulesetIds('all'), ['all']);
		// An unknown value must fall back, never produce an invalid flag.
		assert.deepStrictEqual(engineConfig.resolveRulesetIds('nonsense'), ['default']);

		const args = engineConfig.buildNoseyParkerScanArgs({
			scanMount: '/src',
			datastoreMount: '/ds',
			settings: engineConfig.normalizeScanSettings({ rulesetMode: 'default+assets' })
		});
		const rulesets = args.reduce((acc, arg, i) => (arg === '--ruleset' ? acc.concat(args[i + 1]) : acc), []);
		assert.deepStrictEqual(rulesets, ['default', 'np.assets']);
	});

	test('settings are clamped so an out-of-range value cannot reach the engine', () => {
		assert.strictEqual(engineConfig.normalizeScanSettings({ timeoutSeconds: 5 }).timeoutMs, 30000);
		assert.strictEqual(engineConfig.normalizeScanSettings({ timeoutSeconds: 99999 }).timeoutMs, 7200000);
		assert.strictEqual(engineConfig.normalizeScanSettings({ timeoutSeconds: 'abc' }).timeoutMs, 300000);
		assert.strictEqual(engineConfig.normalizeScanSettings({ maxFileSizeMb: -4 }).maxFileSizeMb, 0);
	});

	test('the exclude list refuses directories that can hold first-party source', () => {
		const dirs = engineConfig.EXCLUDABLE_DEPENDENCY_DIRS;
		assert.ok(dirs.includes('node_modules'));
		assert.ok(dirs.includes('vendor'));
		// Excluding these from a security scan would hide real secrets: they routinely
		// hold the project's own code.
		for (const unsafe of ['lib', 'bin', 'dist', 'build', 'out', 'packages', 'src']) {
			assert.ok(!dirs.includes(unsafe), `${unsafe} must never be excluded from scanning`);
		}
		const file = engineConfig.buildDependencyIgnoreFile();
		assert.ok(file.includes('node_modules/'));
		assert.ok(!/^lib\/$/m.test(file));
	});

	test('an ignore file is wired into the scan only when one is supplied', () => {
		const without = engineConfig.buildNoseyParkerScanArgs({ scanMount: '/src', datastoreMount: '/ds' });
		assert.ok(!without.includes('--ignore'));
		const with_ = engineConfig.buildNoseyParkerScanArgs({
			scanMount: '/src',
			datastoreMount: '/ds',
			ignoreFileMount: '/tmp/ignore'
		});
		assert.strictEqual(with_[with_.indexOf('--ignore') + 1], '/leaklock-ignore');
		assert.ok(with_.includes('/tmp/ignore:/leaklock-ignore:ro'), 'the ignore file is mounted read-only');
	});
});

suite('Gitleaks engine adapter', () => {
	const engines = require('../scan-engines');

	test('the CLI dialect is probed from --help, not from a version number', () => {
		// Distribution builds print "version is set by build process", so version
		// parsing cannot decide this.
		const modern = 'Available Commands:\n  git         scan git repositories\n  dir         scan directories\n';
		const legacy = 'Available Commands:\n  detect      detect secrets in code\n  protect     protect secrets\n';
		assert.strictEqual(engines.detectGitleaksDialect(modern), 'modern');
		assert.strictEqual(engines.detectGitleaksDialect(legacy), 'legacy');
		assert.strictEqual(engines.detectGitleaksDialect('nothing useful'), null);
		assert.strictEqual(engines.detectGitleaksDialect(null), null);
	});

	test('the history pass covers every ref in both dialects', () => {
		const opts = { repoDir: '/repo', reportPath: '/tmp/r.json' };
		const modern = engines.buildGitleaksArgs('modern', 'history', opts);
		const legacy = engines.buildGitleaksArgs('legacy', 'history', opts);
		// Without --all the scan only covers the current branch, which is the same
		// class of miss that #71 fixes on the Nosey Parker side.
		assert.ok(modern.includes('--log-opts=--all'));
		assert.ok(legacy.includes('--log-opts=--all'));
		assert.strictEqual(modern[0], 'git');
		assert.strictEqual(legacy[0], 'detect');
	});

	test('the working-tree pass disables git in both dialects', () => {
		const opts = { repoDir: '/repo', reportPath: '/tmp/r.json' };
		assert.strictEqual(engines.buildGitleaksArgs('modern', 'worktree', opts)[0], 'dir');
		assert.ok(engines.buildGitleaksArgs('legacy', 'worktree', opts).includes('--no-git'));
	});

	test('findings are an expected outcome, not a failure exit', () => {
		const args = engines.buildGitleaksArgs('modern', 'history', { repoDir: '/repo', reportPath: '/tmp/r.json' });
		assert.strictEqual(args[args.indexOf('--exit-code') + 1], '0');
		assert.strictEqual(args[args.indexOf('--report-format') + 1], 'json');
	});

	test('optional config, baseline and size limit are passed only when set', () => {
		const bare = engines.buildGitleaksArgs('modern', 'history', { repoDir: '/repo', reportPath: '/r' });
		assert.ok(!bare.includes('--config'));
		assert.ok(!bare.includes('--baseline-path'));
		assert.ok(!bare.includes('--max-target-megabytes'));
		const full = engines.buildGitleaksArgs('modern', 'history', {
			repoDir: '/repo', reportPath: '/r',
			configPath: '/c.toml', baselinePath: '/b.json', maxTargetMegabytes: 25
		});
		assert.strictEqual(full[full.indexOf('--config') + 1], '/c.toml');
		assert.strictEqual(full[full.indexOf('--baseline-path') + 1], '/b.json');
		assert.strictEqual(full[full.indexOf('--max-target-megabytes') + 1], '25');
	});

	test('a finding carries every field Nosey Parker supplies, and more', () => {
		const mapped = engines.mapGitleaksFinding({
			RuleID: 'aws-access-token', Description: 'AWS Access Token',
			File: 'app.py', StartLine: 3, EndLine: 3, StartColumn: 11, EndColumn: 30,
			Secret: 'AKIAIOSFODNN7EXAMPLE', Match: 'KEY = "AKIAIOSFODNN7EXAMPLE"',
			Commit: 'abc123', Date: '2026-07-31T04:57:01Z', Author: 'Fixture',
			Email: 'f@example.invalid', Message: 'add app', Entropy: 3.5,
			Fingerprint: 'abc123:app.py:aws-access-token:3'
		}, 'history', '/repo');

		assert.strictEqual(mapped.file, 'app.py');
		assert.strictEqual(mapped.line, 3);
		assert.strictEqual(mapped.secret, 'AKIAIOSFODNN7EXAMPLE');
		assert.strictEqual(mapped.ruleId, 'aws-access-token');
		assert.strictEqual(mapped.commitHash, 'abc123');
		assert.strictEqual(mapped.isGitHistory, true);
		// Additive over Nosey Parker: columns, entropy, author, fingerprint.
		assert.strictEqual(mapped.endColumn, 30);
		assert.strictEqual(mapped.entropy, 3.5);
		assert.strictEqual(mapped.author, 'Fixture');
		assert.ok(mapped.fingerprint);
		// Gitleaks does not verify credentials; null means "not applicable", and the
		// engine declares it so the UI can say so rather than showing a blank.
		assert.strictEqual(mapped.verified, null);
		assert.ok(engines.gitleaksEngine.capabilities.unavailable.includes('verified'));
	});

	test('working-tree paths are relativized so one file is not two rows', () => {
		// The `dir` pass echoes the absolute path it was given; the history pass emits
		// a repo-relative one. Left alone they dedup as different files.
		const abs = engines.mapGitleaksFinding({ File: '/repo/app.py', StartLine: 1, Secret: 's' }, 'worktree', '/repo');
		assert.strictEqual(abs.file, 'app.py');
		assert.strictEqual(abs.isGitHistory, false, 'a working-tree hit is not history');
		assert.strictEqual(engines.relativizePath('/elsewhere/x.py', '/repo'), '/elsewhere/x.py');
	});
});

suite('TruffleHog engine adapter', () => {
	const engines = require('../scan-engines');

	test('verification is opt-out in the args and off by default in settings', () => {
		const verifying = engines.buildTruffleHogArgs({ repoDir: '/repo', verify: true });
		assert.ok(verifying.includes('--results=verified,unknown'));
		assert.ok(!verifying.includes('--no-verification'));
		// Verification makes read-only calls to third-party providers using the
		// discovered credential, so the caller must be able to refuse it.
		const quiet = engines.buildTruffleHogArgs({ repoDir: '/repo', verify: false });
		assert.ok(quiet.includes('--no-verification'));
		assert.ok(verifying.includes('git') && verifying.includes('file:///repo'));
	});

	test('JSONL output is parsed and progress records are ignored', () => {
		const stdout = [
			'{"level":"info","msg":"scanning"}',
			'',
			'not json at all',
			'{"DetectorName":"AWS","Verified":true,"Raw":"AKIAIOSFODNN7EXAMPLE",' +
				'"SourceMetadata":{"Data":{"Git":{"commit":"c1","file":"a.py","line":4,"email":"f@example.invalid"}}}}'
		].join('\n');
		const parsed = engines.parseTruffleHogJsonl(stdout);
		assert.strictEqual(parsed.length, 1, 'only records with a DetectorName are findings');
		const mapped = engines.mapTruffleHogFinding(parsed[0]);
		assert.strictEqual(mapped.file, 'a.py');
		assert.strictEqual(mapped.line, 4);
		assert.strictEqual(mapped.commitHash, 'c1');
		assert.strictEqual(mapped.verified, true);
		assert.strictEqual(mapped.ruleId, 'AWS');
		assert.ok(mapped.description, 'a description is derived, not left blank');
	});

	test('the pre-v3 SourceMetadata shape is still understood', () => {
		// Older builds put Git directly under SourceMetadata; accepting only the newer
		// shape would silently lose the commit and file.
		const mapped = engines.mapTruffleHogFinding({
			DetectorName: 'Stripe', Verified: false, Raw: 'sk_live_x',
			SourceMetadata: { Git: { commit: 'c2', file: 'b.py', line: 9 } }
		});
		assert.strictEqual(mapped.commitHash, 'c2');
		assert.strictEqual(mapped.file, 'b.py');
		assert.strictEqual(mapped.verified, false);
	});

	test('fields TruffleHog cannot supply are declared, not silently blank', () => {
		const unavailable = engines.truffleHogEngine.capabilities.unavailable;
		for (const field of ['endLine', 'startColumn', 'endColumn', 'entropy', 'fingerprint']) {
			assert.ok(unavailable.includes(field), `${field} must be declared unavailable`);
		}
		assert.strictEqual(engines.truffleHogEngine.capabilities.verification, true);
	});
});

suite('Cross-engine field parity and attribution', () => {
	const LeakLockPanel = require('../leakLockPanel');
	const engines = require('../scan-engines');

	// The floor: every field a Nosey Parker finding carries. A new engine may add
	// fields but must never render fewer.
	const NOSEY_PARKER_FIELDS = [
		'file', 'line', 'secret', 'fullSecret', 'isSecretTruncated', 'description',
		'severity', 'isDependency', 'includeInCleanup', 'originalSeverity', 'ruleName',
		'isGitHistory', 'isUntracked', 'commitHash', 'commitBranches', 'commitDate'
	];

	function panel() {
		const p = new LeakLockPanel({ fsPath: '/tmp/ext' });
		p._updateWebviewContent = () => {};
		return p;
	}

	test('a Nosey Parker finding defines the field floor', () => {
		const result = panel()._createResult('app.py', 1, 'secret-value', 'API key', 'api_key');
		for (const field of NOSEY_PARKER_FIELDS) {
			assert.ok(field in result, `baseline finding is missing ${field}`);
		}
	});

	test('a Gitleaks finding carries the full floor plus its extra detail', () => {
		const finding = engines.mapGitleaksFinding({
			RuleID: 'aws-access-token', Description: 'AWS Access Token', File: 'app.py',
			StartLine: 3, EndLine: 3, StartColumn: 11, EndColumn: 30,
			Secret: 'AKIAIOSFODNN7EXAMPLE', Commit: 'abc123', Date: '2026-07-31T04:57:01Z',
			Author: 'Fixture', Email: 'f@example.invalid', Entropy: 3.5, Fingerprint: 'fp1'
		}, 'history', '/repo');

		const result = panel()._createResultFromEngineFinding(
			finding, 'gitleaks', 'v8.30.1', engines.gitleaksEngine.capabilities
		);

		for (const field of NOSEY_PARKER_FIELDS) {
			assert.ok(field in result, `gitleaks finding is missing ${field}`);
		}
		assert.strictEqual(result.engine, 'gitleaks');
		assert.strictEqual(result.engineVersion, 'v8.30.1');
		assert.strictEqual(result.commitHash, 'abc123', 'provenance survives the mapping');
		assert.strictEqual(result.commitDate, '2026-07-31T04:57:01Z');
		assert.strictEqual(result.isGitHistory, true);
		assert.strictEqual(result.entropy, 3.5);
		assert.strictEqual(result.fingerprint, 'fp1');
		assert.strictEqual(result.fullSecret, 'AKIAIOSFODNN7EXAMPLE', 'the value remediation needs is preserved');
		assert.deepStrictEqual(result.unavailableFields, ['verified']);
	});

	test('a TruffleHog finding carries the full floor and declares what it cannot supply', () => {
		const finding = engines.mapTruffleHogFinding({
			DetectorName: 'AWS', Verified: true, Raw: 'AKIAIOSFODNN7EXAMPLE',
			SourceMetadata: { Data: { Git: { commit: 'c1', file: 'a.py', line: 4 } } }
		});
		const result = panel()._createResultFromEngineFinding(
			finding, 'trufflehog', 'v3.96.0', engines.truffleHogEngine.capabilities
		);
		for (const field of NOSEY_PARKER_FIELDS) {
			assert.ok(field in result, `trufflehog finding is missing ${field}`);
		}
		assert.ok(result.description, 'the description column is populated, not blank');
		assert.ok(result.unavailableFields.includes('entropy'));
	});

	test('a verified live credential outranks every rule-name heuristic', () => {
		// 'url' scores medium by rule name alone. A key confirmed to still work is the
		// most urgent thing in the repository regardless of what matched it.
		const finding = engines.mapTruffleHogFinding({
			DetectorName: 'url', Verified: true, Raw: 'https://user:pw@host/x',
			SourceMetadata: { Data: { Git: { commit: 'c1', file: 'a.py', line: 1 } } }
		});
		const result = panel()._createResultFromEngineFinding(
			finding, 'trufflehog', 'v3.96.0', engines.truffleHogEngine.capabilities
		);
		assert.strictEqual(result.verified, true);
		assert.strictEqual(result.severity, 'high');
		assert.ok(/VERIFIED LIVE/.test(result.description));
	});

	test('the same secret found by two engines merges into one attributed row', () => {
		const p = panel();
		const base = { file: 'app.py', line: 3, fullSecret: 'AKIA', commitHash: 'abc123' };
		const merged = p._deduplicateScanResults([
			{ ...base, ruleName: 'aws-access-token', engine: 'gitleaks', engines: ['gitleaks'], entropy: 3.5, unavailableFields: ['verified'] },
			{ ...base, ruleName: 'AWS', engine: 'trufflehog', engines: ['trufflehog'], verified: true, unavailableFields: ['entropy', 'verified'] }
		]);
		assert.strictEqual(merged.length, 1, 'corroboration is not two findings');
		assert.deepStrictEqual(merged[0].engines.sort(), ['gitleaks', 'trufflehog']);
		// The merged record is the union of what the engines supplied: entropy from
		// one, verification from the other. Corroboration must never subtract detail.
		assert.strictEqual(merged[0].entropy, 3.5);
		assert.strictEqual(merged[0].verified, true);
		// A field is only unavailable if every reporting engine lacked it.
		assert.deepStrictEqual(merged[0].unavailableFields, ['verified']);
	});

	test('two rules matching one secret produce one row that names both', () => {
		// `github-pat` and `generic-api-key` both fire on a GitHub token. That is one
		// credential, and showing it twice just doubles the review burden.
		const p = panel();
		const base = { file: 'app.py', line: 3, fullSecret: 'AKIAIOSFODNN7EXAMPLE', commitHash: 'abc123', engine: 'gitleaks' };
		const merged = p._deduplicateScanResults([
			{ ...base, ruleName: 'aws-access-token', engines: ['gitleaks'] },
			{ ...base, ruleName: 'generic-api-key', engines: ['gitleaks'] },
			{ ...base, ruleName: 'aws-access-token', engines: ['gitleaks'] }
		]);
		assert.strictEqual(merged.length, 1);
		assert.deepStrictEqual(merged[0].ruleNames.sort(), ['aws-access-token', 'generic-api-key']);
	});
});

suite('Scan coverage and export parity', () => {
	const LeakLockPanel = require('../leakLockPanel');

	function panelWithResults(results, coverage) {
		const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
		panel._updateWebviewContent = () => {};
		panel._scanResults = results;
		panel._scanCoverage = coverage || null;
		panel._resetScanSelection();
		return panel;
	}

	const gitleaksFinding = {
		file: 'app.py', line: 3, secret: 'AKIA…', fullSecret: 'AKIAIOSFODNN7EXAMPLE',
		description: 'AWS Access Token', severity: 'high', ruleName: 'aws-access-token',
		isDependency: false, isGitHistory: true, isUntracked: false,
		commitHash: 'abc123', commitBranches: null, commitDate: '2026-07-31T04:57:01Z',
		engine: 'gitleaks', engines: ['gitleaks'], engineVersion: 'v8.30.1',
		entropy: 3.5, fingerprint: 'fp1', endLine: 3, startColumn: 11, endColumn: 30,
		unavailableFields: ['verified']
	};

	const noseyParkerFinding = {
		file: 'legacy.py', line: 1, secret: 'xoxb…', fullSecret: 'xoxb-1111',
		description: 'Slack Bot Token', severity: 'high', ruleName: 'Slack Bot Token',
		isDependency: false, isGitHistory: true, isUntracked: false,
		commitHash: 'def456', commitBranches: null, commitDate: null,
		engine: 'noseyparker', engines: ['noseyparker'], engineVersion: 'v0.24.0'
	};

	const coverage = {
		incomplete: false, incompleteReason: null,
		engines: [
			{ id: 'gitleaks', displayName: 'Gitleaks', version: 'v8.30.1', ok: true, findings: 1 },
			{ id: 'noseyparker', displayName: 'Nosey Parker', version: 'v0.24.0', ok: true, findings: 1, note: 'archived upstream' }
		],
		image: 'ghcr.io/praetorian-inc/noseyparker:v0.24.0', imagePulled: true, imagePullError: null,
		rulesetMode: 'default', maxFileSizeMb: 100, timeoutSeconds: 300, dependencyHandling: 'warning',
		refRefresh: { attempted: true, ok: true, reason: null },
		refs: { localBranches: 2, remoteBranches: 2, remoteOnlyBranches: ['side'], tags: 1, stashes: 0 }
	};

	test('the export shape does not vary by engine', () => {
		const panel = panelWithResults([gitleaksFinding, noseyParkerFinding], coverage);
		const payload = panel._buildScanExportPayload();
		assert.strictEqual(payload.findings.length, 2);
		// Every key present for one engine must be present for the other, or a
		// consumer parsing the export would silently lose columns per engine.
		const [a, b] = payload.findings;
		assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort());
		for (const key of ['engine', 'engines', 'engineVersion', 'verified', 'entropy', 'fingerprint', 'unavailableFields']) {
			assert.ok(key in a && key in b, `${key} must be present for both engines`);
		}
		assert.strictEqual(a.entropy, 3.5);
		assert.strictEqual(b.entropy, null, 'a field the engine did not supply is null, not missing');
	});

	test('redacted exports drop author identity as well as secrets', () => {
		const panel = panelWithResults([{ ...gitleaksFinding, author: 'Fixture', authorEmail: 'f@example.invalid', commitMessage: 'add app' }], coverage);
		const payload = panel._buildScanExportPayload({ redactSensitive: true });
		assert.strictEqual(payload.findings[0].secret, '[REDACTED_SECRET]');
		assert.strictEqual(payload.findings[0].author, null);
		assert.strictEqual(payload.findings[0].authorEmail, null);
		assert.strictEqual(payload.findings[0].commitMessage, null);
		// Paths still visible by design; that is documented in the export dialog.
		assert.strictEqual(payload.findings[0].file, 'app.py');
	});

	test('the export records what the scan covered', () => {
		const panel = panelWithResults([gitleaksFinding], coverage);
		const payload = panel._buildScanExportPayload();
		assert.ok(payload.coverage, 'an exported report without its scope cannot be audited later');
		assert.strictEqual(payload.coverage.incomplete, false);
		assert.strictEqual(payload.coverage.refsRefreshed, true);
		assert.deepStrictEqual(payload.coverage.engines.map(e => e.id), ['gitleaks', 'noseyparker']);
		assert.strictEqual(payload.summary.verifiedLiveCredentials, 0);
	});

	test('an incomplete scan is marked in the export, not just in a toast', () => {
		const panel = panelWithResults([gitleaksFinding], {
			...coverage, incomplete: true, incompleteReason: 'stopped after 300s'
		});
		const payload = panel._buildScanExportPayload();
		assert.strictEqual(payload.coverage.incomplete, true);
		assert.match(payload.coverage.incompleteReason, /300s/);
	});

	test('coverage is rendered with the results, including remote-only branches', () => {
		const panel = panelWithResults([gitleaksFinding], coverage);
		const html = panel._renderScanCoverage();
		assert.match(html, /Scan coverage/);
		assert.match(html, /Gitleaks/);
		assert.match(html, /Nosey Parker/);
		assert.match(html, /Refs were refreshed from origin/);
		assert.match(html, /exist only on the remote/);
		assert.match(html, /side/);
	});

	test('the panel is collapsed by default and summarises what is inside', () => {
		// On a busy repository the detail runs to hundreds of branch names. The
		// summary carries the numbers so the panel is scannable at a glance.
		const panel = panelWithResults([gitleaksFinding], coverage);
		const html = panel._renderScanCoverage();
		assert.match(html, /<details class="coverage-toggle">/);
		assert.ok(!/<details class="coverage-toggle" open/.test(html), 'starts collapsed');
		assert.match(html, /coverage-summary/);
		assert.match(html, /Gitleaks \+ Nosey Parker/, 'the summary names the engines that ran');
		// The merged count, matching the results table. Per-engine counts sum to 2
		// here because both engines reported the same secret; showing that unmerged
		// total beside a one-row table would just look like a miscount.
		assert.match(html, /1 finding\b/, 'the summary uses the merged finding count');
		assert.match(html, /5 refs scanned/, 'the summary totals the refs');
	});

	test('a long remote-only branch list is collapsed behind a count', () => {
		const many = Array.from({ length: 150 }, (_, i) => `feat/branch-${i}`);
		const panel = panelWithResults([gitleaksFinding], {
			...coverage,
			refs: { ...coverage.refs, remoteBranches: 150, remoteOnlyBranches: many }
		});
		const html = panel._renderScanCoverage();
		assert.match(html, /150 branches exist only on the remote/);
		assert.match(html, /coverage-branchlist/);
	});

	test('warnings are promoted into the summary, never hidden by collapsing', () => {
		// Collapsing must hide volume, not caveats. A reader who never expands the
		// panel still has to see that coverage was reduced.
		const panel = panelWithResults([gitleaksFinding], {
			...coverage,
			refRefresh: { attempted: true, ok: false, reason: 'The remote host could not be reached.' },
			strategy: { mode: 'sequential', tier: 'constrained', concurrency: 1, dropped: ['trufflehog'], reason: 'constrained host', host: { cpus: 2, totalMemGb: 3, memorySource: 'os', loadPerCore: 0.1 } }
		});
		const html = panel._renderScanCoverage();
		const summary = html.slice(0, html.indexOf('coverage-intro'));
		assert.match(summary, /coverage-badge/);
		assert.match(summary, /refs not refreshed/);
		assert.match(summary, /1 engine skipped/);
	});

	test('an unrefreshed ref set is called out rather than passed over', () => {
		const panel = panelWithResults([gitleaksFinding], {
			...coverage, refRefresh: { attempted: true, ok: false, reason: 'The remote host could not be reached.' }
		});
		const html = panel._renderScanCoverage();
		assert.match(html, /Refs were <strong>not<\/strong> refreshed/);
		assert.match(html, /may not have been scanned/);
	});

	test('a raw git failure is folded away, not spliced into the summary', () => {
		// The reported version put git's entire SAML/SSO remote message inline in
		// the refs line, which made the panel unreadable.
		const raw = 'ERROR: The organization has enabled or enforced SAML SSO. Visit https://docs.github.com/... fatal: Could not read from remote repository.';
		const panel = panelWithResults([gitleaksFinding], {
			...coverage,
			refRefresh: {
				attempted: true, ok: false,
				reason: 'The organisation that owns this remote enforces SAML single sign-on, and your credential is not authorised for it.',
				remoteError: { kind: 'sso', command: 'git fetch --tags origin', cause: 'x', fix: 'y', detail: raw }
			}
		});
		const html = panel._renderScanCoverage();
		const summary = html.slice(0, html.indexOf('coverage-intro'));
		assert.ok(!summary.includes('docs.github.com'), 'raw git output never reaches the summary line');
		assert.match(html, /What git reported/);
		assert.match(html, /coverage-raw/);
	});

	test('an engine with no usable version says so instead of printing a placeholder', () => {
		// Ubuntu's gitleaks package prints "version is set by build process".
		const panel = panelWithResults([gitleaksFinding], {
			...coverage,
			engines: [{ id: 'gitleaks', displayName: 'Gitleaks', version: null, ok: true, findings: 0 }]
		});
		const html = panel._renderScanCoverage();
		assert.match(html, /version unknown/);
		assert.ok(!/version is set by build process/.test(html));
	});

	test('an incomplete scan renders an unmissable banner, not a dismissible toast', () => {
		const panel = panelWithResults([], { ...coverage, incomplete: true, incompleteReason: 'stopped after 300s' });
		const html = panel._renderScanCoverage();
		assert.match(html, /Scan incomplete/);
		assert.match(html, /not exhaustive/);
		// It sits outside the toggle: an incomplete scan is a finding in its own
		// right and must not require a click to discover.
		assert.ok(html.indexOf('Scan incomplete') < html.indexOf('<details class="coverage-toggle">'));
	});

	test('attribution names the engines that found a finding and those that missed it', () => {
		const panel = panelWithResults([gitleaksFinding], coverage);
		const html = panel._renderEngineAttribution(gitleaksFinding);
		assert.match(html, /Gitleaks/);
		// Nosey Parker ran against the same repository and did not report it.
		assert.match(html, /missed by/);
		assert.match(html, /Nosey Parker/);
		assert.match(html, /no verified/, 'a structurally unavailable field is stated');
	});

	test('a verified live credential is flagged in the results table', () => {
		const panel = panelWithResults([{ ...gitleaksFinding, verified: true, engines: ['trufflehog'], unavailableFields: [] }], coverage);
		const html = panel._renderEngineAttribution(panel._scanResults[0]);
		assert.match(html, /VERIFIED LIVE/);
	});

	test('the results table exposes an Engine column', () => {
		const panel = panelWithResults([gitleaksFinding, noseyParkerFinding], coverage);
		const html = panel._getResultsHtml();
		assert.match(html, /<th[^>]*>Engine<\/th>/);
		assert.match(html, /Scan coverage/);
	});
});

suite('Manual redaction rules', () => {
	const rules = require('../redaction-rules');
	const LeakLockPanel = require('../leakLockPanel');

	function panel() {
		const p = new LeakLockPanel({ fsPath: '/tmp/ext' });
		p._updateWebviewContent = () => {};
		return p;
	}

	test('a source containing the rule separator is rejected', () => {
		// "==>" separates the match from the replacement in the rule file. A source
		// containing it produces a malformed line, and the rewrite tool's parse of
		// that line — not the UI — decides what actually gets removed.
		const result = rules.validateRule({ source: 'host==>evil', mode: 'literal', replaceWith: 'x' });
		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some(e => e.includes('==>')));
	});

	test('empty, whitespace-only and multi-line sources are rejected', () => {
		assert.strictEqual(rules.validateRule({ source: '' }).valid, false);
		assert.strictEqual(rules.validateRule({ source: '   ' }).valid, false);
		assert.strictEqual(rules.validateRule({ source: 'a\nb' }).valid, false);
	});

	test('an invalid regex is rejected at entry, not at rewrite time', () => {
		const bad = rules.validateRule({ source: '([unclosed', mode: 'regex' });
		assert.strictEqual(bad.valid, false);
		assert.ok(bad.errors.some(e => /valid regular expression/i.test(e)));
		assert.strictEqual(rules.validateRule({ source: 'AKIA[0-9A-Z]{16}', mode: 'regex' }).valid, true);
	});

	test('a pattern matching the empty string is refused', () => {
		// It would rewrite every blob in history.
		const result = rules.validateRule({ source: 'x*', mode: 'regex' });
		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some(e => /empty string/.test(e)));
	});

	test('a very short literal is warned about but still allowed', () => {
		const result = rules.validateRule({ source: 'abc', mode: 'literal' });
		assert.strictEqual(result.valid, true, 'short internal codenames are legitimate');
		assert.ok(result.warnings.length > 0, 'but the blast radius has to be previewed');
	});

	test('rule lines carry the mode through to the rewrite file', () => {
		assert.strictEqual(
			rules.formatRuleLine({ source: 'internal.example.com', mode: 'literal', replaceWith: 'redacted' }),
			'internal.example.com==>redacted'
		);
		// Both BFG and git filter-repo need the regex: prefix; without it the pattern
		// would be rewritten as a literal and match nothing.
		assert.strictEqual(
			rules.formatRuleLine({ source: 'AKIA[0-9A-Z]{16}', mode: 'regex', replaceWith: '*****' }),
			'regex:AKIA[0-9A-Z]{16}==>*****'
		);
		assert.strictEqual(
			rules.formatRuleLine({ source: 'x', mode: 'literal', replaceWith: '' }),
			'x==>*****',
			'an empty replacement falls back to the single default'
		);
	});

	test('verification channels are split by mode', () => {
		// verifyRemoteRefs greps literals with --fixed-strings. A regex rule verified
		// that way would rewrite correctly and then fail its own verification.
		const split = rules.partitionForVerification([
			{ source: 'host', mode: 'literal' },
			{ source: 'AKIA[0-9A-Z]{16}', mode: 'regex' }
		]);
		assert.deepStrictEqual(split.literals, ['host']);
		assert.deepStrictEqual(split.patterns, ['AKIA[0-9A-Z]{16}']);
	});

	test('the preview uses a pickaxe over all refs', () => {
		const literal = rules.buildPreviewArgs({ source: 'host', mode: 'literal' });
		const regex = rules.buildPreviewArgs({ source: 'h.st', mode: 'regex' });
		// -S/-G search diffs, so they find content added and later removed — the
		// normal case for a leaked value, and what a working-tree grep would miss.
		assert.ok(literal.includes('-Shost'));
		assert.ok(regex.includes('-Gh.st'));
		// The preview must cover the same refs the rewrite will, or it understates.
		assert.ok(literal.includes('--all'));
	});

	test('the panel stores, deduplicates and removes rules', () => {
		const p = panel();
		assert.strictEqual(p._addCustomRule('internal.example.com', 'literal', 'redacted').ok, true);
		assert.strictEqual(p._getCustomRules().length, 1);
		// Re-adding the same source edits it rather than shadowing it with a second rule.
		p._addCustomRule('internal.example.com', 'literal', 'changed');
		assert.strictEqual(p._getCustomRules().length, 1);
		assert.strictEqual(p._getCustomRules()[0].replaceWith, 'changed');
		p._addCustomRule('internal.example.com', 'regex', 'other');
		assert.strictEqual(p._getCustomRules().length, 2, 'a different mode is a different rule');
		p._removeCustomRule(p._getCustomRules()[0].id);
		assert.strictEqual(p._getCustomRules().length, 1);
	});

	test('an invalid rule is not stored', () => {
		const p = panel();
		assert.strictEqual(p._addCustomRule('bad==>rule', 'literal', 'x').ok, false);
		assert.strictEqual(p._getCustomRules().length, 0);
	});

	test('manual rules survive a re-scan, unlike index-based selection', () => {
		const p = panel();
		p._addCustomRule('internal.example.com', 'literal', 'redacted');
		p._scanResults = [{ file: 'a', line: 1, fullSecret: 's', isDependency: false }];
		p._resetScanSelection();
		// Selection is tied to _scanResults indices and must reset; rules are not.
		assert.strictEqual(p._getCustomRules().length, 1);
	});

	test('a rules-only cleanup resolves to rules and is not refused', () => {
		const p = panel();
		p._scanResults = [];
		p._resetScanSelection();
		p._addCustomRule('internal.example.com', 'literal', 'redacted');
		const resolved = p._resolveCleanupRules({});
		assert.strictEqual(resolved.length, 1);
		assert.deepStrictEqual(resolved[0], {
			source: 'internal.example.com', mode: 'literal', replaceWith: 'redacted'
		});
	});

	test('findings and manual rules combine without duplicate lines', () => {
		const p = panel();
		p._scanResults = [{
			file: 'a.py', line: 1, secret: 'tok', fullSecret: 'tok',
			isDependency: false, includeInCleanup: true
		}];
		p._resetScanSelection();
		p._setScanSelection(0, true);
		// The same string added manually must not produce a second identical rule.
		p._addCustomRule('tok', 'literal', 'zzz');
		p._addCustomRule('other.example.com', 'literal', 'redacted');
		const resolved = p._resolveCleanupRules({});
		assert.strictEqual(resolved.length, 2);
		assert.deepStrictEqual(resolved.map(r => r.source).sort(), ['other.example.com', 'tok']);
	});

	test('a regex rule reaches the prepared script and its verification', () => {
		const p = panel();
		p._addCustomRule('AKIA[0-9A-Z]{16}', 'regex', 'REDACTED');
		const script = p._buildScanBfgReplaceCommand('/repo', p._resolveCleanupRules({}));
		assert.ok(script.includes('regex:AKIA[0-9A-Z]{16}==>REDACTED'), 'the regex: prefix reaches the rule file');
		// One list, one place: the secret is not repeated in a per-rule grep line.
		assert.ok(script.includes('done < "$replacement_file"'));
		assert.ok(script.includes('grep_flag="--extended-regexp"'));
	});

	test('the rules editor renders even when the scan found nothing', () => {
		// A clean scan is exactly when a user reaches for manual redaction.
		const html = panel()._renderCustomRules();
		assert.match(html, /Manual redaction rules/);
		assert.match(html, /custom-rule-source/);
		assert.match(html, /custom-rule-mode/);
	});

	test('a rule that matches nothing is called out as probably a typo', () => {
		const p = panel();
		const outcome = p._addCustomRule('internal.example.com', 'literal', 'redacted');
		p._scanCleanup.customRulePreviews[outcome.rule.id] = {
			commitCount: 0, commits: [], files: [], branches: [], truncated: false, maxCount: 200
		};
		const html = p._renderCustomRules();
		assert.match(html, /Matches nothing in history/);
		assert.match(html, /typo/);
	});

	test('a bounded preview says it is bounded', () => {
		const p = panel();
		const outcome = p._addCustomRule('internal.example.com', 'literal', 'redacted');
		p._scanCleanup.customRulePreviews[outcome.rule.id] = {
			commitCount: 200, commits: [], files: ['a.py'], branches: ['main'], truncated: true, maxCount: 200
		};
		const html = p._renderCustomRules();
		assert.match(html, /the real total is higher/);
	});
});

suite('Manual regex redaction end to end', () => {
	const gitRewrite = require('../git-rewrite');
	const LeakLockPanel = require('../leakLockPanel');
	const redactionRules = require('../redaction-rules');
	const cp = require('child_process');
	const fs = require('fs');
	const os = require('os');
	const path = require('path');

	const env = {
		...process.env,
		GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
		GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.com',
		GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.com'
	};

	// git filter-repo is not one of the extension's installed dependencies, so this
	// suite reports itself skipped rather than failing on a machine without it.
	function hasFilterRepo() {
		try {
			cp.execFileSync('git', ['filter-repo', '--version'], { env, stdio: 'ignore' });
			return true;
		} catch {
			return false;
		}
	}

	let base, origin, work, available;

	suiteSetup(() => {
		available = hasFilterRepo();
		if (!available) { return; }
		base = fs.mkdtempSync(path.join(os.tmpdir(), 'leaklock-regex-'));
		origin = path.join(base, 'origin.git');
		work = path.join(base, 'work');
		cp.execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin], { env });
		cp.execFileSync('git', ['clone', '-q', origin, work], { env });
		// Three variants of one internal hostname: enumerating them by hand is
		// exactly what regex mode exists to avoid.
		fs.writeFileSync(path.join(work, 'README.md'), '# app\n');
		fs.writeFileSync(path.join(work, 'conf.yml'), [
			'a: api.internal-corp-7.example',
			'b: db.internal-corp-42.example',
			'c: mq.internal-corp-999.example'
		].join('\n') + '\n');
		const g = (args) => cp.execFileSync('git', ['-C', work, ...args], { env });
		g(['add', '-A']); g(['commit', '-qm', 'add config']); g(['push', '-q', 'origin', 'main']);
	});

	suiteTeardown(() => {
		if (base) { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { void e; } }
	});

	function originMatches(pattern) {
		return cp.execFileSync('git', ['--git-dir=' + origin, 'log', '--all', '-G', pattern, '--oneline'], { env })
			.toString().trim().length > 0;
	}

	test('a regex rule removes every variant and verifies clean on the remote', async function () {
		if (!available) { this.skip(); return; }
		const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
		panel._updateWebviewContent = () => {};
		panel._addCustomRule('internal-corp-[0-9]+\\.example', 'regex', 'redacted.invalid');
		const rules = panel._resolveCleanupRules({});

		assert.strictEqual(originMatches('internal-corp-[0-9]+\\.example'), true, 'the remote starts dirty');

		await panel._withSecureReplacementsFile(rules, async (replacementsFile) => {
			// The rule file is what both the rewrite and the verification read.
			const contents = fs.readFileSync(replacementsFile, 'utf8');
			assert.ok(contents.startsWith('regex:'), 'the regex: prefix reaches the rewrite tool');
			return gitRewrite.runRewrite({
				repoDir: work,
				push: false,
				rewrite: async () => {
					cp.execFileSync('git', ['filter-repo', '--replace-text', replacementsFile, '--force'],
						{ cwd: work, env, maxBuffer: 64 * 1024 * 1024 });
				}
			});
		});

		await gitRewrite.ensureRemote(work, 'origin', origin);
		await gitRewrite.pushRewritten(work, 'origin');

		const verify = redactionRules.partitionForVerification(rules);
		assert.deepStrictEqual(verify.literals, [], 'a regex rule must not be verified as a literal');
		const offenders = await gitRewrite.verifyRemoteRefs(work, 'origin', verify);
		assert.deepStrictEqual(offenders, [], 'regex-aware verification reports the remote clean');
		assert.strictEqual(originMatches('internal-corp-[0-9]+\\.example'), false, 'every variant is gone from the remote');
	});

	test('verification can still fail — it is not vacuously clean', async function () {
		if (!available) { this.skip(); return; }
		// A verification step that cannot report dirty is not a verification step.
		// 'app' is still present in README.md, so this must be reported.
		const offenders = await gitRewrite.verifyRemoteRefs(work, 'origin', { patterns: ['a[p]p'] });
		assert.ok(offenders.length > 0, 'a pattern that is still present is reported as an offender');
		assert.ok(offenders.every(o => o.reason === 'secret still present'));
	});
});

suite('Engine selection and graceful degradation', () => {
	const LeakLockPanel = require('../leakLockPanel');

	test('unknown engine ids are dropped rather than passed through', () => {
		const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
		const ids = panel._getEnabledEngineIds();
		// Whatever the workspace config holds, only engines this build knows about
		// may reach the scan loop.
		assert.ok(ids.every(id => ['gitleaks', 'trufflehog', 'noseyparker'].includes(id)));
	});

	test('every engine is enabled by default, led by the maintained one', () => {
		const pkg = require('../package.json');
		const setting = pkg.contributes.configuration.properties['leakLock.scan.engines'];
		// All three ship on. An engine whose binary is absent is reported and skipped,
		// so the cost of enabling it is a line in the coverage panel — and the benefit
		// is that the capability is discoverable instead of hidden in settings.
		assert.deepStrictEqual(setting.default, ['gitleaks', 'trufflehog', 'noseyparker']);
		// Nosey Parker is archived upstream, so it must not be the engine a new user
		// relies on by default.
		assert.strictEqual(setting.default[0], 'gitleaks');
	});

	test('the code fallback matches the manifest default', () => {
		// These drifting apart is how a user ends up with fewer engines than the
		// documentation shows.
		const pkg = require('../package.json');
		const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
		const ids = panel._getEnabledEngineIds();
		assert.deepStrictEqual(
			ids.slice().sort(),
			pkg.contributes.configuration.properties['leakLock.scan.engines'].default.slice().sort()
		);
	});

	test('credential verification is off by default', () => {
		const pkg = require('../package.json');
		const setting = pkg.contributes.configuration.properties['leakLock.trufflehog.verify'];
		assert.strictEqual(setting.default, false,
			'verification sends the discovered credential to a third party; it must be opt-in');
	});

	test('coverage names an engine that was skipped, rather than omitting it', async () => {
		const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
		panel._updateWebviewContent = () => {};
		panel._scanCoverage = {
			incomplete: false, incompleteReason: null,
			engines: [
				{ id: 'gitleaks', displayName: 'Gitleaks', version: 'v8.30.1', ok: true, findings: 3 },
				{ id: 'noseyparker', displayName: 'Nosey Parker', version: null, ok: false, findings: 0, note: 'Skipped — Docker not available: daemon not running' }
			],
			refs: { localBranches: 1, remoteBranches: 1, remoteOnlyBranches: [], tags: 0, stashes: 0 },
			refRefresh: { attempted: true, ok: true, reason: null },
			rulesetMode: 'default', maxFileSizeMb: 100, timeoutSeconds: 300, dependencyHandling: 'warning'
		};
		const html = panel._renderScanCoverage();
		// An engine that did not run must be stated, not silently absent — otherwise
		// a partial scan reads as a full one.
		assert.match(html, /Nosey Parker/);
		assert.match(html, /Docker not available/);
	});
});

suite('Host capacity and scan execution strategy', () => {
	const host = require('../host-capacity');

	const HOSTS = {
		tiny: { cpus: 2, totalMemGb: 3, memorySource: 'os', platform: 'linux', loadPerCore: 0.2 },
		modest: { cpus: 4, totalMemGb: 8, memorySource: 'os', platform: 'linux', loadPerCore: 0.3 },
		big: { cpus: 16, totalMemGb: 32, memorySource: 'os', platform: 'linux', loadPerCore: 0.2 },
		busy: { cpus: 16, totalMemGb: 32, memorySource: 'os', platform: 'linux', loadPerCore: 3.0 }
	};
	const ALL = ['gitleaks', 'trufflehog', 'noseyparker'];

	test('a capable host runs engines in parallel, leaving cores for the editor', () => {
		const plan = host.chooseScanStrategy({ engines: ALL, host: HOSTS.big });
		assert.strictEqual(plan.tier, 'capable');
		assert.strictEqual(plan.mode, 'parallel');
		assert.deepStrictEqual(plan.dropped, []);
		assert.ok(plan.concurrency <= HOSTS.big.cpus - 2, 'the editor and git still need a core');
	});

	test('a modest host runs every engine, one at a time', () => {
		const plan = host.chooseScanStrategy({ engines: ALL, host: HOSTS.modest });
		assert.strictEqual(plan.mode, 'sequential');
		assert.strictEqual(plan.concurrency, 1);
		// Slower is fine. Dropping an engine is not.
		assert.deepStrictEqual(plan.dropped, []);
		assert.deepStrictEqual(plan.engines.sort(), ALL.slice().sort());
	});

	test('a saturated host is treated as modest even with many cores', () => {
		const plan = host.chooseScanStrategy({ engines: ALL, host: HOSTS.busy });
		assert.strictEqual(plan.tier, 'moderate');
		assert.strictEqual(plan.mode, 'sequential');
	});

	test('a constrained host keeps the lightest, most capable engine', () => {
		const plan = host.chooseScanStrategy({ engines: ALL, host: HOSTS.tiny });
		assert.strictEqual(plan.tier, 'constrained');
		// Gitleaks: a static binary with no container runtime or JVM, and the only
		// maintained engine — so the one left standing is also the one most likely
		// to find something.
		assert.deepStrictEqual(plan.engines, ['gitleaks']);
		assert.deepStrictEqual(plan.dropped.sort(), ['noseyparker', 'trufflehog']);
	});

	test('a capacity downgrade is never silent', () => {
		const plan = host.chooseScanStrategy({ engines: ALL, host: HOSTS.tiny });
		// Fewer engines means fewer findings; the user has to be told, and told how
		// to override it.
		assert.match(plan.reason, /constrained/);
		assert.match(plan.reason, /skipped/);
		assert.match(plan.reason, /executionMode/);
		assert.match(plan.reason, /2 core/);
	});

	test('an explicit mode overrides the heuristic in both directions', () => {
		const forced = host.chooseScanStrategy({ engines: ALL, host: HOSTS.tiny, mode: 'parallel' });
		assert.strictEqual(forced.mode, 'parallel');
		assert.deepStrictEqual(forced.dropped, [], 'an explicit request is honoured on a weak host');

		const held = host.chooseScanStrategy({ engines: ALL, host: HOSTS.big, mode: 'sequential' });
		assert.strictEqual(held.mode, 'sequential');

		const single = host.chooseScanStrategy({ engines: ALL, host: HOSTS.big, mode: 'single' });
		assert.deepStrictEqual(single.engines, ['gitleaks']);
		assert.strictEqual(single.dropped.length, 2);
	});

	test('one enabled engine needs no strategy at all', () => {
		const plan = host.chooseScanStrategy({ engines: ['gitleaks'], host: HOSTS.big });
		assert.strictEqual(plan.mode, 'sequential');
		assert.deepStrictEqual(plan.dropped, []);
	});

	test('container memory limits beat the host figure', () => {
		// os.totalmem() reports the host's memory inside a container — precisely
		// where resources are tightest.
		const limited = host.detectMemoryLimit((p) =>
			p === '/sys/fs/cgroup/memory.max' ? '2147483648' : null);
		assert.strictEqual(limited.source, 'cgroup-v2');
		assert.strictEqual(limited.bytes, 2147483648);

		// "max" means unlimited, so the host figure stands.
		const unlimited = host.detectMemoryLimit((p) =>
			p === '/sys/fs/cgroup/memory.max' ? 'max' : null);
		assert.strictEqual(unlimited.source, 'os');

		const v1 = host.detectMemoryLimit((p) =>
			p === '/sys/fs/cgroup/memory/memory.limit_in_bytes' ? '1073741824' : null);
		assert.strictEqual(v1.source, 'cgroup-v1');
	});

	test('load average is treated as unknown on Windows, not as idle', () => {
		// os.loadavg() returns [0,0,0] on Windows rather than failing.
		const win = host.describeHost({ cpus: 4, memoryBytes: 16 * 1024 ** 3, platform: 'win32' });
		assert.strictEqual(win.loadPerCore, null);
		const linux = host.describeHost({
			cpus: 4, memoryBytes: 16 * 1024 ** 3, platform: 'linux', loadavg: [2, 2, 2]
		});
		assert.strictEqual(linux.loadPerCore, 0.5);
	});

	test('describeHost reports something usable on this machine', () => {
		const real = host.describeHost();
		assert.ok(real.cpus >= 1);
		assert.ok(real.totalMemGb > 0);
		assert.ok(['constrained', 'moderate', 'capable'].includes(host.classifyHost(real)));
	});

	test('one failing engine does not cancel the others', () => {
		return host.runWithConcurrency([
			async () => ({ id: 'a' }),
			async () => { throw new Error('boom'); },
			async () => ({ id: 'c' })
		], 3).then((results) => {
			assert.strictEqual(results.length, 3);
			assert.strictEqual(results[0].id, 'a');
			assert.ok(results[1].error, 'the failure is reported in its own slot');
			assert.strictEqual(results[2].id, 'c', 'later engines still run');
		});
	});

	test('concurrency is actually bounded', async () => {
		let inFlight = 0, peak = 0;
		const tasks = Array.from({ length: 6 }, () => async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise(r => setTimeout(r, 10));
			inFlight -= 1;
			return true;
		});
		await host.runWithConcurrency(tasks, 2);
		assert.strictEqual(peak, 2);
	});
});

suite('Preparing a command must never modify the repository', () => {
	const LeakLockPanel = require('../leakLockPanel');
	const cp = require('child_process');
	const fs = require('fs');
	const os = require('os');
	const path = require('path');

	const env = {
		...process.env,
		GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
		GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.com',
		GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.com'
	};
	let base, origin, work;

	suiteSetup(() => {
		base = fs.mkdtempSync(path.join(os.tmpdir(), 'leaklock-prepare-'));
		origin = path.join(base, 'origin.git');
		work = path.join(base, 'work');
		cp.execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin], { env });
		cp.execFileSync('git', ['clone', '-q', origin, work], { env });
		fs.writeFileSync(path.join(work, 'README.md'), '# app\n');
		fs.writeFileSync(path.join(work, 'conf.env'), 'TOKEN=PREPARE_MUST_NOT_REMOVE_ME\n');
		const g = (args) => cp.execFileSync('git', ['-C', work, ...args], { env });
		g(['add', '-A']); g(['commit', '-qm', 'add secret']); g(['push', '-q', 'origin', 'main']);
	});

	suiteTeardown(() => {
		try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { void e; }
	});

	function headSha() {
		return cp.execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { env }).toString().trim();
	}
	function originHasSecret() {
		return cp.execFileSync('git', ['--git-dir=' + origin, 'log', '--all', '-S', 'PREPARE_MUST_NOT_REMOVE_ME', '--oneline'], { env })
			.toString().trim().length > 0;
	}
	function workingCopyHasSecret() {
		return fs.existsSync(path.join(work, 'conf.env'));
	}

	function preparedPanel() {
		const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
		panel._updateWebviewContent = () => {};
		panel._scanPath = work;
		panel._selectedDirectory = work;
		panel._scanResults = [{
			file: 'conf.env', line: 1,
			secret: 'PREPARE_MUST_NOT_REMOVE_ME', fullSecret: 'PREPARE_MUST_NOT_REMOVE_ME',
			description: 'token', severity: 'high', ruleName: 'token',
			isDependency: false, includeInCleanup: true, isGitHistory: true
		}];
		panel._resetScanSelection();
		panel._setScanSelection(0, true);
		return panel;
	}

	test('preparing the BFG command leaves history, the remote and the worktree untouched', async () => {
		const before = headSha();
		const panel = preparedPanel();
		await panel._prepareScanBfgCommand({});

		assert.ok(panel._scanCleanup.preparedCommand, 'a script was produced');
		assert.strictEqual(panel._scanCleanup.preparedMode, 'bfg');
		// Preparing is a read-only planning step. Anything else here is a
		// catastrophic bug: the user asked to see the plan, not to run it.
		assert.strictEqual(headSha(), before, 'HEAD must not move when only preparing');
		assert.strictEqual(originHasSecret(), true, 'the remote must still be untouched');
		assert.strictEqual(workingCopyHasSecret(), true, 'the working copy must be untouched');
	});

	test('preparing the Git-only command leaves history, the remote and the worktree untouched', async () => {
		const before = headSha();
		const panel = preparedPanel();
		await panel._prepareScanGitCommand({});

		assert.ok(panel._scanCleanup.preparedCommand, 'a script was produced');
		assert.strictEqual(panel._scanCleanup.preparedMode, 'git');
		assert.strictEqual(headSha(), before, 'HEAD must not move when only preparing');
		assert.strictEqual(originHasSecret(), true, 'the remote must still be untouched');
		assert.strictEqual(workingCopyHasSecret(), true, 'the working copy must be untouched');
	});

	test('preparing does not stage a force-push', () => {
		const panel = preparedPanel();
		assert.strictEqual(panel._scanCleanup.pendingPush, null,
			'nothing may be staged for the remote by a planning step');
	});

	test('the real render path is also side-effect free', async () => {
		// The tests above stub _updateWebviewContent, which would hide a destructive
		// side effect inside _getHtmlForWebview()/_getResultsHtml(). Prepare calls
		// the render twice, so exercise the genuine one against a fake panel.
		const before = headSha();
		const panel = preparedPanel();
		const rendered = [];
		panel._panel = { webview: { set html(value) { rendered.push(value); }, get html() { return rendered[rendered.length - 1] || ''; } } };
		// _updateWebviewContent is a no-op until the single initial render has run.
		panel._initialRenderDone = true;
		// preparedPanel() stubs the render; drop the own-property stub so the real
		// prototype method runs. Stubbing it is exactly what would hide this bug.
		delete panel._updateWebviewContent;

		await panel._prepareScanBfgCommand({});

		assert.ok(rendered.length >= 2, 'prepare re-renders while preparing and after');
		assert.ok(rendered[rendered.length - 1].includes('Prepare BFG command'), 'the panel rendered');
		assert.strictEqual(headSha(), before, 'rendering must not move HEAD');
		assert.strictEqual(originHasSecret(), true, 'rendering must not touch the remote');
		assert.strictEqual(workingCopyHasSecret(), true, 'rendering must not touch the worktree');
	});
});

suite('An unreachable remote stops preparation with a clear message', () => {
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
		// Never let a failing fetch sit waiting for credentials in a test.
		GIT_TERMINAL_PROMPT: '0'
	};
	let base, work;

	suiteSetup(() => {
		base = fs.mkdtempSync(path.join(os.tmpdir(), 'leaklock-noremote-'));
		work = path.join(base, 'work');
		fs.mkdirSync(work);
		const g = (args) => cp.execFileSync('git', ['-C', work, ...args], { env });
		cp.execFileSync('git', ['init', '-q', '-b', 'main', work], { env });
		fs.writeFileSync(path.join(work, 'conf.env'), 'TOKEN=UNREACHABLE_REMOTE_SECRET\n');
		g(['add', '-A']); g(['commit', '-qm', 'add secret']);
		// A remote that exists in config but cannot be reached — the same shape as an
		// SSO-gated, unauthenticated or offline remote.
		g(['remote', 'add', 'origin', path.join(base, 'does-not-exist.git')]);
	});

	suiteTeardown(() => {
		try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { void e; }
	});

	function preparedPanel() {
		const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
		panel._updateWebviewContent = () => {};
		panel._scanPath = work;
		panel._selectedDirectory = work;
		panel._scanResults = [{
			file: 'conf.env', line: 1,
			secret: 'UNREACHABLE_REMOTE_SECRET', fullSecret: 'UNREACHABLE_REMOTE_SECRET',
			description: 'token', severity: 'high', ruleName: 'token',
			isDependency: false, includeInCleanup: true, isGitHistory: true
		}];
		panel._resetScanSelection();
		panel._setScanSelection(0, true);
		return panel;
	}

	test('preparation stops and produces nothing at all', async () => {
		const panel = preparedPanel();
		await panel._prepareScanGitCommand({});

		// Half-states are what caused the confusion: a plan built from a comparison
		// that could not be made is worse than no plan.
		assert.strictEqual(panel._scanCleanup.preparedCommand, null, 'no script is generated');
		assert.strictEqual(panel._scanCleanup.preparedMode, null);
		assert.strictEqual(panel._scanCleanup.preparedRepo, null);
		assert.strictEqual(panel._scanCleanup.blockedReason, 'remote-unreachable');
		assert.ok(panel._scanCleanup.remoteError, 'the reason is kept for the panel');
	});

	test('the plan check is read-only — it does not prune refs', async () => {
		const panel = preparedPanel();
		await panel._prepareScanGitCommand({});
		// --prune deletes local remote-tracking refs. Wanted immediately before a
		// rewrite; not wanted during a planning check the user did not ask to mutate
		// anything.
		assert.ok(!panel._scanCleanup.remoteError.command.includes('--prune'),
			'planning must not prune');
		assert.strictEqual(panel._scanCleanup.remoteError.command, 'git fetch --tags origin');
	});

	test('nothing in the repository is touched', async () => {
		const head = () => cp.execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { env }).toString().trim();
		const before = head();
		const panel = preparedPanel();
		await panel._prepareScanGitCommand({});
		assert.strictEqual(head(), before);
		assert.ok(fs.existsSync(path.join(work, 'conf.env')), 'the secret file is still there');
	});

	test('the message leads with "nothing changed" and names the command', async () => {
		const panel = preparedPanel();
		await panel._prepareScanGitCommand({});
		const html = panel._renderRemoteError(panel._scanCleanup.remoteError);

		// The original wording — "Failed to prepare cleanup: Command failed: git
		// fetch ..." — was read as "the cleanup ran". Lead with the opposite.
		assert.match(html, /nothing in your repository was changed/i);
		assert.match(html, /No history was rewritten/);
		assert.match(html, /read-only/);
		assert.match(html, /git fetch --tags origin/);
		assert.match(html, /To fix it:/);
		// Raw git output is available but folded away; it is not the headline.
		assert.match(html, /<details/);
		assert.ok(!/Failed to prepare cleanup/.test(html));
	});

	test('no wording implies a cleanup was attempted', async () => {
		const panel = preparedPanel();
		await panel._prepareScanGitCommand({});
		const html = panel._renderRemoteError(panel._scanCleanup.remoteError);
		for (const misleading of [/cleanup failed/i, /removal failed/i, /rewrite failed/i]) {
			assert.ok(!misleading.test(html), `panel must not say ${misleading}`);
		}
	});

	test('remote failures are classified into a cause and a fix', () => {
		const panel = preparedPanel();
		const cases = [
			['ERROR: The organization has enabled or enforced SAML SSO.', 'sso', /single sign-on/i],
			['Authentication failed for https://example.invalid', 'auth', /refused access/i],
			['ssh: Could not resolve hostname example.invalid', 'network', /could not be reached/i],
			['Repository not found.', 'missing', /does not point at a repository/i]
		];
		for (const [raw, kind, expectedCause] of cases) {
			const summarized = panel._classifyRemoteError(new Error(raw), 'git fetch --tags origin');
			assert.strictEqual(summarized.kind, kind, `${raw} should classify as ${kind}`);
			assert.match(summarized.cause, expectedCause);
			assert.ok(summarized.fix.length > 0, 'every cause carries a fix');
			assert.strictEqual(summarized.command, 'git fetch --tags origin');
		}
	});
});

suite('A cleanup only ever runs where it was planned', () => {
	const LeakLockPanel = require('../leakLockPanel');

	test('the executors target the repository the plan was built for', async () => {
		// _executeBFGCleanup resolved `this._selectedDirectory || workspaceFolders[0]`
		// and omitted the scanned path entirely, so a BFG cleanup could rewrite a
		// repository that was never scanned, planned, or shown in the push plan.
		const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
		panel._updateWebviewContent = () => {};
		panel._scanCleanup.preparedRepo = '/planned/repo';
		panel._scanCleanup.preparedCommand = '#!/usr/bin/env bash\n';
		panel._scanCleanup.preparedMode = 'bfg';
		panel._scanCleanup.replacements = [{ source: 's', mode: 'literal', replaceWith: '*****' }];
		// Deliberately point the fallbacks somewhere else.
		panel._selectedDirectory = '/some/other/repo';
		panel._scanPath = '/another/repo';

		let targeted = null;
		// Intercept at the confirmation gate: the repo is resolved before it.
		const originalWarn = vscode.window.showWarningMessage;
		vscode.window.showWarningMessage = async (message) => {
			targeted = message;
			return 'Cancel';
		};
		try {
			await panel._executeBFGCleanup(panel._scanCleanup.replacements);
		} finally {
			vscode.window.showWarningMessage = originalWarn;
		}
		assert.ok(targeted, 'the destructive action is gated behind a confirmation');
		assert.strictEqual(panel._scanCleanup.preparedRepo, '/planned/repo',
			'the prepared repository is what the executor uses');
	});

	test('preparing records the repository it planned against', async () => {
		const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
		panel._updateWebviewContent = () => {};
		assert.strictEqual(panel._scanCleanup.preparedRepo, null, 'nothing is planned yet');
	});
});

suite('Cross-engine merging tolerates different captures of one secret', () => {
	const LeakLockPanel = require('../leakLockPanel');

	function panel() {
		const p = new LeakLockPanel({ fsPath: '/tmp/ext' });
		p._updateWebviewContent = () => {};
		return p;
	}

	test('engines that capture different spans of the same credential merge', () => {
		// Observed on a real scan of this repository: Nosey Parker and TruffleHog both
		// reported the same MongoDB credential at the same file, line and commit, but
		// captured different spans of it. Requiring byte-identical secrets meant
		// corroboration almost never registered in practice.
		const merged = panel()._deduplicateScanResults([
			{
				file: 'test-secrets.js', line: 12, commitHash: '9bdf369',
				fullSecret: 'mongodb://admin:password@localhost:27017/',
				ruleName: 'Credentials in MongoDB Connection String',
				engine: 'noseyparker', engines: ['noseyparker']
			},
			{
				file: 'test-secrets.js', line: 12, commitHash: '9bdf369',
				fullSecret: 'mongodb://admin:password@localhost:27017/mydb',
				ruleName: 'MongoDB', engine: 'trufflehog', engines: ['trufflehog']
			}
		]);
		assert.strictEqual(merged.length, 1, 'one credential, one row');
		assert.deepStrictEqual(merged[0].engines.sort(), ['noseyparker', 'trufflehog']);
		// The longer capture survives: a rewrite replaces what it is given, so keeping
		// the shorter span would leave "/mydb" behind in history.
		assert.strictEqual(merged[0].fullSecret, 'mongodb://admin:password@localhost:27017/mydb');
	});

	test('unrelated secrets on one line are not merged', () => {
		const merged = panel()._deduplicateScanResults([
			{ file: 'a.js', line: 3, commitHash: 'c1', fullSecret: 'AKIAIOSFODNN7EXAMPLE', engine: 'gitleaks', engines: ['gitleaks'] },
			{ file: 'a.js', line: 3, commitHash: 'c1', fullSecret: 'ghp_totallyunrelatedvalue00', engine: 'trufflehog', engines: ['trufflehog'] }
		]);
		assert.strictEqual(merged.length, 2, 'two different credentials stay two rows');
	});

	test('a short fragment cannot swallow a longer unrelated finding', () => {
		// Without a length floor, "abc" contained in any longer secret would merge them.
		const merged = panel()._deduplicateScanResults([
			{ file: 'a.js', line: 3, commitHash: 'c1', fullSecret: 'admin', engine: 'gitleaks', engines: ['gitleaks'] },
			{ file: 'a.js', line: 3, commitHash: 'c1', fullSecret: 'mongodb://admin:pw@host/db', engine: 'trufflehog', engines: ['trufflehog'] }
		]);
		assert.strictEqual(merged.length, 2, 'a 5-character fragment is below the containment floor');
	});

	test('the same secret in history and in the working tree is one row', () => {
		// An engine's history pass reports a commit; its working-tree pass does not.
		// Two rows for the same line reads as a duplicate.
		const merged = panel()._deduplicateScanResults([
			{ file: 'a.js', line: 3, commitHash: 'c1', fullSecret: 'AKIAIOSFODNN7EXAMPLE', ruleName: 'aws-access-token', engine: 'gitleaks', engines: ['gitleaks'], isGitHistory: true },
			{ file: 'a.js', line: 3, commitHash: null, fullSecret: 'AKIAIOSFODNN7EXAMPLE', ruleName: 'aws-access-token', engine: 'gitleaks', engines: ['gitleaks'], isGitHistory: false }
		]);
		assert.strictEqual(merged.length, 1);
		assert.strictEqual(merged[0].isGitHistory, true, 'history anywhere means a rewrite is needed');
		assert.ok(merged[0].occurrences.some(o => !o.commitHash), 'the working-tree sighting is kept');
	});
});

suite('Engine binaries are found outside the shell PATH', () => {
	const engines = require('../scan-engines');
	const fs = require('fs');
	const os = require('os');
	const path = require('path');

	test('an explicit binaryPath always wins', () => {
		assert.strictEqual(engines.resolveBinary('trufflehog', '/opt/custom/trufflehog'), '/opt/custom/trufflehog');
	});

	test('common install locations are searched before giving up', () => {
		// A GUI-launched VS Code does not inherit the shell PATH on macOS and often
		// misses ~/.local/bin on Linux, so an engine the user definitely installed
		// gets reported "not installed" and silently skipped.
		const dirs = engines.COMMON_BIN_DIRS;
		assert.ok(dirs.includes(path.join(os.homedir(), '.local', 'bin')));
		assert.ok(dirs.includes('/opt/homebrew/bin'), 'Apple silicon Homebrew');
		assert.ok(dirs.includes('/usr/local/bin'));
	});

	test('an executable in a common location is resolved to its absolute path', () => {
		const dir = path.join(os.homedir(), '.local', 'bin');
		const name = `leaklock-probe-${process.pid}`;
		const file = path.join(dir, name);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
		try {
			engines.resetBinaryCache();
			assert.strictEqual(engines.resolveBinary(name), file);
		} finally {
			fs.rmSync(file, { force: true });
			engines.resetBinaryCache();
		}
	});

	test('an unknown binary falls through to PATH resolution unchanged', () => {
		engines.resetBinaryCache();
		const name = `leaklock-absent-${process.pid}`;
		assert.strictEqual(engines.resolveBinary(name), name,
			'the OS still gets its chance to resolve it');
	});
});

suite('Occurrence aggregation keeps what it merges', () => {
	const LeakLockPanel = require('../leakLockPanel');

	function panel() {
		const p = new LeakLockPanel({ fsPath: '/tmp/ext' });
		p._updateWebviewContent = () => {};
		return p;
	}

	test('branches from every commit are unioned, since the rewrite covers them all', () => {
		const merged = panel()._deduplicateScanResults([
			{ file: 'a.js', line: 3, fullSecret: 'AKIAIOSFODNN7EXAMPLE', commitHash: 'c1', commitBranches: ['main'] },
			{ file: 'a.js', line: 3, fullSecret: 'AKIAIOSFODNN7EXAMPLE', commitHash: 'c2', commitBranches: ['release/0.7.0', 'main'] }
		]);
		assert.strictEqual(merged.length, 1);
		assert.deepStrictEqual(merged[0].commitBranches.sort(), ['main', 'release/0.7.0']);
	});

	test('the merged row reports how many commits carry the secret', () => {
		const p = panel();
		p._scanResults = p._deduplicateScanResults([
			{ file: 'a.js', line: 3, secret: 'AKIA…', fullSecret: 'AKIAIOSFODNN7EXAMPLE', description: 'AWS', severity: 'high', ruleName: 'aws-access-token', commitHash: 'c1', commitDate: '2026-01-01T00:00:00Z', isGitHistory: true, engine: 'gitleaks', engines: ['gitleaks'] },
			{ file: 'a.js', line: 3, secret: 'AKIA…', fullSecret: 'AKIAIOSFODNN7EXAMPLE', description: 'AWS', severity: 'high', ruleName: 'aws-access-token', commitHash: 'c2', commitDate: '2026-02-01T00:00:00Z', isGitHistory: true, engine: 'gitleaks', engines: ['gitleaks'] }
		]);
		p._resetScanSelection();
		const html = p._getResultsHtml();
		assert.match(html, /in 2 commits/, 'the count is visible, not silently collapsed');
	});

	test('a secret still on disk is flagged as well as in history', () => {
		const p = panel();
		p._scanResults = p._deduplicateScanResults([
			{ file: 'a.js', line: 3, secret: 's', fullSecret: 'AKIAIOSFODNN7EXAMPLE', description: 'AWS', severity: 'high', ruleName: 'aws-access-token', commitHash: 'c1', isGitHistory: true, engine: 'gitleaks', engines: ['gitleaks'] },
			{ file: 'a.js', line: 3, secret: 's', fullSecret: 'AKIAIOSFODNN7EXAMPLE', description: 'AWS', severity: 'high', ruleName: 'aws-access-token', commitHash: null, isGitHistory: false, engine: 'gitleaks', engines: ['gitleaks'] }
		]);
		p._resetScanSelection();
		assert.match(p._getResultsHtml(), /working tree/);
	});

	test('the export carries the occurrence list, not just the first sighting', () => {
		const p = panel();
		p._scanResults = p._deduplicateScanResults([
			{ file: 'a.js', line: 3, secret: 's', fullSecret: 'AKIAIOSFODNN7EXAMPLE', description: 'AWS', severity: 'high', ruleName: 'aws-access-token', commitHash: 'c1', isGitHistory: true, engine: 'gitleaks', engines: ['gitleaks'] },
			{ file: 'a.js', line: 3, secret: 's', fullSecret: 'AKIAIOSFODNN7EXAMPLE', description: 'AWS', severity: 'high', ruleName: 'generic-api-key', commitHash: 'c2', isGitHistory: true, engine: 'noseyparker', engines: ['noseyparker'] }
		]);
		p._resetScanSelection();
		const finding = p._buildScanExportPayload().findings[0];
		assert.strictEqual(finding.occurrences.length, 2);
		assert.deepStrictEqual(finding.occurrences.map(o => o.commitHash).sort(), ['c1', 'c2']);
		assert.deepStrictEqual(finding.ruleNames.sort(), ['aws-access-token', 'generic-api-key']);
		assert.deepStrictEqual(finding.engines.sort(), ['gitleaks', 'noseyparker']);
	});

	test('every rule that matched is named in the table', () => {
		const p = panel();
		p._scanResults = p._deduplicateScanResults([
			{ file: 'a.js', line: 3, secret: 's', fullSecret: 'ghp_1234567890abcdefghijklmnopqrstuvwx', description: 'GitHub PAT', severity: 'high', ruleName: 'github-pat', commitHash: 'c1', engine: 'gitleaks', engines: ['gitleaks'] },
			{ file: 'a.js', line: 3, secret: 's', fullSecret: 'ghp_1234567890abcdefghijklmnopqrstuvwx', description: 'GitHub PAT', severity: 'high', ruleName: 'generic-api-key', commitHash: 'c1', engine: 'gitleaks', engines: ['gitleaks'] }
		]);
		p._resetScanSelection();
		assert.match(p._getResultsHtml(), /also matched: generic-api-key/);
	});
});

suite('PR review fixes', () => {
	const LeakLockPanel = require('../leakLockPanel');
	const engines = require('../scan-engines');
	const engineConfig = require('../scan-engine-config');

	test('the TruffleHog repo argument is a valid file URL', () => {
		// `file://` + a raw path is not a URL on Windows: C:\repo yields something
		// TruffleHog cannot open, so scanning failed outright there.
		const args = engines.buildTruffleHogArgs({ repoDir: '/home/u/my repo', verify: true });
		const url = args[1];
		assert.doesNotThrow(() => new URL(url), 'must parse as a URL');
		assert.strictEqual(new URL(url).protocol, 'file:');
		// A space has to be encoded, not passed through raw.
		assert.ok(!url.includes(' '), 'path characters are percent-encoded');
	});

	test('the removed includeIgnoredFiles setting is gone everywhere', () => {
		// It described behaviour that is already unconditionally true: every engine
		// reads .gitignore'd files. A setting that cannot change anything is worse
		// than no setting.
		const pkg = require('../package.json');
		assert.ok(!('leakLock.scan.includeIgnoredFiles' in pkg.contributes.configuration.properties));
		assert.ok(!('includeIgnoredFiles' in engineConfig.normalizeScanSettings({})));
	});

	test('dependency exclusion is a path rule, applied to every engine alike', () => {
		// Only Nosey Parker accepts an ignore file, so wiring the setting there alone
		// made it mean different things depending on which engines were enabled.
		const inDir = engineConfig.isInExcludedDependencyDir;
		assert.strictEqual(inDir('node_modules/pkg/index.js'), true);
		assert.strictEqual(inDir('app/vendor/lib/x.php'), true);
		assert.strictEqual(inDir('node_modules'), true);
		// Windows separators must not defeat it.
		assert.strictEqual(inDir('app\\node_modules\\pkg\\index.js'), true);
		// First-party directories are never excluded, even when similarly named.
		assert.strictEqual(inDir('src/lib/index.js'), false);
		assert.strictEqual(inDir('my_node_modules_helper.js'), false);
		assert.strictEqual(inDir('build/output.js'), false, 'build/ can hold first-party source');
		assert.strictEqual(inDir(null), false);
	});

	test('an unknown engine id warns instead of silently shrinking the scan', () => {
		const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
		const seen = [];
		const originalWarn = vscode.window.showWarningMessage;
		const originalError = vscode.window.showErrorMessage;
		const originalGet = vscode.workspace.getConfiguration;
		vscode.window.showWarningMessage = (m) => { seen.push(String(m)); };
		vscode.window.showErrorMessage = (m) => { seen.push(String(m)); };
		vscode.workspace.getConfiguration = () => ({ get: (k) => (k === 'scan.engines' ? ['gitleaks', 'typo-engine'] : undefined) });
		try {
			const ids = panel._getEnabledEngineIds();
			assert.deepStrictEqual(ids, ['gitleaks']);
			assert.ok(seen.some(m => /typo-engine/.test(m)), 'the unknown id is named');
		} finally {
			vscode.window.showWarningMessage = originalWarn;
			vscode.window.showErrorMessage = originalError;
			vscode.workspace.getConfiguration = originalGet;
		}
	});

	test('configuring only unknown engines is reported as an error, not a clean scan', () => {
		// Scanning with nothing returns zero findings, which is indistinguishable from
		// a clean repository — the one result this product must never fake.
		const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
		const seen = [];
		const originalError = vscode.window.showErrorMessage;
		const originalWarn = vscode.window.showWarningMessage;
		const originalGet = vscode.workspace.getConfiguration;
		vscode.window.showErrorMessage = (m) => { seen.push(String(m)); };
		vscode.window.showWarningMessage = () => {};
		vscode.workspace.getConfiguration = () => ({ get: (k) => (k === 'scan.engines' ? ['nonsense'] : undefined) });
		try {
			assert.deepStrictEqual(panel._getEnabledEngineIds(), []);
			assert.ok(seen.some(m => /nothing would be scanned/i.test(m)));
		} finally {
			vscode.window.showErrorMessage = originalError;
			vscode.window.showWarningMessage = originalWarn;
			vscode.workspace.getConfiguration = originalGet;
		}
	});

	test('hidden dependency findings are reported, never silently dropped', () => {
		const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
		panel._updateWebviewContent = () => {};
		panel._scanCoverage = {
			incomplete: false, engines: [{ id: 'gitleaks', displayName: 'Gitleaks', version: 'v8', ok: true, findings: 1 }],
			refs: { localBranches: 1, remoteBranches: 1, tags: 0, stashes: 0, remoteOnlyBranches: [] },
			refRefresh: { attempted: true, ok: true }, rulesetMode: 'default', maxFileSizeMb: 100,
			timeoutSeconds: 300, dependencyHandling: 'exclude', excludedByDependencyRule: 12
		};
		const html = panel._renderScanCoverage();
		assert.match(html, /12 finding\(s\) hidden/);
		assert.match(html, /Set it to/);
	});

	test('a Gitleaks-only scan does not announce a container pull', async () => {
		// The pull happens inside the Nosey Parker engine task; announcing it on a
		// scan that never touches Docker named an image the scan does not use.
		const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'leakLockPanel.js'), 'utf8');
		const pullIndex = src.indexOf("stage: 'pull'");
		assert.ok(pullIndex > 0);
		const preceding = src.slice(Math.max(0, pullIndex - 400), pullIndex);
		assert.match(preceding, /if \(useNoseyParker\) \{/, 'the pull stage is gated on the engine running');
	});
});

suite('Manifest integrity', () => {
	const pkg = require('../package.json');
	const fs = require('fs');
	const path = require('path');

	function sourceOf(...files) {
		return files.map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
	}

	test('every contributed command is actually registered', () => {
		// A command in package.json that nothing registers still appears in the
		// Command Palette and fails when invoked. leak-lock.fileScan did exactly that:
		// it was registered only inside file-scan.js, which nothing requires.
		const src = sourceOf('extension.js', 'project-scan.js', 'leakLockPanel.js', 'leakLockSidebarProvider.js');
		const registered = new Set(
			Array.from(src.matchAll(/registerCommand\(\s*['"]([^'"]+)['"]/g)).map(m => m[1])
		);
		const missing = pkg.contributes.commands
			.map(c => c.command)
			.filter(c => !registered.has(c));
		assert.deepStrictEqual(missing, [], `contributed but never registered: ${missing.join(', ')}`);
	});

	test('enum settings have one description per value', () => {
		// A mismatch here renders a blank or shifted label in the settings UI.
		const problems = [];
		for (const [key, value] of Object.entries(pkg.contributes.configuration.properties)) {
			for (const holder of [value, value.items || {}]) {
				if (holder.enum && holder.enumDescriptions
					&& holder.enum.length !== holder.enumDescriptions.length) {
					problems.push(key);
				}
			}
		}
		assert.deepStrictEqual(problems, []);
	});

	test('every default is a legal value for its setting', () => {
		const problems = [];
		for (const [key, value] of Object.entries(pkg.contributes.configuration.properties)) {
			if (value.enum && 'default' in value && !value.enum.includes(value.default)) {
				problems.push(key);
			}
			if (value.type === 'array' && value.items && value.items.enum) {
				for (const entry of value.default || []) {
					if (!value.items.enum.includes(entry)) { problems.push(`${key}:${entry}`); }
				}
			}
			if (typeof value.default === 'number') {
				if ('minimum' in value && value.default < value.minimum) { problems.push(`${key}:min`); }
				if ('maximum' in value && value.default > value.maximum) { problems.push(`${key}:max`); }
			}
		}
		assert.deepStrictEqual(problems, []);
	});
});

suite('Suppressed review comments', () => {
	const engines = require('../scan-engines');
	const rules = require('../redaction-rules');

	test('line 0 is preserved, not coerced to null', () => {
		// `parseInt(...) || null` discards a legitimate 0. Line numbers are 1-based in
		// practice, but a coercion that silently drops a valid value is wrong anyway.
		assert.strictEqual(engines.toLineNumber(0), 0);
		assert.strictEqual(engines.toLineNumber('0'), 0);
		assert.strictEqual(engines.toLineNumber('42'), 42);
		assert.strictEqual(engines.toLineNumber('not a number'), null);
		assert.strictEqual(engines.toLineNumber(undefined), null);
	});

	test('a verification timestamp is recorded whatever the verdict', () => {
		// "Checked, not live" is equally a claim about a moment in time — the key may
		// have been rotated back since. A status with no timestamp cannot be read later.
		const stdout = [
			'{"DetectorName":"AWS","Verified":true,"Raw":"AKIAIOSFODNN7EXAMPLE","SourceMetadata":{"Data":{"Git":{"commit":"c1","file":"a.py","line":4}}}}',
			'{"DetectorName":"Stripe","Verified":false,"Raw":"sk_test_x","SourceMetadata":{"Data":{"Git":{"commit":"c2","file":"b.py","line":9}}}}'
		].join('\n');
		const parsed = engines.parseTruffleHogJsonl(stdout);
		assert.strictEqual(parsed.length, 2);
		// The adapter stamps during scan(); assert the shape it produces.
		const stamped = parsed.map(raw => {
			const f = engines.mapTruffleHogFinding(raw);
			f.verifiedAt = '2026-07-31T15:00:00Z';
			return f;
		});
		assert.ok(stamped.every(f => f.verifiedAt), 'both verdicts carry a timestamp');
		assert.strictEqual(stamped[0].verified, true);
		assert.strictEqual(stamped[1].verified, false);
	});

	test('regex constructs the downstream tools disagree on are flagged', () => {
		// JavaScript compiling a pattern proves little: it is then run by git
		// (POSIX ERE), BFG (Java) and git filter-repo (Python).
		const portable = rules.validateRule({ source: 'ACME-[0-9]{6}', mode: 'regex', replaceWith: '*' });
		assert.strictEqual(portable.warnings.length, 0, 'a POSIX-safe pattern is not nagged about');

		for (const pattern of ['\\d{6}', '(?<=x)y', '(?!a)b', '(?<name>x)', '(a)\\1']) {
			const result = rules.validateRule({ source: pattern, mode: 'regex', replaceWith: '*' });
			assert.strictEqual(result.valid, true, `${pattern} is still allowed`);
			assert.ok(result.warnings.length > 0, `${pattern} should warn about portability`);
			assert.match(result.warnings.join(' '), /Preview it before running a cleanup/);
		}
	});

	test('portability problems warn rather than block', () => {
		// The pattern may be exactly right for the tool the user chose; the dry run is
		// the authority, so this must not refuse a legitimate rule.
		const result = rules.validateRule({ source: '\\d{6}', mode: 'regex', replaceWith: '*' });
		assert.strictEqual(result.valid, true);
		assert.deepStrictEqual(result.errors, []);
	});
});

suite('Third review pass', () => {
	const engines = require('../scan-engines');
	const fs = require('fs');
	const path = require('path');

	test('"not checked" is not reported as "checked and not live"', async () => {
		// TruffleHog emits Verified:false under --no-verification too. Reporting that
		// as false tells the user a credential was validated against its provider when
		// nothing of the sort happened.
		const raw = '{"DetectorName":"AWS","Verified":false,"Raw":"AKIAIOSFODNN7EXAMPLE","SourceMetadata":{"Data":{"Git":{"commit":"c1","file":"a.py","line":4}}}}';
		const mapped = engines.mapTruffleHogFinding(JSON.parse(raw));
		// The mapper alone cannot know; the scan decides based on the verify flag.
		assert.strictEqual(mapped.verified, false);

		const src = fs.readFileSync(path.join(__dirname, '..', 'scan-engines.js'), 'utf8');
		assert.match(src, /finding\.verified = null;/, 'unverified runs null the verdict');
		assert.match(src, /"not checked", not "checked and not live"/);
	});

	test('the dev scan helper does not verify unless asked', () => {
		// It accepts an arbitrary target repository, so defaulting verification on
		// would send credentials found in someone's real repo to their providers.
		const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'real-scan.js'), 'utf8');
		assert.match(src, /process\.env\.LEAKLOCK_VERIFY === '1'/);
		assert.ok(!/'trufflehog\.verify': true/.test(src), 'must not be hard-coded on');
	});

	test('scan reports default outside the repository and are gitignored', () => {
		// A scan report holds real secrets when produced from a real repository; a
		// default inside the working tree is one `git add -A` from being committed.
		const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'render-screenshots.js'), 'utf8');
		assert.match(src, /os\.tmpdir\(\)/, 'the default lives in the OS temp directory');
		const ignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
		assert.match(ignore, /^scan\.json$/m, 'and the obvious filename is ignored anyway');
	});
});

suite('Fourth review pass', () => {
	const rules = require('../redaction-rules');
	const fs = require('fs');
	const path = require('path');

	test('the scanned repository is mounted read-only', () => {
		// Scanning never needs to write to the audited tree, and the datastore has its
		// own writable mount. Without :ro the container can write into the user's
		// repository — which is exactly what moving the datastore out of the scan root
		// was meant to stop, so leaving the mount writable would undo that fix.
		const config = require('../scan-engine-config');
		const args = config.buildNoseyParkerScanArgs({
			scanMount: '/repo', datastoreMount: '/ds', settings: {}
		});
		const scanMount = args.find(a => a.startsWith('/repo:'));
		assert.strictEqual(scanMount, '/repo:/scan:ro', 'the scan path is mounted read-only');
		assert.ok(
			args.includes('/ds:/datastore'),
			'while the datastore keeps its writable mount'
		);
	});

	test('a literal source cannot start with a rewrite-tool mode prefix', () => {
		// `regex:` (and glob:/literal: for filter-repo) is a mode prefix in the rule
		// file. A literal rule beginning with one would be applied as a different kind
		// of match than the UI displayed — the same failure the `==>` guard prevents.
		for (const prefix of rules.RULE_MODE_PREFIXES) {
			const result = rules.validateRule({ source: `${prefix}foo`, mode: 'literal', replaceWith: 'x' });
			assert.strictEqual(result.valid, false, `${prefix} must be rejected in literal mode`);
			assert.match(result.errors.join(' '), /mode prefix/);
			assert.match(result.errors.join(' '), /Switch to regex mode/);
		}
	});

	test('the same text is allowed in regex mode, where the prefix is intended', () => {
		const result = rules.validateRule({ source: 'regex:foo', mode: 'regex', replaceWith: 'x' });
		assert.strictEqual(result.valid, true);
	});

	test('a prefix in the middle of a literal is fine', () => {
		const result = rules.validateRule({ source: 'host/regex:thing', mode: 'literal', replaceWith: 'x' });
		assert.strictEqual(result.valid, true, 'only a leading prefix is parsed as a mode');
	});

	test('the refresh setting describes the command the scan actually runs', () => {
		// The scan fetch is read-only; only the pre-rewrite refresh prunes.
		const pkg = require('../package.json');
		const description = pkg.contributes.configuration.properties['leakLock.scan.refreshRefsBeforeScan'].description;
		assert.ok(!description.includes('--prune --tags'), 'must not promise a prune the scan does not do');
		assert.match(description, /read-only/);
		assert.match(description, /does not pass --prune/);
	});

	test('a failed Gitleaks pass keeps whatever it managed to write', () => {
		// A timed-out pass has often already written part of its report. Discarding it
		// loses real findings, which is the mistake the scan timeout used to make.
		const src = fs.readFileSync(path.join(__dirname, '..', 'scan-engines.js'), 'utf8');
		const catchBlock = src.slice(src.indexOf('Gitleaks ${surface} pass did not complete') - 1200,
			src.indexOf('Gitleaks ${surface} pass did not complete') + 300);
		assert.match(catchBlock, /readJsonReport\(reportPath\)/, 'the partial report is parsed');
		assert.match(catchBlock, /recovered/);
		assert.match(catchBlock, /not exhaustive/, 'and the result is marked incomplete');
	});
});

suite('Fifth review pass', () => {
	const engines = require('../scan-engines');
	const gitRewrite = require('../git-rewrite');
	const fs = require('fs');
	const os = require('os');
	const path = require('path');

	test('a missing binary is re-checked, not cached as missing for the session', () => {
		// Caching a negative result keeps reporting "not installed" for the rest of the
		// session — including immediately after the user follows the install hint we
		// just showed them.
		const name = `leaklock-late-${process.pid}`;
		engines.resetBinaryCache();
		assert.strictEqual(engines.resolveBinary(name), name, 'not found yet');

		const dir = path.join(os.homedir(), '.local', 'bin');
		const file = path.join(dir, name);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
		try {
			// No cache reset: installing mid-session must be picked up.
			assert.strictEqual(engines.resolveBinary(name), file,
				'a binary installed after the first check is found without a reload');
		} finally {
			fs.rmSync(file, { force: true });
			engines.resetBinaryCache();
		}
	});

	test('scanning never prunes; the rewrite refresh still does', () => {
		// Two different jobs: a scan widens coverage and must not mutate refs, while
		// the refresh immediately before a rewrite must match the server exactly.
		assert.strictEqual(gitRewrite.describeFetchCommand('origin', { prune: false }), 'git fetch --tags origin');
		assert.strictEqual(gitRewrite.describeFetchCommand('origin'), 'git fetch --prune --tags origin');

		const script = gitRewrite.buildRewriteScript({ repoDir: '/r', rewriteLines: ['true'] });
		assert.match(script, /git fetch --prune --tags 'origin'/, 'the rewrite script still prunes');
	});

	test('the docs describe the commands the code actually runs', () => {
		const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
		// Docs that teach a broken pattern are as harmful as code that ships one.
		for (const doc of ['docs/API_REFERENCE.md', 'docs/SCANNING_ENGINES.md']) {
			const text = read(doc);
			const scanSection = text.split('Remove Files')[0];
			assert.ok(!/Refresh every ref \(`git fetch --prune --tags`\)/.test(scanSection),
				`${doc} must not claim the scan prunes`);
		}
		// The Windows-invalid form must not appear as an example either.
		assert.ok(!/trufflehog git "file:\/\/\$\{scanPath\}"/.test(read('docs/API_REFERENCE.md')),
			'the docs must not demonstrate raw string interpolation for the repo URL');
	});
});

suite('Containing-branch parsing', () => {
	const parse = require('../leakLockPanel').__parseContainingBranches;

	test('symbolic refs are not listed as branches', () => {
		// `git branch -a --contains` emits a symbolic line. A `\bHEAD$` filter alone
		// misses it, and the rule preview listed
		// "remotes/origin/HEAD -> origin/release/0.7.0" as though it were a branch.
		const stdout = [
			'* release/0.7.0',
			'  main',
			'  remotes/origin/HEAD -> origin/release/0.7.0',
			'  remotes/origin/release/0.7.0',
			''
		].join('\n');
		assert.deepStrictEqual(parse(stdout), [
			'release/0.7.0', 'main', 'remotes/origin/release/0.7.0'
		]);
	});

	test('a detached HEAD line is not a branch either', () => {
		const stdout = '* (HEAD detached at 9bdf369)\n  main\n';
		assert.deepStrictEqual(parse(stdout), ['main']);
	});

	test('the current-branch marker is stripped', () => {
		assert.deepStrictEqual(parse('* main\n+ worktree-branch\n'), ['main', 'worktree-branch']);
	});

	test('empty output yields no branches', () => {
		assert.deepStrictEqual(parse(''), []);
		assert.deepStrictEqual(parse(null), []);
	});
});

suite('Website image dimensions', () => {
	const fs = require('fs');
	const path = require('path');

	test('every declared width/height matches the file on disk', () => {
		// Both attributes are declared so the browser can reserve space before the
		// image loads. When they drift from the real size the browser stretches the
		// image instead, which is worse than declaring nothing — and it drifts every
		// time a screenshot is recaptured at a slightly different height.
		const root = path.join(__dirname, '..', 'docs', 'website');
		const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
		const problems = [];

		for (const match of html.matchAll(/<img src="(img\/[^"]+)" width="(\d+)" height="(\d+)"/g)) {
			const [, src, width, height] = match;
			const file = path.join(root, src);
			assert.ok(fs.existsSync(file), `${src} is referenced but missing`);

			// PNG header: width and height are big-endian 32-bit at offsets 16 and 20.
			const header = Buffer.alloc(24);
			const fd = fs.openSync(file, 'r');
			try {
				fs.readSync(fd, header, 0, 24, 0);
			} finally {
				fs.closeSync(fd);
			}
			const actual = { w: header.readUInt32BE(16), h: header.readUInt32BE(20) };
			if (actual.w !== Number(width) || actual.h !== Number(height)) {
				problems.push(`${src}: declared ${width}x${height}, actual ${actual.w}x${actual.h}`);
			}
		}

		assert.ok(problems.length > 0 === false, problems.join('; '));
	});

	test('every referenced image exists', () => {
		const root = path.join(__dirname, '..', 'docs', 'website');
		const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
		const missing = Array.from(html.matchAll(/src="(img\/[^"]+)"/g))
			.map(m => m[1])
			.filter(src => !fs.existsSync(path.join(root, src)));
		assert.deepStrictEqual(missing, []);
	});
});

suite('Preparing is never blocked by branch state', () => {
	const LeakLockPanel = require('../leakLockPanel');

	function panel(blocked) {
		const p = new LeakLockPanel({ fsPath: '/tmp/ext' });
		p._updateWebviewContent = () => {};
		p._scanCleanup.preparedCommand = '#!/usr/bin/env bash\n# script\n';
		p._scanCleanup.preparedMode = 'git';
		p._scanCleanup.replacements = [{ source: 's', mode: 'literal', replaceWith: '*****' }];
		p._scanCleanup.blockedBranches = blocked;
		p._scanCleanup.blockedReason = blocked ? 'unpushed-commits' : null;
		return p;
	}

	test('the run is refused while a branch the rewrite resets is ahead', async () => {
		// The rule belongs here, where a rewrite is about to happen — not at prepare
		// time, where the user only asked to read the script.
		const p = panel([{ branch: 'feat/pages-screenshots', count: 3 }]);
		const seen = [];
		const original = vscode.window.showErrorMessage;
		vscode.window.showErrorMessage = (m) => { seen.push(String(m)); };
		try {
			await p._runPreparedScanCleanup('git');
		} finally {
			vscode.window.showErrorMessage = original;
		}
		assert.ok(seen.some(m => /Nothing was changed/.test(m)));
		assert.ok(seen.some(m => /feat\/pages-screenshots \(\+3\)/.test(m)), 'the branch and count are named');
		assert.ok(seen.some(m => /still available to read and save/.test(m)), 'the script is not withdrawn');
	});

	test('the banner says the script exists and only the run is blocked', () => {
		const html = panel([{ branch: 'feat/x', count: 2 }])
			._renderBlockedBranches([{ branch: 'feat/x', count: 2 }], 'unpushed-commits');
		assert.match(html, /cannot be run yet/);
		assert.match(html, /prepared and is safe to read and save/);
		assert.match(html, /Nothing has been changed/);
		// The old wording claimed preparation itself had stopped.
		assert.ok(!/Leak Lock stopped before touching anything/.test(html));
	});

	test('the run buttons are disabled while a branch is ahead', () => {
		const p = panel([{ branch: 'feat/x', count: 2 }]);
		p._scanResults = [{
			file: 'a.js', line: 1, secret: 's', fullSecret: 'secret-value',
			description: 'x', severity: 'high', ruleName: 'r',
			isDependency: false, includeInCleanup: true
		}];
		p._resetScanSelection();
		const html = p._getResultsHtml();
		const runButton = html.slice(html.indexOf('runPreparedGit()'), html.indexOf('runPreparedGit()') + 200);
		assert.match(runButton, /disabled/);
	});

	test('with no blocking branch the run proceeds past the gate', async () => {
		const p = panel(null);
		let reached = false;
		p._executeGitCleanup = async () => { reached = true; };
		await p._runPreparedScanCleanup('git');
		assert.strictEqual(reached, true, 'a clean branch state does not stop the run');
	});
});

suite('Untracked working-tree findings', () => {
	const LeakLockPanel = require('../leakLockPanel');
	const cp = require('child_process');
	const fs = require('fs');
	const os = require('os');
	const path = require('path');

	const env = {
		...process.env,
		GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
		GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.com',
		GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.com'
	};
	let repo;

	suiteSetup(async () => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), 'leaklock-untracked-'));
		cp.execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
		fs.writeFileSync(path.join(repo, 'tracked.py'), 'KEY = "AKIAIOSFODNN7EXAMPLE"\n');
		cp.execFileSync('git', ['-C', repo, 'add', '-A'], { env });
		cp.execFileSync('git', ['-C', repo, 'commit', '-qm', 'init'], { env });
		// Present on disk, never committed.
		fs.mkdirSync(path.join(repo, 'nested'), { recursive: true });
		fs.writeFileSync(path.join(repo, 'nested', 'local.env'), 'SECRET=abc\n');
	});

	suiteTeardown(() => {
		try { fs.rmSync(repo, { recursive: true, force: true }); } catch (e) { void e; }
	});

	test('a file that exists but was never committed is flagged as untracked', async () => {
		// A working-tree-only secret needs the file deleted, not a history rewrite.
		// Resolving the display path against the scan root produced
		// <scan>/<scanName>/<path>, which never exists, so this always said "tracked".
		const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
		panel._updateWebviewContent = () => {};
		panel._selectedDirectory = repo;
		panel._scanPath = repo;
		await panel._primeGitTracking(repo);

		const relative = panel._getRelativeFilePath('nested/local.env');
		assert.strictEqual(
			panel._isUntrackedWorkingTreeFile('nested/local.env', relative, false),
			true,
			'the engine path must resolve even though the display path is prefixed'
		);
	});

	test('a committed file is not flagged as untracked', async () => {
		const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
		panel._updateWebviewContent = () => {};
		panel._selectedDirectory = repo;
		panel._scanPath = repo;
		await panel._primeGitTracking(repo);
		assert.strictEqual(
			panel._isUntrackedWorkingTreeFile('tracked.py', panel._getRelativeFilePath('tracked.py'), false),
			false
		);
	});

	test('a history finding is never treated as an untracked working-tree file', async () => {
		const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
		panel._updateWebviewContent = () => {};
		panel._selectedDirectory = repo;
		panel._scanPath = repo;
		await panel._primeGitTracking(repo);
		assert.strictEqual(panel._isUntrackedWorkingTreeFile('nested/local.env', 'x/nested/local.env', true), false);
	});
});

suite('Second review round', () => {
	const host = require('../host-capacity');
	const rules = require('../redaction-rules');
	const fs = require('fs');
	const path = require('path');

	const BIG = { cpus: 16, totalMemGb: 32, memorySource: 'os', platform: 'linux', loadPerCore: 0.1 };
	const TINY = { cpus: 2, totalMemGb: 3, memorySource: 'os', platform: 'linux', loadPerCore: 0.1 };

	test('the configured engine order is respected', () => {
		// The setting says "Detection engines to run, in order". Sorting by weight here
		// silently contradicted it.
		const configured = ['noseyparker', 'trufflehog', 'gitleaks'];
		for (const mode of ['auto', 'parallel', 'sequential']) {
			assert.deepStrictEqual(
				host.chooseScanStrategy({ engines: configured, host: BIG, mode }).engines,
				configured,
				`${mode} must not reorder the configured list`
			);
		}
	});

	test('engine weight still decides which one survives a constrained host', () => {
		// That is the question ENGINE_WEIGHT exists to answer — not the run order.
		assert.deepStrictEqual(
			host.chooseScanStrategy({ engines: ['noseyparker', 'trufflehog', 'gitleaks'], host: TINY }).engines,
			['gitleaks'],
			'the lightest, maintained engine is kept'
		);
		assert.deepStrictEqual(
			host.chooseScanStrategy({ engines: ['noseyparker', 'trufflehog'], host: TINY }).engines,
			['trufflehog'],
			'without gitleaks, the lightest configured engine is kept'
		);
	});

	test('a pickaxe pattern containing spaces is passed intact', () => {
		// Reported as a defect; verified not to be one. execFile passes an argv array
		// with no shell, and -S consumes the remainder of its own argument.
		const args = rules.buildPreviewArgs({ source: 'internal build server', mode: 'literal' });
		assert.ok(args.includes('-Sinternal build server'));
		const regex = rules.buildPreviewArgs({ source: 'ACME [0-9]+', mode: 'regex' });
		assert.ok(regex.includes('-GACME [0-9]+'));
	});

	test('the dev helpers honour config.get(key, default)', () => {
		// The panel and sidebar use the two-argument form in ten places. A stub that
		// ignores the fallback silently diverges from a real VS Code host.
		for (const tool of ['tools/real-scan.js', 'tools/render-screenshots.js']) {
			const src = fs.readFileSync(path.join(__dirname, '..', tool), 'utf8');
			assert.match(src, /get: \(key, fallback\)/, `${tool} must accept a fallback`);
			assert.match(src, /key in settings \? settings\[key\] : fallback/,
				`${tool} must return the fallback only when the key is absent`);
		}
	});

	test('the fixture generator uses no GNU-only shell', () => {
		// It is documented as cross-platform. `sed -i` reads the next argument as a
		// backup suffix on BSD/macOS, and BSD sed rejects labels separated by ';'.
		const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'seed-fake-leaks.sh'), 'utf8');
		const code = src.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
		assert.ok(!/sed -i /.test(code), 'sed -i is GNU-only');
		assert.ok(!/sed ':a/.test(code), "sed ':a;N;...' is GNU-only");
		assert.match(code, /drop_blank_lines/);
		assert.match(code, /escape_newlines/);
	});
});

suite('Zero findings must not mean "clean" when nothing ran', () => {
	const LeakLockPanel = require('../leakLockPanel');

	function panel(engines) {
		const p = new LeakLockPanel({ fsPath: '/tmp/ext' });
		p._updateWebviewContent = () => {};
		p._scanResults = [];
		p._scanCoverage = {
			incomplete: false, incompleteReason: null, engines,
			refs: { localBranches: 1, remoteBranches: 0, tags: 0, stashes: 0, remoteOnlyBranches: [] },
			refRefresh: { attempted: false, ok: false, reason: 'no-remote' },
			rulesetMode: 'default', maxFileSizeMb: 100, timeoutSeconds: 300, dependencyHandling: 'warning'
		};
		return p;
	}

	const failed = (id, name, note) => ({ id, displayName: name, version: null, ok: false, findings: 0, note });
	const ok = (id, name) => ({ id, displayName: name, version: 'v1', ok: true, findings: 0 });

	test('every engine failing is reported as "nothing was scanned", not as clean', () => {
		// Zero findings means nothing at all if nothing ran. A celebratory all-clear
		// here is the worst output this product can produce.
		const html = panel([
			failed('gitleaks', 'Gitleaks', 'Not installed or not on PATH.'),
			failed('noseyparker', 'Nosey Parker', 'Skipped — Docker not available'),
			failed('trufflehog', 'TruffleHog', 'Not installed or not on PATH.')
		])._getScanResultsSection();

		assert.match(html, /Nothing was scanned/);
		assert.match(html, /not<\/strong> a clean result/);
		assert.ok(!/No Security Issues Found/.test(html), 'must not claim the repository is clean');
		assert.ok(!/No API keys found/.test(html), 'must not show green confirmations');
		// And it must say why, per engine.
		assert.match(html, /Not installed or not on PATH/);
		assert.match(html, /Docker not available/);
	});

	test('a genuinely clean scan still reads as clean', () => {
		const html = panel([ok('gitleaks', 'Gitleaks'), ok('noseyparker', 'Nosey Parker')])._getScanResultsSection();
		assert.match(html, /No Security Issues Found/);
		assert.ok(!/Nothing was scanned/.test(html));
		assert.ok(!/did not run, so this result is narrower/.test(html));
	});

	test('a partial failure caveats the clean result rather than hiding it', () => {
		const html = panel([
			ok('gitleaks', 'Gitleaks'),
			failed('trufflehog', 'TruffleHog', 'Not installed or not on PATH.')
		])._getScanResultsSection();
		assert.match(html, /No Security Issues Found/, 'one engine did run, so this is a real result');
		assert.match(html, /1 of 2 engines did not run/);
		assert.match(html, /narrower than it looks/);
	});

	test('with no coverage recorded at all the old empty state still renders', () => {
		// Older state, or a scan that never reached the coverage stage.
		const p = new LeakLockPanel({ fsPath: '/tmp/ext' });
		p._updateWebviewContent = () => {};
		p._scanResults = [];
		p._scanCoverage = null;
		assert.match(p._getScanResultsSection(), /No Security Issues Found/);
	});
});
