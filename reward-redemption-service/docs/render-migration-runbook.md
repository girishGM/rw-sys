# reward-redemption-service — Render migration + seed runbook

Written by T-RR-046 (R11-gated — see `reward-redemption-service-plan/tasks/T-RR-046-db-migration-
seed-render-prep.md` and `ARCHITECTURE.md` §11). This document is the exact, followable operator
runbook for applying this service's schema migrations and demo/seed data to the **shared Render
Postgres instance** (`reward-portal-db`, the same physical database the portal and
`promo-code-service` already use — `render.yaml`'s own header). **No command in this document has
been run against that shared instance by any automated task.** Every command below has been proven,
literally as written, against local Postgres only (this task's own completion report records the
exact output). Running any of them against the real Render database is a deliberate, recorded,
human decision — not something this runbook, or the task that wrote it, executes unilaterally.

## 0. Why this split exists (R11)

Per `AGENT-PROTOCOL.md` R11 (the same rule `render.yaml`'s own header already cites for why this
Blueprint has never been applied): a production-affecting action against shared, hard-to-reverse
infrastructure requires the operator's own explicit go-ahead, recorded in a task's completion
report — never an unattended default. "Preparing the change and locally verifying it" and
"executing the change against the shared instance" are two different Definitions of Done. This
runbook is the first; an operator manually running the commands in §3/§4 below, on their own
authority, is the second.

## 1. Roles — which credential each command uses, and why

Two roles, the same split `render.yaml`, `.env.example`, and root `CLAUDE.md`'s own portal section
already document:

| Role | Env vars | Used by | Never used by |
|---|---|---|---|
| **Migration role** (privileged — `postgres` superuser on this shared instance, same as the portal/RAP/promo-code-service already use) | `DB_MIGRATION_USERNAME`, `DB_MIGRATION_PASSWORD` | `npm run db:migrate` / `db:rollback` / `db:migrate:status`, and this task's own `npm run db:seed` (needs `CREATE TABLE` for its own `seed_migrations` bookkeeping table — see `src/database/seeds/index.ts`'s own header) | Request-time application code — never imported outside a CLI |
| **App role** (`rr_app`, least-privilege, scoped to the `reward_redemption` schema only) | `DB_APP_USERNAME`, `DB_APP_PASSWORD` | The running service itself (`dist/main.js`) — created/altered by `014_create_rr_app_role.ts`, the migration role's own job | The migration CLI or the seed CLI — neither ever authenticates as `rr_app` |

