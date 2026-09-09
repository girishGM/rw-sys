/**
 * T-RR-007. Repository for `reward_redemption.tenant_schema_config` (`01-DATABASE.md` §4) —
 * typed reads only, same shape as T-RR-006's own `ServiceConfigRepository`/T-RR-005's
 * `FieldEncryptionConfigRepository`: connects as the least-privilege `rr_app` role via its own
 * small `pg.Pool` (no shared runtime DB pool module exists anywhere in this service), with an
 * `@Optional() pool?: Pool` constructor seam so a test can substitute a real (but test-owned) pool.
 */
import { Injectable, type OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';
import type { TenantSchemaConfigRow } from '@/database/models/tenant-schema-config.model';

@Injectable()
export class TenantSchemaConfigRepository implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(config: ConfigService<Config, true>, @Optional() pool?: Pool) {
    this.pool =
      pool ??
      new Pool({
        host: config.get('DB_HOST', { infer: true }),
        port: config.get('DB_PORT', { infer: true }),
        database: config.get('DB_NAME', { infer: true }),
        user: config.get('DB_APP_USERNAME', { infer: true }),
        password: config.get('DB_APP_PASSWORD', { infer: true }),
        ssl: config.get('DB_SSL', { infer: true }) ? { rejectUnauthorized: false } : undefined,
      });
  }

  /**
   * `06-CACHING-AND-TENANT-CONFIG.md` §5's own lookup shape — filtered by `(tenant_id,
   * environment, is_active = true)`. May legitimately return more than one row (a tenant spanning
   * more than one `country_code`); resolving to exactly one is a later task's job (folded into
   * T-RR-021's claim-time processing per §5), never this repository's or this cache's own concern.
   */
  async findActiveByTenantAndEnvironment(
    tenantId: number,
    environment: string,
  ): Promise<TenantSchemaConfigRow[]> {
    const result = await this.pool.query<TenantSchemaConfigRow>(
      `SELECT * FROM reward_redemption.tenant_schema_config
       WHERE tenant_id = $1 AND environment = $2 AND is_active = true
       ORDER BY country_code`,
      [tenantId, environment],
    );
    return result.rows;
  }

  /** Every currently-active row — used by `TenantSchemaConfigCache.refreshAll()` (the
   * reconciliation poller's own wholesale reload) to repopulate every `(tenant_id, environment)`
   * cache entry in one round trip, mirroring the same `(tenantId, environment, is_active)` filter
   * `findActiveByTenantAndEnvironment` applies per key. */
  async findAllActive(): Promise<TenantSchemaConfigRow[]> {
    const result = await this.pool.query<TenantSchemaConfigRow>(
      'SELECT * FROM reward_redemption.tenant_schema_config WHERE is_active = true ORDER BY tenant_id, environment, country_code',
    );
    return result.rows;
  }

  /** Every configured row, active or not — used by tests and any future admin/read surface. */
  async findAll(): Promise<TenantSchemaConfigRow[]> {
    const result = await this.pool.query<TenantSchemaConfigRow>(
      'SELECT * FROM reward_redemption.tenant_schema_config ORDER BY tenant_id, environment, country_code',
    );
    return result.rows;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
