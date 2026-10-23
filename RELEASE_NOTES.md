# Release notes, v0.11.1

## Added
- Export JSON and printable reports with either the complete credential and code-issue report or Foxguard code issues only. Code-only reports remain importable and never become history-cleanup candidates.
- Show an inline spinner in credential and Code issues result blocks while another scan stage is still running.

## Fixed
- Install git-filter-repo on Linux without writing to the externally managed system Python.
- Keep dependencies across extension reloads and offer a custom uninstall command with cleanup choices.
- Keep credential-lens out of the VSIX. Dependencies Setup installs the pinned package into Leak Lock user storage before scanning.
- Resolve credential-lens from Leak Lock user storage so workspaces cannot redirect module lookup.
- Launch Windows npm.cmd launchers through Node.js, including Scoop shims.
- Make Windows TruffleHog history scans find Git when VS Code does not inherit the Git for Windows PATH entry.
- Show Windows, macOS, and Linux Node.js/npm installation instructions when credential-lens cannot run npm.
- Upgrade credential-lens when the stored runtime version differs from the locked package version.
- Raise the default Foxguard timeout from 120 seconds to 30 minutes for longer code scans.
- Make npm run build validate the CommonJS sources directly; it no longer invokes an unbundled Babel command.
