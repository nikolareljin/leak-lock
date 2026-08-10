/**
 * Native engine installation (Gitleaks, TruffleHog).
 *
 * Dependencies Setup pulled the Nosey Parker image and downloaded BFG, then reported
 * success — while Gitleaks and TruffleHog, the two engines a default scan actually
 * runs, had no installation step at all. Nothing about them was "too strict": no
 * install was ever attempted, on any platform.
 *
 * Both projects do publish Docker images, and a container is a legitimate way to run
 * either — but Leak Lock's adapters invoke them as local executables, so a `docker
 * pull` would not have satisfied them. This module therefore installs the release
 * binary, and Docker stays a requirement of the optional Nosey Parker engine alone.
 *
 * Rules this module follows:
 *
 *  1. **Per-engine, isolated.** Installing one engine cannot be blocked by another
 *     failing. Every entry point returns a per-engine result rather than throwing.
 *  2. **Pinned first, latest as fallback.** A pinned version makes an install
 *     reproducible; refusing to install anything when that exact tag is unreachable
 *     turns reproducibility into an outage. The pin is tried first, then the current
 *     upstream release, and the result records which one was used.
 *  3. **Integrity is checked when it can be.** Each release publishes a
 *     `checksums.txt`; a downloaded artifact is rejected on mismatch. If the checksums
 *     file itself is unreachable, the install proceeds and says so — an unverified
 *     install the user can see beats no scanner at all, but it is never silent.
 *  4. **Nothing is trusted out of the archive.** Extraction goes to a temporary
 *     directory and only the expected executable name is copied into the install
 *     directory, after confirming the resolved path is still inside the extract root.
 *
 * No `vscode` import (same rule as git-rewrite.js and scan-engines.js): every naming,
 * URL, command and resolution decision below is a pure function so it can be asserted
 * for Windows from a Linux test runner.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const { execFile } = require('child_process');

const execFileAsync = util.promisify(execFile);

const DOWNLOAD_TIMEOUT_MS = 300000; // 5 minutes: these archives run to tens of MB.
const COMMAND_TIMEOUT_MS = 120000;

/**
 * Release layout per engine.
 *
 * Both projects publish GoReleaser artifacts named
 * `<tool>_<version>_<os>_<arch>.<ext>`, but they disagree on the architecture
 * vocabulary (Gitleaks says `x64`/`x32`, TruffleHog says `amd64`) and on the Windows
 * container (Gitleaks ships `.zip`, TruffleHog ships `.tar.gz` everywhere). Getting
 * either wrong yields a 404 that looks exactly like "not released for your platform",
 * so the mapping is data here and asserted in tests rather than built inline.
 *
 * `pinnedVersion` is a known-good release, not a ceiling: `latestFallback` means an
 * unreachable pin degrades to the current release instead of failing the install.
 */
const ENGINE_RELEASES = Object.freeze({
    gitleaks: Object.freeze({
        id: 'gitleaks',
        displayName: 'Gitleaks',
        repo: 'gitleaks/gitleaks',
        pinnedVersion: '8.30.1',
        executable: 'gitleaks',
        versionArgs: ['version'],
        // process.arch -> the token in the asset name, per platform.
        archNames: Object.freeze({
            win32: Object.freeze({ x64: 'x64', arm64: 'arm64', ia32: 'x32' }),
            linux: Object.freeze({ x64: 'x64', arm64: 'arm64', ia32: 'x32', arm: 'armv7' }),
            darwin: Object.freeze({ x64: 'x64', arm64: 'arm64' })
        }),
        extensions: Object.freeze({ win32: 'zip', linux: 'tar.gz', darwin: 'tar.gz' })
    }),
    trufflehog: Object.freeze({
        id: 'trufflehog',
        displayName: 'TruffleHog',
        repo: 'trufflesecurity/trufflehog',
        pinnedVersion: '3.96.0',
        executable: 'trufflehog',
        versionArgs: ['--version'],
        archNames: Object.freeze({
            win32: Object.freeze({ x64: 'amd64', arm64: 'arm64' }),
            linux: Object.freeze({ x64: 'amd64', arm64: 'arm64' }),
            darwin: Object.freeze({ x64: 'amd64', arm64: 'arm64' })
        }),
        // TruffleHog ships a tarball for Windows too, so a zip-on-Windows assumption
        // would 404 for the engine that verifies live credentials.
        extensions: Object.freeze({ win32: 'tar.gz', linux: 'tar.gz', darwin: 'tar.gz' })
    })
});

