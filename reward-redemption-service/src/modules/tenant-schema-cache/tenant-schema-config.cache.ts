/**
 * T-RR-007. Caches `tenant_schema_config` (`01-DATABASE.md` §4) keyed exactly by `(tenant_id,
 * environment)` — deliberately **not** the full `(tenant_id, country_code, environment)` unique
 * key the table itself carries (implementation note 3), since `06-CACHING-AND-TENANT-CONFIG.md`
 * §5's own resolution flow filters by `(tenant_id, environment, is_active)` first and only then
 * expects exactly one matching row. Getting this key wrong (adding `country_code`) would silently
 * defeat that "expect exactly one" check by pre-partitioning entries the check needs to see
 * together.
 */
import { Injectable } from '@nestjs/common';
import type { TenantSchemaConfigRow } from '@/database/models/tenant-schema-config.model';
import { CACHE_TTL_CONFIG_KEYS } from './cache-ttl-config-keys';
import type { InvalidatableCache } from './invalidatable-cache.interface';
import { ServiceConfigCache } from './service-config.cache';
import { TenantSchemaConfigRepository } from './tenant-schema-config.repository';
import { TtlCache } from './ttl-cache';

export interface TenantSchemaConfigKey {
  tenantId: number;
  environment: string;
}

function buildCacheKey(key: TenantSchemaConfigKey): string {
  return `${key.tenantId}::${key.environment}`;
}

@Injectable()
export class TenantSchemaConfigCache implements InvalidatableCache {
  private readonly cache = new TtlCache<string, TenantSchemaConfigRow[]>();

  constructor(
    private readonly repository: TenantSchemaConfigRepository,
    private readonly serviceConfigCache: ServiceConfigCache,
  ) {}

  /** The active rows matching `key`, cache-first. Cached value is always an array (possibly
   * empty, possibly containing more than one row) — see this file's own header on why the cache
   * key is deliberately coarser than the table's own unique constraint. */
  async get(key: TenantSchemaConfigKey): Promise<TenantSchemaConfigRow[]> {
    const cacheKey = buildCacheKey(key);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const rows = await this.repository.findActiveByTenantAndEnvironment(
      key.tenantId,
      key.environment,
    );
    const ttlMs = await this.ttlMs();
    this.cache.set(cacheKey, rows, ttlMs);
    return rows;
  }

  invalidate(): void {
    this.cache.invalidate();
  }

  /** §4's reconciliation safety net — reloads every active row in one round trip and regroups
   * them by this cache's own `(tenant_id, environment)` key, so a poll cycle refreshes every
   * cached key, not just ones a request has actually read since the last refresh. */
  async refreshAll(): Promise<void> {
    const rows = await this.repository.findAllActive();
    const grouped = new Map<string, TenantSchemaConfigRow[]>();
    for (const row of rows) {
      const cacheKey = buildCacheKey({ tenantId: row.tenant_id, environment: row.environment });
      const existing = grouped.get(cacheKey);
      if (existing) {
        existing.push(row);
      } else {
        grouped.set(cacheKey, [row]);
      }
    }
    const ttlMs = await this.ttlMs();
    this.cache.invalidate();
    for (const [cacheKey, groupedRows] of grouped) {
      this.cache.set(cacheKey, groupedRows, ttlMs);
    }
  }

  private async ttlMs(): Promise<number> {
    const seconds = await this.serviceConfigCache.resolve(
      CACHE_TTL_CONFIG_KEYS.tenantSchemaConfig,
      'int',
      {},
    );
    return seconds * 1000;
  }
}
