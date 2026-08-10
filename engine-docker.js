/**
 * Running Gitleaks and TruffleHog from a container image.
 *
 * The native binary is the default: it starts faster, needs no daemon, and reads the
 * repository directly. But it is not always installable — a policy that blocks
 * downloaded executables, an architecture with no published build, a musl host given a
 * glibc binary. On a machine that has Docker, an image is a working scanner, and a
 * working scanner beats a correct explanation of why there is none.
 *
 * Two details decide whether a containerised scan works at all, and both are easy to
 * get wrong in a way that looks like the tool being broken:
 *
 *  1. **`safe.directory`.** Git refuses to operate on a repository owned by a different
 *     user ("detected dubious ownership"), which is exactly what a bind-mounted host
 *     repository looks like from inside a container. Both engines scan git history, so
 *     without this every containerised scan fails on a repository that is perfectly
 *     fine. Passed as environment rather than by writing to the user's git config,
 *     because a scanner must not modify the thing it is auditing.
 *  2. **The container user.** Left as root, anything the container writes to a mounted
 *     directory — Gitleaks' report file — lands on the host owned by root. Running as
 *     the invoking uid keeps the output readable and removable by its owner.
 *
 * No `vscode` import: every argument list below is a pure function of its inputs.
 */

const os = require('os');

/**
 * Pinned images, chosen to match the pinned binary versions so the two runtimes cannot
 * report different rulesets for the same Leak Lock release. Both are the projects' own
 * publications, not third-party rebuilds.
 */
const ENGINE_IMAGES = Object.freeze({
    gitleaks: 'ghcr.io/gitleaks/gitleaks:v8.30.1',
    trufflehog: 'trufflesecurity/trufflehog:3.96.0'
});

/** Where a mounted repository, report directory and config files appear inside. */
const CONTAINER_REPO = '/repo';
const CONTAINER_REPORT = '/report';
const CONTAINER_CONFIG = '/leaklock';

function engineImage(engineId, override) {
    if (typeof override === 'string' && override.trim()) {
        return override.trim();
    }
    return ENGINE_IMAGES[engineId] || null;
}

/**
 * The uid:gid to run as, or null where the concept does not apply.
 *
 * Windows containers have no uid mapping and Docker Desktop handles ownership itself,
 * so passing `--user` there breaks the run instead of fixing the file mode.
 */
function containerUser(platform = process.platform) {
    if (platform === 'win32' || typeof process.getuid !== 'function') {
        return null;
    }
    return `${process.getuid()}:${process.getgid()}`;
}

/**
 * `docker run` for one engine invocation.
 *
 * @param {object} options
 * @param {string} options.image
 * @param {Array<{host: string, container: string, readOnly?: boolean}>} [options.mounts]
 * @param {string[]} [options.args] arguments passed to the image entrypoint
 */
function buildDockerRunArgs({ image, mounts = [], args = [], platform = process.platform, user } = {}) {
    const runArgs = ['run', '--rm'];

    for (const mount of mounts) {
        runArgs.push('-v', `${mount.host}:${mount.container}${mount.readOnly ? ':ro' : ''}`);
    }

    // Git's ownership check, disabled for this process only. GIT_CONFIG_COUNT is the
    // documented way to pass config without a file, so nothing on the host is touched.
    runArgs.push(
        '-e', 'GIT_CONFIG_COUNT=1',
        '-e', 'GIT_CONFIG_KEY_0=safe.directory',
        '-e', 'GIT_CONFIG_VALUE_0=*',
        // Running as a uid with no passwd entry leaves HOME unset, which some tools
        // treat as a fatal error rather than "no cache". /tmp is writable in both
        // images and exists whether or not a report directory was mounted.
        '-e', 'HOME=/tmp'
    );

    const asUser = user === undefined ? containerUser(platform) : user;
    if (asUser) {
        runArgs.push('--user', asUser);
    }

    runArgs.push(image, ...args);
    return runArgs;
}

/** Is the image already on this machine? Never pulls. */
function buildImageInspectArgs(image) {
    return ['image', 'inspect', image];
}

function buildImagePullArgs(image) {
    return ['pull', image];
}

/**
 * The mounts one engine invocation needs, and the paths to use in its arguments.
 *
 * Returned together on purpose: a mount without the matching rewritten path produces a
 * scan of an empty directory that reports zero findings — a silent false clean, the
 * worst failure mode this product has.
 */
function buildScanMounts({ repoDir, reportDir, configPath, baselinePath } = {}) {
    const mounts = [{ host: repoDir, container: CONTAINER_REPO, readOnly: true }];
    const paths = { repoDir: CONTAINER_REPO, reportDir: null, configPath: null, baselinePath: null };

    if (reportDir) {
        mounts.push({ host: reportDir, container: CONTAINER_REPORT });
        paths.reportDir = CONTAINER_REPORT;
    }
    if (configPath) {
        mounts.push({ host: configPath, container: `${CONTAINER_CONFIG}/gitleaks.toml`, readOnly: true });
        paths.configPath = `${CONTAINER_CONFIG}/gitleaks.toml`;
    }
    if (baselinePath) {
        mounts.push({ host: baselinePath, container: `${CONTAINER_CONFIG}/baseline.json`, readOnly: true });
        paths.baselinePath = `${CONTAINER_CONFIG}/baseline.json`;
    }
    return { mounts, paths };
}

/**
 * Why a containerised run failed, in terms of the thing the user can change.
 *
 * Docker's own messages here are famously unhelpful ("Cannot connect to the Docker
 * daemon" appears identically for not-installed, not-running and no-permission).
 */
function describeDockerFailure(message = '') {
    const text = String(message);
    // Docker missing entirely surfaces as a spawn failure, not as a Docker message —
    // "spawn docker ENOENT" on posix, "'docker' is not recognized…" on Windows. Left
    // untranslated it is the least actionable string in the whole flow.
    if (/enoent/i.test(text) || /is not recognized as an internal or external command/i.test(text)
        || /command not found/i.test(text)) {
        return 'Docker is not installed, or is not on the PATH this editor inherited. Install Docker Desktop (Windows/macOS) or the Docker Engine (Linux) and reopen VS Code — or install this engine as a native binary instead, which needs no Docker.';
    }
    if (/permission denied/i.test(text) && /docker\.sock/i.test(text)) {
        return 'Docker is installed but this user cannot reach it. On Linux: `sudo usermod -aG docker $USER`, then log out and back in.';
    }
    if (/cannot connect to the docker daemon|is the docker daemon running/i.test(text)) {
        return os.platform() === 'win32'
            ? 'Docker Desktop is not running. Start it from the Start Menu and try again.'
            : 'The Docker daemon is not running. Start it (`sudo systemctl start docker`, or Docker Desktop) and try again.';
    }
    if (/no such image|manifest unknown|not found/i.test(text)) {
        return 'The image is not present locally. Use "Install as Docker image" in Dependencies Setup to pull it.';
    }
    return text;
}

module.exports = {
    ENGINE_IMAGES,
    CONTAINER_REPO,
    CONTAINER_REPORT,
    CONTAINER_CONFIG,
    engineImage,
    containerUser,
    buildDockerRunArgs,
    buildImageInspectArgs,
    buildImagePullArgs,
    buildScanMounts,
    describeDockerFailure
};
