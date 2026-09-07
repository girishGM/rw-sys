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

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
