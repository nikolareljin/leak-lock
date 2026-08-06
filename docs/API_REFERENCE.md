# 🔧 API Reference

## 📋 Overview

This document provides detailed API documentation for all classes, methods, and interfaces in the Leak Lock extension.

---

## 🏗️ Extension.js

### **activate(context: vscode.ExtensionContext)**
Main extension activation function.

**Parameters:**
- `context` - VS Code extension context

**Responsibilities:**
- Install dependencies automatically
- Register webview providers
- Register commands
- Setup status bar integration

```javascript
function activate(context) {
    installDependencies();
    const welcomeProvider = new WelcomeViewProvider(context.extensionUri);
    // ... registration logic
}
```

### **deactivate(): Promise<void>**
Extension deactivation and cleanup.

**Returns:** Promise that resolves when cleanup is complete

**Responsibilities:**
- Remove Docker images
- Delete temporary files
- Clean up BFG tool

```javascript
async function deactivate() {
    await cleanupDependencies();
}
```

### **checkDependencies(): Promise<Object>**
Validates installed dependencies.

**Returns:** Object with dependency status
```javascript
{
    docker: boolean,
    noseyparker: boolean,
    bfg: boolean,
    java: boolean
}
```

**Usage:**
```javascript
const deps = await checkDependencies();
if (!deps.docker) {
    // Handle missing Docker
}
```

### **installDependencies(forceReinstall?: boolean): Promise<boolean>**
Installs required dependencies with progress tracking.

**Parameters:**
- `forceReinstall` - Force reinstallation of existing dependencies

**Returns:** Promise<boolean> - Success status

**Responsibilities:**
- Download Nosey Parker Docker image
- Download BFG tool
- Validate Java installation
- Show progress notifications

### **cleanupDependencies(): Promise<void>**
Complete cleanup of all extension dependencies.

**Responsibilities:**
- Remove Docker images: `ghcr.io/praetorian-inc/noseyparker:v0.24.0`
- Delete BFG jar file
- Remove temporary directories
- Clean up Docker volumes

---

## 🖥️ LeakLockPanel.js

### **Class: LeakLockPanel**

Main panel provider for the scanner interface.

#### **Properties**
```javascript
_extensionUri: vscode.Uri           // Extension context URI
_scanResults: Array                 // Array of detected secrets
_replacementValues: Object          // User-defined replacement values
_selectedDirectory: string | null   // Currently selected scan directory
_isScanning: boolean               // Scanning state flag
_scanProgress: any                 // Progress tracking object
_dependenciesInstalled: boolean    // Dependency installation status
_panel: vscode.WebviewPanel | null // Webview panel reference
```

#### **Static Methods**

##### **createOrShow(extensionUri: vscode.Uri): void**
Creates or reveals the main scanner panel.

**Parameters:**
- `extensionUri` - Extension context URI

**Behavior:**
- Reuses existing panel if available
- Creates new panel if none exists
- Focuses panel in appropriate column

```javascript
LeakLockPanel.createOrShow(context.extensionUri);
```

##### **get currentPanel(): LeakLockPanel | null**
Returns the current active panel instance.

```javascript
const panel = LeakLockPanel.currentPanel;
if (panel) {
    panel._updateResults(newResults);
}
```

#### **Instance Methods**

##### **_initializePanel(panel: vscode.WebviewPanel): void**
Initializes the webview panel with content and listeners.

**Parameters:**
- `panel` - VS Code webview panel instance

**Responsibilities:**
- Setup panel disposal listeners
- Check dependencies on startup
- Auto-select workspace if git repository
- Render initial HTML content
- Setup message handlers

##### **_autoSelectWorkspaceIfGitRepo(): Promise<void>**
Automatically selects workspace directory if it contains a git repository.

**Logic:**
```javascript
const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
const gitPath = path.join(workspaceFolder.uri.fsPath, '.git');
if (fs.existsSync(gitPath)) {
    this._selectedDirectory = workspaceFolder.uri.fsPath;
}
```

##### **_selectDirectory(): Promise<void>**
Opens directory selection dialog.

**Features:**
- Starts at current workspace
- Updates UI after selection
- Validates selected directory

##### **_scanRepository(useWorkspace?: boolean): Promise<void>**
Executes repository scanning workflow.

**Parameters:**
- `useWorkspace` - Use current workspace instead of selected directory

**Workflow:**
1. Validate the scan directory
2. Refresh every ref (`git fetch --tags`, read-only — the scan never prunes) so
   remote-only history is not skipped
3. Run each enabled engine; a missing engine disables that engine, not the scan
4. Map every engine's output through the same post-processing
5. Merge and attribute results, then record what was covered
6. Update the UI

See [SCANNING_ENGINES.md](SCANNING_ENGINES.md) for the engine comparison. Argument
construction lives in `scan-engine-config.js` and `scan-engines.js`, neither of which
imports `vscode`, so the flags below are unit-testable.

