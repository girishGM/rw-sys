/**
 * T-RR-034. `reward_redemption.reward_tracking_dispatch_outbox` (`01-DATABASE.md` §7) —
 * transactional outbox for `reward.redemption.completed.v1` (`02-KAFKA-CONTRACTS.md` §2),
 * identical shape to RAP's own `reward_entry_outbox`/`reward-entry-outbox.repository.ts`
 * (confirmed by direct read, this task's own implementation note 1).
 *
 * `enqueue()` **requires** an externally-supplied `pg.PoolClient` and never opens its own
 * transaction (implementation note 2) — the caller (ultimately `RedemptionStateMachineService`'s
 * own `dispatched_external -> completed` transition, T-RR-021) owns the transaction boundary here,
 * not this repository. Every other method (`findPendingBatch`/`incrementAttempts`/`markPublished`)
 * runs standalone, outside any transaction, via this repository's own small `pg.Pool` — called only
 * by `OutboxPublisherService`'s own poll cycle, best-effort, per `05-PROCESSING-PIPELINE.md` §7
 * ("those two writes are best-effort delivery of an already-true fact").
 *
 * **`payload` never carries a decrypted `customerId` (R8)** — `customerIdEncrypted` only, mirroring
 * `reward_redemption_entry.customer_id_encrypted` itself. `OutboxPublisherService` decrypts it at
 * the point of publish, never earlier, and never persists the decrypted form anywhere
 * (`02-KAFKA-CONTRACTS.md` §2's own "decrypted at the point of publish" convention).
 *
 * **T-RR-035 extends this same file** (both tasks are `agent-rr-integration`'s own) with
 * `toRewardTrackingMessage` (the one shared message-building function all three dispatch tiers
 * now import, implementation note 1) and `markFailed` (the outbox row's own terminal state once
 * both the primary-channel and immediate-fallback attempts are exhausted for it, TC-5) — same
 * "extra export added when the implementation genuinely needs it, inside this agent's own
 * `dispatch/**` scope grant" precedent this file's own header already establishes for
 * `dispatch.config.ts`/`DispatchMetricsService`.
 *
 * **T-RR-062 extends this same file's own `RewardTrackingDispatchPayload`/`buildOutboxPayload`**
 * with six new fields (`trackerCode`/`trackerComponentCode`/`merchantCode`/`expiresAt`/
 * `rewardKind`/`promoCodeConfigId`/`promoCodeConfigVersionNo` — seven, per that task's own
 * "implementation note 1" counting) — purely additive: every pre-existing field keeps its name,
 * type and position. `trackerCode`/`trackerComponentCode`/`merchantCode` were already read off this
 * same `entry` row elsewhere in this file (`FIND_PENDING_BATCH_SQL`'s own join, for channel
 * *resolution*) but never projected into the outbound *message* until now. `expiresAt` reads
 * `entry.expires_at?.toISOString() ?? null` (`T-RR-063`'s own column, migration `020`, never
 * previously wired into this payload). `rewardKind`/`promoCodeConfigId`/`promoCodeConfigVersionNo`
 * read `entry.reward_kind`/`entry.promo_code_config_id`/`entry.promo_code_config_version_no ?? null`
 * (migration `022`) — all three stay `null` on every row until
 * `realtime-activity-processing-service-plan/tasks/T-RAP-062` lands (still `pending` as of this
 * task) and this service's own Wave 1 ingestion is separately extended to read them; never
 * fabricated in the meantime (T-RR-062's own implementation notes 1a/1b).
 *
 * **T-INT-051 extends this same file** with the fix for the poison-row FIFO-starvation defect
 * (`reward-service-integration-plan/tasks/T-INT-051-*.md`): `OutboxPublisherService.processRowSafely`
 * catches a row that throws *before* any dispatch attempt is even made (a decrypt failure, a
 * `dispatchResolver.resolve` rejection) and, until this task, simply left that row `PENDING` with
 * `attempts` untouched forever — no bound at all, so the very oldest such row(s) permanently
 * occupied every poll cycle's `FIND_PENDING_BATCH_SQL` batch slots (this session's own live
 * evidence: 24,307 such rows). `recordPreDispatchFailure` (below) is the new, single atomic
 * counter-and-maybe-poison operation for exactly that path — increments `attempts`, records
 * `last_error` for operator visibility (TC-3), and flips `status` to the new terminal
 * `'POISONED'` value in the same statement once the caller-supplied threshold is reached.
 * `FIND_PENDING_BATCH_SQL`'s own `WHERE o.status = 'PENDING'` already excludes any non-`'PENDING'`
 * status, `'POISONED'` included, with no query change needed. `findPoisoned` is this task's own
 * chosen TC-3 operator-audit mechanism — a plain, narrow read query (over a dedicated admin
 * endpoint, which is a distinct, heavier unit of work this task's own Scope leaves to the
 * implementer's discretion, noted in the completion report).
 */
