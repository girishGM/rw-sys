/**
 * T-RAP-040. The three read-only queries this whole module needs — none of them ever touch
 * `activity_logs` (Objective/`AGENT-PROTOCOL.md` R4's read-side too):
 *
 *  - `findLatestComponentProgress`/`findLatestTrackerStatus` go through `ix_ctcp_lookup`/`uc_cts`
 *    (`(tenant_id, customer_id_hash, campaign_code[, tracker_code])`, `01-DATABASE.md` §4-§5) — the
 *    exact "indexed lookups only" contract this task's Scope demands. `DISTINCT ON` picks the
 *    latest `completion_cycle` row per component/tracker (a repeatable component/tracker's earlier,
 *    already-superseded cycle is never what a progress bar should show — `01-DATABASE.md` §4's own
 *    `completion_cycle` semantics).
 *  - `findCampaignConfigSnapshotTrackers` reads `campaign_config_snapshot` by its own unique index
 *    (`uc_campaign_config_snapshot (tenant_id, campaign_code)`, `01-DATABASE.md` §1) purely to
 *    surface each tracker's static `completion_logic` — the one piece of the response shape
 *    (Implementation note 3) that isn't itself a progress number. Deliberately **not** a dependency
 *    on the live `CampaignConfigCacheService`/gRPC client (`campaign-config-cache.module.ts`): that
 *    service's own `onModuleInit` bootstrap needs `PORTAL_CONFIG_TENANT_IDS` and a reachable (or
 *    previously-warmed) portal, a startup dependency this "fast, always-answers" read API has no
 *    reason to inherit. The durable snapshot table it already keeps in sync (`01-DATABASE.md` §1's
 *    own "local, durable mirror") is itself an indexed lookup, self-contained, and exactly as fresh
 *    as the hot cache it feeds.
 *
 * Owns its own runtime Postgres connection (the least-privilege `rap_app` role, R1) — same
 * self-contained-connection precedent every prior module in this service follows (see
 * `activity-mapping.module.ts`'s own header for the canonical explanation of why).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type { CustomerTrackerComponentProgressRow } from '@/database/models/customer-tracker-component-progress.model';
import type { CustomerTrackerStatusRow } from '@/database/models/customer-tracker-status.model';
import type { CampaignConfigProto } from '@/modules/campaign-cache/campaign-config.client';

/** DI token for this module's own runtime Postgres connection — see this file's own header. */
export const PROGRESS_API_SEQUELIZE = Symbol('PROGRESS_API_SEQUELIZE');

@Injectable()
export class ProgressRepository {
  constructor(@Inject(PROGRESS_API_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * Latest `completion_cycle` row per `(tracker_code, tracker_component_code)`, scoped to one
   * customer's one campaign (optionally narrowed to one tracker). Uses `ix_ctcp_lookup`'s exact
   * leading columns for the `WHERE` clause — the `ORDER BY`'s trailing `completion_cycle DESC` is
   * what `DISTINCT ON` needs to pick the newest cycle, not an extra index requirement of its own.
   */
  async findLatestComponentProgress(
    tenantId: number,
    customerIdHash: string,
    campaignCode: string,
    trackerCode?: string,
  ): Promise<CustomerTrackerComponentProgressRow[]> {
    return this.sequelize.query<CustomerTrackerComponentProgressRow>(
      `SELECT DISTINCT ON (tracker_code, tracker_component_code) *
         FROM realtime_activity_processing.customer_tracker_component_progress
        WHERE tenant_id = :tenantId
          AND customer_id_hash = :customerIdHash
          AND campaign_code = :campaignCode
          AND (:trackerCode::varchar IS NULL OR tracker_code = :trackerCode)
        ORDER BY tracker_code, tracker_component_code, completion_cycle DESC`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId,
          customerIdHash,
          campaignCode,
          trackerCode: trackerCode ?? null,
        },
      },
    );
  }

  /** Same shape/reasoning as `findLatestComponentProgress`, against `uc_cts`. */
  async findLatestTrackerStatus(
    tenantId: number,
    customerIdHash: string,
    campaignCode: string,
    trackerCode?: string,
  ): Promise<CustomerTrackerStatusRow[]> {
    return this.sequelize.query<CustomerTrackerStatusRow>(
      `SELECT DISTINCT ON (tracker_code) *
         FROM realtime_activity_processing.customer_tracker_status
        WHERE tenant_id = :tenantId
          AND customer_id_hash = :customerIdHash
          AND campaign_code = :campaignCode
          AND (:trackerCode::varchar IS NULL OR tracker_code = :trackerCode)
        ORDER BY tracker_code, completion_cycle DESC`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId,
          customerIdHash,
          campaignCode,
          trackerCode: trackerCode ?? null,
        },
      },
    );
  }

  /**
   * `trackerCode -> completion_logic` for every tracker in this campaign's last-fetched snapshot,
   * or `null` when this tenant/campaign has no local snapshot row at all (never queried before, or
   * vanished — `campaign-config-cache.service.ts`'s own "kept, not deleted" note means this only
   * happens for a genuinely unknown campaign). One row, one index hit
   * (`uc_campaign_config_snapshot`), parsed in memory — never a second query per tracker.
   */
  async findCampaignConfigSnapshotTrackers(
    tenantId: number,
    campaignCode: string,
  ): Promise<Map<string, string> | null> {
    const rows = await this.sequelize.query<{ payload: unknown }>(
      `SELECT payload FROM realtime_activity_processing.campaign_config_snapshot
        WHERE tenant_id = :tenantId AND campaign_code = :campaignCode`,
      { type: QueryTypes.SELECT, replacements: { tenantId, campaignCode } },
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    const payload = row.payload as Partial<CampaignConfigProto> | null;
    const trackers = payload?.trackers ?? [];
    const byTrackerCode = new Map<string, string>();
    for (const tracker of trackers) {
      byTrackerCode.set(tracker.trackerCode, tracker.completionLogic);
    }
    return byTrackerCode;
  }
}
