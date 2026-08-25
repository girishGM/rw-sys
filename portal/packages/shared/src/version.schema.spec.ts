/**
 * T-041 — the `/rules/:id/versions`, `/rewards/:id/versions` and `/blasts` wire contract.
 * Same discipline `rule.schema.spec.ts`/`country.schema.spec.ts` establish: every object is
 * `.strict()`, so an unexpected key fails here rather than shipping.
 *
 * `refineScopeCountryIds` — the `.superRefine` shared by `previewBlastRequestSchema` and
 * `createBlastRequestSchema` — gets the most attention here: it is the one piece of real
 * logic in this file (everything else is shape), and it is what stops a blast being sent to
 * zero countries or to a `countryIds` list that contradicts `scope`.
 */
import {
  assignedVersionSchema,
  blastEnvelopeSchema,
  blastListEnvelopeSchema,
  blastPreviewEnvelopeSchema,
  blastPreviewResponseSchema,
  blastSchema,
  blastTargetSchema,
  createBlastRequestSchema,
  createVersionRequestSchema,
  previewBlastRequestSchema,
  rewardVersionEnvelopeSchema,
  rewardVersionSchema,
  ruleVersionEnvelopeSchema,
  ruleVersionListEnvelopeSchema,
  ruleVersionSchema,
  updateRewardVersionRequestSchema,
  updateRuleVersionRequestSchema,
  versionCountryAssignmentSchema,
  versionDiffSchema,
} from './version.schema';

function validRuleVersion() {
  return {
    id: 10,
    ruleId: 1,
    versionNo: 2,
    expression: 'amount >= :minSpend',
    parameters: { fields: [] },
    changeSummary: null,
    isBreaking: false,
    status: 'published' as const,
    supersedesVersionId: 9,
    originRequestId: null,
    createdBy: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    publishedBy: 1,
    publishedAt: '2026-01-01T00:00:00.000Z',
    deprecatedAt: null,
    retiredAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    suggestedIsBreaking: null,
  };
}

function validRewardVersion() {
  return {
    id: 20,
    rewardId: 1,
    versionNo: 1,
    connectorConfig: {},
    deliveryMode: null,
    retryConfig: {},
    policiesSnapshot: null,
    unitType: null,
    unitCode: null,
    changeSummary: null,
    isBreaking: false,
    status: 'draft' as const,
    supersedesVersionId: null,
    originRequestId: null,
    createdBy: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    publishedBy: null,
    publishedAt: null,
    deprecatedAt: null,
    retiredAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    suggestedIsBreaking: null,
  };
}

