/**
 * T-RAP-034. `reward_entry_outbox` — transactional outbox, Kafka leg (`01-DATABASE.md` §8), same
 * proven pattern as `promo_code.promo_code_outbox` (`promo-code-service/src/modules/outbox/`,
 * referenced directly by `05-PROCESSING-PIPELINE.md` §7 point 1). `insertPending` is called
 * transactionally, inside the exact same transaction `RewardEntryRepository.insertForGrantedAssignment`
 * just committed a row into (T-RAP-034's own "same transaction, same commit" — `reward_entry`
 * inserted first so this row's `reward_entry_id` FK always resolves). Every other method here is
 * called **outside** that transaction, standalone, by `dispatch/outbox-publisher.service.ts`'s own
 * poll cycle (`05-PROCESSING-PIPELINE.md` §7: "outside the domain transaction, best-effort").
 *
 * Reuses `PROCESSING_SEQUELIZE` for the same reason `reward-entry.repository.ts`'s own header
 * gives — `insertPending` must share the caller's exact transaction/connection. The dispatch-side
 * callers (`dispatch.module.ts`) reuse the same connection too, purely to avoid opening a second
 * Postgres pool for a table this small (no transaction of the processing pipeline's own is ever
 * touched by those calls, since none of them pass a `Transaction` in).
 *
 * `payload` never carries a decrypted `customerId` (R4) — `customerIdEncrypted` only, mirroring
 * every other field `reward_entry` itself stores. `OutboxPublisherService`/`RewardGrpcFallbackClient`
 * decrypt it at the point of publish, never earlier, and never persist the decrypted form anywhere
 * (`02-KAFKA-CONTRACTS.md` §3, this file's own `RewardEntryOutboxPayload` doc comment).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize, Transaction } from 'sequelize';
import { QueryTypes } from 'sequelize';
import type { RewardEntryRow } from '@/database/models/reward-entry.model';
import type { RewardEntryOutboxRow } from '@/database/models/reward-entry-outbox.model';
import { PROCESSING_SEQUELIZE } from '@/modules/processing/activity-log-claim.repository';

/** `reward.entry.created.v1`'s own topic name (`02-KAFKA-CONTRACTS.md` §3). */
export const REWARD_ENTRY_CREATED_TOPIC = 'reward.entry.created.v1';

/**
 * The full `reward_entry` row shape as JSON (`02-KAFKA-CONTRACTS.md` §3: "the full `reward_entry`
 * row shape ... as JSON"), camelCase (this service's own JS/proto convention throughout), minus
 * `customerIdHash` (internal-only, never part of a message this service publishes) and with
 * `customerIdEncrypted` standing in for the eventual `customerId` field until the point of publish
 * (this file's own header).
 */
