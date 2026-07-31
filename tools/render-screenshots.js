/**
 * Render the real Leak Lock webview HTML to a standalone file so the documentation
 * screenshots can be regenerated when the UI changes.
 *
 * The output is the extension's own `_getHtmlForWebview()` — not a mock-up. What this
 * adds is a `vscode` stub (the panel imports it) and VS Code's Dark+ theme variables,
 * which the webview normally inherits from the editor and which do not exist in a plain
 * browser. Everything else — findings, engine attribution, versions, coverage — comes
 * from tools/real-scan.js, i.e. from engines that actually ran.
 *
 * The documented subject is `damn-vulnerable-repo`, the public fixture: it carries the
 * full range of cases (multiple engines, multiple commits, untracked files, dependency
 * paths, content no scanner flags) that a screenshot needs to show, and every credential
 * in it is fake by construction. See docs/TEST_FIXTURE.md.
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
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const OUT = process.argv[3] || '/tmp/out.html';
const VIEW = process.argv[2] || 'results';

// ---- vscode stub -----------------------------------------------------------
const settings = {
    'dependencyHandling': 'warning',
    // Read the shipped default rather than hard-coding one — hard-coding here is how
    // the screenshots came to advertise two engines while the extension ran three.
    'scan.engines': (require(path.join(REPO, 'package.json'))
        .contributes.configuration.properties['leakLock.scan.engines'] || {}).default
        || ['gitleaks', 'trufflehog', 'noseyparker'],
    'scan.executionMode': 'auto',
    'scan.timeoutSeconds': 300,
    'gitHistoryKeywordSearch.enabled': false,
    'gitHistoryKeywordSearch.keywords': []
};
const vscodeStub = {
    workspace: {
        workspaceFolders: [{ uri: { fsPath: REPO } }],
        getConfiguration: () => ({
            // Honour the two-argument form. LeakLockPanel and the sidebar call
            // config.get(key, fallback) in ten places; ignoring the fallback made this
            // stub diverge from a real host for any key not hand-seeded below.
            get: (key, fallback) => (key in settings ? settings[key] : fallback),
            update: async () => {}
        })
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

// Real scan output, produced by tools/real-scan.js. Nothing here is hand-written:
// the findings, engine attribution, versions and coverage are whatever the engines
// actually reported.
// Defaults outside the repository: a scan report contains real secrets when it was
// produced from a real repository, and a default inside the working tree is one
// `git add -A` away from being committed.
const SCAN = process.argv[4] || path.join(os.tmpdir(), 'leaklock-scan.json');
if (!fs.existsSync(SCAN)) {
    console.error(`No scan data at ${SCAN}. Produce it first:\n` +
        `  node tools/real-scan.js <repo-to-scan> ${path.join(os.tmpdir(), 'leaklock-scan.json')}`);
    process.exit(1);
}
const scan = JSON.parse(fs.readFileSync(SCAN, 'utf8'));
// The repository the scan actually ran against, so every view names the same one.
// These images are published on a public website, so the scanned repository should
// live somewhere that carries no operator identity. Clone the fixture under /tmp/repos
// and scan it there — then the paths in the capture are simply real, with nothing to
// redact. LEAKLOCK_SHOT_PATH overrides the displayed path if a scan was taken
// elsewhere, but scanning a neutral location is the better habit.
const SCAN_PATH = process.env.LEAKLOCK_SHOT_PATH
    || (scan.coverage && scan.coverage.scanPath)
    || process.cwd();
// The scan refreshed refs, so the views should not claim the refs were never fetched.
const SCAN_FETCHED_AT = (scan.coverage && scan.coverage.refRefresh && scan.coverage.refRefresh.at)
    || scan.scannedAt || null;
// _scanCleanupRepo() derives the repo the header reports on; keep it pointing at the
// repository the scan actually ran against.


// The findings table is sampled so the image stays readable. The coverage panel is
// not a table — it summarises the whole run — so rendering it beside a sampled count
// would publish an image that contradicts itself ("6 findings" next to 23+27+12).
// LEAKLOCK_SHOT_LIMIT=0 keeps every finding for those captures.
const RAW_LIMIT = process.env.LEAKLOCK_SHOT_LIMIT;
const LIMIT = RAW_LIMIT === undefined ? 6 : Number(RAW_LIMIT);

// A real scan of this repository returns ~45 findings, which is far too tall for a
// documentation image, and their natural order groups every engine's findings
// together. Take a sample that spans the engines instead: corroborated findings
// first, then one per engine. The records themselves are untouched — this only
// chooses which real rows appear.
function sampleAcrossEngines(all, limit) {
    // Also vary the secret: a documentation example repeated across several files
    // would otherwise fill the table with the same value.
    const usedSecrets = new Set();
    const fresh = (r) => {
        const key = (r.fullSecret || '').slice(0, 24);
        if (usedSecrets.has(key)) { return false; }
        usedSecrets.add(key);
        return true;
    };
    const multi = all.filter(r => (r.engines || []).length > 1).filter(fresh);
    const picked = multi.slice(0, Math.min(limit, 2));
    const seen = new Set(picked);
    for (const engineId of ['noseyparker', 'gitleaks', 'trufflehog']) {
        for (const r of all) {
            if (picked.length >= limit) { break; }
            if (seen.has(r)) { continue; }
            if ((r.engines || [])[0] === engineId && fresh(r)) { picked.push(r); seen.add(r); break; }
        }
    }
    for (const r of all) {
        if (picked.length >= limit) { break; }
        if (!seen.has(r) && fresh(r)) { picked.push(r); seen.add(r); }
    }
    return picked;
}

panel._scanResults = VIEW === 'empty'
    ? []
    : (LIMIT > 0 ? sampleAcrossEngines(scan.results, LIMIT) : scan.results);
panel._scanCoverage = scan.coverage;
// In the extension the same panel instance scans and then renders, so it already knows
// when it fetched. Here the scan happened in a separate process, so replay the recorded
// time — otherwise the header reports "never (stale)" for a scan that did refresh refs.
panel._scanPath = SCAN_PATH;
panel._selectedDirectory = SCAN_PATH;
if (SCAN_FETCHED_AT && scan.coverage && scan.coverage.refRefresh && scan.coverage.refRefresh.ok) {
    panel._recordFetchAt(SCAN_PATH, SCAN_FETCHED_AT);
}
if (VIEW === 'empty') {
    // The no-findings view, shown with the same real coverage record.
    panel._scanCoverage = {
        ...scan.coverage,
        engines: (scan.coverage.engines || []).map(e => ({ ...e, findings: 0, verified: 0 }))
    };
}
panel._resetScanSelection();

// Manual rules, to show the editor. These are authored by definition — the feature
// exists precisely for text no scanner reports. The first is a literal that genuinely
// occurs in the scanned repository, so the dry run below reports real numbers.
async function seedManualRules() {
    if (VIEW === 'empty') {
        return;
    }
    // Both of these genuinely occur in the fixture's history, so the dry run below
    // reports real commit and file counts. A literal that matched nothing would render
    // an empty preview and make a working feature look broken.
    const literal = panel._addCustomRule(
        process.env.LEAKLOCK_SHOT_LITERAL || 'build-01.internal-corp-7.example',
        'literal', 'redacted.invalid');
    panel._addCustomRule('ACME-CUSTOMER-[0-9]{6}', 'regex', '*****');

    const target = scan.coverage && scan.coverage.scanPath;
    if (target && literal.ok) {
        // A real preview against the real repository: commits, files and branches
        // come from git, not from a fixture.
        panel._scanPath = target;
        panel._selectedDirectory = target;
        await panel._previewCustomRule(literal.rule.id);
    }
}

void seedManualRules()
    .then(seedWorkflowStage)
    .then(writeRenderedPage)
    .catch(error => { console.error(error); process.exit(1); });

/**
 * The panel and the sidebar are separate webviews. `removeFiles` is a mode on the
 * panel; `sidebar` is a different provider entirely. Both previously had to be
 * captured by hand from a live editor, which is how their screenshots ended up
 * showing an unrelated repository and a local path structure.
 */
