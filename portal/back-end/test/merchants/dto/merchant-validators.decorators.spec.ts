/**
 * T-036 — `class-validator` adapter for `merchants.validators.ts`.
 */
import 'reflect-metadata';
import { IsCommissionRateConstraint } from '@/modules/merchants/dto/merchant-validators.decorators';

describe('IsCommissionRateConstraint', () => {
  const constraint = new IsCommissionRateConstraint();

  it('delegates to isCommissionRate', () => {
    expect(constraint.validate(12.34)).toBe(true);
    expect(constraint.validate(150)).toBe(false);
  });

  it('has a non-empty default message', () => {
    expect(constraint.defaultMessage()).toEqual(expect.any(String));
    expect(constraint.defaultMessage().length).toBeGreaterThan(0);
  });
});
