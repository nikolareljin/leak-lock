# 🗑️ Remove Files Flow

This document explains the Remove Files feature that helps you remove unwanted files or directories from your git history using BFG or git filter-branch, directly from the main panel.

## Overview

- Launch from the sidebar: "🗑️ Remove files"
- Uses a guided main-panel interface
- Select repository, pick files/directories, prepare commands (BFG or Git), confirm and run
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
  - Note: The extension automatically runs `git fetch --prune --tags` before preview and execution.
- Preparing produces a complete, reviewable bash script — copy it, or use "💾 Save as .sh"

6) Confirm and run
- Final step is highlighted in red
- For BFG: Click "❗ Confirm and run BFG removal"
- For Git: Click "❗ Confirm and run path-based removal"
- The extension runs the rewrite and then performs `git reflog expire` + `git gc`

## Ref-Complete Rewrites

`git push --force --all` expands to `refs/heads/*` only. A branch that exists solely as
`refs/remotes/origin/*` gets rewritten locally but is never pushed, so the removed file
survives on the server and reappears on the next fetch.

Leak Lock closes that gap. Every rewrite — BFG, `filter-branch`, and `filter-repo`, whether run
from the panel or from the generated script — follows the same sequence:

1. `git fetch --prune --tags origin` — refresh every ref
2. **Preflight**: abort if any local branch holds commits the remote lacks (step 4 would discard them)
3. Detach `HEAD` — git refuses to force-update the checked-out branch
4. Create/reset a local branch for **every** remote branch
5. Rewrite across all refs
6. Delete `refs/original/*`, expire the reflog, `git gc`
7. Force-push every branch and tag in one atomic transaction: `git push --force --atomic <remote> 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'`
8. Restore the originally checked-out branch
9. Re-fetch and verify **every** remote branch and tag is clean

### Preflight blocking

If a local branch is ahead of its remote, preparation stops and lists the branches with their
unpushed commit counts. Push them first, then prepare again. Nothing is rewritten or pushed
while the block is active.

### Push plan

Before you run anything, the panel lists the refs that will be force-updated, the remote-only
branches that were materialised so they are not skipped, the local-only branches that will be
created on the remote, and the tags involved.

### Why `--atomic`

Without it, a rejected ref (a protected branch, for example) leaves the remote half-rewritten:
some branches clean, others still leaking. `--atomic` makes the server reject the entire push
instead.

### `git filter-repo` and the origin remote

`filter-repo` removes the `origin` remote by design. Leak Lock captures the URL beforehand and
restores the remote before pushing.

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
- Coordinate with your team: everyone must re-clone or hard-reset after the rewrite
- Materialising remote branches force-resets local branches, which is why unpushed local
  commits block the rewrite instead of being silently discarded

## Troubleshooting

- Ensure Java is installed for BFG execution
- If command fails, copy the generated command and run it manually in a terminal
