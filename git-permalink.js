// Turning a finding's commit into a URL you can open.
//
// This is NOT `detectRemoteProvider` in git-rewrite.js. That one matches
// provider names out of git *error text* so a remediation message can name the
// right UI; it never sees a URL and cannot produce an owner or repo.
//
// Well-known SaaS hosts are matched exactly. Every other valid git remote is
// supported too: the platform is inferred from the hostname (a host containing
// "gitlab" uses GitLab's /-/blob/ path shape; one containing "gitea", "forgejo"
// or "gogs" uses Gitea's /src/commit/ shape; everything else — GitHub Enterprise,
// Azure DevOps-style, generic self-hosted — gets GitHub's /blob/ shape, which is
// the most widely adopted layout).

// URL builders per platform. The host is the first argument so the same
// function serves both well-known SaaS hosts and any self-hosted instance at an
// arbitrary hostname.
const PLATFORMS = Object.freeze({
    github: {
        build: (host, owner, repo, sha, encodedPath, line) =>
            `https://${host}/${owner}/${repo}/blob/${sha}/${encodedPath}` + (line ? `#L${line}` : '')
    },
    gitlab: {
        build: (host, owner, repo, sha, encodedPath, line) =>
            `https://${host}/${owner}/${repo}/-/blob/${sha}/${encodedPath}` + (line ? `#L${line}` : '')
    },
    bitbucket: {
        build: (host, owner, repo, sha, encodedPath, line) =>
            `https://${host}/${owner}/${repo}/src/${sha}/${encodedPath}` + (line ? `#lines-${line}` : '')
    },
    gitea: {
        build: (host, owner, repo, sha, encodedPath, line) =>
            `https://${host}/${owner}/${repo}/src/commit/${sha}/${encodedPath}` + (line ? `#L${line}` : '')
    }
});

// Canonical SaaS hostnames → platform key.
const BUILT_IN_HOSTS = Object.freeze({
    'github.com': 'github',
    'gitlab.com': 'gitlab',
    'bitbucket.org': 'bitbucket'
});

const SUPPORTED_PLATFORMS = Object.freeze(Object.keys(PLATFORMS));

function normalizeCustomHostTypes(customHostTypes) {
    if (!customHostTypes || typeof customHostTypes !== 'object') {
        return {};
    }
    const normalized = {};
    for (const [hostname, platform] of Object.entries(customHostTypes)) {
        if (typeof hostname === 'string' && typeof platform === 'string') {
            normalized[hostname.toLowerCase()] = platform;
        }
    }
    return normalized;
}

/**
 * Infer which URL layout a self-hosted Git instance most likely uses.
 *
 * The hostname is the only signal available without making a network request.
 * Operators commonly include the product name in their hostname
 * (gitlab.acme.com, gitea.internal, forgejo.dev, …), so keyword matching covers
 * the most common cases. Everything else defaults to GitHub's /blob/ layout,
 * which GitHub Enterprise and most generic hosts share.
 */
function inferPlatform(host) {
    if (/gitlab/i.test(host)) { return 'gitlab'; }
    if (/bitbucket/i.test(host)) { return 'bitbucket'; }
    if (/gitea|forgejo|gogs/i.test(host)) { return 'gitea'; }
    return 'github';
}

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

/**
 * Parse a git remote URL into the fields needed to build a commit permalink.
 *
 * Accepts any remote that git itself accepts (https://, http://, ssh://, git://,
 * and SCP-like git@host:owner/repo). Returns { host, owner, repo, platform }
 * where platform selects the URL layout; returns null only when the URL cannot
 * be parsed into an owner and repo (missing path segments, bad scheme, etc.).
 *
 * @param {string} url  The remote URL (e.g. from `git remote get-url origin`).
 * @param {Record<string,string>} [customHostTypes]  Optional map of hostname →
 *   platform name supplied from user configuration. Checked before heuristics,
 *   so `{ "git.acme.com": "gitlab" }` forces GitLab's URL format for that host
 *   even though its name contains no platform keyword.
 */
function parseRemote(url, customHostTypes = {}) {
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

    const ownerRepo = splitOwnerRepo(pathPart);
    if (!ownerRepo) {
        return null;
    }

    const normalizedHostTypes = normalizeCustomHostTypes(customHostTypes);
    const platform =
        BUILT_IN_HOSTS[host] ||
        (Object.hasOwn(normalizedHostTypes, host) && Object.hasOwn(PLATFORMS, normalizedHostTypes[host])
            ? normalizedHostTypes[host]
            : null) ||
        inferPlatform(host);
    return { host, owner: ownerRepo.owner, repo: ownerRepo.repo, platform };
}

function encodePath(file) {
    // Encode each segment, keep the separators. encodeURIComponent would turn
    // every `/` into %2F and address a file that does not exist.
    return file.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function buildCommitUrl(remote, { commitHash, file, line } = {}) {
    if (!remote || !remote.platform || !Object.hasOwn(PLATFORMS, remote.platform)) {
        return null;
    }
    if (typeof commitHash !== 'string' || !HEX_SHA.test(commitHash)) {
        return null;
    }
    if (typeof file !== 'string' || !file.trim()) {
        return null;
    }
    const anchorLine = Number.isFinite(line) && line > 0 ? line : null;
    return PLATFORMS[remote.platform].build(
        remote.host,
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
 *
 * For well-known SaaS hosts the hostname alone is the guard. For self-hosted
 * instances, remoteInfo (the parsed origin remote of the scanned repository)
 * is required so the check remains specific: only the host the repository
 * actually lives on is accepted, not any arbitrary https address.
 */
function isPermalinkUrl(url, remoteInfo = null) {
    if (typeof url !== 'string' || !url) {
        return false;
    }
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:') {
        return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (Object.hasOwn(BUILT_IN_HOSTS, host)) {
        return true;
    }
    // Custom host: accept only if it matches the repository's own remote,
    // so a crafted webview message cannot redirect the browser elsewhere.
    return remoteInfo != null && host === remoteInfo.host.toLowerCase();
}

module.exports = { parseRemote, buildCommitUrl, isPermalinkUrl, SUPPORTED_PLATFORMS };
