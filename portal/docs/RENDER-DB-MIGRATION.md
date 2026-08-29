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

## What "the database structure is up to date" actually means going forward

`reward_config_postgres.sql` will not change again unless the upstream, real corporate schema
changes — it's a fixed historical snapshot. Every future schema change to *this* project ships
as a new file under `back-end/src/database/migrations/`, and the only thing that keeps a
database (local, Render, or any future environment) current is running `npm run db:migrate`
again after pulling new code. There is no single "latest schema.sql" file to re-download instead
— the migrations directory, applied in order, *is* the current schema, by construction.
