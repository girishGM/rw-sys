/**
 * T-RTS-031. Doc 04 §2.1 — the one portal-admin endpoint that reads
 * `reward_tracking.campaign_reward_counter_shard` (the sharded, hot-write aggregate, R7 — this
 * service only ever reads it here, never writes it). Also resolves *which* tenant a bare
 * `campaignCode` belongs to (the REST route carries no `tenantId` parameter, doc 04 §2.1) and joins
 * in cap/consumption-percent display fields from `campaign_hierarchy_cache`'s mirrored
 * `hierarchy.caps` (doc 02 §7) — read-only, informational (implementation note 3: "this service
 * still never decides anything from them", R1).
 *
 * **A real, load-bearing gap found while wiring this task in, not silently worked around.**
 * `campaign_hierarchy_cache.hierarchy` is populated by `CampaignHierarchyClient`
 * (T-RTS-020, `campaign-hierarchy.client.ts`'s own `DEFAULT_CONFIG_SECTIONS`), which requests only
 * `BASIC`/`MERCHANTS`/`TRACKERS` — never `CAPS`. That means `hierarchy.caps` is `[]` for every row
 * this service actually caches in production today, so `capMaxTotalAmount`/`consumptionPercent`/
 * `warnAtPercent`/`warnTriggered` will never appear on a live response until T-RTS-020's own
 * `DEFAULT_CONFIG_SECTIONS` (agent-rts-config's owned file, out of this task's scope — R10) is
 * extended to request `CAPS` too. This task's own tests below seed `campaign_hierarchy_cache` rows
 * directly (never through the live gRPC client), so they exercise the join logic itself
 * byte-for-byte against doc 03 §4's worked example independent of that upstream gap — flagged here
 * and in this task's completion report for the architect, not filed as a blocking defect since
 * nothing in this task's own Definition of Done depends on the live feed actually carrying `CAPS`
 * yet.
 *
 * **Tenant resolution, not just tenant scoping.** Every other query in this design takes
 * `tenantId` as a given, verified parameter (T-RTS-030's own customer endpoints; §§2.2-2.4 below).
 * This endpoint's path is `campaignCode` alone — for a `super_admin`/`country_admin` token (whose
 * own `tenantId` claim is `null`, meaning "every tenant"), the only place this service can learn
 * which tenant a bare `campaignCode` belongs to is this very cache. A cache miss for such a caller
 * is therefore a genuine "cannot resolve, not just cannot authorize" case — see
 * {@link resolveTenantAndVerifyCountry}'s own header for the exact fallback ladder, and
 * `admin-rewards.controller.ts`'s header for why this is safe (never gates an award, R1 — the
 * worst outcome is a 404, never a wrong tenant's data).
 */
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type { RewardKind } from '@/database/models/reward-fact.model';
import {
  shapeRewardGroup,
  type NonSummableRewardGroup,
  type ShapedRewardGroup,
  type SummableRewardGroup,
} from './reward-kind-response-shaper';

/** DI token for this module's own runtime Postgres connection (the least-privilege
 * `reward_tracking_app` role, AGENT-PROTOCOL.md R2) — same "no shared application-level
 * `DatabaseModule` exists yet" situation every sibling module in this repo already documents for
 * its own table; `admin-rewards.module.ts` (T-RTS-031's own DI wiring) builds the actual
 * connection and shares this one token across every query service this task owns. */
export const ADMIN_REWARDS_SEQUELIZE = Symbol('ADMIN_REWARDS_SEQUELIZE');

/** One `GROUP BY reward_category, reward_kind, unit_type, unit_code` rollup row over
 * `campaign_reward_counter_shard`, doc 04 §2.1's own query, verbatim. */
export interface CampaignRewardGroupTotalsRow {
  reward_category: string;
  reward_kind: RewardKind | null;
  unit_type: string | null;
  unit_code: string | null;
  total_value: string;
  total_count: string;
}

/** The four cap/consumption display fields, present only on a summable row with a matching
 * campaign-level `budget` cap (doc 04 §2.1's own worked example) — never on a non-summable row
 * (R4: a rate/count has no currency-denominated cap to compare against), and never present at all
 * absent a match, same "absent, not null/zero" discipline `reward-kind-response-shaper.ts`'s own
 * header states for `totalValue`. */
export interface CampaignCapDisplayFields {
  capMaxTotalAmount: string;
  consumptionPercent: number;
  warnAtPercent: number;
  warnTriggered: boolean;
}

/** `Partial<CampaignCapDisplayFields>` (not the full, required shape) on the summable branch —
 * the cap fields are attached only when a matching cap is actually found ({@link attachCapDisplay}),
 * so `'warnTriggered' in group` narrows cleanly for every caller (`alerts-query.service.ts`) without
 * an unsafe cast, and a summable row with no cap match is still exactly `SummableRewardGroup`'s own
 * key set, no fabricated `undefined`-valued keys. */
export type CampaignSummaryGroup =
  (SummableRewardGroup & Partial<CampaignCapDisplayFields>) | NonSummableRewardGroup;

