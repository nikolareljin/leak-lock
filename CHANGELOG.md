# Change Log

## 0.7.0
### Added
- **Multiple Detection Engines**: Leak Lock no longer depends on a single scanner. **Gitleaks** (MIT, actively maintained, no Docker or JVM required), **TruffleHog** (live credential verification) and **Nosey Parker** (legacy, archived upstream) are **all enabled by default** and run together, their findings merged into one attributed list. A missing engine binary disables that engine, never the whole scan, and is reported in the coverage panel so an engine you have not installed is visible rather than silently absent. Enabling TruffleHog makes no network call on its own — verification is the separate `leakLock.trufflehog.verify` setting, off by default. Configure with `leakLock.scan.engines`. See [docs/SCANNING_ENGINES.md](docs/SCANNING_ENGINES.md).
- **Engine Binaries Are Found Outside the Shell `PATH`**: a GUI-launched VS Code does not inherit your shell's `PATH` — never on macOS, and frequently missing `~/.local/bin` on Linux — so an engine you had definitely installed was reported "not installed" and skipped. Leak Lock now also looks in `~/.local/bin`, `~/bin`, `~/go/bin`, `/usr/local/bin`, `/usr/bin`, `/opt/homebrew/bin`, `/home/linuxbrew/.linuxbrew/bin` and the common Windows locations. `leakLock.gitleaks.binaryPath` and `leakLock.trufflehog.binaryPath` still take an absolute path for anything unusual.
- **Engine Attribution**: Every finding names the engines that reported it and, from the engines that actually ran, the ones that did not. This is the diagnostic that turns "another scanner found more than you did" from a mystery into a checkable fact — which is how this release started.
- **Live Credential Verification**: TruffleHog can confirm whether a discovered credential still works. A verified finding is badged `VERIFIED LIVE` and ranked above every rule-name heuristic, because rewriting history does not revoke a working key — it has to be rotated first. Verification makes read-only network calls to third-party providers *using the discovered credential*, so it is off by default (`leakLock.trufflehog.verify`).
- **Manual Redaction Rules**: A **Source text → Replace with** editor removes content no scanner flags — an internal hostname, a private repository or team name, a customer identifier, an old email domain. Rules match literally or by regular expression and run through the same prepare, review, rewrite, verify and confirm-push pipeline as a detected secret. They persist across a re-scan, because unlike selection they are not tied to result indices.
- **Dry Run for Manual Rules**: A finding arrives with provenance; a typed string arrives with none. Preview reports the commits, files and branches a rule touches before anything is rewritten, using a pickaxe search over all refs so content that was added and later removed is found. A rule matching nothing is called out — it is almost always a typo — and a bounded preview says it is bounded.
- **Host-Aware Execution**: Running three scanners over a large history is real work, so Leak Lock now sizes the plan to the machine. `leakLock.scan.executionMode` defaults to `auto`, which inspects core count, available memory — respecting **container limits**, since `os.totalmem()` reports the *host's* memory inside a devcontainer, exactly where resources are tightest — and current load. A capable host runs every engine in parallel (capped at `cores − 2` so the editor keeps room); a modest one runs them one at a time; a constrained one (≤ 2 cores or < 4 GB) runs Gitleaks alone. **If host capacity causes an engine to be skipped, the coverage panel says so and names it** — fewer engines means fewer findings, and a silent downgrade is the same failure this release exists to fix. `parallel`, `sequential` and `single` override the heuristic in either direction.
- **Scan Coverage Report**: Shown with the results *and* in the no-findings view, because "no findings" is meaningless without its scope. Reports which engines ran and at which versions, which did not and why, ref counts, branches that exist only on the remote, whether refs were refreshed, the ruleset, the size limit, and whether the scan was incomplete. The same record is written to the JSON export, so an exported report can be audited later.

