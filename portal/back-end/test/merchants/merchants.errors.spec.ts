/**
 * T-036 — the domain error classes and their HTTP status/code mapping (03-API-CONTRACT.md §1).
 */
import { ERROR_CODE } from '@/common/errors/app-error';
import {
  MERCHANT_ERROR_CODE,
  MerchantActivityAlreadyLinkedError,
  MerchantCodeExistsError,
  MerchantDeactivationRequiresConfirmationError,
  MerchantStoreCodeExistsError,
  merchantCountryMismatchError,
} from '@/modules/merchants/merchants.errors';

describe('merchants.errors', () => {
  it('MerchantCodeExistsError is 409 MERCHANT_CODE_EXISTS (TC-3)', () => {
    const error = new MerchantCodeExistsError();
    expect(error.status).toBe(409);
    expect(error.code).toBe(MERCHANT_ERROR_CODE.MERCHANT_CODE_EXISTS);
  });

  it('MerchantStoreCodeExistsError is 409 MERCHANT_STORE_CODE_EXISTS', () => {
    const error = new MerchantStoreCodeExistsError();
    expect(error.status).toBe(409);
    expect(error.code).toBe(MERCHANT_ERROR_CODE.MERCHANT_STORE_CODE_EXISTS);
  });

  it('MerchantActivityAlreadyLinkedError is 409 MERCHANT_ACTIVITY_ALREADY_LINKED (TC-15)', () => {
    const error = new MerchantActivityAlreadyLinkedError();
    expect(error.status).toBe(409);
    expect(error.code).toBe(MERCHANT_ERROR_CODE.MERCHANT_ACTIVITY_ALREADY_LINKED);
  });

  it('MerchantDeactivationRequiresConfirmationError is 422 with a confirm/REQUIRED detail (TC-20)', () => {
    const error = new MerchantDeactivationRequiresConfirmationError();
    expect(error.status).toBe(422);
    expect(error.code).toBe(MERCHANT_ERROR_CODE.MERCHANT_DEACTIVATION_REQUIRES_CONFIRMATION);
    expect(error.details).toEqual([{ field: 'confirm', code: 'REQUIRED' }]);
  });

  it('merchantCountryMismatchError() is 400 VALIDATION_FAILED with a countryCode detail (TC-5)', () => {
    const error = merchantCountryMismatchError();
    expect(error.status).toBe(400);
    expect(error.code).toBe(ERROR_CODE.VALIDATION_FAILED);
    expect(error.details).toEqual([
      { field: 'countryCode', code: MERCHANT_ERROR_CODE.MERCHANT_COUNTRY_MISMATCH },
    ]);
  });

  it('every code is UPPER_SNAKE_CASE — the shape ErrorNormalizationFilter requires to serialise it', () => {
    for (const code of Object.values(MERCHANT_ERROR_CODE)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]{1,59}$/);
    }
  });

  it('carries no internal detail in its own `message` beyond what AppError already logs server-side', () => {
    const error = new MerchantCodeExistsError();
    expect(error.message).not.toMatch(/uq_m_tenant_code/);
  });
});
