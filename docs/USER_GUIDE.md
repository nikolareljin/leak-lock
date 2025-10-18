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

**Install Required Tools**
1. Click "🔧 Install Dependencies"
2. Wait for the installation process to complete
3. Dependencies include:
   - Docker (must be pre-installed)
   - Nosey Parker Docker image
   - BFG Repo Cleaner tool

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

**Nosey Parker**
- [Official Documentation](https://github.com/praetorian-inc/noseyparker)
- Advanced secret detection engine
- 100+ built-in secret patterns

**BFG Repo Cleaner**
- [Official Website](https://rtyley.github.io/bfg-repo-cleaner/)
- Git history rewriting tool
- Safer alternative to `git filter-branch`

### Security Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Git Security Best Practices](https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Git_Secrets_Prevention_Cheat_Sheet.md)
- [Secret Management Guidelines](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)

This user guide covers all aspects of using Leak Lock effectively. For additional help, refer to the other documentation files or create an issue on GitHub.
