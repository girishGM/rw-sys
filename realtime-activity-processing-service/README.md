# realtime-activity-processing-service

Standalone NestJS service that ingests customer activity in real time (gRPC + Kafka), maps it
against a locally cached copy of the portal's campaign/tracker/rule/reward/budget configuration,
tracks per-customer tracker progress, enforces budgets/caps, and emits reward entries toward
`reward-redemption-service`. **Not** part of the portal — no shared npm workspace, no shared
database schema, no shared task tracker. See
`../realtime-activity-processing-service-plan/ARCHITECTURE.md` for the full design and
`../realtime-activity-processing-service-plan/AGENT-PROTOCOL.md` before making any change here.

## Local setup

Node 20 is required (`engines` in `package.json`, enforced by a `preinstall` check):

```bash
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
cp .env.example .env.development   # fill in real values — never commit this file
npm install
```

Postgres is the **existing** server documented in the repo root `CLAUDE.md`
(`/Library/PostgreSQL/16`, database `reward_system`) — this project never starts its own
Postgres. Only the local Kafka-compatible broker (Redpanda) is started by this project's own
`docker-compose.yml`, on ports `9093`/`9645`/`8083` (not the `9092`/`9644`/`8082` default —
`promo-code-service`'s own Redpanda already binds those on this machine, so both services' local
dev loops can run at the same time):

```bash
docker compose up -d          # Redpanda + a one-shot Postgres connectivity probe
docker compose ps             # redpanda should show "Up (healthy)"
npm run db:status             # pg_isready against DB_HOST/DB_PORT — the same real server
```

## Database migrations

`npm run db:migrate` / `npm run db:rollback` / `npm run db:migrate:status` run a real
Sequelize/Umzug CLI (`src/database/cli/migrate.ts`) against the `realtime_activity_processing`
schema (T-RAP-002) — every table in `01-DATABASE.md` §1-§11, plus the least-privilege `rap_app`
role (§13, R1: scoped to `realtime_activity_processing.*` only, nothing on `reward_config`/
`reward_portal`/`promo_code`). Always connects as the privileged `DB_MIGRATION_*` role
(`migration-connection.ts`); application runtime code connects as `DB_APP_*` (`rap_app`) only.
`npm run db:rollback -- --all` rolls back every migration and drops the schema itself — the full
teardown `AGENT-PROTOCOL.md` §4's gate command (`db:migrate && db:rollback && db:migrate`)
round-trips through. Raw row shapes for every table live in `src/database/models/*.ts` — the
shared source of truth later tasks' own module-level repositories build their domain types from.

`npm run db:seed` (T-RAP-003, `src/database/seeds/`) seeds enough local data for every later wave
to develop and test against without a live portal connection: the one required
`field_encryption_config` row, the four global `service_config` rows, and one demo
`campaign_config_snapshot` row (a two-tracker campaign — one `completion_logic = 'all'`, one
`'n_of'` — shaped exactly like the portal's `CampaignConfig` gRPC contract). Safe to re-run —
idempotent by construction, not by relying on a plain `ON CONFLICT` (see that directory's own
file headers for why a nullable `scope_ref` column needs an `IS NOT DISTINCT FROM` check instead).
Connects as `DB_APP_*` (`rap_app`), not the migration role — seeding is plain DML.

## Health check

`GET /health` returns process liveness plus a raw TCP-reachability check against
`DB_HOST`/`DB_PORT` (not an authenticated query against the now-existing `rap_app` role — that
remains this endpoint's own future scope, not T-RAP-002's, whose "Out" list excludes any
application code that reads/writes these tables). No Kafka broker check yet (Kafka wiring is
Wave 2).

```json
{ "status": "ok", "db": "reachable" }
```

`503 { "status": "degraded", "db": "unreachable" }` if Postgres isn't reachable.

## Commands

```bash
npm run typecheck
npm run lint -- --max-warnings=0
npm test
npm run test:cov
npm run build
npm run scan:secrets
npm run start:dev             # http://localhost:3020 by default (PORT in .env)
```

## Pre-commit hook

`.husky/pre-commit` runs `lint -- --max-warnings=0` then `scan:secrets` (via `cd
realtime-activity-processing-service`, since this project sits one level below the git root),
matching `promo-code-service/.husky/pre-commit`'s own precedent. It's wired up automatically by
the `prepare` script (`cd .. && husky realtime-activity-processing-service/.husky`) on
`npm install`.
