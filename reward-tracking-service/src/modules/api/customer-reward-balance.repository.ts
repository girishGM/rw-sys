/**
 * T-RTS-030. `reward_tracking.customer_reward_balance` (`brain-storm/02-DATA-MODEL.md` §6.1) — the
 * expiry-watch wallet view, plus the population step that keeps it fed from `reward_fact`.
 *
 * **Population step — "reacting to it", not inside T-RTS-010's own ingestion transaction.** The task
 * file's own implementation notes leave the choice open ("decide during implementation whether this
 * belongs inside T-RTS-010's own ingestion transaction or as a separate step reacting to it; either
 * is acceptable"). `src/modules/ingestion/**` is `agent-rts-010`'s own file scope, already `done`
 * (AGENT-PROTOCOL.md R10 — not this task's to edit), so the ingestion transaction itself is not an
 * option here regardless of preference. This repository instead exposes {@link populateMissing}: a
 * single atomic `INSERT ... SELECT ... WHERE NOT EXISTS`, scoped to one `(tenantId, customerIdHash)`
 * — the exact grain the one real consumer (the `expiring` endpoint, doc 04 §1.4) already needs —
 * called eagerly by `customer-rewards.controller.ts` immediately before every `expiring` read. This
 * gives read-after-write consistency (a customer who was just ingested a reward and immediately
 * checks their expiring balances sees it, with no polling/scheduling delay or interval to tune) using
 * only files this task already owns, without adding a background job/scheduler dependency this
 * workspace doesn't have (`@nestjs/schedule` is not an existing dependency — not added for one
 * best-effort catch-up job).
 *
 * **Reuses ingestion's own idempotency guarantee, never reimplements it (task file's own
 * instruction).** No new dedupe key/table is introduced. `reward_fact.id` is already guaranteed
 * unique per real-world event by `inbound_event_log`'s own `uq_iel_reward_entry` (R3) one layer
 * upstream — a Kafka/gRPC/REST redelivery of the same `reward_entry_id` short-circuits before a
 * second `reward_fact` row is ever created (`reward-tracking-ingestion.service.ts`'s own header).
 * This repository's only own job is making sure *this* step — inserting the matching balance row —
 * itself runs at most once per `reward_fact.id`, which the `NOT EXISTS` subquery below guarantees
 * atomically (single statement, no read-then-write gap) without a dedicated unique constraint on
 * `customer_reward_balance.reward_fact_id` (that table's own migration, `006_create_customer_reward_
 * balance.ts`, is `src/database/migrations/**` — `agent-rts-foundation`'s own file scope, R10 — not
 * added here; flagged in the completion report as a defense-in-depth hardening opportunity for that
 * owner, not a correctness gap this task can leave unaddressed on its own: two literally-concurrent
 * calls to `populateMissing` for the same customer are not a real scenario this task's own callers
 * ever create — the controller calls it synchronously, once, per request, itself serialized as far as
 * this repository's write is concerned by that one statement's own row visibility).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type { RewardKind } from '@/database/models/reward-fact.model';
import type { CustomerRewardBalanceStatus } from '@/database/models/customer-reward-balance.model';
import { CUSTOMER_REWARDS_SEQUELIZE } from './customer-reward-ledger-query.service';

/** Doc 04 §1.4's own `SELECT` list, plus `reward_kind`/`promo_code_config_id`/
 * `promo_code_config_version_no` (§2.3 — audit/display, the expiring-soon message template branches
 * on `reward_kind`, never a `SUM`) and `reward_code` (informational — "Code SAVE10-X7K2Q ..." style
 * display, doc 04 §2.2's own precedent for what a `PROMO_CODE` row shows alongside itself). */
export interface CustomerRewardBalanceExpiringRow {
  reward_category: string;
  reward_kind: RewardKind | null;
  issued_value: string;
  expires_at: Date;
  campaign_code: string;
  external_reference_id: string | null;
  reward_code: string | null;
  promo_code_config_id: string | null;
  promo_code_config_version_no: number | null;
  status: CustomerRewardBalanceStatus;
}

@Injectable()
export class CustomerRewardBalanceRepository {
  constructor(@Inject(CUSTOMER_REWARDS_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /** Doc 04 §1.4, verbatim (`interval '$3 days'` becomes a bound parameter here, never a
   * string-concatenated literal). */
  async findExpiring(params: {
    tenantId: number;
    customerIdHash: string;
    withinDays: number;
  }): Promise<CustomerRewardBalanceExpiringRow[]> {
    return this.sequelize.query<CustomerRewardBalanceExpiringRow>(
      `SELECT reward_category, reward_kind, issued_value, expires_at, campaign_code,
              external_reference_id, reward_code, promo_code_config_id,
              promo_code_config_version_no, status
         FROM reward_tracking.customer_reward_balance
        WHERE tenant_id = :tenantId AND customer_id_hash = :customerIdHash
          AND status = 'ACTIVE'
          AND expires_at IS NOT NULL
          AND expires_at < now() + (:withinDays * interval '1 day')
        ORDER BY expires_at`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId: params.tenantId,
          customerIdHash: params.customerIdHash,
          withinDays: params.withinDays,
        },
      },
    );
  }

  /**
   * The population step (this file's own header). One atomic `INSERT ... SELECT`: every
   * `reward_fact` row for this `(tenantId, customerIdHash)` with a non-null `expires_at`
   * (TC-4 — a `NULL` `expires_at` row is never selected in the first place, so it can never produce
   * a balance row) that doesn't already have a matching `customer_reward_balance` row, keyed by
   * `reward_fact_id` (this file's header — reusing, not duplicating, ingestion's own dedupe
   * guarantee). `issued_value = reward_value`, `status = 'ACTIVE'` — exactly the task's own
   * "Scope" bullet. Uses `ix_rf_expiry_watch` (`tenant_id, customer_id_hash, expires_at`) for the
   * outer scan.
   *
   * Returns the number of rows actually inserted (0 on every call once caught up — cheap to call on
   * every `expiring` read).
   */
  async populateMissing(params: { tenantId: number; customerIdHash: string }): Promise<number> {
    const [, affectedCount] = await this.sequelize.query(
      `INSERT INTO reward_tracking.customer_reward_balance
         (reward_fact_id, tenant_id, customer_id_hash, campaign_code, reward_category, unit_type,
          unit_code, reward_code, reward_kind, external_reference_id, promo_code_config_id,
          promo_code_config_version_no, issued_value, status, issued_at, expires_at)
       SELECT rf.id, rf.tenant_id, rf.customer_id_hash, rf.campaign_code, rf.reward_category,
              rf.unit_type, rf.unit_code, rf.reward_code, rf.reward_kind, rf.external_reference_id,
              rf.promo_code_config_id, rf.promo_code_config_version_no, rf.reward_value, 'ACTIVE',
              rf.redeemed_at, rf.expires_at
         FROM reward_tracking.reward_fact rf
        WHERE rf.tenant_id = :tenantId
          AND rf.customer_id_hash = :customerIdHash
          AND rf.expires_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM reward_tracking.customer_reward_balance b
             WHERE b.reward_fact_id = rf.id
          )`,
      {
        type: QueryTypes.INSERT,
        replacements: { tenantId: params.tenantId, customerIdHash: params.customerIdHash },
      },
    );
    return affectedCount;
  }
}
