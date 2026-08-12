// A cheap, synchronous "is this worth reading the whole file for?" check.
//
// Scanners report a matched snippet, and the panel truncates it to 50
// characters for display. Fifty characters of a PEM private key is not a key,
// so credential-lens returns `status: 'uninspectable'` for it — yet that
// finding is the one most worth inspecting. This decides, from the shape
// alone, whether to offer the user an inspection that will read the enclosing
// artifact.
//
// It answers "plausibly", never "definitely". credential-lens makes the real
// determination; a false positive here costs one file read and a popup that
// says the artifact was not recognised.

const PEM_OPENER = /-----BEGIN (?:[A-Z0-9]+(?: [A-Z0-9]+)* )?(?:PRIVATE KEY|PUBLIC KEY|CERTIFICATE|CERTIFICATE REQUEST|KEY BLOCK|MESSAGE|PARAMETERS)-----/;
// Three base64url segments. The signature may be empty (alg: none).
const COMPACT_JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/;
const SSH_PUBLIC_KEY = /^(?:ssh-rsa|ssh-dss|ssh-ed25519|ecdsa-sha2-[a-z0-9-]+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-[a-z0-9-]+@openssh\.com)\s/;
const GCP_SERVICE_ACCOUNT = /"type"\s*:\s*"service_account"/;

function sniffCandidate(text) {
    if (typeof text !== 'string' || !text) {
        return null;
    }
    const trimmed = text.trim();
    if (!trimmed) {
        return null;
    }
    if (PEM_OPENER.test(trimmed)) {
        return 'pem';
    }
    if (SSH_PUBLIC_KEY.test(trimmed)) {
        return 'ssh-public-key';
    }
    if (GCP_SERVICE_ACCOUNT.test(trimmed)) {
        return 'gcp-service-account';
    }
    if (COMPACT_JWT.test(trimmed)) {
        return 'jwt';
    }
    return null;
}

module.exports = { sniffCandidate };
