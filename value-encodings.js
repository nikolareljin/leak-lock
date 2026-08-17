// A scanner reports the value it *understood*, which is not always the value the
// file *stores*.
//
// TruffleHog runs decoders (percent, base64, UTF-16) before detection and reports
// the decoded credential, so a token written `...%3d%3d` in the file is reported as
// `...==`. Gitleaks reports the raw match, but a value can still be stored escaped
// by the format around it — `\/` and `\"` in JSON, `&amp;` in XML/HTML.
//
// A rewrite rule built from the reported form then matches no blob. `git filter-repo`
// and BFG both exit 0 in that case, so the secret survives a cleanup that reports
// success, and every later search for the reported value agrees it is not there —
// while the scan keeps finding it, because the scanner decodes again on the next run.
//
// This module enumerates the forms the same value may be stored as, so the rewrite
// can target what is actually in the repository rather than what was displayed.

// Characters that are commonly percent-encoded inside credentials that travel in
// URLs, query strings, connection strings and .env files. `=` is the one that
// matters most: base64 padding becomes %3D, and that is the reported case.
const PERCENT_ENCODED_CHARS = ['=', '+', '/', ':', '?', '&', '#', '@', ' ', '%'];

/** Percent-encode only `chars`, leaving everything else untouched. */
function percentEncodeSome(value, { upperCase = true, chars = PERCENT_ENCODED_CHARS } = {}) {
    let out = '';
    for (const char of String(value)) {
        if (chars.includes(char)) {
            const hex = char.charCodeAt(0).toString(16).padStart(2, '0');
            out += `%${upperCase ? hex.toUpperCase() : hex}`;
            continue;
        }
        out += char;
    }
    return out;
}

/**
 * Lowercase the hex digits of `%XX` escapes and nothing else.
 *
 * `encodeURIComponent(x).toLowerCase()` would lowercase the whole string, including
 * characters the encoder left alone - so `ABC%3D` becomes `abc%3d`, a value that was
 * never stored anywhere. Used as a search key that is merely a miss; used as a
 * rewrite rule that happens to occur in the repository, it redacts the wrong text.
 */
function lowercasePercentEscapes(value) {
    return String(value).replace(/%[0-9A-Fa-f]{2}/g, escape => escape.toLowerCase());
}

/** Percent-decode, tolerating a value that is not encoded at all. */
function percentDecode(value) {
    try {
        return decodeURIComponent(String(value));
    } catch {
        return null;
    }
}

function jsonEscape(value) {
    // The escaping a JSON document applies, including the optional `\/` that many
    // encoders emit and that a JSON parser silently undoes.
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\//g, '\\/');
}

function htmlEscape(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Every form the same value may be stored as, most likely first.
 *
 * Deduplicated and always led by the value itself, so a caller that stops at the
 * first match behaves exactly as before for the ordinary case.
 */
function candidateForms(value) {
    const source = typeof value === 'string' ? value : '';
    if (!source) {
        return [];
    }

    const forms = [
        source,
        // The reported value re-encoded: what the scanner decoded away.
        percentEncodeSome(source, { upperCase: true }),
        percentEncodeSome(source, { upperCase: false }),
        encodeURIComponent(source),
        lowercasePercentEscapes(encodeURIComponent(source)),
        jsonEscape(source),
        htmlEscape(source),
        // And the reverse: the file holds the decoded form while the scanner
        // reported an encoded one.
        percentDecode(source),
        // Stored as base64 of the credential, or the credential is itself the
        // decoded form of a base64 blob in the file.
        Buffer.from(source, 'utf8').toString('base64')
    ];

    const seen = new Set();
    return forms.filter(form => {
        if (typeof form !== 'string' || form === '' || seen.has(form)) {
            return false;
        }
        seen.add(form);
        return true;
    });
}

/**
 * Which of a value's forms actually occur in `text`.
 *
 * Returns every match, not the first: a repository can hold both the encoded and
 * the decoded form — a `.env` with `%3D%3D` and a doc with `==` — and removing one
 * while leaving the other is not a cleanup.
 */
function findStoredForms(value, text) {
    const haystack = typeof text === 'string' ? text : '';
    if (!haystack) {
        return [];
    }
    return candidateForms(value).filter(form => haystack.includes(form));
}

module.exports = {
    PERCENT_ENCODED_CHARS,
    percentEncodeSome,
    lowercasePercentEscapes,
    percentDecode,
    jsonEscape,
    htmlEscape,
    candidateForms,
    findStoredForms
};
