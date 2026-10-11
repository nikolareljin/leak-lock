# Release notes, v0.10.0

## Added
- Add Foxguard working-tree code analysis in a separate, read-only Code issues section. Credential findings remain separate from cleanup candidates and are shown as soon as credential scans finish.
- Add compact Results, Cleanup, and Issues shortcuts for long result pages. Each shortcut expands on hover or keyboard focus and only links to a rendered section.
- Include Foxguard code issues in JSON export and import. Imported code issues remain read-only evidence and are not treated as credential-history verification results.

## Changed
- Start Foxguard with the credential engines and show its progress in Scan coverage while credential results remain available. Foxguard has a separate 120-second default deadline that can be increased with leakLock.foxguard.timeoutSeconds.
- Update the user documentation and product site with Foxguard behavior, result navigation, and search metadata.
