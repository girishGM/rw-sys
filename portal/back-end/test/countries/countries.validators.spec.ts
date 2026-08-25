/**
 * T-030 — `countries.validators.ts`: ISO-3166-1 alpha-2, ISO-4217 and IANA time zone checks,
 * all built on `Intl.supportedValuesOf` rather than a hand-maintained list (see the file's own
 * header for why).
 */
import {
  isIanaTimeZone,
  isIso3166Alpha2CountryCode,
  isIso4217CurrencyCode,
} from '@/modules/countries/countries.validators';

describe('isIso3166Alpha2CountryCode', () => {
  it('accepts real country codes, case-insensitively', () => {
    expect(isIso3166Alpha2CountryCode('MY')).toBe(true);
    expect(isIso3166Alpha2CountryCode('my')).toBe(true);
    expect(isIso3166Alpha2CountryCode('Us')).toBe(true);
    expect(isIso3166Alpha2CountryCode('GB')).toBe(true);
    expect(isIso3166Alpha2CountryCode('IN')).toBe(true);
  });

  it('rejects an invented code, the wrong length, and non-strings', () => {
    expect(isIso3166Alpha2CountryCode('XYZ')).toBe(false);
    expect(isIso3166Alpha2CountryCode('ZZ')).toBe(false);
    expect(isIso3166Alpha2CountryCode('M')).toBe(false);
    expect(isIso3166Alpha2CountryCode('')).toBe(false);
    expect(isIso3166Alpha2CountryCode(undefined)).toBe(false);
    expect(isIso3166Alpha2CountryCode(null)).toBe(false);
    expect(isIso3166Alpha2CountryCode(42)).toBe(false);
  });

  it('rejects a 3-digit UN M49 area code — not a country code at all', () => {
    expect(isIso3166Alpha2CountryCode('419')).toBe(false);
  });
});

describe('isIso4217CurrencyCode', () => {
  it('accepts real currency codes, case-insensitively', () => {
    expect(isIso4217CurrencyCode('MYR')).toBe(true);
    expect(isIso4217CurrencyCode('myr')).toBe(true);
    expect(isIso4217CurrencyCode('USD')).toBe(true);
    expect(isIso4217CurrencyCode('EUR')).toBe(true);
    expect(isIso4217CurrencyCode('INR')).toBe(true);
  });

  it('rejects an invented code, the wrong length, and non-strings', () => {
    expect(isIso4217CurrencyCode('XYZ')).toBe(false);
    expect(isIso4217CurrencyCode('US')).toBe(false);
    expect(isIso4217CurrencyCode('')).toBe(false);
    expect(isIso4217CurrencyCode(undefined)).toBe(false);
    expect(isIso4217CurrencyCode(null)).toBe(false);
    expect(isIso4217CurrencyCode(42)).toBe(false);
  });
});

describe('isIanaTimeZone', () => {
  it('accepts real zones, including UTC', () => {
    for (const zone of ['UTC', 'Asia/Kuala_Lumpur', 'Europe/Paris', 'America/New_York']) {
      expect(isIanaTimeZone(zone)).toBe(true);
    }
  });

  it('rejects an unknown zone, an empty string and a non-string', () => {
    expect(isIanaTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isIanaTimeZone('')).toBe(false);
    expect(isIanaTimeZone(undefined)).toBe(false);
    expect(isIanaTimeZone(null)).toBe(false);
    expect(isIanaTimeZone(42)).toBe(false);
  });
});
