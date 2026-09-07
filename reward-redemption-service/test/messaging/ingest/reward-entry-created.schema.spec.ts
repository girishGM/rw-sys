/**
 * T-RR-012. Unit tests for `validateRewardEntryCreatedMessage` — pure, no DB, no Kafka. Proves the
 * mandatory-field/decimal/ISO-8601-with-offset rules `02-KAFKA-CONTRACTS.md` §1 requires, and that
 * a well-formed message maps onto exactly the `RewardEntryIngestDto` shape T-RR-010's own domain
 * method expects, with `ingestionChannel: 'KAFKA'` stamped on every result.
 */
import { validateRewardEntryCreatedMessage } from '@/messaging/ingest/reward-entry-created.schema';

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '018f6b2e-0000-0000-0000-000000000001',
    correlationId: '018f6b2e-0000-0000-0000-000000000002',
    tenantId: 1,
    customerId: 'MSISDN-60123456789',
    customerIdType: 'MSISDN',
    activityPerformedDate: '2026-09-04T10:15:00.000Z',
    transactionType: null,
    activityCode: 'TXN_TOPUP',
    activityType: 'TOPUP',
    activityCategory: 'TELCO',
    activityValue: '50.0000',
    activityValueUnit: 'MYR',
    channel: 'app',
    activityPerformedEnv: 'production',
    activityName: 'Prepaid Top-up',
    campaignCode: 'CAMP-2026-Q3-001',
    trackerCode: 'TRK-TOPUP-5X',
    trackerComponentCode: 'CMP-TOPUP-STEP-3',
    merchantCode: 'MERCH-001',
    rewardCode: 'RWD-CASHBACK-5PCT',
    rewardCategory: 'CASHBACK',
    rewardValue: '2.5000',
    rewardValueUnit: 'MYR',
    rewardEntryDate: '2026-09-04T10:15:03.000Z',
    completionCycle: 1,
    ...overrides,
  };
}

