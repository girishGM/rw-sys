/**
 * T-RR-022. The fifth cache `06-CACHING-AND-TENANT-CONFIG.md` §1 lists — `campaignConfig`, keyed
 * `(tenant_id, campaign_code)`, sourced from the portal's gRPC `CampaignConfigService` feed via
 * `CampaignConfigClient` rather than a local DB table (the shape every other cache in
 * `tenant-schema-cache/` uses). Follows the exact same `TtlCache`-backed, `InvalidatableCache`-
 * implementing shape those four caches already establish (`ttl-cache.ts`,
 * `invalidatable-cache.interface.ts` — read-only imports from `agent-rr-foundation`'s own file
 * scope, R3; this file never edits either).
 *
 * **TTL resolution has its own documented fallback, mirroring `ReconciliationPollerService`'s own
 * precedent** (`reconciliation-poller.service.ts`'s `resolveIntervalMs`, confirmed by direct
 * read): `cache.ttl.campaignConfig.seconds` has no seed row in `015_seed_service_config_defaults.ts`
 * as of this task (that migration is `src/database/**`, `agent-rr-foundation`'s exclusive file
 * scope, R3 — this task cannot add its own seed row there without a separate, explicitly granted
 * single-file exception; see this task's own completion report). Rather than let every real
 * resolution of this cache's own TTL throw `ServiceConfigNotFoundError` in a fresh environment,
 * this class catches that failure and falls back to `DEFAULT_CAMPAIGN_CONFIG_TTL_MS` — the exact
 * "log a warning, keep going with a sane compiled-in default" idiom `ReconciliationPollerService`
 * already established for the identical "not yet seeded" situation, not a new pattern invented
 * here.
 *
 * **Narrow-clear semantics (`invalidateOne`)** — `06-CACHING-AND-TENANT-CONFIG.md` §3's own
 * `campaignConfig`-specific scoped-clear shape (`{"key": "campaignConfig", "campaignCode": "X",
 * "tenantId": 1}`) — clears only the one `(tenantId, campaignCode)` entry, leaving every other
 * cached campaign (including a different campaign for the *same* tenant) untouched. `invalidate()`
 * with no arguments (the `InvalidatableCache` contract every other cache in this service already
 * implements) clears the whole cache, for the `{"all": true}` sweep.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { InvalidatableCache } from '@/modules/tenant-schema-cache/invalidatable-cache.interface';
import { ServiceConfigCache } from '@/modules/tenant-schema-cache/service-config.cache';
import { TtlCache } from '@/modules/tenant-schema-cache/ttl-cache';
import {
  CampaignConfigClient,
  loadPortalConfigTenantIds,
  type CampaignConfigProto,
} from './campaign-config.client';

/** Dot-namespaced under `cache.ttl.*`, matching every other cache's own key
 * (`06-CACHING-AND-TENANT-CONFIG.md` §2). */
export const CAMPAIGN_CONFIG_TTL_KEY = 'cache.ttl.campaignConfig.seconds';

/** This class's own compiled-in fallback (this file's own header) — 300s, aligned with the other
 * four caches' own seeded default and with `cache.reconciliationPoll.intervalSeconds`'s default,
 * for the same "cold cache refreshed on roughly the same cadence" reasoning
 * `015_seed_service_config_defaults.ts` already documents for its own seeded values. */
export const DEFAULT_CAMPAIGN_CONFIG_TTL_MS = 300_000;

function buildCacheKey(tenantId: number, campaignCode: string): string {
  return `${tenantId}::${campaignCode}`;
}

@Injectable()
export class CampaignConfigCache implements InvalidatableCache {
  private readonly logger = new Logger(CampaignConfigCache.name);
  private readonly cache = new TtlCache<string, CampaignConfigProto>();
  private readonly tenantIds: readonly number[];

  /**
   * T-RR-055. `@Optional()` on `tenantIds` fixes the identical real-Nest-DI defect
   * `CampaignConfigClient`'s own constructor had (see that file's header for the full mechanism):
   * `readonly number[]` has no runtime provider token Nest's automatic constructor-injection can
   * resolve either, so without `@Optional()` this parameter fails to resolve and Nest throws at
   * module-compile time instead of ever reaching this constructor's default value. `client` and
   * `serviceConfigCache` are real, `@Injectable()`-decorated classes with genuine DI tokens — Nest
   * resolves both of those from `ProcessingModule`'s own providers/imports without any special
   * handling, same as any other constructor-injected service in this codebase.
   */
  constructor(
    private readonly client: CampaignConfigClient,
    private readonly serviceConfigCache: ServiceConfigCache,
    @Optional() tenantIds: readonly number[] = loadPortalConfigTenantIds(),
  ) {
    this.tenantIds = tenantIds;
  }

  /** TC-1/TC-3: a cache hit within TTL never calls the portal again. TC-5/TC-2 rely on the raw
   * `CampaignConfigProto` this returns being passed unchanged to `RewardSystemResolutionService`. */
  async get(tenantId: number, campaignCode: string): Promise<CampaignConfigProto> {
    const key = buildCacheKey(tenantId, campaignCode);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const config = await this.client.getCampaignConfig(tenantId, campaignCode);
    const ttlMs = await this.ttlMs();
    this.cache.set(key, config, ttlMs);
    return config;
  }

  /** `{"all": true}` sweep / a bare `{"key": "campaignConfig"}` with no scoping fields — clears
   * every cached campaign for every tenant. */
  invalidate(): void {
    this.cache.invalidate();
  }

  /** `06-CACHING-AND-TENANT-CONFIG.md` §3's own narrow-clear shape — TC-4. */
  invalidateOne(tenantId: number, campaignCode: string): void {
    this.cache.invalidate(buildCacheKey(tenantId, campaignCode));
  }

  /** `06-CACHING-AND-TENANT-CONFIG.md` §4's reconciliation safety net — wholesale re-fetch of
   * every active campaign for every tenant this instance manages (`PORTAL_CONFIG_TENANT_IDS`),
   * regardless of whether any individual `(tenantId, campaignCode)` has been read since the last
   * cycle, exactly like the other four caches' own `refreshAll()`. */
  async refreshAll(): Promise<void> {
    const ttlMs = await this.ttlMs();
    this.cache.invalidate();
    for (const tenantId of this.tenantIds) {
      // eslint-disable-next-line no-await-in-loop -- a handful of tenants per instance
      // (`PORTAL_CONFIG_TENANT_IDS`), sequential is simpler and this runs on a multi-minute
      // interval, not a request path (mirrors `015_seed_service_config_defaults.ts`'s own
      // identical justification for a sequential loop in a low-frequency, non-hot path).
      const list = await this.client.listActiveCampaigns(tenantId);
      for (const config of list.campaigns) {
        this.cache.set(buildCacheKey(tenantId, config.campaignCode), config, ttlMs);
      }
    }
  }

  private async ttlMs(): Promise<number> {
    try {
      const seconds = await this.serviceConfigCache.resolve(CAMPAIGN_CONFIG_TTL_KEY, 'int', {});
      return seconds * 1000;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Could not resolve ${CAMPAIGN_CONFIG_TTL_KEY} (${message}) — falling back to the ` +
          `${DEFAULT_CAMPAIGN_CONFIG_TTL_MS}ms default.`,
      );
      return DEFAULT_CAMPAIGN_CONFIG_TTL_MS;
    }
  }
}