### Fixed
- **An Unreachable Remote Now Stops Preparation With a Message That Cannot Be Misread**: "Prepare BFG/Git-only command" ran `git fetch --prune --tags origin` and, when the remote refused it, reported `Failed to prepare cleanup: Command failed: git fetch …` followed by git's raw remote output. That reads as though a cleanup had been started and failed. Nothing had run. Three changes: the plan check is now **read-only** — `--prune` is gone from it, so planning can no longer delete remote-tracking refs; preparation **stops** rather than producing a half-state, since a plan built from a comparison that could not be made is worse than no plan; and the message leads with **"No cleanup was prepared, and nothing in your repository was changed. No history was rewritten. No secret was removed."**, then names the exact read-only command, states the cause in plain language (SSO authorisation, credentials, network, missing repository) and the fix, with git's raw output folded into a collapsed pane instead of being the headline. The safety rule from #45 is unchanged.
- **Cleanup Failure Messages No Longer Imply More Happened Than Did**: "Git-only cleanup failed" / "BFG cleanup failed" now state that the remote was not touched, because these steps only rewrite local history and the force-push is a separate confirmation.
- **A BFG Cleanup Could Rewrite the Wrong Repository**: `_executeBFGCleanup` resolved its target as `this._selectedDirectory || workspaceFolders[0]`, omitting the scanned path that preparing, the push plan and the Git-only executor all used. A cleanup could therefore rewrite a repository that was never scanned, planned or previewed. Both executors now act on the repository the plan was built for, recorded at prepare time.
- **Findings Were Being Discarded Before They Were Parsed**: `noseyparker report` was invoked with no flags, inheriting upstream defaults that truncate — `--max-matches 3`, `--max-provenance 3`, `--min-score 0.05`. Measured on a fixture with one secret in ten distinct blobs, the report returned **3 matches instead of 10**: seven locations never reached the UI. The no-limit values are now always passed.
- **Remote-Only History Was Never Scanned**: The scan ran against whatever was already in the local object database. A branch existing only as an unfetched remote ref was invisible, and the repository was reported clean. Refs are now refreshed before scanning — the same requirement the rewrite path has enforced since 0.6.0, which was simply never applied to the scan side. This is the more dangerous half: a rewrite that misses a ref leaves a known secret behind, but a scan that misses one produces a false all-clear.
- **A Timed-Out Scan Reported Zero Findings**: The 5-minute limit was hard-coded and rejected the entire scan, so a large repository — the kind most likely to hold a forgotten credential — produced no results at all, indistinguishable from a clean scan once the toast was dismissed. The timeout is now configurable, partial findings are reported, an unmissable banner marks the results incomplete, and the export records it. The timeout also terminates the container instead of abandoning it.
- **The Scanner Read Its Own Datastore**: The Nosey Parker datastore was created inside the directory being scanned, so the scanner enumerated its own SQLite database and Leak Lock wrote into the repository it was auditing. It now lives in the OS temporary directory.
- **Silent Engine Drift**: The container image was `:latest` and pull failures were logged to a console nobody reads, so two machines running the same extension version could produce different findings. The image is pinned to `v0.24.0` — the final release before the project was archived — its version is recorded on every finding and in exports, and a failed pull is reported.
- **`dependencyHandling: "exclude"` Did Nothing**: The setting was advertised in the UI and implemented as a log line. It now writes a real exclude file, restricted to unambiguously third-party directories. `lib/`, `bin/`, `dist/` and `build/` are still scanned: they routinely hold first-party source, and a scanner that silently stops looking at them is worse than one that mislabels them.
- **Regex Redaction Would Have Failed Its Own Verification**: Verification greps with `--fixed-strings`, so a regex rule would have rewritten history correctly and then reported failure. `verifyRemoteRefs` and the generated script now verify patterns as patterns.

### Changed
- **The Cleanup Script Mentions Each Secret Once**: Every value used to appear twice — in the generated rule file and again in its own `git grep` verification line. Verification now re-reads the rule file, so there is one list in one place, the script cannot drift from what was actually rewritten, and sensitive values are no longer pasted through the script body.
- **Cleanup Script Portability**: `#!/usr/bin/env bash` (macOS Homebrew bash and Git Bash are not at `/bin/bash`), bash 3.2 constructs only, `LC_ALL=C` so verification does not depend on the user's locale, and a `command -v` preflight so a missing tool fails immediately with a clear message instead of halfway through a rewrite. Runs on Linux, macOS, and Windows under Git Bash or WSL.
- **Cross-Engine Results Are Merged, Not Duplicated**: The same secret reported by two engines becomes one row carrying the **union** of both engines' fields — corroboration never subtracts detail. Two rules from the same engine at one location stay separate, as before. A field is marked *unavailable* only when no reporting engine supplied it, so a blank cell meaning "nothing here" is never confused with one meaning "this engine cannot tell you".
- **Prepare Is Gated on Total Cleanup Items**: A cleanup consisting only of manual rules — the case that feature exists for — was previously refused with "No secrets selected for removal."
- **Export Detail**: Findings carry identical keys regardless of engine (a field the engine did not supply is `null`, never absent), plus engine attribution, verification status, entropy, fingerprint, column ranges and author metadata. Redacted exports now also drop author name, email and commit message.
- **Validation at Entry**: A redaction source containing `==>` is rejected — that separator decides what the rewrite tool actually removes, and a malformed line would redact something other than what the UI displayed. Empty, whitespace-only and multi-line sources are rejected, invalid regexes and patterns matching the empty string are rejected, and short literals warn.

