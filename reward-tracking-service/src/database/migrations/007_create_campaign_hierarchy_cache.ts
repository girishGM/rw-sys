import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_tracking.campaign_hierarchy_cache` — `brain-storm/02-DATA-MODEL.md` §7. That section
 * itself says only "same as the first draft" without repeating the first draft's own column list
 * inline (unlike every other table in that document, which is given a full, literal `CREATE
 * TABLE`) — the first draft text isn't present anywhere in this repo to copy from verbatim.
 *
 * **Inferred, not copied verbatim — flagged in this task's completion report, per
 * `AGENT-PROTOCOL.md` §3 ("if a design doc contradicts itself... the choice is an architect
 * decision") and this task file's own note ("if a table shape... seems wrong, escalate, don't
 * silently improve it").** This shape is modeled directly on the one other table in this whole
 * repo family serving the *identical* purpose against the *identical* upstream feed —
 * `realtime-activity-processing-service`'s own `campaign_config_snapshot`
 * (`realtime-activity-processing-service/src/database/migrations/002_create_campaign_config_snapshot.ts`),
 * "the local, durable mirror of whatever the portal's bulk gRPC endpoint last returned for one
 * campaign" — since §7 itself names this table as "second consumer of the portal's existing
 * `ListActiveCampaigns`/`WatchCampaignConfig` gRPC feed" (the exact same feed RAP's table mirrors).
 * `hierarchy` carries the nested trackers/components/rewards display tree as a pass-through
 * `jsonb` blob (RAP's own `payload` column, renamed here for this table's own display-oriented
 * purpose) rather than a fully normalized set of tables, for the same reason RAP's own header
 * gives: the actual graph shape is the portal's gRPC contract's concern, read back out by whichever
 * module actually builds the cache (T-RTS-020, out of this task's own scope), never queried via
 * SQL directly. `campaign_name`/`owner_contact` are added as their own columns (not folded into
 * the jsonb blob) because §7's own prose calls them out by name as this table's whole reason to
 * exist ("names + hierarchy + ... campaign owner's contact details") and a customer/admin-facing
 * display query needs them queryable without unpacking jsonb.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_tracking.campaign_hierarchy_cache (
      id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       int         NOT NULL,
      campaign_code   varchar(50) NOT NULL,
      campaign_name   varchar(200) NULL,
      config_version  varchar(64) NULL,
      is_active       boolean     NOT NULL DEFAULT true,
      owner_contact   varchar(200) NULL,
      hierarchy       jsonb       NOT NULL,
      fetched_at      timestamptz NOT NULL DEFAULT now(),
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_chc_tenant_campaign UNIQUE (tenant_id, campaign_code)
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE INDEX ix_chc_active ON reward_tracking.campaign_hierarchy_cache (is_active)
       WHERE is_active;`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_tracking.campaign_hierarchy_cache;', {
    type: QueryTypes.RAW,
  });
}
