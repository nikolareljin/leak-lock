# Release notes, v0.11.0

## Added
- Export either the complete credential and code-issue report or Foxguard code issues only. Code-only reports remain importable and never become history-cleanup candidates.
- Show an inline spinner in credential and Code issues result blocks while another scan stage is still running.

## Fixed
- Resolve bundled credential-lens from the installed extension directory so Windows workspaces cannot redirect its module lookup.
- Raise the default Foxguard timeout from 120 seconds to 10 minutes for longer code scans.
