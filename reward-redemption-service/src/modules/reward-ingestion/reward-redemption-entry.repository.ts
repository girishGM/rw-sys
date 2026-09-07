/**
 * T-RR-010. The idempotency-anchor repository around `reward_redemption_entry`'s *insert* path —
 * the sibling half of T-RR-020's `RewardRedemptionEntryClaimRepository`, which owns that same
 * table's *claim* path instead. Deliberately not merged into that repository: T-RR-020 is a
 * different task's owned file (R3), and this repository's own concern (insert-or-return-existing)
 * shares no query shape with the claim SQL at all.
 *
 * **`ON CONFLICT (id) DO NOTHING RETURNING *`, never a `SELECT` before the `INSERT`**
 * (`01-DATABASE.md` §1's own primary key on `id` is the actual enforcement mechanism, R6,
 * `ARCHITECTURE.md` §7). A `SELECT`-then-`INSERT` shape would re-open exactly the TOCTOU race two
 * concurrent duplicate arrivals must never hit (T-RR-010 implementation note 1). When the insert
 * returns no row (id already existed), the immediate follow-up `SELECT ... WHERE id = $1` is safe
 * — not a second race — because Postgres's own unique-index conflict check blocks on, and waits
 * for, the conflicting transaction to finish before this statement can even determine there *was*
 * a conflict; by the time `ON CONFLICT DO NOTHING` resolves to zero rows, the row that caused the
 * conflict is guaranteed already committed and visible.
 *
 * Owns its own small `pg.Pool`, connected as the least-privilege `rr_app` role
 * (`DB_APP_USERNAME`/`DB_APP_PASSWORD`, `AGENT-PROTOCOL.md` R5) — same convention
 * `RewardRedemptionEntryClaimRepository`/`FieldEncryptionConfigRepository` already established (no
 * shared runtime DB pool module exists anywhere in this service).
 */
import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';

/**
 * Every column this repository's own `INSERT` supplies a value for — everything else
 * (`status`, `retry_count`, `next_attempt_at`, `last_error_*`, `last_attempted_at`,
 * `external_system_code`, `external_reference_id`, `redeemed_at`, `country_code`, `tenant_code`,
 * `created_at`, `updated_at`) is either a column default or, for `country_code`/`tenant_code`,
 * deliberately left `NULL` until Wave 2's own tenant/schema enrichment step runs
 * (`06-CACHING-AND-TENANT-CONFIG.md` §5, `ARCHITECTURE.md` §6). `Pick<...>` off the shared row
 * type rather than a hand-duplicated interface, so this input shape can never silently drift from
 * `01-DATABASE.md` §1's real column list.
 */
export type NewRewardRedemptionEntryInput = Pick<
  RewardRedemptionEntryRow,
  | 'id'
  | 'correlation_id'
  | 'tenant_id'
  | 'customer_id_encrypted'
  | 'customer_id_hash'
  | 'customer_id_type'
  | 'activity_performed_date'
  | 'transaction_type'
  | 'activity_code'
  | 'activity_type'
  | 'activity_category'
  | 'activity_value'
  | 'activity_value_unit'
  | 'channel'
  | 'activity_performed_env'
  | 'activity_name'
  | 'campaign_code'
  | 'tracker_code'
  | 'tracker_component_code'
  | 'merchant_code'
  | 'reward_code'
  | 'reward_category'
  | 'reward_value'
  | 'reward_value_unit'
  | 'reward_entry_date'
  | 'completion_cycle'
  | 'reward_processed_env'
  | 'ingestion_channel'
>;

export interface InsertOrGetExistingResult {
  row: RewardRedemptionEntryRow;
  /** `true` only for the call that actually created the row — `false` for every subsequent
   * duplicate arrival of the same `id`, on any channel, any instance (R6). Never itself branches
   * this service's business logic; it exists purely so `RewardIngestionService` can decide its own
   * log message, nothing more. */
  wasInserted: boolean;
}

const INSERT_SQL = `
  INSERT INTO reward_redemption.reward_redemption_entry (
    id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash, customer_id_type,
    activity_performed_date, transaction_type, activity_code, activity_type, activity_category,
    activity_value, activity_value_unit, channel, activity_performed_env, activity_name,
    campaign_code, tracker_code, tracker_component_code, merchant_code, reward_code,
    reward_category, reward_value, reward_value_unit, reward_entry_date, completion_cycle,
    reward_processed_env, ingestion_channel
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
    $21, $22, $23, $24, $25, $26, $27, $28
  )
  ON CONFLICT (id) DO NOTHING
  RETURNING *
`;

const SELECT_BY_ID_SQL = 'SELECT * FROM reward_redemption.reward_redemption_entry WHERE id = $1';

@Injectable()
export class RewardRedemptionEntryRepository implements OnModuleDestroy {
  private readonly pool: Pool;

  /** Second constructor parameter exists solely so a test can substitute a real (test-owned) or
   * fake `Pool` — same `@Optional()` idiom as every other repository in this service. */
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
   * Inserts `input` as a fresh row, or — if `input.id` already exists — leaves the existing row
   * completely untouched and returns it instead. Never throws on a duplicate `id` (R6, TC-2/TC-3):
   * a duplicate is a normal, expected outcome, not an error path.
   */
  async insertOrGetExisting(
    input: NewRewardRedemptionEntryInput,
  ): Promise<InsertOrGetExistingResult> {
    const inserted = await this.pool.query<RewardRedemptionEntryRow>(INSERT_SQL, [
      input.id,
      input.correlation_id,
      input.tenant_id,
      input.customer_id_encrypted,
      input.customer_id_hash,
      input.customer_id_type,
      input.activity_performed_date,
      input.transaction_type,
      input.activity_code,
      input.activity_type,
      input.activity_category,
      input.activity_value,
      input.activity_value_unit,
      input.channel,
      input.activity_performed_env,
      input.activity_name,
      input.campaign_code,
      input.tracker_code,
      input.tracker_component_code,
      input.merchant_code,
      input.reward_code,
      input.reward_category,
      input.reward_value,
      input.reward_value_unit,
      input.reward_entry_date,
      input.completion_cycle,
      input.reward_processed_env,
      input.ingestion_channel,
    ]);

    if (inserted.rowCount) {
      return { row: inserted.rows[0], wasInserted: true };
    }

    const existing = await this.pool.query<RewardRedemptionEntryRow>(SELECT_BY_ID_SQL, [input.id]);
    if (!existing.rowCount) {
      // Unreachable under normal operation (see this file's own header on why the conflict-then-
      // select sequence is race-free) — guarded rather than silently returning `undefined` (R2).
      throw new Error(
        `reward_redemption_entry ${input.id} conflicted on insert but no row was found on lookup`,
      );
    }
    return { row: existing.rows[0], wasInserted: false };
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
