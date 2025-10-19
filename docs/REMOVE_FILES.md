# 🗑️ Remove Files Flow

This document explains the Remove Files feature that helps you remove unwanted files or directories from your git history using BFG, directly from the main panel.

## Overview

- Launch from the sidebar: "🗑️ Remove files"
- Uses a guided main-panel interface
- Select repository, pick files/directories, prepare BFG, confirm and run
- BFG tool: https://rtyley.github.io/bfg-repo-cleaner/ — fast, safe history cleanup

## Steps

1) Select repository
- Choose the git repository root to operate on

2) Select files or directories
- Multi-select allowed
- Only items inside the repo are accepted

3) Choose removal mode
- Name-based (BFG): Fast; matches by filename/folder name
- Path-based (Git): Exact repo paths; safer when duplicates exist

4) Grouping options (BFG mode)
- Single combined command (default): Builds one BFG call that matches all selected names
- One command per item: Runs one BFG call per selection (more granular)

5) Prepare the command
- BFG mode: Click "⚙️ Prepare the bfg command" (details show flags and patterns)
- Git mode: Click "🔎 Preview matches (branches, remotes, tags)" to list exact matches, then "⚙️ Prepare the git command"
  - Note: The extension automatically runs `git fetch --all --tags --prune` before preview and execution.

6) Confirm and run
- Final step is highlighted in red
- For BFG: Click "❗ Confirm and run BFG removal"
- For Git: Click "❗ Confirm and run path-based removal"
- The extension runs BFG and then performs `git reflog expire` + `git gc`

## Granular Deletion Feedback

For every selected item (BFG mode), we show:
- `flag`: `--delete-files` for files, `--delete-folders` for directories
- `pattern`: The filename or folder name used by BFG

Notes:
- BFG matches by name across history, not by full path
- Deleting a folder removes any directory with that name across the repository’s history
- Path-based (Git) mode uses exact repo-relative paths across branches

## Safety

- This permanently rewrites git history — create a backup first
- Coordinate with your team and use `git push --force-with-lease` afterwards

## Troubleshooting

- Ensure Java is installed for BFG execution
- If command fails, copy the generated command and run it manually in a terminal
