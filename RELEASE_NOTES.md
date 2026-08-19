# Release notes, v0.9.0

## Added
- Import a previous scan report and check each finding as resolved, still present, or unverifiable.
- Record repository identity in exported reports and enforce it on import, using root commits and origin URL rather than local path.
- Offer to switch to the repository a report belongs to when that repository is available on this machine.
- Show findings introduced since an imported report, including the commit that first introduced each value.
- Keep imported findings as historical records, separate from current cleanup selections.
- Build commit permalinks for self-hosted Git remotes, with GitHub, GitLab, Bitbucket, and Gitea URL layouts plus leakLock.git.customHostTypes overrides.
- Add VERSION and RELEASE_NOTES.md as release sources, with tooling that generates GitHub Release text and annotated tag notes from the same file.

## Changed
- Increase the default per-engine scan timeout from 300 seconds to 600 seconds for larger repositories.
- Refresh the README first screen with current badges, project positioning, screenshot, and release workflow links.
- Publish releases from the checked-in version and release notes; duplicate tags now fail fast instead of auto-bumping in CI.
- Allow the release notes tool to sync the current release into CHANGELOG.md while preserving the existing heading style.

## Fixed
- Check a commit permalink against the layout and repository it claims, not only its hostname, before opening it in a browser.
- Stop matching a value that spans lines, such as a PEM key, against any file that merely shares one of its lines.
- Run verification searches with object replacement disabled, so rewritten commits cannot hide original objects.
- Treat redacted reports, decoded scanner values, values recorded only in shortened form, and bounded checks as unverifiable instead of resolved.
- Refuse cross-repository report imports unless the user explicitly compares anyway.
- Prevent a verification in flight from overwriting a newer report result.
- Avoid rendering unreadable dates as Invalid Date.
- Stop failed searches from logging the value they searched for.
- Compare SSH remotes consistently when the URL includes a port.
- Read repository identity from scan results instead of current selection state.
- Find and run the Windows git-filter-repo executable from user-level Python installs on Windows, even when the user Scripts directory is not on PATH.
- Label Windows user-level Python discovery distinctly from a normal PATH launcher.
- Keep Bitbucket custom-host documentation aligned with the URL layout the extension builds.
- Treat custom host type keys case-insensitively.
