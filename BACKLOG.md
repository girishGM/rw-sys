# Reward System — Consolidated Backlog

One place for deferred, cross-service decisions across the **whole** reward system — portal,
promo-code-service, realtime-activity-processing-service, reward-redemption-service, and the
brainstorm-stage reward-tracking-service. Each project also keeps its own `BACKLOG.md`
(`project-plan/BACKLOG.md`, `promo-code-service-plan/BACKLOG.md`) for decisions scoped entirely
within that one project — this file is only for items that span more than one, or that don't have
an obvious single home yet. Check here before re-opening a cross-service question from scratch.

Status: `deferred` (agreed, not scheduled) · `decision-needed` (blocked on the product owner) ·
`design-needed` (the shape isn't agreed yet, so no task can be written) · `planned` (a task exists
— linked, not duplicated here).

---

## RS-05 · Real operator/threshold for `RULE_ACTIVITY_VALUE_001` on 3 live campaigns

**Status:** decision-needed · **Raised:** 2026-09-12 (diagnosing `T-RAP-063`)

Confirmed live on Render (tenant 7): 10 `tracker_component_rules` bindings across
`WEEKEND_PROMO_BLITZ`/`SUMMER_CASHBACK_SPRINT`/`REFER_AND_EARN` use
`rule_master.expression = "transaction.amount :operator :value (transaction.currency == :currency)"`
with **no `operator` set** (structurally un-settable today — no `rule_version_id` is pinned, and an
unversioned binding has an empty allowed-operator set per `bindings.service.ts`'s own
`assertOperatorAllowed`) and `value=0`/`currency="MYR"`, which read as untouched form defaults
(`min:0`, first dropdown option), not a deliberately chosen threshold.

**What's needed**: whoever owns these 3 campaigns' reward rules must decide the real comparison
(`>=` is the plausible business intent for "spend at least X," but this is not written down
anywhere retrievable) and a real threshold amount + currency — then get a `rule_version_id` pinned
to each binding so `operator` becomes settable at all. Full context:
`realtime-activity-processing-service-plan/brain-storm/T-RAP-063-rule-expression-binding-diagnosis.md`
§3 (row set A) and §8 (open question 2). Blocks `realtime-activity-processing-service-plan/tasks/T-RAP-064`
from making these 10 bindings pass for real (that task can still ship its resolver mechanism and the
one other real clause type without this landing first).

---

## RS-06 · `merchant_code` is routinely NULL on real activity submissions — is that acceptable?

**Status:** decision-needed · **Raised:** 2026-09-12 (live Render testing via test-app)

