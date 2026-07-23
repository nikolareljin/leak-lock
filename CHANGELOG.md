# Change Log

## 0.6.0
### Added
- **Finding Selection Controls**: The scan results table now has a header select-all checkbox, `Select all` / `Clear all` buttons, and a live "N of M cleanable findings selected" counter. Cleanup buttons are disabled while nothing is selected. The bulk controls are wired with event listeners so they keep working under a strict Content-Security-Policy.
- **Clearer Dependency Findings**: Findings inside third-party dependencies (node_modules, vendor, …) now carry a prominent "Dependency · not your code" badge and an explicit note that they are not your source and cannot be selected for history cleanup, so their disabled checkbox is no longer confusing. The summary banner explains they should be addressed by updating the package.
- **Git-History Keyword Matches Are Cleanable**: Keyword findings from git-history search are now selectable and checked by default, just like detected secrets. Selecting one redacts that string from history via BFG `--replace-text`. Only findings in dependency directories remain non-selectable (with a tooltip explaining why).
- **Ref-by-Ref Push Plan**: Preparing a cleanup shows exactly which branches will be force-updated, which exist only on the remote, which will be created, and which tags are affected — instead of a blanket `git push --force --all` (LL-002).
- **Rewrite Preflight**: All refs are refreshed before a rewrite is planned, and the rewrite is blocked (with the branch list) when local branches hold commits the remote does not have (LL-001).
- **Post-Run Verification**: After a cleanup, every remote branch and tag is re-checked and any ref where the target survived is reported.
- **Save as .sh**: The prepared cleanup is a complete, reviewable bash script that can be copied or saved to disk.

### Fixed
- **History Rewrites Now Reach Every Remote Branch**: `git push --force --all` expands to `refs/heads/*` only, so branches that existed solely as `refs/remotes/origin/*` were rewritten locally but never pushed — the leaked secret survived on the server and returned on the next fetch. Leak Lock now materialises a local branch for every remote branch before rewriting and pushes with `--atomic`.
- **Selection No Longer Resets On Prepare**: Checkbox state and replacement values are held by the extension rather than the webview DOM, so preparing a command (which re-renders the panel) no longer re-checks every unchecked finding or discards edited replacement text.
- **Git-History Keyword Hits Are Now Consistent**: The row renderer and the cleanup resolver used to disagree — a keyword finding could render as checked but was dropped at cleanup time. A single eligibility predicate now governs both, so a selected keyword finding is actually cleaned (see "Git-History Keyword Matches Are Cleanable" above).
- **`git filter-repo` Remote Restoration**: `filter-repo` deletes the `origin` remote by design, which made the subsequent force-push fail. The remote is now restored before pushing.
- **BFG Failures No Longer Force-Push**: A failed BFG run previously continued to the force-push stage, rewriting the remote for a rewrite that never happened.
- **Individual-Mode BFG Now Escapes Target Names**: In one-command-per-item removal, a selected name containing regex metacharacters (for example `[old].env`) was passed to BFG as a pattern and could match more paths than selected. It is now escaped literally, matching combined mode.
- **No-Remote Repositories Are Blocked, Not Broken**: Preparing a cleanup in a repository with no configured remote previously produced a script that failed on its first fetch/push. Preparation now stops with a clear message instead of offering a plan that cannot run.
- **Prepared Cleanup Script Was Displayed and Copied as One Line**: The command box had no `white-space` rule, so the browser collapsed every newline to a space — the script rendered as a single line and the `📋 Copy` button (reading `innerText`) copied that collapsed, unrunnable version. The box now preserves line breaks and Copy reads the raw text, so the copied script matches what `💾 Save as .sh` writes. The generated script also now restores the working branch via a `trap` on exit, so a rejected push no longer leaves the repository on a detached HEAD.
- **Git-History File-Content Search Now Actually Runs**: The `git log` invocation combined `-G` with `--pickaxe-regex`, which git rejects (`options '-G' and '--pickaxe-regex' cannot be used together`), so searching historical file content silently found nothing. The invalid flag is removed. File-content and filename searches now match literal substrings (a secret is routinely embedded inside a larger token), so a term that appears anywhere in a historical file is found instead of being dropped by whole-word matching.

## 0.5.0
### Added
- **Expanded Git-History Text Search**: Supports arbitrary text terms across commit messages and historical file content without skipping short terms.
- **Git-History Filename Search**: Added optional filename matching mode via `leakLock.gitHistoryKeywordSearch.searchFileNames` (disabled by default / opt-in).

## 0.4.1
### Fixed
- **Printable Report Redaction Scope**: Redacted PDF/printable reports now keep finding paths visible and redact only secret values, so remediation context is preserved.
- **Commit-Message History Result Context**: Keyword matches from commit-message scanning now use a stable path label with ID and commit hash (for example `git-history:commit-message [id:... commit:...]`) to avoid exposing raw commit message text.

