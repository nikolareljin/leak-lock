const assert = require('assert');
const vscode = require('vscode');
const { LeakLockSidebarProvider } = require('../leakLockSidebarProvider');

// Required vs optional is the distinction that decides whether a user can scan
// at all. It has already drifted once: the sidebar defaulted Nosey Parker to
// enabled while the panel did not, so Docker and the Nosey Parker image were
// demanded as REQUIRED for a scan that would never run Nosey Parker.

const ENGINES = (installed) => [
    { id: 'gitleaks', displayName: 'Gitleaks', enabled: true, installed: installed.includes('gitleaks') },
    { id: 'trufflehog', displayName: 'TruffleHog', enabled: true, installed: installed.includes('trufflehog') },
    { id: 'noseyparker', displayName: 'Nosey Parker', enabled: false, installed: installed.includes('noseyparker') }
];

function provider(dependencyStatus, engines, installedEngines = ['gitleaks', 'trufflehog']) {
    const p = Object.create(LeakLockSidebarProvider.prototype);
    p._dependencyStatus = dependencyStatus;
    p._engineStatus = ENGINES(installedEngines);
    const original = vscode.workspace.getConfiguration;
    vscode.workspace.getConfiguration = () => ({
        get: (key) => (key === 'scan.engines' ? engines : undefined)
    });
    p._restore = () => { vscode.workspace.getConfiguration = original; };
    return p;
}

const ALL_PRESENT = {
    docker: { installed: true },
    noseyparker: { installed: true },
    java: { installed: true },
    bfg: { installed: true }
};

