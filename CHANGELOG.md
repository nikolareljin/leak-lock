# Change Log

## September 29, 2025
### Added
- **Comprehensive Installation Instructions**: Step-by-step guides for installing Docker and Java with platform-specific instructions
- **Platform-Specific Setup Guides**: Detailed instructions for Windows, macOS, and Linux with direct download links
- **Visual Progress Indicators**: Real-time scanning progress with animated spinner and stage-by-stage tracking
- **Enhanced Empty Results Display**: Celebratory interface when no secrets found with security checklist and best practices
- **Interactive Security Guide**: Built-in security best practices guide accessible from scan results
- **Advanced Scan Progress**: Five-stage progress tracking (Docker Check → Pull Image → Initialize → Scan Files → Process Results)
- **Command Injection Security Fixes**: Proper shell path escaping and input validation to prevent security vulnerabilities
- **Centralized Configuration**: Extracted hardcoded paths to shared config.js for better maintainability
- **Enhanced Dependency Management**: Smart dependency section that auto-hides when all dependencies are installed
- **Detailed Dependency Status**: Individual status tracking for Docker, Nosey Parker, Java, and BFG with version information
- **Improved UI/UX**: Progress indicators, animations, and better visual feedback during operations
- **Advanced Error Handling**: Comprehensive error messages and recovery suggestions for dependency issues
- **Package Updates**: Updated package-lock.json with latest dependency versions

### Security
- **Fixed Critical Path Validation Flaw**: Corrected path traversal detection to check input BEFORE normalization, preventing bypass attempts
- **Robust Directory Traversal Prevention**: Added comprehensive regex patterns to detect all path traversal attempts (../, ..\, etc.)
- **Enhanced Working Directory Protection**: Added validation to prevent access outside the current working directory
- **Improved Path Containment Logic**: Fixed validateDockerPath() to use path.relative() for accurate containment checking
- **Fixed Docker Command Injection Vulnerabilities**: Comprehensive path validation and sanitization for all Docker volume mounts
- **Enhanced Path Security**: Added validateDockerPath() and sanitizeDockerVolumeName() functions to prevent directory traversal attacks
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