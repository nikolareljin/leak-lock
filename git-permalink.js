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
// `path` mirrors the layout `build` writes, and exists to read the fields back
// out of a URL that claims to be a permalink. It only has to be permissive
// enough to extract them: isPermalinkUrl rebuilds the address with `build` and
// compares, so the builder stays the authority on what a permalink looks like.
const PLATFORMS = Object.freeze({
    github: {
        build: (host, owner, repo, sha, encodedPath, line) =>
            `https://${host}/${owner}/${repo}/blob/${sha}/${encodedPath}` + (line ? `#L${line}` : ''),
        path: /^\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/blob\/(?<sha>[0-9a-f]{7,64})\/(?<file>.+)$/i
    },
    gitlab: {
        build: (host, owner, repo, sha, encodedPath, line) =>
            `https://${host}/${owner}/${repo}/-/blob/${sha}/${encodedPath}` + (line ? `#L${line}` : ''),
        // The owner is greedy because GitLab subgroups are part of it; the
        // literal /-/ segment is what ends it.
        path: /^\/(?<owner>.+)\/(?<repo>[^/]+)\/-\/blob\/(?<sha>[0-9a-f]{7,64})\/(?<file>.+)$/i
    },
    bitbucket: {
        build: (host, owner, repo, sha, encodedPath, line) =>
            `https://${host}/${owner}/${repo}/src/${sha}/${encodedPath}` + (line ? `#lines-${line}` : ''),
        path: /^\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/src\/(?<sha>[0-9a-f]{7,64})\/(?<file>.+)$/i
    },
    gitea: {
        build: (host, owner, repo, sha, encodedPath, line) =>
            `https://${host}/${owner}/${repo}/src/commit/${sha}/${encodedPath}` + (line ? `#L${line}` : ''),
        path: /^\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/src\/commit\/(?<sha>[0-9a-f]{7,64})\/(?<file>.+)$/i
    }
});

// Line anchors differ per platform (#L12, #lines-12). Only the number is read
// here; whether the form is the right one for the platform falls out of the
// rebuild-and-compare below.
const LINE_ANCHOR = /^#(?:L|lines-)([1-9]\d*)$/;

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

    // `host` is what the permalink is built with and can carry a port; `hostname`
    // never does, and is what platform inference and customHostTypes are keyed on,
    // so `{ "git.acme.com": "gitlab" }` still applies to git.acme.com:8443.
    let host;
    let hostname;
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
        hostname = parsed.hostname.toLowerCase();
        // Only a web scheme's port belongs in a browser URL. ssh:// and git://
        // carry the port of the git transport, which the web UI does not answer
        // on, so ssh://git@host:2222/o/r must still link to https://host/...
        const isWebScheme = parsed.protocol === 'https:' || parsed.protocol === 'http:';
        host = isWebScheme && parsed.port ? `${hostname}:${parsed.port}` : hostname;
        pathPart = parsed.pathname;
    } else {
        const match = SCP_LIKE.exec(trimmed);
        if (!match) {
            return null;
        }
        // SCP-like syntax has no port: the colon separates host from path.
        hostname = match[1].toLowerCase();
        host = hostname;
        pathPart = match[2];
    }

    const ownerRepo = splitOwnerRepo(pathPart);
    if (!ownerRepo) {
        return null;
    }

    const normalizedHostTypes = normalizeCustomHostTypes(customHostTypes);
    const platform =
        BUILT_IN_HOSTS[hostname] ||
        (Object.hasOwn(normalizedHostTypes, hostname) && Object.hasOwn(PLATFORMS, normalizedHostTypes[hostname])
            ? normalizedHostTypes[hostname]
            : null) ||
        inferPlatform(hostname);
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
 * Would this URL have been produced by `buildCommitUrl`?
 *
 * The webview never receives a permalink; it sends a finding index back and the
 * address is rebuilt here. This is the second line of that defence: it is what
 * stops `openExternal` becoming a launcher for an arbitrary address if a URL
 * ever reaches it from somewhere less trusted.
 *
 * Checking scheme and hostname was not enough to answer the question the name
 * asks. `https://github.com/anything` passed, and so did any path on a
 * self-hosted host once its hostname matched. The URL is now taken apart along
 * the platform's own layout, the commit is required to be a hex SHA, and the
 * address is rebuilt with the same builder that writes permalinks and compared
 * byte for byte -- so anything the layout pattern let through (a normalised
 * path, a query string, credentials, a port, the wrong anchor form) fails here.
 *
 * With remoteInfo the owner and repository are pinned to the scanned repository
 * as well, which is the only check that keeps a self-hosted host from resolving
 * to somebody else's project on the same server.
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

    // Platform is keyed on the portless hostname; the authority is what the
    // builder writes and is what has to match the repository's own remote,
    // port included, for a self-hosted instance on a non-default port.
    const hostname = parsed.hostname.toLowerCase();
    const authority = parsed.host.toLowerCase();
    // Without a remote to pin it to, only the well-known SaaS hosts are
    // recognised, and the URL still has to be shaped like a commit permalink.
    const platform = remoteInfo && remoteInfo.platform
        ? remoteInfo.platform
        : BUILT_IN_HOSTS[hostname];
    if (!platform || !Object.hasOwn(PLATFORMS, platform)) {
        return false;
    }
    if (remoteInfo) {
        if (authority !== String(remoteInfo.host || '').toLowerCase()) {
            return false;
        }
    } else if (parsed.port) {
        // No well-known SaaS host serves permalinks on a custom port, and with
        // no remote to compare against there is nothing that would justify one.
        return false;
    }

    const layout = PLATFORMS[platform].path.exec(parsed.pathname);
    if (!layout) {
        return false;
    }
    const { owner, repo, sha, file } = layout.groups;

    if (remoteInfo) {
        if (owner !== encodePath(remoteInfo.owner || '') || repo !== encodeURIComponent(remoteInfo.repo || '')) {
            return false;
        }
    }

    let line = null;
    if (parsed.hash) {
        const anchor = LINE_ANCHOR.exec(parsed.hash);
        if (!anchor) {
            return false;
        }
        line = Number(anchor[1]);
    }

    return PLATFORMS[platform].build(authority, owner, repo, sha, file, line) === url;
}

module.exports = { parseRemote, buildCommitUrl, isPermalinkUrl, SUPPORTED_PLATFORMS };
