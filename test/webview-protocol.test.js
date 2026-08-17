const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The panel's webview-to-host protocol keys every message on `command`, because
// that is what `onDidReceiveMessage` switches on. A message posted with `type`
// instead matches no case and is silently dropped: no error, no log, nothing
// happens. That is exactly how the commit-permalink and credential-report
// clicks shipped broken while every unit test passed — the tests exercised the
// host handlers directly and never crossed the boundary.
//
// This asserts the two sides agree, at the source level, for every message.
const PANEL = fs.readFileSync(path.join(__dirname, '..', 'leakLockPanel.js'), 'utf8');

function postedKeys(source) {
    // Matches vscode.postMessage({ <firstKey>: ... in the webview script.
    const calls = [...source.matchAll(/vscode\.postMessage\(\s*\{\s*([A-Za-z_$][\w$]*)\s*:/g)];
    return calls.map(match => match[1]);
}

function handledCommands(source) {
    const switchIndex = source.indexOf('switch (message.command)');
    if (switchIndex === -1) {
        return null;
    }
    const body = source.slice(switchIndex, switchIndex + 20000);
    return new Set([...body.matchAll(/case\s+'([^']+)'\s*:/g)].map(match => match[1]));
}

suite('webview message protocol', () => {

    test('the host switches on `command`', () => {
        assert.ok(
            PANEL.includes('switch (message.command)'),
            'the discriminant changed; every postMessage key must change with it'
        );
    });

    test('every webview postMessage keys on `command`, not `type`', () => {
        const keys = postedKeys(PANEL);
        assert.ok(keys.length > 0, 'expected to find postMessage calls to check');
        const wrong = keys.filter(key => key !== 'command');
        assert.deepStrictEqual(
            wrong,
            [],
            `these postMessage calls use the wrong key and will be silently dropped: ${wrong.join(', ')}`
        );
    });

    test('the tooltip lives on the element the user actually hovers', () => {
        // A `title` on the <td> is shadowed by any titled element inside it,
        // and the filename sits in <span class="file-link"> which carries its
        // own title. The td's tooltip was therefore only reachable on the
        // cell's empty padding — correct in the markup, invisible in the UI.
        const link = PANEL.split('\n').find(line => line.includes('class="file-link'));
        assert.ok(link, 'could not find the file-link span');
        assert.ok(
            link.includes('pathInfo.tooltip'),
            'the file-link span must carry the full-path tooltip; a title on the <td> alone is shadowed by it'
        );
    });

    test('both dialogs manage the shared report-mode class', () => {
        // showDetailDialog and showReportDialog render into the SAME overlay.
        // showReportDialog adds report-mode for HTML; if showDetailDialog does
        // not remove it, a text detail shown straight after a report keeps the
        // report styling and a branch list renders as one run-on line.
        const detail = PANEL.slice(
            PANEL.indexOf('function showDetailDialog'),
            PANEL.indexOf('function showReportDialog')
        );
        assert.ok(detail.includes("classList.remove('report-mode')"),
            'showDetailDialog must clear the class showReportDialog sets');

        const report = PANEL.slice(PANEL.indexOf('function showReportDialog'));
        assert.ok(report.slice(0, 800).includes("classList.add('report-mode')"),
            'showReportDialog must set it');
    });

    test('commit clicks use the verified host resolver rather than an inline URL', () => {
        assert.ok(PANEL.includes('class="commit-link" data-finding-index="'),
            'the Git Info item must carry its finding index to the host');
        assert.ok(PANEL.includes("event.target.closest('.commit-link[data-finding-index]')"),
            'the delegated click handler must handle Git Info items');
        assert.ok(PANEL.includes("vscode.postMessage({ command: 'openCommitUrl', findingIndex: idx })"),
            'the click handler must ask the host to resolve and open the URL');
        assert.ok(!PANEL.includes('<a class="commit-link" href='),
            'an inline href bypasses Git-backed path verification');
    });

    test('keyboard activation matches each element\'s ARIA role', () => {
        // A role="button" activates on Enter AND Space; a role="link" on Enter only,
        // where Space belongs to scrolling. Making them uniform broke one or the
        // other twice, so both directions are pinned here.
        const handlers = PANEL.split('\n')
            .filter(line => /role="(button|link)"/.test(line) && line.includes('onkeydown="'))
            .map(line => ({
                role: line.match(/role="(button|link)"/)[1],
                handler: line.match(/onkeydown="([^"]+)"/)[1]
            }));
        assert.ok(handlers.length >= 3, `expected the keyboard-activated spans, found ${handlers.length}`);
        for (const { role, handler } of handlers) {
            const acceptsSpace = /=== ?' '/.test(handler) || handler.includes("'Spacebar'");
            assert.ok(handler.includes("'Enter'"), `a role="${role}" activates on Enter`);
            if (role === 'button') {
                assert.ok(acceptsSpace, 'a role="button" must accept Space');
            } else {
                assert.ok(!acceptsSpace, 'a role="link" must not swallow Space');
            }
        }
    });

    test('the commands this feature added are actually handled', () => {
        const handled = handledCommands(PANEL);
        assert.ok(handled, 'could not locate the message switch');
        for (const command of ['openCommitUrl', 'inspectCredential', 'openFile']) {
            assert.ok(handled.has(command), `no case for '${command}' — clicking it would do nothing`);
        }
    });
});
