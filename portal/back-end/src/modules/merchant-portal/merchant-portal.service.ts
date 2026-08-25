/**
 * T-039 — `/merchant/campaigns`, `/merchant/campaigns/:id`, `/merchant/summary`.
 *
 * ### Participation is the scope, and `ScopedRepository` already does the hard part
 *
 * `TenantCampaign` and `CampaignMerchant` both carry a `merchant` scope rule
 * (`common/scope/scope-strategy.ts`, T-013/T-037) that is *exactly* implementation note 1's SQL:
 * `tenant_id = :tenantId AND id IN (SELECT campaign_id FROM campaign_merchants WHERE merchant_id
 * = :merchantId AND status = 'active')`. Every read below goes through `this.scoped`, never a raw
 * model call (R2), so same-tenant-but-different-merchant (TC-2, the task's own "headline test")
 * and cross-tenant (TC-4) are both unreachable by construction, not by a branch in this file that
 * could be gotten wrong — see `scoped.repository.ts`'s own header for why that distinction matters
 * (02-SECURITY.md §5.1).
 *
 * `assertRole(actor, 'merchant')` at the top of every method is T-013's third, independent layer
 * (`assert-role.ts`'s own header: *"T-031 and T-032 are required by their own task files to call
 * it... T-033's writes and T-041's blast operations should too"*) — this module holds every read
 * here to the same bar precisely because a merchant-scoped read is still a read of another
 * tenant's structure the moment the role check in front of it is wrong.
 *
 * ### What this file deliberately does **not** query
 *
 * `scope-strategy.ts`'s own comment on the six T-037 journey tables is explicit: *"merchant:
 * deny() on all six, and that is not an oversight... T-039 builds that surface from the campaign
 * header, not from these tables."* This service never touches `TrackerComponent`,
 * `TrackerTrackerComponent`, `TrackerComponentRule` or any `reward_*_assignment` table — a
 * campaign's rule/reward mechanics and its internal budget (`budgetAmount`/`budgetCurrency`,
 * `campaign_caps`) never appear in any DTO this module returns (implementation note 2, TC-8/TC-9).
 * "This merchant's own activities and commission terms" instead comes from `MerchantActivity`,
 * which carries its own `merchant`-scope rule restricting it to exactly this merchant's own rows
 * (`every(column('tenantId','tenant'), column('merchantId','merchant'))`) — so there is no query
 * shape here that could return another merchant's `commissionRate`, not merely a projection that
 * happens to omit it.
 */
import { Injectable } from '@nestjs/common';
import { Op } from 'sequelize';
import { assertRole } from '@/common/rbac/assert-role';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { Activity } from '@/database/models/activity.model';
import { CampaignMerchant } from '@/database/models/campaign-merchant.model';
import { MerchantActivity } from '@/database/models/merchant-activity.model';
import { TenantCampaign } from '@/database/models/tenant-campaign.model';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import {
  CAMPAIGN_ACTIVE_STATUS,
  MERCHANT_PARTICIPATION_ACTIVE_STATUS,
  MERCHANT_VISIBLE_CAMPAIGN_STATUSES,
} from './merchant-portal.constants';
import {
  toMerchantCampaignDetailDto,
  toMerchantCampaignListItemDto,
  toMerchantOwnActivityDto,
  type MerchantCampaignDetailDto,
  type MerchantCampaignListItemDto,
  type MerchantOwnActivityDto,
  type MerchantSummaryDto,
} from './dto/merchant-campaign-response.dto';

/** Implementation note 5: no source table exists for per-campaign redemption/performance data
 * (this file's own header). Stated once, reused by both the detail's absence and `/summary`'s. */
const CAMPAIGN_PERFORMANCE_UNAVAILABLE_REASON =
  'No redemption or transaction data source is linked to campaigns in reward_config yet.';

@Injectable()
export class MerchantPortalService {
  constructor(private readonly scoped: ScopedRepository) {}

  /** `GET /merchant/campaigns` (TC-1, TC-2, TC-5, TC-6, TC-7, TC-14, TC-15, TC-17). */
  async listCampaigns(actor: AuthenticatedUser): Promise<MerchantCampaignListItemDto[]> {
    assertRole(actor, 'merchant');
    const campaigns = await this.visibleCampaigns();
    return campaigns.map(toMerchantCampaignListItemDto);
  }