describe('ruleVersionSchema', () => {
  it('accepts a well-formed version', () => {
    expect(ruleVersionSchema.safeParse(validRuleVersion()).success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(ruleVersionSchema.safeParse({ ...validRuleVersion(), status: 'archived' }).success).toBe(
      false,
    );
  });

  it('rejects an extra key — strict, so a leaked column fails the contract test', () => {
    const withExtraKey = { ...validRuleVersion(), tenantId: 1 };
    expect(ruleVersionSchema.safeParse(withExtraKey).success).toBe(false);
  });

  it('accepts a null expression (a draft with nothing typed yet)', () => {
    expect(ruleVersionSchema.safeParse({ ...validRuleVersion(), expression: null }).success).toBe(
      true,
    );
  });
});

describe('rewardVersionSchema', () => {
  it('accepts a well-formed version', () => {
    expect(rewardVersionSchema.safeParse(validRewardVersion()).success).toBe(true);
  });

  it('accepts a populated connector/retry config and unit fields', () => {
    expect(
      rewardVersionSchema.safeParse({
        ...validRewardVersion(),
        connectorConfig: { provider: 'wallet-x' },
        deliveryMode: 'instant',
        retryConfig: { maxAttempts: 3 },
        unitType: 'points',
        unitCode: 'PTS',
      }).success,
    ).toBe(true);
  });

  it('rejects an extra key — strict', () => {
    expect(rewardVersionSchema.safeParse({ ...validRewardVersion(), secret: 'x' }).success).toBe(
      false,
    );
  });
});

describe('envelope schemas', () => {
  it('ruleVersionEnvelopeSchema wraps a single version in {data}', () => {
    expect(ruleVersionEnvelopeSchema.safeParse({ data: validRuleVersion() }).success).toBe(true);
  });

  it('ruleVersionListEnvelopeSchema wraps a list in {data}', () => {
    expect(ruleVersionListEnvelopeSchema.safeParse({ data: [validRuleVersion()] }).success).toBe(
      true,
    );
  });

  it('rewardVersionEnvelopeSchema wraps a single version in {data}', () => {
    expect(rewardVersionEnvelopeSchema.safeParse({ data: validRewardVersion() }).success).toBe(
      true,
    );
  });
});

describe('createVersionRequestSchema', () => {
  it('accepts an empty body — draft clones the latest published version (implementation note 2)', () => {
    expect(createVersionRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts an optional changeSummary and originRequestId', () => {
    expect(
      createVersionRequestSchema.safeParse({ changeSummary: 'Adds a tier', originRequestId: 5 })
        .success,
    ).toBe(true);
  });

  it('rejects a client-supplied field that is not part of the contract (R3)', () => {
    expect(createVersionRequestSchema.safeParse({ status: 'published' }).success).toBe(false);
  });
});

describe('updateRuleVersionRequestSchema — draft-only edits', () => {
  it('accepts an empty body — every field optional', () => {
    expect(updateRuleVersionRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts expression/parameters/changeSummary edits', () => {
    expect(
      updateRuleVersionRequestSchema.safeParse({
        expression: 'amount >= :minSpend AND tier = :tier',
        parameters: { fields: [] },
        changeSummary: 'Adds a tier condition',
      }).success,
    ).toBe(true);
  });

  it('accepts isBreaking with the required confirmBreakingOverride', () => {
    expect(
      updateRuleVersionRequestSchema.safeParse({
        isBreaking: true,
        confirmBreakingOverride: true,
      }).success,
    ).toBe(true);
  });

  it('has no status key — publish/deprecate/retire are separate acts, not a PATCH field', () => {
    expect(updateRuleVersionRequestSchema.safeParse({ status: 'published' }).success).toBe(false);
  });

  it('rejects an expression over 8000 characters', () => {
    const tooLong = { expression: 'a'.repeat(8001) };
    expect(updateRuleVersionRequestSchema.safeParse(tooLong).success).toBe(false);
  });
});

describe('updateRewardVersionRequestSchema — draft-only edits', () => {
  it('accepts an empty body', () => {
    expect(updateRewardVersionRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts connectorConfig/deliveryMode/retryConfig/unit edits', () => {
    expect(
      updateRewardVersionRequestSchema.safeParse({
        connectorConfig: { provider: 'wallet-x' },
        deliveryMode: 'instant',
        retryConfig: { maxAttempts: 3 },
        unitType: 'currency',
        unitCode: 'MYR',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown unitType', () => {
    expect(updateRewardVersionRequestSchema.safeParse({ unitType: 'gems' }).success).toBe(false);
  });

  it('rejects a unitCode over 10 characters', () => {
    const tooLong = { unitCode: 'TOO-LONG-CODE' };
    expect(updateRewardVersionRequestSchema.safeParse(tooLong).success).toBe(false);
  });
});

describe('versionDiffSchema', () => {
  it('accepts a well-formed diff', () => {
    expect(
      versionDiffSchema.safeParse({
        versionId: 11,
        otherVersionId: 10,
        versionNo: 3,
        otherVersionNo: 2,
        expressionChanged: true,
        parametersAdded: ['tier'],
        parametersRemoved: ['minSpend'],
        parametersTypeChanged: [],
        suggestedIsBreaking: true,
      }).success,
    ).toBe(true);
  });

  it('rejects a missing suggestedIsBreaking (implementation notes 8/9)', () => {
    expect(
      versionDiffSchema.safeParse({
        versionId: 11,
        otherVersionId: 10,
        versionNo: 3,
        otherVersionNo: 2,
        expressionChanged: false,
        parametersAdded: [],
        parametersRemoved: [],
        parametersTypeChanged: [],
      }).success,
    ).toBe(false);
  });
});

describe('versionCountryAssignmentSchema / assignedVersionSchema', () => {
  it('accepts a well-formed country assignment', () => {
    expect(
      versionCountryAssignmentSchema.safeParse({
        id: 900,
        versionId: 10,
        versionNo: 2,
        countryId: 2,
        countryCode: 'MY',
        countryName: 'Malaysia',
        blastId: 700,
        status: 'active',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
        assignedBy: 1,
        assignedAt: '2026-01-01T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown assignment status', () => {
    expect(
      versionCountryAssignmentSchema.safeParse({
        id: 900,
        versionId: 10,
        versionNo: 2,
        countryId: 2,
        countryCode: 'MY',
        countryName: 'Malaysia',
        blastId: 700,
        status: 'active_forever',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
        assignedBy: 1,
        assignedAt: '2026-01-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('assignedVersionSchema accepts a well-formed row, either entity type', () => {
    const base = {
      entityId: 1,
      entityCode: 'MIN_SPEND_TIER',
      entityName: 'Minimum spend tier',
      versionId: 10,
      versionNo: 2,
      status: 'active' as const,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
    };
    expect(assignedVersionSchema.safeParse({ ...base, entityType: 'rule' }).success).toBe(true);
    expect(assignedVersionSchema.safeParse({ ...base, entityType: 'reward' }).success).toBe(true);
    expect(assignedVersionSchema.safeParse({ ...base, entityType: 'campaign' }).success).toBe(
      false,
    );
  });
});

// ─── refineScopeCountryIds — the one piece of real logic in this file ─────────────────────────
// Exercised via both public entry points that share it, `previewBlastRequestSchema` (no writes)
// and `createBlastRequestSchema` (the real blast) — implementation note 6/06-VERSIONING.md §6.
describe.each([
  ['previewBlastRequestSchema', previewBlastRequestSchema],
  ['createBlastRequestSchema', createBlastRequestSchema],
] as const)('%s — scope/countryIds coherence (refineScopeCountryIds)', (_name, schema) => {
  function base() {
    return { entityType: 'rule' as const, entityId: 1, versionId: 10 };
  }

  it('accepts scope "selected" with a non-empty countryIds', () => {
    const input = { ...base(), scope: 'selected' as const, countryIds: [1, 2, 3] };
    expect(schema.safeParse(input).success).toBe(true);
  });

  it('rejects scope "selected" with countryIds omitted', () => {
    const result = schema.safeParse({ ...base(), scope: 'selected' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['countryIds']);
      expect(result.error.issues[0]?.message).toMatch(/required and non-empty/);
    }
  });

  it('rejects scope "selected" with an empty countryIds array', () => {
    const result = schema.safeParse({ ...base(), scope: 'selected', countryIds: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['countryIds']);
    }
  });

  it('accepts scope "all_countries" with countryIds omitted', () => {
    expect(schema.safeParse({ ...base(), scope: 'all_countries' }).success).toBe(true);
  });

  it('rejects scope "all_countries" with countryIds supplied', () => {
    const result = schema.safeParse({ ...base(), scope: 'all_countries', countryIds: [1] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['countryIds']);
      expect(result.error.issues[0]?.message).toMatch(/must be omitted/);
    }
  });

  it('rejects a countryIds list over 300 entries — the plain-shape cap, not the refinement', () => {
    const countryIds = Array.from({ length: 301 }, (_unused, i) => i + 1);
    expect(schema.safeParse({ ...base(), scope: 'selected', countryIds }).success).toBe(false);
  });
});

describe('createBlastRequestSchema — the real-blast-only fields', () => {
  it('accepts note, originRequestId and confirmBreaking on top of the shared shape', () => {
    expect(
      createBlastRequestSchema.safeParse({
        entityType: 'reward',
        entityId: 1,
        versionId: 20,
        scope: 'all_countries',
        note: 'Q1 rollout',
        originRequestId: 5,
        confirmBreaking: true,
      }).success,
    ).toBe(true);
  });

  it('rejects an unrecognised extra key — strict', () => {
    expect(
      createBlastRequestSchema.safeParse({
        entityType: 'rule',
        entityId: 1,
        versionId: 10,
        scope: 'all_countries',
        blastedBy: 999,
      }).success,
    ).toBe(false);
  });
});

describe('previewBlastRequestSchema — no audit-only fields', () => {
  it('rejects note/confirmBreaking — preview is not the real act', () => {
    expect(
      previewBlastRequestSchema.safeParse({
        entityType: 'rule',
        entityId: 1,
        versionId: 10,
        scope: 'all_countries',
        note: 'not allowed here',
      }).success,
    ).toBe(false);
  });
});

describe('blastPreviewResponseSchema / blastPreviewEnvelopeSchema', () => {
  it('accepts a well-formed preview response with per-country impact rows', () => {
    expect(
      blastPreviewResponseSchema.safeParse({
        entityType: 'rule',
        entityId: 1,
        versionId: 10,
        versionNo: 3,
        isBreaking: true,
        countries: [
          {
            countryId: 2,
            countryCode: 'MY',
            countryName: 'Malaysia',
            currentVersionNo: 2,
            willReceiveVersionNo: 3,
            activeCampaignsOnCurrentVersion: 4,
            isBreaking: true,
          },
          {
            countryId: 3,
            countryCode: 'SG',
            countryName: 'Singapore',
            currentVersionNo: null,
            willReceiveVersionNo: 3,
            activeCampaignsOnCurrentVersion: 0,
            isBreaking: true,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('wraps a preview response in {data}', () => {
    expect(
      blastPreviewEnvelopeSchema.safeParse({
        data: {
          entityType: 'rule',
          entityId: 1,
          versionId: 10,
          versionNo: 3,
          isBreaking: false,
          countries: [],
        },
      }).success,
    ).toBe(true);
  });
});

describe('blastSchema / blastTargetSchema / envelopes', () => {
  function validBlast() {
    return {
      id: 700,
      entityType: 'rule' as const,
      entityId: 1,
      versionId: 10,
      versionNo: 3,
      scope: 'selected' as const,
      targetCount: 2,
      note: null,
      originRequestId: null,
      blastedBy: 1,
      blastedAt: '2026-01-01T00:00:00.000Z',
      targets: [
        {
          id: 1,
          countryId: 2,
          countryCode: 'MY',
          countryName: 'Malaysia',
          status: 'delivered' as const,
          failureReason: null,
        },
      ],
    };
  }

  it('accepts a well-formed blast with its targets', () => {
    expect(blastSchema.safeParse(validBlast()).success).toBe(true);
  });

  it('rejects an unknown target status', () => {
    expect(
      blastTargetSchema.safeParse({
        id: 1,
        countryId: 2,
        countryCode: 'MY',
        countryName: 'Malaysia',
        status: 'pending',
        failureReason: null,
      }).success,
    ).toBe(false);
  });

  it('blastEnvelopeSchema wraps a single blast in {data}', () => {
    expect(blastEnvelopeSchema.safeParse({ data: validBlast() }).success).toBe(true);
  });

  it('blastListEnvelopeSchema wraps a list in {data, meta}', () => {
    expect(
      blastListEnvelopeSchema.safeParse({
        data: [validBlast()],
        meta: { page: 1, pageSize: 20, total: 1 },
      }).success,
    ).toBe(true);
  });
});
