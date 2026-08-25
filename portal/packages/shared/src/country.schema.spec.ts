/**
 * T-030 — the `/countries` wire contract. Same discipline `bootstrap.schema.spec.ts` and
 * `trace.schema.spec.ts` establish: every object is `.strict()`, so an unexpected key (a hash, a
 * token, another user's data) fails here rather than shipping.
 */
import {
  countryAdminCreatedSchema,
  countryEnvelopeSchema,
  countryListEnvelopeSchema,
  countrySchema,
  countrySummarySchema,
  createCountryAdminRequestSchema,
  createCountryRequestSchema,
  createCountryResponseSchema,
  updateCountryRequestSchema,
} from './country.schema';

function validCountry() {
  return {
    id: 1,
    code: 'MY',
    name: 'Malaysia',
    timezone: 'Asia/Kuala_Lumpur',
    currencyCode: 'MYR',
    dialingCode: '+60',
    isHq: false,
    status: 'active' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('countrySchema', () => {
  it('accepts a well-formed country', () => {
    expect(countrySchema.safeParse(validCountry()).success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(countrySchema.safeParse({ ...validCountry(), status: 'deleted' }).success).toBe(false);
  });

  it('rejects an extra key — strict, so a leaked column fails the contract test (TC-16)', () => {
    expect(countrySchema.safeParse({ ...validCountry(), passwordHash: 'x' }).success).toBe(false);
  });

  it('rejects a code or currencyCode of the wrong length', () => {
    expect(countrySchema.safeParse({ ...validCountry(), code: 'MYS' }).success).toBe(false);
    expect(countrySchema.safeParse({ ...validCountry(), currencyCode: 'MY' }).success).toBe(false);
  });
});

describe('countryEnvelopeSchema / countryListEnvelopeSchema', () => {
  it('wraps a single country in {data}', () => {
    expect(countryEnvelopeSchema.safeParse({ data: validCountry() }).success).toBe(true);
  });

  it('wraps a list in {data, meta}', () => {
    expect(
      countryListEnvelopeSchema.safeParse({
        data: [validCountry()],
        meta: { page: 1, pageSize: 20, total: 1 },
      }).success,
    ).toBe(true);
  });

  it('rejects a list envelope with no meta', () => {
    expect(countryListEnvelopeSchema.safeParse({ data: [validCountry()] }).success).toBe(false);
  });
});

describe('createCountryRequestSchema', () => {
  it('accepts a body with no admin', () => {
    expect(
      createCountryRequestSchema.safeParse({
        code: 'MY',
        name: 'Malaysia',
        timezone: 'Asia/Kuala_Lumpur',
        currencyCode: 'MYR',
        dialingCode: '+60',
      }).success,
    ).toBe(true);
  });

  it('accepts a body with a nested admin', () => {
    expect(
      createCountryRequestSchema.safeParse({
        code: 'MY',
        name: 'Malaysia',
        timezone: 'Asia/Kuala_Lumpur',
        currencyCode: 'MYR',
        dialingCode: '+60',
        admin: { email: 'admin@example.invalid', displayName: 'Admin' },
      }).success,
    ).toBe(true);
  });

  it('rejects a client-supplied id (TC-17)', () => {
    expect(
      createCountryRequestSchema.safeParse({
        id: 999,
        code: 'MY',
        name: 'Malaysia',
        timezone: 'Asia/Kuala_Lumpur',
        currencyCode: 'MYR',
        dialingCode: '+60',
      }).success,
    ).toBe(false);
  });
});

describe('createCountryAdminRequestSchema', () => {
  it('accepts email + displayName only', () => {
    expect(
      createCountryAdminRequestSchema.safeParse({
        email: 'admin@example.invalid',
        displayName: 'Admin',
      }).success,
    ).toBe(true);
  });

  it('rejects a client-supplied password — the server always generates it (BACKLOG.md B-01)', () => {
    expect(
      createCountryAdminRequestSchema.safeParse({
        email: 'admin@example.invalid',
        displayName: 'Admin',
        password: 'whatever',
      }).success,
    ).toBe(false);
  });
});

describe('countryAdminCreatedSchema / createCountryResponseSchema', () => {
  it('accepts the one-time-shown credential response', () => {
    expect(
      countryAdminCreatedSchema.safeParse({
        id: 5,
        email: 'admin@example.invalid',
        displayName: 'Admin',
        role: 'country_admin',
        countryId: 1,
        temporaryPassword: 'Xy9!kLmnpQ2*Zvwr4Tabcd7',
      }).success,
    ).toBe(true);
  });

  it('rejects a role other than country_admin', () => {
    expect(
      countryAdminCreatedSchema.safeParse({
        id: 5,
        email: 'admin@example.invalid',
        displayName: 'Admin',
        role: 'super_admin',
        countryId: 1,
        temporaryPassword: 'x',
      }).success,
    ).toBe(false);
  });

  it('createCountryResponseSchema allows admin: null (no admin supplied at creation)', () => {
    expect(
      createCountryResponseSchema.safeParse({ country: validCountry(), admin: null }).success,
    ).toBe(true);
  });
});

describe('updateCountryRequestSchema', () => {
  it('accepts an empty body — every field optional', () => {
    expect(updateCountryRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts status + confirm (implementation note 7)', () => {
    expect(
      updateCountryRequestSchema.safeParse({ status: 'inactive', confirm: true }).success,
    ).toBe(true);
  });

  it('never accepts `code` — the business key is immutable', () => {
    expect(updateCountryRequestSchema.safeParse({ code: 'ZZ' }).success).toBe(false);
  });
});

describe('countrySummarySchema', () => {
  it('accepts the deactivation-warning tenant list', () => {
    expect(
      countrySummarySchema.safeParse({
        countryId: 1,
        tenantCount: 2,
        activeTenantCount: 1,
        campaignCount: 3,
        tenants: [{ id: 10, code: 'T001', name: 'A Tenant', status: 'active' }],
      }).success,
    ).toBe(true);
  });
});
