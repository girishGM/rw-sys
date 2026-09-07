import { toSubmitActivityRequest } from './mapping';

describe('toSubmitActivityRequest', () => {
  it("maps an activity with a merchant and amount onto RAP's full request shape", () => {
    const result = toSubmitActivityRequest({
      activityId: 'a1a1a1a1-0000-4000-8000-000000000001',
      customerId: 'priya-shah',
      activityType: 'Grocery Purchase',
      merchant: 'ACME',
      amount: 12.5,
    });

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
      merchant: null,
      amount: null,
    });

    expect(result.activityValue).toBe('0');
    expect(result.merchantCode).toBeUndefined();
  });
});
