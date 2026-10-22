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

async function npmInvocation(command, args, run, options = {}) {
    const platform = options.platform || process.platform;
    if (platform !== 'win32' || !/\.cmd$/i.test(command)) {
        return { command, args };
    }

    const platformPath = options.path || path.win32;
    const existsSync = options.existsSync || fs.existsSync;
    const fromNode = node => {
        const cli = platformPath.join(platformPath.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
        return existsSync(node) && existsSync(cli) ? { command: node, args: [cli, ...args] } : null;
    };

    const adjacent = fromNode(platformPath.join(platformPath.dirname(command), 'node.exe'));
    if (adjacent) {
        return adjacent;
    }

    // Scoop and similar managers put npm.cmd in a shim directory. node.exe can
    // run directly, and process.execPath names the real installation behind it.
    try {
        const { stdout: nodeLaunchers } = await run('where.exe', ['node'], { windowsHide: true });
        const nodeLauncher = String(nodeLaunchers).split(/\r?\n/).map(line => line.trim()).find(Boolean);
        if (nodeLauncher) {
            const { stdout: nodePath } = await run(nodeLauncher, ['-p', 'process.execPath'], { windowsHide: true });
            const invocation = fromNode(String(nodePath).trim());
            if (invocation) {
                return invocation;
            }
        }
    } catch {
        // Fall through to the single actionable error below.
    }
    throw new Error(`npm was found at ${command}, but its Node.js runtime is incomplete`);
}

module.exports = { resolveNpmCommand, npmInvocation };
