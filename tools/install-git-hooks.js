#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const gitDir = path.join(root, '.git');
const hooksDir = path.join(root, '.githooks');

if (!fs.existsSync(gitDir) || !fs.existsSync(hooksDir)) {
  process.exit(0);
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'ignore' });
  console.log('Configured git hooks from .githooks.');
} catch (error) {
  console.warn(`Could not configure git hooks: ${error.message}`);
}
