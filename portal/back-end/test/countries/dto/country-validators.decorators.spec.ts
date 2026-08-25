/**
 * T-030 — the `class-validator` constraint classes directly, so `defaultMessage()` (server-log
 * only — never serialised, see `app-error.ts`) is exercised without needing an HTTP round trip.
 */
import 'reflect-metadata';
import {
  IsIanaTimeZoneConstraint,
  IsIso3166Alpha2CountryCodeConstraint,
  IsIso4217CurrencyCodeConstraint,
} from '@/modules/countries/dto/country-validators.decorators';

describe('IsIso3166Alpha2CountryCodeConstraint', () => {
  const constraint = new IsIso3166Alpha2CountryCodeConstraint();

  it('delegates to isIso3166Alpha2CountryCode', () => {
    expect(constraint.validate('MY')).toBe(true);
    expect(constraint.validate('ZZ')).toBe(false);
  });

  it('carries a server-side message', () => {
    expect(constraint.defaultMessage()).toContain('ISO-3166-1');
  });
});

describe('IsIso4217CurrencyCodeConstraint', () => {
  const constraint = new IsIso4217CurrencyCodeConstraint();

  it('delegates to isIso4217CurrencyCode', () => {
    expect(constraint.validate('MYR')).toBe(true);
    expect(constraint.validate('ZZZ')).toBe(false);
  });

  it('carries a server-side message', () => {
    expect(constraint.defaultMessage()).toContain('ISO-4217');
  });
});

describe('IsIanaTimeZoneConstraint', () => {
  const constraint = new IsIanaTimeZoneConstraint();

  it('delegates to isIanaTimeZone', () => {
    expect(constraint.validate('UTC')).toBe(true);
    expect(constraint.validate('Nowhere/Nothing')).toBe(false);
  });

  it('carries a server-side message', () => {
    expect(constraint.defaultMessage()).toContain('IANA');
  });
});
