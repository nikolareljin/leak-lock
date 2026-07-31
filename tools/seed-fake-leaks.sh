#!/usr/bin/env bash
#
# Seed FAKE credential leaks into the history of an existing repository, so Leak
# Lock can be exercised end to end: scan, review, prepare, rewrite, force-push,
# verify — then re-seed and do it again.
#
#   bash tools/seed-fake-leaks.sh <target-repo> [options]
#
# Options
#   --push            push the seeded branches and tag to origin (OFF by default)
#   --local-remote    create a bare remote beside the repo and point origin at it,
#                     so the full push/verify flow works without a real server
#   --reset           delete previously seeded branches and the tag first
#   --list            show what a previous run created, then exit
#   --github-safe     omit the three credential types GitHub push protection rejects
#                     (Slack webhook, Slack bot token, Twilio SID), so the fixture can
#                     be pushed to a public GitHub repository. Everything else is
#                     planted either way.
#
# EVERYTHING PLANTED IS FAKE.
#   AWS uses Amazon's own published example key; Stripe values carry the sk_test_
#   prefix, which is a test-mode key by definition; every other token is a made-up
#   string of the right shape; SSH keys are generated fresh on each run and used
#   nowhere. Nothing is or ever was live — which also means TruffleHog verification
#   will correctly report none of them as live, rather than appearing broken.
#
# The values are assembled from fragments at runtime rather than written as
# literals. Otherwise this script would itself be a file full of detectable
# secrets, and committing it to the Leak Lock repository would add twenty
# permanent findings to the very project that scans for them.
set -euo pipefail

TARGET=""; DO_PUSH=0; LOCAL_REMOTE=0; DO_RESET=0; DO_LIST=0; GITHUB_SAFE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --push) DO_PUSH=1 ;;
    --local-remote) LOCAL_REMOTE=1 ;;
    --reset) DO_RESET=1 ;;
    --list) DO_LIST=1 ;;
    --github-safe) GITHUB_SAFE=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) TARGET="$1" ;;
  esac
  shift
done

[ -n "$TARGET" ] || { echo "usage: seed-fake-leaks.sh <target-repo> [--push] [--local-remote] [--reset] [--list] [--github-safe]" >&2; exit 2; }
TARGET="$(cd "$TARGET" 2>/dev/null && pwd)" || { echo "no such directory: $TARGET" >&2; exit 2; }
git -C "$TARGET" rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repository: $TARGET" >&2; exit 2; }

g() { git -C "$TARGET" "$@"; }

# Everything this script creates is prefixed, so a re-run can find and replace it
# without guessing and without touching the user's own branches.
PREFIX="leaklock-fixture"
BRANCHES="$PREFIX/main-leaks $PREFIX/hotfix-db-creds $PREFIX/release-1.0 $PREFIX/legacy-import $PREFIX/dev-alice $PREFIX/experimental"
TAG="$PREFIX-v0.1.0"

if [ "$DO_LIST" = 1 ]; then
  echo "Seeded branches present in $TARGET:"
  g for-each-ref --format='  %(refname:short)' "refs/heads/$PREFIX/*" || true
  g for-each-ref --format='  %(refname:short)' "refs/tags/$PREFIX*" || true
  exit 0
fi

# The commit everything is seeded on top of. Recorded on the first run, because a
# second run starts with a fixture branch checked out — taking HEAD then would
# stack a fixture on a fixture, produce no diff, and abort with "nothing to commit".
BASE="$(g config --get leaklock.fixtureBase 2>/dev/null || echo '')"
if [ -n "$BASE" ] && ! g rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
  BASE=""   # recorded commit has since been rewritten away
fi

