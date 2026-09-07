/**
 * T-RR-062 — `buildOutboxPayload`'s six (seven, per that task's own "implementation note 1"
 * counting) new fields: `trackerCode`/`trackerComponentCode`/`merchantCode`/`expiresAt`/
 * `rewardKind`/`promoCodeConfigId`/`promoCodeConfigVersionNo`. Pure in-memory unit tests (no real
 * Postgres round trip needed — `buildOutboxPayload` is a pure function of an already-constructed
 * `RewardRedemptionEntryRow`); the real-DB round trip through an actual `INSERT ... RETURNING *`
 * is separately covered by `reward-tracking-outbox.repository.spec.ts`'s own TC-4.
 */
import { randomUUID } from 'node:crypto';
import { buildOutboxPayload } from '@/modules/dispatch/reward-tracking-outbox.repository';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';

function baseEntry(overrides: Partial<RewardRedemptionEntryRow> = {}): RewardRedemptionEntryRow {
  const now = new Date();
  return {
    id: randomUUID(),
    correlation_id: randomUUID(),
    tenant_id: 1,
    customer_id_encrypted: 'ciphertext-placeholder',
    customer_id_hash: `hash-${randomUUID()}`,
    customer_id_type: 'EMAIL',
    activity_performed_date: now,
    transaction_type: null,
    activity_code: 'ACT_CODE',
    activity_type: 'PURCHASE',
    activity_category: 'SPEND',
    activity_value: '10',
    activity_value_unit: 'USD',
    channel: 'WEB',
    activity_performed_env: 'PROD',
    activity_name: 't-rr-062 payload-fields fixture',
    campaign_code: 'CAMP1',
    tracker_code: 'TRK1',
    tracker_component_code: 'COMP1',
    merchant_code: null,
    reward_code: 'RWD1',
    reward_category: 'CASHBACK',
    reward_value: '5',
    reward_value_unit: 'USD',
    reward_entry_date: now,
    completion_cycle: 1,
    reward_processed_env: 'development',
    country_code: 'MY',
    tenant_code: 'TEN-TEST',
    ingestion_channel: 'REST',
    status: 'completed',
    retry_count: 0,
    next_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    last_attempted_at: null,
    external_system_code: 'PROMO_CODE_SERVICE',
    external_reference_id: `PC-${randomUUID()}`,
    redeemed_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('T-RR-062 — buildOutboxPayload, new fields', () => {
  it('TC-1: an entry with tracker/component/merchant codes set -> all seven new payload fields present, correct values', () => {
    const expiresAt = new Date('2027-01-01T00:00:00.000Z');
    const entry = baseEntry({
      tracker_code: 'TRK-ABC',
      tracker_component_code: 'COMP-XYZ',
      merchant_code: 'MERCH-1',
      expires_at: expiresAt,
      reward_kind: 'FIXED_AMOUNT',
      promo_code_config_id: null,
      promo_code_config_version_no: null,
    });

    const payload = buildOutboxPayload(entry);

    expect(payload.trackerCode).toBe('TRK-ABC');
    expect(payload.trackerComponentCode).toBe('COMP-XYZ');
    expect(payload.merchantCode).toBe('MERCH-1');
    expect(payload.expiresAt).toBe(expiresAt.toISOString());
    expect(payload.rewardKind).toBe('FIXED_AMOUNT');
    expect(payload.promoCodeConfigId).toBeNull();
    expect(payload.promoCodeConfigVersionNo).toBeNull();
  });

  it('TC-2: expires_at/reward_kind/promo_code_config_id/promo_code_config_version_no all NULL -> all corresponding payload fields are null, never omitted, never fabricated', () => {
    const entry = baseEntry({
      expires_at: null,
      reward_kind: null,
      promo_code_config_id: null,
      promo_code_config_version_no: null,
    });

    const payload = buildOutboxPayload(entry);

    expect(payload).toHaveProperty('expiresAt', null);
    expect(payload).toHaveProperty('rewardKind', null);
    expect(payload).toHaveProperty('promoCodeConfigId', null);
    expect(payload).toHaveProperty('promoCodeConfigVersionNo', null);
  });

  it('TC-2a: a PROMO_CODE-kind entry with promo_code_config_id/promo_code_config_version_no set -> both present and correct in the payload', () => {
    const entry = baseEntry({
      reward_kind: 'PROMO_CODE',
      promo_code_config_id: 'PCC-9',
      promo_code_config_version_no: 3,
    });

    const payload = buildOutboxPayload(entry);

    expect(payload.rewardKind).toBe('PROMO_CODE');
    expect(payload.promoCodeConfigId).toBe('PCC-9');
    expect(payload.promoCodeConfigVersionNo).toBe(3);
  });

  it('merchantCode stays null for an entry with no merchant (the direct, no-connector completion path)', () => {
    const entry = baseEntry({ merchant_code: null });

    const payload = buildOutboxPayload(entry);

    expect(payload.merchantCode).toBeNull();
  });

  it('expiresAt stays null for a reward that never expires', () => {
    const entry = baseEntry({ expires_at: null });

    const payload = buildOutboxPayload(entry);

    expect(payload.expiresAt).toBeNull();
  });

  it('TC-3 (regression): the 14 pre-existing 02-KAFKA-CONTRACTS.md §2 fields are unchanged, proving this is additive', () => {
    const entry = baseEntry();

    const payload = buildOutboxPayload(entry);

    expect(payload).toMatchObject({
      rewardEntryId: entry.id,
      tenantId: entry.tenant_id,
      tenantCode: entry.tenant_code,
      countryCode: entry.country_code,
      customerIdEncrypted: entry.customer_id_encrypted,
      campaignCode: entry.campaign_code,
      rewardCode: entry.reward_code,
      rewardCategory: entry.reward_category,
      rewardValue: entry.reward_value,
      rewardValueUnit: entry.reward_value_unit,
      externalSystemCode: entry.external_system_code,
      externalReferenceId: entry.external_reference_id,
      redeemedAt: (entry.redeemed_at as Date).toISOString(),
      correlationId: entry.correlation_id,
    });
    expect(payload).not.toHaveProperty('customerId');
  });
});
