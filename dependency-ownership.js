const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const run = util.promisify(execFile);

function pathFor(platform = process.platform) {
    return platform === 'win32' ? path.win32 : path;
}

function appStateDir(env = process.env, home = os.homedir(), platform = process.platform) {
    const platformPath = pathFor(platform);
    if (platform === 'win32') {
        return platformPath.join(env.LOCALAPPDATA || env.APPDATA || platformPath.join(home, 'AppData', 'Local'), 'Leak Lock');
    }
    if (platform === 'darwin') {
        return platformPath.join(home, 'Library', 'Application Support', 'Leak Lock');
    }
    return platformPath.join(env.XDG_STATE_HOME || platformPath.join(home, '.local', 'state'), 'leak-lock');
}

function ownershipFile(options = {}) {
    return path.join(appStateDir(options.env, options.home, options.platform), 'owned-dependencies.json');
}

function readOwned(options = {}) {
    try {
        const owned = JSON.parse(fs.readFileSync(ownershipFile(options), 'utf8'));
        return Array.isArray(owned) ? owned.filter(entry => entry && typeof entry.id === 'string') : [];
    } catch {
        return [];
    }
}

function writeOwned(entries, options = {}) {
    const file = ownershipFile(options);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(entries, null, 2), { mode: 0o600 });
}

function recordOwned(entry, options = {}) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) {
        throw new Error('Owned dependency requires a stable id.');
    }
    const entries = readOwned(options).filter(current => current.id !== entry.id);
    entries.push(entry);
    writeOwned(entries, options);
}

function removeOwned(ids, options = {}) {
    const selected = new Set(ids || []);
    const entries = readOwned(options);
    writeOwned(entries.filter(entry => !selected.has(entry.id)), options);
}

function isInside(candidate, directory, platformPath = path) {
    const relative = platformPath.relative(platformPath.resolve(directory), platformPath.resolve(candidate));
    return relative && !relative.startsWith(`..${platformPath.sep}`) && relative !== '..' && !platformPath.isAbsolute(relative);
}

function managedRoots(env = process.env, home = os.homedir(), platform = process.platform) {
    const platformPath = pathFor(platform);
    if (platform === 'win32') {
        return [
            platformPath.join(env.LOCALAPPDATA || platformPath.join(home, 'AppData', 'Local'), 'Leak Lock'),
            platformPath.join(env.APPDATA || platformPath.join(home, 'AppData', 'Roaming'), 'Leak Lock')
        ];
    }
    if (platform === 'darwin') {
        return [platformPath.join(home, 'Library', 'Application Support', 'Leak Lock')];
    }
    return [
        platformPath.join(env.XDG_DATA_HOME || platformPath.join(home, '.local', 'share'), 'leak-lock'),
        platformPath.join(env.XDG_STATE_HOME || platformPath.join(home, '.local', 'state'), 'leak-lock')
    ];
}

function isManagedPath(filePath, options = {}) {
    const platform = options.platform || process.platform;
    const platformPath = pathFor(platform);
    return typeof filePath === 'string' && managedRoots(options.env, options.home, platform)
        .some(root => isInside(filePath, root, platformPath));
}

function isRecordedEnginePath(entry, options = {}) {
    const platformPath = pathFor(options.platform || process.platform);
    const names = new Set(['gitleaks', 'gitleaks.exe', 'trufflehog', 'trufflehog.exe', 'foxguard', 'foxguard.exe']);
    if (!entry || typeof entry.path !== 'string' || typeof entry.engineDirectory !== 'string') {
        return false;
    }
    const name = platformPath.basename(entry.path);
    return names.has(name)
        && platformPath.basename(entry.engineDirectory) === 'engines'
        && platformPath.resolve(entry.path) === platformPath.resolve(platformPath.join(entry.engineDirectory, name));
}

async function removeEntry(entry, exec = run, options = {}) {
    if (entry.kind === 'file' || entry.kind === 'directory') {
        if (!isManagedPath(entry.path, options)) {
            throw new Error(`Refusing to remove a path outside Leak Lock storage: ${entry.path}`);
        }
        fs.rmSync(entry.path, { recursive: entry.kind === 'directory', force: true });
        return;
    }
    if (entry.kind === 'engine-file') {
        if (!isRecordedEnginePath(entry, options)) {
            throw new Error(`Refusing to remove an unexpected engine path: ${entry.path}`);
        }
        fs.rmSync(entry.path, { force: true });
        return;
    }
    if (entry.kind === 'docker-image') {
        await exec(entry.command || 'docker', ['image', 'rm', entry.image]);
        return;
    }
    if (entry.kind === 'pipx-package') {
        await exec(entry.command || 'pipx', ['uninstall', entry.package]);
        return;
    }
    if (entry.kind === 'pip-user-package') {
        await exec(entry.python, ['-m', 'pip', 'uninstall', '--yes', '--break-system-packages', entry.package]);
        return;
    }
    if (entry.kind === 'homebrew-package') {
        await exec(entry.command || 'brew', ['uninstall', entry.package]);
        return;
    }
    throw new Error(`Unknown owned dependency type: ${entry.kind}`);
}

async function removeSelected(ids, exec = run, options = {}) {
    const wanted = new Set(ids || []);
    const entries = readOwned(options);
    const retained = [];
    const results = [];
    for (const entry of entries) {
        if (!wanted.has(entry.id)) {
            retained.push(entry);
            continue;
        }
        try {
            await removeEntry(entry, exec, options);
            results.push({ id: entry.id, removed: true });
        } catch (error) {
            retained.push(entry);
            results.push({ id: entry.id, removed: false, error: error.message });
        }
    }
    writeOwned(retained, options);
    return results;
}

module.exports = {
    appStateDir,
    ownershipFile,
    readOwned,
    writeOwned,
    recordOwned,
    removeOwned,
    isManagedPath,
    isRecordedEnginePath,
    removeSelected
};