### Fixed — Review Feedback
- **A Gitleaks-only scan no longer announces a container pull.** The progress line said "Pulling ghcr.io/praetorian-inc/noseyparker…" on scans that never touch Docker; the pull moved into the Nosey Parker engine task and the progress line stayed behind.
- **TruffleHog worked on Windows.** Its repository argument was built as `file://` plus a raw path, which is not a valid URL when the path carries a drive letter or backslashes, so the engine failed outright there. It is now constructed with `pathToFileURL`.
- **`leakLock.scan.includeIgnoredFiles` removed.** It was read into the scan settings but never reached any engine. Testing showed it could not have: Nosey Parker already reads `.gitignore`d files, and Gitleaks' working-tree pass found both an ignored `.env` and an ignored `secrets/` directory. The setting described behaviour that is unconditionally true, so it is gone rather than implemented — a setting that cannot change anything is worse than no setting.
- **`dependencyHandling: "exclude"` now means the same thing for every engine.** Only Nosey Parker accepts an ignore file, so Gitleaks and TruffleHog kept reporting `node_modules` — the setting behaved differently depending on which engines were enabled. Exclusion is now a path rule applied to every engine's output, and the number of findings it hides is stated in the coverage panel rather than left silent.
- **`Leak Lock: File Scan` removed from the Command Palette.** The command was contributed in the manifest but registered only inside `file-scan.js`, which nothing requires, so invoking it failed with "command not found". Its implementation was broken regardless — it ran `noseyparker report` against a datastore that is never created. Tests now assert that every contributed command is registered, that enum settings have one description per value, and that every default is a legal value for its setting.
- **A typo in `leakLock.scan.engines` no longer produces a silent all-clear.** Unknown ids were filtered out without comment, so a misspelling could leave no engines at all and a scan that reported zero findings — indistinguishable from a clean repository. Unknown ids are named, and an empty engine list is an error.

### Fixed — Untracked Findings Were Never Flagged
- **A secret present on disk but never committed was reported as though it were in history.** The check resolved the *display* path against the scan root, and that path already carries the scanned directory's name as a prefix — so it looked for `<scan>/<scanName>/<path>`, which never exists, and every finding fell through as "tracked". The consequence was the wrong remediation: an uncommitted `.env` was presented as needing a history rewrite when deleting the file is the fix. Engine paths are now resolved first. Found by building the test fixture below.

### Added — Test Fixture Generator
- **`tools/seed-fake-leaks.sh`** seeds fake credential leaks into the history of any repository, so the whole flow can be exercised repeatedly: scan, review, prepare, rewrite, force-push, verify, then re-seed and go again. Planted across six branches plus a remote-only branch: AWS keys, GitHub PATs (classic and fine-grained), Slack tokens and webhooks, Stripe test keys, Google/SendGrid/Twilio keys, npm and PyPI tokens, a JWT, an Azure connection string, Postgres/MySQL/MongoDB URLs with passwords, netrc and htpasswd entries, a Docker auth blob, a GCP service-account JSON, and RSA and ed25519 private keys. Everything is fake — AWS's own published example key, `sk_test_` prefixes, freshly generated throwaway SSH keys — so nothing can leak and TruffleHog correctly verifies none of it as live. The values are assembled from fragments at runtime so the script itself is not a file full of detectable secrets. `--local-remote` creates a throwaway bare remote so force-push and post-push verification can be exercised without a real server; `--reset` clears a previous run.

### Changed — Preparing a Cleanup Is Planning, Not Rewriting
- **A local branch ahead of the remote no longer blocks preparation.** Pressing "Prepare Git-only command" returned `Cannot rewrite history: 1 local branch(es) have commits that are not on origin. Push them first, then prepare again.` and produced nothing — even when the branch in question was entirely unrelated to the cleanup, and even though the user had asked only to read the script. Preparation now always produces the script; the **run** is what is refused, with the branches and their commit counts named. The generated script re-checks the same condition itself before touching anything, so running it by hand is equally safe. Nothing about what can actually be rewritten has changed.
- **The block is expressed as an intersection with the branches the rewrite touches**, rather than assuming every ahead branch qualifies. `materializeRemoteBranches()` force-resets every branch that exists on the remote, and `ahead` means "has a remote counterpart and is ahead of it", so the two sets coincide today — but the rule is now correct by construction if materialisation ever becomes selective.
- The banner no longer claims preparation stopped, and no longer tells you to push when you did not ask to rewrite anything.

### Fixed — Sixth Review Pass
- **Website image dimensions matched the files again.** Both `width` and `height` are declared so the browser can reserve space before an image loads, but they drift every time a screenshot is recaptured at a slightly different height — and a stale pair makes the browser stretch the image, which is worse than declaring nothing. Corrected, and a test now compares every declared pair against the PNG header.
- **A symbolic ref was displayed as a branch.** `git branch -a --contains` emits `remotes/origin/HEAD -> origin/main` alongside real branches, and the manual-rule preview listed that whole string as though it were a branch name. The results table already filtered it; the preview added later did not. Both now share one parser, which also handles the `*` current-branch marker and `(HEAD detached at …)`.