describe('validateRewardEntryCreatedMessage', () => {
  it('accepts a fully well-formed message and maps it onto RewardEntryIngestDto with ingestionChannel KAFKA', () => {
    const result = validateRewardEntryCreatedMessage(validBody());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dto).toMatchObject({
      id: '018f6b2e-0000-0000-0000-000000000001',
      correlationId: '018f6b2e-0000-0000-0000-000000000002',
      tenantId: 1,
      customerId: 'MSISDN-60123456789',
      customerIdType: 'MSISDN',
      transactionType: null,
      activityCode: 'TXN_TOPUP',
      activityType: 'TOPUP',
      activityCategory: 'TELCO',
      activityValue: '50.0000',
      activityValueUnit: 'MYR',
      channel: 'app',
      activityPerformedEnv: 'production',
      activityName: 'Prepaid Top-up',
      campaignCode: 'CAMP-2026-Q3-001',
      trackerCode: 'TRK-TOPUP-5X',
      trackerComponentCode: 'CMP-TOPUP-STEP-3',
      merchantCode: 'MERCH-001',
      rewardCode: 'RWD-CASHBACK-5PCT',
      rewardCategory: 'CASHBACK',
      rewardValue: '2.5000',
      rewardValueUnit: 'MYR',
      completionCycle: 1,
      ingestionChannel: 'KAFKA',
    });
    expect(result.dto.activityPerformedDate).toBeInstanceOf(Date);
    expect(result.dto.activityPerformedDate.toISOString()).toBe('2026-09-04T10:15:00.000Z');
    expect(result.dto.rewardEntryDate).toBeInstanceOf(Date);
    expect(result.dto.rewardEntryDate.toISOString()).toBe('2026-09-04T10:15:03.000Z');
  });

  it('treats an absent merchantCode as null (documented optional field)', () => {
    const { merchantCode: _omit, ...withoutMerchantCode } = validBody();
    const result = validateRewardEntryCreatedMessage(withoutMerchantCode);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dto.merchantCode).toBeNull();
  });

  it('accepts a transactionType-only message (no activityCode)', () => {
    const result = validateRewardEntryCreatedMessage(
      validBody({ activityCode: null, transactionType: 'TXN_PURCHASE' }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dto.transactionType).toBe('TXN_PURCHASE');
    expect(result.dto.activityCode).toBeNull();
  });

  it('rejects a non-object payload', () => {
    expect(validateRewardEntryCreatedMessage('not an object')).toEqual({
      ok: false,
      reason: 'message body is not a JSON object',
    });
    expect(validateRewardEntryCreatedMessage(null)).toEqual({
      ok: false,
      reason: 'message body is not a JSON object',
    });
    expect(validateRewardEntryCreatedMessage([1, 2, 3])).toEqual({
      ok: false,
      reason: 'message body is not a JSON object',
    });
  });

  // TC-3 (negative), mirrored per field
  it('rejects a message missing the mandatory campaignCode field', () => {
    const { campaignCode: _omit, ...withoutCampaignCode } = validBody();
    const result = validateRewardEntryCreatedMessage(withoutCampaignCode);

    expect(result).toEqual({ ok: false, reason: 'campaignCode is required' });
  });

  it.each([
    'id',
    'correlationId',
    'customerId',
    'customerIdType',
    'activityType',
    'activityCategory',
    'activityValueUnit',
    'channel',
    'activityPerformedEnv',
    'activityName',
    'campaignCode',
    'trackerCode',
    'trackerComponentCode',
    'rewardCode',
    'rewardCategory',
    'rewardValueUnit',
  ])('rejects a message missing mandatory field %s', (field) => {
    const body = validBody();
    delete body[field];

    const result = validateRewardEntryCreatedMessage(body);

    expect(result.ok).toBe(false);
  });

  it('rejects a message with a non-numeric tenantId', () => {
    const result = validateRewardEntryCreatedMessage(validBody({ tenantId: 'not-a-number' }));

    expect(result).toEqual({
      ok: false,
      reason: 'tenantId is required and must be a finite number',
    });
  });

  it('rejects a message missing both transactionType and activityCode', () => {
    const result = validateRewardEntryCreatedMessage(
      validBody({ transactionType: null, activityCode: null }),
    );

    expect(result).toEqual({
      ok: false,
      reason: 'one of transactionType or activityCode is required',
    });
  });

  it('rejects a non-decimal activityValue', () => {
    const result = validateRewardEntryCreatedMessage(validBody({ activityValue: 'not-a-number' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/activityValue/);
  });

  it('rejects scientific-notation activityValue (not a plain decimal string)', () => {
    const result = validateRewardEntryCreatedMessage(validBody({ activityValue: '1e10' }));

    expect(result.ok).toBe(false);
  });

  it('rejects a non-decimal rewardValue', () => {
    const result = validateRewardEntryCreatedMessage(validBody({ rewardValue: 'abc' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/rewardValue/);
  });

  // TC-4 (negative)
  it('rejects an unparseable activityPerformedDate', () => {
    const result = validateRewardEntryCreatedMessage(
      validBody({ activityPerformedDate: '2026-09-04 10:15:00' }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/activityPerformedDate/);
  });

  it('rejects an activityPerformedDate with no explicit UTC offset', () => {
    const result = validateRewardEntryCreatedMessage(
      validBody({ activityPerformedDate: 'not-a-date-at-all' }),
    );

    expect(result.ok).toBe(false);
  });

  it('rejects an unparseable rewardEntryDate', () => {
    const result = validateRewardEntryCreatedMessage(validBody({ rewardEntryDate: 'garbage' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/rewardEntryDate/);
  });

  it('rejects a non-integer completionCycle', () => {
    const result = validateRewardEntryCreatedMessage(validBody({ completionCycle: 1.5 }));

    expect(result).toEqual({
      ok: false,
      reason: 'completionCycle is required and must be an integer',
    });
  });

  it('rejects a missing completionCycle', () => {
    const { completionCycle: _omit, ...withoutCompletionCycle } = validBody();
    const result = validateRewardEntryCreatedMessage(withoutCompletionCycle);

    expect(result).toEqual({
      ok: false,
      reason: 'completionCycle is required and must be an integer',
    });
  });

  it('never expects/validates country, tenantCode, or rewardProcessedEnv (never on this wire)', () => {
    // A message that only carries these three plus the real mandatory fields must still validate
    // successfully — their presence or absence is never inspected.
    const result = validateRewardEntryCreatedMessage(
      validBody({ country: 'MY', tenantCode: 'TEN-MY', rewardProcessedEnv: 'production' }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dto).not.toHaveProperty('country');
    expect(result.dto).not.toHaveProperty('tenantCode');
    expect(result.dto).not.toHaveProperty('rewardProcessedEnv');
  });
});
