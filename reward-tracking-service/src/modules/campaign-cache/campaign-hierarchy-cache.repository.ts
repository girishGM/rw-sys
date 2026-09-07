/**
 * T-RTS-020. Repository for `reward_tracking.campaign_hierarchy_cache`
 * (`brain-storm/02-DATA-MODEL.md` §7, `007_create_campaign_hierarchy_cache.ts`'s own
 * "inferred, not copied verbatim" header) — the local durable mirror of whatever the portal's
 * `ListActiveCampaigns`/`WatchCampaignConfig` gRPC feed last returned for one campaign.
 *
 * Talks to Postgres with parameterised `sequelize.query(...)`, matching this project's own
 * migrations-are-raw-SQL / no `@Table` ORM model convention (see
 * `src/database/models/campaign-hierarchy-cache.model.ts`'s header and
 * `realtime-activity-processing-service/src/modules/campaign-cache/campaign-config-snapshot.repository.ts`'s
 * identical precedent for the same purpose against the same upstream feed).
 *
 * `hierarchy` (jsonb) always stores the full, portal-shaped payload exactly as received — this
 * table is a pass-through cache, never a normalized local schema (same migration header note).
 * `campaign_name`/`owner_contact` are accepted as optional/nullable inputs: as of this task,
 * neither is actually carried by the portal's wire contract (see this module's own
 * `proto/campaign_config.proto` header, "Finding worth flagging") — callers pass `null` for both
 * today, and this repository's shape is ready to carry real values the day the feed exposes them,
 * with no schema or method-signature change needed then.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type { CampaignHierarchyCacheRow } from '@/database/models/campaign-hierarchy-cache.model';

/**
 * DI token for this module's own runtime Postgres connection (the least-privilege
 * `reward_tracking_app` role — AGENT-PROTOCOL.md R2 — never the migration role from
 * `src/database/migration-connection.ts`). Defined here (not a dedicated constants file — this
 * task's "Files owned" list grants exactly three `.ts` files, none of them a constants file)
 * since this repository is the natural owner of "the connection this module's table is queried
 * through"; `campaign-cache.module.ts` imports it from here to build the actual connection,
 * exactly the precedent `campaign-config-snapshot.repository.ts`'s own `CAMPAIGN_CACHE_SEQUELIZE`
 * set in the sibling project.
 */
export const CAMPAIGN_CACHE_SEQUELIZE = Symbol('CAMPAIGN_CACHE_SEQUELIZE');

/** Every field this table can hold — see this file's own header on `campaignName`/`ownerContact`
 * currently always being `null` in practice. `hierarchy` is the full, opaque, portal-shaped
 * payload for the fetched sections (`BASIC`/`MERCHANTS`/`TRACKERS`). */
export interface UpsertCampaignHierarchyData {
  tenantId: number;
  campaignCode: string;
  campaignName: string | null;
  configVersion: string | null;
  isActive: boolean;
  ownerContact: string | null;
  hierarchy: unknown;
}

/** The narrow surface `CampaignHierarchyClient` (T-RTS-020, same file-scope owner) depends on —
 * exported separately from the concrete class so a unit test can inject a plain object satisfying
 * this shape instead of standing up a real Postgres connection (`campaign-hierarchy.client.spec.ts`
 * does exactly this; `campaign-hierarchy-cache.repository.spec.ts` is what exercises the real,
 * concrete class against real Postgres). */
export interface CampaignHierarchyCacheWriter {
  upsert(data: UpsertCampaignHierarchyData): Promise<void>;
  findCampaignCodesForTenant(tenantId: number): Promise<string[]>;
  markInactive(tenantId: number, campaignCode: string): Promise<void>;
}

