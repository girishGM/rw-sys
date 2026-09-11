import { toSubmitActivityRequest } from './mapping';

describe('toSubmitActivityRequest', () => {
  it("maps an activity with a merchant and amount onto RAP's full request shape", () => {
    const result = toSubmitActivityRequest({
      activityId: 'a1a1a1a1-0000-4000-8000-000000000001',
      customerId: 'priya-shah',
      activityType: 'Grocery Purchase',
      activityCode: null,
      merchant: 'ACME',
      amount: 12.5,
      tenantId: 1,
    });

    expect(result.tenantId).toBe(1);
    expect(result.customerId).toBe('priya-shah');
    expect(result.activityCode).toBe('Grocery Purchase');
    expect(result.activityType).toBe('Grocery Purchase');
    expect(result.activityName).toBe('Grocery Purchase');
    expect(result.activityValue).toBe('12.5');
    expect(result.merchantCode).toBe('ACME');
    expect(result.activityEventId).toBe('a1a1a1a1-0000-4000-8000-000000000001');
    expect(result.correlationId).toBe('a1a1a1a1-0000-4000-8000-000000000001');
    // Date#toISOString always carries an explicit "Z" offset.
    expect(result.activityPerformedDate).toMatch(/Z$/);
  });

  it('falls back to "0" for activityValue and omits merchantCode when neither is present', () => {
    const result = toSubmitActivityRequest({
      activityId: 'a1a1a1a1-0000-4000-8000-000000000002',
      customerId: 'priya-shah',
      activityType: 'Refer a Friend',
      activityCode: null,
      merchant: null,
      amount: null,
      tenantId: 1,
    });

    expect(result.activityValue).toBe('0');
    expect(result.merchantCode).toBeUndefined();
  });

  // T-INT-054
  it('omits tenantId when no real campaign was resolvable (tenantId: null)', () => {
    const result = toSubmitActivityRequest({
      activityId: 'a1a1a1a1-0000-4000-8000-000000000003',
      customerId: 'priya-shah',
      activityType: 'Grocery Purchase',
      activityCode: null,
      merchant: null,
      amount: null,
      tenantId: null,
    });

    expect(result.tenantId).toBeUndefined();
  });

  // T-INT — regression for the live bug found once RAP's campaign cache was actually synced with
  // real data: this app was sending activityType (a display label, e.g. "Weekend Transaction")
  // as RAP's activityCode, which never matches RAP's real, machine-readable codes (e.g.
  // "WEEKEND_TRANSACTION"). Once a real component has matched, the real code must be sent instead.
  it('prefers the real, matched activityCode over the activityType label once one is known', () => {
    const result = toSubmitActivityRequest({
      activityId: 'a1a1a1a1-0000-4000-8000-000000000004',
      customerId: 'marcus-tan',
      activityType: 'Weekend Transaction',
      activityCode: 'WEEKEND_TRANSACTION',
      merchant: null,
      amount: null,
      tenantId: 7,
    });

    expect(result.activityCode).toBe('WEEKEND_TRANSACTION');
    expect(result.activityType).toBe('Weekend Transaction');
    expect(result.activityName).toBe('Weekend Transaction');
  });
});
