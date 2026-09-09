import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';
import type {
  DispatchChannelConfigRow,
  DispatchScopeLevel,
} from '@/database/models/dispatch-channel-config.model';

/**
 * T-RR-033. A single, exact-key read of `reward_redemption.dispatch_channel_config`
 * (`01-DATABASE.md` §5) — never a "load everything" query. `DispatchChannelResolverService` walks
 * `REWARD → TRACKER → CAMPAIGN → GLOBAL` itself (via `DispatchChannelConfigCache`), calling this
 * once per candidate `(scope_level, scope_ref_code, tenant_id)` triple; this repository's own job
 * is exactly one round trip per triple, nothing more.
 *
 * `IS NOT DISTINCT FROM` (rather than `=`) is required on both nullable columns: a `GLOBAL` row's
 * `scope_ref_code` is `NULL` by definition, and a tenant-agnostic row at any scope has `tenant_id
 * IS NULL` — plain `=` against a bound `NULL` parameter is SQL `UNKNOWN`, never `TRUE`, so it would
 * silently fail to find either case. This mirrors why `ServiceConfigRepository`'s own
 * `FIND_FIRST_MATCH_SQL` (T-RR-006) special-cases its `GLOBAL` branch with an explicit `IS NULL`
 * instead of `scope_ref = $n` — same underlying SQL fact, applied here to both nullable columns via
 * the null-safe operator instead of a per-branch special case, since this repository is queried once
 * per exact triple rather than once for the whole precedence walk.
 */
const FIND_ONE_SQL = `
  SELECT * FROM reward_redemption.dispatch_channel_config
  WHERE scope_level = $1
    AND scope_ref_code IS NOT DISTINCT FROM $2
    AND tenant_id IS NOT DISTINCT FROM $3
`;

/**
 * Repository for `reward_redemption.dispatch_channel_config` (`01-DATABASE.md` §5) — typed reads
 * only; this table's rows are written by migration/seed/admin tooling, never by this service's own
 * runtime code (this task's own "Out" scope).
 *
 * Connects as the least-privilege `rr_app` role (`DB_APP_USERNAME`/`DB_APP_PASSWORD`,
 * AGENT-PROTOCOL.md R5) via its own small `pg.Pool` — same precedent as
 * `ServiceConfigRepository`/`RewardRedemptionEntryClaimRepository`: no shared runtime DB pool
 * module exists anywhere in this service. The second constructor parameter exists solely so a test
 * can substitute a real (but test-owned) `Pool`, mirroring both of those repositories' own
 * precedent.
 */
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

  /**
   * The single row matching this exact `(scope_level, scope_ref_code, tenant_id)` triple, or
   * `null` if none exists — a normal, expected "this candidate doesn't match" outcome for the
   * resolver's own precedence walk, never an error.
   */
  async findOne(
    scopeLevel: DispatchScopeLevel,
    scopeRefCode: string | null,
    tenantId: number | null,
  ): Promise<DispatchChannelConfigRow | null> {
    const result = await this.pool.query<DispatchChannelConfigRow>(FIND_ONE_SQL, [
      scopeLevel,
      scopeRefCode,
      tenantId,
    ]);
    return result.rows[0] ?? null;
  }

  /** Every configured row — used by tests and any future admin/read surface, never by `findOne`
   * itself. */
  async findAll(): Promise<DispatchChannelConfigRow[]> {
    const result = await this.pool.query<DispatchChannelConfigRow>(
      'SELECT * FROM reward_redemption.dispatch_channel_config ORDER BY scope_level, scope_ref_code, tenant_id',
    );
    return result.rows;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
