/**
 * T-RR-007. Caches `external_reward_system_config` (`01-DATABASE.md` §3) keyed exactly by
 * `(system_code, tenant_key)` — `tenant_key = coalesce(tenant_id, -1)`, matching
 * `uq_ersc_system_tenant` exactly (implementation note 3). Resolving a tenant-specific override
 * against a `NULL`-tenant (global) row is a later consumer's job (T-RR-023's retry classification
 * module) — this cache only ever answers the exact key it's asked for.
 */
import { Injectable } from '@nestjs/common';
import type { ExternalRewardSystemConfigRow } from '@/database/models/external-reward-system-config.model';
import { CACHE_TTL_CONFIG_KEYS } from './cache-ttl-config-keys';
import { ExternalRewardSystemConfigRepository } from './external-reward-system-config.repository';
import type { InvalidatableCache } from './invalidatable-cache.interface';
import { ServiceConfigCache } from './service-config.cache';
import { TtlCache } from './ttl-cache';

export interface ExternalRewardSystemConfigKey {
  systemCode: string;
  /** `null`/`undefined` both mean "the global override" — coalesced to `-1` exactly like the
   * table's own generated `tenant_key` column. */
  tenantId?: number | null;
}

function tenantKeyOf(tenantId: number | null | undefined): number {
  return tenantId ?? -1;
}

function buildCacheKey(key: ExternalRewardSystemConfigKey): string {
  return `${key.systemCode}::${tenantKeyOf(key.tenantId)}`;
}

@Injectable()
export class ExternalRewardSystemConfigCache implements InvalidatableCache {
  private readonly cache = new TtlCache<string, ExternalRewardSystemConfigRow | null>();

  constructor(
    private readonly repository: ExternalRewardSystemConfigRepository,
    private readonly serviceConfigCache: ServiceConfigCache,
  ) {}

  /** `null` is a legitimate, cached "confirmed no such row" outcome — distinct from `undefined`
   * (TtlCache's own private "not cached at all" sentinel, see `ttl-cache.ts`'s header). */
  async get(key: ExternalRewardSystemConfigKey): Promise<ExternalRewardSystemConfigRow | null> {
    const cacheKey = buildCacheKey(key);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const row = await this.repository.findBySystemCodeAndTenantKey(
      key.systemCode,
      tenantKeyOf(key.tenantId),
    );
    const ttlMs = await this.ttlMs();
    this.cache.set(cacheKey, row, ttlMs);
    return row;
  }

  invalidate(): void {
    this.cache.invalidate();
  }

  async refreshAll(): Promise<void> {
    const rows = await this.repository.findAll();
    const ttlMs = await this.ttlMs();
    this.cache.invalidate();
    for (const row of rows) {
      const cacheKey = `${row.system_code}::${row.tenant_key}`;
      this.cache.set(cacheKey, row, ttlMs);
    }
  }

  private async ttlMs(): Promise<number> {
    const seconds = await this.serviceConfigCache.resolve(
      CACHE_TTL_CONFIG_KEYS.externalRewardSystemConfig,
      'int',
      {},
    );
    return seconds * 1000;
  }
}
