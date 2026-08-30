/**
 * T-121 — `field-value-source.schema.ts`. The assertions that matter here are the negative ones:
 * a response schema that *accepts* a credential field would let one leak without any test noticing.
 */
import {
  createFieldApiLookupProviderRequestSchema,
  createFieldContextProviderRequestSchema,
  fieldApiLookupProviderListEnvelopeSchema,
  fieldApiLookupProviderSchema,
  fieldContextProviderSchema,
  providerCodeSchema,
  updateFieldApiLookupProviderRequestSchema,
  updateFieldContextProviderRequestSchema,
} from './field-value-source.schema';

const validApiLookup = {
  id: 1,
  providerCode: 'PRODUCT_CATALOG',
  name: 'Product Catalog',
  description: null,
  endpointUrl: 'PLACEHOLDER',
  httpMethod: 'GET',
  authType: 'none',
  responseValueKey: 'productId',
  responseLabelKey: 'productName',
  status: 'planned',
};

describe('providerCodeSchema', () => {
  it('accepts upper snake case', () => {
    for (const code of ['SIBLING_COMPONENTS', 'PRODUCT_CATALOG', 'A1_B2']) {
      expect(providerCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it('rejects lower case, spaces, leading digits and over-long codes', () => {
    for (const code of ['product_catalog', 'PRODUCT CATALOG', '1_CATALOG', 'A'.repeat(51), 'A']) {
      expect(providerCodeSchema.safeParse(code).success).toBe(false);
    }
  });
});

describe('response schemas never carry a credential', () => {
  it('the API lookup response schema rejects an authConfig field (strict)', () => {
    expect(fieldApiLookupProviderSchema.safeParse(validApiLookup).success).toBe(true);

    // If someone widens the DTO to include the credential, this fails — which is the point.
    const leaked = { ...validApiLookup, authConfig: { apiKey: 'sk_live_leak' } };
    expect(fieldApiLookupProviderSchema.safeParse(leaked).success).toBe(false);

    const leakedEnc = { ...validApiLookup, authConfigEnc: 'v1.abc' };
    expect(fieldApiLookupProviderSchema.safeParse(leakedEnc).success).toBe(false);
  });

  it('the list envelope wraps the same strict shape', () => {
    expect(
      fieldApiLookupProviderListEnvelopeSchema.safeParse({ data: [validApiLookup] }).success,
    ).toBe(true);
    expect(
      fieldApiLookupProviderListEnvelopeSchema.safeParse({
        data: [{ ...validApiLookup, authConfig: {} }],
      }).success,
    ).toBe(false);
  });

  it('the context provider response schema is strict too', () => {
    const valid = {
      id: 1,
      providerCode: 'SIBLING_COMPONENTS',
      name: 'Siblings',
      description: null,
      status: 'active',
    };
    expect(fieldContextProviderSchema.safeParse(valid).success).toBe(true);
    expect(fieldContextProviderSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });
});

describe('request schemas', () => {
  it('a create request accepts an authConfig — writing a credential is allowed, reading it is not', () => {
    const parsed = createFieldApiLookupProviderRequestSchema.safeParse({
      providerCode: 'NEW_LOOKUP',
      name: 'New',
      endpointUrl: 'https://internal.invalid/x',
      authConfig: { apiKey: 'sk_live_x' },
      responseValueKey: 'id',
      responseLabelKey: 'label',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown auth type, http method and status', () => {
    const base = {
      providerCode: 'NEW_LOOKUP',
      name: 'New',
      endpointUrl: 'https://internal.invalid/x',
      responseValueKey: 'id',
      responseLabelKey: 'label',
    };
    expect(
      createFieldApiLookupProviderRequestSchema.safeParse({ ...base, authType: 'oauth' }).success,
    ).toBe(false);
    expect(
      createFieldApiLookupProviderRequestSchema.safeParse({ ...base, httpMethod: 'DELETE' })
        .success,
    ).toBe(false);
    expect(
      createFieldApiLookupProviderRequestSchema.safeParse({ ...base, status: 'enabled' }).success,
    ).toBe(false);
  });

  it('update schemas never accept providerCode — it is immutable', () => {
    expect(
      updateFieldApiLookupProviderRequestSchema.safeParse({ providerCode: 'RENAMED' }).success,
    ).toBe(false);
    expect(
      updateFieldContextProviderRequestSchema.safeParse({ providerCode: 'RENAMED' }).success,
    ).toBe(false);
  });

  it('a context provider create request does not accept a status — new ones are always active', () => {
    expect(
      createFieldContextProviderRequestSchema.safeParse({
        providerCode: 'NEW_SOURCE',
        name: 'n',
        status: 'inactive',
      }).success,
    ).toBe(false);
  });
});
