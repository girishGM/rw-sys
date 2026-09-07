/**
 * T-RTS-010. `reward_tracking.reward_fact` (`brain-storm/02-DATA-MODEL.md` §2.1) — append-only, one
 * row per reward actually given. `expires_at` is taken verbatim from the caller's own input, never
 * recomputed here (R5). Every method takes an externally-supplied `pg.PoolClient` — see
 * `inbound-event-log.repository.ts`'s own header for why none of this module's repositories own a
 * transaction themselves.
 */
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { RewardFactRow } from '@/database/models/reward-fact.model';

/** Every column this repository's own `INSERT` supplies a value for — `reward_lifecycle_status`
 * (`'ACTIVE'`), `ingested_at`/`created_at` (`now()`) and the surrogate `id` are all column defaults,
 * never supplied here. `Pick<...>` off the shared row type rather than a hand-duplicated interface,
 * so this input shape can never silently drift from `brain-storm/02-DATA-MODEL.md` §2.1's real
 * column list. */
export type NewRewardFactInput = Pick<
  RewardFactRow,
  | 'reward_entry_id'
  | 'correlation_id'
  | 'tenant_id'
  | 'tenant_code'
  | 'country_code'
  | 'customer_id_encrypted'
  | 'customer_id_hash'
  | 'campaign_code'
  | 'tracker_code'
  | 'tracker_component_code'
  | 'merchant_code'
  | 'reward_code'
  | 'reward_category'
  | 'reward_kind'
  | 'unit_type'
  | 'unit_code'
  | 'reward_value'
  | 'reward_value_unit'
  | 'external_system_code'
  | 'external_reference_id'
  | 'promo_code_config_id'
  | 'promo_code_config_version_no'
  | 'redeemed_at'
  | 'expires_at'
>;

const INSERT_SQL = `
  INSERT INTO reward_tracking.reward_fact (
    reward_entry_id, correlation_id, tenant_id, tenant_code, country_code, customer_id_encrypted,
    customer_id_hash, campaign_code, tracker_code, tracker_component_code, merchant_code,
    reward_code, reward_category, reward_kind, unit_type, unit_code, reward_value,
    reward_value_unit, external_system_code, external_reference_id, promo_code_config_id,
    promo_code_config_version_no, redeemed_at, expires_at
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
    $22, $23, $24
  )
  RETURNING *
`;

const SELECT_BY_REWARD_ENTRY_ID_SQL =
  'SELECT * FROM reward_tracking.reward_fact WHERE reward_entry_id = $1';

@Injectable()
export class RewardFactRepository {
  /** Plain `INSERT`, no `ON CONFLICT` — the idempotency check already happened one layer up, against
   * `inbound_event_log` (R3). By the time this is called, the caller has already established this
   * `reward_entry_id` is new; `uq_rf_reward_entry` still exists as a defense-in-depth constraint,
   * never as this method's own dedupe mechanism. */
  async insert(client: PoolClient, input: NewRewardFactInput): Promise<RewardFactRow> {
    const result = await client.query<RewardFactRow>(INSERT_SQL, [
      input.reward_entry_id,
      input.correlation_id,
      input.tenant_id,
      input.tenant_code,
      input.country_code,
      input.customer_id_encrypted,
      input.customer_id_hash,
      input.campaign_code,
      input.tracker_code,
      input.tracker_component_code,
      input.merchant_code,
      input.reward_code,
      input.reward_category,
      input.reward_kind,
      input.unit_type,
      input.unit_code,
      input.reward_value,
      input.reward_value_unit,
      input.external_system_code,
      input.external_reference_id,
      input.promo_code_config_id,
      input.promo_code_config_version_no,
      input.redeemed_at,
      input.expires_at,
    ]);
    return result.rows[0];
  }

  /** Used only by the duplicate short-circuit path (implementation note 2: "read the existing
   * reward_fact row by reward_entry_id to answer with"). */
  async findByRewardEntryId(
    client: PoolClient,
    rewardEntryId: string,
  ): Promise<RewardFactRow | null> {
    const result = await client.query<RewardFactRow>(SELECT_BY_REWARD_ENTRY_ID_SQL, [
      rewardEntryId,
    ]);
    return result.rows[0] ?? null;
  }
}
