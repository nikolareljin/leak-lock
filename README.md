<p align="center">
  <img src="https://github.com/nikolareljin/leak-lock/blob/main/media/icon.png?raw=true&sanitize=true" width="128" height="128" />
</p>

# 🛡️ Leak Lock - VS Code Security Extension

**Secure your code repositories by detecting and removing sensitive information from git history**

[![Version](https://img.shields.io/badge/version-0.7.0-blue.svg)](package.json)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.96.0+-brightgreen.svg)](https://code.visualstudio.com/)

[🌐 Website](https://nikolareljin.github.io/leak-lock/) • [📖 Documentation](#documentation) • [🚀 Quick Start](#quick-start) • [📸 Screenshots](#screenshots) • [🛠️ Development](#development)

---

## Overview

Leak Lock is a powerful VS Code extension that helps developers secure their repositories by:

- 🔍 **Scanning** git repositories for secrets, API keys, and sensitive data
- 🛡️ **Detecting** credentials with **multiple engines** — Gitleaks, TruffleHog and Nosey Parker — merged into one attributed result set
- ✅ **Verifying** whether a discovered credential is still live (TruffleHog)
- ✏️ **Removing** both detected secrets and **arbitrary text you specify** from git history
- 📋 **Reporting** exactly what was scanned, so "no findings" is a claim you can check
- ⚡ **Automating** the complete security remediation workflow

## ✨ Key Features

### 🎯 **Multi-Engine Detection**
- **Several engines, one result set**: Gitleaks (default), TruffleHog and Nosey Parker run together; findings are merged and every finding names the engines that found it — and the ones that missed it
- **Live credential verification**: TruffleHog can confirm whether a key still works. A live credential outranks everything else, because rewriting history does not revoke it
- **Full history, every ref**: refs are refreshed before scanning, so a branch that exists only on the remote is not silently skipped
- **Working tree too**: untracked and ignored files (a local `.env`) are found and flagged as not-committed, since those are fixed by deleting the file, not by rewriting history
- **No silent truncation**: results are never capped without saying so

### ✏️ **Manual Redaction**
- **Source text → Replace with**: remove content no scanner flags — an internal hostname, a private repository or team name, a customer identifier
- **Literal or regex** matching, validated before it can be used
- **Dry run first**: see which commits, files and branches a rule touches before anything is rewritten

### 🖥️ **Modern Interface**
- **Main Area Display**: Wide layout perfect for scan results
- **Activity Bar Integration**: Easy access via shield icon
- **Smart Directory Selection**: Auto-detects git repositories
- **Progress Tracking**: Real-time scanning and remediation progress
- **Remove Files Flow**: Sidebar button opens guided removal UI in main area
 - **Path-Based Safe Removal**: Exact path deletion across branches with preview
- **Results Export**: Export findings to JSON or print/save as PDF directly from the results view

### 🤖 **Automated Workflow**
- **One-Click Dependency Install**: Docker, Nosey Parker, BFG tool
- **Intelligent Scanning**: Context-aware repository analysis
- **Guided Remediation**: Step-by-step secret removal process
- **Git History Cleanup**: Automatic history rewriting and cleanup
- **Granular Deletion Feedback**: Per-item BFG flags and patterns preview
- **Preview Before Delete**: Show exact matches across branches, remotes, and tags for path-based deletions
 - **Auto-Fetch Remotes**: Fetches all remotes and tags before preview and execution

---

## 🚀 Quick Start

### 1. Installation
```bash
# Install from VS Code Marketplace
code --install-extension nikolareljin.leak-lock

# Or install from a VSIX downloaded from the Releases page
code --install-extension leak-lock-*.vsix
```

### 2. Open Leak Lock
- **Activity Bar**: Click the 🛡️ shield icon
- **Command Palette**: `Ctrl+Shift+P` → "Open Leak Lock Scanner"
- **Status Bar**: Click the shield icon

### 3. Install Dependencies
- Click "🔧 Install Dependencies" on first use
- Installs Docker images, BFG tool, and requirements
- One-time setup with progress tracking

### 4. Scan Repository
- **Auto-Detection**: Git repositories selected automatically
- **Manual Selection**: Choose any directory to scan
- **Review Results**: Examine detected secrets in detailed table

### 5. Remove Secrets
- **Select Secrets**: Choose which ones to remove
- **Generate Commands**: Automatic BFG command generation
- **Execute Cleanup**: One-click git history rewriting

### 6. Export Scan Results (New)
- **Export JSON**: Save all current findings and metadata to a `.json` file
- **Print / Save as PDF**: Use the print-friendly view from scan results for PDF reports
- **Share Findings**: Attach exports to tickets, audits, or remediation docs

<img width="942" height="1307" alt="image" src="https://github.com/user-attachments/assets/1c0ca6c4-1254-4337-b893-ee26c94f95e3" />


---

### 6.1 Optional Keyword Search in Git History (New)
- Open VS Code settings for Leak Lock.
- Enable `leakLock.gitHistoryKeywordSearch.enabled`.
- Configure keywords in `leakLock.gitHistoryKeywordSearch.keywords`.
- Optionally tune:
  - `leakLock.gitHistoryKeywordSearch.searchCommitMessages`
  - `leakLock.gitHistoryKeywordSearch.searchFileHistory`
  - `leakLock.gitHistoryKeywordSearch.searchFileNames`
  - `leakLock.gitHistoryKeywordSearch.maxMatchesPerKeyword`
  - `leakLock.gitHistoryKeywordSearch.shortKeywordFileHistoryMaxCount`

Note: `leakLock.gitHistoryKeywordSearch.searchFileNames` is disabled by default (opt-in) because it can increase scan time on large repositories.

Default keyword profile (designed for attribution-policy and secret hygiene):
- Agent/AI attribution terms: `agent`, `assistant`, `claude`, `codex`, `copilot`, `gemini`, `gpt`, `chatgpt`, `openai`, `anthropic`, `aider`, `cursor`, `windsurf`, `meldbot`, `openclaw`, `nanoclaw`
- Sensitive terms: `password`, `ldap`, `ldap_password`, `bind_password`, `bind_dn`, `token`, `access_token`, `auth_token`, `api_key`, `secret`, `client_secret`, `credentials`, `private_key`, `ssh_key`, `id_rsa`
The keyword list can include arbitrary text terms and filename fragments, not only predefined security words.

Example use case:
- Detect commit messages that mention coding agents.
- Detect potentially sensitive terms in historical file changes.
- Detect historical filenames that include specific terms (for example `id_rsa`, `secrets`, or custom naming conventions).

### 7. Remove Unwanted Files (New)
- Open from sidebar: click "🗑️ Remove files"
- Select repository (git root)
- Choose multiple files and/or directories
- Option A (fast): BFG, name-based grouping (single or per-item)
- Option B (safe): Git path-based, exact paths across branches
- Click "🔎 Preview matches" for path-based mode to see exact files across branches, remotes, and tags
- Remotes are fetched automatically to avoid missing references
- Prepare and review the generated script (copy it, or "💾 Save as .sh")
- Final step (red): confirm to run (BFG or Git) and rewrite history

### 8. Ref-Complete History Rewrites (New in 0.6.0)
`git push --force --all` only pushes `refs/heads/*`, so a branch that exists solely on the
remote keeps its leaked history. Every Leak Lock rewrite now materialises a local branch for
each remote branch first, pushes with `--atomic`, and verifies every remote branch and tag
afterwards. See [docs/REMOVE_FILES.md](docs/REMOVE_FILES.md#ref-complete-rewrites).

- **Preflight** blocks the rewrite if local branches hold unpushed commits (they would be discarded)
- **Push plan** lists every ref that will be force-updated or created, before you run anything
- **Verification** reports any ref where the secret or file survived

### 9. Selecting What Gets Cleaned (New in 0.6.0)
- Per-finding checkboxes, a header select-all, and `Select all` / `Clear all` buttons
- A live "N of M cleanable findings selected" counter
- Selections and custom replacement values persist across panel refreshes (previously,
  preparing a command re-checked everything)

---

## 📸 Screenshots

> Captured from a **real scan of [damn-vulnerable-repo](https://github.com/nikolareljin/damn-vulnerable-repo)**,
> the public test fixture — cloned fresh, seeded, and scanned with Gitleaks, TruffleHog
> and Nosey Parker together, then rendered from the extension's own webview.
>
> The run found **31 findings merged from 62 raw detections** (Nosey Parker 23 · Gitleaks
> 27 · TruffleHog 12); the table shows six of them, sampled to span the three engines.
> **Every credential in that repository is fake by construction** — AWS's own published
> `AKIAIOSFODNN7EXAMPLE`, Stripe `sk_test_` keys, hostnames under the reserved `.example`
> TLD that can never resolve, and tokens whose "random" part is the alphabet in order.
> Nothing carries a `VERIFIED LIVE` badge because there is nothing live to verify.
> See [docs/TEST_FIXTURE.md](docs/TEST_FIXTURE.md).
>
> Regenerate the webview images with `tools/real-scan.js` and
> `tools/render-screenshots.js` (views: `results`, `empty`, `sidebar`, `keywords`,
> `removeFiles`, `prepared`, `pushPlan`, `protected`, `verified`). The two full-editor shots are taken
> from a live VS Code window, since the sidebar and activity bar are editor chrome the
> renderer cannot produce — and they come from a separate run against the same fixture,
> which is why the finding count differs from the figures above. Either way, scan a clone
> under `/tmp/repos` rather than your home directory — the paths are visible in the images.

### The whole thing, in one window

![The full Leak Lock interface](docs/website/img/full-interface.png)

Two surfaces: the **Control Panel** in the sidebar is where setup and scanning live, and
the **scanner** in the main editor area is where findings are reviewed and cleaned up. The
sidebar starts things; nothing there rewrites history on its own.

Visible here: the findings count broken down by severity, select-all and per-row
checkboxes, `Export JSON` and `Print / Save as PDF`, a search box over the results, the
refs-status line — `Last fetched never (stale)`, with `Refetch now` beside it, because a
scan is only as complete as the refs it covered — and the banner that marks a finding as
living in a third-party dependency and therefore not selectable for cleanup.

### Scan results — multi-engine, with attribution

![Scan results](docs/website/img/scan-results-table.png)

One row per finding, with the file and line, the commit and branches it lives in, and a
severity label — plus **which engines found it and which missed it**. The top two rows are
real corroboration: Nosey Parker and Gitleaks both found the AWS key and the Azure
connection string, each merged into a single row. Below them, Gitleaks found a Stripe key
the other two missed, and TruffleHog found a credential inside a large blob that Nosey
Parker and Gitleaks both missed — which is the whole reason for running more than one.

The first row also shows aggregation working: one secret, **in 3 commits and still in the
working tree**, as a single row rather than four. The `node_modules` row is marked
*Dependency · not your code* and cannot be selected for a history rewrite.

### Scan coverage — what was actually examined

![Scan coverage](docs/website/img/scan-coverage.png)

Collapsed to one line by default. Expanded, it reports the engines and versions that ran,
the execution mode and the host it was sized for, the refs covered, and the settings in
effect. Warnings are promoted into the collapsed summary, so collapsing hides volume and
never a caveat.

### Manual redaction rules

![Manual redaction rules](docs/website/img/manual-redaction.png)

Remove text no scanner flagged. Literal or regex, and a dry run reports the commits, files
and branches a rule touches before anything is rewritten.

### A clean result you can check

![No findings](docs/website/img/no-findings.png)

"No findings" means nothing without its scope, so the coverage panel sits directly beneath
it.

### Opening it — the Control Panel

![Activity bar icon and the Control Panel](docs/website/img/activity-bar-control-panel.png)

**The shield icon in the activity bar opens it.** Everything starts from this sidebar:
dependency status (Docker and the Nosey Parker image, Java and BFG — all optional, and
installed on first run from the `Details` pane), the auto-detected target repository, the
scan trigger, and the entry points to keyword history search and Remove Files.

### Keyword history search

![Keyword history search](docs/website/img/keyword-history-search.png)

Opt-in, and separate from the credential detectors: commit messages, historical file
contents and filenames are searched for terms you choose — useful for finding what a
pattern-based scanner has no signature for.

### Remove Unwanted Files

![Remove Unwanted Files](docs/website/img/remove-files.png)

Pick files or directories, then choose BFG (fast, name-based across all history) or
path-based git (exact paths across branches, remotes and tags, with a match preview).
Either way the rewrite sits behind a clearly marked final step.

### The cleanup, step by step

Every destructive step sits behind something you have to read first.

![Prepared cleanup script](docs/website/img/prepared-command.png)

**1. The script, before it runs.** Prepare generates the exact commands and shows them.
Nothing has run yet — you can copy the script and run it yourself instead, and it performs
the same safety checks either way.

![Force-push confirmation](docs/website/img/push-confirmation.png)

**2. The remote is still untouched.** The local rewrite and the force-push are separate
steps, and this gate stays on screen until you decide. It names how many refs the push
will overwrite.

![Protected branch explanation](docs/website/img/protected-branch.png)

**If your `main` branch is protected — and it should be.** The push is atomic, so one
protected branch rejects every ref and git reports nine failures for a single cause. Leak
Lock names the branch actually blocking it, says plainly that nothing was pushed and the
secret is still on the remote, and gives the steps to finish — including turning the
protection back on afterwards.

![Verified clean](docs/website/img/verified-clean.png)

**3. Verified, not assumed.** After the push, every remote branch and tag is re-fetched and
re-checked. If nothing could be examined, it says so rather than reporting a clean result
it never tested.

---

## 📖 Documentation

### 📋 **File Structure**
```
leak-lock/
├── extension.js              # Main extension entry point
├── leakLockPanel.js          # Main area panel provider
├── welcomeViewProvider.js    # Activity bar welcome view
├── project-scan.js           # Legacy compatibility
├── package.json              # Extension manifest
├── media/
│   └── shield.svg            # Extension icon
└── docs/                     # Documentation files
```

### 🔧 **Architecture Components**

#### **Extension.js**
- Main extension activation and command registration
- Dependency management and cleanup
- Status bar integration

#### **LeakLockPanel.js**
- Main area webview panel provider
- Scanning workflow implementation
- Results display and remediation UI

#### **WelcomeViewProvider.js**
- Activity bar sidebar integration
- Welcome interface and launch button

See also:
- docs/USER_GUIDE.md — full user guide
- docs/REMOVE_FILES.md — Remove Files flow details

---

## 🛠️ Development

### **Prerequisites**
- Node.js 22.13.0+
- VS Code 1.96.0+
- Docker (for testing scanning functionality)

### **Setup**
```bash
# Clone repository
git clone https://github.com/nikolareljin/leak-lock.git
cd leak-lock

# Install dependencies
npm install

# Launch in development mode
code . # Press F5 to launch extension host
```

### **Testing**
```bash
# Run tests
npm test

# Manual testing
# 1. Press F5 to launch extension host
# 2. Click shield icon in activity bar
# 3. Test dependency installation
# 4. Test scanning workflow
```

---

## 🛡️ Security Tools

Leak Lock runs more than one detection engine and merges the results. They disagree
more than you would expect, so the results table names which engine found each finding
and which enabled engines did not.

### **Gitleaks** — default engine
- **Project**: https://github.com/gitleaks/gitleaks · MIT · actively maintained
- **Install**: `brew install gitleaks`, `apt install gitleaks`, or a release binary. **No Docker, no JVM.**
- **Purpose**: secret detection across full git history and the working tree
- **Why it's the default**: maintained, fast, and its ruleset still receives new detectors. It scans every ref (`--log-opts=--all`) and, in a separate pass, the working tree — including untracked and ignored files.
- **Extra detail it provides**: end line, column range, entropy, commit author and email, and a stable fingerprint (which is what makes baselines work)
- **Settings**: `leakLock.gitleaks.binaryPath`, `leakLock.gitleaks.configPath` (custom TOML rules and allowlists), `leakLock.gitleaks.baselinePath`

### **TruffleHog** — optional, credential verification
- **Project**: https://github.com/trufflesecurity/trufflehog · AGPL-3.0 · actively maintained
- **Install**: `brew install trufflehog` or a release binary. Leak Lock invokes it as an external process only — no bundling, no linking — so the extension remains MIT.
- **Purpose**: the one thing no other engine here does — **checking whether a discovered credential is still live**, against 700+ providers
- **Why it matters**: a verified AWS key in a five-year-old commit is an active incident needing rotation *and* a history rewrite. An unverified high-entropy string is probably noise. Leak Lock ranks a verified finding above every rule-name heuristic and badges it `VERIFIED LIVE`.
- **Privacy**: verification makes read-only network calls to third-party providers **using the discovered credential**. It is therefore **off by default** — enable `leakLock.trufflehog.verify` deliberately.
- **Limits**: reports no column range, entropy or fingerprint. Those are shown as *not provided by this engine* rather than left blank.

### **Nosey Parker** — optional, legacy
- **Project**: https://github.com/praetorian-inc/noseyparker · Apache-2.0
- **Image**: `ghcr.io/praetorian-inc/noseyparker:v0.24.0` (pinned; requires Docker)
- **Status**: ⚠️ **archived read-only upstream on 2026-04-24.** `v0.24.0` (May 2025) is its final release, so its ruleset can no longer receive detectors. On a test fixture it reported 2 findings where Gitleaks reported 7, missing an AWS key and a GitHub PAT in plain committed source.
- **Why it is still here**: an excellent history walker and the best deduplication model of the three — it groups matches sharing a rule and capture groups into a single finding, which keeps large result sets reviewable.
- **Settings**: `leakLock.noseyParker.ruleset` (`default`, `default+assets`, `all`), `leakLock.noseyParker.suppressRedundant`, `leakLock.noseyParker.maxFileSizeMb`, `leakLock.noseyParker.image`

### How many run at once
`leakLock.scan.executionMode` defaults to `auto`, which sizes the plan to your machine —
core count, available memory (respecting container limits, since `os.totalmem()` reports
the *host's* memory inside a container), and current load:

- **Capable host** (≥ 6 cores, ≥ 8 GB, not saturated) — all engines **in parallel**,
  capped at `cores − 2` so the editor still has room
- **Modest host** — all engines, **one at a time**. Slower, but nothing is skipped
- **Constrained host** (≤ 2 cores or < 4 GB) — **Gitleaks only**: a single static binary
  with no container runtime or JVM, and the only engine with a maintained ruleset

If host capacity causes an engine to be skipped, **the coverage panel says so and names
it**. Fewer engines means fewer findings, so a downgrade is never silent. Set
`executionMode` to `parallel`, `sequential` or `single` to decide for yourself.

### Choosing engines
`leakLock.scan.engines` sets which run, and in what order. **All three are enabled by
default** — `["gitleaks", "trufflehog", "noseyparker"]`. A missing engine binary disables
that engine, never the whole scan, and the coverage panel says which engines ran and which
did not, so an engine you have not installed is visible rather than silently absent.

Enabling TruffleHog does not by itself make any network call; verification is the separate
`leakLock.trufflehog.verify` setting, off by default.

Running more than one is the point: they have genuinely different rulesets, and the
attribution line tells you when one of them is falling behind.

If an engine you have installed is reported as missing, it is almost always `PATH` — a
GUI-launched VS Code does not inherit your shell's. Leak Lock searches the usual install
locations (`~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, …); for anything else,
set `leakLock.trufflehog.binaryPath` or `leakLock.gitleaks.binaryPath`.

### **BFG Repo Cleaner**
- **Purpose**: Git history rewriting and cleanup
- **Project**: BFG Repo-Cleaner — https://rtyley.github.io/bfg-repo-cleaner/
- **Tool**: Java-based command line utility
- **Why it’s good**: Safer, faster alternative to `git filter-branch` for removing large files or sensitive data from history; robust, battle‑tested, and widely recommended.
- **Capabilities**: Remove secrets from entire git history, delete files/folders by name
- **Integration**: Automated command generation and execution
- **Note**: Deletion matches by filename/folder name across history (not full path)

### Why Leak Lock
- Seamless integration: combines multi-engine detection with BFG/git removal in a single VS Code experience.
- Safer defaults: Previews, path‑based alternative, and confirmation steps reduce risk.
- Productivity: One panel to scan, review, prepare commands, and execute — no shell juggling.
- Cross‑platform: Gitleaks and TruffleHog run as native binaries with no container runtime; Docker is needed only for the optional Nosey Parker engine. Built‑in helpers keep it reliable on Windows, macOS, and Linux.

### **Git (filter-branch)**
- **Purpose**: Exact path-based history rewriting across branches
- **Command**: `git filter-branch --index-filter 'git rm -r --cached --ignore-unmatch <path> ...' -- --all`
- **Preview**: Lists per-branch matches before running
- **Integration**: Alternative path-safe removal flow in main panel

---

## ⚙️ Configuration

### **Commands Available**
- `leak-lock.openPanel` - Open main scanner interface
- `leak-lock.scanRepository` - Start repository scanning
- `leak-lock.fixSecrets` - Open remediation interface
- `leak-lock.openRemoveFiles` - Open Remove Files flow
- `leak-lock.cleanup` - Clean up all dependencies

### **Dependencies**
- **Git**: required
- **Gitleaks**: default detection engine — a single binary, no runtime
- **TruffleHog**: optional, for live credential verification
- **Docker**: only needed if the Nosey Parker engine is enabled
- **Java**: runtime for the BFG cleanup tool (auto-detected)
- **git-filter-repo**: only needed for the Git-only cleanup mode

A missing engine disables that engine, not the scan.

---

## 🧹 Cleanup

The extension provides comprehensive cleanup functionality:

### **Automatic Cleanup (on uninstall)**
- Removes Nosey Parker Docker image
- Deletes BFG tool jar file
- Cleans up temporary files and directories
- Removes Docker volumes created by extension

### **Manual Cleanup**
Use command palette: `Leak Lock: Clean Up Dependencies`

---

## 🤝 Contributing

We welcome contributions! Areas for improvement:
- 🔍 Additional secret detection patterns
- 🎨 UI/UX enhancements
- 📖 Documentation improvements
- 🧪 Test coverage expansion

---

## 📋 Release Notes

Full history is in the [CHANGELOG](CHANGELOG.md).

### **v0.6.2 (Current)**
- 📦 Slimmer package — docs and the website are no longer bundled into the `.vsix`
- 🔒 Security bumps for `brace-expansion`, `minimatch`, `ajv` and `js-yaml` (dev dependencies)
- 🤖 Dependabot now opens weekly npm and GitHub Actions update PRs

### **v0.6.0**
- ✅ Two-step force-push confirmation before the remote is touched
- ☑️ Select-all / clear-all controls over what gets cleaned
- 🌿 Ref-by-ref push plan, rewrite preflight and post-run verification
- 📄 Cleanups saved as a reviewable `.sh` script

---

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

---

## 🆘 Support

- 🌐 [Website](https://nikolareljin.github.io/leak-lock/) - Overview, screenshots and install instructions
- 📖 [Documentation](./docs/) - Comprehensive guides
- 💬 [Issues](https://github.com/nikolareljin/leak-lock/issues) - Bug reports
- 📧 Contact: Create an issue for support

---

**Made with ❤️ for secure development**
