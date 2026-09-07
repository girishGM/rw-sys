# reward-redemption-service — Handover

Written by this service's own QA task (T-RR-043), the final artifact of the initial build (Waves
0-4), mirroring `promo-code-service/docs/handover.md`'s own section shape (what this service does,
choosing a transport, each contract in turn, idempotency contract, error codes, measured
operational characteristics, known limitations) rather than inventing a different structure.
Self-contained: everything a future operator or an integrating team needs is below — no need to
open `reward-redemption-service-plan/` first, though every claim here cites the design doc section
it comes from so you can go deeper if you need to.

## 1. What this service does

RAP (`realtime-activity-processing-service`) decides a customer has **earned** a reward and commits
a `reward_entry` row. This service receives that already-proven-earned reward and turns it into an
actual **redemption**: it calls whichever external system fulfills that reward type (a promo code
today via `promo-code-service`, eventually a core-banking cashback transfer), records the outcome,
logs what a real push notification would say (no real notification service exists yet), and — if
the campaign is configured to track it — reports the redemption onward to a
`reward-tracking-service` (which also does not exist yet; this service defines and calls the real
contract it would use).

This service does **not** decide whether a reward is earned, does not re-evaluate eligibility, and
does not re-check budgets/caps — all of that is RAP's job, already done before this service ever
sees the entry (`ARCHITECTURE.md` §1-§2).

## 2. Choosing a transport (inbound)

