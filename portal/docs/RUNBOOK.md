# Runbook

**Owner:** T-052 (`agent-qa`). Covers the operations a support engineer or on-call operator
will actually need against a running deployment — not a design document; every command below
is the real one, checked against this codebase's real routes, columns and CLI entry points
while this file was written (see each procedure's own "Verified against" line).

**Every procedure here is a privileged, audited action.** None of it is self-service. Whoever
runs a database command below needs a role with the same grants `reward_app` already has at
runtime for that table (this is normal application behaviour reproduced by hand, not a new
privilege) — never the migration/superuser role for anything in this file except the migration
rollback procedure, which needs it by definition.

---

## 1. Unlock a locked account

**Symptom:** a user reports `AUTH_INVALID_CREDENTIALS` on a password they are sure is correct.
**Cause:** `portal_user_credentials.locked_until` is in the future — 5 consecutive failed
attempts locks for 15 minutes, exponential on repeat (`02-SECURITY.md` §2).

**There is no admin endpoint for this today** — confirmed by inspecting every route
`back-end/src/modules/users/**` and `back-end/src/modules/auth/**` register; the only way back
in currently is to wait out `locked_until`, or clear it directly:

```sql
-- Verified against 01-DATABASE.md §2.2's own DDL for portal_user_credentials.
SELECT u.email, c.failed_attempts, c.locked_until
FROM reward_portal.portal_user_credentials c
JOIN reward_portal.portal_users u ON u.id = c.user_id
WHERE lower(u.email) = lower('user@example.com');

UPDATE reward_portal.portal_user_credentials
SET failed_attempts = 0, locked_until = NULL
WHERE user_id = (
  SELECT id FROM reward_portal.portal_users WHERE lower(email) = lower('user@example.com')
);
```

The account is usable again immediately — nothing else caches lockout state. **This is worth
filing as a proper admin action** (a `POST /users/:id/unlock` alongside the existing
`POST /users/:id/deactivate`/`POST /users/:id/reset-password`) rather than a permanent SQL
runbook step; not this task's file scope to add (`back-end/src/modules/users/**` belongs to
T-035), noted here rather than silently worked around forever.

---

## 2. Revoke a session

**Two different operations answer to this name — pick the one that matches what actually
happened:**

### 2a. Force a user out of every device right now, and stop them logging back in

This is `POST /users/:id/deactivate` (`03-API-CONTRACT.md` §7) — it sets `status = 'inactive'`
and revokes every active session for that user in the same transaction
(`UsersService.deactivate` → `SessionService.revokeAllForUser`, `back-end/src/modules/users/`).
Requires the `user:update` permission. **There is currently no reactivate endpoint**
(`UpdateUserDto` only accepts `displayName`) — undoing this needs the same direct-SQL path
`portal_users.status` back to `'active'`, another real gap worth its own task rather than a
permanent runbook step.

### 2b. Force out one compromised/suspicious session, leave the account itself alone

