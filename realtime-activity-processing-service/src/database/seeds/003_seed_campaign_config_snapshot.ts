import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import {
  DEMO_CAMPAIGN_CODE,
  DEMO_CAMPAIGN_CONFIG,
  DEMO_CONFIG_VERSION,
  DEMO_TENANT_ID,
} from './seed-data.constants';

/**
 * T-RAP-003 — seeds one demo `campaign_config_snapshot` row (01-DATABASE.md §1): a campaign →
 * merchant/activity → tracker → component → rule → reward → cap graph shaped exactly like
 * `CampaignConfig` (03-GRPC-CONTRACT.md §2 / `portal/back-end/proto/campaign_config.v1.proto`),
 * so Wave 1's cache-builder (T-RAP-010) can develop and test against real, non-empty local data
 * with no live portal connection (task file "Objective"/Scope "Out").
 *
 * `uc_campaign_config_snapshot (tenant_id, campaign_code)` has both columns `NOT NULL`
 * (01-DATABASE.md §1), unlike `field_encryption_config`/`service_config`'s nullable `scope_ref` —
 * a plain `ON CONFLICT ... DO UPDATE` is therefore safe and correct here (no `NULL`-equality
 * gotcha to work around), and `DO UPDATE` (not `DO NOTHING`) is deliberate: re-running this seed
 * after `seed-data.constants.ts`'s own demo payload changes should refresh the local fixture
 * in place, not freeze it at whatever was inserted first.
 */
export async function seedCampaignConfigSnapshot(sequelize: Sequelize): Promise<void> {
  await sequelize.query(
    `INSERT INTO realtime_activity_processing.campaign_config_snapshot
       (tenant_id, campaign_code, config_version, is_active, payload)
     VALUES
       (:tenant_id, :campaign_code, :config_version, :is_active, :payload)
     ON CONFLICT (tenant_id, campaign_code) DO UPDATE
       SET config_version = EXCLUDED.config_version,
           is_active      = EXCLUDED.is_active,
           payload        = EXCLUDED.payload,
           fetched_at     = now(),
           updated_at     = now()`,
    {
      type: QueryTypes.RAW,
      replacements: {
        tenant_id: DEMO_TENANT_ID,
        campaign_code: DEMO_CAMPAIGN_CODE,
        config_version: DEMO_CONFIG_VERSION,
        is_active: true,
        payload: JSON.stringify(DEMO_CAMPAIGN_CONFIG),
      },
    },
  );
}
