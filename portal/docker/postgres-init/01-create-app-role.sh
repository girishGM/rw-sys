#!/bin/sh
# T-052 — runs once, automatically, the first time `docker compose up` initialises the
# `postgres` service's empty data directory (the official Postgres image's own
# `docker-entrypoint-initdb.d` convention — every `*.sh`/`*.sql` file there runs, in
# alphabetical filename order, as `$POSTGRES_USER`, which is why this is `01-*` and
# `02-reward-config-schema.sql` (docker-compose.yml's own bind mount) is `02-*`).
#
# CLAUDE.md's own description of the REAL local Postgres this project also targets says it
# "already holds ... an active reward_app role" — nothing in this repo's migrations creates
# that role (`back-end/src/database/migrations/` has none, confirmed by grep while writing
# this task), because on that real server a human already did it once, out of band. A
# from-scratch `docker compose up` has no such human step, so this script is the equivalent
# one: the least-privilege runtime role every migration's `GRANT ... TO reward_app`
# (01-DATABASE.md §3, T-002) assumes already exists.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    DO \$\$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'reward_app') THEN
        CREATE ROLE reward_app LOGIN PASSWORD '${DB_APP_PASSWORD}';
      END IF;
    END
    \$\$;
    GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO reward_app;
EOSQL
