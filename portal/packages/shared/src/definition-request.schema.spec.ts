/**
 * T-042 — the `/definition-requests` wire contract. Same discipline `version.schema.spec.ts`/
 * `rule.schema.spec.ts` establish: every object is `.strict()`, so an unexpected key fails here
 * rather than shipping — and no `requestingCountryId`/`requestingTenantId` field exists on any
 * *request* schema (R3, TC-2), only on the entity/response schema.
 */
import {
  createDefinitionRequestSchema,
  definitionRequestEnvelopeSchema,
  definitionRequestListEnvelopeSchema,
  definitionRequestSchema,
  fulfilDefinitionRequestSchema,
  reviewDefinitionRequestSchema,
  updateDefinitionRequestSchema,
} from './definition-request.schema';

function validRequest() {
  return {
    id: 1,
    requestType: 'new_rule' as const,
    entityId: null,
    requestedBy: 1,
    requestingCountryId: 9,
    requestingTenantId: null,
    title: 'Weekend multiplier',
    description: 'We need a weekend multiplier rule.',
    businessJustification: null,
    desiredBy: null,
    priority: 'normal' as const,
    status: 'submitted' as const,
    reviewedBy: null,
    reviewedAt: null,
    reviewComment: null,
    fulfilledVersionId: null,
    fulfilledAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('definitionRequestSchema', () => {
  it('accepts a well-formed request', () => {
    expect(definitionRequestSchema.safeParse(validRequest()).success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(
      definitionRequestSchema.safeParse({ ...validRequest(), status: 'archived' }).success,
    ).toBe(false);
  });

  it('rejects an unknown requestType', () => {
    expect(
      definitionRequestSchema.safeParse({ ...validRequest(), requestType: 'delete_rule' }).success,
    ).toBe(false);
  });

  it('rejects an extra key — strict, so a leaked column fails the contract test', () => {
    const withExtraKey = { ...validRequest(), tenantId: 1 };
    expect(definitionRequestSchema.safeParse(withExtraKey).success).toBe(false);
  });

  it('accepts a fulfilled request with a version id and timestamps', () => {
    const fulfilled = {
      ...validRequest(),
      status: 'fulfilled' as const,
      fulfilledVersionId: 10,
      fulfilledAt: '2026-02-01T00:00:00.000Z',
      reviewedBy: 2,
      reviewedAt: '2026-01-15T00:00:00.000Z',
    };
    expect(definitionRequestSchema.safeParse(fulfilled).success).toBe(true);
  });
});

describe('definitionRequestEnvelopeSchema / definitionRequestListEnvelopeSchema', () => {
  it('wraps a single request under data', () => {
    expect(definitionRequestEnvelopeSchema.safeParse({ data: validRequest() }).success).toBe(true);
  });

  it('wraps a list under data + meta', () => {
    expect(
      definitionRequestListEnvelopeSchema.safeParse({
        data: [validRequest()],
        meta: { page: 1, pageSize: 20, total: 1 },
      }).success,
    ).toBe(true);
  });
});

describe('createDefinitionRequestSchema — TC-1…TC-5', () => {
  function validCreate() {
    return {
      requestType: 'new_rule' as const,
      title: 'Weekend multiplier',
      description: 'We need a weekend multiplier rule for this country.',
    };
  }

  it('accepts a well-formed new_rule request', () => {
    expect(createDefinitionRequestSchema.safeParse(validCreate()).success).toBe(true);
  });

  it('accepts an update_reward request with an entityId', () => {
    expect(
      createDefinitionRequestSchema.safeParse({
        ...validCreate(),
        requestType: 'update_reward',
        entityId: 7,
      }).success,
    ).toBe(true);
  });

  it('rejects a too-short title', () => {
    expect(createDefinitionRequestSchema.safeParse({ ...validCreate(), title: 'x' }).success).toBe(
      false,
    );
  });

  it('rejects a too-short description', () => {
    expect(
      createDefinitionRequestSchema.safeParse({ ...validCreate(), description: 'short' }).success,
    ).toBe(false);
  });

  it('rejects a malformed desiredBy', () => {
    expect(
      createDefinitionRequestSchema.safeParse({ ...validCreate(), desiredBy: '01-01-2026' })
        .success,
    ).toBe(false);
  });

  it('rejects requestingCountryId/requestingTenantId — no such field exists on the request schema (TC-2, R3)', () => {
    const withScope = { ...validCreate(), requestingCountryId: 9 };
    expect(createDefinitionRequestSchema.safeParse(withScope).success).toBe(false);
  });
});

describe('updateDefinitionRequestSchema — TC-6/TC-7', () => {
  it('accepts an empty body', () => {
    expect(updateDefinitionRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a partial update', () => {
    expect(
      updateDefinitionRequestSchema.safeParse({ title: 'A better title', priority: 'high' })
        .success,
    ).toBe(true);
  });

  it('rejects an unknown priority', () => {
    expect(updateDefinitionRequestSchema.safeParse({ priority: 'critical' }).success).toBe(false);
  });
});

describe('reviewDefinitionRequestSchema — TC-9…TC-12', () => {
  it('accepts status alone', () => {
    expect(reviewDefinitionRequestSchema.safeParse({ status: 'under_review' }).success).toBe(true);
  });

  it('accepts status with a reviewComment', () => {
    expect(
      reviewDefinitionRequestSchema.safeParse({ status: 'rejected', reviewComment: 'No.' }).success,
    ).toBe(true);
  });

  it('rejects "submitted"/"withdrawn"/"fulfilled" — not reachable via .../review', () => {
    for (const status of ['submitted', 'withdrawn', 'fulfilled']) {
      expect(reviewDefinitionRequestSchema.safeParse({ status }).success).toBe(false);
    }
  });
});

describe('fulfilDefinitionRequestSchema — TC-13/TC-14', () => {
  it('accepts a versionId', () => {
    expect(fulfilDefinitionRequestSchema.safeParse({ versionId: 10 }).success).toBe(true);
  });

  it('rejects a missing versionId', () => {
    expect(fulfilDefinitionRequestSchema.safeParse({}).success).toBe(false);
  });
});