/** `campaign_hierarchy_cache.hierarchy`'s shape as this task actually reads it — a subset of
 * `campaign-hierarchy.client.ts`'s own `CampaignConfigProto` (T-RTS-020, read-only, never
 * reimplemented as a full proto mirror here since this task only ever reads three fields off it). */
interface CachedCampaignCap {
  capClass: string;
  scopeLevel: string;
  scopeRefId: number;
  unitType: string;
  unitCode: string;
  rewardType: string;
  maxTotalAmount: string;
  warnAtPercent: number;
}

interface CachedMerchantRef {
  merchantId: number;
  merchantCode: string;
}

interface CachedCampaignHierarchy {
  countryId?: number;
  merchants?: CachedMerchantRef[];
  caps?: CachedCampaignCap[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asHierarchy(value: unknown): CachedCampaignHierarchy {
  return isPlainObject(value) ? (value as CachedCampaignHierarchy) : {};
}

/** `null`/absent countryId means "this cached campaign doesn't tell us its country" — treated the
 * same as a cache miss by the one caller that needs it ({@link resolveTenantAndVerifyCountry}). */
export function extractCountryId(hierarchy: unknown): number | undefined {
  const value = asHierarchy(hierarchy).countryId;
  return typeof value === 'number' ? value : undefined;
}

/** Every merchant participating in this cached campaign, `merchantId`+`merchantCode` pairs
 * (`CampaignConfigProto.merchants[].merchantId`/`.merchantCode`) — used only by
 * `counted-level-query.service.ts`'s own merchant-code<->id best-effort resolution, exported here
 * since this is this task's one file that already knows this jsonb shape. */
export function extractMerchantRefs(hierarchy: unknown): CachedMerchantRef[] {
  const merchants = asHierarchy(hierarchy).merchants;
  return Array.isArray(merchants) ? merchants : [];
}

function extractCaps(hierarchy: unknown): CachedCampaignCap[] {
  const caps = asHierarchy(hierarchy).caps;
  return Array.isArray(caps) ? caps : [];
}

/**
 * Doc 04 §2.1's own cap-join rule, inferred from its worked example (no `scope_ref_id`/`period_*`
 * matching spelled out there — this task's own reasonable, documented reading, not copied
 * verbatim, per the same "inferred, not copied verbatim, flagged" precedent
 * `007_create_campaign_hierarchy_cache.ts` already set for this exact table): a campaign-level
 * (`scope_level = 'campaign'`), pooled (`cap_class = 'budget'`) cap in the same unit
 * (`unit_type`/`unit_code`), whose `reward_type` (proto's own "optional narrowing; empty = all
 * types in this unit") is either empty or names this row's own `reward_category`.
 */
function findMatchingCap(
  caps: readonly CachedCampaignCap[],
  group: { rewardCategory: string; unitType: string | null; unitCode: string | null },
): CachedCampaignCap | undefined {
  return caps.find((cap) => {
    if (cap.capClass !== 'budget' || cap.scopeLevel !== 'campaign') {
      return false;
    }
    const capUnitType = cap.unitType || null;
    const capUnitCode = cap.unitCode || null;
    if (capUnitType !== group.unitType || capUnitCode !== group.unitCode) {
      return false;
    }
    return !cap.rewardType || cap.rewardType === group.rewardCategory;
  });
}

/** Never attaches a cap field to a non-summable row (`'totalValue' in shaped` is false for one,
 * R4) and never attaches one when no cap matches, or the matched cap's own `maxTotalAmount` isn't
 * a usable positive number — same "absent, not a fabricated zero" rule as the shaper it wraps. */
function attachCapDisplay(
  shaped: ShapedRewardGroup,
  cap: CachedCampaignCap | undefined,
): CampaignSummaryGroup {
  if (!cap || !('totalValue' in shaped)) {
    return shaped;
  }
  const maxTotal = Number(cap.maxTotalAmount);
  if (!Number.isFinite(maxTotal) || maxTotal <= 0) {
    return shaped;
  }
  const consumptionPercent = Math.round((Number(shaped.totalValue) / maxTotal) * 100);
  return {
    ...shaped,
    capMaxTotalAmount: cap.maxTotalAmount,
    consumptionPercent,
    warnAtPercent: cap.warnAtPercent,
    warnTriggered: consumptionPercent >= cap.warnAtPercent,
  };
}

/** Type guard for the one shape `alerts-query.service.ts` cares about: a summable row that
 * actually got every cap field attached together (`attachCapDisplay` always sets all four or
 * none — never a partial set), narrowing away both `NonSummableRewardGroup` and a
 * cap-field-less `SummableRewardGroup` in one check. */
export function hasCapDisplay(
  group: CampaignSummaryGroup,
): group is SummableRewardGroup & CampaignCapDisplayFields {
  return 'warnTriggered' in group && group.warnTriggered !== undefined;
}

interface CacheRow {
  tenant_id: number;
  hierarchy: unknown;
}

@Injectable()
export class CampaignSummaryQueryService {
  constructor(@Inject(ADMIN_REWARDS_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * Doc 04 §2.1's own query, verbatim, plus this task's own cap join. Callers that already know
   * `tenantId` (the controller, post-{@link resolveTenantAndVerifyCountry}; `alerts-query.service.ts`
   * iterating its own candidate campaign list) call this directly — no re-resolution.
   */
  async computeCampaignSummary(
    tenantId: number,
    campaignCode: string,
  ): Promise<CampaignSummaryGroup[]> {
    const [rows, cacheRow] = await Promise.all([
      this.sumShardRows(tenantId, campaignCode),
      this.findCacheRow(campaignCode, tenantId),
    ]);
    const caps = cacheRow ? extractCaps(cacheRow.hierarchy) : [];

    return rows.map((row) => {
      const shaped = shapeRewardGroup({
        rewardCategory: row.reward_category,
        rewardKind: row.reward_kind,
        unitType: row.unit_type,
        unitCode: row.unit_code,
        totalValue: row.total_value,
        totalCount: Number(row.total_count),
      });
      const cap = findMatchingCap(caps, {
        rewardCategory: row.reward_category,
        unitType: row.unit_type,
        unitCode: row.unit_code,
      });
      return attachCapDisplay(shaped, cap);
    });
  }

  /**
   * The controller's own entry point (R8 — the controller itself does no tenant-resolution logic).
   * `requiredTenantId`/`requiredCountryId` are `null` for "unrestricted in that dimension"
   * (`portal-admin-auth.guard.ts`'s own scope-triple semantics, `assertPortalAdminScope`'s own
   * header) — a concrete value is enforced, `null` defers entirely to the cache/path.
   *
   * **Fallback ladder, most-trusted source first:**
   * 1. A cache row for this `campaignCode` (scoped to `requiredTenantId` when concrete) — gives
   *    both the effective `tenantId` and, when `requiredCountryId` is concrete, a same-service,
   *    numeric-id-to-numeric-id country check (no code/id translation needed — see
   *    `admin-rewards.controller.ts`'s own header on why country/merchant *_code_ scoping is a
   *    separate, harder problem `counted-level-query.service.ts` has to solve instead).
   * 2. No cache row, but `requiredTenantId` is concrete (a `tenant_admin`/`maker`/`checker`/
   *    `merchant` token) — trust the claim directly; cap fields are simply omitted (R1: this cache
   *    is display-only, a miss degrades the response, never blocks it).
   * 3. No cache row and no claim-provided `tenantId` (`super_admin`/`country_admin` on a campaign
   *    this instance has never cached) — this service has no third source of a bare
   *    `campaignCode`'s tenant (doc 04 §2.1's own route carries no `tenantId` parameter); 404,
   *    not a guess.
   */
  async resolveTenantAndVerifyCountry(params: {
    campaignCode: string;
    requiredTenantId: number | null;
    requiredCountryId: number | null;
  }): Promise<{ tenantId: number }> {
    const cacheRow = await this.findCacheRow(params.campaignCode, params.requiredTenantId);

    if (cacheRow) {
      if (params.requiredCountryId !== null) {
        const countryId = extractCountryId(cacheRow.hierarchy);
        if (countryId !== params.requiredCountryId) {
          throw new ForbiddenException("Token is not authorized for this campaign's country");
        }
      }
      return { tenantId: cacheRow.tenant_id };
    }

    if (params.requiredTenantId !== null) {
      return { tenantId: params.requiredTenantId };
    }

    throw new NotFoundException(
      `Campaign ${params.campaignCode} is not in this service's campaign hierarchy cache — cannot ` +
        'resolve which tenant it belongs to.',
    );
  }

  private async sumShardRows(
    tenantId: number,
    campaignCode: string,
  ): Promise<CampaignRewardGroupTotalsRow[]> {
    return this.sequelize.query<CampaignRewardGroupTotalsRow>(
      `SELECT reward_category, reward_kind, unit_type, unit_code,
              SUM(total_reward_value)::text AS total_value,
              SUM(total_reward_count)::text AS total_count
         FROM reward_tracking.campaign_reward_counter_shard
        WHERE tenant_id = :tenantId AND campaign_code = :campaignCode
        GROUP BY reward_category, reward_kind, unit_type, unit_code`,
      { type: QueryTypes.SELECT, replacements: { tenantId, campaignCode } },
    );
  }

  private async findCacheRow(
    campaignCode: string,
    requiredTenantId: number | null,
  ): Promise<CacheRow | undefined> {
    const rows = await this.sequelize.query<CacheRow>(
      `SELECT tenant_id, hierarchy
         FROM reward_tracking.campaign_hierarchy_cache
        WHERE campaign_code = :campaignCode
          AND (:tenantId::int IS NULL OR tenant_id = :tenantId)
        ORDER BY tenant_id
        LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: { campaignCode, tenantId: requiredTenantId },
      },
    );
    return rows[0];
  }
}
