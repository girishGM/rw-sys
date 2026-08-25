# Handover

**Audience:** the engineering team taking this system over — reading this once, end to end,
should be enough to make a first change safely. Where this document gives a procedure (§4), it
was walked through for real against the live system while writing it, not written from reading
the code alone — see each procedure's own "Verified live" note.

---

## 1. What this system is

A multi-country, multi-tenant, multi-merchant web portal that governs reward-campaign
configuration for the existing `reward_config` database — the portal does not own the reward
domain (rules, rewards, campaigns), it owns **who may configure it and how changes are
governed**: identity, access control, the country → tenant → merchant onboarding hierarchy,
maker/checker approval, and full audit. Full design baseline:
`project-plan/00-ARCHITECTURE.md` (read this first if you read nothing else — every other
design doc hangs off it).

## 2. The `reward_portal` vs `reward_config` split — and why it exists

Two schemas, one database:

- **`reward_config`** — the pre-existing, live schema other services already read and write
  (60 tables at initial analysis, 62 as of the portal's own start; the `create-campaign*`
  agents in this repository's parent directory use it too). The portal treats it as **mostly
  read/write through its own tables, additive-only at the DDL level** — `CLAUDE.md`'s
  constraint C1: no `DROP TABLE`/`DROP COLUMN`/type changes/tightened `CHECK`s, ever. Exactly
  two non-additive exceptions are authorised project-wide (`ALTER ... DROP NOT NULL` on
  `rule_master.tenant_id` and `reward_systems.tenant_id`, constraint C2) — nothing else.
- **`reward_portal`** — a brand-new schema, wholly owned by this project: identity
  (`portal_users`), credentials, sessions, refresh tokens, login attempts, password resets, MFA
  recovery codes, and the portal's own audit log. Nothing outside the portal reads or writes it.

**Why split it this way**, in order of how much it matters day to day:

1. **`reward_config.admin_users` genuinely cannot represent this system's roles** — its `role`
   CHECK only permits four of the six roles this portal needs (no `maker`/`checker`), it has no
   credential column at all, and `api_key_id` is `NOT NULL UNIQUE`, which cannot represent a
   Super Admin or Country Admin who belongs to no tenant. Extending that table would mean
   loosening constraints another live service may depend on. `portal_users` sidesteps all three
   problems by being a new table, not a patched one. See `docs/KNOWN-LIMITATIONS.md` §1 for the
   operational consequence of this split (two identity tables, not reconciled).
2. **Blast radius.** A portal migration can never lock or corrupt a table a live campaign
   service reads, because it only ever touches its own schema (plus the two authorised
   `ALTER`s).
3. **Grant separation, enforced by Postgres itself, not just application code.** The runtime
   role (`reward_app`) has `ALL` on `reward_portal` but only an explicit, hand-maintained list
   of `SELECT`/`INSERT`/`UPDATE` grants on specific `reward_config` tables
   (`back-end/src/database/migrations/T002_008_grants.ts`). **This list has not been kept up to
   date as later waves added tables — see §6 "Open, urgent" below; do not assume a new
   `reward_config` table is reachable until you've checked this file.**

One `reward_config` table genuinely does hold portal-relevant, versioned domain data rather
than portal-private state: the rule/reward versioning and blast-distribution tables (T-005,
`06-VERSIONING.md`) live in `reward_config`, deliberately, because other services are expected
to read them (a global rule with `tenant_id IS NULL` is resolved by version assignment, not by
tenant — see `docs/KNOWN-LIMITATIONS.md` §6 for the cross-service consequence of that).

## 3. Where the six roles are enforced

Six roles, one strict delegation chain (`00-ARCHITECTURE.md` §5):

```
super_admin (global) → country_admin (one country) → tenant_admin (one tenant)
                                                            ├→ maker (tenant-scoped)
                                                            ├→ checker (tenant-scoped)
                                                            └→ merchant (one merchant only)
```

Every authenticated request passes through a fixed guard chain, in this order, composed once in
`back-end/src/app.module.ts` — **do not reorder it**:

```
Helmet → CORS → RateLimitGuard → CsrfGuard → JwtAuthGuard → SessionValidGuard
  → RolesGuard → PermissionsGuard → TenancyScopeInterceptor
  → Controller → Service → Repository → AuditInterceptor → ErrorNormalizationFilter
```

Three of those matter most when you're adding something new:

- **`RolesGuard` + `@Roles(...)`** — a small number of routes (e.g. the trace viewer,
  `back-end/src/modules/trace/trace.controller.ts`) are gated on the literal role name, because
  they are not something Super Admin should be able to hand to another role via configuration
  (see `trace.controller.ts`'s own header for why). This is the exception, not the pattern.
- **`PermissionsGuard` + `@RequirePermission(entity, action)`** — the normal pattern. It checks
  the caller's role against `reward_config.role_entity_permissions` (cached — see §4.3 below).
  **This is the control that actually blocks a request.** A hidden menu item with no matching
  permission row blocks nothing on its own — `00-ARCHITECTURE.md` §7 is explicit that "hiding a
  link never stands alone as a control."
- **`TenancyScopeInterceptor`** — every repository read/write is scoped by a `country_id`/
  `tenant_id`/`merchant_id` triple taken **only** from the verified JWT, via
  `ScopedRepository` (never a raw `Model.findAll`/`findOne`/`update`/`destroy` — a lint rule
  enforces this, R2). A missing scope context is a hard `500`, never a silent full-table query.

On the front end, the same shape is mirrored, not re-decided: `<RequirePermission entity
action>` (`front-end/src/auth/RequirePermission.tsx`) wraps a route, reading the same
`entity`/`action` pair from the one `GET /me/bootstrap` call every session makes on login. The
front end has **no hard-coded menu and no hard-coded dashboard layout** — see §4 for how that
data gets there.

## 4. How Super Admin's configurability actually works, and how to extend it

`GET /me/bootstrap` returns four things a Super Admin controls entirely through data, no
deployment required: `nav`, `permissions`, `widgets`, and `messages`. Each is driven by one
`reward_config` table (`role_nav_configs`, `role_entity_permissions`, `role_dashboard_widgets`,
`system_messages`), all editable live through **Access Control**
(`docs/screenshots/18-access-control-nav.png`, `.../19-access-control-permissions.png`).

**Every procedure below was run for real, live, against the running docker-compose stack, while
writing this document** — inserting the row, logging in fresh, and confirming the result in the
actual `GET /me/bootstrap` response and the actual rendered screen. That is what TC-6/7/8 ask
for, and it is also just good practice: an extension point nobody has walked through is usually
wrong.

### 4.1 Add a new nav item

1. Add a migration (task-id-prefixed, e.g. `T0NN_00N_seed_my_feature_nav.ts` — never edit an
   already-applied migration; see `T042_002_seed_definition_request_nav.ts` for the exact
   pattern to copy) that inserts one row per role that should see it:

   ```sql
   INSERT INTO reward_config.role_nav_configs (role, nav_key, label, path, sort_order)
   VALUES ('super_admin', 'my_feature', 'My Feature', '/my-feature', 70)
   ON CONFLICT (role, nav_key) DO NOTHING;
   ```

   `nav_key` is the natural key (used again in `down()` to delete exactly these rows, never a
   Super Admin's own later edits). `sort_order` decides position in the menu.

2. Add the matching front-end route in `front-end/src/app/router.tsx`'s
   `PROTECTED_ROUTE_SPECS` array, with the same `path`, and an `entity`/`action` pair if the
   screen should also be permission-gated (§4.2) — a route with no entity is reachable by any
   authenticated session, same as `/dashboard`.

3. Migrate. **Verified live:** inserting exactly the row above (`role='super_admin'`,
   `nav_key='handover_test_item'`) directly into a running database, then logging in fresh, put
   "Handover Test Item" straight into the left-hand menu and into the raw `GET /me/bootstrap`
   response — no code change, no restart needed for a **new** role/key that no session has ever
   cached (see the caching note in §4.3 — this only matters if you're adding to a role that
   already has an active, warm cache).

### 4.2 Add a new permission entity

1. Pick an entity name (lower-case, singular, matches what you'll pass to
   `@RequirePermission(...)` — see `definition-requests.constants.ts`'s
   `DEFINITION_REQUEST_ENTITY` for the pattern).
2. Migration, same shape as `T042_001_seed_definition_request_permissions.ts`:

   ```sql
   INSERT INTO reward_config.role_entity_permissions (role, entity, actions)
   VALUES ('super_admin', 'my_feature', '["view","create"]')
   ON CONFLICT (role, entity) DO NOTHING;
   ```

   Only grant the roles that should actually have it — a role with no row for an entity has no
   access to it at all, not an empty-actions row.
3. In the controller, decorate every route with `@RequirePermission(MY_FEATURE_ENTITY, action)`
   — this is what a database misconfiguration cannot bypass. For anything as sensitive as rule/
   reward authorship, add a **second**, hard-coded assertion in the service layer too
   (`RuleService.create()`'s `actor.role === 'super_admin'` check is the model for this —
   `00-ARCHITECTURE.md` §5.2's three independent layers).
4. On the front end, wrap the route with `<RequirePermission entity="my_feature" action="view">`
   and add the same `entity`/`action` to its `PROTECTED_ROUTE_SPECS` row.
5. **Verified live**, with one real, load-bearing catch: a direct-SQL insert into
   `role_entity_permissions` for a role that already has an active session **did not** appear in
   that session's next `/me/bootstrap` call until `rbac_cache_config`'s
   `rbac_version:<role>` row was bumped — `PermissionCacheService` caches the permission matrix
   in memory per API instance, keyed by that version number specifically (nav/widget reads are
   not cached the same way, which is why §4.1/§4.3's inserts appeared immediately with no bump
   needed). Confirmed directly: the new permission was invisible to a fresh login until
   `UPDATE reward_config.rbac_cache_config SET config_value = config_value + 1 WHERE config_key
   = 'rbac_version:super_admin'` ran, after which the very next bootstrap call included it. **On
   a genuinely fresh deployment** (migration runs before the app ever serves traffic) this never
   matters — there is no warm cache yet. It matters the moment you add a permission via a
   migration against an **already-running** system (a rolling deploy, or a support fix applied
   by hand) — bump the version, or restart the affected API instances, or the change will
   silently not take effect for anyone already logged in.

### 4.3 Add a new dashboard widget

1. Pick a `widget_key` (convention: `kpi_*`, `chart_*`, or `list_*` — see
   `front-end/src/features/dashboard/widgetRegistry.ts`'s three categories).
2. Migration, same shape as `T004_003_seed_role_dashboard_widgets.ts`:

   ```sql
   INSERT INTO reward_config.role_dashboard_widgets (role, widget_key, label, sort_order)
   VALUES ('super_admin', 'kpi_my_feature', 'My Feature', 80)
   ON CONFLICT (role, widget_key) DO NOTHING;
   ```

3. Register the key in `front-end/src/features/dashboard/widgetRegistry.ts` — **append a line,
   never restructure the file** (05-EXECUTION-PLAN §3 calls this an append-only registration
   point deliberately, for exactly the reason a growing list of unrelated feature teams add to
   it over time). `createKpiWidget`/`createChartWidget`/`createListWidget` each take the
   `widget_key` and render `null` if the registry has nothing for it, so an unregistered key
   fails safe, not loudly.
4. **This step was broken for most of Wave 4, and is the reason `docs/KNOWN-LIMITATIONS.md` §8
   exists (now resolved, but read this if a future widget's data mysteriously 404s):** every
   widget's data comes from one generic route, `GET /dashboard/widgets/:widgetKey`
   (`front-end/src/features/dashboard/widgets/api.ts`). For most of Wave 4, **no back-end
   module implemented this route at all** — filed as T-092, critical, blocking, now `done`. The
   route now lives in `back-end/src/modules/dashboard/**`, with one resolver per already-seeded
   `widget_key` — copy that module's existing resolver pattern for a new `widget_key`, do not
   build a new mechanism.
5. **Verified live**, twice, in two different sessions: first that the *registration* step
   (this section, steps 1–3) works uncached, same as nav — inserting the
   `role_dashboard_widgets` row above made "Handover Test Widget" appear as a tile in the grid on
   the very next login; and second, after T-092 landed, that the *data* route itself now serves
   real data. **The second check caught something the first one couldn't have**: the
   long-running `docker-compose.yml` stack used for this document's own screenshots was still
   running container images built *before* T-092's fix landed, so it kept showing the old error
   tiles even after T-092's own task report said "done" — `docker compose build api web &&
   docker compose up -d --no-deps api web` was required before the fix was actually visible.
   **A code fix landing and a long-lived environment actually running it are two different
   facts; do not assume the second from the first without a rebuild/redeploy**
   (`docs/DEPLOYMENT.md`, `docs/RUNBOOK.md`). All six roles' dashboards were re-screenshotted
   after the rebuild and show real data now.

## 5. Gap analysis (G1–G8) — what `reward_config` didn't give us, and what closed each gap

From `00-ARCHITECTURE.md` §3.2, reproduced here with what was actually built:

| # | Gap | Closed by |
|---|---|---|
| G1 | `admin_users.role` cannot store `maker`/`checker` | `portal_users`, a new table permitting all six roles (§2 above) |
| G2 | `admin_users` has no credential column | `portal_user_credentials` — Argon2id, T-010 |
| G3 | `admin_users.api_key_id` is `NOT NULL UNIQUE`, so a tenant-less role can't be represented | `portal_users.tenant_id` is nullable, no api-key coupling |
| G4 | No session/refresh-token/login-attempt table anywhere | `portal_sessions`, `portal_refresh_tokens`, `portal_login_attempts` — T-011 |
| G5 | `tenant_campaigns.created_by` (`varchar`) vs `approval_requests.requested_by` (`int`) — inconsistent actor typing | `ActorRef` helper (`back-end/src/modules/campaigns/actor-ref.ts`) — the **only** place permitted to decide the representation; see `docs/KNOWN-LIMITATIONS.md` §2 |
| G6 | `rule_master`/`reward_systems` `.tenant_id` were `NOT NULL`, contradicting Super-Admin-owned global rules | The two authorised `DROP NOT NULL` migrations (T002_009) |
| G7 | No seed data for `role_nav_configs`/`role_entity_permissions`/`role_dashboard_widgets`/`system_messages` | Idempotent seed migrations, T-004, extended by every later task that added a screen (§4 above shows the pattern) |
| G8 | Local Node was v16, NestJS 11/Vite 5+ need ≥20 | `.nvmrc` + `engines`, checked by T-001 before any other work |

All eight closed as designed. **Two new, equally structural gaps were found live while writing
this document** — T-091 (a maintained-by-hand grant list, `T002_008_grants.ts`, that fell behind
~19 tables added by later waves) and T-092 (§4.3's missing widget-data route). Neither was this
task's to close directly (both outside `docs/**`/`e2e/**`), but **both have since been fixed,
landed and independently re-verified live** — see `docs/KNOWN-LIMITATIONS.md` §8 and
`project-plan/reports/T-054-release-readiness.md` for the full detail and the resulting go/no-go
reasoning. Treat them as G9/G10 in spirit, even though they postdate the original architect
review.

## 6. Read before adding any `reward_config` table — a recurring class of bug, closed once, can recur

`back-end/src/database/migrations/T002_008_grants.ts` (extended by `T091_001_...ts`) is a
**hand-maintained, explicit list** of which `reward_config` tables `reward_app` may read/write.
It is not a blanket "every table in the schema" grant, and nothing re-runs it when a later
migration adds a table. **If your migration creates or starts using a new `reward_config`
table, you must add its own `GRANT` — copying an existing table into that file's list is not
enough if the new table isn't already there.** T-091 (now fixed) existed precisely because ~19
tables across T005/T006/T007/T042 never got this step, and the gap went unnoticed until T-054
hit a live `permission denied` error walking the campaign wizard by hand — the fix is in, but
the *pattern* that caused it (a migration adds a table and forgets the matching grant) is not
structurally prevented, only patched for the 19 tables found this time. Check
`has_table_privilege('reward_app', 'reward_config.<table>', 'SELECT')` against a real database
before assuming a new table works — the ORM will not warn you at compile time, and a
well-formed request will 500 with a raw Postgres error the first time a real user reaches that
code path. `project-plan/reports/T-054-release-readiness.md` §3 recommends adding this check to
gate 6 (`migrate → rollback → migrate`) itself so this class of defect cannot recur silently;
that recommendation was not yet acted on as of this document.

## 7. Where to go next

- **First change to make:** read the task file for whatever you're picking up in
  `project-plan/tasks/`, and `AGENT-PROTOCOL.md` end to end once. Both are written for exactly
  this handover moment.
- **Deploying:** `docs/DEPLOYMENT.md`.
- **Something's on fire:** `docs/RUNBOOK.md`.
- **Performance/scaling questions:** `docs/PERFORMANCE.md`.
- **"Is this a known issue?":** `docs/KNOWN-LIMITATIONS.md`, then `project-plan/BACKLOG.md`
  (deferred-on-purpose items), then `project-plan/progress.json` (current status of every
  task, including T-091/T-092).
- **Architecture questions:** `project-plan/00-ARCHITECTURE.md` and the two independent review
  documents, `project-plan/../architect-review/ARCHITECT-REVIEW.md` and
  `CAPABILITY-COMPARISON.md` — both fully resolved as of 2026-08-14, and still the source of
  truth for *why* a design decision was made, not just what it is.
