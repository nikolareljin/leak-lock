# 🧪 Test Fixture — seeding fake leaks

`tools/seed-fake-leaks.sh` plants **fake** credential leaks into the history of any
repository, so Leak Lock can be exercised the whole way through — scan, review, prepare,
rewrite, force-push, verify — and then re-seeded and run again.

There is a public fixture repository ready to use:
**<https://github.com/nikolareljin/damn-vulnerable-repo>**

---

## Quick start

```bash
git clone https://github.com/nikolareljin/damn-vulnerable-repo.git
cd /path/to/leak-lock

# Seed, and create a throwaway bare remote so force-push and verification work
bash tools/seed-fake-leaks.sh ../damn-vulnerable-repo --local-remote
```

Then point Leak Lock's Control Panel at `../damn-vulnerable-repo` and scan.

After you have cleaned it, seed a fresh set and go again:

```bash
bash tools/seed-fake-leaks.sh ../damn-vulnerable-repo --reset --push
```

## Options

| Option | Effect |
|---|---|
| *(none)* | Seed the branches locally. **Nothing is pushed.** |
| `--push` | Push the seeded branches and tag to `origin`, and create a branch that exists *only* on the remote |
| `--local-remote` | Create a throwaway bare remote beside the repository, point `origin` at it, and push. Implies `--push` |
| `--reset` | Delete the previously seeded branches and tag first |
| `--list` | Show what a previous run created, then exit |
| `--github-safe` | Omit the three types GitHub push protection rejects, so the fixture can be pushed to a **public GitHub** repository |

`--local-remote` is the safest way to exercise the destructive paths: the remote is a bare
repository on your disk, so a force-push costs nothing and can be thrown away.

---

## Everything planted is fake

This matters twice over — nothing can leak, and TruffleHog verification correctly reports
none of it as live rather than looking broken.

- **AWS** uses Amazon's own published example key (`AKIAIOSFODNN7EXAMPLE`).
- **Stripe** values carry the `sk_test_` prefix, which is a test-mode key by definition.
- **Every other token** is a made-up string of the right shape.
- **SSH keys** are generated fresh on each run and used nowhere.

The values are **assembled from fragments at runtime** rather than written as literals.
Without that, the script would itself be a file full of detectable secrets, and committing
it here would add twenty permanent findings to the project whose job is finding them. If
you edit the script, keep that property — a quick check:

```bash
gitleaks detect --source tools --no-git --no-banner -v
```

---

## What gets planted

Everything lands under `leaklock-fixture/` on branches prefixed `leaklock-fixture/`, so it
never mixes with your own work.

### Refs

Seven branches and one tag — the tag is listed here too because the push plan has to
cover tag refs, and a fixture that only produced branches would never exercise that.

| Ref | Contents |
|---|---|
| `leaklock-fixture/main-leaks` | The bulk of the history |
| `leaklock-fixture/hotfix-db-creds` | MySQL and MongoDB URLs with passwords |
| `leaklock-fixture/release-1.0` | Azure, SendGrid, Google and Twilio credentials |
| `leaklock-fixture/legacy-import` | `htpasswd` and a Docker auth blob, added then deleted |
| `leaklock-fixture/dev-alice` | Fine-grained GitHub token, Slack bot token, JWT |
| `leaklock-fixture/experimental` | A Stripe test key, unreachable from the others |
| `leaklock-fixture/ops-remote-only` | **Exists only on the remote** (with `--push`) |
| `leaklock-fixture-v0.1.0` *(tag)* | Points at the seeded history, so the push plan covers tag refs |

### Credential types

AWS key and secret · GitHub PAT (classic and fine-grained) · Slack bot token and webhook ·
Stripe test keys · Google API key · SendGrid · Twilio SID and token · npm and PyPI registry
tokens · JWT · Azure storage connection string · Postgres, MySQL and MongoDB URLs with
passwords · `.netrc` and `.htpasswd` entries · Docker auth blob · GCP service-account
JSON · RSA and ed25519 private keys.

### Slack and Twilio, and pushing to public GitHub

All eighteen types are planted **by default**, which is what you want for local testing.

