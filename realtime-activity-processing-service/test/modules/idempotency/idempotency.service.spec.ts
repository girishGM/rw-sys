import { IdempotencyService } from '@/modules/idempotency/idempotency.service';
import { InboundActivity } from '@/modules/idempotency/inbound-activity.types';

function buildActivity(overrides: Partial<InboundActivity> = {}): InboundActivity {
  return {
    tenantId: 1,
    customerId: 'cust-123',
    customerIdType: 'INTERNAL_ID',
    activityPerformedDate: new Date('2026-09-01T10:15:30.000Z'),
    activityCode: 'PURCHASE',
    activityType: 'TRANSACTION',
    activityCategory: 'RETAIL',
    activityValue: '100.0000',
    activityValueUnit: 'USD',
    channel: 'WEB',
    activityPerformedEnv: 'PROD',
    activityName: 'Online purchase',
    sourceTransport: 'GRPC',
    ...overrides,
  };
}

describe('IdempotencyService.deriveDedupKey', () => {
  let service: IdempotencyService;

  beforeEach(() => {
    service = new IdempotencyService();
  });

  // TC-1: activity with activityEventId set -> dedupKey equals it verbatim.
  it('returns the activityEventId verbatim, byte-for-byte, when present', () => {
    const activity = buildActivity({ activityEventId: 'upstream-event-id-987' });
    expect(service.deriveDedupKey(activity)).toBe('upstream-event-id-987');
  });

  // TC-2: two identical activities (all five composite fields equal), no activityEventId ->
  // same dedupKey both times.
  it('derives the same composite dedupKey for two activities with identical composite fields', () => {
    const a = buildActivity();
    const b = buildActivity();
    const keyA = service.deriveDedupKey(a);
    const keyB = service.deriveDedupKey(b);
    expect(keyA).toBe(keyB);
    // Not the change-detector version of this assertion: also prove it's a real SHA-256 hex
    // digest, the actual outcome the design doc specifies, not just "however my own code happens
    // to format it".
    expect(keyA).toMatch(/^[0-9a-f]{64}$/);
  });

  // TC-3: two activities differing only in activityValue, no activityEventId -> different
  // dedupKeys.
  it('derives a different composite dedupKey when only activityValue differs', () => {
    const a = buildActivity({ activityValue: '100.0000' });
    const b = buildActivity({ activityValue: '200.0000' });
    expect(service.deriveDedupKey(a)).not.toBe(service.deriveDedupKey(b));
  });

  it('derives a different composite dedupKey when only customerId differs', () => {
    const a = buildActivity({ customerId: 'cust-123' });
    const b = buildActivity({ customerId: 'cust-456' });
    expect(service.deriveDedupKey(a)).not.toBe(service.deriveDedupKey(b));
  });

  it('derives a different composite dedupKey when only channel differs', () => {
    const a = buildActivity({ channel: 'WEB' });
    const b = buildActivity({ channel: 'MOBILE' });
    expect(service.deriveDedupKey(a)).not.toBe(service.deriveDedupKey(b));
  });

  it('derives a different composite dedupKey when only activityPerformedDate differs', () => {
    const a = buildActivity({ activityPerformedDate: new Date('2026-09-01T10:15:30.000Z') });
    const b = buildActivity({ activityPerformedDate: new Date('2026-09-01T10:15:31.000Z') });
    expect(service.deriveDedupKey(a)).not.toBe(service.deriveDedupKey(b));
  });

  it('uses transactionType in place of activityCode when activityCode is absent', () => {
    const withActivityCode = buildActivity({
      activityCode: 'REFERRAL',
      transactionType: undefined,
    });
    const withTransactionType = buildActivity({
      activityCode: undefined,
      transactionType: 'REFERRAL',
    });
    // Same value in the "code-or-type" slot, everything else equal -> same key, proving the
    // fallback genuinely folds the two fields into one hash input rather than only ever reading
    // activityCode.
    expect(service.deriveDedupKey(withActivityCode)).toBe(
      service.deriveDedupKey(withTransactionType),
    );
  });

  it('does not collide when the delimiter could otherwise be shifted by concatenation', () => {
    // Guards the "delimiter cannot appear in a valid field value, so no combination of field
    // values can collide by shifting where the delimiter falls" property directly: "AB" + "C" and
    // "A" + "BC" (channel and customerId concatenated naively without a delimiter) must not hash
    // to the same value.
    const a = buildActivity({ customerId: 'AB', activityCode: 'C' });
    const b = buildActivity({ customerId: 'A', activityCode: 'BC' });
    expect(service.deriveDedupKey(a)).not.toBe(service.deriveDedupKey(b));
  });

  // TC-4: activity with neither activityCode nor transactionType -> throws, does not silently
  // hash.
  it('throws rather than silently hashing null when neither activityCode nor transactionType is present', () => {
    const activity = buildActivity({ activityCode: undefined, transactionType: undefined });
    expect(() => service.deriveDedupKey(activity)).toThrow(
      /neither activityEventId, activityCode, nor transactionType/,
    );
  });

  it('is pure: calling it twice on the same input produces the same output', () => {
    const activity = buildActivity();
    expect(service.deriveDedupKey(activity)).toBe(service.deriveDedupKey(activity));
  });
});
