// Renders a credential-lens report as webview markup.
//
// Kept out of leakLockPanel.js so the escaping can be tested directly: every
// value here originates in a file the user scanned, which means whoever could
// commit that file chose these strings.
//
// On `warnings`: credential-lens's INTEGRATION.md describes them as
// "limitations a caller should display", which reads as strings. The running
// 0.3.0 library emits `{ code, message }` objects, plus an undocumented
// parallel `caveats` array holding the same text as strings. Both are handled,
// warnings first — rendering the objects as-written would print
// "[object Object]" where the caveat text belongs.
const { escapeHtml } = require('./html-escape');

const SUMMARY_FIELDS = [
    ['algorithm', 'Algorithm'],
    ['fingerprint', 'Fingerprint'],
    ['encrypted', 'Encrypted'],
    ['issuer', 'Issuer'],
    ['subject', 'Subject'],
    ['issuedAt', 'Issued'],
    ['notBefore', 'Not before'],
    ['expiresAt', 'Expires']
];

const SOURCE_TEXT = {
    snippet: 'Read from the matched snippet.',
    file: 'Read from the whole file containing this finding.',
    'commit-blob': 'Read from the file as it existed at that commit.',
    declined: 'The artifact was not inspected.'
};

function renderValue(value) {
    if (value === null || value === undefined || value === '') {
        return '<span class="cred-absent">not present in the artifact</span>';
    }
    if (typeof value === 'boolean') {
        return escapeHtml(value ? 'yes' : 'no');
    }
    return escapeHtml(String(value));
}

function renderSummary(summary) {
    const rows = SUMMARY_FIELDS.map(([key, label]) =>
        `<div class="cred-field"><span class="cred-key">${escapeHtml(label)}</span><span class="cred-value">${renderValue(summary ? summary[key] : null)}</span></div>`
    ).join('');
    return `<div class="cred-summary">${rows}</div>`;
}

function renderClaims(claims) {
    if (!Array.isArray(claims) || claims.length === 0) {
        return '';
    }
    const byCategory = new Map();
    for (const claim of claims) {
        const category = claim.category || 'other';
        if (!byCategory.has(category)) {
            byCategory.set(category, []);
        }
        byCategory.get(category).push(claim);
    }
    return [...byCategory.entries()].map(([category, group]) => `
        <h4 class="cred-category">${escapeHtml(category)}</h4>
        <table class="cred-claims">
            <thead><tr><th>Claim</th><th>Value</th><th>Source</th><th>Verification</th></tr></thead>
            <tbody>
                ${group.map(claim => `
                    <tr>
                        <td>${escapeHtml(claim.label || claim.id || '')}</td>
                        <td class="cred-claim-value">${renderValue(claim.value)}</td>
                        <td>${escapeHtml(claim.source || '')}</td>
                        <td>${escapeHtml(claim.verification || '')}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `).join('');
}

/** Accepts both the object form and the string form; see the file header. */
function warningMessages(report) {
    const warnings = Array.isArray(report && report.warnings) ? report.warnings : [];
    const messages = warnings
        .map(warning => (warning && typeof warning === 'object' ? warning.message : warning))
        .filter(message => typeof message === 'string' && message);
    if (messages.length > 0) {
        return messages;
    }
    const caveats = Array.isArray(report && report.caveats) ? report.caveats : [];
    return caveats.filter(caveat => typeof caveat === 'string' && caveat);
}

function renderWarnings(report) {
    const messages = warningMessages(report);
    if (messages.length === 0) {
        return '';
    }
    // Displayed, never a tooltip: these are what keep an SSH comment or a JWT
    // claim read as evidence rather than as verified ownership.
    return `<div class="cred-warnings">
        <strong>What this does not tell you</strong>
        <ul>${messages.map(message => `<li>${escapeHtml(message)}</li>`).join('')}</ul>
    </div>`;
}

function renderCredentialReportHtml(report, meta = {}) {
    const credential = report && report.credential;
    const header = credential
        ? `<div class="cred-header">
               <span class="cred-kind">${escapeHtml(credential.kind || credential.family || 'Credential')}</span>
               <span class="cred-family">${escapeHtml(credential.family || '')}</span>
               <span class="cred-format">${escapeHtml(credential.format || '')}</span>
           </div>`
        : '<div class="cred-header"><span class="cred-kind">Not a recognised credential</span></div>';

    const body = credential
        ? renderSummary(report.summary) + renderClaims(report.claims)
        : '';

    const cacheNote = report && report.cache && report.cache.hit
        ? 'Served from this scan’s inspection cache.'
        : 'Inspected for this scan’s cache.';

    const footer = `<div class="cred-footer">${escapeHtml(SOURCE_TEXT[meta.source] || '')} ${escapeHtml(cacheNote)}</div>`;

    return `<div class="cred-report">${header}${renderWarnings(report)}${body}${footer}</div>`;
}

module.exports = { renderCredentialReportHtml };
