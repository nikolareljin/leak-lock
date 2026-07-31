/**
 * Run a genuine scan through the extension's own orchestration and dump the results.
 *
 * This is not a fixture generator. It stubs the `vscode` module (the panel imports it)
 * and then calls `_scanRepository()` — the same path the Scan button triggers — so the
 * output is whatever the configured engines actually found, including engine
 * attribution, versions and the coverage record.
 *
 * Its purpose is to feed tools/render-screenshots.js with real data, so documentation
 * screenshots show a real run rather than something hand-written to look like one.
 *
 *   node tools/real-scan.js <repo-to-scan> <out.json>
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const TARGET = process.argv[2];
const OUT = process.argv[3] || '/tmp/scan.json';

if (!TARGET) {
    console.error('usage: node tools/real-scan.js <repo-to-scan> <out.json>');
    process.exit(1);
}

const settings = {
    'dependencyHandling': 'warning',
    // Read the shipped default rather than hard-coding one. Hard-coding here is
    // exactly how the screenshots came to show three engines while the extension
    // shipped with two.
    'scan.engines': require(path.join(REPO, 'package.json'))
        .contributes.configuration.properties['leakLock.scan.engines'].default,
    'scan.executionMode': 'auto',
    'scan.timeoutSeconds': 900,
    'scan.refreshRefsBeforeScan': true,
    'noseyParker.ruleset': 'default',
    'noseyParker.suppressRedundant': true,
    'noseyParker.maxFileSizeMb': 100,
    // Verification is opt-in in the product, and opt-in here too. This script accepts
    // an arbitrary target repository, so defaulting it on would send credentials
    // discovered in someone's real repo to their providers without them asking.
    //   LEAKLOCK_VERIFY=1 node tools/real-scan.js <repo> out.json
    'trufflehog.verify': process.env.LEAKLOCK_VERIFY === '1',
    'gitHistoryKeywordSearch.enabled': false,
    'gitHistoryKeywordSearch.keywords': []
};

const vscodeStub = {
    workspace: {
        workspaceFolders: [{ uri: { fsPath: TARGET } }],
        getConfiguration: () => ({
            // Honour the two-argument form. LeakLockPanel and the sidebar call
            // config.get(key, fallback) in ten places; ignoring the fallback made this
            // stub diverge from a real host for any key not hand-seeded below.
            get: (key, fallback) => (key in settings ? settings[key] : fallback),
            update: async () => {}
        })
    },
    window: {
        showErrorMessage: (m) => console.error('  [error]', String(m).slice(0, 160)),
        showWarningMessage: (m) => console.warn('  [warn]', String(m).slice(0, 160)),
        showInformationMessage: (m) => console.log('  [info]', String(m).slice(0, 160)),
        withProgress: async (_o, fn) => fn({ report: () => {} })
    },
    commands: { executeCommand: () => {} },
    Uri: { file: (p) => ({ fsPath: p }) },
    ViewColumn: { One: 1 },
    ConfigurationTarget: { Global: 1 },
    env: { openExternal: () => {} }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') { return vscodeStub; }
    return originalLoad(request, parent, isMain);
};

const LeakLockPanel = require(path.join(REPO, 'leakLockPanel.js'));

(async () => {
    const panel = new LeakLockPanel({ fsPath: REPO });
    panel._updateWebviewContent = () => {
        if (panel._scanProgress) { console.log('  ·', panel._scanProgress.message); }
    };
    panel._selectedDirectory = TARGET;

    const started = Date.now();
    console.log(`scanning ${TARGET} with: ${settings['scan.engines'].join(', ')}`);
    await panel._scanRepository();

    const payload = {
        scannedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        results: panel._scanResults,
        coverage: panel._scanCoverage
    };
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));

    console.log(`\n${payload.results.length} finding(s) in ${Math.round(payload.durationMs / 1000)}s -> ${OUT}`);
    for (const engine of (payload.coverage?.engines || [])) {
        console.log(`  ${engine.ok ? 'ok  ' : 'FAIL'} ${engine.displayName} ${engine.version || '(version unknown)'} — ${engine.findings} finding(s)${engine.verified ? `, ${engine.verified} verified` : ''}${engine.note ? ` [${engine.note.slice(0, 60)}]` : ''}`);
    }
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
