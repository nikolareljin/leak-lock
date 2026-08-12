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

    test('commit links call the extension host directly', () => {        assert.ok(PANEL.includes('function openCommitUrl(findingIndex)'),            'the webview needs a direct host-message function for commit links');        assert.ok(PANEL.includes('onclick="openCommitUrl(${index})"'),            'the rendered Git Info control must call that function directly');        assert.ok(!PANEL.includes("event.target.closest('.commit-link')"),            'commit links must not depend on delegated click handling');    });
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

    test('the commands this feature added are actually handled', () => {
        const handled = handledCommands(PANEL);
        assert.ok(handled, 'could not locate the message switch');
        for (const command of ['openCommitUrl', 'inspectCredential', 'openFile']) {
            assert.ok(handled.has(command), `no case for '${command}' — clicking it would do nothing`);
        }
    });
});
