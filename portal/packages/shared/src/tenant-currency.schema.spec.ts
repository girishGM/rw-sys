/**
 * T-126 — the `/tenants/:id/currencies` wire contract. Same discipline `tenant.schema.spec.ts`
 * establishes: every object is `.strict()`, so an unexpected key fails here rather than shipping.
 */
import {
  createTenantCurrencyRequestSchema,
  tenantCurrencyEnvelopeSchema,
  tenantCurrencyListEnvelopeSchema,
  tenantCurrencySchema,
  updateTenantCurrencyRequestSchema,
} from './tenant-currency.schema';

function validCurrency() {
  return {
    id: 1,
    tenantId: 10,
    currencyCode: 'MYR',
    isDefault: true,
    status: 'active' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('tenantCurrencySchema', () => {
  it('accepts a well-formed currency row', () => {
    expect(tenantCurrencySchema.safeParse(validCurrency()).success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(tenantCurrencySchema.safeParse({ ...validCurrency(), status: 'retired' }).success).toBe(
      false,
    );
  });

  it('rejects a currencyCode that is not exactly 3 characters', () => {
    expect(tenantCurrencySchema.safeParse({ ...validCurrency(), currencyCode: 'MY' }).success).toBe(
      false,
    );
  });

  it('rejects an extra key — strict, so a leaked column fails the contract test', () => {
    expect(tenantCurrencySchema.safeParse({ ...validCurrency(), countryCode: 'MY' }).success).toBe(
      false,
    );
  });
});

describe('tenantCurrencyEnvelopeSchema / tenantCurrencyListEnvelopeSchema', () => {
  it('wraps a single currency in {data}', () => {
    expect(tenantCurrencyEnvelopeSchema.safeParse({ data: validCurrency() }).success).toBe(true);
  });

  it('wraps a list in {data} — no meta/pagination for this endpoint', () => {
    expect(tenantCurrencyListEnvelopeSchema.safeParse({ data: [validCurrency()] }).success).toBe(
      true,
    );
  });
});

describe('createTenantCurrencyRequestSchema', () => {
  it('accepts a body with only the required field', () => {
    expect(createTenantCurrencyRequestSchema.safeParse({ currencyCode: 'SGD' }).success).toBe(true);
  });

  it('accepts isDefault explicitly set', () => {
    expect(
      createTenantCurrencyRequestSchema.safeParse({ currencyCode: 'SGD', isDefault: true }).success,
    ).toBe(true);
  });

  it('rejects a client-supplied tenantId — always the route param, never the body', () => {
    expect(
      createTenantCurrencyRequestSchema.safeParse({ currencyCode: 'SGD', tenantId: 999 }).success,
    ).toBe(false);
  });
});

describe('updateTenantCurrencyRequestSchema', () => {
  it('accepts an empty body — every field optional', () => {
    expect(updateTenantCurrencyRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts every ck_tc_status value', () => {
    for (const status of ['active', 'inactive']) {
      expect(updateTenantCurrencyRequestSchema.safeParse({ status }).success).toBe(true);
    }
  });

  it('never accepts currencyCode — immutable once created', () => {
    expect(updateTenantCurrencyRequestSchema.safeParse({ currencyCode: 'SGD' }).success).toBe(
      false,
    );
  });
});
