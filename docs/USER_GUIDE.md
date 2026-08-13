# 📖 User Guide

## 🌟 Welcome to Leak Lock

This comprehensive guide will help you get started with Leak Lock and master all its features for securing your code repositories.

---

## 🚀 Getting Started

### Step 1: Installation

**From VS Code Marketplace** (Recommended)
1. Open VS Code
2. Press `Ctrl+Shift+X` to open Extensions view
3. Search for "Leak Lock"
4. Click "Install"

**From VSIX File**
1. Download the `.vsix` file
2. Open VS Code
3. Press `Ctrl+Shift+P` to open Command Palette
4. Type "Extensions: Install from VSIX"
5. Select the downloaded file

### Step 2: First Launch

**Access the Extension**
- **Activity Bar**: Click the 🛡️ shield icon on the left
- **Command Palette**: `Ctrl+Shift+P` → "Open Leak Lock Scanner"
- **Status Bar**: Click the shield icon at the bottom

### Step 3: Initial Setup

On first launch, you'll see the welcome view:
1. Click "🚀 Open Scanner" button
2. The main panel opens in the editor area
3. You'll see a "🔧 Install Dependencies" section

**What you actually need**

One scan engine. That is the whole requirement — any single one of Gitleaks, TruffleHog or
Nosey Parker, and Leak Lock can scan. Click "🔧 Install Dependencies" and it fetches the
native binaries for Gitleaks and TruffleHog; neither needs Docker or Java.

Everything else is optional and never blocks a scan:

| | What it adds | If it is missing |
|---|---|---|
| A second or third engine | Rules the others miss | Fewer findings; the coverage panel names which engines ran |
| Docker | Needed only by Nosey Parker | Gitleaks and TruffleHog are native binaries |
| Nosey Parker image | An extra engine, upstream archived | Off by default |
| Java + BFG | An alternative history-rewrite engine | The git route is the default and needs no Java |

When at least one engine is installed the sidebar reads **✅ Dependencies ready**, with any
optional absences listed underneath — they are worth knowing about, not worth stopping for.
The panel collapses on its own once something can scan; click **Details** any time to
reopen it.

If no engine is installed at all, Dependencies Setup opens by itself and says which ones
would fix it.

**credential-lens** ships inside the extension. There is nothing to install, it needs no
network, and if it ever fails to load the sidebar says so — scanning is unaffected, only
the credential details are lost.

---

## 🔍 Scanning Your Repository

### Automatic Directory Selection

**For Git Repositories:**
- Leak Lock automatically detects if your workspace is a git repository
- The directory is auto-selected and ready to scan
- You'll see: "📂 Current Directory: /path/to/your/project"

**For Non-Git Directories:**
- You'll need to manually select a directory
- Click "📂 Select Directory to Scan"
- Choose the folder you want to analyze

### Starting a Scan

**Option 1: Scan Selected Directory**
1. Ensure a directory is selected
2. Click "🔍 Scan Selected Directory"
3. Wait for the scanning process to complete

**Option 2: Scan Current Workspace**
1. Click "📂 Scan Current Workspace"
2. Uses the current VS Code workspace automatically

### Understanding Scan Results

The results appear in a detailed table with the following columns:

| Column | Description |
|--------|-------------|
| **Type** | Kind of secret detected (API Key, Token, Password, etc.) |
| **Severity** | Risk level (High/Medium/Low) with color coding |
| **File** | File path where the secret was found |
| **Line** | Line number in the file |
| **Preview** | Partial content showing the detected secret |
| **Actions** | Options to fix or ignore the secret |

**Severity Levels:**
- 🔴 **High**: Critical secrets like production API keys
- 🟡 **Medium**: Potentially sensitive data
- 🟢 **Low**: Possible false positives or test data
- 🟢 **Safe (Not committed)**: Found only in the working tree (not tracked or in git history)

### Reading a finding

**The file path.** The File column shows the path relative to the folder you scanned. Hover it to see the full path. A finding from git history names the commit its path belongs to, because that file may have been renamed or deleted since.

