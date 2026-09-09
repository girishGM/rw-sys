/**
 * T-RR-007. `POST /api/v1/cache/invalidate`'s own domain logic (`04-REST-CONTRACT.md` §4,
 * `06-CACHING-AND-TENANT-CONFIG.md` §3) — thin controller (`cache-invalidation.controller.ts`)
 * delegates here so the HTTP-shape concerns (guard, status codes) stay separate from "which caches
 * exist and how a request maps onto them".
 *
 * **T-RR-054**: `registry` now carries all five caches `06-CACHING-AND-TENANT-CONFIG.md` §1
 * lists, including `campaignConfig` (`CampaignConfigCache`, T-RR-022's own, from
 * `ProcessingModule`). Wiring this in was blocked until T-RR-055 fixed `CampaignConfigClient`/
 * `CampaignConfigCache`'s real-Nest-DI construction (see that task's own completion report) —
 * importing `ProcessingModule` before that landed would have crashed `AppModule`'s real boot.
 * `campaignConfig` is no longer a "recognized but not yet active" stub name; a request naming it
 * is routed exactly like every other cache, with one addition: §3's own scoped-clear shape
 * (`{"key": "campaignConfig", "campaignCode": "X", "tenantId": 1}`) narrows the clear to that one
 * `(tenantId, campaignCode)` entry via `CampaignConfigCache.invalidateOne` instead of clearing the
 * whole cache — the only one of the five caches with a scoped-clear request shape at all.
 *
 * **T-RR-060**: `cache_invalidation_total{key}` (`07-CONFIGURABILITY-AND-OBSERVABILITY.md` §3) was
 * fixed as one of the 7 required metrics from the start but never actually incremented anywhere in
 * the tree (`agent-rr-qa`'s T-RR-040 audit reproduced this — zero call sites). Both terminal,
 * successfully-processed branches now increment it, right alongside the existing audit-log write
 * they already sit next to: `invalidateAll` with the literal key `'all'`, `invalidateOne` with the
 * real cache key. Imports `ObservabilityModule` for `MetricsRegistry` the same way every other
 * consuming module already does (see that module's own header) — a validation failure (malformed
 * request or unknown key) throws before either call site is reached, so a rejected request never
 * increments this counter, matching §3's own "one ... call processed" framing.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import type { InvalidatableCache } from '@/modules/tenant-schema-cache/invalidatable-cache.interface';
import { DispatchChannelConfigCache } from '@/modules/tenant-schema-cache/dispatch-channel-config.cache';
import { ExternalRewardSystemConfigCache } from '@/modules/tenant-schema-cache/external-reward-system-config.cache';
import { ServiceConfigCache } from '@/modules/tenant-schema-cache/service-config.cache';
import { TenantSchemaConfigCache } from '@/modules/tenant-schema-cache/tenant-schema-config.cache';
import { CampaignConfigCache } from '@/modules/processing/campaign-config.cache';
import { MetricsRegistry } from '@/observability/metrics.registry';
import { CacheInvalidationAuditRepository } from './cache-invalidation-audit.repository';
import type {
  CacheInvalidateRequest,
  CacheInvalidateResponse,
} from './cache-invalidate-request.dto';

/** `07-CONFIGURABILITY-AND-OBSERVABILITY.md` §3's own literal label value for a whole-registry
 * clear — distinct from any real cache name in `registry`. */
const ALL_CACHES_METRIC_KEY = 'all';

/** `campaignConfig`'s own key name — the one cache in `registry` that also supports a
 * narrow-clear request shape (`campaignCode`/`tenantId` present), handled by `invalidateOne`
 * before falling through to the generic `InvalidatableCache.invalidate()` path every other cache
 * uses. */
const CAMPAIGN_CONFIG_CACHE_KEY = 'campaignConfig';

@Injectable()
export class CacheInvalidationService {
  private readonly registry: ReadonlyMap<string, InvalidatableCache>;

  constructor(
    tenantSchemaConfigCache: TenantSchemaConfigCache,
    externalRewardSystemConfigCache: ExternalRewardSystemConfigCache,
    dispatchChannelConfigCache: DispatchChannelConfigCache,
    serviceConfigCache: ServiceConfigCache,
    private readonly campaignConfigCache: CampaignConfigCache,
    private readonly auditRepository: CacheInvalidationAuditRepository,
    private readonly metrics: MetricsRegistry,
  ) {
    this.registry = new Map<string, InvalidatableCache>([
      ['tenantSchemaConfig', tenantSchemaConfigCache],
      ['externalRewardSystemConfig', externalRewardSystemConfigCache],
      ['dispatchChannelConfig', dispatchChannelConfigCache],
      ['serviceConfig', serviceConfigCache],
      [CAMPAIGN_CONFIG_CACHE_KEY, campaignConfigCache],
    ]);
  }

  async invalidate(
    request: CacheInvalidateRequest,
    invokedBy: string,
  ): Promise<CacheInvalidateResponse> {
    this.validate(request);

    if (request.all === true) {
      return this.invalidateAll(invokedBy);
    }

    // `validate` already guarantees `key` is a non-empty string when `all` isn't `true`.
    return this.invalidateOne(
      request.key as string,
      invokedBy,
      request.campaignCode,
      request.tenantId,
    );
  }

  private async invalidateAll(invokedBy: string): Promise<CacheInvalidateResponse> {
    for (const cache of this.registry.values()) {
      cache.invalidate();
    }
    // `cache_key = NULL` records "the request invalidated everything" (`01-DATABASE.md` §11).
    await this.auditRepository.record(null, invokedBy);
    this.metrics.incrementCacheInvalidation(ALL_CACHES_METRIC_KEY);
    return {
      invalidated: Array.from(this.registry.keys()),
      invalidatedAt: new Date().toISOString(),
    };
  }

  private async invalidateOne(
    key: string,
    invokedBy: string,
    campaignCode?: string,
    tenantId?: number,
  ): Promise<CacheInvalidateResponse> {
    const cache = this.registry.get(key);
    if (!cache) {
      throw new BadRequestException(`Unknown cache key "${key}"`);
    }

    // §3's own scoped-clear shape — only `campaignConfig` supports it; every other cache's own
    // scoping fields (none exist) fall through to the generic whole-cache `invalidate()` below.
    if (key === CAMPAIGN_CONFIG_CACHE_KEY && campaignCode !== undefined && tenantId !== undefined) {
      this.campaignConfigCache.invalidateOne(tenantId, campaignCode);
    } else {
      cache.invalidate();
    }

    await this.auditRepository.record(key, invokedBy);
    this.metrics.incrementCacheInvalidation(key);
    return { invalidated: [key], invalidatedAt: new Date().toISOString() };
  }

  private validate(request: CacheInvalidateRequest): void {
    const hasKey = typeof request.key === 'string' && request.key.length > 0;
    const hasAll = request.all === true;
    if (hasKey === hasAll) {
      // Both false (neither field given) or both true (ambiguous — a caller must pick one shape)
      // are equally invalid; §3 only defines these two, mutually exclusive request shapes.
      throw new BadRequestException(
        'Request body must contain exactly one of a non-empty "key" or "all": true',
      );
    }
  }
}