@Injectable()
export class CampaignHierarchyCacheRepository implements CampaignHierarchyCacheWriter {
  constructor(@Inject(CAMPAIGN_CACHE_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /** Every locally-held row, across every tenant — the API layer's (Wave 3) eventual read
   * surface, and useful for this repository's own regression coverage. */
  async findAll(): Promise<CampaignHierarchyCacheRow[]> {
    return this.sequelize.query<CampaignHierarchyCacheRow>(
      `SELECT * FROM reward_tracking.campaign_hierarchy_cache ORDER BY tenant_id, campaign_code`,
      { type: QueryTypes.SELECT },
    );
  }

  async findOne(
    tenantId: number,
    campaignCode: string,
  ): Promise<CampaignHierarchyCacheRow | undefined> {
    const rows = await this.sequelize.query<CampaignHierarchyCacheRow>(
      `SELECT * FROM reward_tracking.campaign_hierarchy_cache
         WHERE tenant_id = :tenantId AND campaign_code = :campaignCode`,
      { type: QueryTypes.SELECT, replacements: { tenantId, campaignCode } },
    );
    return rows[0];
  }

  /** Every campaign code currently cached for one tenant, active or not — used to detect a
   * campaign that vanished from a fresh `ListActiveCampaigns` response entirely (TC-1/TC-2's own
   * "cache row refreshed" companion: a campaign no longer returned at all is marked inactive,
   * never deleted, mirroring RAP's own `markCampaignVanished` precedent). */
  async findCampaignCodesForTenant(tenantId: number): Promise<string[]> {
    const rows = await this.sequelize.query<{ campaign_code: string }>(
      `SELECT campaign_code FROM reward_tracking.campaign_hierarchy_cache WHERE tenant_id = :tenantId`,
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );
    return rows.map((row) => row.campaign_code);
  }

  /**
   * `config_version`/`hierarchy`/`is_active` are opaque, portal-supplied values — this upsert
   * always overwrites them with whatever was most recently received, never merges
   * (`uq_chc_tenant_campaign` on `(tenant_id, campaign_code)` is what makes this idempotent under
   * a Kafka/gRPC-style redelivery of the same snapshot).
   */
  async upsert(data: UpsertCampaignHierarchyData): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO reward_tracking.campaign_hierarchy_cache
         (tenant_id, campaign_code, campaign_name, config_version, is_active, owner_contact, hierarchy, fetched_at, updated_at)
       VALUES
         (:tenantId, :campaignCode, :campaignName, :configVersion, :isActive, :ownerContact, CAST(:hierarchy AS jsonb), now(), now())
       ON CONFLICT (tenant_id, campaign_code) DO UPDATE SET
         campaign_name  = EXCLUDED.campaign_name,
         config_version = EXCLUDED.config_version,
         is_active      = EXCLUDED.is_active,
         owner_contact  = EXCLUDED.owner_contact,
         hierarchy      = EXCLUDED.hierarchy,
         fetched_at     = now(),
         updated_at     = now()`,
      {
        type: QueryTypes.RAW,
        replacements: {
          tenantId: data.tenantId,
          campaignCode: data.campaignCode,
          campaignName: data.campaignName,
          configVersion: data.configVersion,
          isActive: data.isActive,
          ownerContact: data.ownerContact,
          hierarchy: JSON.stringify(data.hierarchy),
        },
      },
    );
  }

  /**
   * A campaign that no longer appears in a fresh bulk fetch, or that a `WatchCampaignConfig`
   * `ENDED` event names, is `completed`/`archived` — kept, not deleted, for the same audit-trail
   * reason RAP's own `campaign_config_snapshot` keeps a vanished campaign's row
   * (`campaign-config-cache.service.ts`'s own `markCampaignVanished`). No-op (never throws) if the
   * row doesn't exist — this is a best-effort tidy-up, not a correctness-critical write (R1: this
   * cache never gates anything).
   */
  async markInactive(tenantId: number, campaignCode: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE reward_tracking.campaign_hierarchy_cache
         SET is_active = false, updated_at = now()
         WHERE tenant_id = :tenantId AND campaign_code = :campaignCode`,
      { type: QueryTypes.RAW, replacements: { tenantId, campaignCode } },
    );
  }
}