**Commands Generated:**
```bash
# --- Gitleaks (default engine) -------------------------------------------------
# History across every ref. Without --all only the current branch is covered.
gitleaks git --log-opts=--all --report-format json --report-path "${report}" \
  --exit-code 0 --no-banner "${scanPath}"

# Working tree, including untracked and .gitignore'd files.
gitleaks dir --report-format json --report-path "${report}" \
  --exit-code 0 --no-banner "${scanPath}"

# Pre-8.19 builds (probed from --help, since many builds report no version):
#   gitleaks detect --source "${scanPath}" --log-opts=--all ...
#   gitleaks detect --source "${scanPath}" --no-git ...

# --- TruffleHog (optional; verification is opt-in) -----------------------------
# <repoUrl> is built with url.pathToFileURL(scanPath).href, not string interpolation:
# "file://" + a raw path is not a valid URL once a Windows drive letter, a backslash
# or a space is involved.
trufflehog git <repoUrl> --json --no-update --results=verified,unknown
trufflehog git <repoUrl> --json --no-update --no-verification

# --- Nosey Parker (optional, legacy; image pinned, archived upstream) ----------
# The datastore lives in the OS temp directory, never inside the scanned tree.
docker run --rm -v "${datastoreParent}:/workspace" \
  ghcr.io/praetorian-inc/noseyparker:v0.24.0 \
  datastore init --datastore /workspace/noseyparker.np

docker run --rm -v "${scanPath}:/scan" -v "${datastorePath}:/datastore" \
  ghcr.io/praetorian-inc/noseyparker:v0.24.0 \
  scan --datastore /datastore --git-history full \
       --ruleset "${ruleset}" --max-file-size "${maxFileSizeMb}" /scan

# The three no-limit flags are load-bearing: the upstream defaults are
# --max-matches 3, --max-provenance 3 and --min-score 0.05, which discard
# findings before Leak Lock ever parses them.
docker run --rm -v "${datastorePath}:/datastore" \
  ghcr.io/praetorian-inc/noseyparker:v0.24.0 \
  report --datastore /datastore --format json \
         --max-matches -1 --max-provenance -1 --min-score 0 \
         --suppress-redundant true
```

##### **_fixSecrets(replacements: Object): Promise<void>**
Generates BFG commands for secret remediation.

**Parameters:**
- `replacements` - Object mapping secrets to replacement values

**Format:**
```javascript
{
    "api_key_123": "***REMOVED***",
    "password_abc": "***REMOVED***"
}
```

**Generated Files:**
- Creates `replacements.txt` file for BFG tool
- Format: `original_secret==>replacement_value`

##### **_runBFGCommand(replacements: Object): Promise<void>**
Executes BFG tool for git history cleanup.

**Parameters:**
- `replacements` - Secret replacements mapping

**Commands Executed:**
```bash
cd "${scanPath}"
java -jar "${bfgPath}" --replace-text "${replacementsFile}"
git reflog expire --expire=now --all
git gc --prune=now --aggressive
```

**Safety Features:**
- Confirmation dialog before execution
- Progress tracking
- Error handling and reporting

##### **_getHtmlForWebview(): string**
Generates HTML content for the webview panel.

**Returns:** Complete HTML string for webview

**Components:**
- CSS styling for main area layout
- Dependency status section
- Directory selection interface
- Scanning controls
- Results table
- Remediation interface

##### **_getResultsHtml(): string**
Generates HTML for scan results display.

**Returns:** HTML string for results section

**Features:**
- Sortable table with secret details
- Severity color coding
- File and line information
- Action buttons for each secret
- Bulk selection capabilities

##### **_checkDependenciesOnStartup(): Promise<void>**
Validates dependencies during panel initialization.

**Logic:**
- Checks Docker availability
- Validates Nosey Parker image
- Verifies BFG tool presence
- Updates `_dependenciesInstalled` flag

##### **_installDependencies(): Promise<void>**
Dependency installation with UI integration.

**Features:**
- Progress reporting in webview
- Error handling and display
- UI state updates after completion

##### **_resetDependencyStatus(): void**
Resets dependency status for troubleshooting.

**Behavior:**
- Sets `_dependenciesInstalled` to false
- Updates UI to show setup section
- Allows manual re-installation

##### **dispose(): void**
Cleanup method for panel disposal.

**Responsibilities:**
- Dispose webview panel
- Clear static reference
- Prevent memory leaks

---

## 👋 WelcomeViewProvider.js

### **Class: WelcomeViewProvider**

Activity bar sidebar view provider.

#### **Properties**
```javascript
_extensionUri: vscode.Uri     // Extension context URI
_view: vscode.WebviewView     // Webview view reference
```

#### **Methods**

##### **constructor(extensionUri: vscode.Uri)**
Creates welcome view provider instance.

##### **resolveWebviewView(webviewView: vscode.WebviewView): void**
Initializes the welcome webview.

**Parameters:**
- `webviewView` - VS Code webview view instance

**Setup:**
- Configure webview options
- Set HTML content
- Setup message handlers

##### **_getHtmlForWebview(): string**
Generates welcome interface HTML.

**Components:**
- Welcome message and description
- Launch button for main panel
- Styled with VS Code theme integration

##### **static get viewType(): string**
Returns the view type identifier.

