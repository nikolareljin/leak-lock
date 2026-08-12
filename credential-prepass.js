// Decides, right after a scan, which Secret cells are worth offering as
// clickable. Snippet bytes only — this never touches disk, so it cannot make a
// scan slower in proportion to repository size.
const { sniffCandidate } = require('./credential-sniff');
const { runWithConcurrency } = require('./host-capacity');

// Above this, classification happens on demand instead. A 4,000-finding scan
// should not spend its tail inspecting rows nobody will open.
const PREPASS_LIMIT = 500;
const PREPASS_CONCURRENCY = 4;

function labelFor(credential) {
    if (!credential) {
        return null;
    }
    return credential.kind || credential.family || null;
}

async function classifyFindings(findings, { inspect, limit = PREPASS_LIMIT, concurrency = PREPASS_CONCURRENCY } = {}) {
    const states = findings.map(() => ({ state: 'none', label: null }));
    if (typeof inspect !== 'function' || findings.length === 0) {
        return states;
    }

    const inspectable = Math.min(findings.length, limit);

    // Beyond the cap a finding is a candidate, not a none. A cap that rendered
    // rows unclickable would read as "not a credential", which is a claim the
    // pre-pass never actually made about them.
    for (let index = inspectable; index < findings.length; index += 1) {
        states[index] = { state: 'candidate', label: null };
    }

    const tasks = [];
    for (let index = 0; index < inspectable; index += 1) {
        tasks.push(async () => {
            const finding = findings[index];
            const secret = typeof finding.fullSecret === 'string' ? finding.fullSecret : finding.secret;
            if (typeof secret !== 'string' || !secret) {
                return;
            }
            let report = null;
            let failed = false;
            try {
                report = await inspect(Buffer.from(secret, 'utf8'));
            } catch {
                failed = true;
            }
            const label = report ? labelFor(report.credential) : null;
            if (label) {
                states[index] = { state: 'classified', label };
            } else if (failed || sniffCandidate(secret)) {
                // A failed inspection is not evidence of absence.
                states[index] = { state: 'candidate', label: null };
            }
        });
    }

    await runWithConcurrency(tasks, concurrency);
    return states;
}

module.exports = { classifyFindings, PREPASS_LIMIT, PREPASS_CONCURRENCY };
