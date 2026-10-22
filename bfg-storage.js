const os = require('os');
const path = require('path');

function bfgPath(env = process.env, home = os.homedir(), platform = process.platform) {
    if (platform === 'win32') {
        return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Leak Lock', 'bfg.jar');
    }
    if (platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Leak Lock', 'bfg.jar');
    }
    return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'leak-lock', 'bfg.jar');
}

module.exports = { bfgPath };