Three of them — Slack webhook, Slack bot token, Twilio SID — are rejected by GitHub's
**account-level push protection**, and there is no way around that: any shape a scanner
detects, GitHub detects too, using the same patterns. So:

- **Testing locally** (including `--local-remote`): use the default. Everything is planted.
- **Pushing to a public GitHub repo**: add `--github-safe`, which omits those three.
  The other fifteen push cleanly.

Alternatively you can push the full set yourself and click through the one-time unblock
URL GitHub prints for each — but those need re-approving after every re-seed, which is why
the flag exists.

---

## What each case is for

| Path | Exercises |
|---|---|
| `config/settings.py` | One secret across **two commits** and still on disk → a single row reading *"in 2 commits"* and *"+ working tree"* |
| `config/deploy_key*` | Private keys in **history only** — deleted later, so a working-tree scan misses them |
| `ci/deploy.sh` | One token matching **two rules** → *"also matched: …"* |
| `npmrc`, `pypirc` | Added then dropped — gone from the tree, still in history |
| `node_modules/@vendor/` | → *"Dependency · not your code"*, not selectable for cleanup |
| `env`, `secrets/` | **Untracked** → flagged *"(not committed)"*; the fix is deleting the file, not rewriting history |
| `big-blob.txt` | Over the default size limit → reported as skipped |
| `ops-remote-only` | Found **only** because refs are refreshed before scanning |
| `docs/runbook.md` | Content no scanner flags → what manual redaction rules are for |

### Expected scan result

Roughly 30 findings from ~57 raw detections across the three engines:

```
Nosey Parker ~23  ·  Gitleaks ~24  ·  TruffleHog ~10   →  ~30 merged findings
  untracked "(not committed)"  4        matched by >1 rule    17
  in >1 commit                 6        found by >1 engine    17
  also in working tree         7        dependency             1
```

The gap between 57 and 30 is the merging: the same secret across commits, across an
engine's history and working-tree passes, across rules, and across engines.

---

## Manual redaction rules worth trying

The fixture deliberately contains text **no scanner flags**, which is the whole reason
manual rules exist.

| Source | Mode | Expected |
|---|---|---|
| `build-01.internal-corp-7.example` | literal | Matches several commits — check the dry run reports them |
| `ACME-CUSTOMER-[0-9]{6}` | regex | Matches the runbook |
| `a==>b` | literal | **Rejected** — contains the rule-file separator |
| `regex:foo` | literal | **Rejected** — `regex:` is a mode prefix to the rewrite tools |
| `(?<=x)y` | regex | Allowed, **warns**: lookbehind is not POSIX, so the preview and verification would not understand it |
| `xyz` | literal | Allowed, **warns**: very short, will match inside unrelated words |

---

## Undoing a run

```bash
git checkout <your-branch>
bash tools/seed-fake-leaks.sh <repo> --reset --list
git config --unset leaklock.fixtureBase
```

The base commit is recorded in `git config leaklock.fixtureBase` on the first run and
reused afterwards — without it, a second run would stack a fixture on top of a fixture,
produce no diff, and abort.

---

## Not yet covered: insecure code

The fixture plants **credentials** only. Scanning for unsafe *code* — injection, unsafe
deserialization, weak or quantum-vulnerable cryptography, memory and resource leaks,
vulnerable dependencies — is tracked in
[leak-lock#94](https://github.com/nikolareljin/leak-lock/issues/94) and depends on the
FoxGuard adapter ([#47](https://github.com/nikolareljin/leak-lock/issues/47)) landing
first. When it does, this generator should gain a `leaklock-fixture/bad-code` branch.

Unlike the credential side, that content has no push-protection problem: unsafe code is
not a secret, so nothing blocks publishing it.

## Regenerating documentation screenshots

The same real-scan machinery backs the screenshots in `docs/website/img/`:

```bash
node tools/real-scan.js <repo> /tmp/leaklock-scan.json
node tools/render-screenshots.js results /tmp/results.html /tmp/leaklock-scan.json
```

`real-scan.js` runs the extension's own `_scanRepository()` path, so the output is what
the engines actually reported. Verification is opt-in there too — set `LEAKLOCK_VERIFY=1`
if you want it, and note that it makes outbound calls with whatever the scan discovered.
