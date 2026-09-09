/**
 * T-RTS-031. Every portal-admin endpoint from `brain-storm/04-API-DESIGN.md` §2 — campaign/merchant/
 * tenant/country summaries + the pull-based alerts list. A thin transport adapter (R8) — every
 * response row is built by mapping a query-service row through the one shared `shapeRewardGroup`
 * (R4, reused verbatim from T-RTS-030's `reward-kind-response-shaper.ts`, never reimplemented here),
 * plus this task's own cap-join fields where they apply.
 *
 * Guarded end-to-end by `PortalAdminAuthGuard` (T-RTS-032) — every handler below is also its own
 * second, defense-in-depth scoping check (implementation note 2: "this task's own query methods
 * must still take the scoping value as a parameter derived from the verified claim, never from a
 * request query param a caller could override"), never trusting a route/decorator alone.
 *
 * ## Role scoping, endpoint by endpoint — what's enforced and why
 *
 * - **Campaign summary** (§2.1): doc 04's own words — "this service trusts the caller's
 *   already-verified tenant/campaign grant, it does not re-derive RBAC from scratch." No numeric
 *   `tenantId` is even present in this route's path, so `tenantId` is *resolved*, not just
 *   *checked* — `campaign-summary-query.service.ts`'s own `resolveTenantAndVerifyCountry` (see its
 *   header for the fallback ladder). A `country_admin`'s own `countryId` claim IS still checked
 *   against the resolved campaign's own `countryId` when a cache row exists — both numeric,
 *   portal-native ids, no code/id bridge needed here (unlike §2.4 below).
 * - **Tenant summary** (§2.3): a concrete `claims.tenantId` always wins over the path param — a
 *   mismatch is a straight `403`, never a silent redirect to the caller's own tenant, so a caller
 *   always gets an explicit signal rather than quietly-wrong data (TC-3).
 * - **Merchant summary** (§2.2): a concrete `claims.merchantId` is resolved to its own
 *   `merchant_code` via `counted-level-query.service.ts`'s own cache-based bridge (that file's own
 *   header explains why a bridge is even needed) and **that** resolved code, never the path
 *   param, is what's used to query `reward_fact` — a mismatched/unresolvable path param is a `403`.
 * - **Country summary** (§2.4): **no bridge exists anywhere in this service** between a numeric
 *   `countryId` claim and `reward_fact.country_code` (`counted-level-query.service.ts`'s own header
 *   — confirmed, not assumed, by reading the portal's own wire contract). A concrete
 *   `claims.countryId` is therefore rejected outright (`403`) rather than trusting the raw path
 *   param unchecked, which is what an actual cross-country leak would look like — exactly the risk
 *   this task's own header calls out. Only `super_admin` (`countryId: null`) can use this endpoint
 *   until an architect resolves the gap (this file's own `counted-level-query.service.ts` header
 *   spells out three candidate fixes, all outside this task's own file scope). **Flagged in this
 *   task's completion report as a genuine, unresolved design gap, not silently worked around.**
 * - **Alerts** (§2.5): scoped entirely inside `campaign_hierarchy_cache` (numeric-id-to-numeric-id
 *   throughout — `alerts-query.service.ts`'s own header), so it needs no code bridge and is fully,
 *   correctly scoped for every role today, including `country_admin`/`merchant`.
 *
 * `@UseInterceptors(ApiObservabilityInterceptor)` (T-RTS-050) is this controller's one, shared
 * `reward_tracking_api_requests_total`/structured-logging call site, reused verbatim from
 * `customer-rewards.controller.ts` (T-RTS-030) — see that file's own header for why a single
 * class-level interceptor, not five per-handler manual increments.
 */
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  PortalAdminAuthGuard,
  RequirePortalRoles,
  type RequestWithPortalAdmin,
} from '@/modules/auth/portal-admin-auth.guard';
import {
  CampaignSummaryQueryService,
  type CampaignSummaryGroup,
} from './campaign-summary-query.service';
import {
  CountedLevelQueryService,
  type RewardFactGroupTotalsRow,
} from './counted-level-query.service';
import { AlertsQueryService, type RewardAlert } from './alerts-query.service';
import { shapeRewardGroup, type ShapedRewardGroup } from './reward-kind-response-shaper';
import { ApiObservabilityInterceptor } from './api-observability.interceptor';

const ALL_PORTAL_ROLES = [
  'super_admin',
  'country_admin',
  'tenant_admin',
  'maker',
  'checker',
  'merchant',
] as const;

function toShapedGroup(row: RewardFactGroupTotalsRow): ShapedRewardGroup {
  return shapeRewardGroup({
    rewardCategory: row.reward_category,
    rewardKind: row.reward_kind,
    unitType: row.unit_type,
    unitCode: row.unit_code,
    totalValue: row.total_value,
    totalCount: Number(row.total_count),
  });
}

function toMerchantGroup(row: RewardFactGroupTotalsRow): ShapedRewardGroup & {
  distinctCustomers?: number;
} {
  const shaped = toShapedGroup(row);
  if (row.distinct_customers === undefined) {
    return shaped;
  }
  return { ...shaped, distinctCustomers: Number(row.distinct_customers) };
}

@Controller('reward-tracking')
@UseGuards(PortalAdminAuthGuard)
@UseInterceptors(ApiObservabilityInterceptor)
export class AdminRewardsController {
  constructor(
    private readonly campaignSummary: CampaignSummaryQueryService,
    private readonly countedLevel: CountedLevelQueryService,
    private readonly alerts: AlertsQueryService,
  ) {}