**Returns:** `'leak-lock.welcome'`

---

## 📝 Data Structures

### **Scan Result Object**
```typescript
interface ScanResult {
    type: string;           // Secret type (e.g., "API Key", "Password")
    severity: string;       // Severity level ("high", "medium", "low", "safe")
    file: string;          // Relative file path
    line: number;          // Line number in file
    preview: string;       // Preview of detected content
    fullMatch: string;     // Complete matched content
    rule: string;          // Detection rule used
    isUntracked?: boolean; // True when found in working tree only (not tracked or in git history)
}
```

### **Dependency Status Object**
```typescript
interface DependencyStatus {
    docker: boolean;        // Docker availability
    noseyparker: boolean;   // Nosey Parker image present
    bfg: boolean;          // BFG tool available
    java: boolean;         // Java runtime available
}
```

### **Replacement Mapping**
```typescript
interface ReplacementMap {
    [secretValue: string]: string;  // secret -> replacement mapping
}
```

---

## 🎯 Command Registration

### **Extension Commands**
```javascript
// Available VS Code commands
'leak-lock.openPanel'          // Open main scanner panel
'leak-lock.scanRepository'     // Start repository scan
'leak-lock.fixSecrets'         // Open remediation interface
'leak-lock.cleanup'            // Clean up dependencies
'leak-lock.helloWorld'         // Test command
'leak-lock.fileScan'           // Legacy file scan
'leak-lock.projectScan'        // Legacy project scan
```

### **Message Commands (Webview → Extension)**
```javascript
// Internal webview messages
{
    command: 'scan',
    useWorkspace?: boolean
}

{
    command: 'fix',
    replacements: ReplacementMap
}

{
    command: 'selectDirectory'
}

{
    command: 'installDependencies'
}

{
    command: 'runBFG',
    replacements: ReplacementMap
}

{
    command: 'openFile',
    file: string,
    line: number
}

{
    command: 'resetDependencies'
}

{
    command: 'openMainPanel'  // From welcome view
}
```

---

## 🔄 Event Handling

### **Panel Lifecycle Events**
```javascript
// Panel creation
panel.onDidDispose(() => {
    LeakLockPanel.currentPanel = null;
});

// Message handling
panel.webview.onDidReceiveMessage(message => {
    switch (message.command) {
        case 'scan':
            this._scanRepository(message.useWorkspace);
            break;
        // ... other commands
    }
});
```

### **Progress Events**
```javascript
// Scanning progress
vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Scanning for secrets...",
    cancellable: false
}, async (progress) => {
    progress.report({ increment: 25, message: "Initializing datastore..." });
    // ... scanning steps
});
```

---

## 🛠️ Utility Functions

### **File Operations**
```javascript
// Safe file creation
const createTempFile = (content: string, filename: string): string => {
    const tempPath = path.join(__dirname, 'temp', filename);
    fs.writeFileSync(tempPath, content, 'utf8');
    return tempPath;
};

// Directory validation
const isGitRepository = (dirPath: string): boolean => {
    return fs.existsSync(path.join(dirPath, '.git'));
};
```

### **Command Execution**
```javascript
// Async command execution
const execAsync = util.promisify(exec);

// Safe command execution with timeout
const executeCommand = async (command: string, timeout = 30000): Promise<string> => {
    return new Promise((resolve, reject) => {
        const child = exec(command, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve(stdout);
        });
        
        setTimeout(() => {
            child.kill();
            reject(new Error('Command timeout'));
        }, timeout);
    });
};
```

---

## 🔒 Security APIs

### **Input Sanitization**
```javascript
// File path validation
const sanitizePath = (inputPath: string): string => {
    return path.resolve(inputPath);  // Prevents directory traversal
};

// Command injection prevention: commands are never assembled as shell strings,
// so there is nothing to escape. execFile and spawn take the program and an
// argument array, no shell parses the result, and a path containing a quote,
// a space or a $ is passed through as one literal argument.
const { execFile } = require('child_process');
execFile('git', ['log', '--all', '--', userSuppliedPath], (error, stdout) => {
    // ...
});
```

### **Secure Temporary Files**
```javascript
// Create secure temporary directory
const createSecureTempDir = (): string => {
    const tempDir = path.join(__dirname, 'temp', 
        crypto.randomBytes(16).toString('hex'));
    fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    return tempDir;
};
```

---

## 📊 Error Handling

### **Error Types**
```typescript
// Custom error classes
class DependencyError extends Error {
    constructor(message: string, public dependency: string) {
        super(message);
    }
}

class ScanError extends Error {
    constructor(message: string, public path: string) {
        super(message);
    }
}
```

### **Error Handling Patterns**
```javascript
// Graceful error handling
try {
    await this._scanRepository();
} catch (error) {
    if (error instanceof DependencyError) {
        vscode.window.showErrorMessage(
            `Missing dependency: ${error.dependency}`
        );
    } else {
        vscode.window.showErrorMessage(
            `Scan failed: ${error.message}`
        );
    }
}
```

This API reference provides comprehensive documentation for all major components and methods in the Leak Lock extension.
