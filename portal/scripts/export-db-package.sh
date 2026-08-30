#!/usr/bin/env bash
# export-db-package.sh — regenerates database/reward_portal/{schema.sql,seed.sql,er-diagram.html}
# from the real, current database state, so that folder can always produce a portable deploy
# package for Render/cloud/local without anyone needing the portal's own npm/TypeScript toolchain
# to apply it — just `psql -f schema.sql` then `psql -f seed.sql` against a fresh database.
#
# The three output files are GENERATED — never hand-edit them. Source of truth stays
# portal/back-end/src/database/migrations/.
#
# seed.sql scope, confirmed live (2026-08-29) by grepping every T-004/T-102/T-105/T-106/T-107
# migration for its actual INSERT target: every deliberate seed row this project ships lands in
# reward_config (rule_categories, rule_sub_categories, rule_master, rule_versions,
# rule_resolvers, rule_operators, role_nav_configs, role_entity_permissions,
# role_dashboard_widgets, rbac_cache_config, approval_policies, system_messages) — NEVER
# reward_portal. reward_portal itself holds no seed data at all: every one of its 18 tables is
# live runtime/operational state (portal_users, credentials, sessions, refresh tokens, MFA
# codes, login attempts, audit logs). An earlier version of this script dumped
# `--schema=reward_portal --data-only` wholesale — a 69MB file carrying real session tokens,
# password hashes and a live audit trail into what was supposed to be a portable seed package.
# Caught on this script's own first real run; fixed to an explicit table allow-list instead of
# a schema-wide dump, on the same "an unscoped dump silently grabs the wrong thing" principle as
# AGENT-PROTOCOL.md's test-scoping rule.
#
# T-131 (2026-08-30) added the five Wave 6 reference tables below, confirmed the same way: each
# is global/tenant-scoped reference data seeded by its own migration (T116_001/T116_002,
# T121_001/T121_002, T126_001), not per-user runtime state — same category as
# rule_categories/rule_resolvers above, none of them hold session, credential or audit data.
SEED_TABLES=(
  reward_config.role_entity_permissions
  reward_config.role_nav_configs
  reward_config.role_dashboard_widgets
  reward_config.system_messages
  reward_config.rbac_cache_config
  reward_config.approval_policies
  reward_config.rule_resolvers
  reward_config.rule_operators
  reward_config.rule_categories
  reward_config.rule_sub_categories
  reward_config.rule_master
  reward_config.rule_versions
  reward_config.reward_categories
  reward_config.reward_sub_categories
  reward_config.field_context_providers
  reward_config.field_api_lookup_providers
  reward_config.tenant_currencies
)
#
# Usage (from portal/, with Node 20 on PATH):
#   npm run db:export-package
#
# Requires portal/back-end/.env.development to be populated (see CLAUDE.md's "Local
# environment" section) and psql/pg_dump on PATH.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACK_END_DIR="$SCRIPT_DIR/../back-end"
OUT_DIR="$SCRIPT_DIR/../../database/reward_portal"
SCHEMA="reward_portal"

cd "$BACK_END_DIR"

if [ ! -f .env.development ]; then
  echo "  ✗ portal/back-end/.env.development not found — see CLAUDE.md's Local environment section" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env.development
set +a

for var in DB_HOST DB_PORT DB_NAME DB_MIGRATION_USERNAME DB_MIGRATION_PASSWORD DB_APP_USERNAME DB_APP_PASSWORD; do
  if [ -z "${!var:-}" ]; then
    echo "  ✗ $var is not set in portal/back-end/.env.development" >&2
    exit 1
  fi
done

mkdir -p "$OUT_DIR"

echo "==> Applying every migration (idempotent) so the export reflects the real current schema + seed data"
npm run db:migrate

echo "==> Dumping schema ($SCHEMA, DDL only) -> database/reward_portal/schema.sql"
PGPASSWORD="$DB_MIGRATION_PASSWORD" pg_dump \
  -h "$DB_HOST" -p "$DB_PORT" -U "$DB_MIGRATION_USERNAME" -d "$DB_NAME" \
  --schema="$SCHEMA" --schema-only --no-owner --no-privileges \
  > "$OUT_DIR/schema.sql"

echo "==> Dumping seed data (${#SEED_TABLES[@]} reference tables in reward_config, data only) -> database/reward_portal/seed.sql"
TABLE_ARGS=()
for t in "${SEED_TABLES[@]}"; do
  TABLE_ARGS+=(-t "$t")
done
PGPASSWORD="$DB_MIGRATION_PASSWORD" pg_dump \
  -h "$DB_HOST" -p "$DB_PORT" -U "$DB_MIGRATION_USERNAME" -d "$DB_NAME" \
  "${TABLE_ARGS[@]}" --data-only --no-owner --column-inserts \
  > "$OUT_DIR/seed.sql"

echo "==> Generating ER diagram -> database/reward_portal/er-diagram.html"
node "$SCRIPT_DIR/generate-er-diagram.js" "$OUT_DIR/er-diagram.html"

echo
echo "==> Done:"
ls -la "$OUT_DIR"