`DB_HOST`/`DB_PORT`/`DB_NAME` are the same three values for both roles — copied once from the
`reward-portal-db` Render dashboard, per `render.yaml`'s own comment on why they're `sync: false`
in that file (a Render Blueprint's `fromDatabase:` linking only resolves within the same Blueprint
file, and this service's Blueprint is deliberately its own, separate file).

**No value in this document, or in any file this task owns, is ever a real credential, connection
string, or secret** (R1) — every reference below is an environment variable **name**, to be filled
in locally by the operator from their own secrets store immediately before running a command, never
committed anywhere.

## 2. Pre-flight (do this first, every time)

1. Confirm you are targeting the correct, shared `reward-portal-db` instance — **not** a second,
   new database. This service never provisions its own Postgres (`render.yaml`'s own header: "There
   is deliberately no `databases:` block").
2. Set the following in your own shell (never in a committed file) — get the real values from the
   `reward-portal-db` Render dashboard and this service's own Render environment group:
   ```bash
   export DB_HOST=<from Render dashboard>
   export DB_PORT=<from Render dashboard>
   export DB_NAME=<from Render dashboard>
   export DB_SSL=true
   export DB_MIGRATION_USERNAME=<the privileged role's username>
   export DB_MIGRATION_PASSWORD=<the privileged role's own credential value>
   export DB_APP_PASSWORD=<the credential value 014_create_rr_app_role.ts should assign to rr_app's own LOGIN>
   ```
   `DB_APP_USERNAME` defaults to `rr_app` (`014_create_rr_app_role.ts`) — only export it if you're
   using a different value. `DB_APP_PASSWORD` is required even though only the migration role
   connects directly: `014_create_rr_app_role.ts`'s own `up()` reads it to set/rotate `rr_app`'s own
   LOGIN credential as part of applying migration 014.
3. Run this repo's Node 20 requirement (`package.json`'s own `preinstall` gate):
   ```bash
   export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
   ```
4. Confirm connectivity before doing anything else:
   ```bash
   npm run db:status
   ```
   Expected: `Postgres reachable at <DB_HOST>:<DB_PORT>`. If this fails, stop — do not proceed to
   §3/§4 against an instance you cannot even confirm is reachable.
5. Confirm current state before changing anything:
   ```bash
   npm run db:migrate:status
   ```
   This prints every migration already applied vs. pending — read it before running `db:migrate`,
   so you know exactly what's about to change.

## 3. Applying the schema migrations (requires operator go-ahead — R11)

**Do not run this section against the shared Render instance without the operator's own recorded
authorization for this specific action.** Locally, this task proved the full cycle clean (see this
task's own completion report for the literal output):

```bash
npm run db:migrate      # applies every pending migration in src/database/migrations/**, in order
npm run db:rollback     # reverts the single most-recently-applied migration
npm run db:migrate      # re-applies it — proves the migrate/rollback/migrate cycle is clean (R4)
```

Against Render, the intended one-time sequence is just the first line (`npm run db:migrate`) — the
rollback/re-migrate round trip above is this task's own **local** proof that every `up()`/`down()`
pair works, not a step to repeat against the shared instance on every deploy.

**If something goes wrong mid-deploy:** `npm run db:migrate:status` first, to see exactly which
migration failed or is stuck pending. `npm run db:rollback` reverts only the single most recent
migration — safe to run repeatedly, one step at a time, back toward a known-good state. There is no
`--all` rollback intended for Render (that flag also drops the entire `reward_redemption` schema,
per `migrate.ts`'s own comment — appropriate for tearing down a local dev database, never something
to run against shared, populated production data).

## 4. Applying the demo/seed data (requires operator go-ahead — R11, independent of §3)

Once (and only once) §3 has actually been run against Render under its own authorization, applying
this task's own demo dataset (`src/database/seeds/**`) is a separate action, with its own
go-ahead:

```bash
npm run db:seed -- status   # shows which of the 3 seed files are pending vs. already applied
npm run db:seed             # applies every pending one
```

**Verify success:**
```bash
npm run db:seed -- status   # should now show "Pending (0)"
```

**Rollback**, if the demo data needs to be removed (e.g. before a real tenant would ever see it):
```bash
npm run db:seed -- down          # removes the single most-recently-applied seed file's own rows
npm run db:seed -- down --all    # removes every seeded row this task's 3 seed files ever inserted
```

**Post-seed follow-up (do not skip):** `demo-external-reward-system-config.seed.ts`'s own
`endpoint_url` (`http://localhost:3010/api/v1/promo-codes/generate`) is a local-dev value, not a
real Render address — update that row's `endpoint_url` to promo-code-service's actual deployed
endpoint once one exists, via a normal `UPDATE ... SET endpoint_url = ...` against the seeded row
(`system_code = 'PROMO_CODE_SERVICE' AND tenant_id IS NULL`), before relying on this demo tenant for
anything beyond a schema/shape demonstration.

## 5. What this runbook deliberately does not do

- It does not run `render.yaml`'s Blueprint apply (`T-RR-047`'s own scope, same R11 gate).
- It does not create or rotate any Render-side secret — those are entered directly in the Render
  dashboard's own environment-variable UI, never written to a file in this repo.
- It does not touch any other service's schema (`reward_config`, `reward_portal`,
  `realtime_activity_processing`, `promo_code`) — every command above is scoped to the
  `reward_redemption` schema only, via `rr_app`'s own grants (`014_create_rr_app_role.ts`) and every
  migration's own `CREATE TABLE reward_redemption.*` statements.
