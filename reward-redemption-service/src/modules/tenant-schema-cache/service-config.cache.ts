/**
 * T-RR-007. Wraps T-RR-006's `ServiceConfigResolverService` with a TTL cache, per
 * `06-CACHING-AND-TENANT-CONFIG.md` §1's "the fourth of the five listed there" — the fourth of the
 * four caches this task owns (the fifth, `campaignConfig`, is T-RR-022's own). Every other cache
 * this task owns (`tenant-schema-config.cache.ts`, `external-reward-system-config.cache.ts`,
 * `dispatch-channel-config.cache.ts`) reads its own TTL through *this* cache, not directly through
 * `ServiceConfigResolverService` — so this is the one cache in the module whose own freshness
 * bootstraps everyone else's.
 *
 * **The bootstrap cycle this class exists to break (§2's own explicit "one bootstrap exception"):**
 * to know how long to cache a resolved value, this class needs `cache.ttl.serviceConfig.seconds`
 * itself — but resolving *that* key is itself a call into this same cache, which would need to
 * already know its own TTL to store its own result. The only way to store that one specific
 * key's own cache entry without infinite regress is a fixed, compiled-in default
 * (`SERVICE_CONFIG_CACHE_BOOTSTRAP_TTL_MS`) reserved for that literal key alone — every other key,
 * including the very first one this cache is ever asked to resolve, gets its TTL from a real
 * (recursive, but non-circular — see `resolveTtlMs`) call to resolve the TTL key itself, which
 * bottoms out in exactly one bootstrap-default-cached entry rather than looping.
 */
import { Injectable } from '@nestjs/common';
import type { ServiceConfigValueType } from '@/database/models/service-config.model';
import {
  ServiceConfigResolverService,
  type ServiceConfigScopeContext,
} from '@/modules/service-config/service-config-resolver.service';
import { ServiceConfigRepository } from '@/modules/service-config/service-config.repository';
import type { InvalidatableCache } from './invalidatable-cache.interface';
import { TtlCache } from './ttl-cache';

export const SERVICE_CONFIG_TTL_KEY = 'cache.ttl.serviceConfig.seconds';

/** §2's own "small, compiled-in bootstrap default" — deliberately not an env var (not a
 * connection-establishing concern, just a "before any data exists" one). Used **only** to decide
 * how long this cache remembers its own `cache.ttl.serviceConfig.seconds` entry; every other
 * cached value's TTL comes from the real resolved value (`resolveTtlMs`). */
export const SERVICE_CONFIG_CACHE_BOOTSTRAP_TTL_MS = 60_000;

function buildCacheKey(configKey: string, context: ServiceConfigScopeContext): string {
  return JSON.stringify([
    configKey,
    context.campaignCode ?? null,
    context.tenantCode ?? null,
    context.countryCode ?? null,
  ]);
}

@Injectable()
export class ServiceConfigCache implements InvalidatableCache {
  private readonly cache = new TtlCache<string, unknown>();

  constructor(
    private readonly resolver: ServiceConfigResolverService,
    private readonly repository: ServiceConfigRepository,
  ) {}

  resolve(
    configKey: string,
    expectedType: 'string',
    context?: ServiceConfigScopeContext,
  ): Promise<string>;
  resolve(
    configKey: string,
    expectedType: 'int',
    context?: ServiceConfigScopeContext,
  ): Promise<number>;
  resolve(
    configKey: string,
    expectedType: 'boolean',
    context?: ServiceConfigScopeContext,
  ): Promise<boolean>;
  resolve(
    configKey: string,
    expectedType: 'json',
    context?: ServiceConfigScopeContext,
  ): Promise<unknown>;
  async resolve(
    configKey: string,
    expectedType: ServiceConfigValueType,
    context: ServiceConfigScopeContext = {},
  ): Promise<string | number | boolean | unknown> {
    const cacheKey = buildCacheKey(configKey, context);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // Overload resolution can't see through the runtime `expectedType` value here — `resolver`
    // exposes the identical four-way overload this class re-exposes, so this cast is exactly as
    // safe as the resolver's own internal implementation signature (R2: not a silent widening,
    // just re-stating the same overload contract one level up).
    const value = await this.resolver.resolve(configKey, expectedType as 'string', context);
    const ttlMs = this.isServiceConfigTtlKey(configKey)
      ? SERVICE_CONFIG_CACHE_BOOTSTRAP_TTL_MS
      : await this.resolveTtlMs();
    this.cache.set(cacheKey, value, ttlMs);
    return value;
  }

  invalidate(): void {
    this.cache.invalidate();
  }

  /**
   * §4's reconciliation safety net. This cache's own key space is shaped by whatever ad hoc
   * `(configKey, context)` pairs callers actually ask for, not a fixed table-row set the other
   * three caches have — there is no "reload every row into the same shape" operation to perform
   * here. What §4 actually needs from this cache is satisfied by: (1) proving a real round trip
   * against `service_config` still succeeds (not just replaying whatever's already in memory), and
   * (2) guaranteeing every subsequent `resolve()` call re-fetches fresh rather than serving a
   * pre-refresh value — the same "clear, don't eagerly re-populate" contract §3's invalidation
   * endpoint already uses.
   */
  async refreshAll(): Promise<void> {
    await this.repository.findAll();
    this.cache.invalidate();
  }

  private isServiceConfigTtlKey(configKey: string): boolean {
    return configKey === SERVICE_CONFIG_TTL_KEY;
  }

  private async resolveTtlMs(): Promise<number> {
    const seconds = await this.resolve(SERVICE_CONFIG_TTL_KEY, 'int', {});
    return seconds * 1000;
  }
}
