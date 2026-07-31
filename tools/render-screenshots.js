/**
 * Render the real Leak Lock webview HTML to a standalone file so the documentation
 * screenshots can be regenerated when the UI changes.
 *
 * The output is the extension's own `_getHtmlForWebview()` — not a mock-up. What this
 * adds is a `vscode` stub (the panel imports it) and VS Code's Dark+ theme variables,
 * which the webview normally inherits from the editor and which do not exist in a plain
 * browser. The fixture data mirrors a scan of this repository: the secrets are the
 * synthetic values in test/test-secrets.js, never real credentials.
 *
 *   node tools/render-screenshots.js results /tmp/results.html
 *   node tools/render-screenshots.js empty   /tmp/empty.html
 *
 * Then capture with any headless browser, e.g.:
 *   chromium --headless --disable-gpu --hide-scrollbars \
 *     --window-size=1500,2100 --screenshot=out.png file:///tmp/results.html
 *
 * Add `open` to the <details class="coverage-toggle"> tag first if you want the scan
 * coverage panel expanded in the capture.
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const OUT = process.argv[3] || '/tmp/out.html';
const VIEW = process.argv[2] || 'results';

// ---- vscode stub -----------------------------------------------------------
const settings = {
    'dependencyHandling': 'warning',
    'scan.engines': ['gitleaks', 'noseyparker'],
    'scan.executionMode': 'auto',
    'scan.timeoutSeconds': 300,
    'gitHistoryKeywordSearch.enabled': false,
    'gitHistoryKeywordSearch.keywords': []
};
const vscodeStub = {
    workspace: {
        workspaceFolders: [{ uri: { fsPath: REPO } }],
        getConfiguration: () => ({ get: (key) => settings[key], update: async () => {} })
    },
    window: {
        showErrorMessage: () => {}, showWarningMessage: () => {},
        showInformationMessage: () => {}, createWebviewPanel: () => ({}),
        withProgress: async (_o, fn) => fn({ report: () => {} })
    },
    commands: { executeCommand: () => {} },
    Uri: { file: (p) => ({ fsPath: p }), parse: (u) => ({ toString: () => u }) },
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

// ---- state -----------------------------------------------------------------
const panel = new LeakLockPanel({ fsPath: REPO });
panel._scanPath = REPO;
panel._selectedDirectory = REPO;

const mk = (o) => panel._createResult(
    o.file, o.line, o.secret, o.description, o.rule, null,
    { forceGitHistory: o.history, commitHash: o.commit, commitDate: o.date, extraFields: o.extra }
);

const results = [
    Object.assign(mk({
        file: 'test/test-secrets.js', line: 15, secret: 'AKIAIOSFODNN7EXAMPLE',
        description: 'AWS Access Token', rule: 'aws-access-token', history: true,
        commit: '9bdf3691c4a2', date: '2026-07-14T09:12:00Z',
        extra: { endLine: 15, startColumn: 18, endColumn: 38, entropy: 3.68, fingerprint: '9bdf369:test/test-secrets.js:aws-access-token:15', author: 'Nik Reljin', authorEmail: 'nik@example.invalid', commitMessage: 'add scanner fixtures' }
    }), { engine: 'gitleaks', engines: ['gitleaks', 'noseyparker'], engineVersion: 'v8.30.1', unavailableFields: [] }),

    Object.assign(mk({
        file: 'test/test-secrets.js', line: 4, secret: 'ghp_1234567890abcdefghijklmnopqrstuvwx',
        description: 'GitHub Personal Access Token', rule: 'github-pat', history: true,
        commit: '9bdf3691c4a2', date: '2026-07-14T09:12:00Z',
        extra: { endLine: 4, startColumn: 11, endColumn: 51, entropy: 4.21, fingerprint: '9bdf369:test/test-secrets.js:github-pat:4', author: 'Nik Reljin', authorEmail: 'nik@example.invalid' }
    }), { engine: 'gitleaks', engines: ['gitleaks'], engineVersion: 'v8.30.1', unavailableFields: ['verified'] }),

    Object.assign(mk({
        file: 'test/test-secrets.js', line: 2, secret: 'sk_test_1234567890abcdef',
        description: 'Stripe API Key', rule: 'stripe-access-token', history: true,
        commit: '3c69337ab810', date: '2026-06-02T17:40:00Z',
        extra: { endLine: 2, startColumn: 15, endColumn: 39, entropy: 3.94, verified: true, verifiedAt: '2026-07-31T09:55:00Z' }
    }), { engine: 'trufflehog', engines: ['trufflehog', 'gitleaks'], engineVersion: 'v3.96.0', unavailableFields: [] }),

    Object.assign(mk({
        file: 'sidebarProvider.js', line: 313, secret: 'sk_test_123456789abcdef',
        description: 'Stripe API Key', rule: 'stripe-access-token', history: true,
        commit: 'c7e3b99f0d41', date: '2026-05-21T11:02:00Z',
        extra: { endLine: 313, startColumn: 24, endColumn: 47, entropy: 3.81 }
    }), { engine: 'noseyparker', engines: ['noseyparker'], engineVersion: 'v0.24.0', unavailableFields: ['entropy', 'endLine', 'verified'] }),

    Object.assign(mk({
        file: 'node_modules/@sample/sdk/dist/client.js', line: 88, secret: 'AKIAIOSFODNN7EXAMPLE',
        description: 'AWS Access Token', rule: 'aws-access-token', history: false,
        commit: null, date: null, extra: { entropy: 3.68 }
    }), { engine: 'gitleaks', engines: ['gitleaks'], engineVersion: 'v8.30.1', unavailableFields: ['verified'] })
];

results[0].commitBranches = ['main', 'release/0.7.0', 'feat/multi-engine'];
results[1].commitBranches = ['main', 'release/0.7.0', 'feat/multi-engine'];
results[2].commitBranches = ['main'];
results[3].commitBranches = ['main', 'v0.6.3'];

const coverage = {
    incomplete: false, incompleteReason: null,
    engines: [
        { id: 'gitleaks', displayName: 'Gitleaks', version: 'v8.30.1', ok: true, findings: 4 },
        { id: 'trufflehog', displayName: 'TruffleHog', version: 'v3.96.0', ok: true, findings: 1, verified: 1 },
        { id: 'noseyparker', displayName: 'Nosey Parker', version: 'v0.24.0', ok: true, findings: 1,
          note: 'Nosey Parker upstream was archived on 2026-04-24; its ruleset is frozen at v0.24.0.' }
    ],
    image: 'ghcr.io/praetorian-inc/noseyparker:v0.24.0', imagePulled: true, imagePullError: null,
    rulesetMode: 'default', maxFileSizeMb: 100, timeoutSeconds: 300, dependencyHandling: 'warning',
    refRefresh: { attempted: true, ok: true, reason: null, remoteError: null },
    refs: {
        localBranches: 2, remoteBranches: 6, tags: 9, stashes: 0,
        remoteOnlyBranches: ['feat/multi-engine', 'fix/prepare-preflight', 'release/0.6.3', 'docs/website']
    },
    strategy: {
        mode: 'parallel', tier: 'capable', concurrency: 3, dropped: [],
        reason: 'Engines ran in parallel (host: 8 core(s), 19.2 GB, load 0.21/core).',
        host: { cpus: 8, totalMemGb: 19.2, memorySource: 'os', loadPerCore: 0.21 }
    }
};

if (VIEW === 'empty') {
    panel._scanResults = [];
    coverage.engines = coverage.engines.map(e => ({ ...e, findings: 0, verified: 0 }));
} else {
    panel._scanResults = results;
}
panel._scanCoverage = coverage;
panel._resetScanSelection();

if (VIEW !== 'empty') {
    panel._addCustomRule('internal-build.example.invalid', 'literal', 'redacted.invalid');
    panel._addCustomRule('ACME-CUSTOMER-[0-9]{6}', 'regex', '*****');
    const rules = panel._getCustomRules();
    panel._scanCleanup.customRulePreviews[rules[0].id] = {
        commitCount: 12, commits: [], files: ['docs/deploy.md', 'scripts/publish.sh'],
        branches: ['main', 'release/0.7.0'], truncated: false, maxCount: 200
    };
}

let html = panel._getHtmlForWebview();

// ---- make it renderable outside the editor ---------------------------------
const theme = `
<style>
:root{
 --vscode-editor-background:#1f1f1f; --vscode-editor-foreground:#cccccc;
 --vscode-foreground:#cccccc; --vscode-descriptionForeground:#9d9d9d;
 --vscode-panel-border:#2b2b2b; --vscode-widget-border:#313131;
 --vscode-textLink-foreground:#4daafc; --vscode-textLink-activeForeground:#4daafc;
 --vscode-button-background:#0078d4; --vscode-button-foreground:#ffffff;
 --vscode-button-hoverBackground:#026ec1; --vscode-button-secondaryBackground:#313131;
 --vscode-button-secondaryForeground:#cccccc;
 --vscode-input-background:#313131; --vscode-input-foreground:#cccccc; --vscode-input-border:#3c3c3c;
 --vscode-badge-background:#616161; --vscode-badge-foreground:#f8f8f8;
 --vscode-textCodeBlock-background:#2b2b2b;
 --vscode-inputValidation-warningBackground:#352a05; --vscode-inputValidation-warningForeground:#cca700;
 --vscode-inputValidation-errorBackground:#3c1d1d; --vscode-inputValidation-errorBorder:#be1100;
 --vscode-editorWarning-foreground:#cca700; --vscode-editorError-foreground:#f14c4c;
 --vscode-testing-iconFailed:#f14c4c;
 --vscode-gitDecoration-addedResourceForeground:#81b88b;
 --vscode-list-hoverBackground:#2a2d2e; --vscode-editorWidget-background:#252526;
 --vscode-focusBorder:#0078d4; --vscode-scrollbarSlider-background:#79797966;
 --vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Ubuntu,sans-serif;
}
body{background:#1f1f1f;color:#cccccc;font-family:var(--vscode-font-family);}
</style>
<script>window.acquireVsCodeApi=function(){return{postMessage:function(){},getState:function(){},setState:function(){}};};</script>
`;
html = html.replace('</head>', theme + '</head>');
if (!html.includes('</head>')) { html = theme + html; }

fs.writeFileSync(OUT, html);
console.log('wrote', OUT, html.length, 'bytes; view =', VIEW);
