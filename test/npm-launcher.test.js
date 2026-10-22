const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveNpmCommand, npmInvocation } = require('../npm-launcher');
const { findInDirs } = require('../binary-lookup');

suite('npm launcher', () => {

    test('prefers npm.cmd over Node.js extensionless wrapper on Windows', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaklock-npm-launcher-'));
        try {
            fs.writeFileSync(path.join(dir, 'npm'), '#!/bin/sh\n', { mode: 0o755 });
            fs.writeFileSync(path.join(dir, 'npm.cmd'), '@echo off\r\n', { mode: 0o755 });
            assert.strictEqual(findInDirs('npm', [dir], 'win32'), path.join(dir, 'npm.cmd'));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('resolves a PATH npm.cmd before launching it on Windows', async () => {
        const command = await resolveNpmCommand(
            'npm',
            async (executable, args) => {
                assert.strictEqual(executable, 'where.exe');
                assert.deepStrictEqual(args, ['npm']);
                return { stdout: 'C:\\Users\\test\\scoop\\shims\\npm.cmd\r\n' };
            },
            'win32'
        );
        assert.strictEqual(command, 'C:\\Users\\test\\scoop\\shims\\npm.cmd');
    });

    test('falls back to the bare command when PATH resolution fails', async () => {
        const command = await resolveNpmCommand('npm', async () => {
            throw new Error('not found');
        }, 'win32');
        assert.strictEqual(command, 'npm');
    });

    test('runs npm.cmd through its adjacent Node.js CLI', async () => {
        const command = 'C:\\Users\\test\\scoop\\shims\\npm.cmd';
        const invocation = await npmInvocation(command, ['--version'], async () => {
            throw new Error('adjacent Node.js should be used');
        }, {
            platform: 'win32',
            existsSync: file => /(?:node\.exe|npm-cli\.js)$/.test(file)
        });
        assert.deepStrictEqual(invocation, {
            command: 'C:\\Users\\test\\scoop\\shims\\node.exe',
            args: ['C:\\Users\\test\\scoop\\shims\\node_modules\\npm\\bin\\npm-cli.js', '--version']
        });
    });

    test('uses the real Node.js path behind a Scoop npm shim', async () => {
        const command = 'C:\\Users\\test\\scoop\\shims\\npm.cmd';
        const realNode = 'C:\\Users\\test\\scoop\\apps\\nodejs\\current\\node.exe';
        const invocation = await npmInvocation(command, ['--version'], async (executable, args) => {
            assert.strictEqual(executable, 'C:\\Users\\test\\scoop\\shims\\node.exe');
            assert.deepStrictEqual(args, ['-p', 'process.execPath']);
            return { stdout: `${realNode}\r\n` };
        }, {
            platform: 'win32',
            existsSync: file => file === 'C:\\Users\\test\\scoop\\shims\\node.exe' || file === realNode
                || file === 'C:\\Users\\test\\scoop\\apps\\nodejs\\current\\node_modules\\npm\\bin\\npm-cli.js'
        });
        assert.deepStrictEqual(invocation, {
            command: realNode,
            args: ['C:\\Users\\test\\scoop\\apps\\nodejs\\current\\node_modules\\npm\\bin\\npm-cli.js', '--version']
        });
    });
});
