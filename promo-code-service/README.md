# promo-code-service

Standalone NestJS service that generates and issues promo codes for
`reward-redemption-service`, synchronously over gRPC or asynchronously over Kafka depending
on that caller's own reward configuration. **Not** part of the portal — no shared npm
workspace, no shared database schema, no shared task tracker. See
`../promo-code-service-plan/ARCHITECTURE.md` for the full design and
`../promo-code-service-plan/AGENT-PROTOCOL.md` before making any change here.

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
`docker-compose.yml`:

```bash
docker compose up -d          # Redpanda + a one-shot Postgres connectivity probe
docker compose ps             # redpanda should show "Up (healthy)"
npm run db:status             # pg_isready against DB_HOST/DB_PORT — the same real server
```

## Database migrations

`promo_code` schema, the five core domain tables (01-DATABASE.md, T-PC-002), the least-privilege
`promo_code_app` runtime role, and the gRPC mTLS client-identity allowlist
(`grpc_service_identity`, T-PC-044, `03-GRPC-CONTRACT.md` §3) — always run as the privileged
`DB_MIGRATION_*` role, never the app role:

```bash
npm run db:migrate            # applies every pending migration (up)
npm run db:rollback           # reverts the single most recently applied migration (down)
npm run db:rollback -- --all  # reverts every migration — drops all 6 tables, the role, and
                               # the promo_code schema itself
npm run db:migrate:status     # lists applied/pending migrations without changing anything
```

`DB_APP_PASSWORD` (`.env.development`/`.env.example`) is what `007_create_promo_code_app_role`
actually sets the `promo_code_app` role's login password to — not just a placeholder the app
reads at boot. Rotate it there and re-run `npm run db:migrate` to pick up the new value (the
migration is idempotent: `ALTER ROLE` if the role already exists, `CREATE ROLE` if it doesn't).

## Demo seed data

```bash
npm run db:seed               # inserts (or re-affirms) 3-5 demo promo_code_config rows
```

Connects as the least-privilege `promo_code_app` role (T-PC-003 — plain `INSERT`, no DDL), and
is idempotent via the same partial-unique index (`uc_promo_code_config_name`) the schema itself
enforces, so running it more than once never creates duplicates. Rows are tagged with a fixed
demo actor id (`src/database/seeds/seed-data.constants.ts`); see that task's own "Rollback"
section for the manual cleanup query if you ever need to remove them.

## Commands

```bash
npm run typecheck
npm run lint -- --max-warnings=0
npm test
npm run build
npm run scan:secrets
npm run start:dev             # GET http://localhost:3010/health
```

## Health check

`GET /health` reports process liveness plus a raw TCP reachability check against
`DB_HOST`/`DB_PORT` (200 `{"status":"ok","db":"reachable"}`, or 503
`{"status":"degraded","db":"unreachable"}`). It is deliberately **not** an authenticated
query — even now that `promo_code_app` exists (T-PC-002's migration), no service code queries
through it yet (that starts with T-PC-010) — and it does not check Kafka; that lands with the
transport adapters in Wave 3.