### Fixed — Fifth Review Pass
- **An engine installed mid-session is found without reloading the window.** `resolveBinary` cached the negative result, so once an engine had been reported missing it stayed missing for the rest of the session — including immediately after the user followed the install hint shown to them. Only successful resolutions are cached now.
- **Docs no longer describe commands the code does not run.** `docs/API_REFERENCE.md` and `docs/SCANNING_ENGINES.md` still said the scan refresh runs `git fetch --prune --tags`; the scan's fetch is read-only and never prunes, and only the pre-rewrite refresh does. The API reference also demonstrated the TruffleHog repository argument as `"file://${scanPath}"` — the exact string interpolation that breaks on Windows and which the code no longer uses. Documentation that teaches a broken pattern is as harmful as code that ships one.

### Fixed — Fourth Review Pass
- **A literal rule beginning with `regex:` would have been applied as a regular expression.** Both BFG and `git filter-repo` read a leading `regex:` (and, for filter-repo, `glob:` / `literal:`) as a mode prefix in the rule file, so a literal source starting with one would rewrite by a different kind of match than the one displayed — the same failure the `==>` guard exists to prevent. Rejected at entry, with a pointer to regex mode for anyone who genuinely needs to match such text.
- **The refresh setting described a command the scan does not run.** It promised `git fetch --prune --tags`; the scan's fetch is read-only and deliberately omits `--prune`, so the settings UI was misleading. (Only the refresh immediately before a rewrite prunes, where the plan must match the server exactly.)
- **A failed Gitleaks pass no longer discards a partial report.** On a timeout or non-zero exit the tool has often already written part of its JSON; that was thrown away. Whatever it wrote is now recovered, with the pass reported as incomplete — the same treatment the scan timeout already gets.

### Fixed — Third Review Pass
- **"Not checked" is no longer reported as "checked and not live".** TruffleHog emits `Verified: false` under `--no-verification` as well, so with verification off every finding claimed a verdict that was never sought. The field is now `null` in that mode and declared unavailable, so the UI and the export say the credential was not checked rather than implying it was validated against its provider.
- **The development scan helper no longer verifies by default.** `tools/real-scan.js` accepts an arbitrary target repository and hard-coded verification on — while its own comment claimed the opposite — so a casual run against a real repository would have sent discovered credentials to their providers unasked. Opt in with `LEAKLOCK_VERIFY=1`.
- **Scan reports default outside the repository.** `tools/render-screenshots.js` defaulted its input to `scan.json` in the repository root, which `.gitignore` did not cover — one `git add -A` from committing a report full of real secrets. The default is now in the OS temp directory, and `scan.json` is gitignored regardless.

### Fixed — Second Review Pass
- **A regex rule is no longer validated as though JavaScript were the engine that runs it.** The pattern is compiled by JS when typed, but executed by `git log -G` and `git grep -E` (POSIX ERE), BFG (Java) and `git filter-repo` (Python), so JS accepting it proves little. Constructs that commonly diverge — lookahead and lookbehind, named groups, backreferences, and shorthand classes like `\d` — now warn with a POSIX alternative. They warn rather than refuse, because the pattern may be right for the tool in use; the dry run remains the authority, and it reports git's own error.
- **A verification timestamp is recorded whatever the verdict.** Only live credentials carried `verifiedAt`, so "checked, not live" had no timestamp — and that is equally a claim about a moment in time, since a key may have been rotated back since.
- **Line number 0 is preserved.** `parseInt(...) || null` discarded it. Line numbers are 1-based in practice, but a coercion that silently drops a valid value is wrong regardless.

### Fixed — One Secret, One Finding
- **The same secret was reported several times as if it were several problems.** A single credential produced a separate row for each commit it appeared in, another for the working-tree pass of the same engine, another for each rule that matched it, and another for each engine — none of which are separate problems, and all of which a single rewrite removes. Findings are now grouped by **file, line and secret**, and everything that differs is aggregated onto the surviving row: the commit list (shown as *"in N commits"*), a *"+ working tree"* flag when the secret is also still on disk, every rule that matched, and every engine that found it. Nothing is discarded — the full sighting list is in `occurrences` and in the JSON export. On a real scan of this repository the three engines produced 78 raw detections that collapse to 54 distinct findings.
- **Corroboration almost never registered on real repositories.** Merging required byte-identical secrets, and engines routinely capture different spans of the same credential — on a real scan of this repository Nosey Parker reported `mongodb://user:REDACTED@localhost:27017/` where TruffleHog reported the same secret with `/mydb` appended, at the same file, line and commit, and they were shown as two unrelated findings. Merging now keys on position and treats one secret containing the other as the same finding, keeping the longer capture, since a rewrite replaces what it is given and the shorter span would leave the remainder in history. A containment floor of 8 characters stops a short fragment swallowing a longer neighbour. On the same repository this turns two duplicate pairs into two correctly attributed findings.

