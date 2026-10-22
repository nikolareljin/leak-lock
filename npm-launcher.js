const fs = require('fs');
const path = require('path');

async function resolveNpmCommand(command, run, platform = process.platform) {
    if (platform !== 'win32' || command !== 'npm') {
        return command;
    }
    try {
        const { stdout } = await run('where.exe', ['npm'], { windowsHide: true });
        return String(stdout).split(/\r?\n/).map(line => line.trim()).find(Boolean) || command;
    } catch {
        return command;
    }
}

function npmInvocation(command, args, options = {}) {
    const platform = options.platform || process.platform;
    if (platform !== 'win32' || !/\.cmd$/i.test(command)) {
        return { command, args };
    }

    const platformPath = options.path || path.win32;
    const existsSync = options.existsSync || fs.existsSync;
    const directory = platformPath.dirname(command);
    const node = platformPath.join(directory, 'node.exe');
    const cli = platformPath.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!existsSync(node) || !existsSync(cli)) {
        throw new Error(`npm was found at ${command}, but its Node.js runtime is incomplete`);
    }
    return { command: node, args: [cli, ...args] };
}

module.exports = { resolveNpmCommand, npmInvocation };