import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';
import type { Config } from '@/config/config.schema';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';
import type { RewardTrackingDispatchOutboxRow } from '@/database/models/reward-tracking-dispatch-outbox.model';

/**
 * `02-KAFKA-CONTRACTS.md` §2's own JSON shape, camelCase, with `customerIdEncrypted` standing in
 * for the eventual `customerId` field until the point of publish (this file's own header).
 * `externalSystemCode`/`externalReferenceId` are typed nullable — unlike the doc's own worked
 * example (which happens to show a connector-backed redemption), `05-PROCESSING-PIPELINE.md` §2's
 * direct `processing -> completed` path (no connector resolved at all) leaves both `NULL` on
 * `reward_redemption_entry` itself, and this payload must carry that faithfully rather than
 * inventing a placeholder value.
 */
export interface RewardTrackingDispatchPayload {
  rewardEntryId: string;
  tenantId: number;
  tenantCode: string;
  countryCode: string;
  customerIdEncrypted: string;
  campaignCode: string;
  rewardCode: string;
  rewardCategory: string;
  rewardValue: string;
  rewardValueUnit: string;
  externalSystemCode: string | null;
  externalReferenceId: string | null;
  redeemedAt: string;
  correlationId: string;
  /** T-RR-062. Already read off this same entry row elsewhere in this file for channel
   * *resolution* (`FIND_PENDING_BATCH_SQL`'s own join) — this is the first place it is also
   * projected into the outbound *message* itself. */
  trackerCode: string;
  trackerComponentCode: string;
  merchantCode: string | null;
  /** T-RR-062. `entry.expires_at?.toISOString() ?? null` — `T-RR-063`'s own column (migration
   * `020`), never previously wired into this payload. `null` when the reward never expires, or
   * when the resolved config it would derive from didn't exist yet at redemption time. */
  expiresAt: string | null;
  /** T-RR-062 (implementation note 1a). Distinguishes a `PERCENTAGE` reward's `rewardValue` (a
   * rate, never meaningfully summable) from a `FIXED_AMOUNT`/`POINTS` reward's (a real, additive
   * amount) and from a `PROMO_CODE` reward (tracked as the code itself). `null` until
   * `realtime-activity-processing-service-plan/tasks/T-RAP-062` lands and this service's own
   * ingestion is extended to read it — never fabricated. */
  rewardKind: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'POINTS' | 'PROMO_CODE' | null;
  /** T-RR-062 (implementation note 1b). Which promo-code recipe/version produced a
   * `rewardKind: 'PROMO_CODE'` entry — `null` otherwise, and `null` for every entry until the same
   * cross-repo blocker as `rewardKind` above lands. This service only persists and forwards
   * whatever version RAP already stamped; it never resolves one itself (`T-RR-082`'s own, distinct
   * scope). */
  promoCodeConfigId: string | null;
  promoCodeConfigVersionNo: number | null;
}

/**
 * Builds the outbox payload off an already-enriched `reward_redemption_entry` row
 * (`01-DATABASE.md` §1). `tenant_code`/`country_code` are only ever `NULL` before
 * `06-CACHING-AND-TENANT-CONFIG.md` §5's enrichment step runs (Wave 2, T-RR-022) — by the time an
 * entry reaches `dispatched_external`/`completed`, that enrichment has already happened earlier in
 * the same pipeline run, so a `NULL` here is a genuine invariant violation worth throwing loudly
 * on, never a value this function silently tolerates or defaults. Likewise `redeemed_at` is only
 * ever `NULL` before the `-> dispatched_external`/`-> completed` transition itself sets it
 * (`05-PROCESSING-PIPELINE.md` §6 step 1) — this function must only ever be called after that.
 */
