# promo-code-service — Handover for the reward-redemption-service team

This document is self-contained: everything you need to integrate against this service — without
opening `promo-code-service-plan/` — is below. It is written by this service's own QA task
(T-PC-043) as the final artifact of the initial build (Waves 0–4).

**Deviation from the task file's literal path.** The task file names this file
`promo-code-service/plan/HANDOVER.md`; that directory does not exist and is not part of this
agent's granted file scope (`agent-promo-qa`'s actual `Edit` grant for this document is
`promo-code-service/docs/handover.md`, from `project.config.json` — the task file's own prose
predates/disagrees with that grant). This file lives at the granted path instead. See
`promo-code-service-plan/reports/T-PC-043-load-test-results.md` for the same note applied to this
task's other artifact.

## 1. What this service does

Generates and issues promo codes on request, either synchronously (gRPC) or asynchronously
(Kafka) — your own choice, per your own reward configuration for a given redemption, not this
service's. Whichever transport a request arrives on, it is handled by the exact same domain
service (`PromoCodeGenerationService`), so both transports have identical business behaviour,
error codes, and idempotency semantics.

This service does **not** decide *whether* a reward is earned or *which* reward to redeem — that
is entirely your own responsibility. Its only job, once you ask, is: resolve the promo-code recipe
bound to the campaign/tracker/component you tell it, generate a collision-free code against that
recipe, persist it, and hand it back (or publish the result, for the async path).

## 2. Choosing a transport

| | gRPC (`GenerateCode`) | Kafka (`generate.requested`/`generate.result`) |
|---|---|---|
| Call shape | Synchronous unary RPC | Async request/response over two topics |
| Best for | Latency-sensitive redemption flows where you need the code in the same request/response cycle | Callers that can tolerate async result delivery and want delivery durability across a broker outage |
| Measured sustained rate (T-PC-043) | **100 req/s tested clean**, p50 ≈ 8–16ms, p99 ≈ 28–44ms — no ceiling found at this rate | **~25 req/s comfortably bounded**; ~40 req/s is this deployment's own outbox-drain ceiling (config-tunable, see §7) |
| Delivery guarantee | Request either succeeds or the RPC fails (gRPC status) — no partial/duplicate risk to handle beyond normal retry-with-same-`correlationId` | At-least-once; safe to redeliver (§5) |

Both are equally correct; pick based on your own latency/durability tradeoff, per
`ARCHITECTURE.md` §6's "per reward configuration" framing — this service does not have a
preferred winner between the two.

**Recommended shadow-traffic pattern**: if introducing this service against production
`reward-redemption-service` traffic gradually, start with the gRPC path on a percentage of
traffic (synchronous, so a shadow failure is immediately visible in the calling request's own
response) before enabling the Kafka path, which fails more silently from the caller's own
perspective (a lost/delayed result surfaces as "no result ever arrived" rather than an immediate
error) — easier to debug integration issues on the synchronous path first.

## 3. gRPC contract

- **Port `50061`** (internal network only), **mTLS required**. Present a client certificate whose
  SAN is on this service's own allowlist (a `grpc_service_grants`-equivalent table, entirely
  private to this service — contact this service's own operators to have your certificate's
  identity added; there is no self-service enrollment API).
- **Proto**: `promo-code-service/proto/promo_code.v1.proto` (package `promocode.v1`, service
  `PromoCodeService`):

```protobuf
service PromoCodeService {
  rpc GenerateCode (GenerateCodeRequest) returns (GenerateCodeResponse);
  rpc ListActivePromoCodeConfigs (ListActivePromoCodeConfigsRequest) returns (PromoCodeConfigList);
}

message GenerateCodeRequest {
  string correlation_id  = 1;
  string tenant_id       = 2;
  string bind_level      = 3;   // "CAMPAIGN" | "TRACKER" | "COMPONENT"
  string bind_ref_id     = 4;
  string customer_id     = 5;
  string merchant_id     = 6;   // optional — empty string if absent
  ActivityContext activity_context = 7;
}

message ActivityContext {
  string amount        = 1;   // decimal-as-string — never a float
  string currency      = 2;
  string metadata_json = 3;   // free-form, opaque, passed through only
}

message GenerateCodeResponse {
  string status              = 1;   // "SUCCESS" | "FAILED"
  string promo_code_id       = 2;
  string code                = 3;
  string reward_value_type   = 4;
  string reward_value        = 5;   // decimal-as-string
  string reward_unit         = 6;
  string expires_at          = 7;   // ISO 8601, empty if none
  string error_code          = 8;
  string error_message       = 9;
}
```