/**
 * The cleanup stages, so the documentation can show the safety gates rather than only
 * the findings table. Every value here is produced by the real code from the real
 * repository: the command comes from the same builder the button calls, the push plan
 * from git via buildPushPlan(), and the verification from an actual verifyRemoteRefs()
 * run against the fixture's throwaway remote.
 */
async function seedWorkflowStage() {
    const gitRewrite = require(path.join(REPO, 'git-rewrite.js'));
    if (VIEW === 'prepared' || VIEW === 'pushPlan' || VIEW === 'verified') {
        panel._scanPath = SCAN_PATH;
        panel._selectedDirectory = SCAN_PATH;
        panel._scanRepoRoot = SCAN_PATH;
        const replacements = panel._resolveScanReplacements();
        panel._scanCleanup.replacements = replacements;
        panel._scanCleanup.preparedMode = 'git';
        panel._scanCleanup.preparedCommand = gitRewrite.buildRewriteScript({
            repoDir: SCAN_PATH,
            remote: 'origin',
            rewriteLines: ["git filter-repo --replace-text \"$replacement_file\" --force"],
            verifyRulesFile: '"$replacement_file"',
            restoreRemote: true
        });
    }
    if (VIEW === 'pushPlan' || VIEW === 'verified') {
        panel._scanCleanup.pushPlan = await gitRewrite.buildPushPlan(SCAN_PATH, 'origin');
    }
    if (VIEW === 'pushPlan') {
        panel._scanCleanup.pendingPush = {
            repoDir: SCAN_PATH, remote: 'origin', label: 'Git-only cleanup',
            refCount: (panel._scanCleanup.pushPlan.forceUpdate || []).length,
            remoteRestored: true, verify: { literals: ['AKIAIOSFODNN7EXAMPLE'] }
        };
    }
    if (VIEW === 'verified') {
        // A real verification pass over the fixture's own remote.
        panel._scanCleanup.verifyResult =
            await gitRewrite.verifyRemoteRefs(SCAN_PATH, 'origin', { literals: ['no-such-string-anywhere'] });
    }
    if (VIEW === 'protected') {
        panel._scanCleanup.pushBlockedByProtection = {
            ...gitRewrite.parseProtectedRefRejection({ message: PROTECTED_SAMPLE }),
            remote: 'origin', label: 'Git-only cleanup'
        };
    }
}

