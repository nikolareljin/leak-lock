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

	test('pushes atomically and never with a bare --force --all', () => {
		const out = script();
		assert.ok(out.includes('git push --force --atomic --all'), 'branches pushed atomically');
		assert.ok(out.includes('git push --force --atomic --tags'), 'tags pushed atomically');
		// Comment lines quote the old broken command on purpose - only check code.
		const code = out.split('\n').filter(line => !line.trim().startsWith('#'));
		const nonAtomic = code.filter(line => /git push --force --(all|tags)\b/.test(line));
		assert.deepStrictEqual(nonAtomic, [], 'every push must go through --atomic');
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

	test('verifies every remote ref after pushing', () => {
		const out = script();
		const verifyIndex = out.indexOf('git ls-tree -r --name-only');
		const pushIndex = out.indexOf('git push --force --atomic --all');
		assert.ok(verifyIndex > -1, 'emits a verification loop');
		assert.ok(verifyIndex > pushIndex, 'verification runs after the push');
		assert.ok(out.includes('STILL PRESENT'), 'reports refs that are still dirty');
	});

	test('restores the remote that git filter-repo deletes', () => {
		const out = script({ restoreRemote: true, remoteUrl: 'git@github.com:acme/repo.git' });
		assert.ok(
			out.includes('git remote add') && out.includes('git@github.com:acme/repo.git'),
			're-adds the remote before pushing'
		);
		const addIndex = out.indexOf('git remote add');
		const pushIndex = out.indexOf('git push --force --atomic --all');
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
	});

	suiteTeardown(() => {
		try { fs.rmSync(repo, { recursive: true, force: true }); } catch (e) { void e; }
	});

	function panelFor(keyword) {
		const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
		panel._scanRepoRoot = repo;
		panel._updateWebviewContent = () => {};
		panel._getKeywordSearchConfig = () => ({
			enabled: true,
			keywords: [keyword],
			maxMatchesPerKeyword: 25,
			shortKeywordFileHistoryMaxCount: 300,
			searchCommitMessages: false,
			searchFileHistory: true,
			searchFileNames: false
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
});
