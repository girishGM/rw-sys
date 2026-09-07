/**
 * T-RTS-030. Read-only queries against `reward_tracking.customer_reward_ledger`
 * (`brain-storm/02-DATA-MODEL.md` §3.1, `brain-storm/04-API-DESIGN.md` §§1.1-1.3) — direct row reads
 * for the per-campaign summary, `GROUP BY` rollups for the tracker- and campaign-level totals. Every
 * method returns raw rows (snake_case, as Postgres hands them back); `customer-rewards.controller.ts`
 * is the one place that maps them through `reward-kind-response-shaper.ts` into a response body (R4,
 * R8 — no business logic in a transport adapter, and no response-shaping logic duplicated here
 * either).
 *
 * **Resolved documentation inconsistency, noted rather than silently picked** (same "resolved rather
 * than silently picked" precedent `reward-tracking-ingestion.service.ts`'s own header already set for
 * an identically-shaped tension). `brain-storm/02-DATA-MODEL.md` §2.2 states "every query ... that
 * computes `SUM(reward_value)` must ... add `AND reward_kind IN ('FIXED_AMOUNT','POINTS')` to its
 * WHERE/join" — but applied literally as a `WHERE` filter, that sentence is unsatisfiable together
 * with the rest of this very design: doc 04 §1.2's own worked example response includes a
 * `PERCENTAGE` row (`totalCount: 1, averageRatePercent: "10.00"`) produced by the *identical*
 * `GROUP BY reward_category, reward_kind, ...` query shown immediately below that same sentence in
 * doc 02 §3.1 — a `WHERE reward_kind IN (...)` filter would silently drop that row from the result
 * set entirely, making the worked example impossible to reproduce (which is exactly what T-RTS-041
 * is chartered to prove byte-for-byte). Doc 02 §5's own later paragraph confirms the resolution
 * directly: "Grouping by `reward_kind` here is not optional polish; it's the fix" — group by it,
 * never filter it out, and let the API layer (doc 04 §0, `reward-kind-response-shaper.ts`) decide
 * what to serialize per group. This service follows that resolution: `reward_kind` is always in the
 * `GROUP BY`/`SELECT`, never in a `WHERE`/`HAVING` restricting which kinds come back. Flagged here for
 * the architect to fold the stale sentence out of doc 02 §2.2.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type { RewardKind } from '@/database/models/reward-fact.model';

/** DI token for this module's own runtime Postgres connection (the least-privilege
 * `reward_tracking_app` role, AGENT-PROTOCOL.md R2) — same "no shared application-level
 * `DatabaseModule` exists yet" situation `campaign-hierarchy-cache.repository.ts`'s own
 * `CAMPAIGN_CACHE_SEQUELIZE` documents, and the same fix: this module owns its own connection,
 * `customer-rewards-api.module.ts` (this task's own DI wiring) constructs it. Defined here (rather
 * than a dedicated constants file — this task's "Files owned" list grants no such file) since this
 * service is this module's first/primary reader; `customer-reward-balance.repository.ts` imports and
 * reuses the same token/connection rather than opening a second one. */
export const CUSTOMER_REWARDS_SEQUELIZE = Symbol('CUSTOMER_REWARDS_SEQUELIZE');

/** One row exactly as `customer_reward_ledger` stores it, for the direct-row-read summary endpoint
 * (doc 04 §1.1) — no aggregation, `ORDER BY tracker_code, tracker_component_code` per that section's
 * own query. */
export interface CustomerRewardLedgerComponentRow {
  campaign_code: string;
  tracker_code: string;
  tracker_component_code: string;
  reward_category: string;
  reward_kind: RewardKind | null;
  unit_type: string | null;
  unit_code: string | null;
  total_reward_value: string;
  total_reward_count: number;
}

/** One `GROUP BY reward_category, reward_kind, unit_type, unit_code` rollup row, shared shape for
 * both the tracker-level (§1.2) and campaign-level (§1.3) totals queries — identical `SELECT`, only
 * the `WHERE` clause differs. */
export interface CustomerRewardGroupTotalsRow {
  reward_category: string;
  reward_kind: RewardKind | null;
  unit_type: string | null;
  unit_code: string | null;
  total_value: string;
  total_count: string;
}

@Injectable()
export class CustomerRewardLedgerQueryService {
  constructor(@Inject(CUSTOMER_REWARDS_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * Doc 04 §1.1 — direct row read, no aggregation. Omitting `campaignCode` returns every row for
   * this customer across every campaign, exactly as that section specifies ("just without the
   * `campaign_code = $3` filter").
   */
  async findLedgerComponents(params: {
    tenantId: number;
    customerIdHash: string;
    campaignCode?: string;
  }): Promise<CustomerRewardLedgerComponentRow[]> {
    const campaignFilter =
      params.campaignCode !== undefined ? 'AND campaign_code = :campaignCode' : '';
    return this.sequelize.query<CustomerRewardLedgerComponentRow>(
      `SELECT campaign_code, tracker_code, tracker_component_code, reward_category, reward_kind,
              unit_type, unit_code, total_reward_value, total_reward_count
         FROM reward_tracking.customer_reward_ledger
        WHERE tenant_id = :tenantId AND customer_id_hash = :customerIdHash ${campaignFilter}
        ORDER BY tracker_code, tracker_component_code`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId: params.tenantId,
          customerIdHash: params.customerIdHash,
          campaignCode: params.campaignCode ?? null,
        },
      },
    );
  }

  /** Doc 04 §1.2 — spans every campaign that `trackerCode` appears in for this customer. */
  async findTrackerTotals(params: {
    tenantId: number;
    customerIdHash: string;
    trackerCode: string;
  }): Promise<CustomerRewardGroupTotalsRow[]> {
    return this.sequelize.query<CustomerRewardGroupTotalsRow>(
      `SELECT reward_category, reward_kind, unit_type, unit_code,
              SUM(total_reward_value)::text AS total_value,
              SUM(total_reward_count)::text AS total_count
         FROM reward_tracking.customer_reward_ledger
        WHERE tenant_id = :tenantId AND customer_id_hash = :customerIdHash
          AND tracker_code = :trackerCode
        GROUP BY reward_category, reward_kind, unit_type, unit_code`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId: params.tenantId,
          customerIdHash: params.customerIdHash,
          trackerCode: params.trackerCode,
        },
      },
    );
  }

  /** Doc 04 §1.3 — spans every tracker/component within one campaign. Same shape/rule as
   * {@link findTrackerTotals}, scoped by `campaign_code` instead of `tracker_code`. */
  async findCampaignTotals(params: {
    tenantId: number;
    customerIdHash: string;
    campaignCode: string;
  }): Promise<CustomerRewardGroupTotalsRow[]> {
    return this.sequelize.query<CustomerRewardGroupTotalsRow>(
      `SELECT reward_category, reward_kind, unit_type, unit_code,
              SUM(total_reward_value)::text AS total_value,
              SUM(total_reward_count)::text AS total_count
         FROM reward_tracking.customer_reward_ledger
        WHERE tenant_id = :tenantId AND customer_id_hash = :customerIdHash
          AND campaign_code = :campaignCode
        GROUP BY reward_category, reward_kind, unit_type, unit_code`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId: params.tenantId,
          customerIdHash: params.customerIdHash,
          campaignCode: params.campaignCode,
        },
      },
    );
  }
}
