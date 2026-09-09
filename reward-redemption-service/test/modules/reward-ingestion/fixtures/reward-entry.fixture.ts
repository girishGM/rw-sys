/**
 * T-RR-014. **One canonical fixture entry, expressed exactly once**, converted into each of the
 * three transport-specific envelopes (implementation note 1) — a real gRPC `RewardEntry` message
 * (`toGrpcRewardEntry`), a real Kafka `reward.entry.created.v1` JSON payload (`toKafkaMessageValue`),
 * and a real REST `POST /api/v1/reward-entries` JSON body (`toRestRequestBody`). Every converter
 * reads from the same `CanonicalFixtureEntry` object, so a parity failure surfaces as "the
 * gRPC-derived row differs from the REST-derived row", never as three independently hand-typed
 * fixtures that already disagree before either channel's own code runs at all.
 *
 * Field set and types mirror `03-GRPC-CONTRACT.md` §1 / `02-KAFKA-CONTRACTS.md` §1 /
 * `04-REST-CONTRACT.md` §1's own wire shapes exactly — every date is an ISO-8601 string with an
 * explicit UTC offset (never a `Date`, since all three wire formats carry dates as strings; each
 * adapter's own `parseIsoDateWithOffset` call is what turns it into a `Date` downstream), every
 * decimal is a string at `decimal(18,4)`'s own scale (`002_create_reward_redemption_entry.ts`), and
 * `tenantId`/`completionCycle` are the two genuine numeric fields, matching every one of
 * `RewardEntryProto`/the Kafka JSON example/`RewardEntryRequestDto`.
 *
 * No `any`, no `@ts-ignore` anywhere in this file (R2).
 */
import { randomUUID } from 'node:crypto';
import type { RewardEntryProto } from '@/grpc/reward-ingest.grpc.types';
import type { IngestionChannel } from '@/modules/reward-ingestion/reward-entry-ingest.dto';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';

/** The one shape every converter below reads from — camelCase, every field a wire-level primitive
 * (`string`/`number`), never a `Date` (see this file's own header). */
export interface CanonicalFixtureEntry {
  id: string;
  correlationId: string;
  tenantId: number;
  customerId: string;
  customerIdType: string;
  activityPerformedDate: string;
  transactionType: string | null;
  activityCode: string | null;
  activityType: string;
  activityCategory: string;
  activityValue: string;
  activityValueUnit: string;
  channel: string;
  activityPerformedEnv: string;
  activityName: string;
  campaignCode: string;
  trackerCode: string;
  trackerComponentCode: string;
  merchantCode: string | null;
  rewardCode: string;
  rewardCategory: string;
  rewardValue: string;
  rewardValueUnit: string;
  rewardEntryDate: string;
  completionCycle: number;
}

/**
 * Builds a fresh canonical fixture entry (a new `id`/`correlationId`/`customerId` every call, so
 * distinct scenarios never collide on the table's own unique constraint by accident) for the given
 * `tenantId`. `overrides` lets a scenario deliberately vary one field (e.g. a distinct
 * `campaignCode` per test) while keeping everything else — and every derived wire envelope —
 * identical to this one source of truth.
 */
export function buildCanonicalFixtureEntry(
  tenantId: number,
  overrides: Partial<CanonicalFixtureEntry> = {},
): CanonicalFixtureEntry {
  return {
    id: randomUUID(),
    correlationId: randomUUID(),
    tenantId,
    customerId: `cust-${randomUUID()}`,
    customerIdType: 'MSISDN',
    activityPerformedDate: '2026-09-04T10:15:00Z',
    transactionType: null,
    activityCode: 'TXN_TOPUP',
    activityType: 'TOPUP',
    activityCategory: 'TELCO',
    activityValue: '50.0000',
    activityValueUnit: 'MYR',
    channel: 'app',
    activityPerformedEnv: 'production',
    activityName: 'Prepaid Top-up',
    campaignCode: 'CAMP-2026-Q3-001',
    trackerCode: 'TRK-TOPUP-5X',
    trackerComponentCode: 'CMP-TOPUP-STEP-3',
    merchantCode: 'MERCH-001',
    rewardCode: 'RWD-CASHBACK-5PCT',
    rewardCategory: 'CASHBACK',
    rewardValue: '2.5000',
    rewardValueUnit: 'MYR',
    rewardEntryDate: '2026-09-04T10:15:03Z',
    completionCycle: 1,
    ...overrides,
  };
}

/** `RewardEntry` proto message (`03-GRPC-CONTRACT.md` §1) — proto3 optional string fields are
 * simply omitted (never sent as an empty string) when the canonical entry's own value is `null`,
 * exactly as `RewardIngestController.toIngestDto`'s own `emptyToNull` expects on the way back. */
