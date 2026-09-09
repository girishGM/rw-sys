/**
 * T-RR-007. Repository for `reward_redemption.cache_invalidation_audit` (`01-DATABASE.md` §11) —
 * same shape/precedent as `field-encryption-config.repository.ts`'s own header explains: owns its
 * own small `pg.Pool`, connects as the least-privilege `rr_app` role, `@Optional() pool?: Pool`
 * constructor seam for tests.
 *
 * R9: `record`'s only inputs are `cacheKey`/`invokedBy` — there is no connector credential or
 * secret-reference value anywhere near this table, so there is nothing here that could leak one.
 */
import { Injectable, type OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';
import type { CacheInvalidationAuditRow } from '@/database/models/cache-invalidation-audit.model';

@Injectable()
export class CacheInvalidationAuditRepository implements OnModuleDestroy {
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

  /** `cacheKey = null` records an `{"all": true}` invocation (`01-DATABASE.md` §11's own
   * documented meaning). */
  async record(cacheKey: string | null, invokedBy: string): Promise<CacheInvalidationAuditRow> {
    const result = await this.pool.query<CacheInvalidationAuditRow>(
      `INSERT INTO reward_redemption.cache_invalidation_audit (cache_key, invoked_by)
       VALUES ($1, $2)
       RETURNING *`,
      [cacheKey, invokedBy],
    );
    return result.rows[0];
  }

  /** Every audit row — used by tests and any future admin/read surface. */
  async findAll(): Promise<CacheInvalidationAuditRow[]> {
    const result = await this.pool.query<CacheInvalidationAuditRow>(
      'SELECT * FROM reward_redemption.cache_invalidation_audit ORDER BY invoked_at DESC',
    );
    return result.rows;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