### Fixed — Results Table Layout
- **The Engine column squeezed Description into an unreadable sliver.** Column widths summed past the available space once the new column was added, so the description wrapped one or two characters per line. Rebalanced, and the manual-rule Actions column no longer clips its Remove button. Both were found by rendering the real webview for the documentation screenshots.
- **The coverage summary counted findings differently from the table beside it.** It summed per-engine counts, which run higher than the merged rows because a secret found by two engines is one row — so it read "6 findings" next to "Found 5 findings". The summary now uses the merged count; per-engine counts stay in the detail.

### Changed — Scan Coverage Panel
- **Collapsed by default, with a one-line summary**: *Gitleaks + Nosey Parker · 162 findings · 186 refs scanned · parallel*. The panel is reference material and on a busy repository its detail ran to hundreds of branch names. Collapsing hides **volume, never caveats** — any warning (refs not refreshed, engines skipped for host capacity, a cached scanner image) is promoted into the summary line as a badge, and an incomplete scan keeps its banner outside the toggle entirely.
- **Left-aligned.** In the no-findings view the panel sat inside the centred "No Security Issues Found!" block and inherited its centring, which read oddly for a dense list. It is now a sibling of that block with explicit alignment, so it renders the same way in both states.
- **Long branch lists are folded behind their count** — *"150 branches exist only on the remote"* — with the names one click away in a scrollable list.
- **A failed ref refresh no longer splices git's entire remote message into the summary line.** The cause is stated in plain language and git's raw output moves to a collapsed pane.
- **An engine with no usable version says "version unknown"** instead of printing a placeholder. Ubuntu's gitleaks package reports `version is set by build process`, which was being rendered where a version belongs; `noseyparker 0.24.0` also repeated the engine name next to it. Both are now parsed to a bare version.

### Documentation
- **Documentation no longer ships a detectable example credential.** The write-up of cross-engine merging quoted a real-looking MongoDB connection string, which our own engines then dutifully flagged in our own README and changelog on every scan. The illustration keeps its point — two engines capturing different spans of one secret — with a redacted password.
- **Refreshed screenshots, captured from a real three-engine scan.** A fresh clone of this repository, scanned with Gitleaks, TruffleHog and Nosey Parker together, rendered from the extension's own `_getHtmlForWebview()`. Every value shown — engine attribution, versions, commits, branches, the coverage record — is what the engines actually reported. The secrets are synthetic fixtures (`AKIAIOSFODNN7EXAMPLE`, `mongodb://user:REDACTED@localhost`), which is also why nothing carries a `VERIFIED LIVE` badge: verification was enabled and TruffleHog correctly verified none of them. `tools/real-scan.js` produces the data and `tools/render-screenshots.js` renders it, so the images can be regenerated rather than drifting.
- Added [docs/SCANNING_ENGINES.md](docs/SCANNING_ENGINES.md): what each engine is good at, what it cannot do, licensing, privacy, install, settings, how results are merged, and the measured comparison behind the multi-engine decision.
- `docs/ARCHITECTURE.md` no longer documents a scan command without `--git-history full`, and records the current engine invocations.
- README and the project website describe multi-engine scanning, verification and manual redaction.

