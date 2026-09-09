import { Injectable, type OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';
import type { ServiceConfigRow } from '@/database/models/service-config.model';

/**
 * T-RR-006. The three possible scope-ref values a caller can supply when resolving a
 * `service_config` key (`01-DATABASE.md` §6) — `campaignCode`/`tenantCode`/`countryCode` by
 * *code* value only (R5), never another service's internal numeric/uuid id. Any subset may be
 * omitted; an omitted value simply means that scope level can never match (see
 * `FIND_FIRST_MATCH_SQL`'s own comment for why `NULL = NULL` never matching is exactly the
 * "degrade gracefully when part of the context is unavailable" behaviour this needs).
 */
export interface ServiceConfigScopeContext {
  campaignCode?: string;
  tenantCode?: string;
  countryCode?: string;
}

/**
 * First-match-wins precedence in a single round trip: `CAMPAIGN` → `TENANT` → `COUNTRY` →
 * `GLOBAL` (`01-DATABASE.md` §6, this task's own implementation note 2), via one `ORDER BY
 * CASE ... LIMIT 1` rather than four sequential queries or an RAP-style in-memory cache — this
 * module owns no cache (implementation note 5; T-RR-007 is what wraps this resolver with one).
 *
 * A parameter bound to `NULL` (an omitted `campaignCode`/`tenantCode`/`countryCode`) can never
 * satisfy `scope_ref = $n` for any stored row, including a row whose own `scope_ref` also happens
 * to be `NULL` — SQL's `NULL = NULL` is `UNKNOWN`, never `TRUE` — which is exactly why the
 * `GLOBAL` branch is spelled out as its own explicit `scope_level = 'GLOBAL' AND scope_ref IS
 * NULL` condition instead of reusing the same `scope_ref = $n` shape as the other three branches.
 */
const FIND_FIRST_MATCH_SQL = `
  SELECT * FROM reward_redemption.service_config
  WHERE config_key = $1
    AND (
      (scope_level = 'CAMPAIGN' AND scope_ref = $2) OR
      (scope_level = 'TENANT'   AND scope_ref = $3) OR
      (scope_level = 'COUNTRY'  AND scope_ref = $4) OR
      (scope_level = 'GLOBAL'   AND scope_ref IS NULL)
    )
  ORDER BY CASE scope_level
    WHEN 'CAMPAIGN' THEN 0
    WHEN 'TENANT'   THEN 1
    WHEN 'COUNTRY'  THEN 2
    WHEN 'GLOBAL'   THEN 3
  END
  LIMIT 1
`;

/**
 * Repository for `reward_redemption.service_config` (`01-DATABASE.md` §6) — typed reads only, no
 * write path (this table is seeded/edited by each later task's own migration/seed step, per this
 * task's own "Out" scope, never by application runtime code).
 *
 * Connects as the least-privilege `rr_app` role (`DB_APP_USERNAME`/`DB_APP_PASSWORD`,
 * `AGENT-PROTOCOL.md` R5) via its own small `pg.Pool` — same precedent as
 * `FieldEncryptionConfigRepository`/`RewardRedemptionEntryClaimRepository`: no shared runtime DB
 * pool module exists anywhere in this service, so this repository owns one rather than reaching
 * for a module that doesn't exist. The second constructor parameter exists solely so a test can
 * substitute a real (but test-owned) `Pool`, mirroring the same two repositories' own precedent.
 */
@Injectable()
export class ServiceConfigRepository implements OnModuleDestroy {
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
   * The single row `ServiceConfigResolverService` needs for a given `(configKey, context)` pair,
   * or `null` if no row matches at any scope, including no `GLOBAL` row — a genuine configuration
   * gap the resolver itself turns into a thrown, named error (TC-4) rather than this repository
   * inventing a fallback value.
   */
  async findFirstMatch(
    configKey: string,
    context: ServiceConfigScopeContext,
  ): Promise<ServiceConfigRow | null> {
    const result = await this.pool.query<ServiceConfigRow>(FIND_FIRST_MATCH_SQL, [
      configKey,
      context.campaignCode ?? null,
      context.tenantCode ?? null,
      context.countryCode ?? null,
    ]);
    return result.rows[0] ?? null;
  }

  /** Every configured row — used by tests and any future admin/read surface, never by
   * `findFirstMatch` itself (which resolves directly via SQL rather than loading everything into
   * memory, since this module owns no cache). */
  async findAll(): Promise<ServiceConfigRow[]> {
    const result = await this.pool.query<ServiceConfigRow>(
      'SELECT * FROM reward_redemption.service_config ORDER BY config_key, scope_level, scope_ref',
    );
    return result.rows;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