- **Money is always a decimal-formatted string** (`reward_value`, `activity_context.amount`) —
  never parse it as a float; binary floating point cannot represent it exactly.
- **A business failure (`CONFIG_NOT_BOUND`, `CONFIG_INACTIVE`, `GENERATION_EXHAUSTED`,
  `INVALID_REQUEST`, §6) is `status: "FAILED"` in a normal `200`-equivalent response, never a gRPC
  error status.** A gRPC error status (`UNAUTHENTICATED`, `PERMISSION_DENIED`, `UNAVAILABLE`,
  `INTERNAL`) means a transport/auth-layer failure you cannot resolve by inspecting the response
  body (e.g. no/invalid client certificate, server unreachable) — always check `status` in the
  response body first for anything else.
- `ListActivePromoCodeConfigs` is read-only, for discovering which recipes exist without an HTTP
  hop — same data the portal's own `GET /api/v1/promo-code-configs` serves.

## 4. Kafka contract

Naming convention: `promo-code.<event>.v<major-version>`. A breaking payload change is always a
new topic version, never an in-place field reinterpretation.

**Common envelope** (every message on every topic below):

```json
{
  "eventId": "uuid",
  "eventType": "promo-code.generate.requested",
  "eventVersion": "1.0",
  "occurredAt": "2026-09-01T10:00:00.000Z",
  "correlationId": "uuid",
  "tenantId": "uuid",
  "source": "reward-redemption-service",
  "data": { }
}
```

### `promo-code.generate.requested.v1` — you produce, this service consumes

Consumer group: `promo-code-service.generate-requested`. Partition key: `correlationId`.

```json
{
  "bindLevel": "CAMPAIGN",
  "bindRefId": "uuid",
  "customerId": "cust_8213",
  "merchantId": "uuid-or-null",
  "activityContext": { "amount": "49.99", "currency": "USD", "metadata": {} }
}
```

`activityContext` may be omitted entirely for a flat/non-value-bearing reward.

### `promo-code.generate.result.v1` — this service produces, you consume

Partition key: `correlationId` (matches the request that produced it).

```json
{
  "status": "SUCCESS",
  "promoCodeId": "uuid",
  "code": "SAVE10-X7K2Q",
  "rewardValueType": "PERCENTAGE",
  "rewardValue": "10.0000",
  "rewardUnit": "%",
  "expiresAt": "2026-12-01T00:00:00.000Z",
  "errorCode": null,
  "errorMessage": null
}
```

On `FAILED`, every `SUCCESS`-only field above is `null` and `errorCode`/`errorMessage` are
populated (§6). One topic for both outcomes, deliberately — you always match by `correlationId`
regardless of which outcome arrives.

### `promo-code.generate.requested.v1.dlq` — poison messages only

Only for messages that fail to process due to a structural problem (malformed JSON, a missing
required envelope field) — **never** for a legitimate business failure, which is always a normal
`FAILED` result on the result topic instead. Bounded retry (3 attempts, exponential backoff)
before a message lands here. Envelope + `{ "error": "string", "failedAt": "ISO 8601" }`.

## 5. Idempotency contract

`correlationId` is the idempotency key, shared by a request and its eventual result. **A retry
must reuse the same `correlationId`, never mint a new one** — resending with a new `correlationId`
for what is semantically the same redemption attempt will generate (and charge/issue) a second,
distinct code. On receipt, this service checks for an existing `promo_code` row for that
`correlationId` first: if found, it returns/republishes the exact same result rather than
generating again — so a redelivered Kafka message (at-least-once delivery) or a retried gRPC call
after a timeout is always safe to resend verbatim.

