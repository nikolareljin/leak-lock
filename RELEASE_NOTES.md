# Release notes, v0.9.1

## Fixed
- Find Java and git-filter-repo on macOS without a shell profile edit. A VS Code launched from Finder inherits no shell PATH, so both tools were reported missing on machines that had them; they now use the same absolute-path search the scan engines already used.
- Search Homebrew's keg-only openjdk prefixes, JAVA_HOME and /usr/libexec/java_home for a JVM, so brew install openjdk works without linking java onto PATH. The Java-specific locations are searched before the common ones, because macOS ships an always-executable /usr/bin/java stub that would otherwise be resolved first and prevent java_home from ever being consulted.
- Match the installer that actually ran when reporting that git-filter-repo still cannot be found. A Homebrew install was told to add a Python user-scripts directory to PATH, which had nothing to do with what it did.
- Record the released version in package-lock.json, which still named the previous one.
- Ask Python where pip install --user actually writes instead of assuming ~/.local/bin, so a git-filter-repo installed by macOS's framework Python into a versioned directory under ~/Library/Python is found.
- Prefer Homebrew for installing git-filter-repo on macOS when it is present, since Homebrew's Python refuses a --user pip install under PEP 668.
- Run BFG through the resolved Java rather than a bare java, so a rewrite cannot fail on a machine whose dependency panel reported Java as present.
- Resolve Java and Docker on the activation path too. checkDependencies and installDependencies still probed with a shell and a bare name, so activation reported Java and Docker missing on the machines this release is about, while the sidebar reported them present.
- Use one resolved Docker client everywhere. The dependency panel, the scan gate, the engine runner, the image pull and the file scan each invoked a bare docker, so they could disagree about whether Docker exists and an engine could be skipped on a machine able to run it. A test asserts no call site reintroduces a bare name.
- Resolve the interpreter for the pip install fallback as well, so the install button does not fail before pip starts on a Mac without Homebrew.
- Search the shared directories on Windows too when locating git-filter-repo. The Windows path returned early, so a launcher in an already-searched common directory such as Chocolatey's bin was findable on every platform except that one.
- Stop running Docker and the BFG download through a shell. The image pull, image removal and volume cleanup interpolated values into a command line, and the download depended on curl being present; the BFG download now uses the same downloader the engine installs use.
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