suite('optional dependencies', () => {

    const ALL_ENGINES = ['gitleaks', 'trufflehog', 'noseyparker'];

    test('nothing is optional-missing when everything is installed', () => {
        const p = provider(ALL_PRESENT, undefined, ALL_ENGINES);
        try {
            assert.deepStrictEqual(p._missingOptionalDependencies(), []);
        } finally { p._restore(); }
    });

    test('BFG, Docker and Nosey Parker are optional by default', () => {
        const p = provider({
            docker: { installed: false },
            noseyparker: { installed: false },
            java: { installed: false },
            bfg: { installed: false }
        }, undefined);
        try {
            assert.deepStrictEqual(
                p._missingOptionalDependencies(),
                ['Nosey Parker', 'BFG', 'Docker']
            );
        } finally { p._restore(); }
    });

    test('one installed engine is enough to scan; the others are optional', () => {
        // The reported bug: "Not ready to scan — missing: Nosey Parker image"
        // while Gitleaks was installed and perfectly able to run.
        const p = provider(ALL_PRESENT, undefined, ['gitleaks']);
        try {
            assert.deepStrictEqual(p._missingRequiredDependencies(), []);
            assert.deepStrictEqual(p._missingOptionalDependencies(), ['TruffleHog', 'Nosey Parker']);
        } finally { p._restore(); }
    });

    test('Nosey Parker alone also satisfies the requirement', () => {
        const p = provider(ALL_PRESENT, ['noseyparker'], ['noseyparker']);
        try {
            assert.deepStrictEqual(p._missingRequiredDependencies(), []);
        } finally { p._restore(); }
    });

    test('no engine at all is the only blocking state', () => {
        const p = provider(ALL_PRESENT, undefined, []);
        try {
            const required = p._missingRequiredDependencies();
            assert.strictEqual(required.length, 1);
            assert.match(required[0], /at least one scan engine/);
        } finally { p._restore(); }
    });

    test('with no engine, credential-lens is named in the same prompt', () => {
        const p = provider(
            { ...ALL_PRESENT, credentialLens: { installed: false, error: 'ERR_MODULE_NOT_FOUND' } },
            undefined, []
        );
        try {
            const required = p._missingRequiredDependencies();
            assert.ok(required.some(m => /at least one scan engine/.test(m)));
            assert.ok(required.includes('credential-lens'),
                'both are fixed by the same trip through Dependencies Setup');
        } finally { p._restore(); }
    });

    test('credential-lens alone never blocks a scan', () => {
        // It enriches findings that already exist. A user with a working engine
        // must not be stopped because an enrichment library failed to load.
        const p = provider(
            { ...ALL_PRESENT, credentialLens: { installed: false, error: 'x' } },
            undefined, ['gitleaks']
        );
        try {
            assert.deepStrictEqual(p._missingRequiredDependencies(), []);
            assert.ok(p._missingOptionalDependencies().includes('credential-lens'));
        } finally { p._restore(); }
    });

    test('no Java means no BFG, because BFG is a JAR', () => {
        const p = provider({ ...ALL_PRESENT, java: { installed: false } }, undefined, ALL_ENGINES);
        try {
            assert.deepStrictEqual(p._missingOptionalDependencies(), ['BFG']);
        } finally { p._restore(); }
    });

    test('Docker stays optional even with Nosey Parker enabled', () => {
        // Enabling an engine is a preference, not a capability. If Nosey Parker
        // is enabled but its image is absent while Gitleaks runs, the scan is
        // fine — it simply runs one engine short. The old rule promoted Docker
        // to required here and produced the reported
        // "Not ready to scan — missing: Nosey Parker image" on a machine that
        // could scan perfectly well.
        const p = provider({
            docker: { installed: false },
            noseyparker: { installed: false },
            java: { installed: true },
            bfg: { installed: true }
        }, ['gitleaks', 'noseyparker'], ['gitleaks']);
        try {
            assert.deepStrictEqual(p._missingRequiredDependencies(), [],
                'one working engine means a scan can run');
            const optional = p._missingOptionalDependencies();
            assert.ok(optional.includes('Docker'));
            assert.ok(optional.includes('Nosey Parker'));
        } finally { p._restore(); }
    });

    test('Nosey Parker is named once, not twice, when both engine and image are absent', () => {
        const p = provider({
            ...ALL_PRESENT, docker: { installed: true }, noseyparker: { installed: false }
        }, undefined, ['gitleaks', 'trufflehog']);
        try {
            const optional = p._missingOptionalDependencies();
            assert.strictEqual(
                optional.filter(o => o === 'Nosey Parker').length, 1,
                'it arrives as both an uninstalled engine and a missing image'
            );
        } finally { p._restore(); }
    });

    test('the sidebar default matches the panel default', () => {
        // The panel's _getEnabledEngineIds defaults to gitleaks+trufflehog. If
        // the sidebar defaults differently, it demands dependencies for an
        // engine the scan will not run.
        const panel = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'leakLockPanel.js'), 'utf8'
        );
        const sidebar = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'leakLockSidebarProvider.js'), 'utf8'
        );
        const defaults = /\['gitleaks', 'trufflehog'\]/;
        assert.ok(defaults.test(panel), 'panel default changed');
        assert.ok(defaults.test(sidebar), 'sidebar default must track the panel default');

        const p = provider(ALL_PRESENT, undefined);
        try {
            assert.strictEqual(p._isNoseyParkerEnabled(), false,
                'Nosey Parker must be off by default: its upstream is archived and it needs Docker');
        } finally { p._restore(); }
    });

    test('the ready line names the optional absences, and stays clean when there are none', () => {
        const render = (optionalMissing) => {
            const p = Object.create(LeakLockSidebarProvider.prototype);
            p._isInstalling = false;
            p._showDependencyDetails = false;
            p._dependenciesInstalled = true;
            p._dependencyStatus = { optionalMissing };
            return p._getDependenciesSection().replace(/\s+/g, ' ');
        };

        const clean = render([]);
        assert.match(clean, /✅ Dependencies ready/);
        assert.ok(!clean.includes('optional dependencies missing'),
            'nothing missing should read as a plain ready state');

        const partial = render(['BFG']);
        assert.match(partial, /optional dependencies missing \(BFG\)/);

        const all = render(['BFG', 'Docker', 'Nosey Parker']);
        assert.match(all, /optional dependencies missing \(BFG, Docker, Nosey Parker\)/);
        assert.match(all, /✅ Dependencies ready/,
            'the ready state must survive: these do not block a scan');
    });

    test('optional absences never gate scanning', () => {
        const p = provider({
            docker: { installed: false },
            noseyparker: { installed: false },
            java: { installed: false },
            bfg: { installed: false }
        }, undefined);
        try {
            // No enabled engine is missing, so nothing blocks.
            assert.deepStrictEqual(p._missingRequiredDependencies(), []);
            assert.ok(p._missingOptionalDependencies().length > 0);
        } finally { p._restore(); }
    });
});
