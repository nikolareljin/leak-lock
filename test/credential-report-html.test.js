const assert = require('assert');
const { renderCredentialReportHtml } = require('../credential-report-html');

// Matches the shape the running credential-lens 0.3.0 emits: warnings are
// {code, message} objects, with a parallel `caveats` string array. The
// published INTEGRATION.md describes warnings as displayable strings, which is
// not what the library does.
const REPORT = {
    credential: { family: 'ssh', kind: 'private-key', format: 'openssh' },
    summary: {
        algorithm: 'ssh-ed25519',
        fingerprint: 'SHA256:example',
        encrypted: false,
        issuer: null,
        subject: null,
        issuedAt: null,
        notBefore: null,
        expiresAt: null
    },
    claims: [
        { id: 'ssh.algorithm', label: 'Algorithm', category: 'cryptographic', value: 'ssh-ed25519', source: 'embedded', verification: 'unverified' }
    ],
    warnings: [
        { code: 'LIMITATION', message: 'SSH key material does not cryptographically contain a verified owner.' }
    ],
    caveats: ['SSH key material does not cryptographically contain a verified owner.'],
    cache: { hit: true }
};

suite('renderCredentialReportHtml', () => {

    test('renders the family, kind and format', () => {
        const html = renderCredentialReportHtml(REPORT, { source: 'file' });
        assert.match(html, /private-key/);
        assert.match(html, /openssh/);
    });

    test('renders warning objects by their message, not as [object Object]', () => {
        const html = renderCredentialReportHtml(REPORT, { source: 'file' });
        assert.match(html, /does not cryptographically contain a verified owner/);
        assert.ok(!html.includes('[object Object]'), 'warnings are objects and must be unwrapped');
        assert.match(html, /class="cred-warnings"/);
    });

    test('falls back to caveats when only the string form is present', () => {
        const onlyCaveats = { ...REPORT, warnings: [], caveats: ['Only the caveat form.'] };
        const html = renderCredentialReportHtml(onlyCaveats, { source: 'file' });
        assert.match(html, /Only the caveat form\./);
    });

    test('empty summary fields are omitted, not spelled out', () => {
        // An ordinary SSH key leaves issuer, subject and all three date fields
        // null — five of eight rows saying "not present", pushing the algorithm
        // and fingerprint off the top of the dialog. The library's own caveats
        // already explain the absence ("an ordinary SSH key has no expiry
        // date"), so restating it per row was noise, not information.
        const html = renderCredentialReportHtml(REPORT, { source: 'file' });
        assert.match(html, /Algorithm/);
        assert.match(html, /Fingerprint/);
        assert.ok(!html.includes('Issuer'), 'a null issuer should not render a row');
        assert.ok(!html.includes('Not before'), 'a null validity window should not render a row');
    });

    test('a summary with nothing populated renders no grid at all', () => {
        const bare = { ...REPORT, summary: { algorithm: null, fingerprint: null, encrypted: null } };
        const html = renderCredentialReportHtml(bare, { source: 'file' });
        assert.ok(!html.includes('cred-summary'), 'an empty grid is an empty box on screen');
    });

    test('false and 0 are values, not absences', () => {
        // `encrypted: false` is the single most useful thing to know about a
        // private key. A truthiness filter would hide exactly that.
        const html = renderCredentialReportHtml(REPORT, { source: 'file' });
        assert.match(html, /Encrypted/);
        assert.match(html, />no</);
    });

    test('claims still spell out an absent value, where the row exists regardless', () => {
        const withEmptyClaim = {
            ...REPORT,
            claims: [{ id: 'x', label: 'Comment', category: 'identity', value: null, source: 'embedded', verification: 'unverified' }]
        };
        const html = renderCredentialReportHtml(withEmptyClaim, { source: 'file' });
        assert.match(html, /not present in the artifact/);
    });

    test('claims carry their source and verification', () => {
        const html = renderCredentialReportHtml(REPORT, { source: 'file' });
        assert.match(html, /unverified/);
        assert.match(html, /embedded/);
    });

    test('escapes hostile values instead of injecting them', () => {
        const hostile = {
            ...REPORT,
            claims: [{
                id: 'x',
                label: '<img src=x onerror=alert(1)>',
                category: 'identity',
                value: '"><script>alert(1)</script>',
                source: 'a',
                verification: 'b'
            }]
        };
        const html = renderCredentialReportHtml(hostile, { source: 'file' });
        // What makes this safe is that no tag opener survives. The substring
        // "onerror=" does survive, as inert text inside &lt;img …&gt; — it
        // cannot execute without a real tag, so asserting on it would test the
        // wrong property and fail on correctly-escaped output.
        assert.ok(!html.includes('<script>'), 'must not emit a raw script tag');
        assert.ok(!html.includes('<img'), 'must not emit a raw img tag');
        assert.match(html, /&lt;script&gt;/);
        assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    });

    test('a hostile warning message is escaped too', () => {
        const hostile = {
            ...REPORT,
            warnings: [{ code: 'X', message: '<script>alert(1)</script>' }]
        };
        const html = renderCredentialReportHtml(hostile, { source: 'file' });
        assert.ok(!html.includes('<script>'));
        assert.match(html, /&lt;script&gt;/);
    });

    test('names where the bytes came from and whether the cache answered', () => {
        assert.match(renderCredentialReportHtml(REPORT, { source: 'snippet' }), /matched snippet/i);
        assert.match(renderCredentialReportHtml(REPORT, { source: 'file' }), /whole file/i);
        assert.match(renderCredentialReportHtml(REPORT, { source: 'commit-blob' }), /at that commit/i);
        assert.match(renderCredentialReportHtml(REPORT, { source: 'file' }), /cache/i);
    });

    test('a declined report shows the reason and no empty tables', () => {
        const html = renderCredentialReportHtml(
            {
                credential: null,
                summary: {},
                claims: [],
                warnings: [{ code: 'LEAK_LOCK_DECLINED', message: 'The file is binary.' }],
                cache: { hit: false }
            },
            { source: 'declined' }
        );
        assert.match(html, /The file is binary\./);
        assert.ok(!/<table/.test(html), 'no empty claims table');
    });

    test('every interpolation point escapes, not just the ones we remembered', () => {
        // The webview injects this markup with innerHTML and the panel has no
        // Content-Security-Policy, so an unescaped interpolation is XSS with
        // nothing to stop it. This drives the payload through EVERY field the
        // renderer reads, so a future edit that forgets escapeHtml fails here
        // rather than shipping.
        const PAYLOAD = '<img src=x onerror=alert(1)>';
        const hostile = {
            credential: { family: PAYLOAD, kind: PAYLOAD, format: PAYLOAD },
            summary: {
                algorithm: PAYLOAD,
                fingerprint: PAYLOAD,
                encrypted: PAYLOAD,
                issuer: PAYLOAD,
                subject: PAYLOAD,
                issuedAt: PAYLOAD,
                notBefore: PAYLOAD,
                expiresAt: PAYLOAD
            },
            claims: [{
                id: PAYLOAD,
                label: PAYLOAD,
                category: PAYLOAD,
                value: PAYLOAD,
                source: PAYLOAD,
                verification: PAYLOAD
            }],
            warnings: [{ code: PAYLOAD, message: PAYLOAD }],
            caveats: [PAYLOAD],
            cache: { hit: true }
        };
        const html = renderCredentialReportHtml(hostile, { source: PAYLOAD });
        assert.ok(!html.includes('<img'), 'a raw tag opener survived escaping somewhere');
        assert.ok(!html.includes('<script'), 'a raw script tag survived escaping somewhere');
        // The payload must be present in escaped form — a renderer that simply
        // dropped these fields would otherwise pass the assertions above.
        assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    });

    test('a missing or malformed report renders rather than throwing', () => {
        assert.match(renderCredentialReportHtml(null, {}), /Not a recognised credential/);
        assert.match(renderCredentialReportHtml({}, {}), /Not a recognised credential/);
    });
});
