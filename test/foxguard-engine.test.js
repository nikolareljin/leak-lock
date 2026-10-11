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
        panel._codeIssues = [];
        const html = panel._renderScanSideRail();

        assert.match(html, /scan-results-section/);
        assert.match(html, /cleanup-section/);
        assert.match(html, /code-issues-section/);
        assert.match(html, /Results/);
        assert.match(html, /Cleanup/);
        assert.match(html, /Issues/);
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
