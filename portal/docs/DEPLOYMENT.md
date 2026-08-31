# Deployment

**Status of this document:** the "First run on a clean clone" section below is T-057's
(runnability defects) — the sequence a fresh clone needs to boot the API directly with
`npm run start:dev`, no containers involved. **T-052 (observability, containerisation, health
checks) adds everything from "Docker and `docker-compose`" onward** — the containerised path,
metrics, environments, and the backup/DR open decision. The two sections describe two
different ways of running the same application; neither supersedes the other, and both are
kept current.

---

## First run on a clean clone

Every step below is required, in this order. None of it is optional — skipping any step is
exactly what made the portal "not yet deployed" indistinguishable from "not deployable"
before T-057 (see `project-plan/tasks/T-057-runnability-defects.md`).

### 0. Prerequisites

- Node 20 LTS on `PATH` (`node -v` → `v20.x`; see the repo root `CLAUDE.md` if it still shows
  v16 — nvm's `default` alias is deliberately left alone).
- A reachable Postgres instance holding the `reward_config` schema already (this portal does
  not create that schema — see `01-DATABASE.md`), plus the two roles `back-end/.env.example`
  documents (`DB_APP_*`, `DB_MIGRATION_*`).
- `back-end/.env.development` (or `.env.local`/`.env`, same precedence every CLI in this
  project uses) populated from `back-end/.env.example` — **every value it needs**, including
  the RS256 keypair and the database credentials. Never copy real values into a committed
  file (R4).

### 1. Install and build

```bash
npm install                     # portal/ — postinstall gates on Node 20
```

`npm install` alone is enough to leave `packages/shared` built (`prepare` runs
`npm run build -w packages/shared` before husky installs its own hooks) — the defect this
closes (D-1) was that `packages/shared` had no build at all, so `nest start`/`node dist/main.js`
died on the very first `import` from it. If you ever edit `packages/shared/src/**` afterwards,
rebuild it explicitly (`npm run build -w packages/shared`) before relying on `back-end`/
`front-end` picking the change up — this is a normal build-once-cache-the-output workspace, the
same way editing any other library the app depends on requires a rebuild.

### 2. Migrate the portal schema

```bash
npm run db:migrate               # portal/ — or `cd back-end && npm run db:migrate`
```

Creates `reward_portal` and applies every migration, using the **migration** role
(`DB_MIGRATION_*`), never the app's own least-privilege role. See `01-DATABASE.md` §3 for why
the two roles are never merged.

### 3. Provision the first encryption keys

**Do this against the real target database for this environment — never against a shared
database other people, tasks or automated test suites also depend on, to try it out or
verify it.** `provision` inserts a *permanent* `active` row (`uq_ek_active_purpose` allows
only one per purpose, forever, until a real `rotate` replaces it): running it against a
shared local dev database once made that database permanently unable to run
`test/crypto/crypto.e2e-spec.ts`'s own beforeAll unmodified, because that suite (reasonably,
at the time it was written) assumed no environment it ran against would ever have a
permanent active key — see that file's own header comment for the fix, and this task's
completion report for the full incident. If you want to try the sequence below without any
risk to a database anyone else uses, `back-end/test/database-cli/first-run.e2e-spec.ts` runs
the exact same three commands (`db:migrate`, `provision field`, `provision blind_index`,
`bootstrap:superadmin`) against a brand-new, disposable database it creates and drops itself
— `npm run test:e2e -- test/database-cli/first-run.e2e-spec.ts` from `back-end/`.

