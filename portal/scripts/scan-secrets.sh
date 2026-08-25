#!/usr/bin/env bash
# scan-secrets.sh — greps working-tree files for obvious secret patterns and fails
# non-zero on a hit. Belt-and-braces alongside .gitignore; catches the case where a
# secret ends up in a file .gitignore doesn't cover (e.g. a committed fixture).
#
# Deliberately dependency-free (no npm package) so it runs identically in CI and locally.
#
# T-089 (2026-08-23): this file previously listed files via `git ls-files` (tracked-only)
# and `git diff --cached --name-only` (no `--relative`), which — once this repo actually
# got a `git init` and the npm workspace root (portal/) turned out to sit one directory
# below the git root — silently scanned ZERO files on every single code path (see that
# task's evidence for the full trace). Run `bash scripts/scan-secrets.sh --self-test` to
# exercise the fixtures that caught this; see run_self_test() below.
#
# T-100 (2026-08-24): the PASSWORD/SECRET/PRIVATE KEY pattern was matched case-sensitively
# (no `-i`), so a lowercase or mixed-case spelling of one of those field names went
# completely uncaught — first noted by T-094/T-096/T-098's completion reports, filed and
# fixed here. Case carries no security meaning for a field *name*; grep is now case-
# insensitive throughout (main match plus both structural-exclusion filters below it). See
# fixture case E in run_self_test() below for the regression guard.
#
# That one-line fix alone turned out to be incomplete twice over — both caught before
# shipping, by actually running the scan against this repo's own real tree rather than
# trusting the self-test in isolation (see the completion report for that run's full
# output):
#   1. Case-sensitivity had accidentally been acting as a word-boundary filter: every
#      camelCase identifier merely *containing* one of these words as a suffix
#      (`mustChangePassword`, `currentPassword`, `sharedSecret`, ...) started matching too,
#      once matched case-insensitively. Fixed by the leading `(^|[^A-Za-z])` boundary group
#      on `PATTERN` below.
#   2. Even with that boundary restored, this codebase's real, lowercase, lint-boundary-
#      correct `password`/`secret` fields — reached by this scan for the first time —
#      turned out to overwhelmingly hold *references*, not literal values (a DTO field
#      copied onto a domain object, a class field's own type annotation, a function
#      parameter), because real values in this codebase are always quoted string literals.
#      Fixed by the `LITERAL_SHAPE` filter further down, which keeps a hit only if its
#      matched value is actually shaped like a literal.
# (Deliberately not spelling a lowercase field name directly adjacent to a colon or "="
# anywhere in this comment, or anywhere else in this file outside the fixture helpers below
# — this file would trip over its own prose exactly the way write_secret_fixture()'s own
# comment already warns about for the uppercase case.)
set -euo pipefail