Confirmed by direct code read, not a bug: `test-app/frontend/src/features/activity-simulator/
ActivityForm.tsx` treats merchant as a deliberately optional free-text input (no merchant catalog
exists in test-app's model to populate a picker from — a prior, T-010-era decision). Both test-app's
own submission mapping (`rap-client/mapping.ts`) and RAP's ingestion
(`activity-mapping/activity-ingestion.service.ts`) correctly pass through whatever merchant was
typed (or wasn't) — a blank `merchant_code` on `realtime_activity_processing.activity_logs` simply
means no merchant was entered for that submission, exactly as designed today.

**What's needed**: a product decision on whether this is fine for the demo (optional, sometimes
NULL) or whether merchant should become required/defaulted per activity type for more realistic
demo data (and, if so, whether that needs a real merchant catalog in test-app rather than free
text). No task filed pending this decision — filing one before the shape is agreed would guess at
the answer.

---

## RS-01 · Campaign owner contact — schema location

**Status:** decision-needed · **Raised:** 2026-09-07 (reward-tracking-service brainstorm review)

**What's confirmed:** a campaign owner's notification details are configured **at the portal, at
the campaign level**, and a campaign can have **more than one** contact (name + email, at least —
possibly a role/purpose per contact). This is needed so reward-tracking-service's warn-threshold
alerts (`reward-tracking-service-plan/brain-storm/04-API-DESIGN.md` §2.5) have somewhere real to
send a notification.

**What's not yet confirmed:** where this lives in the schema. `reward_config.tenant_campaigns`
(`database/reward_config/reward_config_postgres.sql:374-397`) has `created_by`/`approved_by` —
portal user identifiers, not contact/notification details — and nothing else campaign-owner-shaped
was found in this pass. Most likely shape: a new child table, `campaign_owner_contacts` (or under
`reward_portal`, per R1's "no new DDL on `reward_config`" rule — the same reasoning `T-171` already
applied to `activity_external_codes`), keyed on `campaign_id`, holding one or more
`(name, email, role)` rows.

**Why not filed as a task yet:** needs a direct read of the portal's campaign wizard/schema first,
to confirm this doesn't already exist under a different name before designing a table that
duplicates one. Whoever picks this up: read `portal/back-end/src/modules/campaigns/` end to end for
anything contact/notification-shaped before writing a migration.

---

## RS-02 · Reward-tracking-service ingestion adapters (three-channel-one-domain-method)

**Status:** design-needed · **Raised:** 2026-09-06

Reward Tracking Service (still brainstorm-stage, `reward-tracking-service-plan/brain-storm/`) needs
to receive `reward.redemption.completed.v1` over whichever of Kafka/gRPC/REST a campaign's
`dispatch_channel_config` resolves (`T-RR-062`) — meaning its own inbound side needs the same
three-adapter-one-shared-domain-method shape reward-redemption-service's own ingestion already
proved (`T-RR-010`/`011`/`012`/`013`, R10). Not designed in schema-level detail yet, and can't be
filed as a real task until reward-tracking-service has an actual plan folder (not just
`brain-storm/`) with its own agents/task tracker — tracked here so it isn't lost in the meantime.

---

## RS-03 · Shard count `N` for reward-tracking-service's campaign counter — configurable, not hardcoded

**Status:** deferred (design decided, nothing to build yet — no real RTS code exists) ·
**Raised:** 2026-09-06 · **Made configurable:** 2026-09-08

`reward-tracking-service-plan/brain-storm/02-DATA-MODEL.md` §4 resolves `N` from a `service_config`
key (`tracking.campaignCounterShardCount`, `GLOBAL` scope, same resolution pattern
`reward-redemption-service`'s own `ServiceConfigResolverService` already established), defaulting to
**32** when unseeded. Sizing formula for whoever deploys it:
`N ≈ (RTS's own instance count) × (its own DB pool size per instance) × a safety factor` — the
precise variable is RTS's *own* DB-connection concurrency, not the sender's instance count (a
sender's own dispatch is one row at a time per instance). A simpler alternative — sizing off total
fleet instance count across every backend service, as a rough proxy — is also safe, since
over-provisioning shards costs almost nothing; under-provisioning is the only real risk.
**Confirmed safe to change later with no migration or rehash**: `shard_key` has no semantic meaning
beyond "which row," the read query never assumes a shard-key range, and the table's primary key is
content-addressed — resizing `N` only changes how *future* writes distribute, every existing row
keeps summing correctly. Not filed as a task because no real reward-tracking-service code exists yet
to configure — this is a design decision recorded for whenever that project's real plan starts.

---

## RS-04 · Offline activity processing service — not yet designed at all

**Status:** deferred · **Raised:** 2026-09-05 (reward-tracking-service brainstorm, §01 scope
decision)

Referenced throughout the reward-tracking-service brainstorm as a second reward-issuing service
(alongside `realtime-activity-processing-service`) that doesn't exist yet, planned or built. Whoever
designs it must carry forward one non-negotiable: **its own runtime-owned budget/limit counters,
enforced atomically at grant time, never delegated to reward-tracking-service** — the same
architecture RAP already proves and this whole brainstorm's scope decision (doc 01 §2) depends on.
Flagging here so that lesson isn't rediscovered/re-litigated when that project starts.

---

## Already filed, not duplicated here (for cross-reference only)

These were real, actionable gaps surfaced during the same review pass, but concrete enough to file
as real tasks immediately rather than sit in this backlog:

- **`project-plan/tasks/T-173`** — expiry duration + `reward_kind` exposure on `BoundReward`.
- **`reward-redemption-service-plan/tasks/T-RR-062`/`T-RR-063`** — outbound payload extension
  (tracker/component/merchant/expiry/rewardKind) + gRPC dispatch channel; redemption-time expiry
  computation.
- **`reward-redemption-service-plan/tasks/T-RR-080`/`T-RR-081`** — promo-code-service channel
  precedence config + gRPC connector variant; Kafka request/reply connector variant.
- **`realtime-activity-processing-service-plan/tasks/T-RAP-062`** — stamp `reward_kind` onto
  `reward_entry` from the newly-exposed `BoundReward` field.
