const assert = require('assert');
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
});
