const { execFileSync } = require('child_process');

const archive = process.argv[2];
if (!archive) throw new Error('Usage: node tools/check-vsix.js <archive>');
const files = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).split('\n');
const required = 'extension/node_modules/@nikolareljin/credential-lens/src/index.js';
if (!files.includes(required)) {
    throw new Error(`VSIX is missing ${required}`);
}