### Known Issues
- Dependency cleanup still runs from `deactivate()`, which VS Code invokes on every window reload rather than only on uninstall (#59).

## 0.6.3
### Changed
- Updated the VS Code test toolchain, ESLint, type definitions, and GitHub
  Actions used by CI, publishing, and Pages deployment.
- Standardized contributor, CI, and publishing environments on Node.js 22.
- Added save/manual-run guidance for prepared BFG and Git-only scripts; saved scripts
  are owner-executable, and in-panel runs use owner-only OS temporary files.
- Expanded the optional git-history keyword profile with LDAP, token, credential, and private/SSH key terms.
- Added Ctrl/Cmd+F filtering for scan-result rows.
- Pinned third-party GitHub Actions to immutable commit SHAs while retaining
  release tags in comments for maintainable Dependabot updates.
- Kept the ESLint-only `globals` package development-only so it is not shipped
  with the extension.

### Security
- Updated vulnerable transitive test dependencies, scoped the required npm
  overrides to Mocha's dependency subtree, and restored a zero-vulnerability
  `npm audit` result without changing extension runtime dependencies.

## 0.6.2
### Fixed
- **"Could not register service worker" When Opening the Panel**: Opening Remove Files or starting a scan from the sidebar created the panel, rendered the default view, and then reassigned `webview.html` 50–100 ms later to switch views. Reassigning it destroys the webview's iframe document and builds a new one, so when VS Code's service worker registration for the first document was still in flight it rejected with `InvalidStateError: The document is in an invalid state` — surfacing as `Error loading webview: Could not register service worker`. The panel now applies the requested view and directory *before* its single initial render, so the document is built once. The two timing constants that papered over the race are gone.

### Added
- **Website Link**: The Control Panel has an "Open the Leak Lock website" button, and `Leak Lock: Open Website` is available from the Command Palette. Both open the project site in your default browser.
- **Dependabot Version Updates**: `.github/dependabot.yml` enables weekly npm and GitHub Actions update pull requests, grouping minor and patch bumps into one PR while leaving majors separate for individual review. Previously only Dependabot *security* updates ran, since those need no configuration file. The reusable workflow pinned to `ci-helpers@production` is untouched — that floating tag is advanced by its own release flow.

### Changed
- **Leaner Package**: The published `.vsix` no longer carries `docs/`, the GitHub Pages site, `.github/` workflows, or contributor notes — none of which the extension loads at runtime, and the site's screenshots alone were ~192 KB of dead weight. The package is now 17 files / 94 KB. The Marketplace listing is unaffected: it renders only `README.md`, `CHANGELOG.md`, `LICENSE` and the icon, and the README's relative `docs/` links are rewritten to absolute repository URLs when the package is built, so they keep working from the listing.

### Security
- Updated development dependencies flagged by advisories (lockfile only — no runtime dependencies changed):
  - `brace-expansion` 1.1.12 → 1.1.16 and 2.0.2 → 2.1.2 (CVE-2026-13149)
  - `minimatch` 3.1.2 → 3.1.5, 5.1.6 → 5.1.9 and 9.0.5 → 9.0.9 (ReDoS)
  - `ajv` 6.12.6 → 6.15.0 (ReDoS via the `$data` option)
  - `js-yaml` 4.1.1 → 4.3.0 (quadratic-complexity DoS in merge-key handling)
  - `flatted` 3.3.3 → 3.4.3, `picomatch` 2.3.1 → 2.3.2
- Three development-only advisories remain open with no upstream fix available: `mocha` pins `serialize-javascript@^6`, and the fix for that advisory landed in 7.0.7. They affect the test runner only and never ship in the extension.

### Documentation
- The GitHub Pages site now shows the interface — the scan results table with severity, file, line and originating commit; the Control Panel; the git-history keyword search; and the guided file-removal flow. Both pages carry the same primary navigation.

## 0.6.1
### Documentation
- Published the project site to GitHub Pages from `docs/website/`, built around the scan → fix → verify flow, with the shield mark, a dark brand band, copy buttons on the install commands, and an About page. No extension code changed in this release.

## 0.6.0
### Added
- **Force-Push Confirmation Gate**: Running a secrets cleanup now happens in two explicit steps. First the cleanup rewrites your **local** history and removes the secret — the remote is **not** touched. The panel then shows a persistent confirmation that does not auto-dismiss, explains that continuing will rewrite remote git history irreversibly, and asks you to confirm. Only after you confirm does Leak Lock force-push the rewritten branches and tags (in a single atomic push) and verify the remote is clean. Cancelling keeps the remote unchanged.
- **Finding Selection Controls**: The scan results table now has a header select-all checkbox, `Select all` / `Clear all` buttons, and a live "N of M cleanable findings selected" counter. Cleanup buttons are disabled while nothing is selected. The bulk controls are wired with event listeners so they keep working under a strict Content-Security-Policy.
- **Clearer Dependency Findings**: Findings inside third-party dependencies (node_modules, vendor, …) now carry a prominent "Dependency · not your code" badge and an explicit note that they are not your source and cannot be selected for history cleanup, so their disabled checkbox is no longer confusing. The summary banner explains they should be addressed by updating the package.
- **Git-History Keyword Matches Are Cleanable**: Keyword findings from git-history search are now selectable and checked by default, just like detected secrets. Selecting one redacts that string from history via BFG `--replace-text`. Only findings in dependency directories remain non-selectable (with a tooltip explaining why).
- **Ref-by-Ref Push Plan**: Preparing a cleanup shows exactly which branches will be force-updated, which exist only on the remote, which will be created, and which tags are affected — instead of a blanket `git push --force --all` (LL-002).
- **Rewrite Preflight**: All refs are refreshed before a rewrite is planned, and the rewrite is blocked (with the branch list) when local branches hold commits the remote does not have (LL-001).
- **Post-Run Verification**: After a cleanup, every remote branch and tag is re-checked and any ref where the target survived is reported.
- **Save as .sh**: The prepared cleanup is a complete, reviewable bash script that can be copied or saved to disk.

### Fixed
- **History Rewrites Now Reach Every Remote Branch**: `git push --force --all` expands to `refs/heads/*` only, so branches that existed solely as `refs/remotes/origin/*` were rewritten locally but never pushed — the leaked secret survived on the server and returned on the next fetch. Leak Lock now materialises a local branch for every remote branch before rewriting and force-pushes every branch and tag in a single `--atomic` transaction, so a rejected ref (e.g. a protected branch or tag) fails the whole push rather than leaving the remote half-rewritten.
- **Selection No Longer Resets On Prepare**: Checkbox state and replacement values are held by the extension rather than the webview DOM, so preparing a command (which re-renders the panel) no longer re-checks every unchecked finding or discards edited replacement text.
- **Git-History Keyword Hits Are Now Consistent**: The row renderer and the cleanup resolver used to disagree — a keyword finding could render as checked but was dropped at cleanup time. A single eligibility predicate now governs both, so a selected keyword finding is actually cleaned (see "Git-History Keyword Matches Are Cleanable" above).
- **`git filter-repo` Remote Restoration**: `filter-repo` deletes the `origin` remote by design, which made the subsequent force-push fail. The remote is now restored before pushing.
- **BFG Failures No Longer Force-Push**: A failed BFG run previously continued to the force-push stage, rewriting the remote for a rewrite that never happened.
- **Individual-Mode BFG Now Escapes Target Names**: In one-command-per-item removal, a selected name containing regex metacharacters (for example `[old].env`) was passed to BFG as a pattern and could match more paths than selected. It is now escaped literally, matching combined mode.
- **No-Remote Repositories Are Blocked, Not Broken**: Preparing a cleanup in a repository with no configured remote previously produced a script that failed on its first fetch/push. Preparation now stops with a clear message instead of offering a plan that cannot run.
- **Prepared Cleanup Script Was Displayed and Copied as One Line**: The command box had no `white-space` rule, so the browser collapsed every newline to a space — the script rendered as a single line and the `📋 Copy` button (reading `innerText`) copied that collapsed, unrunnable version. The box now preserves line breaks and Copy reads the raw text, so the copied script matches what `💾 Save as .sh` writes. The generated script also now restores the working branch via a `trap` on exit, so a rejected push no longer leaves the repository on a detached HEAD.
- **Git-History Search No Longer Fails Silently On Large Repos**: The commit-message, file-content, and file-name passes shared one `try/catch`, so if the heavy content pass hit its time or output limit on a big history, the whole keyword scan was discarded with a vague warning. Each pass is now isolated (a failure in one keeps the others' results), the content pass gets a larger buffer and longer timeout, and any pass that can't finish is reported by name so "found nothing" is never silently a timeout.
- **Git-History Filename Search Now Finds Matches**: The name-status parser was fed `git log --name-status -z --pretty=format:…`, whose first status record for each commit arrives prefixed with a newline (`"\nA"`). That leading newline defeated the status-token check, so no historical file names were ever matched. It is now stripped, and filename search finds keywords in historical paths (matched as substrings).
- **Git-History File-Content Search Now Actually Runs**: The `git log` invocation combined `-G` with `--pickaxe-regex`, which git rejects (`options '-G' and '--pickaxe-regex' cannot be used together`), so searching historical file content silently found nothing. The invalid flag is removed. File-content and filename searches now match literal substrings (a secret is routinely embedded inside a larger token), so a term that appears anywhere in a historical file is found instead of being dropped by whole-word matching.

## 0.5.0
### Added
- **Expanded Git-History Text Search**: Supports arbitrary text terms across commit messages and historical file content without skipping short terms.
- **Git-History Filename Search**: Added optional filename matching mode via `leakLock.gitHistoryKeywordSearch.searchFileNames` (disabled by default / opt-in).

## 0.4.1
### Fixed
- **Printable Report Redaction Scope**: Redacted PDF/printable reports now keep finding paths visible and redact only secret values, so remediation context is preserved.
- **Commit-Message History Result Context**: Keyword matches from commit-message scanning now use a stable path label with ID and commit hash (for example `git-history:commit-message [id:... commit:...]`) to avoid exposing raw commit message text.

## 0.4.0
### Added
- **Keyword Search in Git History**: Optional scanning for configured keywords in commit messages and historical file content changes ([#39](https://github.com/nikolareljin/leak-lock/issues/39))
  - New settings to enable/disable keyword history scanning
  - Separate toggles for commit-message scanning and file-history scanning
  - Configurable keyword list and per-keyword match cap
  - Default keyword profile targets agent-attribution terms and sensitive credential wording
  - Keyword matches are surfaced in scan results with git commit metadata

## 0.3.0
### Added
- **Scan Results Export**: Export scan findings as JSON and print/save the current results view as PDF ([#37](https://github.com/nikolareljin/leak-lock/issues/37))
  - New `Export JSON` action in the scan results section
  - New `Print / Save as PDF` action in the scan results section
  - Exported JSON includes metadata (`generatedAt`, scan path, counts) and full finding records

## 0.2.0
### Added
- **Git Commit Info in Scan Results**: Display branch name, commit hash, and commit date for each detected credential leak found in git history ([#36](https://github.com/nikolareljin/leak-lock/issues/36))
  - New "Git Info" column in the results table showing branch, abbreviated commit hash, and formatted date
  - Batch-resolves commit metadata via `git log` and `git branch --contains` after scanning
  - Gracefully handles orphaned commits and non-git findings

## 0.1.2
- Ignore jar files in the vscode distro.

## 0.1.1
### Changed
- **Test Assets Organization**: Moved `validate.sh`, `test.sh`, and `test-secrets.js` into `test/` for a cleaner root directory
- **README Documentation**: Improved README guidance and clarity

## 0.1.0
### Added
- **Scan Cleanup Flow (Prepare → Run)**: Scan results now generate BFG or Git-only commands before execution with copyable placeholders
- **Open VSX Publishing**: CI now publishes VSIX packages to Open VSX using `OVSX_PAT`
- **Local-Only Finding Classification**: Untracked, non-history secrets are marked safe (green) but still documented

### Changed
- **Force Push Prompt**: Explicit confirmation prompts after cleanup to optionally force push changes
- **BFG Warning Text**: Clear note that BFG removes same-name files/directories everywhere in history
- **Remove Files UX**: Target selection supports removing individual items and clearing selections
- **Repository Picker Default**: Remove Files target selection opens at the chosen repository
- **Activity Bar Icon**: Switched to `./media/icon.svg`

## September 29, 2025
### Added
- **Comprehensive Installation Instructions**: Step-by-step guides for installing Docker and Java with platform-specific instructions
- **Platform-Specific Setup Guides**: Detailed instructions for Windows, macOS, and Linux with direct download links
- **Visual Progress Indicators**: Real-time scanning progress with animated spinner and stage-by-stage tracking
- **Enhanced Empty Results Display**: Celebratory interface when no secrets found with security checklist and best practices
- **Interactive Security Guide**: Built-in security best practices guide accessible from scan results
- **Local-Only Finding Classification**: Marks uncommitted, non-history secrets as safe (green) while still documenting them
- **Advanced Scan Progress**: Five-stage progress tracking (Docker Check → Pull Image → Initialize → Scan Files → Process Results)
- **Command Injection Security Fixes**: Proper shell path escaping and input validation to prevent security vulnerabilities
- **Centralized Configuration**: Extracted hardcoded paths to shared config.js for better maintainability
- **Enhanced Dependency Management**: Smart dependency section that auto-hides when all dependencies are installed
- **Detailed Dependency Status**: Individual status tracking for Docker, Nosey Parker, Java, and BFG with version information
- **Improved UI/UX**: Progress indicators, animations, and better visual feedback during operations
- **Advanced Error Handling**: Comprehensive error messages and recovery suggestions for dependency issues
- **Package Updates**: Updated package-lock.json with latest dependency versions
- **Code Quality Improvements**: Replaced magic numbers with named constants for better maintainability
  - `MAX_PATH_LENGTH = 4096`: Maximum allowed path length for security validation
  - `MAX_VOLUME_NAME_LENGTH = 255`: Maximum Docker volume name length
  - `DOCKER_PULL_TIMEOUT = 120000`: Docker image pull timeout (2 minutes)
  - `SCAN_TIMEOUT = 300000`: Security scan timeout (5 minutes)
  - `SECRET_TRUNCATE_LENGTH = 50`: Length limit for displaying secrets in UI

### Security
- **Fixed Critical XSS Vulnerabilities**: Implemented comprehensive HTML escaping to prevent cross-site scripting attacks
  - Added escapeHtml() and escapeJsonAttribute() functions for proper output encoding
  - Replaced unsafe onclick handlers with data attributes and event delegation
  - Applied HTML escaping to all user-controlled data (file paths, secrets, descriptions, progress messages)
  - Eliminated direct interpolation of user data into HTML onclick attributes
- **Fixed Critical Path Validation Flaw**: Corrected path traversal detection to check input BEFORE normalization, preventing bypass attempts
- **Robust Directory Traversal Prevention**: Added comprehensive regex patterns to detect all path traversal attempts (../, ..\, etc.)
- **Enhanced Working Directory Protection**: Added validation to prevent access outside the current working directory
- **Improved Path Containment Logic**: Fixed validateDockerPath() to use path.relative() for accurate containment checking
- **Fixed Docker Command Injection Vulnerabilities**: Comprehensive path validation and sanitization for all Docker volume mounts
- **Enhanced Path Security**: Added validateDockerPath() and sanitizeDockerVolumeName() functions to prevent directory traversal attacks
- **Cross-Platform Sensitive Directory Protection**: Implemented platform-aware system directory blocking
  - Unix/Linux: Protects `/etc`, `/usr/bin`, `/bin`, `/sbin`, `/root`, `/var/run`, `/var/log`, `/sys`, `/proc`, `/boot`, `/dev`
  - Windows: Protects `C:\Windows`, `C:\Program Files`, `C:\ProgramData`, system user directories, and critical system files
  - Multi-drive support: Automatically protects system directories on D:, E:, F: drives on Windows
  - Case-insensitive matching on Windows, case-sensitive on Unix-like systems
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
