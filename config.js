/**
 * Configuration constants for Leak Lock VS Code Extension
 * Centralizes all hardcoded paths, URLs, and settings
 */

module.exports = {
    // BFG Tool Configuration
    BFG_JAR_PATH: '/tmp/bfg.jar',
    BFG_DOWNLOAD_URL: 'https://repo1.maven.org/maven2/com/madgag/bfg/1.14.0/bfg-1.14.0.jar',
    
    // Docker Configuration
    DOCKER_IMAGE: 'ghcr.io/praetorian-inc/noseyparker:latest',
    DOCKER_PULL_TIMEOUT: 120000, // 2 minutes
    
    // Scanning Configuration
    TEMP_DATASTORE_NAME: '.noseyparker-temp',
    SCAN_TIMEOUT: 300000, // 5 minutes
    REPORT_TIMEOUT: 60000, // 1 minute
    
    // File and Directory Patterns
    DEPENDENCY_PATTERNS: [
        'node_modules',
        'vendor',
        '.git',
        'dist',
        'build',
        'target',
        'out',
        'bin',
        '.vscode',
        '.idea',
        '__pycache__',
        'venv',
        'env',
        '.env',
        'site-packages',
        'packages',
        '.m2',
        '.gradle',
        '.cargo',
        'Pods',
        '.DS_Store',
        'Thumbs.db'
    ],
    
    // Default Replacement Values
    DEFAULT_REPLACEMENTS: {
        'api_key': '***REMOVED_API_KEY***',
        'password': '***REMOVED_PASSWORD***',
        'secret': '***REMOVED_SECRET***',
        'token': '***REMOVED_TOKEN***',
        'private_key': '***REMOVED_PRIVATE_KEY***'
    },
    
    // UI Configuration
    MAX_SECRET_DISPLAY_LENGTH: 50,
    PROGRESS_UPDATE_INTERVAL: 1000, // 1 second
    
    // Severity Configuration
    SEVERITY_COLORS: {
        high: '#ff6b6b',
        medium: '#ffa726', 
        low: '#66bb6a',
        info: '#42a5f5',
        dependency: '#9e9e9e'
    },
    
    // Command Configuration
    COMMANDS: {
        HELLO_WORLD: 'leak-lock.helloWorld',
        OPEN_PANEL: 'leak-lock.openPanel',
        START_SCAN: 'leak-lock.startScan',
        CLEANUP: 'leak-lock.cleanup'
    }
};