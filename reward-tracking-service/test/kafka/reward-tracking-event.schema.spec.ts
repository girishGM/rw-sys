/**
 * T-RTS-012 — `parseRewardTrackingEventMessage`, unit-tested directly (no DB, no Kafka) — pure
 * function, never throws.
 */
import { randomUUID } from 'node:crypto';
import { parseRewardTrackingEventMessage } from '@/kafka/reward-tracking-event.schema';

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rewardEntryId: randomUUID(),
    correlationId: randomUUID(),
    tenantId: 1,
    tenantCode: 'T1',
    countryCode: 'US',
    customerId: 'customer-1',
    campaignCode: 'CAMP-1',
    trackerCode: 'TRK1',
    trackerComponentCode: 'COMP1',
    merchantCode: null,
    rewardCode: 'RWD1',
    rewardCategory: 'CASHBACK',
    rewardKind: 'FIXED_AMOUNT',
    unitType: 'CURRENCY',
    unitCode: 'USD',
    rewardValue: '5.00',
    rewardValueUnit: 'USD',
    externalSystemCode: null,
    externalReferenceId: null,
    promoCodeConfigId: null,
    promoCodeConfigVersionNo: null,
    redeemedAt: '2026-09-04T10:15:07.500Z',
    expiresAt: null,
    ...overrides,
  };
}

describe('T-RTS-012 — parseRewardTrackingEventMessage', () => {
  it('accepts a well-formed body, mapping receivedChannel to KAFKA', () => {
    const result = parseRewardTrackingEventMessage(validBody());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.receivedChannel).toBe('KAFKA');
      expect(result.input.trackerCode).toBe('TRK1');
      expect(result.input.rewardKind).toBe('FIXED_AMOUNT');
    }
  });

  it('rejects a non-object payload', () => {
    expect(parseRewardTrackingEventMessage('just a string')).toEqual({
      ok: false,
      reason: 'message body is not a JSON object',
    });
    expect(parseRewardTrackingEventMessage(null)).toEqual({
      ok: false,
      reason: 'message body is not a JSON object',
    });
    expect(parseRewardTrackingEventMessage([1, 2, 3])).toEqual({
      ok: false,
      reason: 'message body is not a JSON object',
    });
  });

  it.each([
    'rewardEntryId',
    'correlationId',
    'customerId',
    'campaignCode',
    'trackerCode',
    'trackerComponentCode',
    'rewardCode',
    'rewardCategory',
    'rewardValue',
    'rewardValueUnit',
  ])('rejects a body missing required field %s', (field) => {
    const body = validBody();
    delete body[field];

    const result = parseRewardTrackingEventMessage(body);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(field);
    }
  });

  it('rejects a non-positive-integer tenantId', () => {
    expect(parseRewardTrackingEventMessage(validBody({ tenantId: 0 })).ok).toBe(false);
    expect(parseRewardTrackingEventMessage(validBody({ tenantId: -1 })).ok).toBe(false);
    expect(parseRewardTrackingEventMessage(validBody({ tenantId: 1.5 })).ok).toBe(false);
    expect(parseRewardTrackingEventMessage(validBody({ tenantId: '1' })).ok).toBe(false);
  });

  it('rejects a non-numeric rewardValue', () => {
    const result = parseRewardTrackingEventMessage(validBody({ rewardValue: 'not-a-number' }));
    expect(result.ok).toBe(false);
  });

  it('rejects an unparseable redeemedAt', () => {
    const result = parseRewardTrackingEventMessage(validBody({ redeemedAt: 'not-a-date' }));
    expect(result.ok).toBe(false);
  });

  it('accepts a missing/null/empty expiresAt as null, and rejects an unparseable one when provided', () => {
    expect(parseRewardTrackingEventMessage(validBody({ expiresAt: undefined })).ok).toBe(true);
    expect(parseRewardTrackingEventMessage(validBody({ expiresAt: null })).ok).toBe(true);
    expect(parseRewardTrackingEventMessage(validBody({ expiresAt: '' })).ok).toBe(true);

    const bad = parseRewardTrackingEventMessage(validBody({ expiresAt: 'not-a-date' }));
    expect(bad.ok).toBe(false);
  });

  it('rejects an out-of-enum rewardKind, accepts a valid one, and treats missing/null/empty as null', () => {
    expect(parseRewardTrackingEventMessage(validBody({ rewardKind: 'NOT_A_KIND' })).ok).toBe(false);

    const withKind = parseRewardTrackingEventMessage(validBody({ rewardKind: 'POINTS' }));
    expect(withKind.ok).toBe(true);
    if (withKind.ok) {
      expect(withKind.input.rewardKind).toBe('POINTS');
    }

    for (const value of [undefined, null, '']) {
      const result = parseRewardTrackingEventMessage(validBody({ rewardKind: value }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.rewardKind).toBeNull();
      }
    }
  });

  it('maps optional string fields (empty/null/undefined) to null, not empty-string', () => {
    const result = parseRewardTrackingEventMessage(
      validBody({ tenantCode: '', countryCode: null, merchantCode: undefined }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.tenantCode).toBeNull();
      expect(result.input.countryCode).toBeNull();
      expect(result.input.merchantCode).toBeNull();
    }
  });

  it('maps a numeric promoCodeConfigVersionNo through, and a non-number to null', () => {
    const withNumber = parseRewardTrackingEventMessage(validBody({ promoCodeConfigVersionNo: 3 }));
    expect(withNumber.ok).toBe(true);
    if (withNumber.ok) {
      expect(withNumber.input.promoCodeConfigVersionNo).toBe(3);
    }

    const withoutNumber = parseRewardTrackingEventMessage(
      validBody({ promoCodeConfigVersionNo: 'not-a-number' }),
    );
    expect(withoutNumber.ok).toBe(true);
    if (withoutNumber.ok) {
      expect(withoutNumber.input.promoCodeConfigVersionNo).toBeNull();
    }
  });
});