## 0.4.0
### Added
- **Keyword Search in Git History**: Optional scanning for configured keywords in commit messages and historical file content changes ([#39](https://github.com/nikolareljin/leak-lock/issues/39))
  - New settings to enable/disable keyword history scanning
  - Separate toggles for commit-message scanning and file-history scanning
  - Configurable keyword list and per-keyword match cap
  - Default keyword profile targets agent-attribution terms and sensitive credential wording
  - Keyword matches are surfaced in scan results with git commit metadata

## 0.3.0
### Added
- **Scan Results Export**: Export scan findings as JSON and print/save the current results view as PDF ([#37](https://github.com/nikolareljin/leak-lock/issues/37))
  - New `Export JSON` action in the scan results section
  - New `Print / Save as PDF` action in the scan results section
  - Exported JSON includes metadata (`generatedAt`, scan path, counts) and full finding records

## 0.2.0
### Added
- **Git Commit Info in Scan Results**: Display branch name, commit hash, and commit date for each detected credential leak found in git history ([#36](https://github.com/nikolareljin/leak-lock/issues/36))
  - New "Git Info" column in the results table showing branch, abbreviated commit hash, and formatted date
  - Batch-resolves commit metadata via `git log` and `git branch --contains` after scanning
  - Gracefully handles orphaned commits and non-git findings

## 0.1.2
- Ignore jar files in the vscode distro.

## 0.1.1
### Changed
- **Test Assets Organization**: Moved `validate.sh`, `test.sh`, and `test-secrets.js` into `test/` for a cleaner root directory
- **README Documentation**: Improved README guidance and clarity

## 0.1.0
### Added
- **Scan Cleanup Flow (Prepare → Run)**: Scan results now generate BFG or Git-only commands before execution with copyable placeholders
- **Open VSX Publishing**: CI now publishes VSIX packages to Open VSX using `OVSX_PAT`
- **Local-Only Finding Classification**: Untracked, non-history secrets are marked safe (green) but still documented

### Changed
- **Force Push Prompt**: Explicit confirmation prompts after cleanup to optionally force push changes
- **BFG Warning Text**: Clear note that BFG removes same-name files/directories everywhere in history
- **Remove Files UX**: Target selection supports removing individual items and clearing selections
- **Repository Picker Default**: Remove Files target selection opens at the chosen repository
- **Activity Bar Icon**: Switched to `./media/icon.svg`

## September 29, 2025
### Added
- **Comprehensive Installation Instructions**: Step-by-step guides for installing Docker and Java with platform-specific instructions
- **Platform-Specific Setup Guides**: Detailed instructions for Windows, macOS, and Linux with direct download links
- **Visual Progress Indicators**: Real-time scanning progress with animated spinner and stage-by-stage tracking
- **Enhanced Empty Results Display**: Celebratory interface when no secrets found with security checklist and best practices
- **Interactive Security Guide**: Built-in security best practices guide accessible from scan results
- **Local-Only Finding Classification**: Marks uncommitted, non-history secrets as safe (green) while still documenting them
- **Advanced Scan Progress**: Five-stage progress tracking (Docker Check → Pull Image → Initialize → Scan Files → Process Results)
- **Command Injection Security Fixes**: Proper shell path escaping and input validation to prevent security vulnerabilities
- **Centralized Configuration**: Extracted hardcoded paths to shared config.js for better maintainability
- **Enhanced Dependency Management**: Smart dependency section that auto-hides when all dependencies are installed
- **Detailed Dependency Status**: Individual status tracking for Docker, Nosey Parker, Java, and BFG with version information
- **Improved UI/UX**: Progress indicators, animations, and better visual feedback during operations
- **Advanced Error Handling**: Comprehensive error messages and recovery suggestions for dependency issues
- **Package Updates**: Updated package-lock.json with latest dependency versions
- **Code Quality Improvements**: Replaced magic numbers with named constants for better maintainability
  - `MAX_PATH_LENGTH = 4096`: Maximum allowed path length for security validation
  - `MAX_VOLUME_NAME_LENGTH = 255`: Maximum Docker volume name length
  - `DOCKER_PULL_TIMEOUT = 120000`: Docker image pull timeout (2 minutes)
  - `SCAN_TIMEOUT = 300000`: Security scan timeout (5 minutes)
  - `SECRET_TRUNCATE_LENGTH = 50`: Length limit for displaying secrets in UI

### Security
- **Fixed Critical XSS Vulnerabilities**: Implemented comprehensive HTML escaping to prevent cross-site scripting attacks
  - Added escapeHtml() and escapeJsonAttribute() functions for proper output encoding
  - Replaced unsafe onclick handlers with data attributes and event delegation
  - Applied HTML escaping to all user-controlled data (file paths, secrets, descriptions, progress messages)
  - Eliminated direct interpolation of user data into HTML onclick attributes
- **Fixed Critical Path Validation Flaw**: Corrected path traversal detection to check input BEFORE normalization, preventing bypass attempts
- **Robust Directory Traversal Prevention**: Added comprehensive regex patterns to detect all path traversal attempts (../, ..\, etc.)
- **Enhanced Working Directory Protection**: Added validation to prevent access outside the current working directory
- **Improved Path Containment Logic**: Fixed validateDockerPath() to use path.relative() for accurate containment checking
- **Fixed Docker Command Injection Vulnerabilities**: Comprehensive path validation and sanitization for all Docker volume mounts
- **Enhanced Path Security**: Added validateDockerPath() and sanitizeDockerVolumeName() functions to prevent directory traversal attacks
- **Cross-Platform Sensitive Directory Protection**: Implemented platform-aware system directory blocking
  - Unix/Linux: Protects `/etc`, `/usr/bin`, `/bin`, `/sbin`, `/root`, `/var/run`, `/var/log`, `/sys`, `/proc`, `/boot`, `/dev`
  - Windows: Protects `C:\Windows`, `C:\Program Files`, `C:\ProgramData`, system user directories, and critical system files
  - Multi-drive support: Automatically protects system directories on D:, E:, F: drives on Windows
  - Case-insensitive matching on Windows, case-sensitive on Unix-like systems
- **Removed Dangerous Root Access**: Eliminated --user root flag from Docker commands to reduce security risks
- **Added Input Validation**: Path traversal prevention and directory access validation for all user inputs
- **Enhanced CI Security**: Added npm audit and eslint-plugin-security to CI pipeline

All notable changes to the "leak-lock" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## September 28, 2025

### Added
- **Enhanced Dependency Management**: Smart dependency section that auto-hides when all dependencies are installed
- **Detailed Dependency Status**: Individual status tracking for Docker, Nosey Parker, Java, and BFG with version information
- **Improved UI/UX**: Progress indicators, animations, and better visual feedback during operations
- **Advanced Error Handling**: Comprehensive error messages and recovery suggestions for dependency issues
- **Package Updates**: Updated package-lock.json with latest dependency versions

### Changed
- **Dependency Error Handling**: Replaced generic error messages with comprehensive installation instructions and help links
- **UI Architecture**: Complete reorganization with sidebar-based controls and main area results display
- **Directory Selection**: Enhanced git repository auto-detection and manual directory selection
- **Dependency Installation**: Streamlined installation process with better progress tracking
- **Scan Results Display**: Improved table layout and formatting in main editor area

### Fixed
- **Directory Validation**: Removed overly restrictive working directory limitation that prevented scanning external directories
- **Path Security**: Replaced blanket CWD restriction with targeted protection against sensitive system directories
- **Arbitrary Directory Scanning**: Users can now scan any accessible directory outside the VS Code workspace
- **Main Panel Corruption**: Resolved HTML corruption issues and restored clean implementation
- **Dependency Verification**: Enhanced dependency checking with proper error handling
- **Git Integration**: Improved workspace folder detection and repository handling

## September 27, 2025

### Added
- **Complete Core Implementation**: Full Leak Lock extension with scanning and secret fixing capabilities
- **Nosey Parker Integration**: Docker-based secret scanning with 100+ secret type detection
- **BFG Repo-Cleaner Integration**: Automated git history cleaning and secret removal
- **Results Display**: Comprehensive scan results with file locations, line numbers, and secret previews
- **Manual Remediation**: Safe manual command generation for git history rewriting
- **Safety Features**: Backup reminders, force-push warnings, and manual execution requirements

### Technical Infrastructure
- **Project Assessment**: Initial codebase analysis and implementation planning
- **Extension Foundation**: Core VS Code extension structure and activation events

## February 28, 2025

### Added
- **Sidebar Integration**: Activity bar view container with shield icon
- **Package Management**: Updated dependencies and build scripts
- **Extension Registration**: Proper VS Code extension registration and configuration

## February 15, 2025

### Added
- **Initial Sidebar Panel**: Basic webview-based sidebar display
- **Command Structure**: Core command registration and extension framework
- **Build Infrastructure**: Installation and project scanning scripts setup

## February 8, 2025

### Added
- **Project Foundation**: Initial VS Code extension starter code and basic structure
- **Development Setup**: Base configuration files and development environment

## [Unreleased]

### Planned Features
- **VS Code Marketplace Publishing**: Automated CI/CD pipeline for extension releases
- **Enhanced Secret Detection**: Additional secret pattern recognition and validation
- **Bulk Operations**: Multi-repository scanning and batch secret remediation
- **Integration APIs**: Support for external security tools and workflows
