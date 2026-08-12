const assert = require('assert');
const vscode = require('vscode');
const { LeakLockSidebarProvider } = require('../leakLockSidebarProvider');

// Required vs optional is the distinction that decides whether a user can scan
// at all. It has already drifted once: the sidebar defaulted Nosey Parker to
// enabled while the panel did not, so Docker and the Nosey Parker image were
// demanded as REQUIRED for a scan that would never run Nosey Parker.

function provider(dependencyStatus, engines) {
    const p = Object.create(LeakLockSidebarProvider.prototype);
    p._dependencyStatus = dependencyStatus;
    p._engineStatus = [];
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

    test('nothing is optional-missing when everything is installed', () => {
        const p = provider(ALL_PRESENT, undefined);
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
                ['BFG', 'Docker', 'Nosey Parker']
            );
        } finally { p._restore(); }
    });

    test('no Java means no BFG, because BFG is a JAR', () => {
        const p = provider({ ...ALL_PRESENT, java: { installed: false } }, undefined);
        try {
            assert.deepStrictEqual(p._missingOptionalDependencies(), ['BFG']);
        } finally { p._restore(); }
    });

    test('enabling Nosey Parker moves Docker out of optional', () => {
        // It becomes required instead, and _missingRequiredDependencies names
        // it. Reporting it in both places would let a blocking absence read as
        // an optional one.
        const p = provider({
            docker: { installed: false },
            noseyparker: { installed: false },
            java: { installed: true },
            bfg: { installed: true }
        }, ['gitleaks', 'noseyparker']);
        try {
            assert.deepStrictEqual(p._missingOptionalDependencies(), []);
            const required = p._missingRequiredDependencies();
            assert.ok(required.includes('Docker Engine'), 'Docker must be required when NP is on');
            assert.ok(required.includes('Nosey Parker image'));
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