**The commit.** If the finding came from history, the Git Info column shows the commit that contained it. Click the hash to open that file, at that commit, in your browser, with the line highlighted. This works for repositories hosted on GitHub, GitLab and Bitbucket. A repository on a self-hosted or unrecognised host shows the hash as plain text — Leak Lock will not guess a URL that would send you to a page that does not exist. A commit you have not pushed yet has nothing to open, so that link will not resolve until you push.

**The secret.** Some secrets can be identified rather than merely matched. When Leak Lock recognises one — an SSH or PEM private key, a certificate, a JWT, a GCP service-account file and others — the Secret cell is badged with what it is. Click it to see the algorithm, fingerprint, whether the key is passphrase-protected, any validity window, and the claims the artifact carries.

A cell badged **inspect** is one that looks like a credential but was cut short by the scanner. Clicking it reads the whole file to identify it.

All of this analysis happens on your machine. Nothing is uploaded, and the report never contains the private key body or a JWT signature.

**What the report does not tell you.** Names inside a credential — an SSH key comment, a certificate subject, a JWT `sub` claim — are evidence of what the artifact says about itself, not proof of who owns it. The report labels each claim's source and states its limits; read those before acting on a name.

### Exporting Results

After a scan completes, use the export actions in the results section:

- **📤 Export JSON**: Saves a machine-readable report with scan metadata and findings.
- **🖨️ Print / Save as PDF**: Opens a print-friendly version of the current results so you can save a PDF report.

Use exports to share findings in incidents, tickets, or audit reports.

---

## 🔧 Removing Secrets

### Step 1: Review Detected Secrets

1. Examine each detected secret carefully
2. Determine which ones are actually sensitive
3. Some may be test data or false positives

### Step 2: Select Secrets for Removal

1. Check the boxes next to secrets you want to remove
2. For each selected secret, you can:
   - Use the default replacement "***REMOVED***"
   - Enter a custom replacement value
   - Leave blank to remove entirely

### Step 3: Generate Fix Commands

1. Click "🔧 Generate Fix Command"
2. Leak Lock creates a BFG command to remove the secrets
3. Review the generated command before proceeding

### Step 4: Execute Git Cleanup

⚠️ **Important Warning:** This permanently modifies your git history!

1. **Backup your repository** before proceeding
2. Click "🚀 Run BFG + Git Cleanup"
3. Confirm the action in the warning dialog
4. Wait for the cleanup process to complete

**What happens during cleanup:**
1. BFG tool removes secrets from git history
2. Git reflog is expired
3. Garbage collection runs to clean up
4. Your repository history is rewritten

---

## 🗑️ Remove Unwanted Files (New)

Use this guided flow to remove files or directories from your repository history.

### Open the Flow

- In the sidebar, click "🗑️ Remove files"
- The main panel switches to the Remove Files interface

### Steps

1) Select repository
- Choose the git repository root directory

2) Select files and/or directories
- Multi-select is supported
- Selections must be within the chosen repository

3) Choose removal mode
- Name-based (BFG): Fast; matches by filename/folder name
- Path-based (Git): Exact paths; safer when duplicates exist

4) Prepare the command
- BFG mode: choose grouping (single or per-item) and click "⚙️ Prepare the bfg command"
- Git mode: click "🔎 Preview matches (branches, remotes, tags)" to see exact files per ref, then "⚙️ Prepare the git command"
   - The extension automatically fetches remotes and tags before preview/running to avoid missing refs.

5) Granular deletion feedback
- BFG mode: per selection shows the flag used and name pattern
- Git mode: shows branch-by-branch exact matches before running
  - Note: BFG matches by filename/folder name across history; Git mode uses exact repo-relative paths

6) Confirm and run
- Final steps are highlighted in red
- Click the appropriate button for BFG or Git to execute and cleanup
- After completion, review changes and force-push if needed

### If the push is refused: a protected branch

The most common way a real cleanup stops. GitHub, GitLab and Bitbucket all block
force-pushes to a protected branch — and a history rewrite *is* a force-push, which is
exactly what the rule exists to prevent by accident.

**Keep the protection.** It is doing its job. This is a deliberate, temporary exception.

