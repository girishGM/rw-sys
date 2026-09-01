#!/usr/bin/env bash
# scan-secrets.sh — greps this service's own working tree for obvious secret patterns and
# fails non-zero on a hit. Belt-and-braces alongside the repo root .gitignore; catches the
# case where a secret ends up in a file .gitignore doesn't cover (e.g. a committed fixture).
# Deliberately dependency-free (no npm package) so it runs identically in CI and locally.
#
# Scoped copy of portal/scripts/scan-secrets.sh's already-proven logic (that file's own
# header documents two real defects it fixed: T-089 — `git diff --cached --name-only`
# defaults to REPO-ROOT-relative paths, which silently scanned zero files once the npm
# workspace root turned out to sit one directory below the git root, the exact relationship
# `promo-code-service/` also has to this repo's git root; and T-100 — the match must be
# case-insensitive with an explicit word-boundary, and a hit is only real if the matched
# value is actually shaped like a literal, not a variable reference or a type annotation).
# This copy carries the same `--relative` fix and the same literal-shape filter, scoped to
# `promo-code-service/`'s own cwd rather than portal/'s.
set -euo pipefail

cd "$(dirname "$0")/.."

# Prefer staged files during a pre-commit hook (fast, scoped to what's actually about to be
# committed); otherwise scan the full working tree — tracked, staged and untracked files git
# wouldn't ignore. `--relative` is load-bearing: without it, `git diff` emits paths relative
# to the *repository* root while everything below expects paths relative to this script's
# own cwd (promo-code-service/, one directory below the repo root).
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git diff --cached --name-only --diff-filter=ACM --relative | grep -q .; then
    FILES=$(git diff --cached --name-only --diff-filter=ACM --relative)
  else
    FILES=$(git ls-files --cached --others --exclude-standard)
  fi
else
  # No git repo (shouldn't happen in this monorepo, but stay honest if it ever runs
  # standalone): fall back to `find`, excluding what .gitignore would exclude anyway.
  FILES=$(find . -type f \
    -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/coverage*/*' \
    -not -path '*/.git/*' \
    \( -not -name '.env' -a -not \( -name '.env.*' -a -not -name '.env.example' \) \))
fi

# Field-name keywords, matched case-insensitively with an explicit boundary so a camelCase
# suffix (`mustChangePassword`) doesn't collide with a bare field name (`DB_PASSWORD`).
PATTERN='(^|[^A-Za-z])(PASSWORD|SECRET|PRIVATE[_ ]KEY)[[:space:]]*[:=][[:space:]]*[^[:space:]]'

# A hit is only real if the matched value is actually shaped like a literal: quoted with 8+
# unbroken non-space characters right after the opening quote, or unquoted but running,
# uninterrupted, in the character set an env-file-style literal is written in, to end of
# line. A source-code *reference* (a parameter, a type annotation, a property copy) is never
# shaped like either — see portal/scripts/scan-secrets.sh's own header (T-100) for the full
# reasoning this filter is copied from.
LITERAL_SHAPE='(^|[^A-Za-z])(PASSWORD|SECRET|PRIVATE[_ ]KEY)[[:space:]]*[:=][[:space:]]*(['"'"'"\`][^[:space:]]{8,}|[A-Za-z0-9_+/=.-]+[[:space:]]*$)'

HIT=0

while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  case "/$f" in
    # Template file: key names with empty/placeholder values, not a leak.
    *.env.example) continue ;;
    # Colocated unit/e2e specs use fixed, openly-fake placeholder credentials to drive
    # assertions against non-production infrastructure (a local Postgres, a not-yet-real DB
    # role) — never a value that reaches anything real.
    *.spec.ts | *.spec.tsx | *.test.ts | *.test.tsx | *.e2e-spec.ts) continue ;;
  esac
  if grep -EinI "$PATTERN" "$f" >/tmp/promo-scan-secrets-hit.$$ 2>/dev/null; then
    if [ -s /tmp/promo-scan-secrets-hit.$$ ]; then
      grep -Ei "$LITERAL_SHAPE" /tmp/promo-scan-secrets-hit.$$ >/tmp/promo-scan-secrets-hit-filtered.$$ || true
      mv /tmp/promo-scan-secrets-hit-filtered.$$ /tmp/promo-scan-secrets-hit.$$
    fi
    if [ -s /tmp/promo-scan-secrets-hit.$$ ]; then
      echo "possible secret in $f:"
      sed 's/^/    /' /tmp/promo-scan-secrets-hit.$$
      HIT=1
    fi
  fi
  rm -f /tmp/promo-scan-secrets-hit.$$
done <<<"$FILES"

if [ "$HIT" -ne 0 ]; then
  echo
  echo "scan:secrets found possible secrets above. Remove them or add an explicit,"
  echo "reviewed exception to this script — never silence a hit by weakening the pattern."
  exit 1
fi

echo "scan:secrets: clean"
