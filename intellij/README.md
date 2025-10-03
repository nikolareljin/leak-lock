## Leak Lock for IntelliJ Platform

Leak Lock plugin for IntelliJ IDEA brings the same scanning and remediation workflow from the VS Code/Visual Studio extensions to the IntelliJ Platform.

### Features
- Scan a chosen directory (or current project base) using Nosey Parker via Docker
- Parse JSON results and list findings (rule, file, line, preview)
- Open files at the finding line
- Run BFG cleanup with generated replacement rules and perform git maintenance
- Toolbar actions: "Leak Lock: Open Scanner" and "Leak Lock: Scan Project"
- Status bar indicator with live progress (install, scan, report, BFG)
- Progress indicators in background tasks with stage messages

### Requirements
- IntelliJ IDEA 2022.3+ (Community or Ultimate)
- Docker Desktop installed and running (`docker --version` works)
- Java Runtime (`java -version` works) for BFG

### Build & Run
Option A: One‑click via Gradle Wrapper
```bash
cd intellij/LeakLockIntelliJ
./gradlew runIde   # Windows: gradlew.bat runIde
```

Option B: From IntelliJ IDEA
1. Open `intellij/LeakLockIntelliJ` as a Gradle project
2. Let IDEA import; ensure Kotlin plugin is installed
3. Run Gradle task: `runIde` to launch a sandbox IDE with the plugin loaded
4. Open the Tool Window: View → Tool Windows → Leak Lock

Keyboard shortcut
- Scan Project: Ctrl+Alt+Shift+P (Windows/Linux) or Cmd+Alt+Shift+P (macOS)

### Usage
- Toolbar: click "Leak Lock: Open Scanner" to open the tool window
- Toolbar: click "Leak Lock: Scan Project" to immediately scan the current project base dir
- Tools menu: both actions are available under Tools
- In the tool window:
  - Click "Install Dependencies" to verify Docker/Java and pull Nosey Parker image
  - Choose a directory (defaults to project base dir)
  - Click "Scan" and review results; progress shows in the status bar and task indicator
  - Double-click a result or press "Open File" to navigate
  - Click "Run BFG + Cleanup" to rewrite git history and purge secrets

### Project Layout
```
LeakLockIntelliJ/
├── build.gradle.kts
├── settings.gradle.kts
├── gradle.properties
└── src/
    └── main/
        ├── kotlin/
        │   └── com/leaklock/intellij/
        │       ├── LeakLockToolWindowFactory.kt
        │       ├── LeakLockPanel.kt
        │       ├── models/Finding.kt
        │       ├── services/ProcessRunner.kt
        │       ├── services/ScannerService.kt
        │       └── services/BfgService.kt
        └── resources/
            └── META-INF/plugin.xml
```

### Notes
- Nosey Parker datastore is created under your temp folder and cleaned up after scanning.
- BFG jar is downloaded to a temp location on first use.
- On Windows, commands run via `cmd /c` and on macOS/Linux via `/bin/sh -lc`.

If you want me to wire progress indicators and richer UI styling, I can extend the tool window quickly.
