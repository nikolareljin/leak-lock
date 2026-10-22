const { execFileSync } = require('child_process');

const archive = process.argv[2];
if (!archive) throw new Error('Usage: node tools/check-vsix.js <archive>');
const files = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).split('\n');
if (files.some(file => file.startsWith('extension/node_modules/'))) {
    throw new Error('VSIX must not bundle node_modules; runtime dependencies are installed in user storage.');
}
if (files.some(file => /(^|\/)(?:\.env(?:\.|$)|[^/]*\.env)$/.test(file))) {
    throw new Error('VSIX must not contain environment files.');
}
