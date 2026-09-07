/**
 * T-RR-036. Self-contained `reward_redemption_entry` fixture helper for this task's own
 * `notification-log.repository.spec.ts` — same shape as `test/dispatch/fixtures/
 * reward-redemption-entry.fixture.ts` (T-RR-034, confirmed by direct read), duplicated locally
 * rather than imported across task test-scope boundaries, for the identical reason that file's own
 * header already documents: every prior spec file in this service keeps its own copy of this
 * fixture rather than sharing one, since `test/dispatch/**`/`test/redemption/**` are other tasks'
 * own test scope.
 */
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';

export function baseEntryFields(
  tenantId: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: randomUUID(),
    correlation_id: randomUUID(),
    tenant_id: tenantId,
    customer_id_encrypted: 'ciphertext-placeholder',
    customer_id_hash: `hash-${randomUUID()}`,
    customer_id_type: 'EMAIL',
    activity_performed_date: new Date(),
    transaction_type: null,
    activity_code: 'ACT_CODE',
    activity_type: 'PURCHASE',
    activity_category: 'SPEND',
    activity_value: 10,
    activity_value_unit: 'USD',
    channel: 'WEB',
    activity_performed_env: 'PROD',
    activity_name: 't-rr-036 notification fixture',
    campaign_code: 'CAMP1',
    tracker_code: 'TRK1',
    tracker_component_code: 'COMP1',
    merchant_code: null,
    reward_code: 'RWD1',
    reward_category: 'CASHBACK',
    reward_value: 5,
    reward_value_unit: 'USD',
    reward_entry_date: new Date(),
    completion_cycle: 1,
    reward_processed_env: 'development',
    country_code: 'MY',
    tenant_code: 'TEN-TEST',
    ingestion_channel: 'REST',
    status: 'completed',
    retry_count: 0,
    next_attempt_at: null,
    external_system_code: 'CORE_BANKING',
    external_reference_id: `REF-${randomUUID()}`,
    redeemed_at: new Date(),
    ...overrides,
  };
}

export async function insertEntry(
  sequelize: Sequelize,
  tenantId: number,
  overrides: Record<string, unknown> = {},
): Promise<RewardRedemptionEntryRow> {
  const f = baseEntryFields(tenantId, overrides);
  const [row] = await sequelize.query<RewardRedemptionEntryRow>(
    `INSERT INTO reward_redemption.reward_redemption_entry
       (id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash, customer_id_type,
        activity_performed_date, transaction_type, activity_code, activity_type,
        activity_category, activity_value, activity_value_unit, channel, activity_performed_env,
        activity_name, campaign_code, tracker_code, tracker_component_code, merchant_code,
        reward_code, reward_category, reward_value, reward_value_unit, reward_entry_date,
        completion_cycle, reward_processed_env, country_code, tenant_code, ingestion_channel,
        status, retry_count, next_attempt_at, external_system_code, external_reference_id,
        redeemed_at)
     VALUES
       (:id, :correlation_id, :tenant_id, :customer_id_encrypted, :customer_id_hash,
        :customer_id_type, :activity_performed_date, :transaction_type, :activity_code,
        :activity_type, :activity_category, :activity_value, :activity_value_unit, :channel,
        :activity_performed_env, :activity_name, :campaign_code, :tracker_code,
        :tracker_component_code, :merchant_code, :reward_code, :reward_category, :reward_value,
        :reward_value_unit, :reward_entry_date, :completion_cycle, :reward_processed_env,
        :country_code, :tenant_code, :ingestion_channel, :status, :retry_count, :next_attempt_at,
        :external_system_code, :external_reference_id, :redeemed_at)
     RETURNING *`,
    { type: QueryTypes.SELECT, replacements: f },
  );
  return row;
}