/** Engines this module can install. Nosey Parker is a Docker image and is not one. */
const INSTALLABLE_ENGINE_IDS = Object.freeze(Object.keys(ENGINE_RELEASES));

const PLATFORM_NAMES = Object.freeze({ win32: 'windows', linux: 'linux', darwin: 'darwin' });

function releaseInfo(engineId) {
    return ENGINE_RELEASES[engineId] || null;
}

/** `8.30.1`, `v8.30.1` and `V8.30.1` all mean the same release. */
function normaliseVersion(version) {
    return String(version || '').trim().replace(/^v/i, '');
}

/**
 * The release asset for this engine on this platform, or null if none exists.
 *
 * Returning null rather than a plausible-but-wrong name matters: a guessed name
 * downloads a 404 page, and the failure then reads as a network problem instead of
 * "there is no build for your architecture".
 */
function buildAssetName(engineId, version, platform = process.platform, arch = process.arch) {
    const info = releaseInfo(engineId);
    const osName = PLATFORM_NAMES[platform];
    if (!info || !osName) {
        return null;
    }
    const archName = info.archNames[platform]?.[arch];
    if (!archName) {
        return null;
    }
    return `${info.id}_${normaliseVersion(version)}_${osName}_${archName}.${info.extensions[platform]}`;
}

/** Why no asset exists, in words a user can act on. */
function describeUnsupportedPlatform(engineId, platform = process.platform, arch = process.arch) {
    const info = releaseInfo(engineId);
    if (!info) {
        return `${engineId} is not an installable native engine.`;
    }
    const osName = PLATFORM_NAMES[platform];
    if (!osName) {
        return `${info.displayName} publishes no release build for platform "${platform}".`;
    }
    const supported = Object.keys(info.archNames[platform] || {}).join(', ') || 'none';
    return `${info.displayName} publishes no ${osName} build for architecture "${arch}" `
        + `(available: ${supported}). Install it manually and set leakLock.${info.id}.binaryPath.`;
}

function buildAssetUrl(engineId, version, assetName) {
    const info = releaseInfo(engineId);
    if (!info || !assetName) {
        return null;
    }
    return `https://github.com/${info.repo}/releases/download/v${normaliseVersion(version)}/${assetName}`;
}

function buildChecksumsUrl(engineId, version) {
    const info = releaseInfo(engineId);
    if (!info) {
        return null;
    }
    const v = normaliseVersion(version);
    return `https://github.com/${info.repo}/releases/download/v${v}/${info.id}_${v}_checksums.txt`;
}

function buildLatestReleaseUrl(engineId) {
    const info = releaseInfo(engineId);
    return info ? `https://api.github.com/repos/${info.repo}/releases/latest` : null;
}

/**
 * `<sha256>  <filename>` lines, as published by GoReleaser.
 * Unknown lines are skipped rather than failing the parse: TruffleHog's checksums file
 * is also signed, and a future extra line must not cost the integrity check.
 */
function parseChecksums(text) {
    const map = new Map();
    for (const line of String(text || '').split('\n')) {
        const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(\S+)$/);
        if (match) {
            map.set(match[2], match[1].toLowerCase());
        }
    }
    return map;
}

/** The file name an executable takes on this platform. */
function executableName(engineId, platform = process.platform) {
    const info = releaseInfo(engineId);
    if (!info) {
        return null;
    }
    return platform === 'win32' ? `${info.executable}.exe` : info.executable;
}

/**
 * How to unpack a downloaded artifact.
 *
 * `tar` has shipped in Windows since 10 build 17063, and PowerShell's `Expand-Archive`
 * is present on every supported Windows, so neither needs a bundled extractor. The
 * command is built here, not run, so the Windows form is assertable anywhere.
 */
function buildExtractCommand({ archivePath, destDir, platform = process.platform } = {}) {
    if (!archivePath || !destDir) {
        return null;
    }
    if (archivePath.endsWith('.zip')) {
        if (platform === 'win32') {
            const quote = value => `'${String(value).replace(/'/g, "''")}'`;
            return {
                command: 'powershell.exe',
                args: [
                    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
                    `Expand-Archive -LiteralPath ${quote(archivePath)} -DestinationPath ${quote(destDir)} -Force`
                ]
            };
        }
        return { command: 'unzip', args: ['-o', archivePath, '-d', destDir] };
    }
    return { command: 'tar', args: ['-xzf', archivePath, '-C', destDir] };
}

