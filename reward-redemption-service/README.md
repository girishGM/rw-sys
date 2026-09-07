# reward-redemption-service

Standalone NestJS service that turns a reward entry RAP has already proven earned into an
actual redemption: calling the external system that fulfills that reward type (a promo code
today; a stubbed core-banking connector for later), recording the outcome, logging what a real
customer notification would say, and — when a campaign is configured to track it — reporting
the redemption to reward-tracking-service. **Not** part of the portal — no shared npm workspace,
no shared database schema, no shared task tracker. See
`../reward-redemption-service-plan/ARCHITECTURE.md` for the full design and
`../reward-redemption-service-plan/AGENT-PROTOCOL.md` before making any change here.

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
docker compose ps             # redpanda should show "Up (healthy)" on port 9094;
                               # postgres-connectivity-check should show "Exited (0)"
npm run db:status             # pg_isready against DB_HOST/DB_PORT — the same real server
```

## Database migrations

The `reward_redemption` schema, its own tables and the least-privilege `rr_app` runtime role
land in Wave 0 (T-RR-002/T-RR-003) — this task (T-RR-001) wires the stable command names only;
`src/database/cli/migrate.ts` does not exist yet:

```bash
npm run db:migrate            # applies every pending migration (up)
npm run db:rollback           # reverts the single most recently applied migration (down)
npm run db:migrate:status     # lists applied/pending migrations without changing anything
npm run db:seed               # inserts (or re-affirms) demo config rows (T-RR-046)
```

## Commands

```bash
npm run typecheck
npm run lint -- --max-warnings=0
npm test
npm run build
npm run scan:secrets
npm run start:dev             # GET http://localhost:3030/health
```

## Health check

`GET /health` — process liveness plus a raw DB TCP reachability check, deliberately
unauthenticated: `200 {"status":"ok","db":"reachable"}` when Postgres accepts the TCP handshake,
`503 {"status":"degraded","db":"unreachable"}` otherwise, within a short, bounded timeout. It is
a raw TCP connect, never an authenticated query — the same shape RAP's and promo-code-service's
own `/health` endpoints already use, and deliberately so: it must already answer even before the
`rr_app` role exists (e.g. immediately after a fresh deploy, pre-migration).

## Ports

| Process | Port | Notes |
|---|---|---|
| HTTP/REST (`src/main.ts`) | `3030` | Distinct from RAP's `3020` and promo-code-service's `3010` (`07-CONFIGURABILITY-AND-OBSERVABILITY.md` §1). |
| Inbound gRPC (`RewardIngestService`, T-RR-011) | `50081` | Its own standalone bootstrap entry point, not part of `src/main.ts`. |
| Local Redpanda (Kafka API) | `9094` | `docker-compose.yml` — the third free port after promo-code-service's `9092` and RAP's `9093`. |

## Deploying

`Dockerfile`/`render.yaml` are prepared and locally validated by this task, but this task does
**not** apply the Render Blueprint against the shared environment — see `render.yaml`'s own
header and `AGENT-PROTOCOL.md` R11. Preparing a production-affecting action and executing it are
different Definitions of Done.
