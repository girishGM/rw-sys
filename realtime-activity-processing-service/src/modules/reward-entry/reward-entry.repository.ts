/**
 * T-RAP-034 (original) / T-RAP-050 (this fix). `reward_entry` — one row per earned reward
 * (`01-DATABASE.md` §7). This is the final statement of the same transaction/advisory-lock scope
 * T-RAP-031 opened and T-RAP-033 continued (`05-PROCESSING-PIPELINE.md` §6 point 3: "same
 * transaction, same commit") — every method that takes a `Transaction` here is called from inside
 * that one open transaction, never a new one of its own.
 *
 * Reuses `PROCESSING_SEQUELIZE` (`activity-log-claim.repository.ts`) rather than opening a second
 * connection — same convention `budget-consumption.repository.ts` (T-RAP-033) already established
 * for this same file-scope owner's task chain, for the same reason: a `Transaction` object is bound
 * to the connection/pool it was opened on, so a `reward_entry` insert that must commit atomically
 * with T-RAP-033's own cap reservations has no choice but to share that exact connection.
 *
 * **`insertForGrantedAssignment`'s `ON CONFLICT ... DO NOTHING` — T-RAP-050 diagnosis.** T-RAP-034
 * originally flagged that `uc_reward_entry_completion` (`01-DATABASE.md` §7) carried no
 * `reward_code`/assignment discriminator, so a second genuinely-earned reward on the same
 * completion collided with the *first* grant's row instead of being its own distinct row. T-RAP-049
 * fixed the schema gap directly: `uc_reward_entry_completion` now includes `reward_code`
 * (`(tenant_id, customer_id_hash, campaign_code, tracker_code, tracker_component_code,
 * completion_cycle, reward_code)`, `015_fix_reward_entry_unique_index.ts`), so two distinct bound
 * rewards granted on the same completion now insert as two distinct rows — no collision, no
 * `DO NOTHING` no-op, no lost budget-vs-reward-entry consistency. That leaves exactly one case this
 * index still needs to guard against: a **genuine duplicate** — the identical `(tenant, customer,
 * campaign, tracker, component, cycle, reward_code)` tuple inserted twice (e.g. an idempotency-key
 * race, a retried claim after a crash between commit and ack — `05-PROCESSING-PIPELINE.md` §2/§6).
 * `ON CONFLICT (<the seven columns>) DO NOTHING RETURNING *` is kept, now updated to the full
 * 7-column list so it once again matches `uc_reward_entry_completion` and Postgres can infer it as
 * the arbiter index (a stale, narrower column list simply matches no index and Postgres rejects the
 * insert outright with `42P10`, which is exactly what T-RAP-050 was filed to fix) — a genuine
 * duplicate still returns no row rather than throwing, exactly the same graceful, R2/R3-safe
 * no-op behaviour this method has always documented, just now scoped to the one case that's still
 * actually possible instead of also silently absorbing legitimate second-reward inserts. The
 * conflict target is spelled out as the explicit column list, not
 * `ON CONFLICT ON CONSTRAINT uc_reward_entry_completion` — verified against the real `rap_app` role
 * while building T-RAP-034 (not assumed): `01-DATABASE.md` §7 and `009_create_reward_entry.ts`/
 * `015_fix_reward_entry_unique_index.ts` all create this as a plain `CREATE UNIQUE INDEX`, never an
 * `ALTER TABLE ... ADD CONSTRAINT`, and Postgres's `ON CONFLICT ON CONSTRAINT` clause only resolves
 * an actual constraint name (`42704 constraint "..." for table "..." does not exist` otherwise) —
 * the column-list form works against any unique index regardless of how it was created, which is
 * also arguably the more robust choice here since it survives that index ever being renamed.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Sequelize, Transaction } from 'sequelize';
import { QueryTypes } from 'sequelize';
import type { ActivityLogRow } from '@/database/models/activity-log.model';
import type { RewardEntryRow } from '@/database/models/reward-entry.model';
import { PROCESSING_SEQUELIZE } from '@/modules/processing/activity-log-claim.repository';

/** Everything `insertForGrantedAssignment` needs beyond the claimed `ActivityLogRow` itself
 * (`05-PROCESSING-PIPELINE.md` §6: the reward's own resolved value/code/category/unit, the
 * completion cycle T-RAP-031's progress upsert just produced, and the one `rewardEntryDate` T-RAP-033
 * already computed once and passed through — never re-read mid-transaction, same discipline that
 * task's own `CapEnforcementContext.rewardEntryDate` documents). */
export interface GrantedRewardInsertInput {
  row: ActivityLogRow;
  rewardCode: string;
  rewardCategory: string;
  rewardValue: string;
  rewardValueUnit: string;
  completionCycle: number;
  rewardEntryDate: Date;
}

@Injectable()
export class RewardEntryRepository {
  private readonly logger = new Logger(RewardEntryRepository.name);