/** Is `candidate` genuinely inside `root`? Guards against archive path traversal. */
function isInsideDirectory(root, candidate) {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(candidate);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

/**
 * Is this a real file, rather than a link pointing somewhere else?
 *
 * `lstat`, never `stat`, and never `existsSync`: both of those follow symlinks, so an
 * archive containing a link named `gitleaks` and pointing at, say, `/etc/shadow` would
 * satisfy every name and containment check and then be copied out of the extract
 * directory by the install. tar restores symlinks faithfully, so this is a property of
 * the archive, not a hypothetical.
 */
function isRegularFile(candidate, fsImpl = fs) {
    try {
        return fsImpl.lstatSync(candidate).isFile();
    } catch {
        return false;
    }
}

/**
 * Find the engine executable inside an extracted archive.
 *
 * Only the expected name is accepted, only from the archive root or one directory below
 * it — the two layouts these projects actually publish — and only if it is a regular
 * file inside the extract directory. Anything else in the tarball is ignored rather
 * than executed.
 */
function resolveExtractedExecutable(extractDir, engineId, platform = process.platform, fsImpl = fs) {
    const wanted = executableName(engineId, platform);
    if (!wanted) {
        return null;
    }
    const direct = path.join(extractDir, wanted);
    if (isRegularFile(direct, fsImpl) && isInsideDirectory(extractDir, direct)) {
        return direct;
    }
    let entries = [];
    try {
        entries = fsImpl.readdirSync(extractDir, { withFileTypes: true });
    } catch {
        return null;
    }
    for (const entry of entries) {
        // isDirectory() on a Dirent is already lstat-based, so a symlinked directory is
        // not descended into either.
        if (!entry.isDirectory()) {
            continue;
        }
        const nested = path.join(extractDir, entry.name, wanted);
        if (isRegularFile(nested, fsImpl) && isInsideDirectory(extractDir, nested)) {
            return nested;
        }
    }
    return null;
}

/**
 * Where downloaded engines live.
 *
 * Kept out of the extension directory: that is replaced wholesale on every extension
 * update, which would silently uninstall the engines the user just installed.
 */
function engineInstallDir(storageRoot) {
    return path.join(storageRoot, 'engines');
}

/**
 * Move a verified staging file onto the final name.
 *
 * Plain `rename` first, and nothing before it: on POSIX rename replaces the destination
 * atomically, so at no instant is the engine absent. Deleting the old copy first would
 * throw that away — and would leave the user with no engine at all if the rename then
 * failed, having destroyed a binary that was working.
 *
 * Windows is the reason the other branches exist: it refuses to rename onto an existing
 * file, so there the old copy has to go first, and if even that fails (the old binary is
 * running) a copy is the last resort. The staging file is removed on every path —
 * leaving a `.installing` file in a directory that is searched for executables is its
 * own small mess.
 */
async function promoteInstalledFile(staging, target) {
    try {
        await fs.promises.rename(staging, target);
        return;
    } catch {
        // Windows: EEXIST/EPERM onto an existing destination. Also covers a staging file
        // that ended up on another device, where rename cannot work at all.
    }
    try {
        await fs.promises.rm(target, { force: true });
        await fs.promises.rename(staging, target);
        return;
    } catch {
        // The destination may be locked by a running process; a copy sometimes succeeds
        // where a rename cannot.
    }
    try {
        await fs.promises.copyFile(staging, target);
    } finally {
        await fs.promises.rm(staging, { force: true });
    }
}

async function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', resolve);
    });
    return hash.digest('hex');
}

/* ------------------------------------------------------------------------- *
 * Injectable side effects. Tests substitute these; nothing here reaches the
 * network or the filesystem through any other path.
 * ------------------------------------------------------------------------- */