What you will see is misleading if you read it literally: the push is `--atomic`, so one
protected branch rejects **every** ref. Nine `[remote rejected]` lines usually mean *one*
problem, and the other eight say `(atomic transaction failed)` — those refs were fine and
were rolled back with the transaction. Leak Lock separates the cause from the collateral
and tells you which branch is actually blocking.

Nothing is pushed when this happens: **the remote is unchanged, so the secret is still on
it.** Your local history is already rewritten — only the push is outstanding.

To finish, on GitHub:

1. **Settings → Branches** (or **Rules → Rulesets** if you use rulesets)
2. Edit the rule protecting the branch and tick **Allow force pushes**. If *Do not allow
   bypassing the above settings* is on, turn it off or add yourself to the bypass list.
3. Back in Leak Lock, press **Confirm force-push** again.
4. **Turn the protection back on immediately.**

On GitLab: *Settings → Repository → Protected branches* → allow force push. On Bitbucket:
*Repository settings → Branch restrictions*. On any other host, ask whoever administers it
to lift the restriction briefly.

### After the force-push: what "verified" means

Leak Lock re-fetches and re-greps **every** remote branch and tag after pushing, rather
than trusting that the rewrite did what it said. There are three possible outcomes, and
they are deliberately kept distinct:

| Outcome | What it means | What to do |
|---|---|---|
| ✅ **Verified clean on every remote ref** | Every ref was fetched and checked, and the target is gone from all of them | Tell everyone with a clone to re-clone or hard-reset |
| ⚠️ **Still present** | Refs were checked, and the target is **still there** on the ones listed | The rewrite did not fully take. Do not assume the leak is closed — rotate the credential |
| ⚠️ **Not verified** | The check could not run: no search criteria, or no refs found under the remote | **This is not a clean result.** Nothing was examined, so it says nothing either way — check the remote yourself |

The third one exists because an empty result set and a successful check look identical
unless you keep them apart. A tool that says "clean" when it simply never looked is worse
than one that says nothing, so Leak Lock will not make the claim it did not test.

The generated cleanup script applies the same rule: it exits non-zero and prints
`NOT VERIFIED` rather than reporting clean when it examined no refs.

### Notes and Limitations

- BFG’s deletion semantics are name-based; it does not support full path deletion
- Directory deletions remove any folder with the given name throughout history
- Consider running on a backup first and coordinate force-push with your team

---

## 🎛️ Advanced Features

### Changing Scan Directory

1. In the "📁 Scan Directory" section
2. Click "🔄 Change Directory"
3. Select a different folder to scan
4. The dialog starts at your current workspace

### Manual Dependency Management

**Reset Dependencies**
1. Click "🔧 Reset Status" in the setup section
2. This allows you to reinstall dependencies
3. Useful if installation failed or for troubleshooting

**Clean Up Dependencies**
1. Open Command Palette (`Ctrl+Shift+P`)
2. Type "Leak Lock: Clean Up Dependencies"
3. Confirms before removing all installed tools

### Multiple Access Methods

**Activity Bar Integration**
- Click the shield icon to open welcome view
- Welcome view has launch button for main panel

**Status Bar Quick Access**
- Shield icon in status bar opens main panel directly
- Always visible for quick access

**Command Palette**
- `Ctrl+Shift+P` → "Open Leak Lock Scanner"
- Works from anywhere in VS Code

---

## 🔍 Understanding Secret Types

### Common Secret Categories

**API Keys**
- AWS Access Keys
- Google Cloud API Keys
- Azure Service Principal Keys
- Third-party service keys

**Authentication Tokens**
- GitHub Personal Access Tokens
- GitLab Tokens
- JWT Secrets
- OAuth Tokens

**Database Credentials**
- Connection strings
- Usernames and passwords
- Database URLs with credentials

**Certificates and Keys**
- Private SSH keys
- SSL/TLS certificates
- PGP private keys

**Application Secrets**
- Encryption keys
- Session secrets
- Webhook secrets
- Configuration passwords

### False Positive Handling