export function buildOutboxPayload(entry: RewardRedemptionEntryRow): RewardTrackingDispatchPayload {
  if (entry.tenant_code === null || entry.country_code === null) {
    throw new Error(
      `reward_redemption_entry ${entry.id} has no tenant_code/country_code enrichment yet — ` +
        "06-CACHING-AND-TENANT-CONFIG.md §5's enrichment step must run before an entry can reach " +
        'the reward_tracking_dispatch_outbox.',
    );
  }
  if (entry.redeemed_at === null) {
    throw new Error(
      `reward_redemption_entry ${entry.id} has no redeemed_at set — cannot enqueue a ` +
        'reward_tracking_dispatch_outbox row before the redemption itself has been redeemed.',
    );
  }
  return {
    rewardEntryId: entry.id,
    tenantId: entry.tenant_id,
    tenantCode: entry.tenant_code,
    countryCode: entry.country_code,
    customerIdEncrypted: entry.customer_id_encrypted,
    campaignCode: entry.campaign_code,
    rewardCode: entry.reward_code,
    rewardCategory: entry.reward_category,
    rewardValue: entry.reward_value,
    rewardValueUnit: entry.reward_value_unit,
    externalSystemCode: entry.external_system_code,
    externalReferenceId: entry.external_reference_id,
    redeemedAt: entry.redeemed_at.toISOString(),
    correlationId: entry.correlation_id,
    trackerCode: entry.tracker_code,
    trackerComponentCode: entry.tracker_component_code,
    merchantCode: entry.merchant_code,
    expiresAt: entry.expires_at?.toISOString() ?? null,
    rewardKind: entry.reward_kind ?? null,
    promoCodeConfigId: entry.promo_code_config_id ?? null,
    promoCodeConfigVersionNo: entry.promo_code_config_version_no ?? null,
  };
}

/**
 * T-RR-035 implementation note 1: "reuse the exact same payload-building code T-RR-034 wrote for
 * the Kafka leg (import it, don't duplicate it) so the two channels can never silently drift in
 * shape." This is that one shared function — the single place `customerIdEncrypted` is swapped
 * for the already-decrypted `customerId` (R8) — imported by `OutboxPublisherService` (both the
 * Kafka and REST attempts in the same poll cycle), `RewardTrackingRestClient`'s own callers, and
 * `RewardTrackingDispatchRetryWorker` alike, so all three tiers build byte-identical message
 * bodies off the same `RewardTrackingDispatchPayload`.
 */
export function toRewardTrackingMessage(
  payload: RewardTrackingDispatchPayload,
  customerId: string,
): Record<string, unknown> {
  const { customerIdEncrypted: _omit, ...rest } = payload;
  return { ...rest, customerId };
}

/** The narrow shape `OutboxPublisherService`'s poll cycle actually needs per row — deliberately
 * not `SELECT *` (same discipline RAP's own `OutboxPendingRow` documents), plus the three
 * `dispatch_channel_config` resolution fields (`reward_code`/`tracker_code`/`campaign_code`/
 * `tenant_id`) read off the *entry* row via a join, never off `payload` itself — `payload` is the
 * fixed, external, downstream-facing message shape (`02-KAFKA-CONTRACTS.md` §2), which has no
 * `trackerCode` field at all; resolution needs it, the outbound message does not. */
export interface OutboxPendingRow {
  id: string;
  rewardEntryId: string;
  topic: string;
  payload: RewardTrackingDispatchPayload;
  attempts: number;
  createdAt: Date;
  rewardCode: string;
  trackerCode: string;
  campaignCode: string;
  tenantId: number;
}

interface OutboxPendingRowRaw {
  id: string;
  reward_entry_id: string;
  topic: string;
  payload: RewardTrackingDispatchPayload;
  attempts: number;
  created_at: Date;
  reward_code: string;
  tracker_code: string;
  campaign_code: string;
  tenant_id: number;
}

/** T-INT-051 TC-3. The narrow shape `findPoisoned()` returns — an operator-audit read, not a
 * dispatch-decision one, so it carries `lastError`/`updatedAt` (when it was poisoned, and why)
 * rather than `findPendingBatch`'s own dispatch-resolution fields. */
export interface PoisonedOutboxRow {
  id: string;
  rewardEntryId: string;
  attempts: number;
  lastError: string | null;
  updatedAt: Date;
}

interface PoisonedOutboxRowRaw {
  id: string;
  reward_entry_id: string;
  attempts: number;
  last_error: string | null;
  updated_at: Date;
}

/** T-INT-051. Outcome of a single `recordPreDispatchFailure` call — `attempts` is the
 * post-increment count, `poisoned` is `true` exactly when this call's own increment pushed the
 * row across the caller-supplied threshold (i.e. `status` is now `'POISONED'`). */
