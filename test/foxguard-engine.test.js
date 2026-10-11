const assert = require('assert');
const fs = require('fs');
const path = require('path');
const scanEngines = require('../scan-engines');
const LeakLockPanel = require('../leakLockPanel');

suite('Foxguard code scan', () => {
    test('maps the native JSON report envelope into a read-only code issue', () => {
        const findings = scanEngines.parseFoxguardJson(JSON.stringify({
            schema_version: '1.0.0',
            findings: [{
                rule_id: 'js/no-eval', severity: 'high', cwe: 'CWE-95',
                description: 'Avoid eval', file: '/repo/src/app.js', line: 12,
                column: 4, end_line: 12, end_column: 8, snippet: 'eval(value)',
                confidence: 0.91, fix_suggestion: 'Use a fixed dispatch table.'
            }]
        }));
        const issue = scanEngines.mapFoxguardFinding(findings[0], '/repo');

        assert.strictEqual(issue.kind, 'code');
        assert.strictEqual(issue.file, 'src/app.js');
        assert.strictEqual(issue.line, 12);
        assert.strictEqual(issue.ruleId, 'js/no-eval');
        assert.strictEqual(issue.fix, 'Use a fixed dispatch table.');
        assert.ok(scanEngines.ENGINES.foxguard);
    });

    test('a timed-out scan reports the timeout, not a parse error on partial JSON', async () => {
        const os = require('os');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxguard-slow-'));
        const slow = path.join(dir, 'foxguard');
        fs.writeFileSync(slow, '#!/bin/sh\nprintf \'{"findings": [\'\nsleep 5\n', { mode: 0o755 });
        try {
            if (process.platform === 'win32') return;
            await assert.rejects(
                scanEngines.foxguardEngine.scan({ repoDir: dir, execution: { mode: 'binary', command: slow }, timeoutMs: 300 }),
                error => error.killed === true && !/parse/i.test(error.message)
            );
            const panel = Object.create(LeakLockPanel.prototype);
            const note = panel._engineFailureNote('foxguard', { killed: true, message: 'Command failed' }, { foxguardTimeoutMs: 120000 });
            assert.match(note, /Stopped after 120s\. Increase leakLock\.foxguard\.timeoutSeconds/);
            assert.match(panel._engineFailureNote('gitleaks', new Error('boom'), {}), /^Scan failed: boom$/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('exit 1 with a JSON report is read as findings, as Foxguard 0.14.0 exits', async () => {
        const os = require('os');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxguard-exit1-'));
        const fake = path.join(dir, 'foxguard');
        fs.writeFileSync(fake, '#!/bin/sh\nprintf \'{"findings":[{"rule_id":"py/no-eval","file":"a.py","line":3,"severity":"critical"}]}\'\nexit 1\n', { mode: 0o755 });
        try {
            if (process.platform === 'win32') return;
            const out = await scanEngines.foxguardEngine.scan({ repoDir: dir, execution: { mode: 'binary', command: fake }, timeoutMs: 5000 });
            assert.strictEqual(out.findings.length, 1);
            assert.strictEqual(out.findings[0].ruleId, 'py/no-eval');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('renders code issues as source links without cleanup controls', () => {
        const panel = Object.create(LeakLockPanel.prototype);
        panel._codeIssues = [{
            file: 'src/app.js', line: 12, severity: 'high', ruleId: 'js/no-eval',
            description: 'Avoid eval', engine: 'foxguard'
        }];
        const html = panel._renderCodeIssues();

        assert.match(html, /openFile\(/);
        assert.doesNotMatch(html, /secret-checkbox|<input/i);
    });

    test('renders the side rail with results, cleanup and code-issue targets', () => {
        const panel = Object.create(LeakLockPanel.prototype);
        panel._scanResults = [{}];
        panel._codeIssues = [{}];
        const html = panel._renderScanSideRail();

        assert.match(html, /scan-results-section/);
        assert.match(html, /cleanup-section/);
        assert.match(html, /code-issues-section/);
        assert.match(html, /Results/);
        assert.match(html, /Cleanup/);
        assert.match(html, /Issues/);
    });

    test('cleanup is refused while Foxguard is still scanning', async () => {
        const vscode = require('vscode');
        const panel = Object.create(LeakLockPanel.prototype);
        panel._isScanning = true;
        panel._scanCleanup = { preparedCommand: 'x', preparedMode: 'bfg', blockedBranches: [] };
        const warnings = [];
        const originalWarn = vscode.window.showWarningMessage;
        vscode.window.showWarningMessage = async message => { warnings.push(message); };
        try {
            await panel._prepareScanReplacementCommand('bfg', {});
            await panel._runPreparedScanCleanup('bfg');
            panel._runBFGCommand({});
            panel._generateFixCommand({});
        } finally {
            vscode.window.showWarningMessage = originalWarn;
        }
        assert.strictEqual(warnings.length, 4);
        assert.ok(warnings.every(message => /Wait for the scan to finish/.test(message)));
        assert.strictEqual(panel._scanCleanup.preparedCommand, 'x');
    });

    test('a selection made while Foxguard runs survives its completion', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'leakLockPanel.js'), 'utf8');
        const waitAt = source.indexOf('foxguardOutcome = await foxguardPromise');
        const doneAt = source.indexOf('this._isScanning = false;', waitAt);
        const tail = source.slice(waitAt, doneAt);
        assert.doesNotMatch(tail.replace(/if \(!foxguardTask\) this\._resetScanSelection\(\);/, ''), /_resetScanSelection\(\)/);
    });

    test('a code issue without a file renders no source link', () => {
        const panel = Object.create(LeakLockPanel.prototype);
        panel._codeIssues = [{ file: null, line: 3, ruleId: 'x', description: 'd', severity: 'low' }];
        const html = panel._renderCodeIssues();
        assert.doesNotMatch(html, /openFile\(/);
        assert.match(html, /unknown:3/);
    });

    test('does not render broken side-rail links for sections that are absent', () => {
        const panel = Object.create(LeakLockPanel.prototype);
        panel._scanResults = [];
        panel._codeIssues = [{ file: 'src/app.js' }];
        panel._scanCoverage = { engines: [{ id: 'foxguard', ok: true }] };

        const html = panel._renderScanSideRail();

        assert.doesNotMatch(html, /href="#scan-results-section"/);
        assert.doesNotMatch(html, /href="#cleanup-section"/);
        assert.match(html, /href="#code-issues-section"/);
    });

    test('does not attribute credential findings to Foxguard', () => {
        const panel = Object.create(LeakLockPanel.prototype);
        panel._scanCoverage = {
            engines: [
                { id: 'gitleaks', displayName: 'Gitleaks', ok: true },
                { id: 'foxguard', displayName: 'Foxguard', ok: true }
            ]
        };

        const html = panel._renderEngineAttribution({ engine: 'gitleaks' });

        assert.doesNotMatch(html, /missed by/);
    });

    test('anchors glyphs on the right and reveals labels to their left', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'leakLockPanel.js'), 'utf8');

        assert.match(source, /\.scan-side-rail \{[\s\S]*align-items: flex-end/);
        assert.match(source, /\.scan-side-glyph \{[\s\S]*right: 7px;[\s\S]*filter: grayscale\(1\)/);
        assert.match(source, /\.scan-side-label \{[\s\S]*right: 30px;[\s\S]*opacity: 0/);
        assert.match(source, /a:hover \.scan-side-label,[\s\S]*opacity: 1/);
    });

    test('starts Foxguard with credentials but waits for it after rendering credential results', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'leakLockPanel.js'), 'utf8');
        const startedAt = source.indexOf('let foxguardPromise = foxguardTask && parallel ? startFoxguard()');
        const credentialWaitAt = source.indexOf('const outcomes = await hostCapacity.runWithConcurrency');
        const renderedAt = source.indexOf('Credential results are ready. Scanning code issues with Foxguard...');
        const foxguardWaitAt = source.indexOf('foxguardOutcome = await foxguardPromise');

        assert.ok(startedAt >= 0 && startedAt < credentialWaitAt, 'Foxguard starts with credential scans');
        assert.ok(renderedAt >= 0 && renderedAt < foxguardWaitAt, 'credentials render before waiting for Foxguard');
    });

    test('keeps a code-issues target while Foxguard is still scanning', () => {
        const panel = Object.create(LeakLockPanel.prototype);
        panel._codeIssues = [];
        panel._isScanning = true;
        panel._scanCoverage = { engines: [{ id: 'foxguard', inProgress: true }] };

        const html = panel._renderCodeIssues();

        assert.match(html, /id="code-issues-section"/);
        assert.match(html, /still scanning/);
    });

    test('keeps a code-issues target after Foxguard completes cleanly', () => {
        const panel = Object.create(LeakLockPanel.prototype);
        panel._codeIssues = [];
        panel._isScanning = false;
        panel._scanCoverage = { engines: [{ id: 'foxguard', ok: true, findings: 0 }] };

        const html = panel._renderCodeIssues();

        assert.match(html, /id="code-issues-section"/);
        assert.match(html, /completed with no code issues/);
    });

    test('keeps the side rail and code-issues target when credentials are clean while Foxguard scans', () => {
        const panel = Object.create(LeakLockPanel.prototype);
        panel._codeIssues = [];
        panel._scanResults = [];
        panel._isScanning = true;
        panel._scanProgress = { message: 'Credential results are ready. Scanning code issues with Foxguard...' };
        panel._scanCoverage = { engines: [{ id: 'foxguard', inProgress: true }] };
        panel._renderEmptyScanState = () => '<section id="empty-results">No credential findings</section>';
        panel._renderImportedReport = () => '';

        const html = panel._getScanResultsSection();

        assert.match(html, /scan-side-rail/);
        assert.match(html, /id="code-issues-section"/);
    });
});

suite('Three credential engines and Foxguard finish in either order', () => {
    const vscode = require('vscode');
    const os = require('os');
    const { execFileSync } = require('child_process');
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    async function runScan({ credentialMs, foxguardMs, mode = 'parallel', failAfterInterim = false }) {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'order-'));
        execFileSync('git', ['-C', repo, 'init', '-q']);
        LeakLockPanel.createOrShow(vscode.Uri.file(path.join(__dirname, '..')));
        const panel = LeakLockPanel.currentPanel;
        // The panel is a singleton: drop instance stubs a previous run left behind.
        for (const key of Object.keys(panel)) {
            if (typeof panel[key] === 'function') delete panel[key];
        }
        panel._isScanning = false;
        panel._selectedDirectory = repo;
        panel._chooseScanStrategy = () => ({ mode, engines: ['noseyparker', 'gitleaks', 'trufflehog', 'foxguard'], dropped: [], concurrency: mode === 'parallel' ? 4 : 1, reason: '', tier: 'capable', host: { cpus: 8, totalMemGb: 16, memorySource: 'os', loadPerCore: null } });
        panel._refreshRefsForScan = async () => null;
        panel._checkDockerAvailability = async () => ({ available: true });
        const timeline = [];
        const credential = engineId => async () => {
            timeline.push(`start:${engineId}`);
            await delay(credentialMs);
            timeline.push(`end:${engineId}`);
            return { id: engineId, results: [{ file: 'cfg.js', line: 1, secret: `s-${engineId}`, engine: engineId }], codeIssues: [],
                report: { id: engineId, displayName: engineId, ok: true, findings: 1 } };
        };
        panel._runNoseyParkerEngine = credential('noseyparker');
        panel._deduplicateScanResults = results => results;
        panel._scanGitHistoryForKeywords = async () => [];
        panel._enrichResultsWithGitInfo = async () => {};
        panel._classifyCredentials = async () => {};
        panel._createResultFromEngineFinding = finding => finding;
        panel._runExternalEngine = async engineId => {
            if (engineId === 'foxguard') {
                timeline.push('start:foxguard');
                await delay(foxguardMs);
                return { id: 'foxguard', results: [], codeIssues: [{ file: 'a.py', line: 1, ruleId: 'py/no-eval' }],
                    report: { id: 'foxguard', displayName: 'Foxguard', ok: true, findings: 1 } };
            }
            return credential(engineId)();
        };
        if (failAfterInterim) {
            // Fail right after the interim coverage (Foxguard in progress) is built:
            // the first reset is at scan start, the second in the interim render.
            const reset = panel._resetScanSelection.bind(panel);
            let calls = 0;
            panel._resetScanSelection = () => {
                if (++calls === 2) throw new Error('interim render failed');
                return reset();
            };
        }
        const snapshots = [];
        const original = panel._updateWebviewContent.bind(panel);
        panel._updateWebviewContent = () => {
            snapshots.push({ scanning: panel._isScanning, cred: panel._scanResults.length, code: panel._codeIssues.length });
            return original();
        };
        const warn = vscode.window.showWarningMessage;
        const info = vscode.window.showInformationMessage;
        const warnings = [];
        vscode.window.showWarningMessage = async message => { warnings.push(message); };
        vscode.window.showInformationMessage = async () => {};
        const showError = vscode.window.showErrorMessage;
        vscode.window.showErrorMessage = async () => {};
        try {
            const scan = panel._scanRepository(false);
            await delay(Math.min(credentialMs, foxguardMs) + 100);
            const mid = { scanning: panel._isScanning, cred: panel._scanResults.length, code: panel._codeIssues.length };
            if (!failAfterInterim) {
                await panel._scanRepository(false);
                await panel._prepareScanReplacementCommand('bfg', {});
            }
            await scan;
            return { panel, snapshots, mid, warnings, timeline };
        } finally {
            vscode.window.showWarningMessage = warn;
            vscode.window.showInformationMessage = info;
            vscode.window.showErrorMessage = showError;
            fs.rmSync(repo, { recursive: true, force: true });
        }
    }

    function assertBothComplete({ panel, snapshots, warnings }) {
        const ended = snapshots.findIndex(s => !s.scanning);
        assert.ok(ended >= 0, 'the scan ends');
        assert.ok(snapshots.slice(ended).every(s => s.cred === 3 && s.code === 1), 'never ends with one side missing');
        assert.deepStrictEqual(panel._scanResults.map(r => r.engine).sort(), ['gitleaks', 'noseyparker', 'trufflehog']);
        assert.deepStrictEqual(panel._scanCoverage.engines.map(e => e.id).sort(), ['foxguard', 'gitleaks', 'noseyparker', 'trufflehog']);
        assert.strictEqual(panel._codeIssues.length, 1);
        assert.ok(warnings.some(m => /A scan is already running/.test(m)), 'second scan refused');
        assert.ok(warnings.some(m => /before preparing or running a cleanup/.test(m)), 'cleanup refused mid-scan');
    }

    test('Foxguard first: its issues show while credentials still scan', async function () {
        this.timeout(30000);
        const run = await runScan({ credentialMs: 1500, foxguardMs: 100 });
        assert.deepStrictEqual(run.mid, { scanning: true, cred: 0, code: 1 });
        assertBothComplete(run);
    });

    test('sequential mode runs Foxguard after the credential engines, never alongside', async function () {
        this.timeout(30000);
        const run = await runScan({ credentialMs: 100, foxguardMs: 100, mode: 'sequential' });
        const foxStart = run.timeline.indexOf('start:foxguard');
        const lastCredentialEnd = Math.max(...['noseyparker', 'gitleaks', 'trufflehog'].map(id => run.timeline.indexOf(`end:${id}`)));
        assert.ok(foxStart > lastCredentialEnd, run.timeline.join(' '));
        assert.strictEqual(run.panel._scanResults.length, 3);
        assert.strictEqual(run.panel._codeIssues.length, 1);
    });

    test('a scan that fails after the interim render does not claim Foxguard finished clean', async function () {
        this.timeout(30000);
        const run = await runScan({ credentialMs: 50, foxguardMs: 4000, failAfterInterim: true });
        assert.strictEqual(run.panel._isScanning, false);
        const foxguard = run.panel._scanCoverage.engines.find(engine => engine.id === 'foxguard');
        assert.strictEqual(foxguard.ok, false);
        assert.ok(!foxguard.inProgress);
        assert.doesNotMatch(run.panel._renderCodeIssues(), /completed with no code issues/);
    });

    test('credentials first: they show while Foxguard still scans', async function () {
        this.timeout(30000);
        const run = await runScan({ credentialMs: 100, foxguardMs: 1500 });
        assert.deepStrictEqual(run.mid, { scanning: true, cred: 3, code: 0 });
        assertBothComplete(run);
    });
});

suite('Foxguard on Linux, macOS and Windows', () => {
    const engineInstall = require('../engine-install');

    test('every supported platform resolves to a published Foxguard 0.14.0 asset', () => {
        // Names as published on https://github.com/0sec-labs/foxguard/releases/tag/v0.14.0
        const expected = {
            'linux/x64': 'foxguard-linux-x86_64',
            'linux/arm64': 'foxguard-linux-aarch64',
            'darwin/x64': 'foxguard-macos-x86_64',
            'darwin/arm64': 'foxguard-macos-aarch64',
            'win32/x64': 'foxguard-windows-x86_64.exe',
            // No arm64 build; Windows 11 on Arm runs the x64 build emulated.
            'win32/arm64': 'foxguard-windows-x86_64.exe'
        };
        for (const [key, asset] of Object.entries(expected)) {
            const [platform, arch] = key.split('/');
            assert.strictEqual(engineInstall.buildAssetName('foxguard', '0.14.0', platform, arch), asset, key);
        }
        assert.strictEqual(engineInstall.executableName('foxguard', 'win32'), 'foxguard.exe');
        assert.strictEqual(engineInstall.executableName('foxguard', 'darwin'), 'foxguard');
        assert.strictEqual(
            engineInstall.buildChecksumsUrl('foxguard', '0.14.0'),
            'https://github.com/0sec-labs/foxguard/releases/download/v0.14.0/checksums.txt'
        );
    });

    test('Windows output paths become repository-relative, whatever the drive-letter case', () => {
        // Shape taken from foxguard-windows-x86_64.exe 0.14.0: it echoes the scan root.
        const root = 'C:\\Users\\dev\\repo';
        const raw = { file: 'C:\\Users\\dev\\repo\\src\\a.py', line: 2, rule_id: 'py/no-eval', severity: 'critical' };
        assert.strictEqual(scanEngines.mapFoxguardFinding(raw, root).file, 'src\\a.py');
        assert.strictEqual(scanEngines.mapFoxguardFinding(raw, 'c:\\users\\dev\\repo').file, 'src\\a.py');
        assert.strictEqual(scanEngines.mapFoxguardFinding({ ...raw, file: 'C:/Users/dev/repo/src/a.py' }, 'C:/Users/dev/repo').file, 'src/a.py');
        // POSIX stays case-sensitive: /Repo and /repo are different directories.
        assert.strictEqual(scanEngines.relativizePath('/Repo/a.py', '/repo'), '/Repo/a.py');
    });

    test('Foxguard gets no Docker route, since it publishes no image', async () => {
        const { LeakLockSidebarProvider } = require('../leakLockSidebarProvider');
        const provider = Object.create(LeakLockSidebarProvider.prototype);
        const result = await provider._pullEngineImage('foxguard');
        assert.strictEqual(result.ok, false);
        assert.match(result.error, /no Docker image/);
        const ui = fs.readFileSync(path.join(__dirname, '..', 'leakLockSidebarProvider.js'), 'utf8');
        assert.match(ui, /engine\.image \? method\('docker'/);
    });

    test('Foxguard alone does not make setup ready: it finds no credentials', () => {
        const { LeakLockSidebarProvider } = require('../leakLockSidebarProvider');
        const provider = Object.create(LeakLockSidebarProvider.prototype);
        provider._dependencyStatus = {};
        provider._engineStatus = [{ id: 'foxguard', displayName: 'Foxguard', installed: true }];
        assert.deepStrictEqual(provider._installedScanners(), []);
        assert.strictEqual(provider._missingRequiredDependencies().length, 1);
        provider._engineStatus.push({ id: 'gitleaks', displayName: 'Gitleaks', installed: true });
        assert.deepStrictEqual(provider._installedScanners(), ['Gitleaks']);
    });
});

suite('Product site SEO', () => {
    const site = path.join(__dirname, '..', 'docs', 'website');
    const base = 'https://nikolareljin.github.io/leak-lock/';

    test('structured data names the released version', () => {
        const version = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim();
        const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
        const json = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
        assert.strictEqual(json.softwareVersion, version);
    });

    test('every page is in the sitemap and declares that URL as canonical', () => {
        const sitemap = fs.readFileSync(path.join(site, 'sitemap.xml'), 'utf8');
        const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
        // google*.html is the Search Console ownership token, not a page.
        const pages = fs.readdirSync(site).filter(f => f.endsWith('.html') && !/^google[0-9a-f]+\.html$/.test(f));
        for (const page of pages) {
            const url = page === 'index.html' ? base : base + page;
            assert.ok(listed.includes(url), `${page} missing from sitemap.xml`);
            const html = fs.readFileSync(path.join(site, page), 'utf8');
            assert.ok(html.includes(`<link rel="canonical" href="${url}">`), `${page} canonical`);
        }
        assert.strictEqual(listed.length, pages.length);
        assert.match(fs.readFileSync(path.join(site, 'robots.txt'), 'utf8'), new RegExp(`Sitemap: ${base}sitemap.xml`));
    });
});

suite('Foxguard is not a credential scan', () => {
    const scanBaseline = require('../scan-baseline');

    test('only Foxguard running is not rendered as a clean result', () => {
        const panel = new LeakLockPanel({ fsPath: '/tmp/ext' });
        panel._isScanning = false;
        panel._scanResults = [];
        panel._codeIssues = [];
        panel._scanCoverage = { incomplete: false, engines: [
            { id: 'gitleaks', displayName: 'Gitleaks', ok: false, note: 'not installed' },
            { id: 'foxguard', displayName: 'Foxguard', ok: true, findings: 0 }
        ] };
        let html = panel._renderEmptyScanState();
        assert.match(html, /No credential scan ran/);
        assert.match(html, /Gitleaks/);
        assert.doesNotMatch(html, /Foxguard<\/strong> — did not run/);

        panel._codeIssues = [{ file: 'a.py', line: 1, ruleId: 'py/no-eval', severity: 'high' }];
        html = panel._getScanResultsSection();
        assert.match(html, /No credential scan ran/);
        assert.match(html, /py\/no-eval/);
    });

    test('an import with only code issues does not ask to re-verify them', () => {
        const parsed = scanBaseline.parseImportedReport(JSON.stringify({
            generatedAt: '2026-10-01T10:00:00.000Z', scanPath: '/repo', totalFindings: 2, redacted: false,
            findings: [],
            codeIssues: [{ file: 'a.py', line: 1, ruleId: 'py/no-eval' }, { file: 'b.py', line: 2, ruleId: 'py/no-eval' }]
        }), { sourceName: 'report.json' });
        assert.ok(parsed.ok, parsed.error);
        const panel = Object.create(LeakLockPanel.prototype);
        panel._importedReport = parsed.report;
        panel._scanResults = [];
        panel._scanCleanup = {};
        const html = panel._renderImportedReport();
        assert.doesNotMatch(html, /have not been checked/);
        assert.match(html, /Imported code issues/);
    });
});
