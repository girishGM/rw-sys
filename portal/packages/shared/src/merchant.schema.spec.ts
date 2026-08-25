/**
 * T-036 — the `/merchants` wire contract. Same discipline `tenant.schema.spec.ts` establishes:
 * every object is `.strict()`, so an unexpected key fails here rather than shipping.
 */
import {
  createMerchantActivityRequestSchema,
  createMerchantRequestSchema,
  createMerchantStoreRequestSchema,
  merchantActiveCampaignListEnvelopeSchema,
  merchantActivityEnvelopeSchema,
  merchantActivityListEnvelopeSchema,
  merchantActivitySchema,
  merchantEnvelopeSchema,
  merchantListEnvelopeSchema,
  merchantSchema,
  merchantStoreEnvelopeSchema,
  merchantStoreListEnvelopeSchema,
  merchantStoreSchema,
  updateMerchantRequestSchema,
} from './merchant.schema';

function validMerchant() {
  return {
    id: 100,
    tenantId: 10,
    merchantCode: 'M001',
    name: 'Acme Store',
    description: null,
    contactEmail: null,
    contactPhone: null,
    website: null,
    countryCode: 'MY',
    status: 'active' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function validStore() {
  return {
    id: 200,
    tenantId: 10,
    merchantId: 100,
    storeCode: 'S001',
    name: 'Main Store',
    address: null,
    city: null,
    state: null,
    postalCode: null,
    region: null,
    latitude: null,
    longitude: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function validActivity() {
  return {
    id: 300,
    tenantId: 10,
    merchantId: 100,
    activityId: 50,
    storeId: null,
    commissionRate: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('merchantSchema', () => {
  it('accepts a well-formed merchant', () => {
    expect(merchantSchema.safeParse(validMerchant()).success).toBe(true);
  });

  it('accepts every populated optional field', () => {
    expect(
      merchantSchema.safeParse({
        ...validMerchant(),
        description: 'A great merchant',
        contactEmail: 'ops@acme.example',
        contactPhone: '+60123456789',
        website: 'https://acme.example',
        status: 'suspended',
      }).success,
    ).toBe(true);
  });

  it('rejects an unexpected key', () => {
    expect(merchantSchema.safeParse({ ...validMerchant(), tenantCode: 'X' }).success).toBe(false);
  });

  it('rejects an invalid status', () => {
    expect(merchantSchema.safeParse({ ...validMerchant(), status: 'deleted' }).success).toBe(false);
  });

  it('rejects a missing required field', () => {
    const rest: Record<string, unknown> = { ...validMerchant() };
    delete rest.merchantCode;
    expect(merchantSchema.safeParse(rest).success).toBe(false);
  });
});

describe('merchantEnvelopeSchema / merchantListEnvelopeSchema', () => {
  it('accepts a single-merchant envelope', () => {
    expect(merchantEnvelopeSchema.safeParse({ data: validMerchant() }).success).toBe(true);
  });

  it('accepts a list envelope with meta', () => {
    expect(
      merchantListEnvelopeSchema.safeParse({
        data: [validMerchant()],
        meta: { page: 1, pageSize: 20, total: 1 },
      }).success,
    ).toBe(true);
  });

  it('rejects a list envelope missing meta', () => {
    expect(merchantListEnvelopeSchema.safeParse({ data: [validMerchant()] }).success).toBe(false);
  });
});

describe('createMerchantRequestSchema', () => {
  it('accepts the minimum required fields', () => {
    expect(
      createMerchantRequestSchema.safeParse({
        merchantCode: 'M001',
        name: 'Acme Store',
        countryCode: 'MY',
      }).success,
    ).toBe(true);
  });

  it('has no tenantId field — AGENT-PROTOCOL R3', () => {
    const result = createMerchantRequestSchema.safeParse({
      merchantCode: 'M001',
      name: 'Acme Store',
      countryCode: 'MY',
      tenantId: 999,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a countryCode that is not exactly 2 characters', () => {
    expect(
      createMerchantRequestSchema.safeParse({
        merchantCode: 'M001',
        name: 'Acme Store',
        countryCode: 'MYS',
      }).success,
    ).toBe(false);
  });
});

describe('updateMerchantRequestSchema', () => {
  it('accepts an empty body', () => {
    expect(updateMerchantRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts status and confirm together (TC-20)', () => {
    expect(
      updateMerchantRequestSchema.safeParse({ status: 'inactive', confirm: true }).success,
    ).toBe(true);
  });

  it('has no merchantCode/countryCode field', () => {
    expect(updateMerchantRequestSchema.safeParse({ merchantCode: 'X' }).success).toBe(false);
    expect(updateMerchantRequestSchema.safeParse({ countryCode: 'MY' }).success).toBe(false);
  });
});

describe('merchantStoreSchema / envelopes', () => {
  it('accepts a well-formed store', () => {
    expect(merchantStoreSchema.safeParse(validStore()).success).toBe(true);
  });

  it('accepts a store with populated coordinates as decimal strings', () => {
    expect(
      merchantStoreSchema.safeParse({
        ...validStore(),
        latitude: '3.1390000',
        longitude: '101.6869000',
      }).success,
    ).toBe(true);
  });

  it('rejects a numeric latitude — decimal columns are strings on the wire', () => {
    expect(merchantStoreSchema.safeParse({ ...validStore(), latitude: 3.139 }).success).toBe(false);
  });

  it('accepts single-store and list envelopes', () => {
    expect(merchantStoreEnvelopeSchema.safeParse({ data: validStore() }).success).toBe(true);
    expect(merchantStoreListEnvelopeSchema.safeParse({ data: [validStore()] }).success).toBe(true);
  });
});

describe('createMerchantStoreRequestSchema', () => {
  it('accepts the minimum required fields', () => {
    expect(
      createMerchantStoreRequestSchema.safeParse({ storeCode: 'S001', name: 'Main Store' }).success,
    ).toBe(true);
  });

  it('accepts latitude/longitude as numbers within range', () => {
    expect(
      createMerchantStoreRequestSchema.safeParse({
        storeCode: 'S001',
        name: 'Main Store',
        latitude: 3.139,
        longitude: 101.6869,
      }).success,
    ).toBe(true);
  });

  it('rejects out-of-range latitude/longitude', () => {
    expect(
      createMerchantStoreRequestSchema.safeParse({
        storeCode: 'S001',
        name: 'Main Store',
        latitude: 90.1,
      }).success,
    ).toBe(false);
  });
});

describe('merchantActivitySchema / envelopes', () => {
  it('accepts a well-formed activity link', () => {
    expect(merchantActivitySchema.safeParse(validActivity()).success).toBe(true);
  });

  it('accepts a populated storeId and commissionRate', () => {
    expect(
      merchantActivitySchema.safeParse({
        ...validActivity(),
        storeId: 200,
        commissionRate: '12.34',
      }).success,
    ).toBe(true);
  });

  it('accepts single-activity and list envelopes', () => {
    expect(merchantActivityEnvelopeSchema.safeParse({ data: validActivity() }).success).toBe(true);
    expect(merchantActivityListEnvelopeSchema.safeParse({ data: [validActivity()] }).success).toBe(
      true,
    );
  });
});

describe('createMerchantActivityRequestSchema', () => {
  it('accepts activityId alone — a tenant-wide link (TC-14)', () => {
    expect(createMerchantActivityRequestSchema.safeParse({ activityId: 50 }).success).toBe(true);
  });

  it('accepts activityId with storeId and commissionRate', () => {
    expect(
      createMerchantActivityRequestSchema.safeParse({
        activityId: 50,
        storeId: 7,
        commissionRate: 12.34,
      }).success,
    ).toBe(true);
  });

  it('rejects a commissionRate above 100 (TC-17)', () => {
    expect(
      createMerchantActivityRequestSchema.safeParse({ activityId: 50, commissionRate: 150 })
        .success,
    ).toBe(false);
  });
});

describe('merchantActiveCampaignListEnvelopeSchema', () => {
  it('accepts an empty and a populated list', () => {
    expect(merchantActiveCampaignListEnvelopeSchema.safeParse({ data: [] }).success).toBe(true);
    expect(
      merchantActiveCampaignListEnvelopeSchema.safeParse({
        data: [{ id: 900, campaignCode: 'C900', name: 'Campaign 900', status: 'active' }],
      }).success,
    ).toBe(true);
  });
});