**Common False Positives:**
- Test data with fake credentials
- Example code with placeholder values
- Documentation with sample keys
- Base64 encoded non-sensitive data

**How to Handle:**
1. Carefully review each detection
2. Verify if the secret is actually sensitive
3. Use custom replacement values for legitimate test data
4. Consider excluding test directories from scans

---

## 🛡️ Security Best Practices

### Before Using Leak Lock

1. **Backup Your Repository**
   - Create a complete backup before running cleanup
   - Test on a copy first for important repositories

2. **Review Your History**
   - Understand what will be changed
   - Check if other team members need notification

3. **Coordinate with Team**
   - Inform team members about history rewriting
   - Plan the cleanup during low-activity periods

### After Cleanup

1. **Force Push Changes**
   - Use `git push --force-with-lease` to update remote
   - Coordinate with team for pulling changes

2. **Update Team Repositories**
   - Team members need to reclone or reset their local copies
   - Provide clear instructions for updating

3. **Rotate Compromised Secrets**
   - Generate new API keys for removed secrets
   - Update applications with new credentials

### Ongoing Security

1. **Regular Scanning**
   - Run Leak Lock periodically on active repositories
   - Include in your security review process

2. **Pre-commit Hooks**
   - Consider using git hooks to prevent secret commits
   - Complement Leak Lock with prevention tools

3. **Developer Education**
   - Train team on secure coding practices
   - Use environment variables for secrets

---

## 🐛 Troubleshooting

### Common Issues

**Dependencies Won't Install**
- Ensure Docker is installed and running
- Check internet connectivity for downloads
- Try manual cleanup and reinstall

**Scanning Fails**
- Verify the selected directory is accessible
- Check available disk space for temporary files
- Ensure Docker has sufficient memory

**BFG Command Fails**
- Verify Java is installed and accessible
- Check repository is not corrupted
- Ensure sufficient disk space

**Git-only cleanup fails with `FileNotFoundError: .../replacements.txt`**

A snap-packaged `git-filter-repo` is confined: it gets a private `/tmp` and can
only read non-hidden paths under your home directory. The replacement rule file
now lives inside the repository's `.git` directory for exactly that reason, but a
snap still cannot touch a repository stored outside `$HOME` at all. Install the
unconfined tool instead:

```bash
sudo snap remove git-filter-repo      # optional, but it stays first on PATH otherwise
python3 -m pip install --user git-filter-repo
```

Then reload the VS Code window so its `PATH` picks up the new binary. Leak Lock
reports this case by name rather than passing the Python traceback through.

**The secret keeps coming back after a cleanup**

The cleanup is two separate steps: it rewrites your **local** history first, and the
force-push to the remote is a **second, explicitly confirmed** step. If the second
step never ran, or was rejected, the remote still holds the secret — and every
`git fetch` or `git pull` brings those commits back into your clone. Preparing
another cleanup does the same, because it force-resets each local branch to its
remote counterpart before rewriting. This looks identical to "the rewrite did not
work", including on the default branch, and no branch protection is involved.

Check what the remote actually has:

```bash
git fetch --prune --tags origin
git --no-replace-objects grep -F "<the secret>" $(git for-each-ref --format='%(refname)' refs/remotes)
```

`--no-replace-objects` matters. `git filter-repo` writes a `refs/replace/<old>`
entry for every commit it rewrites, and git honours those refs everywhere: ask
about the original commit and git answers with the rewritten one, so a branch that
still carries the secret reads as clean. Leak Lock now deletes those refs after a
rewrite and verifies past them regardless; a repository rewritten with `git
filter-repo` directly may still have them:

```bash
git for-each-ref refs/replace          # anything here masks the original commits
git for-each-ref --format='delete %(refname)' refs/replace | git update-ref --stdin
```

Two more reasons a secret survives a *successful* force-push, both outside the
extension's reach:

- **The hosting provider keeps the old commits.** On GitHub, any commit that was
  ever part of a pull request stays reachable at its URL through `refs/pull/*`
  after a force-push, and forks keep their own copy. Ask GitHub Support to run a
  garbage collection on the repository, and delete forks first.
