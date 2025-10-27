# 🛡️ Leak Lock - VS Code Security Extension

**Secure your code repositories by detecting and removing sensitive information from git history**

[![Version](https://img.shields.io/badge/version-0.0.1-blue.svg)](package.json)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.96.0+-brightgreen.svg)](https://code.visualstudio.com/)

[📖 Documentation](#documentation) • [🚀 Quick Start](#quick-start) • [📸 Screenshots](#screenshots) • [🛠️ Development](#development)

---

## 🌟 Overview

Leak Lock is a powerful VS Code extension that helps developers secure their repositories by:

- 🔍 **Scanning** git repositories for secrets, API keys, and sensitive data
- 🛡️ **Detecting** over 100+ types of credentials using Nosey Parker
- 🔧 **Removing** secrets from git history using BFG tool
- ⚡ **Automating** the complete security remediation workflow
- 📊 **Displaying** results in an intuitive main area interface

## ✨ Key Features

### 🎯 **Smart Detection**
- **100+ Secret Types**: API keys, passwords, tokens, certificates
- **Low False Positives**: Advanced pattern matching and validation
- **Git History Scanning**: Deep analysis of entire repository history
- **Multiple Formats**: JSON, database connections, configuration files

### 🖥️ **Modern Interface**
- **Main Area Display**: Wide layout perfect for scan results
- **Activity Bar Integration**: Easy access via shield icon
- **Smart Directory Selection**: Auto-detects git repositories
- **Progress Tracking**: Real-time scanning and remediation progress
- **Remove Files Flow**: Sidebar button opens guided removal UI in main area
 - **Path-Based Safe Removal**: Exact path deletion across branches with preview

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
# Install from VS Code Marketplace (coming soon)
code --install-extension leak-lock

# Or install from VSIX
code --install-extension leak-lock-0.0.1.vsix
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

---

### 6. Remove Unwanted Files (New)
- Open from sidebar: click "🗑️ Remove files"
- Select repository (git root)
- Choose multiple files and/or directories
- Option A (fast): BFG, name-based grouping (single or per-item)
- Option B (safe): Git path-based, exact paths across branches
- Click "🔎 Preview matches" for path-based mode to see exact files across branches, remotes, and tags
- Remotes are fetched automatically to avoid missing references
- Prepare and review the generated command
- Final step (red): confirm to run (BFG or Git) and rewrite history

---

## 📸 Screenshots

### Activity Bar Integration
The extension adds a shield icon to the activity bar for easy access.

### Welcome View
Simple welcome interface in the sidebar with a "Open Scanner" button.

<img width="71" height="653" alt="image" src="https://github.com/user-attachments/assets/7746e552-4017-45fb-b2d3-3f412b2da92b" />

"Leak-Lock" scanner button:

<img width="73" height="74" alt="image" src="https://github.com/user-attachments/assets/2e927619-0825-47b7-9ef3-e825c6ffd520" />


### Main Scanner Interface

<img width="413" height="548" alt="image" src="https://github.com/user-attachments/assets/e6d5630d-0a4a-4ae5-8383-94c88595de02" />

Full-width main area interface showing:
- Dependency installation status

<img width="422" height="1009" alt="image" src="https://github.com/user-attachments/assets/e1da44be-e827-4006-bada-ebb2095b2127" />

- Directory selection with auto-detection
- Scanning controls and progress
- Results display in wide table format

### Scanning Process

<img width="1701" height="859" alt="image" src="https://github.com/user-attachments/assets/dd8af4e9-c873-4435-9bd5-cbc60584ee73" />

Real-time progress indication during repository scanning with Nosey Parker.

### Results Display

<img width="2340" height="1215" alt="image" src="https://github.com/user-attachments/assets/bc057139-d659-49f0-b81c-4d76dbe54dba" />

Detailed table showing:
- Secret type and severity
- File location and line number
- Preview of detected content
- Action buttons for remediation

### Remediation Interface
Step-by-step process for removing secrets:
- Secret selection checkboxes
- Replacement value input
- BFG command generation
- Git cleanup execution

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
- Node.js 16+ 
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

### **Nosey Parker**
- **Purpose**: Secret detection and scanning
- **Project**: Nosey Parker by Praetorian — https://github.com/praetorian-inc/noseyparker
- **Image**: `ghcr.io/praetorian-inc/noseyparker:latest`
- **Why it’s good**: High-precision detection with 100+ well‑maintained rules, fast scanning, low false positives, and active community support.
- **Integration**: Containerized execution for portability and consistency across platforms

### **BFG Repo Cleaner**
- **Purpose**: Git history rewriting and cleanup
- **Project**: BFG Repo-Cleaner — https://rtyley.github.io/bfg-repo-cleaner/
- **Tool**: Java-based command line utility
- **Why it’s good**: Safer, faster alternative to `git filter-branch` for removing large files or sensitive data from history; robust, battle‑tested, and widely recommended.
- **Capabilities**: Remove secrets from entire git history, delete files/folders by name
- **Integration**: Automated command generation and execution
- **Note**: Deletion matches by filename/folder name across history (not full path)

### Why Leak Lock
- Seamless integration: Combines Nosey Parker (detection) and BFG/git (removal) into a single VS Code experience.
- Safer defaults: Previews, path‑based alternative, and confirmation steps reduce risk.
- Productivity: One panel to scan, review, prepare commands, and execute — no shell juggling.
- Cross‑platform: Dockerized scanning and built‑in helpers make it reliable on Windows, macOS, and Linux.

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
- **Docker**: Container runtime for Nosey Parker
- **Java**: Runtime for BFG tool (auto-detected)
- **Git**: Version control operations

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

### **v0.0.1 (Current)**
- ✨ Initial release with core functionality
- 🛡️ Main area interface for wide result display
- 🔧 Automated dependency installation
- 🎯 Smart directory selection for git repositories
- 🧹 Complete cleanup on uninstall

---

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

---

## 🆘 Support

- 📖 [Documentation](./docs/) - Comprehensive guides
- 💬 [Issues](https://github.com/nikolareljin/leak-lock/issues) - Bug reports
- 📧 Contact: Create an issue for support

---

**Made with ❤️ for secure development**
