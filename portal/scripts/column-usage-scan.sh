#!/usr/bin/env bash
# column-usage-scan.sh — T-044: static + best-effort runtime inventory of readers/writers
# of the reward_config PII columns that 07-DATA-PROTECTION.md §6 deliberately leaves
# unencrypted in place. Produces raw evidence only (file:line hits, counts, connection
# metadata) — it does not print row values, and it does not decide anything. The
# recommendation per column lives in project-plan/reports/T-044-column-consumers.md,
# built from this script's output plus the humans-asked step the script itself cannot do.
#
# Usage: bash scripts/column-usage-scan.sh   (run from portal/, matches every other
# scripts/*.sh in this repo)
set -uo pipefail

# Repo root is one level above the portal/ npm workspace root — same layout CLAUDE.md
# documents for the git root vs. the npm workspace root split.
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORTAL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The static scan is deliberately scoped to exactly the directories T-044's own task file
# names in its Method §1 — the parts of this repo that can plausibly read reward_config
# directly. Everything else (portal/back-end, portal/front-end) reads reward_config only
# through Sequelize models that T-003/T-017 already inventory; adding them here would just
# duplicate that work, not extend the evidence.
SCAN_DIRS=("$REPO_ROOT/agents/create-campaign" "$REPO_ROOT/agents/create-campaign-v2" "$REPO_ROOT/database" "$REPO_ROOT/documents")

# Candidate columns, "table.column" — exactly T-044's own "Candidate columns" list.
# merchant_stores has no contact_* columns in the live DDL (confirmed against
# database/reward_config_postgres.sql) — scanned anyway so that fact is evidence, not an
# assumption; see the report.
CANDIDATE_COLUMNS=(
  "merchants.contact_email"
  "merchants.contact_phone"
  "merchants.website"
  "merchant_stores.contact_email"
  "merchant_stores.contact_phone"
  "tenants.contact_email"
  "tenants.contact_phone"
  "admin_users.email"
  "tenant_campaigns.metadata"
  "reward_systems.connector_config"
)

# Owning tables — used for the SELECT * triage (Method §1, TC-2): SELECT * against one of
# these tables silently picks up a candidate column without ever naming it.
OWNING_TABLES=(merchants merchant_stores tenants admin_users tenant_campaigns reward_systems)

GREP_EXCLUDES=(--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=.git --exclude-dir=coverage --exclude-dir=sessions)

echo "=== T-044 column-usage-scan.sh ==="
echo "Repo root: $REPO_ROOT"
echo "Scanned directories:"
for d in "${SCAN_DIRS[@]}"; do
  echo "  - $d"
done
echo

echo "--- 1. Static scan: candidate column names ---"
for col in "${CANDIDATE_COLUMNS[@]}"; do
  name="${col#*.}"
  echo
  echo "[$col]"
  found=0
  for d in "${SCAN_DIRS[@]}"; do
    [ -d "$d" ] || continue
    if grep -rniI "${GREP_EXCLUDES[@]}" -n "$name" "$d" 2>/dev/null; then
      found=1
    fi
  done
  if [ "$found" -eq 0 ]; then
    echo "  (no hits)"
  fi
done

echo
echo "--- 2. SELECT * against an owning table (high-risk case) ---"
for d in "${SCAN_DIRS[@]}"; do
  [ -d "$d" ] || continue
  grep -rniI "${GREP_EXCLUDES[@]}" -n "select \*" "$d" 2>/dev/null || true
done
echo "(each hit above must be triaged by hand against OWNING_TABLES: ${OWNING_TABLES[*]} — see the report)"

echo
echo "--- 3. Runtime evidence: pg_stat_statements ---"
if [ -n "${DB_HOST:-}" ] && command -v psql >/dev/null 2>&1; then
  PGPASSWORD="${DB_PASSWORD:-}" psql -h "${DB_HOST}" -p "${DB_PORT:-5432}" -U "${DB_USERNAME:-reward_app}" -d "${DB_NAME:-reward_system}" -v ON_ERROR_STOP=0 -c \
    "SELECT query, calls, rows FROM pg_stat_statements WHERE query ILIKE '%contact_email%' OR query ILIKE '%merchants%' ORDER BY calls DESC LIMIT 50;" \
    2>&1 || echo "  pg_stat_statements query failed — see error above (commonly: extension not loaded via shared_preload_libraries)."
else
  echo "  Skipped: no DB_HOST in environment (or psql not on PATH). Set DB_HOST/DB_PORT/DB_NAME/DB_USERNAME/DB_PASSWORD to run this against a live database."
fi

echo
echo "--- 4. Connection census: pg_stat_activity ---"
if [ -n "${DB_HOST:-}" ] && command -v psql >/dev/null 2>&1; then
  PGPASSWORD="${DB_PASSWORD:-}" psql -h "${DB_HOST}" -p "${DB_PORT:-5432}" -U "${DB_USERNAME:-reward_app}" -d "${DB_NAME:-reward_system}" -v ON_ERROR_STOP=0 -c \
    "SELECT DISTINCT usename, application_name, client_addr FROM pg_stat_activity ORDER BY usename;" \
    2>&1 || echo "  pg_stat_activity query failed — see error above."
else
  echo "  Skipped: no DB_HOST in environment (or psql not on PATH)."
fi

echo
echo "=== Scan complete. This is raw evidence only — it is one point-in-time sample, not a"
echo "working-day census, and it cannot see any consumer outside this repository or outside"
echo "the sampled connections (e.g. a monthly batch job). See project-plan/reports/T-044-column-consumers.md"
echo "for the recommendation built from this output plus the humans-asked step."

exit 0
