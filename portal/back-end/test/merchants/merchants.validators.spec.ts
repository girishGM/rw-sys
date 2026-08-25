/**
 * T-036 — `merchants.validators.ts`: `commission_rate` (implementation note 5, TC-17/TC-18/TC-19).
 */
import {
  commissionRateToColumnString,
  isCommissionRate,
} from '@/modules/merchants/merchants.validators';

describe('isCommissionRate', () => {
  it('accepts 0, 100 and values in between with up to 2 decimals', () => {
    expect(isCommissionRate(0)).toBe(true);
    expect(isCommissionRate(100)).toBe(true);
    expect(isCommissionRate(50)).toBe(true);
    expect(isCommissionRate(12.34)).toBe(true); // TC-19
    expect(isCommissionRate(12.3)).toBe(true);
    expect(isCommissionRate(0.01)).toBe(true);
  });

  it('rejects a value above 100 (TC-17)', () => {
    expect(isCommissionRate(150)).toBe(false);
    expect(isCommissionRate(100.01)).toBe(false);
  });

  it('rejects a negative value', () => {
    expect(isCommissionRate(-0.01)).toBe(false);
  });

  it('rejects more than 2 fractional digits (TC-18)', () => {
    expect(isCommissionRate(12.345)).toBe(false);
    expect(isCommissionRate(0.001)).toBe(false);
  });

  it('rejects a non-finite or non-number value', () => {
    expect(isCommissionRate(Number.NaN)).toBe(false);
    expect(isCommissionRate(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isCommissionRate('12.34')).toBe(false);
    expect(isCommissionRate(undefined)).toBe(false);
    expect(isCommissionRate(null)).toBe(false);
  });
});

describe('commissionRateToColumnString', () => {
  it('preserves an already-two-decimal value exactly (TC-19)', () => {
    expect(commissionRateToColumnString(12.34)).toBe('12.34');
  });

  it('pads a whole number to two decimals', () => {
    expect(commissionRateToColumnString(50)).toBe('50.00');
  });

  it('pads a single-decimal value to two decimals', () => {
    expect(commissionRateToColumnString(12.3)).toBe('12.30');
  });

  it('handles the boundary values', () => {
    expect(commissionRateToColumnString(0)).toBe('0.00');
    expect(commissionRateToColumnString(100)).toBe('100.00');
  });
});
