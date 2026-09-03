# Migrating the database structure and first login to Render Postgres

A record of the exact commands run to take a brand-new, empty Render Postgres instance to a
working portal database — schema, migrations, encryption keys, and a first Super Admin login —
plus *why* each step exists, for whoever (human or agent) does this again on a fresh database.

**No real secrets are written in this file on purpose** — every password/key below is a
placeholder (`<...>`). This file lives in `portal/project-setup/`, which is *not* excluded from
git the way `portal/architect-review/` is, so treat it as safe to read but never as a place to
paste a real credential.

Companion reading: `portal/docs/DEPLOYMENT.md` (the project's own general deployment reference)
and `portal/architect-review/render-deployment-guide.html` (the full Render walkthrough this
migration is one part of).

---

## The five things that have to happen, in this order

1. Create a least-privilege database role the *running app* will use.
2. Load the base `reward_config` schema.
3. Run the portal's own migrations — this creates `reward_portal` and applies every fix made
   during implementation (47 migration files at the time of this run).
4. Provision encryption keys — the app cannot create or read a single user row without these.
5. Bootstrap the first Super Admin account.

Each step depends on the one before it. Skipping or reordering any of them fails loudly (a clear
error naming what's missing), never silently.

---

## Prerequisites

- The Render Postgres instance already created (Render dashboard → New → PostgreSQL, free plan),
  **Available**.
- Its **External Database URL** — not the Internal one. Render shows both; the internal one's
  hostname has no domain suffix (`dpg-xxxxx-a`) and only resolves from *inside* Render's own
  network. The external one looks like `dpg-xxxxx-a.<region>-postgres.render.com` and is what
  every command below connects to. Trying to run these from a laptop against the internal URL
  fails at the DNS-resolution step (`NXDOMAIN`), before Postgres is ever involved — that's what
  happened the first time here, and is the easiest mistake to make in this whole process.
- Node 20 on `PATH` (`export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"`), run from
  `portal/back-end/`.
- `psql` available locally (this machine already has one via the EDB Postgres 16 install:
  `/Library/PostgreSQL/16/bin/psql`).

---

## Step 1 — Create the least-privilege `reward_app` role

**Why:** the codebase deliberately never lets the running application connect with the same
privileged role that ran the migrations (`01-DATABASE.md` §3) — the app's own role should not be
able to `CREATE`/`DROP` anything, only read and write the rows its features actually need.
Render's own auto-created database user is effectively an admin on that one database; it's the
right role to run migrations *as*, and the wrong one for the running API to connect *as* day to
day.

```bash
psql "<External Database URL>" <<'SQL'
CREATE ROLE reward_app LOGIN PASSWORD '<choose a strong password>';
GRANT CONNECT ON DATABASE <database name from the URL> TO reward_app;
SQL
```

The migrations in Step 3 grant this role everything else it needs (table-level privileges) —
this step only creates the role and lets it connect at all.

**Verify:**
```bash
psql "<External Database URL>" -c "SELECT rolname FROM pg_roles WHERE rolname='reward_app';"
```

---

## Step 2 — Load the base `reward_config` schema

**Why:** `reward_config` is explicitly *not* this portal's schema to create from scratch — in a
real corporate environment it already exists, owned by another system. `database/
reward_config_postgres.sql` (repo root, one level above `portal/`) is a schema-only port of that
real system, kept so a from-scratch environment (this one) has something to point at. This is a
**static snapshot of the starting point**, not the final state — see the note at the bottom of
this file on why Step 3 still matters even after this succeeds.

```bash
# From the git repo root (one level above portal/):
psql "<External Database URL>" -f database/reward_config_postgres.sql
```

**Verify:**
```bash
psql "<External Database URL>" -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='reward_config';"
# Expect 60 tables.
```

---

## Step 3 — Run the portal's own migrations

**Why:** every fix and addition made while building the portal — including real, authorised
changes to `reward_config` itself (e.g. relaxing a `tenant_id` constraint, granting the new
tables access) — lives as a migration file under `back-end/src/database/migrations/`, not baked
into the static `.sql` file from Step 2. **Step 2 alone leaves the database on the very first
day of the project; this step brings it current.** At the time of this run there were 47
migration files; treat that number as a floor, not a fact — check
`ls back-end/src/database/migrations/*.ts | wc -l` for the real current count before assuming
Step 2 alone is ever enough.

```bash
cd portal/back-end

# A throwaway local env file — NEVER committed, delete it when done (see the end of this file).
cat > .env <<EOF
NODE_ENV=production
DB_HOST=<host from the External Database URL>
DB_PORT=<port, usually 5432>
DB_NAME=<database name>
DB_SSL=true
DB_MIGRATION_USERNAME=<Render's own database username from the URL>
DB_MIGRATION_PASSWORD=<Render's own database password from the URL>
DB_APP_USERNAME=reward_app
DB_APP_PASSWORD=<the password chosen in Step 1>
JWT_PRIVATE_KEY=<see "the JWT keypair gotcha" below>
JWT_PUBLIC_KEY=<see "the JWT keypair gotcha" below>
EOF

export NODE_ENV=production   # see "the NODE_ENV gotcha" below — this line is not optional
npm run db:migrate
```

**Verify:**
```bash
psql "<External Database URL>" -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='reward_portal';"
# Expect 18 tables (at the time of this run).
```

### Two real gotchas hit doing this, worth knowing before you hit them too

**The `NODE_ENV` gotcha — the expensive one.** The migration CLI decides which `.env.*` file to
load based on `process.env.NODE_ENV`, but it reads that *before* your `.env` file (which sets
`NODE_ENV=production` inside itself) has been loaded — chicken and egg. If `NODE_ENV` isn't
already a real, exported shell variable, the CLI defaults to `'development'`, silently loads
`back-end/.env.development` instead (your **local** database's credentials), and happily runs
migrations against your laptop's own Postgres — printing `Applied 0 migration(s)` if your local
DB already had everything applied, which looks exactly like success. It connected, it ran, it
returned 0 errors — it just did all of that against the wrong database entirely. The fix is the
`export NODE_ENV=production` line *before* the `npm run db:migrate` line above, as a real shell
export, not just a line inside the `.env` file. If a migration run against Render ever reports
suspiciously few applied migrations, check `npm run db:status` locally first (with `.env`
temporarily moved aside) to see if it matches — if it does, you just migrated your laptop again.

**The JWT keypair gotcha — the surprising one.** The migration CLI validates the *entire*
environment schema at boot, including `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` — even though a schema
migration never touches a JWT. Generate a real keypair before this step, not a placeholder:
```bash
openssl genrsa -out /tmp/jwt_private.pem 2048
openssl rsa -in /tmp/jwt_private.pem -pubout -out /tmp/jwt_public.pem
```
Paste each PEM's contents into the `.env` file above with real newlines replaced by literal
`\n` (the app un-escapes them at boot — same format `back-end/.env.example` documents). This is
also the real keypair you'll use for the Render API service's own environment variables later —
generating it here isn't wasted effort, it's reused.

---

## Step 4 — Provision encryption keys

**Why:** `portal_users.email` (and a few other columns) are encrypted at rest
(`07-DATA-PROTECTION.md` §3) — the app cannot create, or even look up, a single user until at
least one active `field` key and one active `blind_index` key exist. Nothing seeds this
automatically; it's a deliberate per-environment decision (`T016_001_encryption_keys.ts`'s own
header: *"which kids exist, and which env vars hold them, is a deployment decision"*).

```bash
# Still from portal/back-end/, NODE_ENV=production still exported:
npx ts-node -T -r tsconfig-paths/register src/database/cli/encryption-keys.ts provision field
npx ts-node -T -r tsconfig-paths/register src/database/cli/encryption-keys.ts provision blind_index
```

Each command prints a `NAME=value` line **exactly once** — nothing secret is written to any
file by the command itself. Two things need that value:
1. Append it to the same `.env` file used in Step 3, so Step 5 (below) can use it.
2. Later, add it as an environment variable on the **Render API service itself** (once that
   service exists) — this is what lets the *running, deployed* app decrypt the same data.

**Do this against the real target database only** — never against a database other tasks, test
suites, or people also depend on. `provision` inserts a row that's `active` **forever** (only one
per purpose, by a database constraint) — running it against a shared database once is why
`docs/DEPLOYMENT.md` has an entire section on the incidents this caused during development.

---

## Step 5 — Bootstrap the first Super Admin

**Why:** the portal has no seed data for its first login — someone has to create account #1 by
hand, once, per environment.

```bash
SUPERADMIN_EMAIL=<email> \
SUPERADMIN_NAME="<name>" \
SUPERADMIN_PASSWORD="<a strong password>" \
npm run bootstrap:superadmin
```

Refuses to run if a Super Admin already exists (safe to re-run without duplicating). The created
account carries `must_change_password=true` — the first login is always a forced password
change, by design, not a bug.

**Verify:**
```bash
psql "<External Database URL>" -c \
  "SELECT id, role, status, must_change_password FROM reward_portal.portal_users;"
```

---

## Cleanup — do this every time

```bash
cd portal/back-end
rm -f .env
```

That file held a real database password, a real JWT private key, and real encryption key
material for however long it existed. It was never committed (`.gitignore` excludes every
`.env*` except `.env.example`), but deleting it once the five steps above succeed is still the
right habit — nothing after this point needs it locally again. The Render **API service**'s own
environment variables (set once, in the Render dashboard) are the actual, ongoing home for these
values in the deployed app; this file was only ever a scratch copy to reach that database from a
laptop.

---

## promo-code-service — the `promo_code` schema on this same Render Postgres instance

*(Added by T-167.)* `promo-code-service` is a **separate standalone service**
(`promo-code-service/`, own repo directory, own npm workspace — not part of `portal/`) that
issues promo codes for reward-redemption-service. It deliberately reuses the **same**
`reward-portal-db` Render Postgres instance the five steps above already provisioned — a new
schema (`promo_code`) and a new least-privilege role (`promo_code_app`), never a second database
(`promo-code-service-plan/ARCHITECTURE.md` §4/§5). Do this *after* the five steps above have
already succeeded once against this Render instance — it depends on nothing here, but there is no
reason to run it against a database that isn't itself already live.

Companion reading: `promo-code-service/render.yaml` (this service's own Blueprint — the env var
names below are copied verbatim from its `envVars` list, not invented) and
`promo-code-service-plan/04-API-CONTRACT.md` §3 (the admin API the manual smoke test below calls).

**One thing this section does differently from the five steps above, on purpose:** unlike the
portal's own `reward_app` (a role a human creates by hand, Step 1), `promo_code_app` is created
by promo-code-service's **own migration** (`007_create_promo_code_app_role.ts`), which both
creates the role (if missing) and sets its login password to whatever `DB_APP_PASSWORD` holds at
migrate time — not a placeholder the running app merely reads. There is no separate manual
`CREATE ROLE` `psql` command to run here; setting the env var and running `db:migrate` *is* the
step. (This was confirmed by reading that migration file directly before writing this section —
worth calling out because it is easy to assume, by analogy with Step 1 above, that a manual
`CREATE ROLE` command belongs here too. It doesn't.)

### Step A — choose `DB_APP_PASSWORD` and run promo-code-service's own migrations

```bash
# From the git repo root, into promo-code-service's own directory:
cd promo-code-service

cat > .env <<EOF
NODE_ENV=production
DB_HOST=<host from reward-portal-db's own External Database URL — same value the portal used>
DB_PORT=<port, usually 5432>
DB_NAME=<database name — same one the portal used>
DB_SSL=true
DB_MIGRATION_USERNAME=<Render's own database username — same value the portal used>
DB_MIGRATION_PASSWORD=<Render's own database password — same value the portal used>
DB_APP_USERNAME=promo_code_app
DB_APP_PASSWORD=<choose a strong password — this is what 007_create_promo_code_app_role.ts uses
                  to create/alter the role, not just a value the app reads later>
KAFKA_BROKERS=<a reachable broker list — this Blueprint provisions no Kafka cluster of its own,
                see promo-code-service/render.yaml's own header>
EOF

export NODE_ENV=production   # the identical chicken-and-egg gotcha the portal's own Step 3
                              # documents — promo-code-service/src/database/cli/migrate.ts reads
                              # process.env.NODE_ENV *before* this .env file is loaded, the same
                              # way the portal's migration CLI does. Skip this export and it
                              # silently migrates your own laptop's local Postgres instead,
                              # printing a success message for the wrong database.
npm run db:migrate
```

**Verify:**
```bash
psql "<reward-portal-db's own External Database URL>" -c \
  "SELECT rolname FROM pg_roles WHERE rolname = 'promo_code_app';"
psql "<reward-portal-db's own External Database URL>" -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='promo_code';"
# Expect the role to exist and every table promo-code-service's migrations create (check
# ls promo-code-service/src/database/migrations/*.ts for the current count — treat it as a
# floor, not a fact, the same caveat Step 3 above gives for the portal's own migration count).
```

### Step B — wire the two Render services to each other

**Corrected (T-167 retry) — neither of these exists as a `sync: false` placeholder in
`portal/render.yaml` today.** `promo-code-service/render.yaml` (`promo-code-service-plan`
T-PC-050) does declare `INTERNAL_SERVICE_TOKEN` as `sync: false` on its own side, but
`portal/render.yaml`'s API service `envVars` list only has `DB_*`, `JWT_*`, `TRUST_PROXY` and
(on the web service) `API_UPSTREAM_HOST` — grep it yourself before trusting this sentence:
`grep -n "PROMO_CODE_SERVICE" portal/render.yaml` currently returns nothing. Until a human adds
the two entries below to `portal/render.yaml`'s API service `envVars` block (the same shape as
the existing `DB_APP_PASSWORD`/`JWT_PRIVATE_KEY` `sync: false` lines already there), Render's
dashboard has no field for them at all — you cannot "just set" a value that isn't declared.
Add these two blocks to `portal/render.yaml` first, `git commit` them (they are placeholders,
not secrets — R4 is about committed *values*, not committed *keys*), redeploy/re-sync the
Blueprint so Render picks up the new declared vars, **then** set the actual values by hand in
each service's own Render dashboard, exactly like `DB_APP_PASSWORD`/`JWT_PRIVATE_KEY` already are
for the portal (Step 3 above):

```yaml
      # promo-code-service integration (T-166) — see portal/docs/RENDER-DB-MIGRATION.md's
      # "promo-code-service" section, Step B, for what these must be set to.
      - key: PROMO_CODE_SERVICE_BASE_URL
        sync: false
      - key: PROMO_CODE_SERVICE_INTERNAL_TOKEN
        sync: false
```

- **`PROMO_CODE_SERVICE_BASE_URL`** (portal API service's env) → promo-code-service's real Render
  service hostname, once that service has been deployed from its own `render.yaml`
  (`promo-code-service-plan` T-PC-050). Bare `https://<hostname>`, no trailing slash — the same
  shape `.env.development`'s local value (`http://localhost:3010`) already takes.
- **`PROMO_CODE_SERVICE_INTERNAL_TOKEN`** (portal API service's env) and **`INTERNAL_SERVICE_TOKEN`**
  (promo-code-service's own env) → generate one strong random secret, set it identically on
  **both** services' Render dashboards. Every route on promo-code-service's admin/config API is
  guarded by `InternalServiceTokenGuard`, which checks this exact value — a mismatch here fails
  every call from the portal with a `401` that the portal itself then reports as a `502`
  (`FIELD_API_LOOKUP_UPSTREAM_ERROR`/`PROMO_CODE_SERVICE_BIND_FAILED`), not as an auth error, so a
  copy/paste mistake here is easy to misdiagnose as "the service is down" when it is not.

### Step C — activate the portal's own promo-code integration

Both of these are the portal's own migration/manual-step pair (T-165), run here against the
**Render** database now that it exists, exactly as Step 3/Step 4 above ran the portal's core
migrations and encryption-key provisioning:

```bash
# From portal/back-end/, the same throwaway .env this file's Step 3 already describes,
# NODE_ENV=production still exported:
npm run db:migrate
```

This applies `T165_001_activate_promo_code_config_service_provider.ts` along with every other
pending portal migration — safe to run repeatedly (idempotent), and correct whether this is a
brand-new Render deploy or one that already has the portal's core schema from the five steps
above.

Then, as a real `super_admin` (real MFA, T-055) against the **live Render-hosted portal API**:

```bash
# id = the field_api_lookup_providers row for PROMO_CODE_CONFIG_SERVICE — find it first:
curl -s https://<portal Render hostname>/api/v1/field-api-lookup-providers \
  -H "Cookie: <a real super_admin session cookie jar>" | python3 -m json.tool

curl -s -X PATCH https://<portal Render hostname>/api/v1/field-api-lookup-providers/<id> \
  -H "Cookie: <the same session cookie jar>" \
  -H "X-CSRF-Token: <the matching rs_csrf cookie value>" \
  -H "Content-Type: application/json" \
  -d '{"authConfig": {"token": "<the exact same value as INTERNAL_SERVICE_TOKEN/
                                 PROMO_CODE_SERVICE_INTERNAL_TOKEN from Step B above>"}}'
```

T-165's own implementation note 3 explains why this cannot be part of any migration:
`FieldCryptoService` needs the running application's key registry, which a migration-CLI context
structurally does not have. T-162's "Value Sources" screen (Super Admin, Wave 8) calls this exact
endpoint and can be used instead of the raw `curl` above.

### Step D — smoke test

```bash
curl -s https://<portal Render hostname>/api/v1/field-value-sources/api/PROMO_CODE_CONFIG_SERVICE \
  -H "Cookie: <any authenticated role's session cookie jar>"
```

**Resolved (T-172, `done`) — kept here for history, not a current gap.** Between this section
first being written and T-167 completing, this exact call briefly returned `502
FIELD_API_LOOKUP_UPSTREAM_ERROR` even with Steps A–C done correctly, because
`FieldValueSourceLookupService.apiLookup()`
(`portal/back-end/src/modules/field-value-sources/field-value-source-lookup.service.ts`) called
the provider's stored `endpoint_url` with no query parameters at all, while promo-code-service's
own `GET /api/v1/promo-code-configs` requires a `tenantId` query parameter by design (its list is
tenant-scoped, not global). T-172 fixed this: the caller's own verified `tenantId` (from the JWT,
never client-supplied — R3) is now appended as `?tenantId=` on every generic field-api-lookup-
provider call. Re-verified live, T-167, against a real running promo-code-service and a real
Maker session, after T-172 landed: this smoke test now returns a bare JSON array of
`{value, label}` options — real promo-code-service data, not an error. **The bind path was never
affected either way** — a Maker attaching a `PROMO_CODE` reward once they already have a config id
has worked end to end since T-166 (re-verified live again here too, including the fail-closed
`502`-then-retry sequence with promo-code-service stopped and restarted). If this smoke test still
`502`s against a real Render deploy, treat it as a genuine regression or a Steps A–C
misconfiguration, not this historical gap resurfacing.

## What "the database structure is up to date" actually means going forward

`reward_config_postgres.sql` will not change again unless the upstream, real corporate schema
changes — it's a fixed historical snapshot. Every future schema change to *this* project ships
as a new file under `back-end/src/database/migrations/`, and the only thing that keeps a
database (local, Render, or any future environment) current is running `npm run db:migrate`
again after pulling new code. There is no single "latest schema.sql" file to re-download instead
— the migrations directory, applied in order, *is* the current schema, by construction.
