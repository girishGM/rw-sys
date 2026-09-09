/**
 * T-RR-007. Repository for `reward_redemption.external_reward_system_config` (`01-DATABASE.md`
 * §3) — same shape/precedent as `tenant-schema-config.repository.ts`'s own header explains.
 */
import { Injectable, type OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';
import type { ExternalRewardSystemConfigRow } from '@/database/models/external-reward-system-config.model';

@Injectable()
export class ExternalRewardSystemConfigRepository implements OnModuleDestroy {
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

  /** Exact match on `uq_ersc_system_tenant (system_code, tenant_key)` — `tenantKey` is the
   * already-`coalesce(tenant_id, -1)`d value the caller (the cache) computes, matching the
   * table's own generated column exactly, never a separate NULL-handling path here. */
  async findBySystemCodeAndTenantKey(
    systemCode: string,
    tenantKey: number,
  ): Promise<ExternalRewardSystemConfigRow | null> {
    const result = await this.pool.query<ExternalRewardSystemConfigRow>(
      'SELECT * FROM reward_redemption.external_reward_system_config WHERE system_code = $1 AND tenant_key = $2',
      [systemCode, tenantKey],
    );
    return result.rows[0] ?? null;
  }

  /** Every configured row — used by the cache's own `refreshAll()` and by tests. */
  async findAll(): Promise<ExternalRewardSystemConfigRow[]> {
    const result = await this.pool.query<ExternalRewardSystemConfigRow>(
      'SELECT * FROM reward_redemption.external_reward_system_config ORDER BY system_code, tenant_key',
    );
    return result.rows;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
