const assert = require('assert');
const { classifyFindings, PREPASS_LIMIT } = require('../credential-prepass');

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

suite('classifyFindings', () => {

    test('a snippet credential-lens resolves is classified and labelled', async () => {
        const states = await classifyFindings(
            [{ fullSecret: JWT }],
            { inspect: async () => ({ credential: { family: 'jwt', kind: 'JWT' } }) }
        );
        assert.deepStrictEqual(states[0], { state: 'classified', label: 'JWT' });
    });

    test('an unresolved snippet with a credential shape is a candidate', async () => {
        const states = await classifyFindings(
            [{ fullSecret: '-----BEGIN RSA PRIVATE KEY-----\nMIIE' }],
            { inspect: async () => ({ credential: null }) }
        );
        assert.strictEqual(states[0].state, 'candidate');
    });

    test('an ordinary secret is none, and its cell stays unclickable', async () => {
        const states = await classifyFindings(
            [{ fullSecret: 'hunter2' }],
            { inspect: async () => ({ credential: null }) }
        );
        assert.deepStrictEqual(states[0], { state: 'none', label: null });
    });

    test('findings past the cap are candidates, never none', async () => {
        const findings = Array.from({ length: PREPASS_LIMIT + 5 }, () => ({ fullSecret: 'hunter2' }));
        const states = await classifyFindings(findings, { inspect: async () => ({ credential: null }) });
        assert.strictEqual(states.length, findings.length);
        assert.strictEqual(states[PREPASS_LIMIT].state, 'candidate');
        assert.strictEqual(states[findings.length - 1].state, 'candidate');
    });

    test('the cap bounds how many inspections actually run', async () => {
        let calls = 0;
        const findings = Array.from({ length: PREPASS_LIMIT + 50 }, () => ({ fullSecret: JWT }));
        await classifyFindings(findings, { inspect: async () => { calls += 1; return { credential: null }; } });
        assert.strictEqual(calls, PREPASS_LIMIT);
    });

    test('an inspection that throws leaves that finding a candidate, not a failed scan', async () => {
        const states = await classifyFindings(
            [{ fullSecret: JWT }],
            { inspect: async () => { throw new Error('boom'); } }
        );
        assert.strictEqual(states[0].state, 'candidate');
    });

    test('no session at all yields all-none rather than throwing', async () => {
        const states = await classifyFindings([{ fullSecret: JWT }], { inspect: null });
        assert.deepStrictEqual(states[0], { state: 'none', label: null });
    });

    test('an empty finding list is handled without touching the inspector', async () => {
        let called = false;
        const states = await classifyFindings([], { inspect: async () => { called = true; return {}; } });
        assert.deepStrictEqual(states, []);
        assert.strictEqual(called, false);
    });
});