  constructor(@Inject(PROCESSING_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * TC-1: `reward_entry` fields mirror the claimed `activity_logs` row 1:1 for every column both
   * tables share (`01-DATABASE.md` §7's own "this row shape" framing) — `customer_id_encrypted`
   * carried through verbatim, still encrypted (R4: decrypted only at the point of publish, never
   * here). Returns `null` only when `uc_reward_entry_completion` already holds a row for this
   * exact 7-tuple (including `reward_code`) — a genuine duplicate, never a distinct second reward
   * on the same completion (T-RAP-049/T-RAP-050) — see this file's own header for why that is a
   * graceful no-op, not a thrown error.
   */
  async insertForGrantedAssignment(
    transaction: Transaction,
    input: GrantedRewardInsertInput,
  ): Promise<RewardEntryRow | null> {
    const { row } = input;
    const rows = await this.sequelize.query<RewardEntryRow>(
      `INSERT INTO realtime_activity_processing.reward_entry
         (correlation_id, tenant_id, customer_id_encrypted, customer_id_hash, customer_id_type,
          activity_performed_date, transaction_type, activity_code, activity_type,
          activity_category, activity_value, activity_value_unit, channel, activity_performed_env,
          activity_name, campaign_code, tracker_code, tracker_component_code, merchant_code,
          reward_code, reward_category, reward_value, reward_value_unit, reward_entry_date,
          completion_cycle)
       VALUES
         (:correlationId, :tenantId, :customerIdEncrypted, :customerIdHash, :customerIdType,
          :activityPerformedDate, :transactionType, :activityCode, :activityType,
          :activityCategory, :activityValue, :activityValueUnit, :channel, :activityPerformedEnv,
          :activityName, :campaignCode, :trackerCode, :trackerComponentCode, :merchantCode,
          :rewardCode, :rewardCategory, :rewardValue, :rewardValueUnit, :rewardEntryDate,
          :completionCycle)
       ON CONFLICT (tenant_id, customer_id_hash, campaign_code, tracker_code, tracker_component_code,
                    completion_cycle, reward_code) DO NOTHING
       RETURNING *`,
      {
        type: QueryTypes.SELECT,
        transaction,
        replacements: {
          correlationId: row.correlation_id,
          tenantId: row.tenant_id,
          customerIdEncrypted: row.customer_id_encrypted,
          customerIdHash: row.customer_id_hash,
          customerIdType: row.customer_id_type,
          activityPerformedDate: row.activity_performed_date,
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
          rewardCode: input.rewardCode,
          rewardCategory: input.rewardCategory,
          rewardValue: input.rewardValue,
          rewardValueUnit: input.rewardValueUnit,
          rewardEntryDate: input.rewardEntryDate,
          completionCycle: input.completionCycle,
        },
      },
    );
    const inserted = rows[0] ?? null;
    if (inserted === null) {
      this.logger.warn(
        `REWARD_ENTRY_COMPLETION_COLLISION: uc_reward_entry_completion already holds a row for ` +
          `tenant=${row.tenant_id} campaign=${row.campaign_code} tracker=${row.tracker_code} ` +
          `component=${row.tracker_component_code} cycle=${input.completionCycle} — reward ` +
          `"${input.rewardCode}" was NOT inserted (see reward-entry.repository.ts's own header).`,
      );
    }
    return inserted;
  }

  /** Used by the dispatch tiers (outside this transaction, `05-PROCESSING-PIPELINE.md` §7) to load
   * the committed row's full field set — never called from inside the domain transaction above. */
  async findById(id: string): Promise<RewardEntryRow | null> {
    const rows = await this.sequelize.query<RewardEntryRow>(
      `SELECT * FROM realtime_activity_processing.reward_entry WHERE id = :id`,
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    return rows[0] ?? null;
  }

  /** TC-2/TC-4/TC-6: a dispatch attempt (any tier) succeeded — R3: this never touches whether the
   * row exists, only its own delivery-status columns. Clears `last_dispatch_error` on success. */
  async markDispatched(id: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE realtime_activity_processing.reward_entry
          SET dispatch_status = 'dispatched',
              dispatch_attempts = dispatch_attempts + 1,
              last_dispatch_error = NULL,
              updated_at = now()
        WHERE id = :id`,
      { type: QueryTypes.RAW, replacements: { id } },
    );
  }

  /** A single dispatch attempt (Kafka or gRPC) failed but the overall dispatch outcome for this
   * row is not yet decided (more tiers/attempts remain) — records the attempt without flipping
   * `dispatch_status` away from whatever it currently is. */
  async recordDispatchAttemptFailure(id: string, errorMessage: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE realtime_activity_processing.reward_entry
          SET dispatch_attempts = dispatch_attempts + 1,
              last_dispatch_error = :errorMessage,
              updated_at = now()
        WHERE id = :id`,
      { type: QueryTypes.RAW, replacements: { id, errorMessage } },
    );
  }

  /** TC-5: both Kafka (tier 1) and gRPC (tier 2) failed for this row — `reward_dispatch_retry`
   * (tier 3) now owns further attempts. */
  async markDispatchFailed(id: string, errorMessage: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE realtime_activity_processing.reward_entry
          SET dispatch_status = 'failed',
              dispatch_attempts = dispatch_attempts + 1,
              last_dispatch_error = :errorMessage,
              updated_at = now()
        WHERE id = :id`,
      { type: QueryTypes.RAW, replacements: { id, errorMessage } },
    );
  }
}
