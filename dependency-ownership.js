const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const run = util.promisify(execFile);

function appStateDir(env = process.env, home = os.homedir(), platform = process.platform) {
    if (platform === 'win32') {
        return path.join(env.LOCALAPPDATA || env.APPDATA || path.join(home, 'AppData', 'Local'), 'Leak Lock');
    }
    if (platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Leak Lock');
    }
    return path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'leak-lock');
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

function isInside(candidate, directory) {
    const relative = path.relative(path.resolve(directory), path.resolve(candidate));
    return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function managedRoots(env = process.env, home = os.homedir(), platform = process.platform) {
    if (platform === 'win32') {
        return [path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Leak Lock')];
    }
    if (platform === 'darwin') {
        return [path.join(home, 'Library', 'Application Support', 'Leak Lock')];
    }
    return [
        path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'leak-lock'),
        path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'leak-lock')
    ];
}

function isManagedPath(filePath, options = {}) {
    return typeof filePath === 'string' && managedRoots(options.env, options.home, options.platform)
        .some(root => isInside(filePath, root));
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
        const name = path.basename(entry.path || '');
        const engines = new Set(['gitleaks', 'gitleaks.exe', 'trufflehog', 'trufflehog.exe', 'foxguard', 'foxguard.exe']);
        if (path.basename(path.dirname(entry.path || '')) !== 'engines' || !engines.has(name)) {
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
    removeSelected
};
