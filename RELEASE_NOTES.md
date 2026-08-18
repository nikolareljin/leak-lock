# Release notes, v0.9.0

## Added
- Import a previous scan report and check which findings are resolved.
- Enforce repository identity on imported reports before comparing findings.
- Show findings introduced since the imported report, with the commit that introduced them.
- Keep imported findings as historical records, not cleanup targets.

## Fixed
- Run verification searches with object replacement disabled, so rewritten commits cannot hide original objects.
- Refuse cross-repository report imports unless the user explicitly compares anyway.
- Report unverifiable findings as their own status instead of treating them as resolved.
