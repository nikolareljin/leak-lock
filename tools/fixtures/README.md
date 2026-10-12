# tools/fixtures: test-fixture generators

**These scripts exist only to build test and documentation fixtures.** Run them by
hand. Nothing else may use them: the extension, its tests, CI workflows and the other
tools in `tools/` do not import, require, source or execute anything in this folder,
and `test/fixture-tools.test.js` fails if that changes.

| Script | What it writes |
|---|---|
| `seed-fake-leaks.sh` | Fake credentials, on `leaklock-fixture/*` branches |
| `seed-code-issues.js` | Deliberately insecure code that Foxguard reports, on `leaklock-fixture/code-issues` |

## Rules

- **Fake data only.** Every credential is a published example value, a test-mode
  prefix or a made-up string of the right shape. The insecure code is marked
  "intentionally insecure, never deploy" in every file it writes.
- **Nothing is pushed to a hosted remote.** `seed-code-issues.js` never pushes,
  fetches, clones or touches a remote at all; every git call goes through a guard
  that refuses those subcommands. `seed-fake-leaks.sh --push` only pushes to a
  remote on this disk (`--local-remote`) and refuses anything else.
- **Publishing is manual.** Both scripts print the exact `git push` command; a person
  reviews the commits and runs it.
- **Never point them at a real project.** Use a throwaway repository, or the public
  fixture <https://github.com/nikolareljin/damn-vulnerable-repo>.
- **Not shipped.** `tools/**` is excluded from the `.vsix` by `.vscodeignore`.

## Excluded from this repository's own scans

The generators carry fake secrets and insecure-code patterns by design, so scanning
Leak Lock itself would report its own fixture tooling. Both scanners skip this folder,
and only this folder:

- **Gitleaks:** `.gitleaks.toml` allowlists `^tools/fixtures/`, on top of the default rules.
- **Foxguard:** `.foxguard.yml` skips this folder for secrets and lists the code rules
  ignored per file. Foxguard has no folder-wide code exclusion, so a new rule that
  fires here needs a line there.

The same patterns anywhere else in the repository are still reported.

How to use them: [docs/TEST_FIXTURE.md](../../docs/TEST_FIXTURE.md).
