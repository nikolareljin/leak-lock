# Change Log

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
- **UI Architecture**: Complete reorganization with sidebar-based controls and main area results display
- **Directory Selection**: Enhanced git repository auto-detection and manual directory selection
- **Dependency Installation**: Streamlined installation process with better progress tracking
- **Scan Results Display**: Improved table layout and formatting in main editor area

### Fixed
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