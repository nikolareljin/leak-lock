# Release notes, v0.10.0

## Added
- Add Foxguard working-tree code analysis in a separate, read-only Code issues section. Credential findings remain separate from cleanup candidates and each side is shown as soon as it finishes, in either order.
- Add compact Results, Cleanup, and Issues shortcuts for long result pages. Each shortcut expands on hover or keyboard focus and only links to a rendered section.
- Include Foxguard code issues in JSON export and import. Imported code issues remain read-only evidence and are not treated as credential-history verification results.

## Changed
- Start Foxguard with the credential engines and show its progress in Scan coverage while credential results remain available. Foxguard has a separate 120-second default deadline that can be increased with leakLock.foxguard.timeoutSeconds.
- Keep cleanup selections made while Foxguard is still running, and refuse to prepare or run a history rewrite until every engine finishes, so a rewrite cannot change the working tree under an active scan.
- Refuse a second scan, a repository switch or a report import while a scan runs. Overlapping scans cleared each other's state, so a scan could end showing Foxguard issues and no credential findings.
- Update the user documentation and product site with Foxguard behavior, result navigation, and search metadata.
- Update brace-expansion to 5.0.12 (GHSA-q2hr-2g5m-vwhr). Development-only dependency; packaging excludes it, so the published extension is not affected.
