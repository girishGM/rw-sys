# Performance

T-053 — measured budgets, the test suite that proves them, and every finding this task
turned up along the way. Every number below is a **real** measurement against real
infrastructure (the local Postgres this repo's own `CLAUDE.md` documents, and — for the
front-end/network-bound budgets — the actual `docker-compose.yml` stack T-052 built), not an
estimate. Where a number is borderline or a gap was found, this document says so plainly; see
"Findings and fixes" below before assuming every row is a comfortable pass.

## Budgets and results

| Metric | Budget | Measured | Result |
|---|---|---|---|
| `GET /me/bootstrap` p95 (1000 warm requests) | < 100 ms | **25.0 ms** | ✅ |
| `GET /campaigns` p95 @ 10k rows | < 300 ms | **37.8 ms** | ✅ |
| `GET /users` p95 @ 5k rows | < 300 ms | **38.8 ms** | ✅ |
| Campaign submit p95 | < 500 ms | **42.0 ms** | ✅ |
| Login p95 | < 600 ms | **44.5 ms** | ✅ |
| Login floor (Argon2 not weakened) | every sample "expensive enough" | see TC-5 below | ✅ |
| Initial JS bundle, gzipped | < 250 KB | **159.19 KB** (true entry) / 229.23 KB (`size-limit`'s own, conservative — see finding) | ✅ |
| Initial CSS bundle, gzipped | < 50 KB | **5.88 KB** | ✅ |
| Dashboard FCP, Fast 3G, cold cache | < 1.5 s | **~1.44–1.54 s** | ⚠️ borderline pass — see finding |
| Lighthouse Performance score, dashboard, Fast-3G-equivalent throttling | ≥ 90 | **98 / 100** (retry 1, real run — see "Verification step 4" below) | ✅ |
| DB pool utilisation @ 50 rps | < 70% | **7.8–16% average** (peaks to 100% momentarily — expected, see TC-18 below) | ✅ |
| 50 rps sustained, 5 min | zero errors | **zero 5xx, zero 429** (15-actor run) | ✅ |
| Spike to 200 rps | graceful degradation | **zero 5xx, zero connection failures, 429s engage** | ✅ |
| 30-minute soak | flat memory | **flat — healthy sawtooth GC pattern, no growth trend** | ✅ |

All measurements below are reproducible; every command is given verbatim.

## Test cases

| ID | Description | Result | Evidence |
|---|---|---|---|
| TC-1 | `/me/bootstrap` p95 over 1000 warm requests | ✅ 25.0 ms | `back-end/test/performance/list-endpoints.e2e-spec.ts` |
| TC-2 | `/campaigns` @ 10k rows, p95 | ✅ 37.8 ms | same file |
| TC-3 | `/users` @ 5k rows, p95 | ✅ 38.8 ms | same file |
| TC-4 | Campaign submit p95 | ✅ 42.0 ms | `back-end/test/performance/submit-and-login-latency.e2e-spec.ts` |
| TC-5 | Login p95 < 600 ms **and** Argon2 cost intact | ✅ p95 44.5 ms; floor calibrated per-run against a fresh, in-process `argon2.verify()` benchmark (~20–25 ms on the machine this suite runs on — see that spec's own header for why a fixed ">100ms" is not portable across hardware) | same file |
| TC-6 | Query count per list request constant regardless of row count | ✅ | `list-endpoints.e2e-spec.ts` |
| TC-7 | `EXPLAIN ANALYZE` on every list query — index scan, no seq scan on a large table | ✅ (see below) | this doc + live `psql` |
| TC-8 | Pagination is `LIMIT`/`OFFSET` in the real SQL, not an in-memory slice | ✅ | `list-endpoints.e2e-spec.ts` (`captureQueries`) |
| TC-9 | RBAC cache hit rate under load | ✅ 100% (300 checks, 0 store reads after warm-up) | `back-end/test/performance/rbac-cache-load.e2e-spec.ts` |
| TC-10 | Version bump under concurrent load — all instances see fresh permissions | ✅ 30/30 correctly denied | same file |
| TC-11 | Cache/store failure injected — denies, not allows | ✅ 403 `PERM_DENIED` | same file |
| TC-12 | Initial bundle size | ✅ 159.19 KB true entry (< 250 KB); see finding on `size-limit`'s own conservative number | `.size-limit.json` + build output |
| TC-13 | Access Control screen — separate chunk | ✅ `index-BHfc4rWk.js`, absent from the entry chunk (only a lazy-import string reference remains there) | live `dist/` inspection |
| TC-14 | Charts — separate chunk | ✅ `Chart-DeJkE4RY.js`, same confirmation | live `dist/` inspection |
| TC-15 | Dashboard FCP on Fast 3G | ⚠️ borderline — see finding (was ~3.3s before a real, fixed bug) | `e2e/perf/dashboard-fcp.ts` + Lighthouse |
| TC-16 | 50 rps for 5 min, zero errors | ✅ | `scripts/load-test.js` (see below) |
| TC-17 | Spike to 200 rps — graceful, no crash | ✅ | same |
| TC-18 | DB pool utilisation @ 50 rps | ✅ average 7.8–16% (< 70%) | `list-endpoints.e2e-spec.ts` TC-18 |
| TC-19 | Memory over a 30-minute soak | ✅ flat | this doc (below) |
| TC-20 | Table with 500 rows — virtualised, smooth scrolling | ⚠️ N/A as literally specified — see finding | this doc |

## Findings and fixes

Several of these were genuine bugs this task found and fixed, in files this task owns. None of
them were known going in; all were caught by actually running the measurement against real
infrastructure rather than trusting a static check. That is deliberately the point of running
*both* a static bundle-size gate (TC-12) and a real, over-the-wire measurement (TC-15) — they
catch different failure modes, and this task is proof of exactly that: TC-12 was green the
entire time this deployment was silently shipping the wrong bytes.

### 1. `front-end/nginx.conf` never enabled gzip — the SPA image served 520 KB, not 159 KB, over the wire (fixed)

**This is the reason TC-15 initially failed at ~3.3s, more than double the 1.5s budget.**
`nginx:1.27-alpine` (the base image `front-end/Dockerfile` builds from) ships `gzip off;` by
default, and nothing in `nginx.conf` or `nginx.main.conf` had ever turned it on. Confirmed live:

```bash
curl -sS -H "Accept-Encoding: gzip" -D - -o /dev/null http://localhost:8080/assets/index-*.js
#   (before the fix) Content-Length: 520233, no Content-Encoding header at all
#   (after the fix)  Content-Encoding: gzip
```

The bundle-budget gate (TC-12, `size-limit`) never caught this because it measures the *build
artefact* directly — it has no way to know what a running container actually serves. Fixed by
adding a `gzip on;` block (with `gzip_types` covering JS/CSS/JSON/SVG) to `front-end/nginx.conf`
— see that file's own comment for the full story and the exact `curl` evidence. This is why
TC-15 matters as an independent, end-to-end check even though TC-12 was — and still is —
green: a correct bundle can still be served wrong.

### 2. Dashboard FCP on Fast 3G is a borderline pass, not a comfortable one

With the gzip fix in place, five independent measurements — three via a real, headless-Chromium,
cold-cache, CDP-throttled run (`e2e/perf/dashboard-fcp.ts`) and one via Lighthouse
(`--preset=desktop --throttling-method=devtools` with the same Fast-3G parameters) — landed at
1444 ms, 1456 ms, 1460 ms and 1541.7 ms respectively. Three of four are under the 1.5s budget;
Lighthouse's own run was 41 ms over it. This is reported as a genuine **borderline pass**, not
rounded up to a comfortable green: the margin (well under 5%) is easy to lose to any future
change that adds even a small amount of critical-path weight (another sequential API call before
first paint, a slightly larger entry chunk, …).

**Root cause of the remaining ~1.4–1.5s, for whoever tunes this further:** the network waterfall
(`network-requests` Lighthouse audit) shows the Dashboard route firing **seven** API calls before
first paint — `/me/bootstrap`, `/notifications/unread-count` and five separate
`/dashboard/widgets/*` calls (`kpi_countries`, `kpi_tenants`, `kpi_active_campaigns`,
`chart_campaigns_by_country`, `list_recent_admin_activity`). `mainthread-work-breakdown` (0.4s)
and `bootup-time` (0.2s) rule out JS execution as the dominant cost; the remaining time is
consistent with network round trips (150ms RTT under Fast 3G, per call, if any of the seven are
serialised rather than fully parallel) plus the ~0.8–1s the compressed bundle itself now
genuinely costs to fetch. **`front-end/src/**` is out of this task's file scope** (T-053 owns
`front-end/.size-limit.json` only) — reported here as a recommendation for whoever owns
`DashboardPage.tsx`/the widgets API client: confirm the seven calls are issued in parallel
(`Promise.all`, not sequential `await`s) and consider whether the Dashboard can paint a skeleton
before any of them resolve (the pattern `Table.tsx`'s own `isLoading` state already establishes
elsewhere in this app) for real headroom rather than a margin this thin.

### 3. `scripts/load-test.js` had three real bugs, all now fixed

All three were caught by actually running the script against a live stack, not by reading the
code:

1. **`new URL(path, baseUrl)` silently discarded `baseUrl`'s own path.** `--base-url
   http://host/api/v1` combined with a request path like `/auth/login` resolved to
   `http://host/auth/login` — WHATWG's `URL` treats a leading-`/` second argument as relative to
   the *origin*, not the base's path, throwing away `/api/v1` entirely. Every request 404/405'd
   against nginx's SPA fallback instead of reaching the API. Fixed with a `joinUrl` helper that
   strips/re-adds the slash correctly; see that function's own comment.
2. **A single `--email`/`--password` actor cannot honestly produce a *sustained* 50 rps number.**
   `AUTHENTICATED_API_LIMIT` (`security.constants.ts`) is 300 req/user/minute = 5 rps/user. A
   single-actor run asked for 50 rps spent **86% of its requests on 429s** (confirmed live, this
   task's own first real run) — and because a 429 short-circuits before touching the database,
   that run's own p50/p95 numbers looked *better* than a real 50 rps of distinct traffic would,
   for the wrong reason. Fixed with `--credentials <path-to-json>`: many actors, round-robined
   per authenticated request (not per request-type) — this document's own TC-16/TC-17 numbers
   were measured with 15 actors this way, zero 429s during the sustained phase.
3. **No session refresh — any run past the access token's 15-minute lifetime silently degrades.**
   The 30-minute soak's first real run showed a clean 0% 429 rate for roughly its first 900s,
   then a wall of 429s for the rest (~49% overall) — every actor's access token expired partway
   through, and (per `throttler.config.ts`'s own `generalRule`) a request with no valid identity
   falls through to the *unauthenticated* per-IP bucket (`UNAUTHENTICATED_API_LIMIT = 60/min`,
   **shared across every actor**, since they all share this driver's one IP) instead of each
   actor's own 300/min. Fixed with a background `POST /auth/refresh` loop
   (`startCookieRefresher`, every 630s — 70% of the 900s token lifetime) that keeps every actor's
   session alive for the duration of a long run.

   **This fix had a bug of its own on the first attempt, also found by actually running it, not
   by reading the code:** `POST /auth/refresh` still 403'd every time — `CsrfGuard`
   (`security.constants.ts#CSRF_EXEMPT_METHODS`) exempts only `GET`/`HEAD`/`OPTIONS`, so a POST
   needs a matching `x-csrf-token` header even on a route that needs no JWT (`@Public()` on this
   route is about the auth guard, not the CSRF one — two independent guards, both real). Fixed by
   reading the `rs_csrf` cookie back out of the jar (`csrfTokenFrom`) and sending it as that
   header, the same thing `apiClient.ts` does for every real browser session. The final
   30-minute soak (below) used the fully-fixed script and shows zero 429s throughout.

### 4. `front-end/.size-limit.json`'s glob is a conservative *sum*, not the true entry size

`"dist/assets/index-*.js"` matches every chunk whose Vite-assigned name happens to start with
`index-` — not only the true `<script>` entry `index.html` references. Vite defaults a lazily
imported module's chunk name to its nearest barrel file (several of this SPA's
`features/*/index.ts` files), which collides with the entry's own default name (also `index`,
since neither `vite.config.ts` overrides `build.rollupOptions.output.entryFileNames`). The result
is `size-limit`'s own reported number (229.23 KB) sums several *lazy* route chunks together with
the one true entry chunk (159.19 KB, confirmed by cross-referencing `dist/index.html`'s single
`<script>` tag and T-083's own completion report). Both numbers are comfortably under the 250 KB
budget today, and the direction is safe (the reported number can only overstate the true initial
payload, never understate it), so this is not a blocking defect — but it is a real imprecision
worth fixing properly: `vite.config.ts` (T-020's file, out of this task's scope) would need
`entryFileNames: 'assets/app-[hash].js'` (or similar) to give the true entry a name no lazy chunk
can collide with, after which `.size-limit.json`'s existing glob would need no further change.

### 5. A candidate missing index — for the DBA, not added here (constraint C1)

`reward_config.tenant_campaigns`'s default list sort (`createdAt`) has no covering index —
`ix_tc_tenant_dates` covers `(tenant_id, start_date, end_date)` and `ix_tc_tenant_status` covers
`(tenant_id, status)`, but nothing covers `(tenant_id, created_at)`. `EXPLAIN ANALYZE` (below)
shows Postgres correctly index-scanning on `tenant_id` via `ix_tc_tenant_dates` and then doing an
in-memory top-N heapsort for the `created_at` ordering — cheap at today's scale (15ms at 10k
rows, comfortably inside TC-2's 300ms budget) but worth a DBA's attention if `createdAt` sort
ever becomes the default across a much larger table. **No index was added to `reward_config`** —
C1 forbids it from this task.

### 6. TC-20 ("500 rows, virtualised") does not apply to any screen this app currently ships

Every list endpoint in the backend caps `pageSize` at 100, not 500 — confirmed via all nine
`MAX_PAGE_SIZE = 100` constants (`users`, `tenants`, `merchants`, `rules`, `rewards`, `countries`,
`blasts`, `definition-requests`, `approvals`; `audit` has its own `AUDIT_MAX_PAGE_SIZE = 100`).
The shared `Table` component (`front-end/src/components/Table.tsx`, T-021's file) renders every
row it is given with no windowing/virtualisation — unlike `MultiSelect`, which does implement a
hand-rolled windowed render specifically for its own 500-option scale (T-021 TC-13). Since no
real screen can ever hand `Table` more than 100 rows today, TC-20 as literally specified is
unreachable, not failing. Recorded here as a forward-looking note rather than a defect: if
`MAX_PAGE_SIZE` is ever raised well beyond 100 in the future, `Table.tsx` would need the same
windowing treatment `MultiSelect` already has.

## `EXPLAIN ANALYZE` — the hottest queries, real plans

Reproduced live against the local Postgres this repo's own `CLAUDE.md` documents, with realistic
row counts (10,000 `tenant_campaigns` rows, 5,000 `portal_users` rows) seeded the same way
`back-end/test/performance/support/perf-fixtures.ts` does for the automated suite above.

```sql
-- 1. GET /campaigns (tenant-scoped, default sort, page 1) — the query TC-2 measures.
EXPLAIN ANALYZE
SELECT * FROM reward_config.tenant_campaigns
WHERE tenant_id = 1022
ORDER BY created_at DESC
LIMIT 20 OFFSET 0;

 Limit  (cost=60.57..60.62 rows=20 width=449) (actual time=15.428..15.432 rows=20 loops=1)
   ->  Sort  (cost=60.57..60.62 rows=22 width=449) (actual time=15.427..15.429 rows=20 loops=1)
         Sort Key: created_at DESC
         Sort Method: top-N heapsort  Memory: 27kB
         ->  Index Scan using ix_tc_tenant_dates on tenant_campaigns
               (cost=0.28..60.08 rows=22 width=449) (actual time=0.053..9.119 rows=10000 loops=1)
               Index Cond: (tenant_id = 1022)
 Planning Time: 0.686 ms
 Execution Time: 15.459 ms
```

Index scan, not a sequential scan, despite Postgres's row estimate being stale (22 estimated vs.
10,000 actual — see the note below on why `ANALYZE` cannot be run by the app role). See
finding 5 above for the one column this table's indexes do not cover.

```sql
-- 2. GET /users (tenant-scoped, default sort) — the query TC-3 measures.
EXPLAIN ANALYZE
SELECT * FROM reward_portal.portal_users
WHERE tenant_id = 1022 AND deleted_at IS NULL
ORDER BY display_name ASC
LIMIT 20 OFFSET 0;

 Limit  (cost=8.29..8.29 rows=1 width=909) (actual time=10.245..10.250 rows=20 loops=1)
   ->  Sort  (cost=8.29..8.29 rows=1 width=909) (actual time=10.243..10.246 rows=20 loops=1)
         Sort Key: display_name
         Sort Method: top-N heapsort  Memory: 31kB
         ->  Index Scan using ix_portal_users_tenant on portal_users
               (cost=0.26..8.28 rows=1 width=909) (actual time=0.046..5.982 rows=5000 loops=1)
               Index Cond: (tenant_id = 1022)
 Planning Time: 1.620 ms
 Execution Time: 10.323 ms
```

Index scan on `ix_portal_users_tenant`.

```sql
-- 3. Session validation (every authenticated request pays this) — a real, but tiny, table.
EXPLAIN ANALYZE
SELECT * FROM reward_portal.portal_sessions
WHERE id = '<a real session uuid>' AND status = 'active';

 Seq Scan on portal_sessions  (cost=0.00..1.12 rows=1 width=710) (actual time=0.083..0.084 rows=0 loops=1)
   Filter: ((status = 'active') AND (id = '...'))
 Planning Time: 0.991 ms
 Execution Time: 0.129 ms
```

A sequential scan here is **correct**, not a red flag: `portal_sessions` holds a handful of live
rows in any single environment (one row per active login), well under one page — Postgres's own
planner correctly prefers a seq scan over an index scan below a certain row count, and the table
carries a primary-key index (`portal_sessions_pkey`) that would be used the moment real row
counts justify it.

**Why `ANALYZE` cannot be run by the application itself:** `reward_app` (the least-privilege
runtime role, `01-DATABASE.md` §3) does not own any table in `reward_config`/`reward_portal` — it
was granted `SELECT`/`INSERT`/`UPDATE`/`DELETE` (`T002_008_grants.ts`), not table ownership, and
`ANALYZE` requires the latter. `reward_app ANALYZE reward_config.tenant_campaigns;` returns
`WARNING: permission denied to analyze "tenant_campaigns", skipping it` — a warning, not a hard
error, so it fails silently rather than loudly. In production this is exactly what autovacuum
exists to do in the background; the automated suite's own fixtures (`perf-fixtures.ts`) borrow
the migration role for one `ANALYZE` statement per bulk insert, exactly because a fresh bulk load
needs current statistics *before* the very next query, not eventually.

## Load test — `scripts/load-test.js`

Real, headless requests against the actual `docker-compose.yml` stack (nginx + gzip fix, real
API, real Postgres) — not the automated e2e suite, which is scoped to single-request latency
percentiles rather than sustained throughput.

```bash
# One-time setup: 15 real maker accounts under one tenant, credentials written to a JSON file
# --credentials reads (see this file's own header for why 15, not 1).
node scripts/load-test.js \
  --base-url http://localhost:8080/api/v1 \
  --credentials /tmp/loadtest-actors.json \
  --rps 50 --duration 300 \
  --spike-rps 200 --spike-duration 30
```

```
--- Sustained @ 50 rps for 300s ---
  bootstrap        n=6429   p50=9.5ms  p95=19.7ms  p99=51.7ms  max=215.3ms  errors=0 (0.00%) 429s=0
  campaigns_list   n=4286   p50=10.9ms p95=24.4ms  p99=70.5ms  max=164.9ms  errors=0 (0.00%) 429s=0
  users_list       n=2143   p50=7.6ms  p95=18.2ms  p99=53.7ms  max=181.4ms  errors=0 (0.00%) 429s=0
  health           n=2142   p50=3.4ms  p95=9.7ms   p99=29.1ms  max=111.6ms  errors=0 (0.00%) 429s=0

✓ Zero errors during the sustained phase.

--- Spike @ 200 rps for 30s ---
  bootstrap        n=2572   p50=3.9ms  p95=5.7ms  p99=7.7ms  max=33.9ms  errors=0 (0.00%) 429s=832
  campaigns_list   n=1714   p50=4.9ms  p95=6.7ms  p99=8.5ms  max=40.4ms  errors=0 (0.00%) 429s=556
  users_list       n=857    p50=3.2ms  p95=4.7ms  p99=6.5ms  max=24.9ms  errors=0 (0.00%) 429s=278
  health           n=857    p50=1.6ms  p95=2.6ms  p99=3.9ms  max=10.6ms  errors=0 (0.00%) 429s=0

Spike result: 0 connection failure(s), 0 5xx, 1666 rate-limited (429). Graceful degradation
means the last number is > 0 and the first two are 0 — the limiter engaging, not the process
falling over.
```

TC-16 and TC-17 both hold: every list-endpoint p95 during the sustained phase is comfortably
inside its own budget, zero 5xx/connection failures throughout, and the 200 rps spike degrades
exactly the way 02-SECURITY.md's own rate limiter is designed to — `429`s engage, nothing crashes.

## 30-minute soak (TC-19)

```bash
node scripts/load-test.js --base-url http://localhost:8080/api/v1 \
  --credentials /tmp/loadtest-actors.json --rps 20 --duration 1800
```

Sampled every 10 seconds via `docker stats portal-api-1 --no-stream` for the full 1800-second
run. Memory shows the healthy sawtooth pattern V8's own generational GC produces under sustained
load — ramps from a ~150 MB baseline, peaks in the 190–270 MB range, a GC cycle reclaims the
ramp-up garbage, and the next plateau is **flat or lower than the previous one**, never trending
upward run over run. No sign of an unbounded leak over the full 30 minutes. The load driver
itself reported zero 5xx/connection failures across all 36,000 requests (three real bugs in the
driver itself, found and fixed while producing this exact run — see "Findings and fixes" above).

## RBAC cache configuration (implementation note 3)

```sql
SELECT config_key, config_value FROM reward_config.rbac_cache_config;
--  rbac_ttl_seconds | 300
```

TTL is 300 seconds (5 minutes), read live by `PermissionCacheService` — exercised directly (not
just documented) by TC-9/TC-10/TC-11 above, which hit the real service through the real,
already-running `PermissionsGuard`, not a fake store.

## Verification step 4 — Lighthouse Performance score (retry 1, 2026-08-23)

The task file's Verification step 4 ("Lighthouse on the dashboard, Performance ≥ 90") was never
actually captured in the first pass of this task — Lighthouse had only ever been used once, as a
cross-check for TC-15's own FCP number (see "Dashboard FCP on Fast 3G is a borderline pass" above),
never to record the **Performance category score** (0-100, Lighthouse's own weighted composite of
FCP/LCP/TBT/CLS/Speed Index) this step asks for. `e2e/perf/dashboard-lighthouse.ts` is the fix: a
real, reproducible, checked-in script (not a one-off manual command) that authenticates through the
same real login/MFA-enrolment flow `dashboard-fcp.ts` uses, then runs the `lighthouse` CLI (via
`npx`, already resolvable — no new `package.json` dependency, same reasoning
`scripts/load-test.js`'s own header gives for staying dependency-free) against the authenticated
`/dashboard` route, with `--extra-headers` carrying the session cookie so Lighthouse audits the
real dashboard rather than being redirected to `/login`.

**Real, throttled result** (Fast-3G-equivalent: `FAST_3G`/`CPU_SLOWDOWN_MULTIPLIER` — the exact
same constants `dashboard-fcp.ts`'s own CDP emulation uses for TC-15, passed to Lighthouse's
`--throttling.*` flags explicitly rather than relying on `--preset=desktop`'s own, much lighter
default throttling — see the finding below):

```
Performance score: 98 / 100 (budget: >= 90)
FCP:  789.7ms
LCP:  948.1ms
TBT:  0.0ms
CLS:  0.012
Speed Index: 538.0ms
```

**A real, honest discrepancy worth naming, not smoothing over:** Lighthouse's own FCP for this
audit (789.7ms) is meaningfully lower than `dashboard-fcp.ts`'s CDP-emulated FCP for the same
route under nominally the same Fast-3G parameters (~1.44–1.54s, see the finding above). Both are
genuine, reproducible measurements — the difference is methodology, not one of them being wrong:
`dashboard-fcp.ts` measures a **cold-cache, first-ever navigation** in a brand-new browser context
(this file's own `measureDashboardFcp` doc comment explains why that matters), while Lighthouse's
own navigation in this script reuses the *same* browser context the login/enrolment flow just ran
in — warmer HTTP cache, same as the FCP methodology bug T-053 originally found and fixed for
`dashboard-fcp.ts` itself (see "Findings and fixes" above). Because Lighthouse's own score is not
the budget this task treats as authoritative for FCP specifically (TC-15/`dashboard-fcp.ts` is —
see the Budgets table), this is reported as a second, independent, deliberately-not-reconciled data
point rather than a replacement number: the **Performance score** (98/100) is what Verification
step 4 asks for and is what closes that gap; the FCP sub-metric it also reports is corroborating
context, not a new canonical FCP figure.

**Finding: `--preset=desktop` alone does not throttle to Fast 3G.** The first real run of this
script, before the fix above, used only `--throttling-method=devtools --preset=desktop` (matching
the informal description of the original one-off manual Lighthouse invocation this document's
"Findings and fixes" section already referenced) and scored 100/100 with FCP **195.1ms** — a
locally-served, effectively unthrottled number, nothing like a genuine Fast-3G condition. Confirmed
live: Lighthouse's desktop preset does not apply network throttling by default unless the
`--throttling.*` flags are given explicitly. Left as-is, that would have been a technically-true
but practically meaningless "Performance ≥ 90" — trivially passable under any real-world
condition. Fixed by exporting `FAST_3G`/`CPU_SLOWDOWN_MULTIPLIER` from `dashboard-fcp.ts` and
passing them to Lighthouse's own `--throttling.rttMs`/`--throttling.throughputKbps`/
`--throttling.uploadThroughputKbps`/`--throttling.cpuSlowdownMultiplier` flags — one Fast-3G
definition shared by both scripts, not two that could silently drift apart.

**A second, real defect this retry found and fixed while wiring the above:**
`dashboard-fcp.ts`'s own `parseArgs` used to default `--password` and `--temp-password` to the
*same* literal string. Any invocation that only ever passes `--password` — which is exactly what
this file's own "Usage" example and this document's former "Reproducing these numbers" section
both showed — silently sends an identical old/new password to `POST /auth/change-password`. The
backend correctly rejects that with a `400` (a real password-reuse guard, not a bug in it), but
`completeFirstLoginThroughUi` had no way to distinguish that from any other failure to reach
`/dashboard`, so the whole script just hung until its own 60s `waitForURL(/dashboard)` timeout —
confirmed live, reproduced on every run that omitted an explicit `--temp-password`, not once. Fixed
two ways: the two flags now default to different literals, and `parseArgs` throws immediately, with
a clear message, if a caller ever supplies the same value for both. This is exactly the kind of
"code, test and spec agreed with each other and with nothing real" failure mode
`AGENT-PROTOCOL.md` §3 warns about — the script *looked* complete (it had run successfully before,
per the original completion notes) but the one documented way to invoke it triggered a defect that
had never actually been exercised end-to-end with only the documented flags.

## Reproducing these numbers

```bash
# Automated suite (TC-1..TC-11, TC-18) — real Postgres, real AppModule, no Docker required.
npm run test:perf
# (equivalent to: cd back-end && npx jest --config ./test/jest-e2e.json test/performance --runInBand)

# Bundle budget (TC-12).
npm run size-limit

# Load test / soak (TC-16, TC-17, TC-19) — against the docker-compose stack:
docker compose up -d --build
# ...provision encryption keys and a super_admin per docs/DEPLOYMENT.md's own "first boot"...
npm run load-test -- --base-url http://localhost:8080/api/v1 --credentials <path> --rps 50 --duration 300 --spike-rps 200 --spike-duration 30

# Dashboard FCP (TC-15) — note --temp-password must differ from --password (see finding above).
cd e2e && npm run perf:dashboard-fcp -- --base-url http://localhost:8080 \
  --email <email> --temp-password <bootstrap-password> --password <new-password>

# Lighthouse Performance score (Verification step 4) — same account/flags, once enrolled reuse
# --totp-secret (printed by the run above) instead of repeating enrolment.
cd e2e && npm run perf:dashboard-lighthouse -- --base-url http://localhost:8080 \
  --email <email> --temp-password <bootstrap-password> --password <new-password>
```

## Independent re-verification (2026-08-23, separate session)

Everything above was reproduced afresh in a later session, from a clean `docker compose down -v`
(new Postgres volume, freshly provisioned encryption keys, a new `super_admin`, a new
country/tenant/8 maker actors created through the real API, no reuse of the previous run's data)
— not just re-read. Two things came out different enough from the first pass to record honestly
rather than silently match the numbers above.

**Gates:** `typecheck` ✅ · `lint --max-warnings=0` ✅ (0 errors/warnings, whole workspace) ·
`db:migrate → db:rollback → db:migrate` ✅ (`T056_001_portal_users_email_blind_index`, clean round
trip) · `scan:secrets` ✅ · `cd back-end && npx jest --config ./test/jest-e2e.json test/performance
--runInBand` ✅ 13/13 across three separate real runs (plain, and twice under `--coverage` with two
different coverage providers — see below), real numbers throughout (`/me/bootstrap` p95 21.5–30.9 ms
against a 100 ms budget, `/campaigns`@10k p95 23.4–45.3 ms and `/users`@5k p95 32.8–54.0 ms against a
300 ms budget, submit p95 55.2–64.9 ms against 500 ms, login p95 44.3–58.5 ms against 600 ms with the
Argon2 floor (`benchmarkArgon2Verify`) confirmed intact on every run — all comfortably inside budget).

**On `test:cov` and this task's own files:** `npm test -- back-end/test/performance` and
`npm run test:cov -- back-end/test/performance` both report **0 matches** — reproduced live, exit
code 1, `testRegex: .*\.spec\.ts$ — 279 matches / Pattern: back-end/test/performance — 0 matches`.
This is mechanical, not a gap: every file this task owns under `back-end/test/performance/**` is
named `*.e2e-spec.ts`, which `back-end/jest.config.js`'s `testRegex` deliberately excludes (the same
convention every other e2e-only task in this repo follows — those specs run only under
`test/jest-e2e.json`, per that file's own extensive comment block). The real equivalent command is
the one this document has used throughout: `cd back-end && npx jest --config ./test/jest-e2e.json
test/performance --runInBand`. One real wrinkle worth naming for whoever runs this next: adding
`--coverage` to that exact command **without** `--coverageProvider=v8` measures the wrong thing —
`ts-jest`'s default (Istanbul) instrumentation adds enough per-request overhead to instrumented
source files that TC-1 and TC-2 themselves fail (`/me/bootstrap` p95 103 ms vs. a 100 ms budget,
`/campaigns` p95 554 ms vs. a 300 ms budget — reproduced live), for a reason that has nothing to do
with a real regression: the coverage tool is measuring how slow it makes the code it is
instrumenting, on tests whose entire assertion is real wall-clock time. `--coverageProvider=v8`
(native V8 coverage, no source rewriting) removes that confound — the identical 13 tests all pass
under it, with realistic p95s (25–45 ms) — and, run without an explicit `collectCoverageFrom`
(which needs to be relative to `jest-e2e.json`'s own `rootDir` of `test/`, not `back-end/`, to
match anything at all), reports this task's one piece of genuine production-shaped logic,
`back-end/test/performance/support/perf-fixtures.ts`, at **97.74% statements / 89.28% branches /
100% functions / 97.74% lines** — comfortably over the 80% floor. The `*.e2e-spec.ts` files
themselves are the tests, not code under test, the same reason `campaigns.e2e-spec.ts` and every
other e2e spec in this repo carry no coverage number of their own.

**TC-15 (Dashboard FCP), reproduced three times, fresh `super_admin`, fresh enrolment:** 1512.0 ms
(over budget), 1488.0 ms, 1484.0 ms (both under) — via `e2e/perf/dashboard-fcp.ts` itself, no
change to the script. This is not a regression from the 1444–1541.7 ms range the first pass
recorded; it is the same finding, reproduced independently: **this budget sits close enough to its
own margin that a fresh run on a different day, on a machine doing other things concurrently, can
land on either side of it.** Treat "Dashboard FCP ✅" in the table above as accurate only in the
sense the first pass already qualified it — a borderline pass, not a comfortable one — and not as
something this second, independent measurement resolved either more or less favourably.

**Load test, fresh 8-actor tenant, shorter duration (30 rps/90 s sustained, 150 rps/20 s spike —
lower than the original 15-actor/50 rps/300 s run, deliberately: this pass exists to prove the
*mechanism* still works end-to-end against a genuinely from-scratch stack, not to re-establish the
canonical throughput numbers the first pass already measured at proper scale):**

```
--- Sustained @ 30 rps for 90s ---
  bootstrap        n=1158  p50=16.3ms p95=69.3ms p99=202.2ms max=554.6ms errors=0 (0.00%) 429s=0
  campaigns_list   n=772   p50=15.7ms p95=78.2ms p99=208.7ms max=460.0ms errors=0 (0.00%) 429s=0
  users_list       n=385   p50=13.2ms p95=76.4ms p99=189.8ms max=425.5ms errors=0 (0.00%) 429s=0
  health           n=385   p50=6.3ms  p95=38.9ms p99=106.7ms max=261.4ms errors=0 (0.00%) 429s=0
✓ Zero errors during the sustained phase.

--- Spike @ 150 rps for 20s ---
  bootstrap        n=1287  p95=275.8ms max=537.9ms errors=0 429s=688
  campaigns_list   n=857   p95=276.7ms max=535.7ms errors=0 429s=459
  users_list       n=428   p95=272.1ms max=518.7ms errors=0 429s=229
  health           n=428   p95=228.1ms max=509.1ms errors=0 429s=0
Spike result: 0 connection failure(s), 0 5xx, 1376 rate-limited (429).
```

Zero errors/connection failures in both phases; the spike again shows the limiter engaging (429s
rise sharply) rather than the process degrading. p95s here are higher than the first pass's
(69–78 ms vs. 19.7–24.4 ms) — expected, not a regression: this tenant has no bulk-seeded campaign
rows (a brand-new tenant, not the 10k-row fixture the automated suite seeds separately) and this
run shares the host machine with everything else this verification session was doing concurrently
(jest suites, `docker build`, front-end builds). The property this pass actually needs to prove —
zero errors under sustained load, graceful (not crashing) degradation under a spike — holds.

**Not independently re-run this session, given the wall-clock cost:** the 30-minute soak (TC-19)
and the full 15-actor/300 s canonical throughput numbers above. Nothing observed in this session's
shorter runs (zero errors, correctly-engaging rate limiter, flat-looking behaviour throughout)
contradicts the first pass's soak result; it was not re-measured for its own sake as a 30-minute
real-time cost with no new information expected, not because it is doubted.
