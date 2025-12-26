# Repository Guidelines

## Project Structure & Module Organization
This repo is a VS Code extension. Most runtime code lives at the root as plain JS modules (e.g., `extension.js`, `file-scan.js`, `project-scan.js`, `leakLockPanel.js`, `leakLockSidebarProvider.js`, `welcomeViewProvider.js`). Tests live under `test/` (e.g., `test/extension.test.js`). Static assets are in `media/` (icons, SVGs). Documentation lives in `docs/` plus top-level files like `README.md` and `IMPLEMENTATION.md`. Local configuration files include `eslint.config.mjs`, `jsconfig.json`, and `.vscode-test.mjs`.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run lint`: run ESLint over the project.
- `npm test`: run the VS Code extension tests via `@vscode/test-cli`.
- `npm run build`: run the Babel build (`babel src --out-dir dist`); ensure `src/` exists before relying on this.
- `test/validate.sh` and `test/test.sh`: ad-hoc validation and smoke tests for local workflows.

## Coding Style & Naming Conventions
Use 2-space indentation in JS. Keep filenames kebab-case when adding new modules (e.g., `file-scan.js`). Stick to descriptive, verb-driven function names for commands (e.g., `scanRepository`, `projectScan`). ESLint (`eslint.config.mjs`) is the source of truth; run `npm run lint` before PRs.

## Testing Guidelines
Tests are JavaScript files under `test/`, typically named `*.test.js`. Run `npm test` to execute the suite. Use `test/test-secrets.js` only as a fixture and never add real credentials. Add tests for new commands or scanning logic when feasible.

## Commit & Pull Request Guidelines
Recent history uses Conventional Commit prefixes (`feat:`, `chore:`, `fix:`). Follow that format with a short, imperative summary. PRs should include a clear description, testing steps, and screenshots when UI/webview changes occur (e.g., updates to `media/` or the sidebar panel).

## Security & Configuration Tips
Do not commit real secrets. Use `test/test-secrets.js` for demos. Configuration is exposed under `leakLock.dependencyHandling` in `package.json`—update docs if you add or change settings.
