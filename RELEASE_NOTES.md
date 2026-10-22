# Release notes, v0.11.1

## Added
- Export JSON and printable reports with either the complete credential and code-issue report or Foxguard code issues only. Code-only reports remain importable and never become history-cleanup candidates.
- Show an inline spinner in credential and Code issues result blocks while another scan stage is still running.

## Fixed
- Install git-filter-repo on Linux without writing to the externally managed system Python.
- Keep dependencies across extension reloads and offer a custom uninstall command with cleanup choices.
- Keep credential-lens out of the VSIX. Dependencies Setup installs the pinned package into Leak Lock user storage before scanning.
- Resolve credential-lens from Leak Lock user storage so workspaces cannot redirect module lookup.
- Raise the default Foxguard timeout from 120 seconds to 30 minutes for longer code scans.
- Make npm run build validate the CommonJS sources directly; it no longer invokes an unbundled Babel command.