CURRENT="$(g symbolic-ref --quiet --short HEAD || echo '')"
if [ -z "$BASE" ]; then
  case "$CURRENT" in
    "$PREFIX"/*)
      echo "a fixture branch is checked out but no base commit was recorded;" >&2
      echo "check out your own branch first, then re-run" >&2
      exit 2 ;;
  esac
  BASE="$(g rev-parse HEAD 2>/dev/null || echo '')"
  [ -n "$BASE" ] || { echo "the target repository has no commits; make one first" >&2; exit 2; }
  g config leaklock.fixtureBase "$BASE"
fi

ORIGINAL_BRANCH="$CURRENT"
case "$ORIGINAL_BRANCH" in "$PREFIX"/*) ORIGINAL_BRANCH="" ;; esac

# Step off any fixture branch before deleting them.
case "$CURRENT" in
  "$PREFIX"/*) g checkout -q --detach "$BASE" ;;
esac

if [ "$DO_RESET" = 1 ]; then
  for b in $BRANCHES; do g branch -D "$b" >/dev/null 2>&1 || true; done
  g tag -d "$TAG" >/dev/null 2>&1 || true
  echo "removed any previously seeded branches and tags"
fi

if ! g diff --quiet -- ":(exclude)$PREFIX" || ! g diff --cached --quiet -- ":(exclude)$PREFIX"; then
  echo "the target repository has uncommitted changes outside $PREFIX/;" >&2
  echo "commit or stash them first" >&2
  exit 2
fi

export GIT_AUTHOR_NAME="Leak Lock Fixture" GIT_AUTHOR_EMAIL="fixture@example.invalid"
export GIT_COMMITTER_NAME="Leak Lock Fixture" GIT_COMMITTER_EMAIL="fixture@example.invalid"

# ---- fake credential material, assembled at runtime ---------------------------
# Slack webhook/bot tokens and the Twilio SID are deliberately absent: GitHub's
# account-level push protection rejects them, and any shape our engines detect
# GitHub detects too, so they cannot live in a public fixture. Every other
# provider below pushes fine.
# Slack and Twilio are planted by default — they are exactly what you want when
# testing locally. GitHub's account-level push protection rejects them and no shape
# satisfies both sides, since a scanner and GitHub match on the same patterns, so
# --github-safe omits them for a public GitHub push.
SLACK_BOT=""; SLACK_HOOK=""; TWILIO_SID=""; TWILIO_TOKEN=""
if [ "$GITHUB_SAFE" = 0 ]; then
  SLACK_BOT="xoxb-""1111111111-2222222222-abcdefghijklmnopqrstuvwx"
  SLACK_HOOK="https://hooks.slack.com/services/""T00000000/B00000000/abcdefghijklmnopqrstuvwx"
  TWILIO_SID="AC""0123456789abcdef0123456789abcdef"
  TWILIO_TOKEN="0123456789""abcdef01""23456789""abcdef"
fi

AWS_ID="AKIA""IOSFODNN7EXAMPLE"
AWS_SECRET="wJalrXUtnFEMI/K7MDENG/bPxRfiCY""EXAMPLEKEY"
GH_PAT="ghp_""wJalrXUtnFEMIKBDENGbPxRfiCYEXAMPLE01"
GH_FINE="github_pat_""11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789AbCdEfGhIjKlMnOpQrSt"
STRIPE_A="sk_test_""51H8xkKLmNoPqRsTuVwXyZ0123456789"
STRIPE_B="sk_test_""51AbCdEfGhIjKlMnOpQrStUvWxYz9876"
GOOGLE_KEY="AIza""SyD-0123456789abcdefghijklmnopqrstuv"
SENDGRID="SG.""abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHI"
NPM_TOKEN="npm_""abcdefghijklmnopqrstuvwxyz0123456789"
PYPI_TOKEN="pypi-""AgEIcHlwaS5vcmcCJDAxMjM0NTY3LTg5YWItY2RlZi0wMTIzLTQ1Njc4OWFiY2RlZgAC"
JWT_TOK="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.""eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkZha2UifQ.7uZ9Kx0mQKcQ2Wm8kQm3Xn4vB1cD2eF3gH4iJ5kL6mN"
AZURE_KEY="$(printf 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH' | base64 | tr -d '\n')"
AZURE_CS="DefaultEndpointsProtocol=https;AccountName=fakestorage;AccountKey=${AZURE_KEY};EndpointSuffix=core.windows.net"
PG_URL="postgres://reporting_svc:""Pa55w0rd-NotReal@db.internal-corp-7.example:5432/reporting"
MYSQL_URL="mysql://root:""r00tpass-NotReal@mysql.internal-corp-7.example:3306/legacy"
MONGO_URL="mongodb://svc_user:""M0ngoPass-NotReal@db.internal-corp-7.example:27017/reports"
DOCKER_AUTH="$(printf 'builduser:BuildPass-NotReal' | base64 2>/dev/null | tr -d '\n')"
SA_KEY_ID="0123456789""abcdef0123""456789abcd""ef01234567"
HTPASSWD_HASH='$apr1$abcdefgh$0123456789abcdefghijkl'

SLACK_HOOK_LINE=""; SLACK_BOT_LINE=""; TWILIO_LINES=""; OPS_SLACK_LINE=""
if [ -n "$SLACK_HOOK" ]; then SLACK_HOOK_LINE="SLACK_WEBHOOK=\"$SLACK_HOOK\""; fi
if [ -n "$SLACK_BOT" ]; then
  SLACK_BOT_LINE="SLACK_BOT_TOKEN = \"$SLACK_BOT\""
  OPS_SLACK_LINE="OPS_SLACK_TOKEN=\"$SLACK_BOT\""
fi
if [ -n "$TWILIO_SID" ]; then
  TWILIO_LINES="TWILIO_ACCOUNT_SID=\"$TWILIO_SID\"
TWILIO_AUTH_TOKEN=\"$TWILIO_TOKEN\""
fi

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
if command -v ssh-keygen >/dev/null 2>&1; then
  ssh-keygen -q -t rsa -b 2048 -N '' -C 'fixture@example.invalid' -f "$WORK/id_rsa"
  ssh-keygen -q -t ed25519 -N '' -C 'fixture@example.invalid' -f "$WORK/id_ed25519"
else
  # Assembled rather than written whole, for the same reason as the tokens above.
  PEM_HEAD="-----BEGIN ""OPENSSH PRIVATE KEY-----"
  PEM_TAIL="-----END ""OPENSSH PRIVATE KEY-----"
  PEM_BODY="b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW"
  printf -- '%s\n%s\nQyNTUxOQAAACBGAKEfakeFAKEfakeFAKEfakeFAKEfakeFAKEfakeFAA\n%s\n' \
    "$PEM_HEAD" "$PEM_BODY" "$PEM_TAIL" > "$WORK/id_ed25519"
  cp "$WORK/id_ed25519" "$WORK/id_rsa"
fi

DREL="leaklock-fixture"                # pathspec, relative to the repo root
D="$TARGET/$DREL"                      # absolute, for writing files
# `git rm` can empty the fixture directory entirely, at which point the pathspec
# matches nothing and `add` fails — but the removal is already staged, so the
# commit itself is still valid.
commit() { g add -A -- "$DREL" >/dev/null 2>&1 || true; g commit -q -m "$1"; }
start_branch() {
  # Clear anything a previous run left behind, so each branch is built from the
  # recorded base rather than from the last run's leftovers.
  rm -rf "$D"
  g checkout -q -B "$1" "$BASE"
  rm -rf "$D"
  mkdir -p "$D"
}

# =============================================================================
# main-leaks — credentials that arrive, move around, and are "removed"
# =============================================================================
start_branch "$PREFIX/main-leaks"

mkdir -p "$D/config" "$D/ci" "$D/docs"
cat > "$D/config/settings.py" <<EOF
AWS_ACCESS_KEY_ID = "$AWS_ID"
AWS_SECRET_ACCESS_KEY = "$AWS_SECRET"
DATABASE_URL = "$PG_URL"
REPORT_HOST = "build-01.internal-corp-7.example"
EOF
commit "fixture: initial service configuration"

# The same secret touched again -> one row reading "in 2 commits", not two rows.
printf 'REQUEST_TIMEOUT = 30\n' >> "$D/config/settings.py"
commit "fixture: add a request timeout"

# Private keys committed then deleted -> history only.
cp "$WORK/id_rsa" "$D/config/deploy_key"
cp "$WORK/id_ed25519" "$D/config/deploy_key_ed25519"
commit "fixture: add deployment keys"
g rm -q -- "$DREL/config/deploy_key" "$DREL/config/deploy_key_ed25519"
commit "fixture: remove deployment keys"

# One token matching two rules -> "also matched: ...".
cat > "$D/ci/deploy.sh" <<EOF
#!/usr/bin/env bash
GITHUB_TOKEN="$GH_PAT"
$SLACK_HOOK_LINE
curl -H "Authorization: token \$GITHUB_TOKEN" https://api.github.com/user
EOF
sed -i '/^$/d' "$D/ci/deploy.sh"
cat > "$D/ci/netrc" <<EOF
machine artifacts.internal-corp-7.example
  login builduser
  password BuildPass-NotReal
EOF
commit "fixture: add deploy script and netrc"

# Registry tokens, added then dropped.
cat > "$D/npmrc" <<EOF
//registry.npmjs.org/:_authToken=$NPM_TOKEN
EOF
cat > "$D/pypirc" <<EOF
[pypi]
username = __token__
password = $PYPI_TOKEN
EOF
commit "fixture: add registry credentials"
g rm -q -- "$DREL/npmrc" "$DREL/pypirc"
commit "fixture: drop registry credentials"

# A vendored dependency -> "Dependency - not your code", not selectable.
mkdir -p "$D/node_modules/@vendor/sdk"
cat > "$D/node_modules/@vendor/sdk/client.js" <<EOF
module.exports.apiKey = "$STRIPE_A";
module.exports.googleKey = "$GOOGLE_KEY";
EOF
g add -f -- "$DREL/node_modules/@vendor/sdk/client.js" >/dev/null
g commit -q -m "fixture: vendor the sdk"

# Content no scanner flags -> what manual redaction rules are for. Deliberately
# spread over several commits and files so the dry run reports real numbers.
cat > "$D/docs/runbook.md" <<'EOF'
# Runbook

Primary deploy target: build-01.internal-corp-7.example
Failover: build-02.internal-corp-7.example
Customer of record: ACME-CUSTOMER-004417
EOF
commit "fixture: add runbook"
printf 'BACKUP_HOST = "build-02.internal-corp-7.example"\n' >> "$D/config/settings.py"
commit "fixture: document the failover host"

# Over the default size limit -> reported as skipped.
head -c 2200000 /dev/urandom | base64 > "$D/big-blob.txt"
g add -f -- "$DREL/big-blob.txt" >/dev/null
g commit -q -m "fixture: add a large generated artefact"

g tag -f "$TAG" >/dev/null

# =============================================================================
# other branches — leaks that exist nowhere else
# =============================================================================
start_branch "$PREFIX/hotfix-db-creds"
mkdir -p "$D/config"
cat > "$D/config/database.yml" <<EOF
production:
  url: "$MYSQL_URL"
legacy:
  url: "$MONGO_URL"
EOF
commit "fixture: pin the legacy database URLs"

start_branch "$PREFIX/release-1.0"
mkdir -p "$D/config"
cat > "$D/config/cloud.env" <<EOF
AZURE_STORAGE_CONNECTION_STRING="$AZURE_CS"
SENDGRID_API_KEY="$SENDGRID"
GOOGLE_API_KEY="$GOOGLE_KEY"
$TWILIO_LINES
EOF
sed -i '/^$/d' "$D/config/cloud.env"
commit "fixture: release 1.0 cloud configuration"

start_branch "$PREFIX/legacy-import"
mkdir -p "$D/docker"
printf 'admin:%s\n' "$HTPASSWD_HASH" > "$D/htpasswd"
cat > "$D/docker/config.json" <<EOF
{ "auths": { "registry.internal-corp-7.example": { "auth": "$DOCKER_AUTH" } } }
EOF
commit "fixture: import legacy auth files"
g rm -q -- "$DREL/htpasswd" "$DREL/docker/config.json"
commit "fixture: remove legacy auth files"

start_branch "$PREFIX/dev-alice"
mkdir -p "$D/scripts"
cat > "$D/scripts/notify.py" <<EOF
GITHUB_FINE_GRAINED = "$GH_FINE"
$SLACK_BOT_LINE
JWT = "$JWT_TOK"
EOF
sed -i '/^$/d' "$D/scripts/notify.py"
commit "fixture: add notification helper"

start_branch "$PREFIX/experimental"
mkdir -p "$D"
cat > "$D/experiment.py" <<EOF
STRIPE_SECRET = "$STRIPE_B"
EOF
commit "fixture: experimental billing integration"

# Back to where the user was, on the branch carrying the bulk of the history.
g checkout -q "$PREFIX/main-leaks"

# Untracked, gitignored secrets: found by the scan, flagged "not committed", and
# fixed by deleting the file rather than by rewriting history.
mkdir -p "$D/secrets"
cat > "$D/env" <<EOF
DATABASE_PASSWORD=hunter2-NotReal
STRIPE_KEY=$STRIPE_B
JWT_SECRET=$JWT_TOK
EOF
cat > "$D/secrets/service-account.json" <<EOF
{
  "type": "service_account",
  "project_id": "fixture-project",
  "private_key_id": "${SA_KEY_ID}",
  "private_key": "$(sed ':a;N;$!ba;s/\n/\\n/g' "$WORK/id_rsa")",
  "client_email": "svc@fixture-project.iam.gserviceaccount.com"
}
EOF

# ---- optional local remote, so push and verification can be exercised ----------
if [ "$LOCAL_REMOTE" = 1 ]; then
  BARE="$(dirname "$TARGET")/$(basename "$TARGET")-fixture-origin.git"
  rm -rf "$BARE"; git init --bare -q "$BARE"
  # Point origin at the throwaway remote, adding it if the repo had none.
  if g remote get-url origin >/dev/null 2>&1; then
    PREVIOUS_ORIGIN="$(g remote get-url origin)"
    g remote set-url origin "$BARE"
    echo "origin was: $PREVIOUS_ORIGIN"
  else
    g remote add origin "$BARE"
  fi
  DO_PUSH=1
  echo "local remote created: $BARE  (origin now points at it)"
fi

if [ "$DO_PUSH" = 1 ]; then
  for b in $BRANCHES; do g push -q -f origin "$b:$b"; done
  g push -q -f origin "$TAG"
  # A branch that exists ONLY on the remote: the headline case, invisible without a
  # ref refresh before scanning.
  RTMP="$(mktemp -d)"
  git clone -q "$(g remote get-url origin)" "$RTMP/x"
  (
    cd "$RTMP/x"
    git checkout -q -B "$PREFIX/ops-remote-only" "origin/$PREFIX/main-leaks"
    mkdir -p leaklock-fixture/ops
    cat > leaklock-fixture/ops/keys.env <<EOF
AWS_ACCESS_KEY_ID="$AWS_ID"
OPS_DB_URL="$MONGO_URL"
$OPS_SLACK_LINE
EOF
    sed -i '/^$/d' leaklock-fixture/ops/keys.env
    cp "$WORK/id_ed25519" leaklock-fixture/ops/id_ed25519
    git -c user.name="Leak Lock Fixture" -c user.email="fixture@example.invalid" add -A
    git -c user.name="Leak Lock Fixture" -c user.email="fixture@example.invalid" commit -qm "fixture: ops-only credentials"
    git push -q -f origin "$PREFIX/ops-remote-only"
  )
  rm -rf "$RTMP"
  echo "pushed the seeded branches, the tag, and a remote-only branch"
else
  echo "NOT pushed. Re-run with --push to publish to origin, or --local-remote to"
  echo "create a throwaway bare remote and exercise the force-push and verify flow."
fi

cat <<EOF

Fake leaks seeded into: $TARGET
Everything planted is fake. Files live under leaklock-fixture/ so they are easy to spot.

  base commit before seeding : $BASE
  original branch            : ${ORIGINAL_BRANCH:-（detached）}
  currently checked out      : $PREFIX/main-leaks

To undo entirely:
  git checkout ${ORIGINAL_BRANCH:-$BASE}
  git config --unset leaklock.fixtureBase
  bash tools/seed-fake-leaks.sh "$TARGET" --reset --list

Branches created (all prefixed $PREFIX/):
  main-leaks         the bulk of the history
  hotfix-db-creds    MySQL and MongoDB URLs with passwords
  release-1.0        Azure, SendGrid and Google credentials
  legacy-import      htpasswd and docker auth, added then deleted
  dev-alice          fine-grained GitHub token, JWT
  experimental       a Stripe test key, unreachable from the others
$([ "$DO_PUSH" = 1 ] && echo "  ops-remote-only    exists ONLY on the remote")

Credential types planted (all fake): AWS key and secret, GitHub PAT classic and
fine-grained, Stripe test keys, Google API key, SendGrid, npm and PyPI registry
tokens, a JWT, an Azure storage connection string, Postgres/MySQL/MongoDB URLs
with passwords, netrc and htpasswd entries, a Docker auth blob, a GCP
service-account JSON, and RSA and ed25519 private keys.

Slack and Twilio values are deliberately omitted: GitHub push protection rejects
them, and any shape a scanner detects GitHub detects too.

What to look for in Leak Lock:
  config/settings.py     one secret across 2 commits and still on disk
                         -> a single row reading "in 2 commits" and "+ working tree"
  config/deploy_key      private keys in history only, deleted later
  ci/deploy.sh           one token matching two rules -> "also matched: ..."
  node_modules/@vendor   -> "Dependency - not your code", not selectable
  leaklock-fixture/env   untracked -> flagged "not committed", delete rather than rewrite
  big-blob.txt           over the size limit -> reported as skipped

Manual redaction rules worth trying:
  literal  build-01.internal-corp-7.example  ->  redacted.invalid   (several commits)
  regex    ACME-CUSTOMER-[0-9]{6}            ->  *****
  literal  a==>b       -> rejected: contains the rule separator
  literal  regex:foo   -> rejected: mode prefix
  regex    (?<=x)y     -> allowed, warns about POSIX portability

After a cleanup, re-run this script with --reset --push to seed a fresh set and
test again.
EOF