export interface PreDispatchFailureOutcome {
  attempts: number;
  poisoned: boolean;
}

const ENQUEUE_SQL = `
  INSERT INTO reward_redemption.reward_tracking_dispatch_outbox (reward_entry_id, payload)
  VALUES ($1, $2)
  RETURNING *
`;

const FIND_PENDING_BATCH_SQL = `
  SELECT o.id, o.reward_entry_id, o.topic, o.payload, o.attempts, o.created_at,
         e.reward_code, e.tracker_code, e.campaign_code, e.tenant_id
    FROM reward_redemption.reward_tracking_dispatch_outbox o
    JOIN reward_redemption.reward_redemption_entry e ON e.id = o.reward_entry_id
   WHERE o.status = 'PENDING'
   ORDER BY o.created_at ASC
   LIMIT $1
`;

/**
 * T-INT-051. One atomic increment-and-maybe-poison step for the "threw before any dispatch
 * attempt was even made" failure path (`OutboxPublisherService.processRowSafely`'s own catch
 * block) — deliberately a single `UPDATE ... RETURNING`, not a read-then-write pair, so a
 * concurrent poll cycle (there is only ever one `OutboxPublisherService` instance polling in this
 * service today, but this repository makes no such assumption for its own callers) can never
 * observe or produce a torn intermediate state between the increment and the terminal-status
 * flip. `status = CASE WHEN attempts + 1 >= $3 THEN 'POISONED' ELSE status END` reads `attempts`
 * pre-increment (the column's value at the time this statement starts), so `+ 1` accounts for the
 * increment this same statement is about to apply — the returned `attempts` (already
 * post-increment, per the `SET attempts = attempts + 1` clause) and the returned `status` are
 * therefore always consistent with each other.
 */
const RECORD_PRE_DISPATCH_FAILURE_SQL = `
  UPDATE reward_redemption.reward_tracking_dispatch_outbox
     SET attempts = attempts + 1,
         last_error = $2,
         status = CASE WHEN attempts + 1 >= $3 THEN 'POISONED' ELSE status END,
         updated_at = now()
   WHERE id = $1
  RETURNING attempts, status
`;

/** TC-3's own operator-audit read: every currently-`'POISONED'` row, most-recently-poisoned
 * first, so an operator can see (and, outside this task's own scope, act on) exactly which rows
 * this bounding mechanism has permanently excluded from `findPendingBatch` and why
 * (`last_error`). */
const FIND_POISONED_SQL = `
  SELECT id, reward_entry_id, attempts, last_error, updated_at
    FROM reward_redemption.reward_tracking_dispatch_outbox
   WHERE status = 'POISONED'
   ORDER BY updated_at DESC
   LIMIT $1
`;

@Injectable()
export class RewardTrackingOutboxRepository implements OnModuleDestroy {
  private readonly pool: Pool;

  /** Second constructor parameter exists solely so a test can substitute a real (test-owned) or
   * fake `Pool` — same `@Optional()` idiom every repository in this service already uses. */
  constructor(config: ConfigService<Config, true>, @Optional() pool?: Pool) {
    this.pool =
      pool ??
      new Pool({
        host: config.get('DB_HOST', { infer: true }),
        port: config.get('DB_PORT', { infer: true }),
        database: config.get('DB_NAME', { infer: true }),
        user: config.get('DB_APP_USERNAME', { infer: true }),
        password: config.get('DB_APP_PASSWORD', { infer: true }),
        ssl: config.get('DB_SSL', { infer: true }) ? { rejectUnauthorized: false } : undefined,
      });
  }

  /**
   * TC-1: writes a `PENDING`, `attempts = 0` row (the table's own defaults) using the caller's own
   * open transaction/connection (`client`) — never this repository's own pool, so the insert
   * commits or rolls back atomically with whatever else that transaction is doing.
   */
  async enqueue(
    client: PoolClient,
    rewardEntry: RewardRedemptionEntryRow,
  ): Promise<RewardTrackingDispatchOutboxRow> {
    const payload = buildOutboxPayload(rewardEntry);
    const result = await client.query<RewardTrackingDispatchOutboxRow>(ENQUEUE_SQL, [
      rewardEntry.id,
      JSON.stringify(payload),
    ]);
    const inserted = result.rows[0];
    if (inserted === undefined) {
      throw new Error(
        `reward_tracking_dispatch_outbox insert for reward_entry ${rewardEntry.id} returned no ` +
          'row (structurally unreachable — a plain INSERT with no ON CONFLICT clause).',
      );
    }
    return inserted;
  }