async function defaultFetchText(url) {
    const response = await fetch(url, {
        headers: { 'User-Agent': 'leak-lock-vscode-extension' },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return response.text();
}

async function defaultDownload(url, destPath) {
    const response = await fetch(url, {
        headers: { 'User-Agent': 'leak-lock-vscode-extension' },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(destPath, buffer);
}

async function defaultRun(command, args, options = {}) {
    return execFileAsync(command, args, { timeout: COMMAND_TIMEOUT_MS, ...options });
}

/**
 * Read the version back out of an installed binary.
 *
 * The default asks the binary itself; the sidebar passes the engine adapter's own
 * `version()` instead, so what Dependencies Setup reports after an install is produced
 * by the same code path a scan uses to decide the engine exists.
 */
async function defaultVerifyVersion(engineId, exePath, run = defaultRun) {
    const info = releaseInfo(engineId);
    if (!info) {
        return null;
    }
    const { stdout, stderr } = await run(exePath, info.versionArgs);
    const text = `${stdout || ''}${stderr || ''}`.trim();
    const match = text.match(/\d+\.\d+\.\d+/);
    return match ? `v${match[0]}` : (text.split('\n')[0] || null);
}

/**
 * Which versions to try, in order.
 *
 * This is the "less strict" rule: the pin is a preference, not a gate. An install that
 * refuses to proceed because one tag moved or one artifact was withdrawn leaves the
 * user with no scanner, which is strictly worse than a slightly newer one.
 */
async function resolveVersionCandidates(engineId, { version, allowLatestFallback = true, fetchText = defaultFetchText } = {}) {
    const info = releaseInfo(engineId);
    if (!info) {
        return [];
    }
    if (version) {
        return [{ version: normaliseVersion(version), source: 'requested' }];
    }
    const candidates = [{ version: info.pinnedVersion, source: 'pinned' }];
    if (!allowLatestFallback) {
        return candidates;
    }
    try {
        const body = await fetchText(buildLatestReleaseUrl(engineId));
        const tag = normaliseVersion(JSON.parse(body)?.tag_name);
        if (tag && tag !== info.pinnedVersion) {
            candidates.push({ version: tag, source: 'latest' });
        }
    } catch {
        // The pin is still worth trying; the latest lookup is the fallback, not the
        // prerequisite. A rate-limited API must not prevent the pinned install.
    }
    return candidates;
}

/**
 * Install one engine. Never throws: the caller renders the result per engine.
 *
 * @returns {Promise<{engineId: string, displayName: string, ok: boolean, version: ?string,
 *                    path: ?string, source: ?string, checksumVerified: boolean,
 *                    warnings: string[], error: ?string}>}
 */
async function installEngine({
    engineId,
    installDir,
    version = null,
    allowLatestFallback = true,
    platform = process.platform,
    arch = process.arch,
    fetchText = defaultFetchText,
    download = defaultDownload,
    run = defaultRun,
    verifyVersion = null
} = {}) {
    const info = releaseInfo(engineId);
    const result = {
        engineId,
        displayName: info?.displayName || engineId,
        ok: false,
        version: null,
        path: null,
        source: null,
        checksumVerified: false,
        warnings: [],
        error: null
    };

    if (!info) {
        result.error = `${engineId} is not a natively installable engine.`;
        return result;
    }
    if (!buildAssetName(engineId, info.pinnedVersion, platform, arch)) {
        result.error = describeUnsupportedPlatform(engineId, platform, arch);
        return result;
    }

    const candidates = await resolveVersionCandidates(engineId, { version, allowLatestFallback, fetchText });
    const attemptErrors = [];

    for (const candidate of candidates) {
        let workDir = null;
        try {
            const assetName = buildAssetName(engineId, candidate.version, platform, arch);
            workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `leaklock-${engineId}-`));
            const archivePath = path.join(workDir, assetName);

            await download(buildAssetUrl(engineId, candidate.version, assetName), archivePath);

            // Integrity: verified when the checksums file is reachable, and the
            // mismatch case is fatal for this candidate rather than a warning.
            let checksumVerified = false;
            let expected = null;
            try {
                expected = parseChecksums(await fetchText(buildChecksumsUrl(engineId, candidate.version))).get(assetName) || null;
            } catch {
                expected = null;
            }
            if (expected) {
                const actual = await sha256File(archivePath);
                if (actual !== expected) {
                    throw new Error(`checksum mismatch for ${assetName} (expected ${expected}, got ${actual})`);
                }
                checksumVerified = true;
            }

            const extractDir = path.join(workDir, 'extracted');
            await fs.promises.mkdir(extractDir, { recursive: true });
            const extract = buildExtractCommand({ archivePath, destDir: extractDir, platform });
            await run(extract.command, extract.args);

            const extracted = resolveExtractedExecutable(extractDir, engineId, platform);
            if (!extracted) {
                throw new Error(`the ${assetName} archive did not contain ${executableName(engineId, platform)}`);
            }

            await fs.promises.mkdir(installDir, { recursive: true });
            const target = path.join(installDir, executableName(engineId, platform));
            // Staged beside the target, then promoted only once it has proved it runs.
            // Copying to the final name first would leave a broken binary behind on a
            // failed verify — and the install directory is searched ahead of every other
            // location, so that file would be picked up by the next probe and the next
            // scan. A failed install must leave nothing for anything else to find.
            const staging = `${target}.installing`;
            await fs.promises.rm(staging, { force: true });
            await fs.promises.copyFile(extracted, staging);
            if (platform !== 'win32') {
                await fs.promises.chmod(staging, 0o755);
            }

            let reportedVersion;
            try {
                // Verify by running it. A file of the right name that will not execute —
                // wrong architecture, blocked by policy — is the failure this catches,
                // and it is exactly what a "downloaded successfully" message would hide.
                reportedVersion = verifyVersion
                    ? await verifyVersion(engineId, staging)
                    : await defaultVerifyVersion(engineId, staging, run);
                if (!reportedVersion) {
                    throw new Error(
                        `${assetName} was downloaded but reported no version when run; it is present but not executable here`
                    );
                }
            } catch (verifyError) {
                await fs.promises.rm(staging, { force: true });
                throw verifyError;
            }

            await promoteInstalledFile(staging, target);

            result.ok = true;
            result.version = reportedVersion;
            result.path = target;
            result.source = candidate.source;
            result.checksumVerified = checksumVerified;
            if (!checksumVerified) {
                result.warnings.push(
                    `Could not fetch ${info.id}_${candidate.version}_checksums.txt; the download was not checksum-verified.`
                );
            }
            if (candidate.source === 'latest') {
                result.warnings.push(
                    `Pinned version ${info.pinnedVersion} was unavailable; installed the current release ${candidate.version} instead.`
                );
            }
            return result;
        } catch (error) {
            attemptErrors.push(`${candidate.version} (${candidate.source}): ${error.message}`);
        } finally {
            if (workDir) {
                await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
            }
        }
    }

    result.error = `Could not install ${info.displayName}. Tried ${attemptErrors.join('; ')}`;
    return result;
}

/**
 * What to do when an automated install fails or is declined.
 *
 * Windows gets its own text because the usual advice — "put it on your PATH" — is the
 * one thing that reliably does not work there: a GUI-launched VS Code inherits the
 * PATH from the shell that started Explorer, not from the terminal where the user just
 * ran `winget install`, so a correctly installed engine still reads as missing until
 * the machine is signed out or the binary path is set explicitly.
 */
function manualInstallGuidance(engineId, platform = process.platform) {
    const info = releaseInfo(engineId);
    if (!info) {
        return '';
    }
    const setting = `leakLock.${info.id}.binaryPath`;
    if (platform === 'win32') {
        return `Install ${info.displayName} manually from https://github.com/${info.repo}/releases, `
            + `then set "${setting}" to the full path of ${executableName(engineId, platform)} `
            + `(for example C:\\Tools\\${executableName(engineId, platform)}). `
            + `Adding it to PATH is not enough on Windows unless VS Code is restarted from a new session — `
            + `a window launched from the Start Menu does not see a PATH change made in a terminal.`;
    }
    return `Install ${info.displayName} manually from https://github.com/${info.repo}/releases `
        + `or your package manager, then set "${setting}" if it lives outside the usual bin directories.`;
}

/**
 * Install several engines, isolating failures.
 *
 * Sequential on purpose: two concurrent multi-megabyte downloads on a slow link make
 * both look hung, and the progress reporting has one line.
 */
async function installEngines(engineIds, options = {}) {
    const results = [];
    for (const engineId of engineIds) {
        results.push(await installEngine({ ...options, engineId }));
        if (typeof options.onProgress === 'function') {
            options.onProgress(results[results.length - 1]);
        }
    }
    return results;
}

module.exports = {
    ENGINE_RELEASES,
    INSTALLABLE_ENGINE_IDS,
    PLATFORM_NAMES,
    normaliseVersion,
    buildAssetName,
    describeUnsupportedPlatform,
    buildAssetUrl,
    buildChecksumsUrl,
    buildLatestReleaseUrl,
    parseChecksums,
    executableName,
    buildExtractCommand,
    isInsideDirectory,
    isRegularFile,
    resolveExtractedExecutable,
    engineInstallDir,
    promoteInstalledFile,
    sha256File,
    // The one download implementation. Exported so nothing else in the extension grows
    // a second one — a shelled-out `curl` interpolates paths into a command line and
    // depends on a tool that may not be there.
    downloadFile: defaultDownload,
    manualInstallGuidance,
    resolveVersionCandidates,
    installEngine,
    installEngines
};
