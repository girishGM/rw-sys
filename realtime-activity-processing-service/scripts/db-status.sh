#!/usr/bin/env bash
# db-status.sh — `npm run db:status`, the documented alternative implementation-note-4 mentions
# alongside the `postgres-connectivity-check` compose service (docker-compose.yml): a
# lightweight `pg_isready` probe against the EXISTING Postgres 16 server (root CLAUDE.md), never
# a database this project owns. Reads DB_HOST/DB_PORT from the environment (export them
# yourself, or run via a tool that loads .env.development first) and falls back to the same
# localhost:5432 default docker-compose.yml uses.
set -euo pipefail

HOST="${DB_HOST:-localhost}"
PORT="${DB_PORT:-5432}"

if ! command -v pg_isready >/dev/null 2>&1; then
  echo "pg_isready not found on PATH — install the Postgres client tools (already present on" >&2
  echo "this machine's own Postgres 16 server install, e.g. /Library/PostgreSQL/16/bin, or via" >&2
  echo "Homebrew's libpq/postgresql package) and re-run." >&2
  exit 1
fi

if pg_isready -h "$HOST" -p "$PORT" >/dev/null 2>&1; then
  echo "Postgres reachable at ${HOST}:${PORT}"
  exit 0
else
  echo "Postgres NOT reachable at ${HOST}:${PORT}" >&2
  exit 1
fi
