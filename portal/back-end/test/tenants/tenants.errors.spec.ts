/**
 * T-034 — the domain error classes and their HTTP status/code mapping (03-API-CONTRACT.md §1).
 */
import {
  TENANT_ERROR_CODE,
  TenantAdminEmailExistsError,
  TenantAlreadyActiveError,
  TenantCodeExistsError,
  TenantNotActiveError,
  TenantSchemaPrefixExistsError,
} from '@/modules/tenants/tenants.errors';

describe('tenants.errors', () => {
  it('TenantCodeExistsError is 409 TENANT_CODE_EXISTS (TC-10)', () => {
    const error = new TenantCodeExistsError();
    expect(error.status).toBe(409);
    expect(error.code).toBe(TENANT_ERROR_CODE.TENANT_CODE_EXISTS);
  });

  it('TenantSchemaPrefixExistsError is 409 TENANT_SCHEMA_PREFIX_EXISTS (TC-11)', () => {
    const error = new TenantSchemaPrefixExistsError();
    expect(error.status).toBe(409);
    expect(error.code).toBe(TENANT_ERROR_CODE.TENANT_SCHEMA_PREFIX_EXISTS);
  });

  it('TenantAdminEmailExistsError is 409 TENANT_ADMIN_EMAIL_EXISTS', () => {
    const error = new TenantAdminEmailExistsError();
    expect(error.status).toBe(409);
    expect(error.code).toBe(TENANT_ERROR_CODE.TENANT_ADMIN_EMAIL_EXISTS);
  });

  it('TenantAlreadyActiveError is 409 TENANT_ALREADY_ACTIVE (TC-16)', () => {
    const error = new TenantAlreadyActiveError();
    expect(error.status).toBe(409);
    expect(error.code).toBe(TENANT_ERROR_CODE.TENANT_ALREADY_ACTIVE);
  });

  it('TenantNotActiveError is 422 TENANT_NOT_ACTIVE (TC-17)', () => {
    const error = new TenantNotActiveError();
    expect(error.status).toBe(422);
    expect(error.code).toBe(TENANT_ERROR_CODE.TENANT_NOT_ACTIVE);
  });

  it('every code is UPPER_SNAKE_CASE — the shape ErrorNormalizationFilter requires to serialise it', () => {
    for (const code of Object.values(TENANT_ERROR_CODE)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]{1,59}$/);
    }
  });

  it('carries no internal detail in its own `message` beyond what AppError already logs server-side', () => {
    const error = new TenantCodeExistsError();
    expect(error.message).not.toMatch(/uq_tenants_code/);
  });
});
