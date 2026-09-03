/**
 * T-RAP-040. Shared seed/cleanup helpers for the customer progress API's own e2e suite. Every
 * function here writes/reads the exact tables `progress.repository.ts` reads
 * (`customer_tracker_component_progress`, `customer_tracker_status`, `campaign_config_snapshot`)
 * directly via raw SQL — same "insert the row this read-side test needs directly, rather than
 * driving the whole Wave 3 write pipeline" precedent `test/modules/campaign-cache/*.spec.ts`
 * already set for a different table (`campaign_config_snapshot.repository.spec.ts`'s own header).
 * This module is entirely read-only in production; nothing here is production code.
 */
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type { CampaignConfigProto } from '@/modules/campaign-cache/campaign-config.client';

export function buildTestSequelize(): Sequelize {
  return new Sequelize({
    dialect: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    username: process.env.DB_APP_USERNAME,
    password: process.env.DB_APP_PASSWORD,
    logging: false,
    pool: { max: 10 },
  });
}

export interface SeedComponentProgressInput {
  tenantId: number;
  customerIdHash: string;
  campaignCode: string;
  trackerCode: string;
  trackerComponentCode: string;
  currentCount: number;
  requiredCount: number;
  completionCycle?: number;
  isCompleted?: boolean;
}

export async function seedComponentProgress(
  sequelize: Sequelize,
  input: SeedComponentProgressInput,
): Promise<void> {
  const isCompleted = input.isCompleted ?? input.currentCount >= input.requiredCount;
  await sequelize.query(
    `INSERT INTO realtime_activity_processing.customer_tracker_component_progress
       (tenant_id, customer_id_hash, campaign_code, tracker_code, tracker_component_code,
        current_count, required_count, completion_cycle, is_completed, completed_at)
     VALUES
       (:tenantId, :customerIdHash, :campaignCode, :trackerCode, :trackerComponentCode,
        :currentCount, :requiredCount, :completionCycle, :isCompleted, :completedAt)`,
    {
      type: QueryTypes.INSERT,
      replacements: {
        tenantId: input.tenantId,
        customerIdHash: input.customerIdHash,
        campaignCode: input.campaignCode,
        trackerCode: input.trackerCode,
        trackerComponentCode: input.trackerComponentCode,
        currentCount: input.currentCount,
        requiredCount: input.requiredCount,
        completionCycle: input.completionCycle ?? 1,
        isCompleted,
        completedAt: isCompleted ? new Date() : null,
      },
    },
  );
}

export interface SeedTrackerStatusInput {
  tenantId: number;
  customerIdHash: string;
  campaignCode: string;
  trackerCode: string;
  componentsRequiredCount: number;
  componentsCompletedCount: number;
  completionCycle?: number;
  isCompleted?: boolean;
}

export async function seedTrackerStatus(
  sequelize: Sequelize,
  input: SeedTrackerStatusInput,
): Promise<void> {
  const isCompleted =
    input.isCompleted ?? input.componentsCompletedCount >= input.componentsRequiredCount;
  await sequelize.query(
    `INSERT INTO realtime_activity_processing.customer_tracker_status
       (tenant_id, customer_id_hash, campaign_code, tracker_code, completion_cycle,
        components_required_count, components_completed_count, is_completed, completed_at)
     VALUES
       (:tenantId, :customerIdHash, :campaignCode, :trackerCode, :completionCycle,
        :componentsRequiredCount, :componentsCompletedCount, :isCompleted, :completedAt)`,
    {
      type: QueryTypes.INSERT,
      replacements: {
        tenantId: input.tenantId,
        customerIdHash: input.customerIdHash,
        campaignCode: input.campaignCode,
        trackerCode: input.trackerCode,
        completionCycle: input.completionCycle ?? 1,
        componentsRequiredCount: input.componentsRequiredCount,
        componentsCompletedCount: input.componentsCompletedCount,
        isCompleted,
        completedAt: isCompleted ? new Date() : null,
      },
    },
  );
}

export async function seedCampaignConfigSnapshot(
  sequelize: Sequelize,
  tenantId: number,
  campaignCode: string,
  trackers: { trackerCode: string; completionLogic: string }[],
): Promise<void> {
  const payload: Partial<CampaignConfigProto> = {
    campaignCode,
    tenantId,
    status: 'active',
    trackers: trackers.map((t, index) => ({
      trackerId: index + 1,
      trackerCode: t.trackerCode,
      name: t.trackerCode,
      completionLogic: t.completionLogic,
      completionThreshold: 0,
      status: 'active',
      components: [],
    })),
  };
  await sequelize.query(
    `INSERT INTO realtime_activity_processing.campaign_config_snapshot
       (tenant_id, campaign_code, config_version, is_active, payload)
     VALUES (:tenantId, :campaignCode, 'v1', true, CAST(:payload AS jsonb))
     ON CONFLICT (tenant_id, campaign_code)
     DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    {
      type: QueryTypes.INSERT,
      replacements: { tenantId, campaignCode, payload: JSON.stringify(payload) },
    },
  );
}

export async function cleanupTenant(sequelize: Sequelize, tenantId: number): Promise<void> {
  await sequelize.query(
    'DELETE FROM realtime_activity_processing.customer_tracker_component_progress WHERE tenant_id = :tenantId',
    { type: QueryTypes.RAW, replacements: { tenantId } },
  );
  await sequelize.query(
    'DELETE FROM realtime_activity_processing.customer_tracker_status WHERE tenant_id = :tenantId',
    { type: QueryTypes.RAW, replacements: { tenantId } },
  );
  await sequelize.query(
    'DELETE FROM realtime_activity_processing.campaign_config_snapshot WHERE tenant_id = :tenantId',
    { type: QueryTypes.RAW, replacements: { tenantId } },
  );
}
