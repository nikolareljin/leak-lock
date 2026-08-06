// Shared HTML escaping for the webviews.
//
// Both the panel and the sidebar render user-controlled strings — scan results,
// file paths, keywords — into webview HTML, and each had grown its own copy of
// this. The copies had already drifted (one coerced non-strings, the other did
// not), which is exactly how an escaping bug gets reintroduced on one surface
// after being fixed on the other. One implementation, used by both.
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') {
        return String(unsafe);
    }
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

module.exports = { escapeHtml };
