/**
 * T-RR-007. Caches `dispatch_channel_config` (`01-DATABASE.md` §5) keyed exactly by
 * `(scope_level, scope_ref_code, tenant_id)`, matching `uq_dcc_scope` (implementation note 3).
 * Walking `REWARD → TRACKER → CAMPAIGN → GLOBAL` precedence is T-RR-033's own resolver's job, not
 * this cache's — this cache only ever answers the exact scope tuple it's asked for.
 */
import { Injectable } from '@nestjs/common';
import type {
  DispatchChannelConfigRow,
  DispatchScopeLevel,
} from '@/database/models/dispatch-channel-config.model';
import { CACHE_TTL_CONFIG_KEYS } from './cache-ttl-config-keys';
import { DispatchChannelConfigRepository } from './dispatch-channel-config.repository';
import type { InvalidatableCache } from './invalidatable-cache.interface';
import { ServiceConfigCache } from './service-config.cache';
import { TtlCache } from './ttl-cache';

export interface DispatchChannelConfigKey {
  scopeLevel: DispatchScopeLevel;
  scopeRefCode: string | null;
  tenantId: number | null;
}

function buildCacheKey(key: DispatchChannelConfigKey): string {
  return `${key.scopeLevel}::${key.scopeRefCode ?? 'NULL'}::${key.tenantId ?? 'NULL'}`;
}

@Injectable()
export class DispatchChannelConfigCache implements InvalidatableCache {
  private readonly cache = new TtlCache<string, DispatchChannelConfigRow | null>();

  constructor(
    private readonly repository: DispatchChannelConfigRepository,
    private readonly serviceConfigCache: ServiceConfigCache,
  ) {}

  async get(key: DispatchChannelConfigKey): Promise<DispatchChannelConfigRow | null> {
    const cacheKey = buildCacheKey(key);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const row = await this.repository.findByScope(key.scopeLevel, key.scopeRefCode, key.tenantId);
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
      const cacheKey = buildCacheKey({
        scopeLevel: row.scope_level,
        scopeRefCode: row.scope_ref_code,
        tenantId: row.tenant_id,
      });
      this.cache.set(cacheKey, row, ttlMs);
    }
  }

  private async ttlMs(): Promise<number> {
    const seconds = await this.serviceConfigCache.resolve(
      CACHE_TTL_CONFIG_KEYS.dispatchChannelConfig,
      'int',
      {},
    );
    return seconds * 1000;
  }
}
