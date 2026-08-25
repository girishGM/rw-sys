/**
 * T-030 — the domain error classes and their HTTP status/code mapping (03-API-CONTRACT.md §1).
 */
import {
  AdminEmailExistsError,
  COUNTRY_ERROR_CODE,
  CountryCodeExistsError,
  CountryDeactivationRequiresConfirmationError,
  HqAlreadyExistsError,
} from '@/modules/countries/countries.errors';

describe('countries.errors', () => {
  it('CountryCodeExistsError is 409 COUNTRY_CODE_EXISTS (TC-2)', () => {
    const error = new CountryCodeExistsError();
    expect(error.status).toBe(409);
    expect(error.code).toBe(COUNTRY_ERROR_CODE.COUNTRY_CODE_EXISTS);
  });

  it('AdminEmailExistsError is 409 ADMIN_EMAIL_EXISTS', () => {
    const error = new AdminEmailExistsError();
    expect(error.status).toBe(409);
    expect(error.code).toBe(COUNTRY_ERROR_CODE.ADMIN_EMAIL_EXISTS);
  });

  it('HqAlreadyExistsError is 422 HQ_ALREADY_EXISTS (TC-5)', () => {
    const error = new HqAlreadyExistsError();
    expect(error.status).toBe(422);
    expect(error.code).toBe(COUNTRY_ERROR_CODE.HQ_ALREADY_EXISTS);
  });

  it('CountryDeactivationRequiresConfirmationError is 422 with a confirm/REQUIRED detail (TC-14)', () => {
    const error = new CountryDeactivationRequiresConfirmationError();
    expect(error.status).toBe(422);
    expect(error.code).toBe(COUNTRY_ERROR_CODE.COUNTRY_DEACTIVATION_REQUIRES_CONFIRMATION);
    expect(error.details).toEqual([{ field: 'confirm', code: 'REQUIRED' }]);
  });

  it('every code is UPPER_SNAKE_CASE — the shape ErrorNormalizationFilter requires to serialise it', () => {
    for (const code of Object.values(COUNTRY_ERROR_CODE)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]{1,59}$/);
    }
  });

  it('carries no internal detail in its own `message` beyond what AppError already logs server-side', () => {
    // AppError.message never reaches a client (see app-error.ts); this just proves the
    // constructor does not accidentally interpolate a constraint name into it.
    const error = new CountryCodeExistsError();
    expect(error.message).not.toMatch(/uq_countries_code/);
  });
});