  /** `GET /merchant/campaigns/:id` (TC-3, TC-4, TC-5, TC-6, TC-8, TC-9). */
  async getCampaign(actor: AuthenticatedUser, id: number): Promise<MerchantCampaignDetailDto> {
    assertRole(actor, 'merchant');

    // Scoped to this merchant's own tenant and participation, and further narrowed to a visible
    // status — a `draft`/`pending_approval`/`archived` campaign 404s here exactly as an
    // out-of-scope one does (TC-5/TC-6), the same "not found or not visible, indistinguishable"
    // shape `findByPkOrFail` gives everywhere else (02-SECURITY.md §5.1).
    const campaign = await this.scoped.findByPkOrFail(TenantCampaign, id, {
      where: { status: { [Op.in]: MERCHANT_VISIBLE_CAMPAIGN_STATUSES } },
    });

    // Guaranteed to exist once the lookup above succeeds — `TenantCampaign`'s own merchant scope
    // rule already required a matching, active `campaign_merchants` row — but fetched again
    // (rather than assumed) to read `status`/`createdAt` for the response, and `findOneOrFail`
    // keeps the same fail-closed shape if that invariant were ever wrong.
    const participation = await this.scoped.findOneOrFail(CampaignMerchant, {
      where: { campaignId: id },
    });

    const myActivities = await this.listMyActivities();
    return toMerchantCampaignDetailDto(campaign, participation, myActivities);
  }

  /** `GET /merchant/summary` (TC-13, TC-18, TC-19). */
  async getSummary(actor: AuthenticatedUser): Promise<MerchantSummaryDto> {
    assertRole(actor, 'merchant');

    const [activeCampaignsCount, myActivitiesCount, participatingCampaigns] = await Promise.all([
      this.scoped.count(TenantCampaign, { where: { status: CAMPAIGN_ACTIVE_STATUS } }),
      this.scoped.count(MerchantActivity, {
        where: { status: MERCHANT_PARTICIPATION_ACTIVE_STATUS },
      }),
      this.visibleCampaigns(),
    ]);

    return {
      activeCampaignsCount,
      myActivitiesCount,
      // TC-19 — no fabricated `0`, no fabricated series; an honest "not available" (this file's
      // own header explains why no source table exists for this yet).
      campaignPerformance: { available: false, reason: CAMPAIGN_PERFORMANCE_UNAVAILABLE_REASON },
      participatingCampaigns: participatingCampaigns.map(toMerchantCampaignListItemDto),
    };
  }

  /** The scoped, status-filtered campaign list both `listCampaigns` and `getSummary` share. */
  private async visibleCampaigns(): Promise<TenantCampaign[]> {
    return this.scoped.listAll(TenantCampaign, {
      where: { status: { [Op.in]: MERCHANT_VISIBLE_CAMPAIGN_STATUSES } },
      order: [
        ['startDate', 'DESC'],
        ['id', 'DESC'],
      ],
    });
  }

  /**
   * This merchant's own `merchant_activities` (implementation note 2). `MerchantActivity`'s own
   * scope rule already restricts this to exactly this merchant's rows, so there is no `merchantId`
   * filter to get wrong here — see this file's own header.
   */
  private async listMyActivities(): Promise<MerchantOwnActivityDto[]> {
    const links = await this.scoped.listAll(MerchantActivity, {
      where: { status: MERCHANT_PARTICIPATION_ACTIVE_STATUS },
      order: [['id', 'ASC']],
    });
    if (links.length === 0) return [];

    // `Activity` carries its own `merchant` scope rule too (`column('tenantId','tenant')`) — this
    // is still a scoped read, not a raw lookup, even though every id here already came from this
    // merchant's own `merchant_activities` rows.
    const activityIds = [...new Set(links.map((link) => link.activityId))];
    const activities = await this.scoped.listAll(Activity, {
      where: { id: { [Op.in]: activityIds } },
    });
    const nameById = new Map(activities.map((activity) => [activity.id, activity.name]));

    return links.map((link) =>
      toMerchantOwnActivityDto(link, nameById.get(link.activityId) ?? 'Unknown activity'),
    );
  }
}
