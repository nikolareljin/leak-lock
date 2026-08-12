const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The version badge was hardcoded as `version-0.7.0-blue` and read 0.7.0 while
// package.json said 0.8.0 — it had been stale across five releases, because
// nothing ever fails when a picture of a number goes out of date. It now reads
// package.json from the repository, and this keeps it that way.
const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

suite('README badges', () => {

    test('the version badge is read from package.json, not typed in', () => {
        assert.ok(
            README.includes('img.shields.io/github/package-json/v/nikolareljin/leak-lock'),
            'the version badge must resolve the version dynamically'
        );
    });

    test('no badge hardcodes a version number', () => {
        // Catches the whole class, not just the one that went stale. Static
        // badges are fine — `VS Code-1.125.0+` names a minimum, not a release —
        // so only a `version-<x.y.z>` shaped badge is rejected.
        const hardcoded = [...README.matchAll(/img\.shields\.io\/badge\/version-[\d.]+/g)];
        assert.deepStrictEqual(
            hardcoded.map(match => match[0]),
            [],
            'this badge will be wrong the next time the version changes'
        );
    });
});
