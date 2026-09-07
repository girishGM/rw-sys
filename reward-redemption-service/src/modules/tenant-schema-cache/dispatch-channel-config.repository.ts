/**
 * T-RR-007. Repository for `reward_redemption.dispatch_channel_config` (`01-DATABASE.md` §5) —
 * same shape/precedent as `tenant-schema-config.repository.ts`'s own header explains.
 *
 * `scope_ref_code`/`tenant_id` are both nullable (`NULL` for the `GLOBAL` scope / "every tenant"),
 * so an exact-match lookup needs `IS NOT DISTINCT FROM` rather than `=` — plain SQL `NULL = NULL`
 * is `UNKNOWN`, never `TRUE`, which would otherwise make the `GLOBAL` row (both columns `NULL`)
 * unreachable by exact lookup.
 */
import { Injectable, type OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';
import type {
  DispatchChannelConfigRow,
  DispatchScopeLevel,
} from '@/database/models/dispatch-channel-config.model';

@Injectable()
export class DispatchChannelConfigRepository implements OnModuleDestroy {
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

  /** Exact match on `uq_dcc_scope (scope_level, scope_ref_code, tenant_id)`. */
  async findByScope(
    scopeLevel: DispatchScopeLevel,
    scopeRefCode: string | null,
    tenantId: number | null,
  ): Promise<DispatchChannelConfigRow | null> {
    const result = await this.pool.query<DispatchChannelConfigRow>(
      `SELECT * FROM reward_redemption.dispatch_channel_config
       WHERE scope_level = $1
         AND scope_ref_code IS NOT DISTINCT FROM $2
         AND tenant_id IS NOT DISTINCT FROM $3`,
      [scopeLevel, scopeRefCode, tenantId],
    );
    return result.rows[0] ?? null;
  }

  /** Every configured row — used by the cache's own `refreshAll()` and by tests. */
  async findAll(): Promise<DispatchChannelConfigRow[]> {
    const result = await this.pool.query<DispatchChannelConfigRow>(
      'SELECT * FROM reward_redemption.dispatch_channel_config ORDER BY scope_level, scope_ref_code',
    );
    return result.rows;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
