#!/usr/bin/env node

// The extension executes its CommonJS sources directly. Check every top-level
// source file with Node instead of invoking a transpiler that the package does
// not ship and the runtime never uses.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const sources = fs.readdirSync(root)
    .filter(name => name.endsWith('.js'))
    .map(name => path.join(root, name));

for (const source of sources) {
    const result = spawnSync(process.execPath, ['--check', source], { stdio: 'inherit' });
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

console.log(`Validated ${sources.length} extension source files.`);
