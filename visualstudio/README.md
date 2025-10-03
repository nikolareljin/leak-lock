# Leak Lock for Visual Studio (VSIX)

Leak Lock Visual Studio extension brings the same scanning and remediation workflow from the VS Code extension to Visual Studio. It scans repositories for secrets using Nosey Parker (Docker) and removes them from git history using BFG.

## Features
- Scan a selected directory or current solution folder via Dockerized Nosey Parker
- Show results with rule, file, line, and preview
- Generate and run BFG cleanup with replacements
- Open file at the finding location

## Requirements
- Visual Studio 2022 (17.0+) with VS SDK tooling
- Docker Desktop installed and running (`docker --version` works)
- Java Runtime Environment (`java -version` works) for BFG

## Build & Run
1. Open the solution `visualstudio/LeakLock.VisualStudio.sln` in Visual Studio 2022
2. Restore NuGet packages
3. Build the project (Debug/Release)
4. Press F5 to launch the experimental instance of Visual Studio and load the extension

## Usage
- Tools -> Leak Lock -> Open Scanner (or search “Leak Lock” in Quick Launch)
- Click “Install Dependencies” (pull Nosey Parker image, verify Java)
- Choose directory (defaults to current Solution folder if available)
- Run Scan – results list will populate
- Optionally run BFG cleanup to purge secrets from git history

## Notes
- The extension uses a temporary Nosey Parker datastore under your temp folder.
- The BFG replacements file is generated on demand inside the scanned repo root and deleted after cleanup.
- Docker volumes are not persisted; all runs are `--rm` containers.

## Project Structure
```
LeakLock.VSExtension/
├── LeakLockVSIX.csproj
├── source.extension.vsixmanifest
├── LeakLockPackage.vsct
├── VSPackage.cs
├── Commands/
│   └── OpenLeakLockCommand.cs
├── Models/
│   ├── Finding.cs
│   └── ScanResult.cs
├── Services/
│   ├── ProcessRunner.cs
│   ├── ScannerService.cs
│   └── BfgService.cs
├── LeakLockToolWindow.cs
├── LeakLockToolWindowControl.xaml
└── LeakLockToolWindowControl.xaml.cs
```

## Limitations
- Parsing assumes Nosey Parker report `--format json` structure as described in `NOSEYPARKER_FIXES.md`.
- Some Visual Studio SDK packaging details may differ by environment; if build fails, let me know and I can adjust metadata.
