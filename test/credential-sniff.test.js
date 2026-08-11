const assert = require('assert');
const { sniffCandidate } = require('../credential-sniff');

suite('sniffCandidate', () => {

    test('recognises PEM openers, including the head of a truncated key', () => {
        assert.strictEqual(sniffCandidate('-----BEGIN RSA PRIVATE KEY-----\nMIIE'), 'pem');
        assert.strictEqual(sniffCandidate('-----BEGIN OPENSSH PRIVATE KEY-----'), 'pem');
        assert.strictEqual(sniffCandidate('-----BEGIN PRIVATE KEY-----'), 'pem');
        assert.strictEqual(sniffCandidate('-----BEGIN EC PRIVATE KEY-----'), 'pem');
        assert.strictEqual(sniffCandidate('-----BEGIN CERTIFICATE-----'), 'pem');
        assert.strictEqual(sniffCandidate('-----BEGIN CERTIFICATE REQUEST-----'), 'pem');
        assert.strictEqual(sniffCandidate('-----BEGIN PGP PRIVATE KEY BLOCK-----'), 'pem');
    });

    test('recognises a compact JWT', () => {
        assert.strictEqual(
            sniffCandidate('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
            'jwt'
        );
    });

    test('recognises an unsigned JWT, which has an empty third segment', () => {
        assert.strictEqual(sniffCandidate('eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.'), 'jwt');
    });

    test('recognises SSH public key prefixes', () => {
        assert.strictEqual(sniffCandidate('ssh-rsa AAAAB3NzaC1yc2E user@host'), 'ssh-public-key');
        assert.strictEqual(sniffCandidate('ssh-ed25519 AAAAC3NzaC1lZDI1'), 'ssh-public-key');
        assert.strictEqual(sniffCandidate('ecdsa-sha2-nistp256 AAAAE2Vj'), 'ssh-public-key');
    });

    test('recognises a GCP service-account document', () => {
        assert.strictEqual(sniffCandidate('{"type": "service_account", "project_id": "x"}'), 'gcp-service-account');
        assert.strictEqual(sniffCandidate('{"type":"service_account"}'), 'gcp-service-account');
    });

    test('a dotted version string is not a JWT', () => {
        assert.strictEqual(sniffCandidate('1.2.3'), null);
        assert.strictEqual(sniffCandidate('lodash.get.mixin'), null);
    });

    test('ordinary secrets and prose are not candidates', () => {
        assert.strictEqual(sniffCandidate('AKIAIOSFODNN7EXAMPLE'), null);
        assert.strictEqual(sniffCandidate('password = hunter2'), null);
        assert.strictEqual(sniffCandidate('-----BEGIN-----'), null);
        assert.strictEqual(sniffCandidate(''), null);
        assert.strictEqual(sniffCandidate(null), null);
        assert.strictEqual(sniffCandidate(12345), null);
    });

    test('leading whitespace does not defeat the sniff', () => {
        assert.strictEqual(sniffCandidate('   \n-----BEGIN RSA PRIVATE KEY-----'), 'pem');
    });
});