No narrower endpoint exists for this either. Direct SQL, scoped to the one session (find its
id from `portal_sessions` by `user_id` + `ip_address`/`user_agent`/`last_seen_at`, or from a
`portal_audit_log`/`campaign_audit_trail` row's `correlation_id` via `GET
/audit/trace/:correlationId`, §5 below):

```sql
-- Verified against 01-DATABASE.md §2.3.
UPDATE reward_portal.portal_sessions
SET status = 'revoked', revoked_at = now(), revoked_reason = 'support_revoke'
WHERE id = '<session-uuid>' AND status = 'active';
```

`SessionValidGuard` checks this on every request (`01-DATABASE.md` §2.3), so the next request
on that session — not the next access-token expiry, immediately — gets `401
AUTH_SESSION_INVALID`. The still-issued refresh token is useless too:
`portal_refresh_tokens.session_id` no longer resolves to an active session.

---

## 3. Rotate JWT signing keys

There is one RS256 keypair (`JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY`, `env.schema.ts`), no `kid`
rotation scheme, no JWKS endpoint. Rotating is a full key swap, not a gradual one:

```bash
openssl genrsa -out /tmp/jwt_private_new.pem 2048
openssl rsa -in /tmp/jwt_private_new.pem -pubout -out /tmp/jwt_public_new.pem
# paste each PEM into JWT_PRIVATE_KEY/JWT_PUBLIC_KEY with literal \n in place of real
# newlines (token.service.ts un-escapes them at boot — same format .env.example documents),
# update the running environment/secret manager, then restart every API instance.
```

**What this does and does not break**, verified by reading `token.service.ts` and
`session.service.ts` together:

- Every **access token** signed under the old key fails `jwt.verify` the moment the new key is
  live — the very next request on it gets `401`.
- The **refresh token** is an opaque, randomly generated value stored hashed
  (`portal_refresh_tokens.token_hash`, T-011 note 4) — it does not depend on the RS256 keypair
  at all, so it is **not** invalidated by this rotation.
- `front-end/src/lib/apiClient.ts`'s single-flight 401-refresh interceptor means a logged-in
  user notices nothing: their next request 401s, the client transparently calls
  `POST /auth/refresh`, gets a new access token signed under the new key, and retries. **No
  forced logout, no user-visible interruption**, for anyone whose refresh token is still valid
  (T-011's own TTL) at the moment of rotation.
- Rotate because of a suspected leaked private key, not routine hygiene alone: a leaked
  private key can forge access tokens (bypassing login and MFA both) until this rotation
  happens, so treat it as urgent, not scheduled maintenance.

---

## 4. Restore access if every Super Admin is locked out

**The supported path — at least one `super_admin` can still log in, only their MFA is the
problem:** any other `super_admin`, once authenticated with **their own** MFA
(`MfaRequiredGuard`), calls:

```
POST /api/v1/admin/access-control/super-admins/:id/mfa-reset
```

(`mfa-admin.controller.ts`, T-055). This clears the locked-out admin's MFA seed, invalidates
their recovery codes, and revokes their sessions — they log in again with password only and
re-enrol MFA. `MfaService.resetByAdmin` refuses self-reset and audits both actor and target
ids, by design (that file's own header) — there is no way around needing a *second*, MFA-
satisfied Super Admin for this path, on purpose: a self-service MFA bypass would be a second,
weaker authentication path around the factor the whole feature exists to add.

**If literally every Super Admin account is inaccessible** (all locked, or all have lost both
device and recovery codes) — **there is no application-level break-glass for this today.**
`bootstrap-superadmin` (`back-end/src/cli/bootstrap-superadmin.ts`) explicitly refuses to run
if one already exists (`docs/DEPLOYMENT.md` "Bootstrap the first Super Admin"), so it cannot be
rerun to mint a fresh one. The only real path is privileged, audited direct SQL, run by
whoever holds the migration-role database credentials:

```sql
-- Unlock the account (§1 above) and/or clear MFA on ONE existing super_admin row so they can
-- log in with password alone and re-enrol:
UPDATE reward_portal.portal_users
SET mfa_enabled = false, mfa_secret_enc = NULL
WHERE id = <super_admin_user_id>;

DELETE FROM reward_portal.portal_mfa_recovery_codes WHERE user_id = <super_admin_user_id>;
```

Log this action outside the database too (an incident ticket, at minimum) — it bypasses the
one control `02-SECURITY.md`'s AR-08 review added specifically because a Super Admin account
is the highest-value target in this system. **A real break-glass procedure (a signed, offline
recovery mechanism, or a documented multi-party process) is a genuine gap, not a design
choice** — worth its own task; this runbook records the honest current state, not a
recommendation to rely on ad hoc SQL as a permanent answer.

---

## 5. Read the audit log

Three surfaces, by what you're looking for:

| Question | Endpoint | Restricted to |
|---|---|---|
| "What happened on this one request?" (given a `traceId`/`correlationId` from an error toast or a support ticket) | `GET /api/v1/audit/trace/:correlationId` | `super_admin` |
| Campaign/domain changes (approvals, publishes, blasts — `campaign_audit_trail`) | `GET /api/v1/audit/campaigns` (`.../export` for CSV) | `audit:view` permission |
| Auth/access-control events (`portal_audit_log` — logins, permission denials, nav/widget config changes) | `GET /api/v1/audit/portal` (`.../export` for CSV) | `super_admin` |

The first row is the one worth remembering: **`traceId` in an error response is the
`correlation_id` (08-OBSERVABILITY.md §2), deliberately** — a user reporting "it said error
b7f3…" hands you the exact key `GET /audit/trace/:correlationId` needs, and that one call
assembles the request's log lines, `portal_audit_log` rows and `campaign_audit_trail` rows
together (T-045).

Direct SQL, if the endpoints above are themselves unreachable (the incident *is* the API being
down):

```sql
SELECT * FROM reward_portal.portal_audit_log
WHERE occurred_at > now() - interval '1 hour'
ORDER BY occurred_at DESC LIMIT 100;

SELECT * FROM reward_config.campaign_audit_trail
WHERE performed_at > now() - interval '1 hour'
ORDER BY performed_at DESC LIMIT 100;
```

`campaign_audit_trail`'s timestamp column is `performed_at`, not `occurred_at` — that name
belongs to `portal_audit_log` only (`01-DATABASE.md`; `database/reward_config_postgres.sql`'s
own DDL confirms `performed_at` for `campaign_audit_trail`). Don't copy-paste the first query's
column name into the second without checking each table's own DDL — this exact mistake was
caught live during T-052's own review (a support engineer following this section during a real
incident would otherwise hit a bare Postgres error).

Both tables are append-only to `reward_app` (`REVOKE UPDATE, DELETE`, `01-DATABASE.md` §3) —
a `SELECT` here can never be the action that damages the record you're trying to read.

---

## 6. Roll back a migration

```bash
cd back-end
npm run db:rollback              # the single most recent migration
npm run db:rollback -- --all     # every migration, back to nothing (T-002's own rehearsal:
                                  # migrate -> rollback -> migrate, twice over)
```

Runs against `DB_MIGRATION_*` (the privileged role, never `reward_app`) — same as
`db:migrate`. Every migration in this codebase is required to have a working `down()`
(AGENT-PROTOCOL R7); if one doesn't, that is a bug in that migration, not something this
runbook can work around.

**Inside a container** (docker-compose or otherwise), there is no dev-dependency-free way to
run this today — `npm run db:rollback` needs `ts-node`, which the shipped `runtime` image
deliberately excludes (TC-15). Use the same `migrator` build target
`docker-compose.yml`'s own `migrate` service uses:

```bash
docker compose run --rm migrate npx ts-node -T -r tsconfig-paths/register \
  src/database/cli/migrate.ts down
```

(See `docs/DEPLOYMENT.md`'s "A defect this compose file works around" for why the compiled
`dist/database/cli/migrate.js` form silently does nothing instead of rolling back — the same
bug, T-079, affects `down` exactly as it affects `up`.)

---

## 7. Audit-trail archival — the purge process this task records, does not build

**08-OBSERVABILITY.md §7.1 (architect review AR-14) is explicit that this is T-052's job to
document, not automate:** `campaign_audit_trail` and `portal_audit_log` are append-only by
design — `REVOKE DELETE FROM reward_app` (`01-DATABASE.md` §3) — so **nothing running as the
application's own runtime role can ever purge a row**, including past its 7-year retention
(`retention_expires_at`). That is correct for tamper-resistance during the retention window; it
also means the purge is necessarily an operation performed by a role outside `reward_app`'s own
grants, run on a schedule, by a named owner. This section names that operation; it is a
scheduled DBA job, never application code.

### 7.1 Row-count projection (7-year horizon)

**No tenant-count or change-frequency target is committed anywhere in this project** — not in
`00-ARCHITECTURE.md`, not in `BACKLOG.md`, not in any task file (checked while writing this
section). The numbers below are therefore an illustrative worked projection using assumed
figures, stated as assumptions, not a capacity plan — replace the two inputs with real business
numbers from product/infrastructure before treating the output as a real target.

| Input (assumed, not committed) | Value |
|---|---|
| Tenants at steady state | 200 |
| Countries | 15 |
| Campaign audit events per tenant per day (create, submit, approve/reject, publish, pause/resume, blast) | ~15 |
| Portal audit events per tenant per day (logins, permission checks logged at `warn`+, config changes) | ~40 |

```
campaign_audit_trail:  200 tenants x 15 events/day x 365 days x 7 years  ≈  7.7 million rows
portal_audit_log:      200 tenants x 40 events/day x 365 days x 7 years  ≈ 20.4 million rows
```

**~28 million rows combined over 7 years, under these assumed inputs.** That is well within
what a single unpartitioned Postgres table handles comfortably for `INSERT`/indexed-lookup
workloads (both tables' own indexes are already scoped to the query patterns §5 above uses —
`ix_pal_event_time`, `ix_pal_actor_time`, and `campaign_audit_trail`'s existing indexes) — date-
range partitioning is **not required before go-live** at this scale. Revisit this projection,
not just the purge job below, the moment either input is 5-10x this assumption (a
materially larger tenant base, or a much higher per-tenant event rate than assumed here) — the
threshold where partitioning starts paying for its own operational complexity is exactly that
order of magnitude, not this one.

### 7.2 The purge job itself

**Owner: the DBA/infrastructure role responsible for this deployment's Postgres instance** — no
individual or team is named anywhere else in this project's docs, which is itself a gap worth
raising at the same time as this runbook (see `docs/DEPLOYMENT.md`'s backup/DR section for the
same "no infrastructure owner named" gap, filed once rather than twice).

**Schedule:** monthly, off-peak. Both tables have an indexed timestamp column suited to a
bounded delete (`portal_audit_log.occurred_at`; `campaign_audit_trail.retention_expires_at`,
computed from its own `performed_at` at insert time — see the query below, not `occurred_at`,
which that table does not have), so a monthly cadence keeps each run small regardless of the
volume in §7.1.

**Runs as a role that is not `reward_app`** — a separate, narrowly-scoped role
(`reward_audit_purge`, or whatever this deployment's own naming convention is) granted `DELETE`
on exactly these two tables and nothing else, created and run the same deliberate way the
migration role is kept separate from the app role (`01-DATABASE.md` §3, T-002 note 6). **Never**
add this `DELETE` grant to `reward_app` — that would reopen the exact tamper-resistance
`REVOKE DELETE` exists for, for the sake of a job that runs once a month.

```sql
-- Run by the dedicated purge role, scheduled (cron / a DBA-managed job runner), never by the
-- application process:
DELETE FROM reward_config.campaign_audit_trail WHERE retention_expires_at < now();
DELETE FROM reward_portal.portal_audit_log
WHERE occurred_at < now() - interval '7 years';
-- portal_audit_log has no retention_expires_at column of its own (01-DATABASE.md §2.5) — the
-- 7-year figure is applied directly to occurred_at, matching the retention 08-OBSERVABILITY.md
-- §7 states for it.
```

Verify row counts before and after each run land in whatever this deployment's own operational
logging covers (outside this application's scope) — a purge job that silently deletes 0 rows
every month for a year is the same "looks fine, isn't" failure mode `docs/DEPLOYMENT.md`'s
T-079 section describes for the migration CLI, and deserves the same suspicion.

---

## 8. Graceful shutdown

`SIGTERM`/`SIGINT` (`app.enableShutdownHooks()`, `main.ts`, T-019) drains in-flight requests,
closes the Sequelize pool (`DatabaseModule.onModuleDestroy`) and closes the metrics listener
(`MetricsServerService.onApplicationShutdown`) before the process exits. Verified live: `docker
compose stop -t 10 api` against a running stack exits cleanly well inside the 10-second grace
period, with the in-flight request's own "request completed" log line written before the
container reports stopped — nothing is silently dropped mid-response.