Three inbound channels, all parsing their own transport envelope into the same DTO and calling the
same one domain method (`RewardIngestionService.ingest()`, R10 — no business logic lives in any one
adapter). Identical business behaviour, error codes, and idempotency semantics regardless of which
channel a given `id` arrives on (proven by `T-RR-014`'s cross-channel parity suite and, at real
concurrency, by this task's own load test — §7 below).

| | gRPC (`SubmitRewardEntry`) | Kafka (`reward.entry.created.v1`) | REST (`POST /api/v1/reward-entries`) |
|---|---|---|---|
| Call shape | Synchronous unary RPC, mTLS | Async, at-least-once | Synchronous HTTP, bearer token |
| Best for | RAP's own primary path today | Durable delivery across a broker hiccup | Likely to become the channel that *actually* works once both services are deployed to Render — Render's edge-terminated TLS cannot support gRPC mTLS (`04-REST-CONTRACT.md` §1) |
| Measured (T-RR-043) | See §7 — up to 800/1600 combined req/s tested alongside REST, no ceiling found in accept rate | Not included in this task's own load test — see §7's own explicit scope note | See gRPC row — measured together as "combined" |

## 3. The three inbound contracts

### 3.1 gRPC — `RewardIngestService.SubmitRewardEntry`

- **Port `50081`**, mTLS required (present a client cert whose SAN is on
  `GRPC_SERVER_ALLOWED_IDENTITIES`). Proto: `reward-redemption-service/proto/reward_ingest.proto`,
  package **`rewardrap.reward.v1`** — deliberately *not* renamed to reflect this service as the new
  owner (wire-compatibility with RAP's own already-shipped client, `03-GRPC-CONTRACT.md` §1's own
  "why the package name is NOT renamed" note).
- **Known port mismatch (`BACKLOG.md` B-6):** RAP's own `.env.example` still defaults
  `REWARD_REDEMPTION_GRPC_PORT` to `50061`, not this service's real `50081`. Whoever wires a real
  RAP-to-this-service caller must override that default on RAP's own side — not something this
  plan's own `.env.example` can fix (it lives in a different repo folder this plan may not edit).
- `SubmitRewardEntry(RewardEntry) returns (SubmitRewardEntryAck)` — one field set, shared with the
  Kafka payload and the REST body (see 3.3 below for the full field list).

### 3.2 Kafka — `reward.entry.created.v1`

- RAP → this service. Consumer group: this service's own `<service>-ingest`-style name
  (`02-KAFKA-CONTRACTS.md` §1). Partition key: `customerId`.
- Same field set as the gRPC/REST payloads. A structurally invalid message (missing a required
  field) is retried a bounded number of times, then routed to
  **`reward.entry.created.dlq.v1`** — never silently dropped, and the offset is still committed so
  a poison message cannot wedge the consumer (`02-KAFKA-CONTRACTS.md` §1).
- Local dev broker: Redpanda on **`localhost:9094`** (a third, non-colliding port — RAP and
  promo-code-service each use their own).

### 3.3 REST — `POST /api/v1/reward-entries`

```
POST /api/v1/reward-entries
Authorization: Bearer <REWARD_ENTRY_INGEST_TOKEN>
Content-Type: application/json

{
  "id": "uuid", "correlationId": "uuid", "tenantId": 1,
  "customerId": "MSISDN-60123456789", "customerIdType": "MSISDN",
  "activityPerformedDate": "2026-09-04T10:15:00.000Z",
  "transactionType": null, "activityCode": "TXN_TOPUP",
  "activityType": "TOPUP", "activityCategory": "TELCO",
  "activityValue": "50.0000", "activityValueUnit": "MYR",
  "channel": "app", "activityPerformedEnv": "production",
  "activityName": "Prepaid Top-up",
  "campaignCode": "CAMP-2026-Q3-001", "trackerCode": "TRK-TOPUP-5X",
  "trackerComponentCode": "CMP-TOPUP-STEP-3", "merchantCode": "MERCH-001",
  "rewardCode": "RWD-CASHBACK-5PCT", "rewardCategory": "CASHBACK",
  "rewardValue": "2.5000", "rewardValueUnit": "MYR",
  "rewardEntryDate": "2026-09-04T10:15:03.000Z", "completionCycle": 1
}
```

`200` on both a fresh insert and an idempotent replay of the same `id` (§4 below); `400` on a
structurally invalid body (a required field missing/wrong type); `401` on a missing/wrong bearer
token. Money fields (`activityValue`/`rewardValue`) are always decimal-formatted strings, never
floats.

## 4. Idempotency contract (R6)

`id` is the idempotency key, shared across all three channels. **A retry/redelivery must reuse the
same `id`**, never mint a new one. The unique primary key on `reward_redemption_entry.id`
(`reward_entry_unique_id`) makes a second insert a no-op — `RewardIngestionService.ingest()` does an
`INSERT ... ON CONFLICT DO NOTHING RETURNING *` with a `SELECT` fallback, so a redelivered message
or a retried call after a client-side timeout always gets back the entry's real current status,
never a duplicate row and never a duplicate call to the external reward system. Proven at low
concurrency by `T-RR-014`/`T-RR-041`, and at real concurrent load (a fraction of load-test traffic
deliberately resubmitting the same `id`, via the *opposite* channel from the original, while a real
claim worker is actively processing it) by this task's own load test — §7.

## 5. Processing pipeline (claim → resolve → connector → state machine)

One `reward_redemption_entry` row moves through `received → processing → dispatched_external →
completed` (connector-backed rewards) or the direct `received → processing → completed` path (a
reward whose value needs no external call at all), with `retrying`/`failed` off the `processing`
state for a connector failure (`05-PROCESSING-PIPELINE.md` §2). The claim step uses
`SELECT ... FOR UPDATE SKIP LOCKED` plus a transaction-scoped `pg_advisory_xact_lock` held only
across the claim itself, never across the external call — this is what lets any number of running
instances of this service claim from the same table concurrently without double-processing a row,
and is the mechanism this task's own load test exists to validate (§7).

## 6. Outbound contracts (to reward-tracking-service, which does not exist yet)

Two dispatch tiers, resolved per campaign/tracker/reward via `dispatch_channel_config`
(`01-DATABASE.md` §5), both delivering the identical logical event:

- **Kafka — `reward.redemption.completed.v1`** (this service as producer). Partition key:
  `correlationId`.
- **REST fallback — `POST /api/v1/redemptions/completed`** (`REWARD_TRACKING_REST_TOKEN`, a fourth
  distinct bearer secret alongside ingest/generation/cache-admin tokens — R9: never merge
  distinct-trust-domain credentials). Used when `dispatch_channel_config` resolves REST as primary
  or fallback for a given scope, or when Kafka is simply unreachable at publish time.
- **Tier 3 — `reward_tracking_dispatch_retry`** (`01-DATABASE.md` §7): once *both* the Kafka publish
  and the immediate REST attempt have failed for a given outbox row, it lands here with
  `next_attempt_at`/backoff, retried by its own worker. **`status = 'exhausted'`** once
  `dispatch.retry.maxAttempts` is reached — terminal, logged loudly, **never retried further
  automatically**. This is explicitly **an operator/alerting concern this plan has not built**: no
  metric-driven alert currently fires on an `exhausted` row (see §8, known limitations). If you
  operate this service, query
  `SELECT count(*) FROM reward_redemption.reward_tracking_dispatch_retry WHERE status = 'exhausted'`
  yourself until a real alerting integration exists.
- **The redemption itself is never rolled back for a delivery failure at any tier** — the reward was
  already fulfilled with the external system; only the *reporting* of that fact is what retries
  (the same principle RAP's own R3 states one hop upstream, `ARCHITECTURE.md` §9).

## 7. Connector abstraction and its two implementations

`RewardSystemConnector` (`08-EXTERNAL-INTEGRATION-CONTRACTS.md` §1) is the interface every external
reward system is called through — resolved per entry via `external_reward_system_config`
(`01-DATABASE.md` §3), never hardcoded to one system:

- **`PromoCodeServiceConnector`** — real REST client to `promo-code-service`'s own
  `POST /api/v1/promo-codes/generate` (`08-EXTERNAL-INTEGRATION-CONTRACTS.md` §2). Classifies a
  failure retryable only if its error code appears in that system's own configured
  `retryable_error_codes` — never a hardcoded list (R7).
- **`CoreBankingConnector`** — a stub (no real core-banking cashback API exists anywhere in this
  repo, `BACKLOG.md` B-2). Implements the identical interface with a configurable canned outcome
  (`SUCCESS`/`RETRYABLE_FAILURE`/`PERMANENT_FAILURE`, resolved from `service_config` — zero real
  network I/O, ever). The day a real integration is scoped, it replaces this stub behind the same
  interface without touching the pipeline's own resolution/classification logic.

## 8. Five caches (all in-memory, per-instance, never Redis/shared)

`tenantSchemaConfig`, `externalRewardSystemConfig`, `dispatchChannelConfig`, `serviceConfig`,
`campaignConfig` (`06-CACHING-AND-TENANT-CONFIG.md` §1) — each with its own `service_config`-driven
TTL and covered by the generic `POST /api/v1/cache/invalidate` endpoint
(`CACHE_ADMIN_TOKEN`, a second distinct secret from the ingest token) plus a reconciliation poller
that refreshes every cache on its own interval so N independent per-instance caches never need to
agree in real time. Deliberately in-memory rather than Redis/distributed — see `BACKLOG.md` B-1;
this task's own load test (§9 below) found no evidence this deferral needs revisiting.

## 9. Running this service locally

```bash
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"   # Node 20 required
cd reward-redemption-service
npm install
docker compose up -d                # local Postgres connectivity check + Redpanda on 9094
npm run db:migrate                  # applies all 15 migrations, seeds service_config defaults
npm run start:dev                   # boots REST (3030) + gRPC (50081) + Kafka consumer in-process
```

`.env.development` (foundation-owned) carries the DB/encryption/Kafka bootstrap vars;
`.env.local` (git-ignored, not committed) carries this repo's own throwaway dev-only bearer tokens
(`REWARD_ENTRY_INGEST_TOKEN`, etc. — see `07-CONFIGURABILITY-AND-OBSERVABILITY.md` §1 for the full
env-var list and what each one is for). Health check: `GET /health` (200 when the DB is reachable,
503 when it is not).

## 10. Load test — measured operational characteristics (T-RR-043)

**Methodology, honestly stated up front.** This load test drives real mTLS gRPC + real REST
ingestion (both at once, split 50/50) against the real `AppModule`/gRPC server, backed by
`INSTANCE_COUNT = 3` real, continuously-polling `ClaimWorkerService` instances — each its own
`pg.Pool`, its own `RedemptionProcessingOrchestrator`, its own claim repository — simulating three
separately running instances of this service all claiming from the one real shared Postgres table.
This is exactly the mechanism `05-PROCESSING-PIPELINE.md` §8 already argues scales close to
linearly with instance count (`SKIP LOCKED` lets any instance claim any unclaimed row, the advisory
lock is held only for the narrow claim transaction, `status = 'processing'` — not a lock — is what
prevents double-claiming). **This load test validates that existing, already-proven mechanism; it
does not introduce a new one.** Two boundaries are faked, deliberately: the portal-feed
resolution (`RewardSystemResolutionService`/`ExternalRewardSystemConfigResolver`, out of this
task's own scope) always resolves to the zero-I/O `CoreBankingConnector` stub — the bulk-load-test
choice this task's own instructions explicitly sanction, so the measured numbers characterize this
service's own pipeline, never a real network call to promo-code-service (which was not itself under
load test here); and the tenant/country lookup (`TenantSchemaConfigCache`) is a fixed single-row
fake feeding a *real* `TenantSchemaEnrichmentService`, which still performs its own real claim-time
`UPDATE` against Postgres. Kafka was **not** included in this pass — `T-RR-041` already proved
cross-channel parity (gRPC/Kafka/REST share one identical domain method) at low concurrency, and the
`dispatched_external -> completed` transition this load test measures happens synchronously inside
`CompletionSweepService`, never via the separate Kafka-consuming outbox-publish worker — so Kafka's
own throughput was not this file's own subject. Full source:
`test/e2e/load/load-test.e2e-spec.ts` + `test/e2e/load/load-test-scenarios.ts`; reproduce with
`npx jest --runInBand test/e2e/load/load-test.e2e-spec.ts` (real local Postgres required, already
migrated; Redpanda not required for this file).

**Real run output** (a rate ladder, each step mixing gRPC+REST 50/50, ~10% of each step's own
traffic deliberately resubmitting an already-sent `id` via the *opposite* channel, scheduled as the
very next slot after the original so it races genuinely in-flight processing):

| Step | Target combined rate | Achieved | Attempted | Unique submitted | Completed | Failed | Unresolved | Claim→dispatched-external latency (avg/p50/p95/p99) | Claim→completed latency (avg/p50/p95/p99) |
|---|---|---|---|---|---|---|---|---|---|
| moderate | 50/s | 50.1/s | 250 | 226 | 226 | 0 | 0 | 14.06 / 11.4 / 28.4 / 35.7 ms | 2708 / 2666 / 4831 / 5168 ms |
| high | 150/s | 150.1/s | 750 | 676 | 676 | 0 | 0 | 12.74 / 10.6 / 26.9 / 38.4 ms | 2810 / 2867 / 4990 / 5322 ms |
| very-high | 400/s | 399.6/s | 1600 | 1441 | 1441 | 0 | 0 | 13.8 / 13.7 / 25.1 / 30.5 ms | 2613 / 2611 / 4450 / 4781 ms |
| extreme | 800/s | 799.2/s | 2400 | 2161 | 2161 | 0 | 0 | 8.79 / 5.8 / 31.1 / 54.3 ms | 2366 / 2352 / 3877 / 4244 ms |
| beyond-target | 1600/s | 1595.2/s | 4800 | 4321 | 4321 | 0 | 0 | **2194 / 2518 / 2843 / 2851 ms** | 4063 / 4118 / 5137 / 5490 ms |

REST/gRPC ingestion-acceptance latency itself stayed low and flat at every rate (p50 1-5ms, p99
5-51ms even at the "beyond-target" step) — the inbound transport layer is not what limits throughput
at these rates.

**The 500-1000 RPS target (requirement #3) was reached and exceeded cleanly**, up to 800 combined
req/s with zero errors, zero unresolved rows, zero duplicate/lost rows, and claim-to-dispatched
-external latency flat around 9-14ms (no real degradation signal below 800/s). Pushed deliberately
further, to 1600 combined req/s (double the band's own upper bound, to honestly answer "whatever
ceiling appears as concurrency increases"), a real degradation signal *did* appear: claim-to
-dispatched-external latency jumped roughly 150-200x, from ~10-14ms to ~2.1-2.5s. **This is not an
error, a lost row, or a duplicate** — every single one of the 4,321 unique entries at that step
still reached `completed` correctly, exactly once, inside this step's own drain-wait budget. The
limiting factor at this rate is this test's own chosen `INSTANCE_COUNT = 3` claim-worker instances,
each running one poll loop, beginning to fall behind the rate new `received` rows arrive faster than
three single-threaded claim loops can drain — not Postgres lock contention, not the advisory-lock
mechanism, and not the connector call (a zero-I/O stub here). `05-PROCESSING-PIPELINE.md` §8's own
claim that adding instances scales claim throughput close to linearly is exactly the lever this
finding points back to: a real deployment seeing this latency shape at this rate should add claim
-worker instances (or increase `ClaimWorkerService`'s own `pollIntervalMs`/consider more than one
poll loop per instance), not distrust the underlying claim mechanism.

**Duplicate-arrival correctness (R6) held under real concurrent load at every rate tested**,
including the 1600 combined req/s step: every unique `id` produced exactly one
`reward_redemption_entry` row and exactly one `external_system_call_log` row, even for the ~10% of
traffic that deliberately resent an already-in-flight `id` via the opposite channel from its
original send.

**A note on this environment's own ambient noise, for whoever re-runs this test.** This repo's
build runs under an autonomous multi-agent orchestrator
(`reward-redemption-service-plan/scripts/orchestrator.js --watch`) that can dispatch other agents'
own test runs against this same shared local Postgres instance and the same host's own ephemeral
TCP port range at any time. During this task, two of five total attempts at this exact test showed
transient, non-reproducible failures traceable to that ambient contention — not to this test's own
logic or to a pipeline defect: one from another concurrently-running process holding enough of
Postgres's `max_connections` (100 on this machine) to stall a graceful teardown step (fixed in this
task by bounding every teardown step with its own 15s timeout, §11 below, `load-test.e2e-spec.ts`),
and one from an ephemeral-port collision on the gRPC TLS listener (a classic TOCTOU race on
`listen(0)`-then-close port allocation, more likely to manifest when many concurrent processes on
one machine are doing the same thing at once — not something this task can fix from its own file
scope, and not unique to this test: `T-RR-041`'s own `full-pipeline.e2e-spec.ts` uses the identical
port-allocation pattern). The three other attempts — including the final, currently-committed run
captured in the table above — passed cleanly with zero errors at every rate up to 1600 combined
req/s. If you re-run this file and see a failure that does not match this task's own committed
assertions (zero failed/zero unresolved), check first whether another concurrent process was
sharing this machine's Postgres/network resources before treating it as a pipeline defect.

## 11. Metrics and structured logs

Every process exposes Prometheus-text `/metrics` with `reward_entries_ingested_total{channel}`,
`reward_redemptions_completed_total{system_code}`, `reward_redemptions_failed_total{system_code}`,
`external_system_call_total{system_code,result}`, `reward_tracking_dispatch_tier_total{tier}`,
`notification_logged_total`, `cache_invalidation_total{key}` (`07-CONFIGURABILITY-AND-
OBSERVABILITY.md` §3 — names fixed now so a later dashboard integration is additive, never a
rename). Every log line concerning a reward entry carries `correlationId`/`tenantId`/
`campaignCode`/`rewardEntryId` as separate structured fields, never string-interpolated;
`customerId` is never logged in plaintext — only `customer_id_hash` (R8).

## 12. Known limitations (do not design around a capability that doesn't exist) — every `BACKLOG.md` item

- **B-1 — No Redis/distributed caching.** All five caches (§8) are in-memory, per-instance, with a
  short TTL plus the invalidation endpoint. Deliberately deferred, not an oversight — and this
  task's own load test (§10), run up to double the required RPS band, found **no evidence this
  needs revisiting**: the real degradation signal it did find (§10) traces to claim-worker
  concurrency/poll-interval configuration, not cache/lock contention.
- **B-2 — No real core-banking connector.** `CoreBankingConnector` is a stub with a configurable
  canned outcome, zero real network I/O. The day a real integration is scoped, it replaces the stub
  behind the same `RewardSystemConnector` interface.
- **B-3 — No real reward-tracking-service or push-notification-service exists anywhere in this
  repo.** This service defines and calls the real contracts it would use (§6 above) against neither
  service actually existing; notifications are logged (`notification_log`), never sent.
- **B-4 — No live per-tenant schema split.** `tenant_schema_config` resolves a schema/database name
  per tenant/country/environment, but every tenant this v1 serves shares one `reward_redemption`
  schema today. The resolution path is real; a physical data split is not.
- **B-5 — `test-app/tracking-service` is not wired to call RAP.** Out of scope for this plan
  entirely (touches only `test-app/` and RAP's own already-built gRPC surface, neither of which this
  plan may edit) — a standalone piece of work belonging to `test-app-plan/`.
- **B-6 — RAP's own `REWARD_REDEMPTION_GRPC_PORT` default (`50061`) collides with this service's
  real inbound gRPC port (`50081`).** Flagged, not fixed here (belongs entirely in
  `realtime-activity-processing-service/`, which this plan may not edit) — see §3.1 above.
- **No alerting on an `exhausted` `reward_tracking_dispatch_retry` row** (§6 above) — logged
  loudly, but nothing currently pages an operator. Query the table directly until a real alerting
  integration exists.
- **This load test (§10) did not include Kafka ingestion or the outbound Kafka/REST dispatch tiers**
  in its own measured rates — see §10's own methodology note for why, and re-run with those legs
  included if you need numbers for them specifically.
