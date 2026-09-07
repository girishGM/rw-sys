/**
 * T-RTS-010. `reward_tracking.customer_reward_ledger` (`brain-storm/02-DATA-MODEL.md` §3.1) — the
 * exact upsert SQL from that section, verbatim (only parameter placeholders renumbered to fit `pg`'s
 * positional style). One row per (tenant, customer, campaign, tracker, component, category, kind,
 * unit) — no time bucket. See `inbound-event-log.repository.ts`'s own header for why this repository
 * takes an externally-supplied `pg.PoolClient` rather than owning its own transaction.
 *
 * **Postgres NULL-uniqueness note (not this task's to fix, already accepted at the schema layer —
 * `T-RTS-002`'s own review note).** `uq_crl` includes three nullable columns (`reward_kind`,
 * `unit_type`, `unit_code`); standard SQL/Postgres unique-constraint semantics never consider two
 * NULLs equal, so `ON CONFLICT` only fires when a *second* event for the same grain shares the exact
 * same non-NULL values in every unique-key column — two separate `reward_kind: null` events for an
 * otherwise-identical grain each insert their own row rather than accumulating into one. TC-7
 * (a single `reward_kind: null` ingest succeeds) is unaffected by this; only true accumulation across
 * more than one `NULL`-keyed event would be.
 */
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { CustomerRewardLedgerRow } from '@/database/models/customer-reward-ledger.model';
import type { RewardKind } from '@/database/models/reward-fact.model';

export interface LedgerUpsertInput {
  tenant_id: number;
  customer_id_hash: string;
  campaign_code: string;
  tracker_code: string;
  tracker_component_code: string;
  reward_category: string;
  reward_kind: RewardKind | null;
  unit_type: string | null;
  unit_code: string | null;
  /** Same single event's `reward_value` — this call always represents exactly one reward, so the
   * ledger's own `total_reward_count` always increments by exactly 1 per call (never a batch). */
  reward_value: string;
  earned_at: Date;
}

const UPSERT_SQL = `
  INSERT INTO reward_tracking.customer_reward_ledger
    (tenant_id, customer_id_hash, campaign_code, tracker_code, tracker_component_code,
     reward_category, reward_kind, unit_type, unit_code, total_reward_value, total_reward_count,
     first_earned_at, last_earned_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $11)
  ON CONFLICT (tenant_id, customer_id_hash, campaign_code, tracker_code, tracker_component_code,
               reward_category, reward_kind, unit_type, unit_code)
  DO UPDATE SET total_reward_value = customer_reward_ledger.total_reward_value + EXCLUDED.total_reward_value,
                total_reward_count = customer_reward_ledger.total_reward_count + 1,
                last_earned_at     = EXCLUDED.last_earned_at,
                updated_at         = now()
  RETURNING *
`;

@Injectable()
export class CustomerRewardLedgerRepository {
  async upsert(client: PoolClient, input: LedgerUpsertInput): Promise<CustomerRewardLedgerRow> {
    const result = await client.query<CustomerRewardLedgerRow>(UPSERT_SQL, [
      input.tenant_id,
      input.customer_id_hash,
      input.campaign_code,
      input.tracker_code,
      input.tracker_component_code,
      input.reward_category,
      input.reward_kind,
      input.unit_type,
      input.unit_code,
      input.reward_value,
      input.earned_at,
    ]);
    return result.rows[0];
  }
}