The portal cannot create its first user — cannot even attempt to, since `portal_users.email`
is encrypted at rest — until at least one `active` `field` key and one `active` `blind_index`
key exist in `reward_portal.encryption_keys`. Nothing seeds this table (deliberately —
`T016_001_encryption_keys.ts`'s own header: *"which kids exist, and which env vars hold them,
is a deployment decision"*), and until T-057 nothing implemented that decision either. Now:

```bash
cd back-end
npx ts-node -T -r tsconfig-paths/register src/database/cli/encryption-keys.ts provision field
npx ts-node -T -r tsconfig-paths/register src/database/cli/encryption-keys.ts provision blind_index
```

Each command prints **once** a `NAME=value` line — the environment variable name
`encryption_keys.key_ref` now points at (`env:NAME`), and the base64 key material to put
there. **This is the only time it is printed.** Nothing secret is written to any file by this
command. Copy each value into your secret manager, or into this environment's own
`.env.<environment>` file (never a committed file — see `.env.example`, R4), under the exact
name shown, then make sure it is exported in the real process environment (or present in an
`.env` file — see "A note on where key material may live" below) before the API starts.

Full command reference — `list`, `add` (stage a second, non-active key ahead of a rotation),
`rotate <kid>`, `retire <kid>` — is in `encryption-keys.ts`'s own header comment. `rotate`/
`retire` are thin wrappers around the already-built rotation engine
(`src/common/crypto/rotate-keys.command.ts`, T-016); this CLI adds no crypto of its own.

There is deliberately no `npm run` alias for this command (`back-end/package.json` is
`T-001`'s file, out of this task's scope — see the T-057 completion report's "Deviations from
spec"). The `npx ts-node ...` form above is the whole interface.

### 4. Bootstrap the first Super Admin

```bash
npm run bootstrap:superadmin      # from back-end/, or `npm run bootstrap:superadmin` from portal/
```

Prompts for (or reads from `SUPERADMIN_EMAIL`/`SUPERADMIN_NAME`/`SUPERADMIN_PASSWORD`) the
first `super_admin` account. Refuses if one already exists. Requires step 3 to have completed
successfully — without an active `field`/`blind_index` key pair this fails with a clear
`KeyRegistryError` naming the missing key, not a silent hang.

### 5. Start the API and log in

```bash
npm run start:dev                 # dev, from portal/
# or, for the production build:
npm run build && npm start        # from portal/ — this is the path CI/deployment actually runs
```

`GET /api/v1/health` → `{"status":"ok"}` confirms the process is up. Log in through the SPA
(or `POST /api/v1/auth/login`) as the account step 4 created; it carries
`must_change_password=true`, so the first real action is a forced password change.

---

## A note on where key material may live (D-3)

Every other required environment variable (`DB_HOST`, `JWT_PRIVATE_KEY`, ...) is validated by
`env.schema.ts` and therefore reaches `process.env` however you supply it — a real exported
variable or a `.env.<environment>` file both work identically.

**Key material referenced by `encryption_keys.key_ref` is different, and the difference used
to be silent and misleading before this task:** the value can be supplied either as a real
process environment variable, **or** in `.env.local`/`.env.<NODE_ENV>`/`.env` in `back-end/`
— `EnvKeyMaterialResolver` (`src/common/crypto/key-material.resolver.ts`) now reads both,
falling back to whichever `.env` file would have supplied it at boot, with a real environment
variable always taking priority when both are present. If a key's variable is missing from
every one of those, the boot fails with a message that says so plainly and names every place
it looked — it no longer claims a variable "is not set" while it sits visibly in a `.env`
file the process already loaded.

---

## Known environmental hazard — a shared database's `encryption_keys` rows are everyone's problem

`KeyRegistryService.load()` (T-016) resolves **every** row in `encryption_keys`, regardless
of status or purpose, at boot — a single row whose `key_ref` variable is not obtainable from
anywhere fails the entire boot, dev or production. Two distinct, real incidents on this
project's own shared local development database illustrate the two ways that bites:

1. **An orphaned row with unrecoverable material.** A `rotating` row left behind by a manual
   verification session, whose env var value nobody still running could supply, blocked every
   boot on this database until whoever owned that session cleaned it up (`encryption-keys.ts
   list` shows rows like this — `rotating`/`retired` rows with no corresponding value
   anywhere are always safe to investigate, never assume your own configuration is at fault
   without checking first). **This is not a one-off** — during T-057's own retry, three more
   such rows appeared *while the retry was in progress*, from three other agents' concurrent
   verification sessions on this same machine (`t058ui_t056_*`, `t033ui_t056_*`,
   `t045ui_t056_*`), and broke `test/crypto/crypto.e2e-spec.ts` a second time for a reason
   unrelated to incident 2 below. That file's `beforeAll` now tolerates this generically (see
   its own header, "Orphaned rows from other tasks' own verification sessions"), but any other
   code path that boots `KeyRegistryService` against this database — `migrate.ts`'s own
   `down()` for `T056_001_portal_users_email_blind_index.ts` among them — does not, and will
   fail exactly this way for as long as this pattern of concurrent, uncoordinated manual
   sessions against one shared database continues. Worth an architect decision on process, not
   something any one task's file grant can fix alone.
2. **A permanent `active` row nobody expected to still be there.** T-057's own first
   verification pass provisioned real `active` `field`/`blind_index` keys (`dev_local_fld` /
   `dev_local_bidx`) against this same shared database to prove step 3 worked — which is
   exactly what `provision` is supposed to do, permanently, by design
   (`uq_ek_active_purpose`). That permanence is precisely what then made
   `test/crypto/crypto.e2e-spec.ts`'s own `beforeAll` fail on every subsequent run, because it
   had been written under the (previously true, now false) assumption that nothing else in
   this codebase could ever create a permanent active key. Fixed in that file directly (see
   its own header); the real keys were kept, not deleted — real `portal_users` rows on this
   database are genuinely encrypted under them.

The takeaway for anyone about to run `provision`/`add`/`rotate`/`retire` by hand: **do it
against the real target for that environment, never against a shared database other tasks,
suites or people also rely on**, exactly as the warning at the top of step 3 above says. Use
`back-end/test/database-cli/first-run.e2e-spec.ts` (a disposable, self-contained database) if
you just want to see the sequence work.

---

## Docker and `docker-compose`

`docker-compose.yml` (workspace root, `portal/`) brings up four services — `postgres`,
`migrate`, `api`, `web` — from a clean checkout with no other tooling installed. This is the
**local-and-CI path**, not a template for a real production deployment; see "What this compose
file is, and is not" below before reusing it as one.

### First run

```bash
cp .env.example .env       # then fill in JWT_PRIVATE_KEY/JWT_PUBLIC_KEY — see the file's own
                            # comments; everything else already has a workable local default
docker compose up --build
```

What happens, in order:

1. **`postgres`** (`postgres:16-alpine`) starts from an empty volume. Its own
   `docker-entrypoint-initdb.d` mechanism runs `docker/postgres-init/01-create-app-role.sh`
   (creates the `reward_app` login role — the real, non-Docker Postgres this project also
   targets already has this role provisioned by hand, see the repo root `CLAUDE.md`; a
   from-scratch compose environment has no such human step, so this script is it) and then
   `database/reward_config/reward_config_postgres.sql` (repo root, one level above `portal/`,
   under `database/reward_config/` since the 2026-08-29 restructuring — mounted read-only; this
   is *not* a second source of truth for that schema, purely what makes this file self-contained
   on a clean checkout that has no real `reward_config` to point at). A
   `pg_isready` healthcheck gates everything downstream.
2. **`migrate`** runs once (`restart: "no"`) against a **different build target** than `api` —
   `back-end/Dockerfile`'s `migrator` stage, not `runtime`. See "A defect this compose file
   works around" below for why; the short version is that the compiled production CLI
   (`node dist/database/cli/migrate.js`) currently reports success while silently applying
   nothing, and this stage sidesteps that by running the same command every other verification
   in this project has always used (`ts-node` against the `.ts` sources).
3. **`api`** starts once `migrate` exits `0` and `postgres` is healthy. Its own `HEALTHCHECK`
   (`back-end/Dockerfile`) is what `docker compose ps`/`depends_on: condition: service_healthy`
   read — there is exactly one liveness check, not a second one duplicated in this file.
4. **`web`** (nginx, serving the built SPA and reverse-proxying `/api/*` to `api`) starts once
   `api` is healthy.

`GET http://localhost:${API_PORT:-3000}/api/v1/health` and
`http://localhost:${WEB_PORT:-8080}/` should both answer once `docker compose ps` shows every
service healthy.

**Provisioning encryption keys and the first Super Admin** still needs the same two manual
steps "Provision the first encryption keys" and "Bootstrap the first Super Admin" describe
above, run against the container instead of the bare `npx ts-node` form:

```bash
docker compose exec api node dist/database/cli/encryption-keys.js provision field
docker compose exec api node dist/database/cli/encryption-keys.js provision blind_index
# copy each printed NAME=value line into .env, as that file's own comments describe, then:
docker compose up -d api    # picks up the new values
docker compose exec -e SUPERADMIN_EMAIL=... -e SUPERADMIN_NAME=... -e SUPERADMIN_PASSWORD=... \
  api node dist/cli/bootstrap-superadmin.js
```

Neither step is automated by this compose file — see "What this compose file is, and is not"
below for why that is a deliberate boundary, not an oversight.

### Picking up a later code change in a long-lived stack

`docker compose up --build` only rebuilds on that first invocation. **A stack left running
across multiple later `git`/source changes does not pick any of them up on its own** —
`api`/`web` keep serving whatever image was built the last time `--build` (or an explicit
`docker compose build`) actually ran, indefinitely, with no error or warning that the running
code and the checked-out source have diverged. This was found live, not theoretically: while
re-verifying a fixed defect (T-092, `project-plan/reports/T-054-release-readiness.md` §1) for
this documentation set, a long-running local stack kept showing the *pre-fix* behaviour for
several hours after the fix had landed and its own task report said `done`, simply because
nobody had rebuilt the containers in between. The fix was correct throughout; the running
environment was stale. To pick up a code change against an already-running stack:

```bash
docker compose build api web        # or the full service list, if front-end assets changed too
docker compose up -d --no-deps api web   # recreates only these two; postgres/its data untouched
```

`--no-deps` matters here: without it, Compose also re-evaluates `postgres`'s and `migrate`'s
dependency chain, which is harmless but unnecessary noise for a code-only change. If a migration
was part of the change, run `migrate` again first (`docker compose run --rm migrate`) before
recreating `api`.

### What this compose file is, and is not

- **Is:** a genuinely self-contained way to prove the containerised images work end to end —
  build, migrate, serve, healthcheck, reverse-proxy — on a machine with nothing installed but
  Docker. This is what TC-12/TC-13/TC-17/TC-18 (T-052's own test cases) were verified against,
  live, while writing this section.
- **Is not:** a production topology. `DB_SSL=false` and `NODE_ENV=development` are set
  explicitly for the `migrate`/`api` services, because the `postgres` container here has no
  TLS listener configured at all — `02-SECURITY.md`'s "DB_SSL must be true outside
  development/test" is a real requirement for a real deployment, and this file does not
  attempt to satisfy it (out of this task's scope: "actual cloud provisioning" — see the task
  file). A real deployment needs its own TLS-terminated Postgres (managed or self-hosted) and
  `NODE_ENV=production`, at which point `DB_SSL=true` is enforced by `sequelize.provider.ts`
  exactly as designed.
- **Is not** a key-management or backup solution — see "Backup, disaster recovery and key
  escrow" below, which this compose file does nothing to close.

### A defect this compose file works around (filed as T-079)

While first verifying `docker compose up` against a fresh database, `migrate`'s original
design — run `node dist/database/cli/migrate.js up`, the compiled production CLI, no dev
dependencies needed — applied **zero** migrations and reported success. Root cause:
`createMigrator()`'s migration glob (`back-end/src/database/umzug.ts`, owned by T-002, outside
this task's file scope per R9) is hard-coded to `migrations/*.ts`. Every prior verification of
this CLI in this project ran it via `ts-node` against the real `.ts` sources, where that glob
matches; compiled to `dist/`, the migration files are `.js`, the glob matches nothing, and
`Applied 0 migration(s)` is indistinguishable from "already up to date" — a silent no-op, not
a loud failure.

Filed as **T-079** (`agent-foundation`), with full reproduction steps. This file's own
`migrate` service does not wait for that fix: `back-end/Dockerfile`'s `migrator` stage runs
`ts-node` against the source directly (the same invocation `db:migrate` already used
successfully in every other task's own verification), which is unaffected by the bug. **This
is a real, verified mitigation, not a workaround masking an untested path** — TC-13 was
confirmed by counting `reward_portal`'s tables before (1: the empty migration-tracking table)
and after (the real ~30-migration count) a full `docker compose up` on a disposable database.
Anyone who runs `node dist/database/cli/migrate.js` directly, outside this compose file — a
hand-written Kubernetes `Job` manifest, for instance — still hits the underlying bug until
T-079 lands.

---

## Environments

This project has no committed hosting target (BACKLOG.md B-15 records the same gap for
backup/DR). What's true regardless of where it eventually runs:

| | Local (`npm run start:dev`) | `docker compose up` | A real deployment |
|---|---|---|---|
| `NODE_ENV` | `development` | `development` (see above) | `production` |
| `DB_SSL` | usually `false` (local Postgres) | `false` (no TLS in this compose file) | **must be `true`** (02-SECURITY.md §7) |
| HTTPS enforcement (`main.ts`) | off | off | on (`enforceHttps` keys off `NODE_ENV=production`) |
| Metrics port | bound, `METRICS_HOST` unset (all interfaces) | bound, not published (TC-11) | bound, reachable only from a scrape target inside the same private network — **never** through the public ingress/load balancer that reaches `api`'s own port |
| Rate-limit store (`REDIS_URL`) | unset — in-memory, fine for one process | unset | **required** for more than one instance (02-SECURITY.md §8, AR-11) — an in-memory limiter across N instances is an N-times weaker limiter |
| Encryption key material | `.env.development`/`env:` vars | `.env`/`env:` vars | a real secret manager or KMS — see "Backup, disaster recovery and key escrow" below; env vars are what T-057 wired up as the *mechanism*, not a statement that a flat file is where production key material should live |

None of this changes what a deployment target actually is — that decision (cloud provider,
container orchestrator, managed Postgres or self-hosted, reverse proxy/ingress, secret
manager) is exactly the "actual cloud provisioning" this task's own Scope table marks **Out**.

---

## Metrics

`GET /metrics` (08-OBSERVABILITY.md §8) is served on a **separate port** (`METRICS_PORT`,
default `9464`) by a second, independent HTTP listener
(`back-end/src/modules/health/metrics/metrics-server.service.ts`) — not a route on the main
API port, and not started via `main.ts` at all (it self-starts from a Nest lifecycle hook, so
the whole feature stays inside `back-end/src/modules/health/**`). This is what makes "reachable
on the metrics port only; not reachable from outside the container network" (TC-10/TC-11) true
by construction rather than by guard configuration: there is no `/metrics` route on the main
port to disable, only a port `docker-compose.yml` chooses not to publish.

**What is genuinely measured today:** `http_requests_total{route,status}` and
`http_request_duration_seconds{route}` (from every request, via a global middleware —
`HealthModule`'s own `configure()`) and `db_pool_utilisation` (sampled from Sequelize's
connection pool at scrape time). **What is deliberately not populated by this task:**
`auth_login_total`, `auth_permission_denied_total`, `auth_refresh_reuse_detected_total`,
`rbac_cache_hit_ratio`, `rule_evaluations_total`, `crypto_decrypt_failures_total`,
`pii_reveal_total` — every one of those events happens inside a file this task does not own
(`auth`, `rbac`, `crypto`, `data-protection`), and deriving them approximately from HTTP status
codes here would produce a metric with the right name and shape that silently mislabels every
sample it counts. The registry (`MetricsRegistry`, exported globally by `MetricsModule`) is
the ready-made seam for whichever task instruments those events at their real source; see
`metrics.registry.ts`'s own header.

**A real deployment's scrape target** (Prometheus, or an OpenTelemetry collector's Prometheus
receiver) must live inside the same private network as `api` — never behind the same public
ingress that reaches `PORT`. `docker-compose.yml`'s `expose: - "9464"` (not `ports:`) is the
worked example of that boundary in a compose network; the equivalent in a real cluster is a
`NetworkPolicy`/security-group rule, not this file's concern.

---

## Backup, disaster recovery and key escrow — OPEN DECISION, not resolved here

**This section exists because [`BACKLOG.md` B-15](BACKLOG.md) requires it, and because this
task's own file (`T-052-observability-deployment.md`, implementation note 9) is explicit: "an
infrastructure decision this task cannot make unilaterally... `DEPLOYMENT.md` must contain an
explicit, prominent, unresolved section — not a checkbox marked done."** Nothing below silently
picks a default. If you are looking for "the backup strategy," there isn't one yet — that is
the finding, not a gap in this document.

### The gap, stated plainly

- **No backup process exists for either database anywhere in this repo, this task included.**
  `pg_dump`/WAL archiving/point-in-time recovery/a managed provider's own backup product — none
  is chosen, configured, or scheduled.
- **`encryption_keys.key_ref` deliberately never stores key material itself**
  (07-DATA-PROTECTION.md §3, T-016) — it points at `env:NAME` or `kms:...`. Correct for
  confidentiality; it also means **nothing in this application backs up the key material
  itself**. That is infrastructure's job, and no infrastructure owner or mechanism is named
  anywhere in this project.
- **`reward_config` and `reward_portal` are two schemas in one physical database**
  (`01-DATABASE.md` §1) that must be recovered **in a mutually consistent state relative to
  each other** — a restore of one without the other (e.g. `reward_portal` restored to
  Tuesday while `reward_config` is still at Thursday) would leave foreign-key references
  (`portal_sessions.user_id`, `campaign_audit_trail` rows against a `campaigns` table that no
  longer matches) pointing at data that no longer means what the restored row says it means.
  Nothing here specifies whether that means one combined backup job or two coordinated ones.

### The consequence, stated plainly (BACKLOG.md B-15, verbatim)

> Losing the KMS key ring — misconfiguration, an expired/rotated-away key with no
> re-derivation path, or a destroyed environment — makes every row this design deliberately
> encrypted (sessions, MFA secrets and recovery codes, transport keys, AI-agent conversation
> content, reward connector configs) **permanently and irreversibly unreadable**.

### What would resolve this — not decided here, listed so the decision is scoped

1. **Where KMS material actually lives**, and how *that* is backed up independently of the
   application database (a cloud KMS with its own replication story is a different answer from
   a `.env` file on one box, and this project has not chosen between them — see the
   Environments table above: env vars are the *mechanism* T-057 wired up, not a statement
   about where production key material belongs).
2. **A stated RPO/RTO** for the combined Postgres instance (`reward_config` + `reward_portal`
   together) — how much data loss is acceptable, how long a restore is allowed to take.
3. **A rehearsed key-recovery drill**, distinct from the migration-rollback rehearsal
   `02-SECURITY.md` §11 already requires (that rehearsal proves schema changes reverse
   cleanly; it says nothing about recovering from key loss).
4. **A named infrastructure owner and a decision-maker for the RPO/RTO numbers** — BACKLOG.md
   B-15's own "Needs from the product owner / infrastructure" line, unchanged by this task.

**Until all four exist, treat every environment this application runs in as one that cannot
recover from a lost key ring or a lost database.** That is not a hypothetical worst case; it
is the current, literal state of this project's backup posture.
