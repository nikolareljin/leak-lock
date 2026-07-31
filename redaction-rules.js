/**
 * User-authored redaction rules.
 *
 * Leak Lock could previously only redact strings a scanner had flagged. That leaves a
 * real category of content unremovable: an internal hostname, a private repository or
 * team codename, a customer identifier, an old employer's domain — and anything a
 * scanner simply missed. The only alternative was hand-rolling BFG outside the
 * extension, which discards every safety property this product provides (ref refresh,
 * ahead-branch block, ref-by-ref push plan, atomic push, post-push verification).
 *
 * A rule is `source ==> replaceWith`, matched either literally or as a regular
 * expression, and flows through exactly the same prepare → review → rewrite → verify →
 * confirm-push pipeline as a detected secret.
 *
 * No `vscode` import, so validation is unit-testable.
 */

// BFG and `git filter-repo` both use `==>` to separate the match from the replacement
// in a --replace-text file. A source string containing that sequence produces a
// malformed line, and the tool's parse of it — not the UI — decides what actually gets
// rewritten. Silently rewriting something other than what was displayed is the worst
// failure this feature could have, so it is rejected at entry.
const RULE_SEPARATOR = '==>';

// One owner for the default replacement. It was previously duplicated in three places
// that had to agree by convention.
const DEFAULT_REPLACEMENT = '*****';

// Below this length a literal will match inside unrelated words across the whole
// history. Not blocked — short internal codenames are legitimate — but the preview
// stops being optional.
const SHORT_SOURCE_THRESHOLD = 4;

const MODES = Object.freeze(['literal', 'regex']);

/**
 * Validate one rule.
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
function validateRule(rule) {
    const errors = [];
    const warnings = [];

    if (!rule || typeof rule !== 'object') {
        return { valid: false, errors: ['Rule must be an object.'], warnings };
    }

    const source = typeof rule.source === 'string' ? rule.source : '';
    const replaceWith = typeof rule.replaceWith === 'string' ? rule.replaceWith : '';
    const mode = MODES.includes(rule.mode) ? rule.mode : 'literal';

    if (!source.trim()) {
        errors.push('Source text is required.');
    }
    if (source.includes(RULE_SEPARATOR)) {
        errors.push(
            `Source text cannot contain "${RULE_SEPARATOR}" — it separates the match from the replacement ` +
            'in the rewrite rule file, and a source containing it would rewrite something other than what is shown here.'
        );
    }
    if (/[\r\n]/.test(source)) {
        errors.push('Source text cannot span multiple lines; the rule file is line-based.');
    }
    if (/[\r\n]/.test(replaceWith)) {
        errors.push('Replacement text cannot span multiple lines.');
    }
    if (replaceWith.includes(RULE_SEPARATOR)) {
        warnings.push(`Replacement text contains "${RULE_SEPARATOR}"; the first occurrence in the line is the separator, so this is kept as-is but is easy to misread.`);
    }

    if (mode === 'regex' && source.trim()) {
        try {
            const compiled = new RegExp(source);
            if (compiled.test('')) {
                errors.push('This pattern matches the empty string, which would rewrite every blob in history.');
            }
        } catch (error) {
            errors.push(`Not a valid regular expression: ${error.message}`);
        }
    }

    if (mode === 'literal' && source.trim() && source.trim().length < SHORT_SOURCE_THRESHOLD) {
        warnings.push(
            `"${source.trim()}" is very short and will match inside unrelated words throughout history. ` +
            'Preview the affected commits before running the cleanup.'
        );
    }

    return { valid: errors.length === 0, errors, warnings };
}

/**
 * Normalise a rule for storage. Returns null when the rule cannot be stored.
 */
function normalizeRule(rule, idFactory) {
    const { valid } = validateRule(rule);
    if (!valid) {
        return null;
    }
    const mode = MODES.includes(rule.mode) ? rule.mode : 'literal';
    const replaceWith = typeof rule.replaceWith === 'string' && rule.replaceWith !== ''
        ? rule.replaceWith
        : DEFAULT_REPLACEMENT;
    return {
        id: rule.id || (typeof idFactory === 'function' ? idFactory() : `rule-${Date.now()}`),
        source: rule.source,
        mode,
        replaceWith
    };
}

/**
 * Render one rule as a line for a BFG / `git filter-repo` --replace-text file.
 *
 * Both tools treat a bare line as a literal and a `regex:`-prefixed line as a regular
 * expression, so the mode has to be carried all the way here rather than decided at the
 * call site.
 */
function formatRuleLine(rule) {
    const replaceWith = rule.replaceWith === '' || rule.replaceWith === undefined || rule.replaceWith === null
        ? DEFAULT_REPLACEMENT
        : rule.replaceWith;
    const prefix = rule.mode === 'regex' ? 'regex:' : '';
    return `${prefix}${rule.source}${RULE_SEPARATOR}${replaceWith}`;
}

/**
 * Split rules into the two verification channels.
 *
 * verifyRemoteRefs greps literals with `--fixed-strings`. A regex rule verified that
 * way would rewrite correctly and then fail its own verification, so patterns need a
 * separate `git grep -E` path.
 */
function partitionForVerification(rules) {
    const literals = [];
    const patterns = [];
    for (const rule of rules || []) {
        if (rule.mode === 'regex') {
            patterns.push(rule.source);
        } else {
            literals.push(rule.source);
        }
    }
    return { literals, patterns };
}

/**
 * git log arguments that show which commits a rule touches, without changing anything.
 *
 * `-S` and `-G` are pickaxe searches over diffs, so they find content that was added
 * and later removed — the normal case for a leaked value, and precisely what a
 * working-tree grep would miss. `--all` matters: the preview has to cover the same refs
 * the rewrite will, or it understates the impact.
 */
function buildPreviewArgs(rule, { maxCount = 200 } = {}) {
    const selector = rule.mode === 'regex' ? `-G${rule.source}` : `-S${rule.source}`;
    return [
        'log', '--all', '--no-color',
        '--name-only',
        `--max-count=${maxCount}`,
        '--pretty=format:%x00%H%x09%aI%x09%s',
        selector
    ];
}

/**
 * Parse `git log --name-only` output from buildPreviewArgs into a blast-radius summary.
 */
function parsePreviewOutput(stdout) {
    const commits = [];
    const files = new Set();
    for (const chunk of String(stdout || '').split('\0')) {
        const trimmed = chunk.replace(/^\n+/, '');
        if (!trimmed.trim()) {
            continue;
        }
        const lines = trimmed.split('\n');
        const [hash, date, ...subjectParts] = lines[0].split('\t');
        if (!hash) {
            continue;
        }
        commits.push({ hash, date: date || null, subject: subjectParts.join('\t') || '' });
        for (const line of lines.slice(1)) {
            if (line.trim()) {
                files.add(line.trim());
            }
        }
    }
    return { commits, files: Array.from(files) };
}

module.exports = {
    RULE_SEPARATOR,
    DEFAULT_REPLACEMENT,
    SHORT_SOURCE_THRESHOLD,
    MODES,
    validateRule,
    normalizeRule,
    formatRuleLine,
    partitionForVerification,
    buildPreviewArgs,
    parsePreviewOutput
};
