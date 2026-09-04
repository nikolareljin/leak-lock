# Release notes, v0.9.1

## Fixed
- Find Java and git-filter-repo on macOS without a shell profile edit. A VS Code launched from Finder inherits no shell PATH, so both tools were reported missing on machines that had them; they now use the same absolute-path search the scan engines already used.
- Search Homebrew's keg-only openjdk prefixes, JAVA_HOME and /usr/libexec/java_home for a JVM, so brew install openjdk works without linking java onto PATH.
- Ask Python where pip install --user actually writes instead of assuming ~/.local/bin, so a git-filter-repo installed by macOS's framework Python into a versioned directory under ~/Library/Python is found.
- Prefer Homebrew for installing git-filter-repo on macOS when it is present, since Homebrew's Python refuses a --user pip install under PEP 668.
- Run BFG through the resolved Java rather than a bare java, so a rewrite cannot fail on a machine whose dependency panel reported Java as present.
- Correct the macOS Java install guidance, which recommended the keg-only formula that produced the failure it was shown next to.

## Added
- A leakLock.java.path setting, to point at a specific JVM.
- A commit-msg hook that refuses AI attribution trailers. GitHub's contributors graph counts Co-authored-by lines, so one trailer adds a bot to the contributors page and removing it later costs a rewrite of every commit that follows.

## Changed
- Update @humanfs/node to 0.16.8 (GHSA-p498-v437-472g) and bump eslint and @types/node. Development-only dependencies; packaging excludes them, so no published extension was affected.
- Exclude @types/vscode from grouped Dependabot bumps. It is pinned to engines.vscode on purpose, and raising it to satisfy a types update would drop support for every user below that VS Code build.
