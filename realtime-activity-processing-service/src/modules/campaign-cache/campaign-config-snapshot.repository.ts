/**
 * T-RAP-010. Repositories for this task's two local durable cache tables
 * (`01-DATABASE.md` §1-§2) — `campaign_config_snapshot` (the cold cache) and
 * `activity_external_code_map` (the local mirror of the portal-owned, T-171
 * `reward_portal.activity_external_codes` join table). Both are simple, tightly-coupled
 * "mirror whatever the portal last returned" tables sharing the one connection this module owns
 * (`campaign-config-cache.module.ts`), which is why they live in one file — the task's own "Files
 * owned" list grants exactly one repository file here, not two.
 *
 * Talks to Postgres with parameterised `sequelize.query(...)`, matching this project's own
 * migrations-are-raw-SQL / no `@Table` ORM model convention (see `campaign-config-snapshot.model.ts`'s
 * header, `01-DATABASE.md`'s own note, and `promo-code-config.repository.ts`'s identical precedent).
 *
 * `payload` (jsonb) always stores the full, portal-shaped `CampaignConfigProto` object exactly as
 * received — this table is a pass-through cache, never a normalized local schema
 * (`01-DATABASE.md` §1's own note: "not a second source of truth to query with SQL").
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type { CampaignConfigSnapshotRow } from '@/database/models/campaign-config-snapshot.model';
import type { ActivityExternalCodeMapRow } from '@/database/models/activity-external-code-map.model';
import type { CampaignConfigProto } from './campaign-config.client';

/**
 * DI token for this module's own runtime Postgres connection (the least-privilege `rap_app`
 * role — AGENT-PROTOCOL.md R1 — never the migration role from `src/database/migration-connection.ts`).
 * Defined here (not a dedicated constants file — this task's "Files owned" list grants exactly
 * four `.ts` files, none of them a constants file) since this repository is the natural owner of
 * "the connection this module's tables are queried through"; `campaign-config-cache.module.ts`
 * imports it from here to build the actual connection and to export it for T-RAP-011/T-RAP-013
 * (same file-scope owner, `agent-rap-cache`) to reuse rather than opening a second pool, exactly
 * the precedent `promo-code-config.constants.ts` set for `PROMO_CODE_SEQUELIZE`.
 */
export const CAMPAIGN_CACHE_SEQUELIZE = Symbol('CAMPAIGN_CACHE_SEQUELIZE');

export interface UpsertSnapshotData {
  tenantId: number;
  campaignCode: string;
  configVersion: string;
  isActive: boolean;
  payload: CampaignConfigProto;
}

@Injectable()
export class CampaignConfigSnapshotRepository {
  constructor(@Inject(CAMPAIGN_CACHE_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /** Every locally-held snapshot row, across every tenant — what the in-memory cache rebuilds
   * itself from at process start (`01-DATABASE.md` §1, TC-1/TC-2 of this task). */
  async findAll(): Promise<CampaignConfigSnapshotRow[]> {
    return this.sequelize.query<CampaignConfigSnapshotRow>(
      `SELECT * FROM realtime_activity_processing.campaign_config_snapshot ORDER BY tenant_id, campaign_code`,
      { type: QueryTypes.SELECT },
    );
  }

  /**
   * `config_version`/`payload`/`is_active` are opaque, portal-supplied values
   * (`01-DATABASE.md` §1's own note: "compared, never parsed") — this upsert always overwrites
   * them with whatever the portal most recently returned, never merges.
   */
  async upsert(data: UpsertSnapshotData): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO realtime_activity_processing.campaign_config_snapshot
         (tenant_id, campaign_code, config_version, is_active, payload, fetched_at, updated_at)
       VALUES
         (:tenantId, :campaignCode, :configVersion, :isActive, CAST(:payload AS jsonb), now(), now())
       ON CONFLICT (tenant_id, campaign_code) DO UPDATE SET
         config_version = EXCLUDED.config_version,
         is_active      = EXCLUDED.is_active,
         payload         = EXCLUDED.payload,
         fetched_at      = now(),
         updated_at      = now()`,
      {
        type: QueryTypes.RAW,
        replacements: {
          tenantId: data.tenantId,
          campaignCode: data.campaignCode,
          configVersion: data.configVersion,
          isActive: data.isActive,
          payload: JSON.stringify(data.payload),
        },
      },
    );
  }
}

export interface UpsertExternalCodeData {
  tenantId: number;
  externalCode: string;
  activityCode: string;
}

@Injectable()
export class ActivityExternalCodeMapRepository {
  constructor(@Inject(CAMPAIGN_CACHE_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /** Every locally-held mapping row, across every tenant — what the in-memory
   * `transactionType → activityCode` index rebuilds itself from at process start. */
  async findAll(): Promise<ActivityExternalCodeMapRow[]> {
    return this.sequelize.query<ActivityExternalCodeMapRow>(
      `SELECT * FROM realtime_activity_processing.activity_external_code_map ORDER BY tenant_id, external_code`,
      { type: QueryTypes.SELECT },
    );
  }

  /**
   * `01-DATABASE.md` §2: "one `external_code` maps to exactly one `activity_code` per tenant" —
   * `ON CONFLICT (tenant_id, external_code) DO UPDATE` keeps that invariant even when the
   * portal's own mapping for a code is repointed to a different activity between two fetches.
   */
  async upsert(data: UpsertExternalCodeData): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO realtime_activity_processing.activity_external_code_map
         (tenant_id, external_code, activity_code, fetched_at)
       VALUES
         (:tenantId, :externalCode, :activityCode, now())
       ON CONFLICT (tenant_id, external_code) DO UPDATE SET
         activity_code = EXCLUDED.activity_code,
         fetched_at    = now()`,
      {
        type: QueryTypes.RAW,
        replacements: { ...data },
      },
    );
  }
}
