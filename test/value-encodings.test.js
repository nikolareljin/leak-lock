const assert = require('assert');
const encodings = require('../value-encodings');

// A scanner reports the value it understood, not the value the file stores.
// TruffleHog decodes before detecting, so a token written `…%3d%3d` arrives as
// `…==`; a rewrite rule built from that matches no blob, and both rewrite tools
// exit 0 on a rule that matches nothing. The secret then survives a cleanup that
// reported success — which is exactly how this was found.
suite('value encodings', () => {

	const DECODED = 'sk_live_abc123==';
	const LOWER = 'sk_live_abc123%3d%3d';
	const UPPER = 'sk_live_abc123%3D%3D';

	test('re-encodes a decoded value in both hex cases', () => {
		const forms = encodings.candidateForms(DECODED);
		assert.ok(forms.includes(UPPER), 'uppercase %3D is the common encoder output');
		assert.ok(forms.includes(LOWER), 'lowercase %3d is what the reported repository held');
	});

	test('leads with the value itself, so the ordinary case is unchanged', () => {
		assert.strictEqual(encodings.candidateForms(DECODED)[0], DECODED);
		assert.deepStrictEqual(encodings.candidateForms(''), []);
	});

	test('finds every form present, not the first', () => {
		// A repository can hold the encoded form in a .env and the decoded form in a
		// document. Removing one and leaving the other is not a cleanup.
		const text = `URL=https://x/?t=${LOWER}\nnote: the token is ${DECODED}\n`;
		const found = encodings.findStoredForms(DECODED, text);
		assert.ok(found.includes(DECODED));
		assert.ok(found.includes(LOWER));
	});

	test('covers the escaping a format applies, not only URL encoding', () => {
		const withSlash = 'abc/def+ghi';
		const forms = encodings.candidateForms(withSlash);
		assert.ok(forms.includes('abc\\/def+ghi'), 'JSON escapes the solidus');
		assert.ok(forms.some(f => f.includes('%2F')), 'percent form for a path separator');
		assert.ok(forms.includes(Buffer.from(withSlash, 'utf8').toString('base64')));

		const withAmp = 'a&b"c';
		assert.ok(encodings.candidateForms(withAmp).includes('a&amp;b&quot;c'), 'HTML entities');
	});

	test('handles the reverse direction: the file stores what the scanner encoded', () => {
		assert.ok(encodings.candidateForms(LOWER).includes(DECODED),
			'a reported encoded value must also be looked for decoded');
	});

	test('a value that cannot be percent-decoded does not throw', () => {
		assert.strictEqual(encodings.percentDecode('100%'), null);
		assert.ok(encodings.candidateForms('100%').length > 0);
	});

	test('only the hex digits of an escape are lowercased, never the value', () => {
		// `encodeURIComponent(x).toLowerCase()` lowercased everything, so `ABC%3D`
		// became `abc%3d` — a string that was never stored. As a search key that is
		// a miss; as a rewrite rule that happens to occur, it redacts the wrong text.
		assert.strictEqual(encodings.lowercasePercentEscapes('ABC%3D%2F'), 'ABC%3d%2f');
		assert.strictEqual(encodings.lowercasePercentEscapes('NoEscapesHere'), 'NoEscapesHere');

		const forms = encodings.candidateForms('ABC=');
		assert.ok(forms.includes('ABC%3D') && forms.includes('ABC%3d'), 'both hex cases are offered');
		assert.ok(forms.every(form => !form.startsWith('abc')),
			'the value itself keeps its case in every candidate');
	});

	test('no form is empty or duplicated', () => {
		const forms = encodings.candidateForms('plain-token');
		assert.strictEqual(new Set(forms).size, forms.length);
		assert.ok(forms.every(form => form.length > 0));
	});
});