## 6. Error codes

| Code | Meaning |
|---|---|
| `CONFIG_NOT_BOUND` | No active `campaign_promo_config` binding exists for the given `(tenantId, bindLevel, bindRefId)` — nothing is bound to that campaign/tracker/component yet. |
| `CONFIG_INACTIVE` | A binding exists, but the promo-code recipe it points to is not `ACTIVE` (e.g. archived). |
| `GENERATION_EXHAUSTED` | Collision-retry ceiling (default 5 attempts) exceeded generating a unique code — extremely rare at normal volumes; see the outbox/rate ceilings in §7 for the load conditions where this becomes more likely. |
| `INVALID_REQUEST` | The request itself failed validation (e.g. an oversized field). |

`errorMessage` is human-readable, for your own logs/support tooling — never parse it
programmatically; only `errorCode` is the stable, machine-readable value.

## 7. Operational characteristics (measured — T-PC-043)

Full methodology and raw run output: `promo-code-service-plan/reports/T-PC-043-load-test-results.md`.

- **gRPC**: 100 req/s sustained tested clean (p50 ≈ 8–16ms, p99 ≈ 28–44ms), no ceiling found at
  that rate in this pass. The next scaling lever if a higher concurrent rate is ever needed is
  this service's own Sequelize connection pool (currently the library default, 5 connections —
  not observed as a bottleneck at 100 req/s).
- **Kafka**: ~25 req/s sustained comfortably bounded; ~40 req/s is this deployment's own
  outbox-publish drain ceiling (poll interval x batch size, both operator-configurable). Above
  that ceiling, result latency degrades (observed p50 rising from ~310ms to ~865ms) but the
  backlog it creates is bounded and fully drains once the burst ends — it does not fail requests,
  it delays their results. If you need a materially higher sustained Kafka rate than ~25–30/s,
  ask this service's operators to raise `OUTBOX_BATCH_SIZE`/lower `OUTBOX_POLL_INTERVAL_MS` first.
- **Metrics**: each of this service's three processes (HTTP, gRPC, Kafka consumer) exposes its
  own Prometheus-text-format `GET /metrics` — `codes_generated_total{transport,outcome}`,
  `generation_duration_seconds{transport}` (histogram), `outbox_pending_count` (gauge, global
  across all tenants), `kafka_consumer_lag` (gauge). Not exposed externally to you directly — for
  this service's own operators' dashboards; mentioned here so you know what signal they'll see if
  you report a problem.
- **Structured logs**: every request/message this service handles carries the same
  `correlationId` end to end in its own JSON log lines (`{"correlationId": "...", "transport":
  "GRPC"|"KAFKA"|"HTTP", ...}`) — the value to hand this service's operators if you need to trace
  a specific request through their logs.

## 8. Known limitations (do not design around a capability that doesn't exist)

- **No pre-generated code pools.** Every code is generated on-demand at request time. A separate
  "bulk-upload a CSV of pre-printed codes and assign one from a pool" model does not exist and is
  not scheduled.
- **Redemption/expiry lifecycle is not tracked here.** This service issues codes (`status` can be
  `ISSUED`, and the schema reserves `REDEEMED`/`EXPIRED`/`CANCELLED`), but nothing in this service
  transitions a code to those later states — that is entirely your own (or
  `reward-tracking-service`'s own) responsibility once you present it. There is no
  expiry-sweep job on this side; `expiresAt` is informational only from this API's own point of
  view.
- **No config-change broadcast topic.** If a promo-code recipe's configuration changes after you
  last read it, there is no push notification — the only place binding/config resolution happens
  synchronously is inside this service's own `GenerateCode` request handling, against its own
  live database, on every request. If you cache `ListActivePromoCodeConfigs` results, be aware
  they can go stale with no invalidation signal.
- **`GENERATION_EXHAUSTED` under sustained heavy load** becomes more likely purely from increased
  collision pressure at volume — not observed in this task's own load-test rates (§7), but a
  real, correlated risk if your own sustained rate materially exceeds the numbers reported here.
