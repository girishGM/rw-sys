# Handover — realtime-activity-processing-service

Written for a reader who has not read `realtime-activity-processing-service-plan/` — a future
`reward-redemption-service` team, or anyone operating this service, should be able to work from
this document alone. Where a claim needs more depth than fits here, it points at the exact design
doc section rather than restating it.

This is T-RAP-044's own deliverable (the plan's final task, Wave 4 — Hardening). If you're picking
up further work here, also read `realtime-activity-processing-service-plan/AGENT-PROTOCOL.md` and
root `CLAUDE.md`'s "Working on `realtime-activity-processing-service/`" section first.

## 1. What this service is

Ingests customer activity in real time over **gRPC** and **Kafka**, matches it against a locally
cached copy of the portal's campaign/tracker/rule/reward/budget configuration, tracks per-customer
tracker progress, enforces budgets/caps, and emits reward entries toward
**`reward-redemption-service`** — a system this repo does not build (same "stub contract" status
`promo-code-service-plan` gives it). Standalone service: own `realtime_activity_processing`
Postgres schema (same server as the portal's own schemas), own Kafka topics, no shared npm
workspace with the portal. Full design: `realtime-activity-processing-service-plan/ARCHITECTURE.md`.

## 2. How to run this service locally

### 2.1 Prerequisites

```bash
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"   # Node 20 required
cd realtime-activity-processing-service
cp .env.example .env.development   # fill in real values — never commit this file
npm install
```

Postgres is the **existing** server documented in root `CLAUDE.md`
(`/Library/PostgreSQL/16`, database `reward_system`) — this project never starts its own
Postgres. Only Redpanda (Kafka-API-compatible) is started by this project's own
`docker-compose.yml`, on ports `9093`/`9645`/`8083` (not the `9092`/`9644`/`8082` default —
`promo-code-service`'s own Redpanda already binds those on the same machine):

```bash
docker compose up -d          # Redpanda + a one-shot Postgres connectivity probe
npm run db:migrate            # creates the realtime_activity_processing schema + rap_app role
npm run db:seed               # optional — seeds field_encryption_config/service_config/a demo campaign
```

### 2.2 The processes this service actually runs — read before deploying

**There is no single `npm start` that runs the whole service.** Each of the following is its own
independently-bootstrapped Nest composition root, run as a separate OS process (a deliberate
file-scope consequence, not an oversight — `src/main.ts`/`src/app.module.ts` are
`agent-rap-foundation`'s exclusive file scope, so every other task shipped its own standalone
`*.main.ts` rather than editing either):

| Process | Entry point | Port | Purpose |
|---|---|---|---|
| HTTP health | `src/main.ts` | `PORT` (default 3020) | `GET /health` liveness + DB reachability only |
| gRPC ingestion | `src/grpc/grpc-server.main.ts` | `GRPC_SERVER_PORT` (default 50071) | mTLS `ActivityIngestService.SubmitActivity` |
| Kafka ingestion | `src/messaging/ingest/activity-ingest-consumer.main.ts` | n/a | consumes `activity.ingest.v1` |
| Customer progress API | `src/modules/progress-api/progress-api-server.main.ts` | `PROGRESS_API_PORT` (default 3021) | `GET /progress/customers/:id/campaigns/:code/trackers/:code` |

Run any of these directly with `ts-node`, e.g.:

```bash
npx ts-node -T -r tsconfig-paths/register src/grpc/grpc-server.main.ts
npx ts-node -T -r tsconfig-paths/register src/messaging/ingest/activity-ingest-consumer.main.ts
npx ts-node -T -r tsconfig-paths/register src/modules/progress-api/progress-api-server.main.ts
```

**Known gap, flagged for whoever deploys this service next.** The processing pipeline itself —
`ProcessingModule` (the claim worker that drains `activity_logs`), `DispatchModule` (the outbox
publisher + retry worker), `InvalidationModule` (the cache-invalidation watch stream) — has **no
standalone `*.main.ts` of its own yet**. Every `*.main.ts` above was shipped with an explicit
"follow-up flagged for the architect/reviewer" comment in its own header proposing this bundle
either get its own composition root or be folded into `src/main.ts` as a hybrid process, but that
follow-up was never picked up as its own task. Today, the **only** place in this repo that actually
boots `ProcessingModule + DispatchModule + InvalidationModule` together is
`test/e2e/full-pipeline-test-helpers.ts`'s own `startInstance()` (test-only code, not shipped in
`dist/`). **This means the service, as it stands, cannot actually process any activity in a real
deployment** — ingestion accepts and durably records activities, but nothing drains them — until
whoever owns `src/modules/processing/**`/`src/modules/dispatch/**`/`src/modules/invalidation/**`
adds a real standalone entry point (mirroring `grpc-server.main.ts`'s own shape is the fastest path:
a tiny root module importing `ConfigModule` + the three processing modules, a
`NestFactory.createApplicationContext()` bootstrap, a `require.main === module` guard). This was
out of `T-RAP-044`'s own scope to fix ("Out: any new feature work") — flagged here rather than
silently worked around, per `AGENT-PROTOCOL.md` §3.

### 2.3 Database

`npm run db:migrate` / `npm run db:rollback` / `npm run db:migrate:status` — real Sequelize/Umzug
CLI against the `realtime_activity_processing` schema, connecting as the privileged
`DB_MIGRATION_*` role. Application runtime code always connects as `DB_APP_*` (`rap_app`),
least-privilege, scoped to `realtime_activity_processing.*` only — never granted anything on
`reward_config`/`reward_portal`/`promo_code` (`01-DATABASE.md` R1).

### 2.4 Commands

```bash
npm run typecheck
npm run lint -- --max-warnings=0
npm test              # full unit + e2e suite (66 suites / 477 tests as of this task)
npm run test:cov
npm run build
npm run scan:secrets
```

## 3. The contract `reward-redemption-service` needs: `reward.entry.created.v1`

Full contract: `realtime-activity-processing-service-plan/02-KAFKA-CONTRACTS.md` §3,
`03-GRPC-CONTRACT.md` §3, `05-PROCESSING-PIPELINE.md` §7. Summarized here so this section alone is
enough to start integrating.

### 3.1 Delivery: three tiers, in order, never double-delivered

1. **Tier 1 — Kafka, topic `reward.entry.created.v1`.** The transactional outbox poller
   (`src/modules/dispatch/outbox-publisher.service.ts`) publishes once a `reward_entry` row commits.
   `key = customerId` (plaintext, for downstream partition affinity). At-least-once — a consumer
   must be idempotent on `id` (the `reward_entry.id`, a uuid, globally unique).
2. **Tier 2 — gRPC fallback, `RewardIngestService.SubmitRewardEntry`.** After a configurable number
   of failed Kafka publish attempts on the *same* row (`service_config` key
   `reward_dispatch_max_retry_attempts`, default `8`), this service instead calls
   `RewardIngestService.SubmitRewardEntry` directly (`03-GRPC-CONTRACT.md` §3 — this service is the
   **client** here; `reward-redemption-service` would need to run the **server** side of this proto
   to receive tier-2 calls; if it doesn't, every tier-2 attempt fails closed and falls through to
   tier 3). Whichever tier succeeds first stops the other from retrying the same row — never
   delivered twice by design.
3. **Tier 3 — `reward_dispatch_retry` table.** If both tier 1 and tier 2 fail, a row is written here
   and a separate backoff worker (`src/modules/dispatch/reward-dispatch-retry.worker.ts`) retries
   Kafka then gRPC, exponential backoff (`DEFAULT_RETRY_BACKOFF_BASE_MS = 1000`,
   `DEFAULT_RETRY_BACKOFF_MAX_MS = 300000`), up to `reward_dispatch_max_retry_attempts` total
   attempts.

**Nothing above ever reverses the `reward_entry` row itself** — once committed, the reward is
earned, full stop (`ARCHITECTURE.md` §9). `dispatch_status`/`dispatch_attempts`/
`last_dispatch_error` describe delivery only.

### 3.2 The exact message published (tier 1 and tier 2 both carry this shape)

The full `reward_entry` row as JSON, `customerId` **decrypted** at the point of publish (this topic
crosses a trust boundary into `reward-redemption-service`'s own domain, which needs the real value):

```jsonc
{
  "id": "uuid",                    // reward_entry.id — use this as your own idempotency key
  "correlationId": "uuid",         // one per inbound activity, shared across its fan-out rows
  "tenantId": 1,
  "customerId": "string",          // DECRYPTED — the real value, never customerIdEncrypted/Hash
  "customerIdType": "string",
  "activityPerformedDate": "2026-09-01T10:15:30.000Z",
  "transactionType": "string|null",
  "activityCode": "string|null",
  "activityType": "string",
  "activityCategory": "string",
  "activityValue": "100.0000",     // decimal-as-string, avoids float precision loss
  "activityValueUnit": "string",
  "channel": "string",
  "activityPerformedEnv": "string",
  "activityName": "string",
  "campaignCode": "string",
  "trackerCode": "string",
  "trackerComponentCode": "string",
  "merchantCode": "string|null",
  "rewardCode": "string",
  "rewardCategory": "string",
  "rewardValue": "5.0000",         // decimal-as-string
  "rewardValueUnit": "string",
  "rewardEntryDate": "2026-09-01T10:15:31.000Z",
  "completionCycle": 1             // for repeatable trackers — 01-DATABASE.md §7/§8
}
```

### 3.3 Retry-table `exhausted` state — what it means, what alerting exists today

Once `reward_dispatch_retry.status` flips from `pending` to `exhausted` (both Kafka and gRPC failed
`reward_dispatch_max_retry_attempts` times each), a structured `error`-level log line is emitted:

```
REWARD_DISPATCH_RETRY_EXHAUSTED: reward_dispatch_retry row "<id>" (reward_entry "<id>")
exhausted <n> attempt(s): <failure reason>
```

**This log line is, today, the entire alerting mechanism.** `BACKLOG.md` B-2 explicitly defers the
actual paging/Slack/email integration as "environment-specific... left for whoever owns that
integration when this service is actually deployed" — this is still true as of this task; nothing
in this plan wires that log line to a real paging system. `exhausted` rows remain queryable
(`status = 'exhausted'`, `ix_reward_dispatch_retry_due` doesn't index them — that partial index is
`pending`-only — a direct `SELECT ... WHERE status = 'exhausted'` is the way to find them) and are
intended to be visible on a future observability dashboard (`06-CONFIGURABILITY-AND-OBSERVABILITY.md`
§3, `BACKLOG.md` B-4, also still deferred). **Until B-2/B-4 land, an `exhausted` row is only found by
someone actively querying for it** — there is no push notification.

## 4. Observability

Full design: `06-CONFIGURABILITY-AND-OBSERVABILITY.md`. Summary an operator needs:

- **Structured JSON logs** (`src/observability/structured-logger.ts`) — every log line carries
  `correlationId`/`tenantId`/`campaignCode` where applicable, so one inbound activity's entire
  journey (ingestion → claim → rule evaluation → reward → dispatch) can be traced by
  `correlationId` alone across every process. Verified live in this task's own load-test run.
- **In-memory metrics** (`src/observability/metrics.service.ts`) — counters/histograms exactly
  matching `06-CONFIGURABILITY-AND-OBSERVABILITY.md` §3's contract:
  `activities_ingested_total{transport}`, `activity_logs_fanout_total`,
  `tracker_components_completed_total{campaign_code}`,
  `rewards_created_total{campaign_code,reward_category}`,
  `budget_breach_total{campaign_code,cap_type}`, `dedup_hits_total`,
  `reward_dispatch_tier_total{tier}`, `activity_processing_duration_seconds`. **No HTTP `/metrics`
  exporter exists yet** — this is an in-memory, per-process store; exposing it (Prometheus text
  format, StatsD bridge, whatever a real dashboard needs) is deliberately deferred
  (`BACKLOG.md` B-4/B-2, `06-CONFIGURABILITY-AND-OBSERVABILITY.md` §3's own "exact backend left to
  T-RAP-043's own discretion... building the exporter itself is the explicitly deferred part").
- **Field-level redaction is configurable, not hardcoded** — `field_encryption_config` table,
  resolution order campaign → tenant → country → global (`06-CONFIGURABILITY-AND-OBSERVABILITY.md`
  §1). Seeded with exactly one row today: `customerId` encrypted globally.

## 5. Security posture (full detail: T-RAP-042's own report, `realtime-activity-processing-service-plan/reports/T-RAP-042-security-review.md`)

- gRPC ingestion is mTLS-only, client identity allowlisted per tenant
  (`GRPC_SERVER_ALLOWED_IDENTITIES`).
- `customerId` is never stored in plaintext anywhere in this service's own tables — AES-256-GCM
  ciphertext at rest, HMAC-SHA-256 hash for lookups/joins, decrypted only at the point of
  publishing to `reward.entry.created.v1` (§3.2 above) or serving an authorized read.
- The customer progress API uses its own narrow, purpose-built bearer-token credential
  (`src/modules/progress-api/progress-api-token.ts`) — HMAC-signed, asserts "this bearer may read
  this one `customerId`'s progress in this one tenant", `exp` required. Neither the portal's own
  admin session cookie nor this service's own gRPC mTLS identity are reused for this — a
  deliberately new, narrow credential type (see that file's own header for the two existing
  conventions checked and rejected first).
- `rap_app` (the runtime DB role) is scoped to `realtime_activity_processing.*` only — no grants on
  `reward_config`/`reward_portal`/`promo_code`.
- `.env.example` documents every required secret/credential with no committed default value;
  `npm run scan:secrets` gates every commit (`.husky/pre-commit`).

## 6. Every `BACKLOG.md` item — status as of this task

Full text: `realtime-activity-processing-service-plan/BACKLOG.md`. Restated here so nothing
deferred is silently forgotten once this plan's active build work ends (this task's own
implementation note 3).

| Item | What it is | Status after this task |
|---|---|---|
| **B-1** | Redis / distributed locking — rejected for v1; concurrency safety is Postgres-only (advisory locks + `SELECT FOR UPDATE` + unique indexes). Revisit only if real load testing shows advisory-lock contention is an actual throughput ceiling. | **Tested by this task, up to 300 events/sec combined mixed-transport load — no advisory-lock contention or rejected/failed rows observed at any rate tested.** The one real latency-growth signal found (§ below) traces to the claim worker's own poll-interval/concurrency config, not the lock mechanism. B-1's deferral stands unchanged — see `T-RAP-044-load-test-results.md` for the full finding. |
| **B-2** | Alerting/paging integration for `reward_dispatch_retry` exhaustion — the `exhausted` state and dashboard visibility are built; the actual paging/Slack/email hook is environment-specific, left for whoever deploys this service. | **Still open.** Today the only signal is the `REWARD_DISPATCH_RETRY_EXHAUSTED` structured error log line (§3.3 above) — no push notification exists. |
| **B-3** | Fine-grained cache invalidation by `changeType` — every `changeType` triggers a full campaign re-fetch today; distinguishing partial changes is a pure optimization with real correctness complexity and no evidence yet it's needed. | Still deferred — not evaluated by this task (no cache-invalidation load scenario was in this task's own scope). |
| **B-4** | Building an actual observability dashboard — the metrics/logs/comment data this plan produces are dashboard-ready; the dashboard product itself is out of this plan's job, per the user's own framing. | Still deferred. §4 above lists exactly what data is ready to be consumed by one. |
| **B-5** | Rule expression language / evaluator choice — deferred to T-RAP-031's own implementation discretion; done, resolved during Wave 2/3 build. | Resolved (not an open item — listed here only for completeness, since this section restates the whole file). |
| **B-6** | Multi-tenant / multi-region deployment topology — this plan assumes one shared Postgres server and Kafka cluster(s); it does not design cross-region replication or federated Kafka. | Still deferred — out of this task's own scope; not exercised by this task's own load test (single Postgres/single Redpanda, as this plan already assumes). |

## 7. Load test results

Full numbers, methodology, and the B-1 discussion above's own evidence:
`realtime-activity-processing-service-plan/reports/T-RAP-044-load-test-results.md`. Headline: zero
errors, zero lost/duplicate rows at every rate tested up to 300 events/sec combined
(gRPC + Kafka, mixed); claim-to-processed latency ~500ms average at ≤100 events/sec (explained by
the claim worker's own 1-second default poll interval), rising to ~1,080ms average at 300
events/sec (a real, bounded queueing effect, not a failure); customer progress API stayed under
25ms p99 under a 200-request concurrent burst.

## 8. Where the task-tracking artifacts for this whole plan live

`realtime-activity-processing-service-plan/` — `progress.json`/`index.html` (current status),
`tasks/T-RAP-0xx-*.md` (what each task was), `reports/T-RAP-0xx*.md` (what each task actually did).
This document is this plan's own final deliverable (T-RAP-044) — the plan's active build work ends
here; anything not resolved above is a genuine open item for whoever picks this service up next.
