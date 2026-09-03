/**
 * T-RAP-013. Repository for `realtime_activity_processing.service_config` (`01-DATABASE.md` §11)
 * — the generic per-scope configuration table every current and future tunable in this service
 * reads through (`06-CONFIGURABILITY-AND-OBSERVABILITY.md` §2).
 *
 * Talks to Postgres with parameterised `sequelize.query(...)`, matching this project's own
 * migrations-are-raw-SQL / no `@Table` ORM model convention — same precedent as
 * `field-encryption-config.repository.ts` (T-RAP-012, same file-scope owner).
 *
 * Owns its own connection (`SERVICE_CONFIG_SEQUELIZE`, provided by `service-config.module.ts`)
 * rather than importing `CampaignConfigCacheModule` for its exported `CAMPAIGN_CACHE_SEQUELIZE` —
 * this task's own `Depends on` is only T-RAP-002, not T-RAP-010, and staying self-contained
 * avoids a load-order coupling neither task actually needs (identical reasoning to
 * `field-encryption-config.repository.ts`'s own header).
 *
 * Read-only by design: `Scope §Out` of this task's own file explicitly excludes any admin
 * UI/API for editing `service_config` rows — this module only resolves what's already there, it
 * never writes to the table itself.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type { ServiceConfigRow } from '@/database/models/service-config.model';

/**
 * DI token for this module's own runtime Postgres connection (the least-privilege `rap_app`
 * role — AGENT-PROTOCOL.md R1 — never the migration role from `src/database/migration-connection.ts`).
 * Defined here (not a dedicated constants file — this task's "Files owned" list grants exactly
 * four files under `src/modules/service-config/`, none of them a constants file), matching
 * `ENCRYPTION_SEQUELIZE`'s own precedent.
 */
export const SERVICE_CONFIG_SEQUELIZE = Symbol('SERVICE_CONFIG_SEQUELIZE');

@Injectable()
export class ServiceConfigRepository {
  constructor(@Inject(SERVICE_CONFIG_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /** Every configured row, across every scope — what `ServiceConfigResolverService` rebuilds its
   * in-memory resolution map from, at process start and on every later refresh. */
  async findAll(): Promise<ServiceConfigRow[]> {
    return this.sequelize.query<ServiceConfigRow>(
      `SELECT * FROM realtime_activity_processing.service_config
        ORDER BY scope_level, scope_ref, config_key`,
      { type: QueryTypes.SELECT },
    );
  }
}
