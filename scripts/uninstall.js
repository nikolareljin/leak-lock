const fs = require('fs');
const path = require('path');
const ownership = require('../dependency-ownership');

const stateFile = path.join(ownership.appStateDir(), 'uninstall-selection.json');

function writeSelection(selection) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile, JSON.stringify(selection), { mode: 0o600 });
}

function consumeSelection() {
    try {
        const selection = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        fs.rmSync(stateFile, { force: true });
        return selection;
    } catch {
        return null;
    }
}

async function removeSelected(selection, exec) {
    if (!selection || !Array.isArray(selection.ids)) return [];
    return ownership.removeSelected(selection.ids, exec);
}

if (require.main === module) {
    removeSelected(consumeSelection()).catch(() => process.exitCode = 0);
}

module.exports = { stateFile, writeSelection, consumeSelection, removeSelected };
