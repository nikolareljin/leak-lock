# Release notes, v0.9.1

## Fixed
- Find Java and git-filter-repo on macOS without a shell profile edit. A VS Code launched from Finder inherits no shell PATH, so both tools were reported missing on machines that had them; they now use the same absolute-path search the scan engines already used.
- Search Homebrew's keg-only openjdk prefixes, JAVA_HOME and /usr/libexec/java_home for a JVM, so brew install openjdk works without linking java onto PATH.
- Ask Python where pip install --user actually writes instead of assuming ~/.local/bin, so a git-filter-repo installed by macOS's framework Python into a versioned directory under ~/Library/Python is found.
- Prefer Homebrew for installing git-filter-repo on macOS when it is present, since Homebrew's Python refuses a --user pip install under PEP 668.
- Run BFG through the resolved Java rather than a bare java, so a rewrite cannot fail on a machine whose dependency panel reported Java as present.
- Resolve Java and Docker on the activation path too. checkDependencies and installDependencies still probed with a shell and a bare name, so activation reported Java and Docker missing on the machines this release is about, while the sidebar reported them present.
- Discover every openjdk keg Homebrew has installed by reading its opt directory, rather than matching a fixed list of versions, and include openjdk@8 since BFG is documented as needing Java 8+.
- Resolve the Python interpreter before spawning it to ask where pip installed things, so the probe is not defeated by the same missing PATH it exists to work around.
- Name the installer the git-filter-repo button will actually run. Label and command now come from one call, so the button cannot offer pip and then invoke Homebrew.
- Correct the macOS Java install guidance, which recommended the keg-only formula that produced the failure it was shown next to.

## Added
- A leakLock.java.path setting, to point at a specific JVM.
- A commit-msg hook that refuses AI attribution trailers. GitHub's contributors graph counts Co-authored-by lines, so one trailer adds a bot to the contributors page and removing it later costs a rewrite of every commit that follows. The match is on the address, not on words in the line, so a co-author who happens to be named Claude or Cursor is unaffected.

## Changed
- Update @humanfs/node to 0.16.8 (GHSA-p498-v437-472g) and bump eslint and @types/node. Development-only dependencies; packaging excludes them, so no published extension was affected.
- Exclude @types/vscode from grouped Dependabot bumps. It is pinned to engines.vscode on purpose, and raising it to satisfy a types update would drop support for every user below that VS Code build.
