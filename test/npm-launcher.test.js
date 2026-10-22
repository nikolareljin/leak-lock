const assert = require('assert');
const { resolveNpmCommand, npmInvocation } = require('../npm-launcher');

suite('npm launcher', () => {

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

    test('runs npm.cmd through its adjacent Node.js CLI', () => {
        const command = 'C:\\Users\\test\\scoop\\shims\\npm.cmd';
        const invocation = npmInvocation(command, ['--version'], {
            platform: 'win32',
            existsSync: file => /(?:node\.exe|npm-cli\.js)$/.test(file)
        });
        assert.deepStrictEqual(invocation, {
            command: 'C:\\Users\\test\\scoop\\shims\\node.exe',
            args: ['C:\\Users\\test\\scoop\\shims\\node_modules\\npm\\bin\\npm-cli.js', '--version']
        });
    });
});
