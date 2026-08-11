// Turning a finding's commit into a URL you can open.
//
// This is NOT `detectRemoteProvider` in git-rewrite.js. That one matches
// provider names out of git *error text* so a remediation message can name the
// right UI; it never sees a URL and cannot produce an owner or repo.
//
// Unknown hosts — self-hosted GitLab, GitHub Enterprise, internal Gitea —
// return null on purpose. A guessed URL shape produces a 404 that looks like
// leak-lock pointing at the wrong commit, which is worse than plain text.

const HOSTS = Object.freeze({
    'github.com': {
        build: (owner, repo, sha, encodedPath, line) =>
            `https://github.com/${owner}/${repo}/blob/${sha}/${encodedPath}` + (line ? `#L${line}` : '')
    },
    'gitlab.com': {
        build: (owner, repo, sha, encodedPath, line) =>
            `https://gitlab.com/${owner}/${repo}/-/blob/${sha}/${encodedPath}` + (line ? `#L${line}` : '')
    },
    'bitbucket.org': {
        build: (owner, repo, sha, encodedPath, line) =>
            `https://bitbucket.org/${owner}/${repo}/src/${sha}/${encodedPath}` + (line ? `#lines-${line}` : '')
    }
});

const SUPPORTED_HOSTS = Object.freeze(Object.keys(HOSTS));

// Only the forms git itself writes into `remote.get-url`. `file://` and
// anything exotic is refused rather than parsed.
const REMOTE_SCHEMES = new Set(['https:', 'http:', 'ssh:', 'git:']);
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i;
// user@host:path — git's SCP-like syntax, which is not a URL.
const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/;
const HEX_SHA = /^[0-9a-f]{7,64}$/i;

function splitOwnerRepo(pathPart) {
    const segments = pathPart
        .replace(/^\/+/, '')
        .replace(/\.git$/i, '')
        .split('/')
        .filter(Boolean);
    if (segments.length < 2) {
        return null;
    }
    return {
        // GitLab subgroups are part of the owner path, not separate fields.
        owner: segments.slice(0, -1).join('/'),
        repo: segments[segments.length - 1]
    };
}

function parseRemote(url) {
    if (typeof url !== 'string') {
        return null;
    }
    const trimmed = url.trim();
    if (!trimmed) {
        return null;
    }

    let host;
    let pathPart;

    if (SCHEME_PREFIX.test(trimmed)) {
        let parsed;
        try {
            parsed = new URL(trimmed);
        } catch {
            return null;
        }
        if (!REMOTE_SCHEMES.has(parsed.protocol)) {
            return null;
        }
        host = parsed.hostname.toLowerCase();
        pathPart = parsed.pathname;
    } else {
        const match = SCP_LIKE.exec(trimmed);
        if (!match) {
            return null;
        }
        host = match[1].toLowerCase();
        pathPart = match[2];
    }

    if (!Object.hasOwn(HOSTS, host)) {
        return null;
    }

    const ownerRepo = splitOwnerRepo(pathPart);
    if (!ownerRepo) {
        return null;
    }

    return { host, owner: ownerRepo.owner, repo: ownerRepo.repo };
}

function encodePath(file) {
    // Encode each segment, keep the separators. encodeURIComponent would turn
    // every `/` into %2F and address a file that does not exist.
    return file.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function buildCommitUrl(remote, { commitHash, file, line } = {}) {
    if (!remote || !Object.hasOwn(HOSTS, remote.host)) {
        return null;
    }
    if (typeof commitHash !== 'string' || !HEX_SHA.test(commitHash)) {
        return null;
    }
    if (typeof file !== 'string' || !file.trim()) {
        return null;
    }
    const anchorLine = Number.isFinite(line) && line > 0 ? line : null;
    return HOSTS[remote.host].build(
        encodePath(remote.owner),
        encodeURIComponent(remote.repo),
        commitHash,
        encodePath(file),
        anchorLine
    );
}

/**
 * Would this URL have been produced by `buildCommitUrl`? The host re-checks
 * before opening a browser, so that a message from the webview can never turn
 * `openExternal` into a launcher for an arbitrary address.
 */
function isPermalinkUrl(url) {
    if (typeof url !== 'string' || !url) {
        return false;
    }
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    return parsed.protocol === 'https:' && Object.hasOwn(HOSTS, parsed.hostname.toLowerCase());
}

module.exports = { parseRemote, buildCommitUrl, isPermalinkUrl, SUPPORTED_HOSTS };