  /** Doc 04 §2.1. */
  @Get('campaigns/:campaignCode/summary')
  @RequirePortalRoles(...ALL_PORTAL_ROLES)
  async getCampaignSummary(
    @Req() request: RequestWithPortalAdmin,
    @Param('campaignCode') campaignCode: string,
  ): Promise<{ campaignCode: string; totals: CampaignSummaryGroup[] }> {
    const { tenantId, countryId } = request.portalAdmin;
    const resolved = await this.campaignSummary.resolveTenantAndVerifyCountry({
      campaignCode,
      requiredTenantId: tenantId,
      requiredCountryId: countryId,
    });
    const totals = await this.campaignSummary.computeCampaignSummary(
      resolved.tenantId,
      campaignCode,
    );
    return { campaignCode, totals };
  }

  /** Doc 04 §2.2. */
  @Get('merchants/:merchantCode/summary')
  @RequirePortalRoles(...ALL_PORTAL_ROLES)
  async getMerchantSummary(
    @Req() request: RequestWithPortalAdmin,
    @Param('merchantCode') merchantCode: string,
  ): Promise<{ merchantCode: string; totals: unknown[] }> {
    const { tenantId, merchantId } = request.portalAdmin;
    const effectiveMerchantCode = await this.resolveEffectiveMerchantCode(
      merchantCode,
      merchantId,
      tenantId,
    );
    const rows = await this.countedLevel.findMerchantTotals(effectiveMerchantCode);
    return { merchantCode: effectiveMerchantCode, totals: rows.map(toMerchantGroup) };
  }

  /** Doc 04 §2.3. */
  @Get('tenants/:tenantId/summary')
  @RequirePortalRoles(...ALL_PORTAL_ROLES)
  async getTenantSummary(
    @Req() request: RequestWithPortalAdmin,
    @Param('tenantId') tenantIdParam: string,
  ): Promise<{ tenantId: number; totals: ShapedRewardGroup[] }> {
    const requestedTenantId = this.parsePositiveInt(tenantIdParam, 'tenantId');
    const { tenantId: claimTenantId } = request.portalAdmin;

    if (claimTenantId !== null && claimTenantId !== requestedTenantId) {
      // TC-3: rejected, never silently redirected to a different tenant's data (R11's own
      // "never a distinguishable exists-but-forbidden response" doesn't apply here — this is a
      // deliberate, explicit signal to a legitimate admin caller, not a probe of a secret's
      // existence).
      throw new ForbiddenException('Token is not authorized for this tenant');
    }
    const effectiveTenantId = claimTenantId ?? requestedTenantId;

    const rows = await this.countedLevel.findTenantTotals(effectiveTenantId);
    return { tenantId: effectiveTenantId, totals: rows.map(toShapedGroup) };
  }

  /** Doc 04 §2.4. See this file's own header — only `super_admin` can reach this endpoint today. */
  @Get('countries/:countryCode/summary')
  @RequirePortalRoles(...ALL_PORTAL_ROLES)
  async getCountrySummary(
    @Req() request: RequestWithPortalAdmin,
    @Param('countryCode') countryCode: string,
  ): Promise<{ countryCode: string; totals: ShapedRewardGroup[] }> {
    const { countryId } = request.portalAdmin;
    if (countryId !== null) {
      throw new ForbiddenException(
        'This service cannot verify a country_admin (or narrower) token against a country_code ' +
          '— see admin-rewards.controller.ts / counted-level-query.service.ts for the documented ' +
          'gap. Only a super_admin token can call this endpoint today.',
      );
    }
    const rows = await this.countedLevel.findCountryTotals(countryCode);
    return { countryCode, totals: rows.map(toShapedGroup) };
  }

  /** Doc 04 §2.5. */
  @Get('alerts')
  @RequirePortalRoles(...ALL_PORTAL_ROLES)
  async getAlerts(@Req() request: RequestWithPortalAdmin): Promise<{ alerts: RewardAlert[] }> {
    const { tenantId, countryId, merchantId } = request.portalAdmin;
    const alerts = await this.alerts.listAlerts({ tenantId, countryId, merchantId });
    return { alerts };
  }

  /**
   * `claims.merchantId === null` (every non-`merchant` role): no restriction, the path param is
   * used directly. `claims.merchantId` concrete (the `merchant` role, always): resolved via the
   * hierarchy-cache bridge (`counted-level-query.service.ts`'s own header) and that resolved code
   * — never the caller-supplied path param — is what's actually queried; an unresolvable or
   * mismatched merchant is a `403`, never a silent fall-through to the raw param.
   */
  private async resolveEffectiveMerchantCode(
    requestedMerchantCode: string,
    claimMerchantId: number | null,
    claimTenantId: number | null,
  ): Promise<string> {
    if (claimMerchantId === null) {
      return requestedMerchantCode;
    }
    const resolvedCode = await this.countedLevel.resolveMerchantCodeForId(
      claimMerchantId,
      claimTenantId,
    );
    if (resolvedCode === undefined) {
      throw new ForbiddenException(
        'Could not verify this token is authorized for any merchant (cache miss)',
      );
    }
    if (resolvedCode !== requestedMerchantCode) {
      throw new ForbiddenException('Token is not authorized for this merchant');
    }
    return resolvedCode;
  }

  private parsePositiveInt(raw: string, fieldName: string): number {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BadRequestException(`${fieldName} must be a positive integer`);
    }
    return parsed;
  }
}
