/**
 * T-RR-034. Self-contained `reward_redemption_entry` fixture helper for this task's own two spec
 * files (`reward-tracking-outbox.repository.spec.ts`/`outbox-publisher.service.spec.ts`) — mirrors
 * the same inline `baseEntryFields`/`insertEntry` shape `test/redemption/redemption-state-machine.
 * service.spec.ts` (T-RR-021) already established, kept as this task's own copy rather than an
 * import across module/agent boundaries (that file is `src/modules/redemption/**`'s own test
 * scope, a different task, R3) — every prior spec file in this service duplicates this same
 * fixture shape locally rather than sharing one across task boundaries, for the identical reason.
 *
 * Defaults every row to `status: 'completed'`/`redeemed_at: now()`/real `tenant_code`/
 * `country_code` — the exact post-enrichment, post-redemption shape a row must have by the time it
 * reaches `reward_tracking_dispatch_outbox` (`buildOutboxPayload`'s own two invariant checks).
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
    activity_name: 't-rr-034 dispatch fixture',
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
    external_system_code: 'PROMO_CODE_SERVICE',
    external_reference_id: `PC-${randomUUID()}`,
    redeemed_at: new Date(),
    // T-RR-062: expires_at (T-RR-063's own column, never previously wired into this fixture's own
    // INSERT column list below — this task is the first to also read it from an inserted row) and
    // the three new T-RR-062 columns all default to `null`, the same "nullable means not yet known,
    // never fabricated" value every real un-overridden row has today.
    expires_at: null,
    reward_kind: null,
    promo_code_config_id: null,
    promo_code_config_version_no: null,
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
        redeemed_at, expires_at, reward_kind, promo_code_config_id, promo_code_config_version_no)
     VALUES
       (:id, :correlation_id, :tenant_id, :customer_id_encrypted, :customer_id_hash,
        :customer_id_type, :activity_performed_date, :transaction_type, :activity_code,
        :activity_type, :activity_category, :activity_value, :activity_value_unit, :channel,
        :activity_performed_env, :activity_name, :campaign_code, :tracker_code,
        :tracker_component_code, :merchant_code, :reward_code, :reward_category, :reward_value,
        :reward_value_unit, :reward_entry_date, :completion_cycle, :reward_processed_env,
        :country_code, :tenant_code, :ingestion_channel, :status, :retry_count, :next_attempt_at,
        :external_system_code, :external_reference_id, :redeemed_at, :expires_at, :reward_kind,
        :promo_code_config_id, :promo_code_config_version_no)
     RETURNING *`,
    { type: QueryTypes.SELECT, replacements: f },
  );
  return row;
}