export function toGrpcRewardEntry(fixture: CanonicalFixtureEntry): RewardEntryProto {
  return {
    id: fixture.id,
    correlationId: fixture.correlationId,
    tenantId: fixture.tenantId,
    customerId: fixture.customerId,
    customerIdType: fixture.customerIdType,
    activityPerformedDate: fixture.activityPerformedDate,
    ...(fixture.transactionType !== null ? { transactionType: fixture.transactionType } : {}),
    ...(fixture.activityCode !== null ? { activityCode: fixture.activityCode } : {}),
    activityType: fixture.activityType,
    activityCategory: fixture.activityCategory,
    activityValue: fixture.activityValue,
    activityValueUnit: fixture.activityValueUnit,
    channel: fixture.channel,
    activityPerformedEnv: fixture.activityPerformedEnv,
    activityName: fixture.activityName,
    campaignCode: fixture.campaignCode,
    trackerCode: fixture.trackerCode,
    trackerComponentCode: fixture.trackerComponentCode,
    ...(fixture.merchantCode !== null ? { merchantCode: fixture.merchantCode } : {}),
    rewardCode: fixture.rewardCode,
    rewardCategory: fixture.rewardCategory,
    rewardValue: fixture.rewardValue,
    rewardValueUnit: fixture.rewardValueUnit,
    rewardEntryDate: fixture.rewardEntryDate,
    completionCycle: fixture.completionCycle,
  };
}

/** `reward.entry.created.v1` JSON payload (`02-KAFKA-CONTRACTS.md` §1) — that contract's own JSON
 * example shows optional fields present with an explicit `null`, never omitted, so this converter
 * (unlike `toGrpcRewardEntry` above) serializes the canonical entry's fields verbatim, `null`s
 * included. */
export function toKafkaMessageValue(fixture: CanonicalFixtureEntry): string {
  return JSON.stringify(fixture);
}

/** `POST /api/v1/reward-entries` JSON body (`04-REST-CONTRACT.md` §1) — same camelCase shape as the
 * canonical entry itself, `null`s included (`reward-entry-request.dto.ts`'s own zod schema accepts
 * `null` for the same three optional fields). */
export function toRestRequestBody(fixture: CanonicalFixtureEntry): Record<string, unknown> {
  return { ...fixture };
}

/**
 * Every `reward_redemption_entry` column the ingestion path (T-RR-010) is responsible for
 * populating from a `CanonicalFixtureEntry`, keyed exactly as `RewardRedemptionEntryRow` declares
 * them — everything except `id`/`customer_id_encrypted`/`customer_id_hash` (verified separately:
 * `id` varies by design across scenarios, and `customerId` is never stored in plaintext, R8) and the
 * claim-time enrichment / bookkeeping columns (`country_code`, `tenant_code`, `reward_processed_env`
 * — stamped from this instance's own `NODE_ENV`, not the fixture — `status`, `retry_count`,
 * `next_attempt_at`, `last_error_code`, `last_error_message`, `last_attempted_at`,
 * `external_system_code`, `external_reference_id`, `redeemed_at`, `created_at`, `updated_at`,
 * `activity_performed_date`, `reward_entry_date` — timestamps compared separately since Postgres
 * returns them as `Date`, not the fixture's own ISO string).
 *
 * This is deliberately a `Partial<RewardRedemptionEntryRow>` rather than a bespoke type — every key
 * here is checked against the real row type at compile time, so a column rename in the model file
 * is a compile error here too, not a silently-stale comparison.
 */
export function expectedRowFields(
  fixture: CanonicalFixtureEntry,
  ingestionChannel: IngestionChannel,
): Partial<RewardRedemptionEntryRow> {
  return {
    correlation_id: fixture.correlationId,
    tenant_id: fixture.tenantId,
    customer_id_type: fixture.customerIdType,
    transaction_type: fixture.transactionType,
    activity_code: fixture.activityCode,
    activity_type: fixture.activityType,
    activity_category: fixture.activityCategory,
    activity_value: fixture.activityValue,
    activity_value_unit: fixture.activityValueUnit,
    channel: fixture.channel,
    activity_performed_env: fixture.activityPerformedEnv,
    activity_name: fixture.activityName,
    campaign_code: fixture.campaignCode,
    tracker_code: fixture.trackerCode,
    tracker_component_code: fixture.trackerComponentCode,
    merchant_code: fixture.merchantCode,
    reward_code: fixture.rewardCode,
    reward_category: fixture.rewardCategory,
    reward_value: fixture.rewardValue,
    reward_value_unit: fixture.rewardValueUnit,
    completion_cycle: fixture.completionCycle,
    ingestion_channel: ingestionChannel,
  };
}
