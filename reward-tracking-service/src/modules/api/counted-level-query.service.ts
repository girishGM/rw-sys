/**
 * T-RTS-031. Doc 04 §§2.2-2.4 — live `COUNT`/`SUM` queries over `reward_tracking.reward_fact` for
 * the merchant/tenant/country admin summaries. "Live", not cached, deliberately (doc 04 §3: "nothing
 * is pre-aggregated at those levels" — a query-optimization concern to revisit later, not solved
 * here).
 *
 * ## The merchant/country scoping gap this file exists to bridge (flagged in this task's own
 * completion report, not silently invented)
 *
 * `reward_fact` stores business codes throughout — `merchant_code`, `country_code` — never the
 * portal's own numeric surrogate ids. `portal-admin-auth.guard.ts`'s own `PortalAdminTokenClaims`
 * (T-RTS-032, already reviewed/`done`, out of this task's file scope — R10) carries exactly the
 * opposite: `merchantId`/`countryId`/`tenantId`, all numeric, mirroring the portal's own
 * browser-facing `AccessTokenClaims` shape verbatim. `tenantId` happens to need no bridge at all
 * (`reward_fact.tenant_id` is itself numeric) — but a `merchant`-role token's own `merchantId` has
 * no numeric column in `reward_fact` to compare against directly, and a `country_admin`-role
 * token's own `countryId` has **no bridge anywhere in this service at all**: `reward_config.countries`
 * (`id` <-> `code`) is a different Postgres schema this service's DB role has no grant to read
 * (R2), and the portal's own `CampaignConfig` wire contract (`campaign-cache/proto/campaign_config.proto`)
 * carries `country_id` but never a `country_code` field anywhere reachable from it — confirmed by
 * reading that file directly, not assumed.
 *
 * **Resolution applied here, differentiated by what's actually resolvable:**
 *  - **Tenant**: no bridge needed — `claims.tenantId` compares directly against `reward_fact.tenant_id`.
 *  - **Merchant**: bridgeable, best-effort, via `campaign_hierarchy_cache.hierarchy.merchants[]`
 *    (`merchantId`+`merchantCode` pairs, mirrored from the same portal feed T-RTS-020 already
 *    caches) — {@link resolveMerchantCodeForId}. A miss (the merchant participates in no cached
 *    campaign yet, or the cache is cold) fails **closed** (`undefined`), never open.
 *  - **Country**: genuinely NOT bridgeable with any data this service holds or is grant to read —
 *    a `country_admin` (or any role whose own `countryId` claim is concrete) calling
 *    `/countries/{countryCode}/summary` is rejected outright by `admin-rewards.controller.ts`
 *    ({@link https://} see that file's own header) rather than either (a) trusting the caller-supplied
 *    `countryCode` unchecked — a real cross-country leak, exactly this task's own risk warning — or
 *    (b) silently inventing a mapping this service cannot actually verify. Only a `super_admin`
 *    token (`countryId: null`, "every country") can use that endpoint today. **This is a genuine,
 *    unresolved architecture gap** — the fix belongs to whichever of (a portal-minted, RTS-specific
 *    token that also carries `countryCode`), (b) a `country_code` field added to the portal's own
 *    `CampaignConfig`/`campaign_hierarchy_cache` mirror, or (c) a small, explicitly-owned static
 *    country id<->code reference this service is granted to read — an architect decision, not a
 *    default this task should silently pick for a cross-tenant-isolation-risk surface (this task's
 *    own header risk rating; AGENT-PROTOCOL.md §7's "never weaken a guard to make a test green").
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type { RewardKind } from '@/database/models/reward-fact.model';
import { ADMIN_REWARDS_SEQUELIZE, extractMerchantRefs } from './campaign-summary-query.service';

/** One `GROUP BY reward_category, reward_kind, unit_type, unit_code` rollup row over
 * `reward_fact`, shared shape for merchant/tenant/country (doc 04 §§2.2-2.4) —
 * `distinct_customers` is only ever selected for the merchant query (§2.2's own worked example). */
export interface RewardFactGroupTotalsRow {
  reward_category: string;
  reward_kind: RewardKind | null;
  unit_type: string | null;
  unit_code: string | null;
  total_value: string;
  total_count: string;
  distinct_customers?: string;
}

@Injectable()
export class CountedLevelQueryService {
  constructor(@Inject(ADMIN_REWARDS_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /** Doc 04 §2.2, verbatim — the one query in this file that also counts distinct customers. */
  async findMerchantTotals(merchantCode: string): Promise<RewardFactGroupTotalsRow[]> {
    return this.sequelize.query<RewardFactGroupTotalsRow>(
      `SELECT reward_category, reward_kind, unit_type, unit_code,
              SUM(reward_value)::text AS total_value,
              COUNT(*)::text AS total_count,
              COUNT(DISTINCT customer_id_hash)::text AS distinct_customers
         FROM reward_tracking.reward_fact
        WHERE merchant_code = :merchantCode
        GROUP BY reward_category, reward_kind, unit_type, unit_code`,
      { type: QueryTypes.SELECT, replacements: { merchantCode } },
    );
  }

  /** Doc 04 §2.3, verbatim. */
  async findTenantTotals(tenantId: number): Promise<RewardFactGroupTotalsRow[]> {
    return this.sequelize.query<RewardFactGroupTotalsRow>(
      `SELECT reward_category, reward_kind, unit_type, unit_code,
              SUM(reward_value)::text AS total_value,
              COUNT(*)::text AS total_count
         FROM reward_tracking.reward_fact
        WHERE tenant_id = :tenantId
        GROUP BY reward_category, reward_kind, unit_type, unit_code`,
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );
  }

  /** Doc 04 §2.4, verbatim. */
  async findCountryTotals(countryCode: string): Promise<RewardFactGroupTotalsRow[]> {
    return this.sequelize.query<RewardFactGroupTotalsRow>(
      `SELECT reward_category, reward_kind, unit_type, unit_code,
              SUM(reward_value)::text AS total_value,
              COUNT(*)::text AS total_count
         FROM reward_tracking.reward_fact
        WHERE country_code = :countryCode
        GROUP BY reward_category, reward_kind, unit_type, unit_code`,
      { type: QueryTypes.SELECT, replacements: { countryCode } },
    );
  }

  /**
   * Best-effort `merchantId` (portal numeric surrogate, from the verified claim) -> `merchantCode`
   * (`reward_fact`'s own business key) resolution, via every merchant this service has ever cached
   * off *any* campaign's `hierarchy.merchants[]` (this file's own header). Scoped to `tenantId` when
   * the caller's own claim provides one (narrows the search, never widens it); `undefined` on no
   * match — the controller's own job to fail closed on that (never falls back to trusting the raw
   * path param instead).
   */
  async resolveMerchantCodeForId(
    merchantId: number,
    tenantId: number | null,
  ): Promise<string | undefined> {
    const rows = await this.sequelize.query<{ hierarchy: unknown }>(
      `SELECT hierarchy
         FROM reward_tracking.campaign_hierarchy_cache
        WHERE (:tenantId::int IS NULL OR tenant_id = :tenantId)`,
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );
    for (const row of rows) {
      const match = extractMerchantRefs(row.hierarchy).find((m) => m.merchantId === merchantId);
      if (match) {
        return match.merchantCode;
      }
    }
    return undefined;
  }
}
