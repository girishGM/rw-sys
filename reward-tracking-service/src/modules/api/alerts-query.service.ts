/**
 * T-RTS-031. Doc 04 §2.5 — a pull-based list of warn-threshold signals, computed off the exact same
 * `campaign_reward_counter_shard`+cap-join logic `campaign-summary-query.service.ts` already
 * implements for the single-campaign endpoint (§2.1), never a second, duplicated computation (R8's
 * own "no business logic duplicated across a second code path" spirit, applied here to two
 * *endpoints* rather than two *transport adapters*). Per §0/§2.5: only ever raised for a summable
 * (`FIXED_AMOUNT`/`POINTS`) group with a matching cap — a `PERCENTAGE`/`PROMO_CODE`/`PHYSICAL` group,
 * or one with no matching cap at all, structurally can never appear here (no `consumptionPercent`
 * to cross a threshold with in the first place; `campaign-summary-query.service.ts`'s own
 * `attachCapDisplay` never attaches one to such a row).
 *
 * **Candidate campaigns are found in `campaign_hierarchy_cache`, never `reward_fact`/
 * `campaign_reward_counter_shard` directly** — this is this service's only table that already
 * knows a campaign's `tenant_id`/`countryId`/participating merchants (`campaign-summary-query.service.ts`'s
 * own header explains why `campaign_reward_counter_shard` alone can't answer "which tenant"), and,
 * critically, avoids this file needing any merchant_code/country_code bridge at all
 * (`counted-level-query.service.ts`'s own header) — every scoping dimension here is compared
 * numeric-id-to-numeric-id, entirely inside this service's own cache, never against `reward_fact`'s
 * business-code columns.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import {
  ADMIN_REWARDS_SEQUELIZE,
  CampaignSummaryQueryService,
  hasCapDisplay,
  type CampaignCapDisplayFields,
} from './campaign-summary-query.service';

export interface RewardAlert extends CampaignCapDisplayFields {
  campaignCode: string;
  tenantId: number;
  rewardCategory: string;
  rewardKind: 'FIXED_AMOUNT' | 'POINTS';
  totalValue: string;
  totalCount: number;
}

/** `null` in any field means "unrestricted in that dimension" — the exact same scope-triple
 * semantics `portal-admin-auth.guard.ts`'s own `assertPortalAdminScope` already documents. */
export interface AlertsScope {
  tenantId: number | null;
  countryId: number | null;
  merchantId: number | null;
}

interface CandidateCampaign {
  tenant_id: number;
  campaign_code: string;
}

@Injectable()
export class AlertsQueryService {
  constructor(
    @Inject(ADMIN_REWARDS_SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly campaignSummary: CampaignSummaryQueryService,
  ) {}

  async listAlerts(scope: AlertsScope): Promise<RewardAlert[]> {
    const campaigns = await this.findCandidateCampaigns(scope);
    const alerts: RewardAlert[] = [];

    for (const campaign of campaigns) {
      const groups = await this.campaignSummary.computeCampaignSummary(
        campaign.tenant_id,
        campaign.campaign_code,
      );
      for (const group of groups) {
        // R4: `hasCapDisplay` is only ever true for a summable (FIXED_AMOUNT/POINTS) row with a
        // matching cap — `campaign-summary-query.service.ts`'s own `attachCapDisplay` never
        // attaches a cap field to any other row, so `group.rewardKind` here is guaranteed to be
        // one of the two summable kinds.
        if (!hasCapDisplay(group) || !group.warnTriggered) {
          continue;
        }
        alerts.push({
          campaignCode: campaign.campaign_code,
          tenantId: campaign.tenant_id,
          rewardCategory: group.rewardCategory,
          rewardKind: group.rewardKind,
          totalValue: group.totalValue,
          totalCount: group.totalCount,
          capMaxTotalAmount: group.capMaxTotalAmount,
          consumptionPercent: group.consumptionPercent,
          warnAtPercent: group.warnAtPercent,
          warnTriggered: group.warnTriggered,
        });
      }
    }

    return alerts;
  }

  /**
   * `is_active` campaigns only (an ended/archived campaign, per `campaign-hierarchy-cache.repository.ts`'s
   * own `markInactive`, is kept for audit but never a live alert source). `merchantId` matches
   * against every cached campaign's own `hierarchy.merchants[].merchantId` via
   * `jsonb_array_elements` — numeric-id-to-numeric-id, no code bridge needed (this file's own
   * header).
   */
  private async findCandidateCampaigns(scope: AlertsScope): Promise<CandidateCampaign[]> {
    return this.sequelize.query<CandidateCampaign>(
      `SELECT tenant_id, campaign_code
         FROM reward_tracking.campaign_hierarchy_cache
        WHERE is_active = true
          AND (:tenantId::int IS NULL OR tenant_id = :tenantId)
          AND (:countryId::int IS NULL OR (hierarchy->>'countryId')::int = :countryId)
          AND (
            :merchantId::int IS NULL
            OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(COALESCE(hierarchy->'merchants', '[]'::jsonb)) AS m
               WHERE (m->>'merchantId')::int = :merchantId
            )
          )
        ORDER BY tenant_id, campaign_code`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId: scope.tenantId,
          countryId: scope.countryId,
          merchantId: scope.merchantId,
        },
      },
    );
  }
}