// Verbatim output of a real force-push to a repository whose main branch is protected.
const PROTECTED_SAMPLE = [
    'Command failed: git push --force --atomic origin refs/heads/*:refs/heads/* refs/tags/*:refs/tags/*',
    'remote: error: GH006: Protected branch update failed for refs/heads/main.',
    'remote: - Cannot force-push to this branch',
    'To github.com:nikolareljin/damn-vulnerable-repo.git',
    ' ! [remote rejected] leaklock-fixture/dev-alice -> leaklock-fixture/dev-alice (atomic transaction failed)',
    ' ! [remote rejected] leaklock-fixture/main-leaks -> leaklock-fixture/main-leaks (atomic transaction failed)',
    ' ! [remote rejected] leaklock-fixture/release-1.0 -> leaklock-fixture/release-1.0 (atomic transaction failed)',
    ' ! [remote rejected] main -> main (protected branch hook declined)'
].join('\n');

function renderCurrentView() {
    if (VIEW === 'sidebar' || VIEW === 'keywords') {
        const { LeakLockSidebarProvider } = require(path.join(REPO, 'leakLockSidebarProvider.js'));
        const sidebar = new LeakLockSidebarProvider({ fsPath: REPO });
        sidebar._selectedDirectory = SCAN_PATH;
        sidebar._dependenciesInstalled = true;
        sidebar._showDependencyDetails = true;
        // Mirrors what checkDependencies() reports on a machine where everything the
        // scan needs is present, so the panel shows its normal ready state.
        sidebar._dependencyStatus = {
            docker: { installed: true, version: 'Docker version 28.2.2, build 28.2.2-0ubuntu1~22.04.1' },
            noseyparker: { installed: true },
            java: { installed: true },
            bfg: { installed: true }
        };
        if (VIEW === 'keywords') {
            // The commit-message / file-history keyword search, expanded. Off by default
            // in the product, so it has to be opened explicitly to be documented at all.
            sidebar._showGitHistorySection = true;
            settings['gitHistoryKeywordSearch.enabled'] = true;
            settings['gitHistoryKeywordSearch.keywords'] = [
                'internal-corp-7', 'ACME-CUSTOMER', 'deploy_key'
            ];
        }
        return sidebar._getHtmlForWebview();
    }
    if (VIEW === 'removeFiles') {
        panel._viewMode = 'removeFiles';
        panel._selectedDirectory = SCAN_PATH;
        panel._scanPath = SCAN_PATH;
        // This view reads the repository from _removalState, not _selectedDirectory.
        panel._removalState.repoDir = SCAN_PATH;
        panel._removalState.lastFetchAt = SCAN_FETCHED_AT;
    }
    return panel._getHtmlForWebview();
}

function writeRenderedPage() {
let html = renderCurrentView();

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
}