  /** TC-8/TC-9: `WHERE status = 'PENDING'` — a `PUBLISHED` row (or a `FAILED` one, once T-RR-035
   * introduces that transition) is never returned again, no matter how many poll cycles run. */
  async findPendingBatch(batchSize: number): Promise<OutboxPendingRow[]> {
    const result = await this.pool.query<OutboxPendingRowRaw>(FIND_PENDING_BATCH_SQL, [batchSize]);
    return result.rows.map((row) => ({
      id: row.id,
      rewardEntryId: row.reward_entry_id,
      topic: row.topic,
      payload: row.payload,
      attempts: row.attempts,
      createdAt: row.created_at,
      rewardCode: row.reward_code,
      trackerCode: row.tracker_code,
      campaignCode: row.campaign_code,
      tenantId: row.tenant_id,
    }));
  }

  /** TC-2: a Kafka publish attempt failed, but the row itself stays `PENDING` for the next poll
   * cycle (or T-RR-035's own REST tier, once its own attempt threshold is reached). */
  async incrementAttempts(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE reward_redemption.reward_tracking_dispatch_outbox
          SET attempts = attempts + 1, updated_at = now()
        WHERE id = $1`,
      [id],
    );
  }

  /** TC-1/TC-8: delivered — this row's own eligibility for `findPendingBatch` ends here. */
  async markPublished(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE reward_redemption.reward_tracking_dispatch_outbox
          SET status = 'PUBLISHED', attempts = attempts + 1, updated_at = now()
        WHERE id = $1`,
      [id],
    );
  }

  /**
   * T-RR-035 TC-5: both the primary-channel attempt(s) and the immediate fallback attempt have
   * failed for this row — a `reward_tracking_dispatch_retry` (tier 3) row has been written to take
   * over, and this outbox row's own `findPendingBatch` eligibility ends here permanently (unlike
   * `incrementAttempts`, which leaves the row `PENDING` for a later cycle). `01-DATABASE.md` §7's
   * own `status` comment names `'FAILED'` as the third value alongside `'PENDING'`/`'PUBLISHED'`
   * for exactly this terminal-for-the-outbox-but-not-for-the-redemption state.
   */
  async markFailed(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE reward_redemption.reward_tracking_dispatch_outbox
          SET status = 'FAILED', attempts = attempts + 1, updated_at = now()
        WHERE id = $1`,
      [id],
    );
  }

  /**
   * T-INT-051. Called only from `OutboxPublisherService.processRowSafely`'s own catch block — the
   * "threw before any dispatch attempt was even made" path (`processRowSafely`'s own header),
   * never from the normal per-channel-attempt tier-selection flow (`incrementAttempts` remains the
   * right call there, unchanged). `maxAttemptsBeforePoison` is resolved by the caller once per
   * poll cycle (`dispatch.config.ts`'s own `resolveOutboxMaxPreDispatchFailures`), not by this
   * repository, which stays a thin, policy-free data-access layer.
   */
  async recordPreDispatchFailure(
    id: string,
    lastError: string,
    maxAttemptsBeforePoison: number,
  ): Promise<PreDispatchFailureOutcome> {
    const result = await this.pool.query<{ attempts: number; status: string }>(
      RECORD_PRE_DISPATCH_FAILURE_SQL,
      [id, lastError, maxAttemptsBeforePoison],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(
        `reward_tracking_dispatch_outbox row "${id}" not found while recording a ` +
          'pre-dispatch failure (structurally unreachable — the caller just read this id off ' +
          'findPendingBatch).',
      );
    }
    return { attempts: row.attempts, poisoned: row.status === 'POISONED' };
  }

  /** TC-3. Operator-audit read — see this file's own `FIND_POISONED_SQL` header. */
  async findPoisoned(limit = 100): Promise<PoisonedOutboxRow[]> {
    const result = await this.pool.query<PoisonedOutboxRowRaw>(FIND_POISONED_SQL, [limit]);
    return result.rows.map((row) => ({
      id: row.id,
      rewardEntryId: row.reward_entry_id,
      attempts: row.attempts,
      lastError: row.last_error,
      updatedAt: row.updated_at,
    }));
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
