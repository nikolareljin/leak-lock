# Testing Setup for Leak Lock Extension

This document explains the testing configuration for the Leak Lock VS Code extension.

## Test Configuration

### Local Testing
Run tests locally with:
```bash
npm test
```

### CI/CD Testing
The GitHub Actions workflow automatically runs tests in a headless environment using:
- Ubuntu latest
- Node.js 18
- Xvfb (X Virtual Framebuffer) for headless display
- VS Code 1.96.0

### Test Files
- `test/extension.test.js` - Main extension tests
- `.vscode-test.mjs` - Test configuration
- `.github/workflows/publish.yml` - CI/CD pipeline

### Configuration Details

The `.vscode-test.mjs` file configures:
- VS Code version: 1.96.0
- Test files pattern: `test/**/*.test.js`
- Mocha UI: TDD style
- Timeout: 20 seconds
- Launch args for headless mode

### Headless Mode
For CI environments, VS Code runs with these flags:
- `--disable-extensions` - Prevents conflicts
- `--disable-gpu` - Disables GPU acceleration
- `--no-sandbox` - Required for container environments
- `--disable-dev-shm-usage` - Prevents shared memory issues
- `--disable-web-security` - Allows testing in restricted environments

### Troubleshooting

If tests fail with display errors:
1. Ensure Xvfb is installed
2. Check that all required system libraries are available
3. Verify VS Code version compatibility
4. Review test timeout settings

Common issues:
- Missing X server: Fixed by Xvfb setup
- Platform initialization errors: Fixed by launch args
- Extension activation timeouts: Increased timeout to 20s