# --self-test [path-to-script-under-test] runs fixture-backed regression checks and exits
# non-zero if any of them fail. Defaults to testing this script itself; a path argument
# lets the same harness be pointed at a different (e.g. pre-fix) copy — see the completion
# report for how this proved TC-3 red on the unfixed code and green on the fixed one.
if [ "${1:-}" = "--self-test" ]; then
  SELF_TEST_TARGET="${2:-$0}"
  SELF_TEST_TARGET="$(cd "$(dirname "$SELF_TEST_TARGET")" && pwd)/$(basename "$SELF_TEST_TARGET")"

  # Builds the fixture's secret line at runtime, deliberately never spelling PASSWORD
  # directly adjacent to an "=" anywhere in this script's own source — otherwise the
  # fixture-under-test copy (see run_self_test() below, which copies this very file into
  # the scanned tree) would trip the scanner over its OWN self-test code, not over the
  # fixture files it writes. Caught by hand while first proving this harness out; see the
  # completion report.
  write_secret_fixture() {
    local file="$1" key='DB_PASSWORD'
    printf '%s=hunter2SuperSecretLiveValue\n' "$key" >"$file"
  }

  # T-100: same construction as write_secret_fixture() above (key built separately from the
  # "=" / ":" so this script's own source never spells the field name directly adjacent to
  # one), but lowercase and using a colon — the exact shape the case-sensitive regex missed.
  write_secret_fixture_lowercase() {
    local file="$1" key='password'
    printf '%s: hunter2SuperSecretLiveValue\n' "$key" >"$file"
  }

  run_self_test() {
    local target="$1" tmp failures=0
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' RETURN

    # Fixture layout mirrors this repo exactly: a git root with an npm workspace root
    # (portal/) one directory below it — the layout that broke every path in the original
    # defect.
    mkdir -p "$tmp/gitroot/portal/scripts" "$tmp/gitroot/portal/back-end/src"
    cp "$target" "$tmp/gitroot/portal/scripts/scan-secrets.sh"
    chmod +x "$tmp/gitroot/portal/scripts/scan-secrets.sh"
    (cd "$tmp/gitroot" && git init -q -b main && git config user.email t@t.local && git config user.name t)

    # Case A — TC-1/TC-8: a zero-commit repo (this project's own real state), a brand new
    # file with a secret, never staged. Must be caught without requiring `git add` first.
    write_secret_fixture "$tmp/gitroot/portal/back-end/src/leak-a.ts"
    if (cd "$tmp/gitroot/portal" && bash scripts/scan-secrets.sh) >/dev/null 2>&1; then
      echo "SELF-TEST FAIL (case A: untracked secret in a zero-commit repo went uncaught)"
      failures=1
    else
      echo "SELF-TEST pass (case A: untracked secret in a zero-commit repo caught)"
    fi
    rm -f "$tmp/gitroot/portal/back-end/src/leak-a.ts"

    # Case B — the pre-commit-hook path: a *staged* secret, one directory below the git
    # root (portal/ vs. the repo root), the exact layout that made `git diff --cached`'s
    # repo-root-relative paths disagree with the script's own portal-relative cwd.
    write_secret_fixture "$tmp/gitroot/portal/back-end/src/leak-b.ts"
    (cd "$tmp/gitroot" && git add -f portal/back-end/src/leak-b.ts)
    if (cd "$tmp/gitroot/portal" && bash scripts/scan-secrets.sh) >/dev/null 2>&1; then
      echo "SELF-TEST FAIL (case B: staged secret one directory below the git root went uncaught)"
      failures=1
    else
      echo "SELF-TEST pass (case B: staged secret one directory below the git root caught)"
    fi
    (cd "$tmp/gitroot" && git reset -q -- portal/back-end/src/leak-b.ts)
    rm -f "$tmp/gitroot/portal/back-end/src/leak-b.ts"

    # Case C — adjacent behaviour that must not regress: a clean tree still exits 0.
    echo 'export const x = 1;' >"$tmp/gitroot/portal/back-end/src/clean.ts"
    if (cd "$tmp/gitroot/portal" && bash scripts/scan-secrets.sh) >/dev/null 2>&1; then
      echo "SELF-TEST pass (case C: clean tree still exits 0)"
    else
      echo "SELF-TEST FAIL (case C: clean tree no longer exits 0)"
      failures=1
    fi

    # Case D — adjacent behaviour that must not regress: a real, .gitignore'd .env file
    # stays excluded (belt-and-braces with .gitignore, not a duplicate of it).
    printf '.env\n.env.*\n!.env.example\n' >"$tmp/gitroot/.gitignore"
    write_secret_fixture "$tmp/gitroot/portal/back-end/.env.development"
    if (cd "$tmp/gitroot/portal" && bash scripts/scan-secrets.sh) >/dev/null 2>&1; then
      echo "SELF-TEST pass (case D: gitignored .env.development stays excluded)"
    else
      echo "SELF-TEST FAIL (case D: gitignored .env.development was flagged)"
      failures=1
    fi

    # Case E — T-100 regression guard: a lowercase spelling of a field name (built up by
    # write_secret_fixture_lowercase() above, never spelled directly here) must be caught
    # exactly like the uppercase case already covered by cases A-D. This is the case that
    # went uncaught before the -i fix (T-100's own TC-1/TC-3).
    write_secret_fixture_lowercase "$tmp/gitroot/portal/back-end/src/leak-e.ts"
    if (cd "$tmp/gitroot/portal" && bash scripts/scan-secrets.sh) >/dev/null 2>&1; then
      echo "SELF-TEST FAIL (case E: lowercase field name went uncaught)"
      failures=1
    else
      echo "SELF-TEST pass (case E: lowercase field name caught)"
    fi
    rm -f "$tmp/gitroot/portal/back-end/src/leak-e.ts"

    return "$failures"
  }

  if run_self_test "$SELF_TEST_TARGET"; then
    echo "scan-secrets self-test: all cases passed"
    exit 0
  else
    echo "scan-secrets self-test: at least one case FAILED (see above)"
    exit 1
  fi
