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
        const startedAt = source.indexOf('const foxguardPromise = foxguardTask');
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

    async function runScan({ credentialMs, foxguardMs }) {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'order-'));
        execFileSync('git', ['-C', repo, 'init', '-q']);
        LeakLockPanel.createOrShow(vscode.Uri.file(path.join(__dirname, '..')));
        const panel = LeakLockPanel.currentPanel;
        panel._isScanning = false;
        panel._selectedDirectory = repo;
        panel._chooseScanStrategy = () => ({ mode: 'parallel', engines: ['noseyparker', 'gitleaks', 'trufflehog', 'foxguard'], dropped: [], concurrency: 4, reason: '', tier: 'capable', host: { cpus: 8, totalMemGb: 16, memorySource: 'os', loadPerCore: null } });
        panel._refreshRefsForScan = async () => null;
        panel._checkDockerAvailability = async () => ({ available: true });
        const credential = engineId => async () => {
            await delay(credentialMs);
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
                await delay(foxguardMs);
                return { id: 'foxguard', results: [], codeIssues: [{ file: 'a.py', line: 1, ruleId: 'py/no-eval' }],
                    report: { id: 'foxguard', displayName: 'Foxguard', ok: true, findings: 1 } };
            }
            return credential(engineId)();
        };
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
        try {
            const scan = panel._scanRepository(false);
            await delay(Math.min(credentialMs, foxguardMs) + 100);
            const mid = { scanning: panel._isScanning, cred: panel._scanResults.length, code: panel._codeIssues.length };
            await panel._scanRepository(false);
            await panel._prepareScanReplacementCommand('bfg', {});
            await scan;
            return { panel, snapshots, mid, warnings };
        } finally {
            vscode.window.showWarningMessage = warn;
            vscode.window.showInformationMessage = info;
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

    test('credentials first: they show while Foxguard still scans', async function () {
        this.timeout(30000);
        const run = await runScan({ credentialMs: 100, foxguardMs: 1500 });
        assert.deepStrictEqual(run.mid, { scanning: true, cred: 3, code: 0 });
        assertBothComplete(run);
    });
});