- **Another clone pushes it back.** A colleague's working copy, a CI job, or a
  second machine of yours still has the pre-rewrite history; the next push from
  there restores it. Everyone must re-clone after a rewrite.

Rotate the credential regardless. A secret that reached a remote must be treated
as compromised, whatever the history now says.

**A cleanup failed and I do not want to re-select every secret**

Nothing is lost. The replacement rules are written to
`<repo>/.git/leak-lock/replacements.*` and are deleted **only after** the rewrite,
the force-push and the verification have all succeeded. A failed run keeps the
file and the error message names its path, so the same cleanup can be retried
unchanged. The file holds the raw secret values, so delete it once you are done.

**UI Not Responding**
- Reload VS Code window (`Ctrl+Shift+P` → "Reload Window")
- Check VS Code version compatibility
- Look for error messages in Developer Console

### Getting Help

1. **Check Documentation**
   - Review this user guide
   - Check the FAQ section
   - Look at troubleshooting guide

2. **Enable Verbose Logging**
   - Open VS Code settings
   - Search for "leak-lock"
   - Enable verbose logging option

3. **Report Issues**
   - Create an issue on GitHub
   - Include error messages and steps to reproduce
   - Provide system information (OS, VS Code version)

---

## ⚡ Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Open Command Palette | `Ctrl+Shift+P` |
| Open Extensions View | `Ctrl+Shift+X` |
| Toggle Activity Bar | `Ctrl+Shift+E` |
| Reload Window | `Ctrl+R` |

**Leak Lock Specific:**
- Search "Leak Lock" in Command Palette for all commands
- Use "Open Leak Lock Scanner" for quick access
- Access through Activity Bar shield icon

---

## 📚 Additional Resources

### External Tools

**Gitleaks** — default detection engine
- [Project page](https://github.com/gitleaks/gitleaks) · MIT · actively maintained
- Install: `brew install gitleaks`, `apt install gitleaks`, or a release binary. No Docker or JVM needed.
- Scans full git history across every ref, plus a separate working-tree pass that also
  covers untracked and `.gitignore`d files
- Supplies detail the other engines do not: column ranges, entropy, commit author, and a
  stable fingerprint used for baselines

**TruffleHog** — optional, credential verification
- [Project page](https://github.com/trufflesecurity/trufflehog) · AGPL-3.0 · actively maintained
- Install: `brew install trufflehog` or a release binary. Leak Lock runs it as an external
  process only, so the extension stays MIT-licensed.
- Answers the question no other engine here can: **is this credential still live?**
- Verification makes read-only network calls to third-party providers *using the
  discovered credential*, so it is **off by default**. Enable `leakLock.trufflehog.verify`
  deliberately.
- A verified credential is ranked above everything else and badged `VERIFIED LIVE` —
  rewriting history does not revoke a working key, so it needs rotating first.

**Nosey Parker** — optional, legacy
- [Project page](https://github.com/praetorian-inc/noseyparker) · Apache-2.0
- ⚠️ **Archived read-only upstream on 2026-04-24**; `v0.24.0` (May 2025) is the final
  release and its ruleset can no longer gain detectors. Leak Lock pins that version.
- Requires Docker. Kept because its history walker and finding-level deduplication are
  excellent — it groups matches sharing a rule and capture groups into a single finding,
  which keeps large result sets reviewable.

**BFG Repo Cleaner**
- [Project page](https://rtyley.github.io/bfg-repo-cleaner/)
- Git history rewriting tool; safer, faster than `git filter-branch`
- Ideal for removing large files or secrets across history

### Why Leak Lock
- Seamlessly integrates multi-engine scanning and BFG/git workflows inside VS Code
- Offers both name‑based (BFG) and path‑exact (git) removal with previews
- Adds safe defaults, warnings, and copyable commands for clear, auditable changes

### Security Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Git Security Best Practices](https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Git_Secrets_Prevention_Cheat_Sheet.md)
- [Secret Management Guidelines](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)

This user guide covers all aspects of using Leak Lock effectively. For additional help, refer to the other documentation files or create an issue on GitHub.
