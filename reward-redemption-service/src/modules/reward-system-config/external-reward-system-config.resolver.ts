/**
 * T-RR-023. Resolves `external_reward_system_config` (`01-DATABASE.md` §3) for a
 * `system_code`/tenant pair, applying `05-PROCESSING-PIPELINE.md` §4 point 2's
 * tenant-specific-overrides-tenant-agnostic precedence — the same `tenant_key =
 * coalesce(tenant_id, -1)` trick `uq_ersc_system_tenant` enforces at the schema level, resolved
 * here as two cache lookups against T-RR-007's own `ExternalRewardSystemConfigCache`
 * (`@/modules/tenant-schema-cache/external-reward-system-config.cache`), never a single query that
 * could non-deterministically pick either row when both exist.
 *
 * "No active connector-config row for this system_code/tenant" is a legitimate, non-throwing
 * outcome (§4 point 2: "there is genuinely nothing to call... this entry takes the direct
 * `→ completed` path") — `resolve()` returns `null` for it, never throws. A thrown error out of
 * this resolver means resolution itself failed (a DB error surfaced through the cache's own
 * repository), a materially different outcome T-RR-021's state machine and T-RR-024's
 * orchestration both depend on being able to tell apart from "no config found" (implementation
 * note 2).
 *
 * A row that exists but is `status = 'inactive'` is treated identically to "no row at all" at
 * whichever tier it was found — an inactive tenant-specific override does not itself resolve to
 * "nothing to call"; resolution simply continues on to the tenant-agnostic row, exactly as it
 * would if no tenant-specific row existed. Only when neither tier yields an *active* row does
 * this resolver report "no active config" (`null`).
 */
import { Injectable } from '@nestjs/common';
import type { ExternalRewardSystemConfigRow } from '@/database/models/external-reward-system-config.model';
import { ExternalRewardSystemConfigCache } from '@/modules/tenant-schema-cache/external-reward-system-config.cache';

function isActive(row: ExternalRewardSystemConfigRow | null): row is ExternalRewardSystemConfigRow {
  return row !== null && row.status === 'active';
}

@Injectable()
export class ExternalRewardSystemConfigResolver {
  constructor(private readonly cache: ExternalRewardSystemConfigCache) {}

  /**
   * Returns the resolved *active* `external_reward_system_config` row for `systemCode`, or `null`
   * if no active row resolves at either the tenant-specific or tenant-agnostic (`NULL`-tenant)
   * level (TC-1…TC-3).
   */
  async resolve(
    systemCode: string,
    tenantId: number | null | undefined,
  ): Promise<ExternalRewardSystemConfigRow | null> {
    if (tenantId !== null && tenantId !== undefined) {
      const tenantSpecific = await this.cache.get({ systemCode, tenantId });
      if (isActive(tenantSpecific)) {
        return tenantSpecific;
      }
    }
    const global = await this.cache.get({ systemCode, tenantId: null });
    return isActive(global) ? global : null;
  }
}
