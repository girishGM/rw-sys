/**
 * T-031 — the `/rules` wire contract. Same discipline `country.schema.spec.ts` and
 * `bootstrap.schema.spec.ts` establish: every object is `.strict()`, so an unexpected key
 * fails here rather than shipping. `ruleParametersSchema` gets the most attention — it is the
 * one schema both the back end (`RuleService.create/update`) and the front end (the
 * parameter-schema builder) validate the same `parameters` blob against.
 */
import {
  assignRuleCountryRequestSchema,
  createRuleRequestSchema,
  ruleCategorySchema,
  ruleCountryAssignmentSchema,
  ruleEnvelopeSchema,
  ruleListEnvelopeSchema,
  ruleParametersSchema,
  ruleSchema,
  ruleSubCategorySchema,
  updateRuleRequestSchema,
} from './rule.schema';

function validRule() {
  return {
    id: 1,
    ruleCode: 'MIN_SPEND_TIER',
    name: 'Minimum spend tier',
    categoryId: 13,
    categoryName: 'TRANSACTION',
    subCategoryId: 13,
    subCategoryName: 'General',
    expression: 'amount >= :minSpend',
    parameters: { fields: [] },
    status: 'active' as const,
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('ruleParametersSchema — the meta-schema shared by the builder and the back end', () => {
  it('accepts an empty field list', () => {
    expect(ruleParametersSchema.safeParse({ fields: [] }).success).toBe(true);
  });

  it('accepts a well-formed field of every type', () => {
    const parameters = {
      fields: [
        {
          key: 'minSpend',
          label: 'Minimum spend',
          type: 'number',
          required: true,
          min: 0,
          max: 100,
        },
        {
          key: 'tier',
          label: 'Tier',
          type: 'select',
          required: false,
          options: ['gold', 'silver'],
        },
        { key: 'isVip', label: 'VIP?', type: 'boolean', required: false },
        {
          key: 'validFrom',
          label: 'Valid from',
          type: 'date',
          required: false,
          helpText: 'ISO date',
        },
      ],
    };
    expect(ruleParametersSchema.safeParse(parameters).success).toBe(true);
  });

  it('rejects a select field with no options', () => {
    expect(
      ruleParametersSchema.safeParse({
        fields: [{ key: 'tier', label: 'Tier', type: 'select', required: true }],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate field keys', () => {
    expect(
      ruleParametersSchema.safeParse({
        fields: [
          { key: 'a', label: 'A', type: 'string', required: true },
          { key: 'a', label: 'A again', type: 'string', required: false },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed key (must be identifier-shaped)', () => {
    expect(
      ruleParametersSchema.safeParse({
        fields: [{ key: 'not a key!', label: 'x', type: 'string', required: true }],
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown field type', () => {
    expect(
      ruleParametersSchema.safeParse({
        fields: [{ key: 'x', label: 'x', type: 'array', required: true }],
      }).success,
    ).toBe(false);
  });

  it('rejects an unrecognised extra key — strict', () => {
    expect(ruleParametersSchema.safeParse({ fields: [], extra: true }).success).toBe(false);
  });

  it('caps the field list at 50', () => {
    const fields = Array.from({ length: 51 }, (_unused, i) => ({
      key: `f${String(i)}`,
      label: `Field ${String(i)}`,
      type: 'string' as const,
      required: false,
    }));
    expect(ruleParametersSchema.safeParse({ fields }).success).toBe(false);
  });

  // T-074 — reproduced live: `rule_master.parameters` stored as a bare `{}` (the shape
  // `rules.service.ts#create` wrote for an omitted `parameters` before this fix, and the shape
  // `rule-master.model.ts`'s own `parseJsonColumn` falls back to for malformed/absent legacy
  // content — see that file's "never throws" comment) failed this `.strict()` schema, because
  // only `{ fields: [] }` satisfied it. A single such row broke every `GET /rules` response,
  // not just the one rule, because a Zod array parse fails whole if any one element fails.
  describe('T-074 — a bare {} is the same "no parameters" value as { fields: [] }', () => {
    it('accepts a bare {} and normalises it to { fields: [] }', () => {
      const parsed = ruleParametersSchema.safeParse({});
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual({ fields: [] });
      }
    });

    it('still rejects a non-empty object missing the fields key', () => {
      expect(ruleParametersSchema.safeParse({ extra: true }).success).toBe(false);
    });

    it('still rejects {fields: [], extra: true} — strict, unaffected by the {} tolerance', () => {
      expect(ruleParametersSchema.safeParse({ fields: [], extra: true }).success).toBe(false);
    });

    it('a rule list containing one legacy bare-{} row still parses in full', () => {
      const rows = [
        { ...validRule(), id: 1, parameters: { fields: [] } },
        { ...validRule(), id: 2, parameters: {} },
      ];
      const parsed = ruleListEnvelopeSchema.safeParse({
        data: rows,
        meta: { page: 1, pageSize: 20, total: 2 },
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.data[1]?.parameters).toEqual({ fields: [] });
      }
    });
  });
});

describe('ruleSchema', () => {
  it('accepts a well-formed rule', () => {
    expect(ruleSchema.safeParse(validRule()).success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(ruleSchema.safeParse({ ...validRule(), status: 'deleted' }).success).toBe(false);
  });

  it('rejects an extra key — strict, so a leaked column fails the contract test', () => {
    expect(ruleSchema.safeParse({ ...validRule(), passwordHash: 'x' }).success).toBe(false);
  });

  it('accepts a null expression', () => {
    expect(ruleSchema.safeParse({ ...validRule(), expression: null }).success).toBe(true);
  });
});

describe('ruleEnvelopeSchema / ruleListEnvelopeSchema', () => {
  it('wraps a single rule in {data}', () => {
    expect(ruleEnvelopeSchema.safeParse({ data: validRule() }).success).toBe(true);
  });

  it('wraps a list in {data, meta}', () => {
    expect(
      ruleListEnvelopeSchema.safeParse({
        data: [validRule()],
        meta: { page: 1, pageSize: 20, total: 1 },
      }).success,
    ).toBe(true);
  });
});

describe('createRuleRequestSchema', () => {
  it('accepts a minimal valid body', () => {
    expect(
      createRuleRequestSchema.safeParse({ ruleCode: 'MIN_SPEND_TIER', name: 'x', subCategoryId: 1 })
        .success,
    ).toBe(true);
  });

  it('rejects a client-supplied tenantId (R3)', () => {
    expect(
      createRuleRequestSchema.safeParse({
        ruleCode: 'MIN_SPEND_TIER',
        name: 'x',
        subCategoryId: 1,
        tenantId: 999,
      }).success,
    ).toBe(false);
  });

  it('rejects a ruleCode shorter than 2 characters', () => {
    expect(
      createRuleRequestSchema.safeParse({ ruleCode: 'X', name: 'x', subCategoryId: 1 }).success,
    ).toBe(false);
  });
});

describe('updateRuleRequestSchema', () => {
  it('accepts an empty body — every field optional', () => {
    expect(updateRuleRequestSchema.safeParse({}).success).toBe(true);
  });

  it('has no ruleCode key at all — immutable', () => {
    expect(updateRuleRequestSchema.safeParse({ ruleCode: 'NEW_CODE' }).success).toBe(false);
  });
});

describe('assignRuleCountryRequestSchema', () => {
  it('accepts a countryId', () => {
    expect(assignRuleCountryRequestSchema.safeParse({ countryId: 1 }).success).toBe(true);
  });

  it('rejects a client-supplied assignedBy (implementation note 6, R3)', () => {
    expect(
      assignRuleCountryRequestSchema.safeParse({ countryId: 1, assignedBy: 999 }).success,
    ).toBe(false);
  });
});

describe('ruleCountryAssignmentSchema', () => {
  it('accepts a well-formed assignment row', () => {
    expect(
      ruleCountryAssignmentSchema.safeParse({
        id: 1,
        ruleId: 1,
        countryId: 2,
        countryCode: 'SG',
        countryName: 'Singapore',
        assignedAt: '2026-01-01T00:00:00.000Z',
        assignedBy: null,
      }).success,
    ).toBe(true);
  });
});

describe('reference data schemas', () => {
  it('ruleCategorySchema accepts a well-formed category', () => {
    expect(
      ruleCategorySchema.safeParse({
        id: 13,
        categoryCode: 'TRANSACTION',
        name: 'TRANSACTION',
        status: 'active',
      }).success,
    ).toBe(true);
  });

  it('ruleSubCategorySchema accepts a well-formed sub-category', () => {
    expect(
      ruleSubCategorySchema.safeParse({
        id: 13,
        categoryId: 13,
        subCategoryCode: 'GENERAL',
        name: 'General',
        status: 'active',
      }).success,
    ).toBe(true);
  });
});
