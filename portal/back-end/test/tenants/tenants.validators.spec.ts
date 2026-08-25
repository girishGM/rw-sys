/**
 * T-034 — `tenants.validators.ts`: `schemaPrefix` (implementation note 4) and the decimal-string
 * money helpers `tenant_budget_ceilings` needs.
 */
import {
  decimalStringLessThanOrEqual,
  isDecimalString,
  isPositiveDecimalString,
  isTenantSchemaPrefix,
} from '@/modules/tenants/tenants.validators';

describe('isTenantSchemaPrefix', () => {
  it('accepts a lowercase-letter-first identifier of 1-10 characters', () => {
    expect(isTenantSchemaPrefix('a')).toBe(true);
    expect(isTenantSchemaPrefix('abc123')).toBe(true);
    expect(isTenantSchemaPrefix('abc_def_1')).toBe(true);
    expect(isTenantSchemaPrefix('abcdefghij')).toBe(true); // exactly 10
  });

  it('rejects a digit-first, uppercase, over-length or non-string value', () => {
    expect(isTenantSchemaPrefix('1abc')).toBe(false);
    expect(isTenantSchemaPrefix('Abc')).toBe(false);
    expect(isTenantSchemaPrefix('abcdefghijk')).toBe(false); // 11 chars
    expect(isTenantSchemaPrefix('')).toBe(false);
    expect(isTenantSchemaPrefix('a-b')).toBe(false); // hyphen not allowed, unlike tenant code
    expect(isTenantSchemaPrefix(undefined)).toBe(false);
    expect(isTenantSchemaPrefix(null)).toBe(false);
    expect(isTenantSchemaPrefix(42)).toBe(false);
  });
});

describe('isDecimalString', () => {
  it('accepts a bare integer and a value with up to 4 fractional digits', () => {
    expect(isDecimalString('5')).toBe(true);
    expect(isDecimalString('5.0')).toBe(true);
    expect(isDecimalString('5.1234')).toBe(true);
    expect(isDecimalString('0.0001')).toBe(true);
    expect(isDecimalString('12345678901234')).toBe(true); // 14 integer digits
  });

  it('rejects a sign, too many fractional digits, too many integer digits and non-strings', () => {
    expect(isDecimalString('-5')).toBe(false);
    expect(isDecimalString('+5')).toBe(false);
    expect(isDecimalString('5.12345')).toBe(false);
    expect(isDecimalString('123456789012345')).toBe(false); // 15 integer digits
    expect(isDecimalString('abc')).toBe(false);
    expect(isDecimalString('')).toBe(false);
    expect(isDecimalString('5.')).toBe(false);
    expect(isDecimalString(5)).toBe(false);
    expect(isDecimalString(undefined)).toBe(false);
    expect(isDecimalString(null)).toBe(false);
  });
});

describe('isPositiveDecimalString', () => {
  it('accepts any well-formed value strictly greater than zero', () => {
    expect(isPositiveDecimalString('0.0001')).toBe(true);
    expect(isPositiveDecimalString('5000000')).toBe(true);
  });

  it('rejects zero (ck_tbc_positive) and anything isDecimalString already rejects', () => {
    expect(isPositiveDecimalString('0')).toBe(false);
    expect(isPositiveDecimalString('0.0000')).toBe(false);
    expect(isPositiveDecimalString('-5')).toBe(false);
    expect(isPositiveDecimalString('abc')).toBe(false);
  });
});

describe('decimalStringLessThanOrEqual', () => {
  it('compares values with a different number of fractional digits correctly', () => {
    expect(decimalStringLessThanOrEqual('5', '5.0000')).toBe(true);
    expect(decimalStringLessThanOrEqual('5.0001', '5')).toBe(false);
    expect(decimalStringLessThanOrEqual('4000000', '5000000')).toBe(true);
    expect(decimalStringLessThanOrEqual('5000000', '4000000')).toBe(false);
  });

  it('is exact — not susceptible to float rounding at the boundary', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; the fixed-point comparison must not inherit that.
    expect(decimalStringLessThanOrEqual('0.3000', '0.3')).toBe(true);
    expect(decimalStringLessThanOrEqual('99999999999999.9999', '99999999999999.9999')).toBe(true);
  });
});
