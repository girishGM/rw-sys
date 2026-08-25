/**
 * T-034 — the `/tenants` wire contract. Same discipline `country.schema.spec.ts` establishes:
 * every object is `.strict()`, so an unexpected key fails here rather than shipping.
 */
import {
  budgetCeilingListEnvelopeSchema,
  budgetCeilingSchema,
  createTenantAdminRequestSchema,
  createTenantRequestSchema,
  createTenantResponseSchema,
  tenantAdminCreatedSchema,
  tenantEnvelopeSchema,
  tenantListEnvelopeSchema,
  tenantSchema,
  tenantWithoutCeilingListEnvelopeSchema,
  updateTenantRequestSchema,
  upsertBudgetCeilingRequestSchema,
} from './tenant.schema';

function validTenant() {
  return {
    id: 10,
    code: 'T001',
    name: 'Acme Retail',
    countryId: 1,
    schemaPrefix: null,
    contactEmail: null,
    contactPhone: null,
    status: 'pending_provisioning' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('tenantSchema', () => {
  it('accepts a well-formed tenant', () => {
    expect(tenantSchema.safeParse(validTenant()).success).toBe(true);
  });

  it('accepts every populated optional field', () => {
    expect(
      tenantSchema.safeParse({
        ...validTenant(),
        schemaPrefix: 'acme',
        contactEmail: 'ops@acme.example',
        contactPhone: '+60123456789',
        status: 'active',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(tenantSchema.safeParse({ ...validTenant(), status: 'deleted' }).success).toBe(false);
  });

  it('rejects an extra key — strict, so a leaked column fails the contract test', () => {
    expect(tenantSchema.safeParse({ ...validTenant(), schemaVersion: 3 }).success).toBe(false);
  });
});

describe('tenantEnvelopeSchema / tenantListEnvelopeSchema', () => {
  it('wraps a single tenant in {data}', () => {
    expect(tenantEnvelopeSchema.safeParse({ data: validTenant() }).success).toBe(true);
  });

  it('wraps a list in {data, meta}', () => {
    expect(
      tenantListEnvelopeSchema.safeParse({
        data: [validTenant()],
        meta: { page: 1, pageSize: 20, total: 1 },
      }).success,
    ).toBe(true);
  });

  it('rejects a list envelope with no meta', () => {
    expect(tenantListEnvelopeSchema.safeParse({ data: [validTenant()] }).success).toBe(false);
  });
});

describe('createTenantRequestSchema', () => {
  it('accepts a body with only the required fields — no countryId (implementation note 2)', () => {
    expect(createTenantRequestSchema.safeParse({ code: 'T001', name: 'Acme Retail' }).success).toBe(
      true,
    );
  });

  it('rejects a client-supplied countryId (AGENT-PROTOCOL R3)', () => {
    expect(
      createTenantRequestSchema.safeParse({ code: 'T001', name: 'Acme Retail', countryId: 999 })
        .success,
    ).toBe(false);
  });

  it('accepts a body with a nested admin', () => {
    expect(
      createTenantRequestSchema.safeParse({
        code: 'T001',
        name: 'Acme Retail',
        admin: { email: 'admin@example.invalid', displayName: 'Admin' },
      }).success,
    ).toBe(true);
  });
});

describe('createTenantAdminRequestSchema', () => {
  it('accepts email + displayName only', () => {
    expect(
      createTenantAdminRequestSchema.safeParse({
        email: 'admin@example.invalid',
        displayName: 'Admin',
      }).success,
    ).toBe(true);
  });

  it('rejects a client-supplied password — the server always generates it (BACKLOG.md B-01)', () => {
    expect(
      createTenantAdminRequestSchema.safeParse({
        email: 'admin@example.invalid',
        displayName: 'Admin',
        password: 'whatever',
      }).success,
    ).toBe(false);
  });
});

describe('tenantAdminCreatedSchema / createTenantResponseSchema', () => {
  it('accepts the one-time-shown credential response', () => {
    expect(
      tenantAdminCreatedSchema.safeParse({
        id: 5,
        email: 'admin@example.invalid',
        displayName: 'Admin',
        role: 'tenant_admin',
        tenantId: 10,
        temporaryPassword: 'Xy9!kLmnpQ2*Zvwr4Tabcd7',
      }).success,
    ).toBe(true);
  });

  it('rejects a role other than tenant_admin', () => {
    expect(
      tenantAdminCreatedSchema.safeParse({
        id: 5,
        email: 'admin@example.invalid',
        displayName: 'Admin',
        role: 'country_admin',
        tenantId: 10,
        temporaryPassword: 'x',
      }).success,
    ).toBe(false);
  });

  it('createTenantResponseSchema allows admin: null (no admin supplied at creation)', () => {
    expect(
      createTenantResponseSchema.safeParse({ tenant: validTenant(), admin: null }).success,
    ).toBe(true);
  });
});

describe('updateTenantRequestSchema', () => {
  it('accepts an empty body — every field optional', () => {
    expect(updateTenantRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts every ck_tenants_status value', () => {
    for (const status of ['pending_provisioning', 'active', 'inactive', 'suspended']) {
      expect(updateTenantRequestSchema.safeParse({ status }).success).toBe(true);
    }
  });

  it('never accepts `code` or `countryId` — immutable / scope-derived only', () => {
    expect(updateTenantRequestSchema.safeParse({ code: 'ZZZ' }).success).toBe(false);
    expect(updateTenantRequestSchema.safeParse({ countryId: 999 }).success).toBe(false);
  });
});

describe('tenantWithoutCeilingListEnvelopeSchema (implementation note 7, TC-28)', () => {
  it('accepts the dashboard widget list', () => {
    expect(
      tenantWithoutCeilingListEnvelopeSchema.safeParse({
        data: [{ id: 10, code: 'T001', name: 'Acme Retail', countryId: 1 }],
      }).success,
    ).toBe(true);
  });
});

describe('budgetCeilingSchema / budgetCeilingListEnvelopeSchema', () => {
  function validCeiling() {
    return {
      id: 1,
      tenantId: 10,
      unitType: 'currency' as const,
      unitCode: 'MYR',
      maxCampaignBudget: '5000000.0000',
      warnAboveAmount: '4000000.0000',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('accepts a well-formed ceiling, money as strings (never a float)', () => {
    const parsed = budgetCeilingSchema.safeParse(validCeiling());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(typeof parsed.data.maxCampaignBudget).toBe('string');
    }
  });

  it('accepts a null warnAboveAmount', () => {
    expect(
      budgetCeilingSchema.safeParse({ ...validCeiling(), warnAboveAmount: null }).success,
    ).toBe(true);
  });

  it('rejects an unknown unitType', () => {
    expect(budgetCeilingSchema.safeParse({ ...validCeiling(), unitType: 'crypto' }).success).toBe(
      false,
    );
  });

  it('wraps a list in {data}', () => {
    expect(budgetCeilingListEnvelopeSchema.safeParse({ data: [validCeiling()] }).success).toBe(
      true,
    );
  });
});

describe('upsertBudgetCeilingRequestSchema (TC-21/TC-22/TC-27)', () => {
  it('accepts a valid body without warnAboveAmount', () => {
    expect(
      upsertBudgetCeilingRequestSchema.safeParse({
        unitType: 'currency',
        unitCode: 'MYR',
        maxCampaignBudget: '5000000',
      }).success,
    ).toBe(true);
  });

  it('accepts a valid body with warnAboveAmount', () => {
    expect(
      upsertBudgetCeilingRequestSchema.safeParse({
        unitType: 'currency',
        unitCode: 'MYR',
        maxCampaignBudget: '5000000',
        warnAboveAmount: '4000000',
      }).success,
    ).toBe(true);
  });

  it('rejects a maxCampaignBudget supplied as a number rather than a string', () => {
    expect(
      upsertBudgetCeilingRequestSchema.safeParse({
        unitType: 'currency',
        unitCode: 'MYR',
        maxCampaignBudget: 5000000,
      }).success,
    ).toBe(false);
  });
});