fi

cd "$(dirname "$0")/.."

# Prefer staged files during a pre-commit hook (fast, and scoped to what's actually about
# to be committed); otherwise scan the full working tree — tracked, staged and untracked
# files git wouldn't ignore (`--others --exclude-standard`), which is what makes this work
# correctly even in a repo with zero commits (this project's own real state — see the
# header comment). `--relative` on the staged path is load-bearing: without it, `git diff`
# emits paths relative to the *repository* root while everything below expects paths
# relative to this script's own cwd (portal/, one directory below the repo root here) —
# see case B in run_self_test() above.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git diff --cached --name-only --diff-filter=ACM --relative | grep -q .; then
    FILES=$(git diff --cached --name-only --diff-filter=ACM --relative)
  else
    FILES=$(git ls-files --cached --others --exclude-standard)
  fi
else
  # No git repo yet (this is the real state of this project as of Wave 0). `find` has no
  # concept of .gitignore, so it would otherwise flag the exact files .gitignore exists to
  # protect (.env.development and friends) — excluded explicitly below instead, matching
  # this repo's own .gitignore pattern (.env / .env.* / !.env.example) so this fallback
  # path stays honest about what it's actually checking: files that WOULD be committed.
  FILES=$(find . -type f \
    -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/build/*' \
    -not -path '*/coverage/*' -not -path '*/.git/*' \
    \( -not -name '.env' -a -not \( -name '.env.*' -a -not -name '.env.example' \) \))
fi

# T-100: leading `(^|[^A-Za-z])` group added alongside the `-i` flag below. Matching
# case-insensitively without it turned out to be a much bigger change than the reported
# defect: with the field-name keywords matched in any case, EVERY camelCase identifier
# that merely *contains* one as a suffix (`mustChangePassword`, `currentPassword`,
# `sharedSecret`, ...) started matching too — real, already-reviewed application code
# throughout the auth module, not the lowercase-*whole-field-name* gap this task exists to
# fix. Case-sensitivity had accidentally been doing double duty as a word-boundary filter
# (this codebase's real secret-holding fields are always ALL_CAPS with `_` separators, so a
# bare `PASSWORD`/`SECRET` literal never collided with a camelCase suffix); removing it
# without replacing that boundary reopened a false-positive flood, not just closed the
# reported gap — reproduced and rejected during diagnosis, see the completion report.
# Requiring the character immediately before the keyword to be either start-of-line or a
# non-letter (so `_` — as in `DB_PASSWORD` — still counts as a boundary, but a preceding
# letter like the `e` in `...changePassword` does not) restores that same boundary for
# every case, not just the all-caps one.
PATTERN='(^|[^A-Za-z])(PASSWORD|SECRET|PRIVATE[_ ]KEY)[[:space:]]*[:=][[:space:]]*[^[:space:]]'

# Known-safe placeholder values — a value ending up here must be provably incapable of
# protecting anything (an ephemeral, throwaway CI service-container credential; never a
# real environment's secret). Add to this list only with that justification in the same
# commit, never to silence a hit you haven't actually checked.
#
# T-100: `unit-test-no-connection` added — read `back-end/src/database/models/
# build-test-sequelize.ts` in full to confirm before adding it. It is used identically as
# the host, database, username AND password of a `Sequelize` instance that the file's own
# doc comment states, and the file's only two call sites (both `*.spec.ts`, already excluded
# above) confirm, is never connected — no `.authenticate()`/`.sync()`/query is ever run
# against it. A value that is provably never sent anywhere, over any protocol, to
# authenticate anything, cannot be protecting anything. Only reachable now that -i (below)
# lets the scan see this file's lowercase password field (name followed by a colon) for the
# first time.
SAFE_VALUES='ci_local_only|unit-test-no-connection'

HIT=0

while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  # T-089: matched against "/$f", not "$f" — these globs require a "/" immediately before
  # the path fragment they name, which a bare cwd-relative path like "back-end/src/..."
  # (no leading directory component) never has. That silently disabled every exception
  # below for as long as FILES was scanned from this script's own cwd (portal/) rather
  # than from the repo root, and went unnoticed only because the pre-fix defect meant
  # FILES was always empty anyway. The leading "/" makes the match independent of whether
  # $f happens to carry a leading path component or not.
  case "/$f" in
    # .env.example carries key names with empty values — that's not a leak.
    *.env.example) continue ;;
    # Pure planning/reference documentation — never deployed, never executed, and
    # necessarily discusses these exact keywords in prose and worked examples (e.g. this
    # very script's own spec in T-001, or a test case literally named "SUPERADMIN_PASSWORD
    # = short is rejected"). A real secret has no reason to exist only in these folders;
    # if one shows up in shipped code or config elsewhere, this scan still catches it.
    */project-plan/*|*/architect-review/*) continue ;;
    # This file's whole job is to NAME required secret env vars as Zod schema field
    # declarations — never an actual value. Every required secret this schema ever gains
    # will trigger the same false positive here; excluding the one file is more honest
    # than chasing the regex in circles.
    */back-end/src/config/env.schema.ts) continue ;;
    # T-089: this file's whole job is to allowlist Claude Code tool-permission *patterns*
    # (e.g. a wildcarded psql invocation naming the standard libpq password env var) — the
    # wildcard is a glob, never a value. This is the first file the newly-working scan
    # (this task's own fix) actually reached; see the completion report for the rest of
    # that first real run — deliberately not spelling the env var name itself out here,
    # for the same reason write_secret_fixture() above doesn't: this comment is itself
    # scanned, and PG + that name forms the very sequence this scan looks for.
    */.claude/settings.json) continue ;;
    # T-089: test/e2e suites use fixed, openly-fake, XKCD-936-style fixture credentials
    # (repeated verbatim across dozens of already-reviewed files, e.g. a certain four-word
    # phrase about horses, batteries, correctness and staples) to drive assertions against
    # ephemeral, non-production infrastructure (in-memory config, testcontainers, a local
    # dev DB with a scoped test role) — never a value that reaches anything real. Same
    # reasoning as the project-plan/architect-review exclusion above, generalised to "this
    # whole tree never touches production, by construction": a real secret has no reason
    # to exist only in a test suite; if one leaks into shipped runtime code, this scan
    # still catches it there.
    */test/*|*/e2e/*) continue ;;
    # T-100: same reasoning as the T-089 exclusion directly above, extended to cover this
    # project's *colocated* unit-test convention — confirmed real, not assumed, by reading
    # `back-end/src/database/models/build-test-sequelize.ts`'s own doc comment ("Deliberately
    # lives under `src/database/models/` (not `test/`) so it participates in the `test:cov`
    # unit run... `jest.config.js`'s `rootDir: 'src'` / `testRegex: '.*\.spec\.ts$'` never
    # collects anything under `test/`") and by finding dozens of matching files across
    # `packages/shared/src/*.schema.spec.ts` and `front-end/src/features/**/*.test.tsx`. Only
    # reachable at all now that -i (above) makes the scan see lowercase password/secret field
    # names (each spelled with a colon) in test fixtures for the first time — same "first
    # real run reaches a new, legitimate file" situation T-089's own comment describes.
    # Filename-based, not directory-based, and
    # deliberately narrow to the exact suffixes this repo's own test runners recognise
    # (`jest.config.js` / `vitest.config.ts`), not a bare `*test*` substring match.
    *.spec.ts|*.spec.tsx|*.test.ts|*.test.tsx|*.e2e-spec.ts) continue ;;
  esac
  # T-100: -i added — the pattern below only ever spelled the keywords in uppercase, so a
  # lowercase or mixed-case spelling of a field name matched nothing at all, silently. Case
  # carries no security meaning for a field *name* (only the value matters), so matching
  # case-insensitively closes that gap without narrowing what counts as a hit. See the
  # completion report for the fixture that proved this red before the flag was added.
  if grep -EinI "$PATTERN" "$f" >/tmp/scan-secrets-hit.$$ 2>/dev/null; then
    # Drop lines whose matched value is on the explicit safe-value allowlist.
    if [ -n "$SAFE_VALUES" ]; then
      grep -Ev "($SAFE_VALUES)" /tmp/scan-secrets-hit.$$ >/tmp/scan-secrets-hit-filtered.$$ || true
      mv /tmp/scan-secrets-hit-filtered.$$ /tmp/scan-secrets-hit.$$
    fi
    # T-100: keep only lines whose matched *value* is actually shaped like a literal, not
    # code. This is new, not a widening of the two T-089 filters below it (which only ever
    # dropped two specific already-caught shapes) — it exists because -i (above) doesn't just
    # close the reported lowercase gap, it also makes the scan match this codebase's ordinary
    # lowercase `password`/`secret` *identifiers* for the first time: function parameters
    # (a hash-password helper's own same-named argument, typed as a plain string), type
    # annotations (a "secret" class field typed as a plain string, holding no value at that
    # line at all), and property-reference values (an object literal field whose value is
    # another object's same-named field, e.g. a DTO's field copied onto a domain object) —
    # none of which hold a hardcoded value at all. Confirmed empirically: with only the
    # boundary fix above and none of this, a real scan of this repo's own auth module
    # reported ~40 files of exactly this shape; see the completion report for that run.
    #
    # Deliberately NOT the file-extension rule T-089's own comment two blocks below already
    # tried and rejected ("a bare unquoted token in a .ts file must be a variable reference")
    # — that broke the self-test's own positive-control fixtures, which are plain env-file-
    # style text saved with a .ts name. This rule instead looks only at the shape of the
    # matched value itself, so it treats every file identically:
    #   - quoted (`'`/`"`/backtick), with at least 8 CONSECUTIVE non-space characters right
    #     after the opening quote. This isn't just "long enough to not be empty or a single
    #     placeholder character" (`''`, `'x'`, both seen in this repo's own comments and
    #     specs) — requiring the run to be unbroken by whitespace is what actually matters:
    #     a real secret (password, API key, token) is written as one unbroken token, never
    #     containing a space, while an English sentence almost always hits a space within
    #     its first word or two. 8 was chosen empirically against this repo's own remaining
    #     false positives after every filter above it — a doc comment ("Nothing here is
    #     secret: ...") and a user-facing validation message keyed `common_password` (front-
    #     end/src/features/auth/passwordPolicy.ts) both start with a short word (4 and 4
    #     characters) immediately followed by a space, so 8 clears both without a
    #     value-specific exception, while staying comfortably under this repo's own real
    #     secret-length floor (`PASSWORD_MIN_LENGTH = 12` in `auth.constants.ts`) with room to
    #     spare for shorter classes of secret this pattern also has to cover (API keys,
    #     tokens). See the completion report for the before/after scan output that produced
    #     this number — it is not an arbitrary round figure;
    #   - or unquoted, but ONLY if the value runs, uninterrupted, in the character set an
    #     env-file-style literal is actually written in (letters, digits, `_+/=.-`) all the
    #     way to end of line. A source-code *reference* is never shaped like this: a bare
    #     identifier is followed by `,`/`;`/`)` ending a statement, a `.` continuing a
    #     property chain, or a `(` calling a function — every one of which ends the match
    #     before end of line and correctly drops the line. Proven against this repo's own
    #     real hits, not just theorised — see the completion report.
    #
    #     Known, deliberate trade-off: a genuine *multi-word* quoted secret (a passphrase
    #     containing spaces, e.g. this repo's own XKCD-936-style test fixture value) is only
    #     caught if its first word alone is 8+ characters — the 8-char run is required to
    #     start immediately after the opening quote, not merely to exist somewhere inside it,
    #     precisely so an English sentence's short first word or two (as in both real
    #     examples this threshold was tuned against) can't slip through by accident later in
    #     the string. Checked against this repo's real, current tree (see the completion
    #     report): every actual committed credential-shaped value is a single unbroken token,
    #     and this project's own multi-word passphrase convention is confined by construction
    #     to `test`/`e2e`/colocated-spec paths, which are excluded above regardless. Revisit
    #     if that ever changes — this is a real, narrow gap, not a hidden one.
    if [ -s /tmp/scan-secrets-hit.$$ ]; then
      LITERAL_SHAPE='(^|[^A-Za-z])(PASSWORD|SECRET|PRIVATE[_ ]KEY)[[:space:]]*[:=][[:space:]]*(['"'"'"`][^[:space:]]{8,}|[A-Za-z0-9_+/=.-]+[[:space:]]*$)'
      grep -Ei "$LITERAL_SHAPE" /tmp/scan-secrets-hit.$$ >/tmp/scan-secrets-hit-filtered.$$ || true
      mv /tmp/scan-secrets-hit-filtered.$$ /tmp/scan-secrets-hit.$$
    fi
    # T-089: two further, structural — not path-based — safe shapes, checked wherever a
    # file is (still) being scanned at all. Deliberately NOT doing this by file extension
    # (e.g. "a bare, unquoted token in a .ts file must be a variable reference, since a
    # string literal there is always quoted") — tried exactly that, and it silently swallowed
    # this repo's own TC-8 positive control (a plain-text fixture saved with a .ts extension,
    # no quotes at all) the same way the original defect did. A shape-based rule that isn't
    # true of 100% of a file's *possible* bytes, not just its typical ones, is a guard
    # weakened to make a test green — removed; see the completion report.
    if [ -s /tmp/scan-secrets-hit.$$ ]; then
      # (1) A `${...}` shell/template interpolation. The value, whatever it is, lives
      # wherever that referenced variable is actually assigned — this scan catches it
      # there if it's ever a hardcoded literal. `${` can't itself be a leaked value.
      # T-100: -i to match the main grep above now that a hit line's field name may be
      # lowercase — without it, a lowercase field's `${...}` interpolation would fail to
      # match here and be reported as a false positive instead of correctly excluded.
      grep -Eiv '(PASSWORD|SECRET|PRIVATE[_ ]KEY)[[:space:]]*[:=][[:space:]]*"?\$\{' \
        /tmp/scan-secrets-hit.$$ >/tmp/scan-secrets-hit-filtered.$$ || true
      mv /tmp/scan-secrets-hit-filtered.$$ /tmp/scan-secrets-hit.$$
    fi
    if [ -s /tmp/scan-secrets-hit.$$ ]; then
      # (2) A literal "..." placeholder, the shell-command convention this repo's own docs
      # use for "fill in your own value here" (e.g. docs/DEPLOYMENT.md's worked `docker
      # compose exec` example). Three periods can never themselves be a leaked value.
      # T-100: -i, same reason as (1) above.
      grep -Eiv '(PASSWORD|SECRET|PRIVATE[_ ]KEY)[[:space:]]*[:=][[:space:]]*\.\.\.' \
        /tmp/scan-secrets-hit.$$ >/tmp/scan-secrets-hit-filtered.$$ || true
      mv /tmp/scan-secrets-hit-filtered.$$ /tmp/scan-secrets-hit.$$
    fi
    if [ -s /tmp/scan-secrets-hit.$$ ]; then
      echo "✗ possible secret in $f:"
      sed 's/^/    /' /tmp/scan-secrets-hit.$$
      HIT=1
    fi
  fi
  rm -f /tmp/scan-secrets-hit.$$
done <<<"$FILES"

if [ "$HIT" -ne 0 ]; then
  echo
  echo "scan:secrets found possible secrets above. Remove them or add an explicit,"
  echo "reviewed exception to this script — never silence a hit by weakening the pattern."
  exit 1
fi

echo "scan:secrets: clean"