export interface RewardEntryOutboxPayload {
  id: string;
  correlationId: string;
  tenantId: number;
  customerIdEncrypted: string;
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

export function buildOutboxPayload(row: RewardEntryRow): RewardEntryOutboxPayload {
  return {
    id: row.id,
    correlationId: row.correlation_id,
    tenantId: row.tenant_id,
    customerIdEncrypted: row.customer_id_encrypted,
    customerIdType: row.customer_id_type,
    activityPerformedDate: new Date(row.activity_performed_date).toISOString(),
    transactionType: row.transaction_type,
    activityCode: row.activity_code,
    activityType: row.activity_type,
    activityCategory: row.activity_category,
    activityValue: row.activity_value,
    activityValueUnit: row.activity_value_unit,
    channel: row.channel,
    activityPerformedEnv: row.activity_performed_env,
    activityName: row.activity_name,
    campaignCode: row.campaign_code,
    trackerCode: row.tracker_code,
    trackerComponentCode: row.tracker_component_code,
    merchantCode: row.merchant_code,
    rewardCode: row.reward_code,
    rewardCategory: row.reward_category,
    rewardValue: row.reward_value,
    rewardValueUnit: row.reward_value_unit,
    rewardEntryDate: new Date(row.reward_entry_date).toISOString(),
    completionCycle: row.completion_cycle,
  };
}

/** The narrow shape `OutboxPublisherService`'s poll cycle actually needs per row — deliberately not
 * `SELECT *`, same discipline `promo-code-service`'s own `OutboxRepository.findPendingBatch`
 * documents for its sibling. */
export interface OutboxPendingRow {
  id: string;
  rewardEntryId: string;
  topic: string;
  payload: RewardEntryOutboxPayload;
  attempts: number;
  createdAt: Date;
}

/** Same T-PC-045 precedent (`promo-code-service`'s own `OutboxRepository.findPendingBatch` doc
 * comment): an optional constraint so a caller that already knows which rows it just created can
 * drain only those, without also racing a concurrently-running, unrelated test's own row on this
 * same globally-shared table (`test/modules/dispatch/*.spec.ts`'s own concern, not a production
 * one — every production poll cycle omits `scope` and gets the prior global query back). */
export interface OutboxBatchScope {
  rowIds: string[];
}

interface OutboxPendingRowRaw {
  id: string;
  reward_entry_id: string;
  topic: string;
  payload: RewardEntryOutboxPayload;
  attempts: number;
  created_at: Date;
}

@Injectable()
export class RewardEntryOutboxRepository {
  constructor(@Inject(PROCESSING_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /** TC-1: written in the same transaction as the `reward_entry` row it references — always
   * `PENDING`, `attempts = 0` (the table's own defaults). */
  async insertPending(
    transaction: Transaction,
    rewardEntry: RewardEntryRow,
  ): Promise<RewardEntryOutboxRow> {
    const rows = await this.sequelize.query<RewardEntryOutboxRow>(
      `INSERT INTO realtime_activity_processing.reward_entry_outbox
         (reward_entry_id, topic, payload)
       VALUES (:rewardEntryId, :topic, :payload)
       RETURNING *`,
      {
        type: QueryTypes.SELECT,
        transaction,
        replacements: {
          rewardEntryId: rewardEntry.id,
          topic: REWARD_ENTRY_CREATED_TOPIC,
          payload: JSON.stringify(buildOutboxPayload(rewardEntry)),
        },
      },
    );
    const inserted = rows[0];
    if (inserted === undefined) {
      throw new Error(
        `reward_entry_outbox insert for reward_entry ${rewardEntry.id} returned no row ` +
          '(structurally unreachable — a plain INSERT with no ON CONFLICT clause).',
      );
    }
    return inserted;
  }

  /**
   * Implementation note 1 (`budget-consumption.repository.ts`'s own precedent): `WHERE status =
   * 'PENDING' ORDER BY created_at` matches `ix_reward_entry_outbox_pending`'s own column order
   * exactly, so Postgres can satisfy this with a single partial-index scan rather than degrading to
   * a sequential scan as this ever-growing table grows.
   */
  async findPendingBatch(batchSize: number, scope?: OutboxBatchScope): Promise<OutboxPendingRow[]> {
    const rows = scope
      ? await this.sequelize.query<OutboxPendingRowRaw>(
          `SELECT id, reward_entry_id, topic, payload, attempts, created_at
             FROM realtime_activity_processing.reward_entry_outbox
            WHERE status = 'PENDING'
              AND id IN (:rowIds)
            ORDER BY created_at ASC
            LIMIT :batchSize`,
          { type: QueryTypes.SELECT, replacements: { batchSize, rowIds: scope.rowIds } },
        )
      : await this.sequelize.query<OutboxPendingRowRaw>(
          `SELECT id, reward_entry_id, topic, payload, attempts, created_at
             FROM realtime_activity_processing.reward_entry_outbox
            WHERE status = 'PENDING'
            ORDER BY created_at ASC
            LIMIT :batchSize`,
          { type: QueryTypes.SELECT, replacements: { batchSize } },
        );
    return rows.map((row) => ({
      id: row.id,
      rewardEntryId: row.reward_entry_id,
      topic: row.topic,
      payload: row.payload,
      attempts: row.attempts,
      createdAt: row.created_at,
    }));
  }

  /** A Kafka publish attempt failed, but the row's own attempt count is still under the
   * `service_config`-resolved threshold (`dispatch.config.ts`) — stays `PENDING`. */
  async incrementAttempts(id: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE realtime_activity_processing.reward_entry_outbox SET attempts = attempts + 1 WHERE id = :id`,
      { type: QueryTypes.RAW, replacements: { id } },
    );
  }

  /** TC-2/TC-4: delivered — by Kafka directly, or by the gRPC fallback tier for the same row (§7
   * point 2: "mark both the outbox row and `reward_entry.dispatch_status` as delivered ... never
   * deliver twice"). Either path ends this row's own eligibility for `findPendingBatch` above. */
  async markPublished(id: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE realtime_activity_processing.reward_entry_outbox
          SET status = 'PUBLISHED', published_at = now(), attempts = attempts + 1
        WHERE id = :id`,
      { type: QueryTypes.RAW, replacements: { id } },
    );
  }

  /** TC-5: both Kafka and the gRPC fallback failed for this row — tier 3
   * (`reward_dispatch_retry`) now owns further attempts; this row stops being polled. */
  async markFailed(id: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE realtime_activity_processing.reward_entry_outbox
          SET status = 'FAILED', attempts = attempts + 1
        WHERE id = :id`,
      { type: QueryTypes.RAW, replacements: { id } },
    );
  }
}
