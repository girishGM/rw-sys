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
  ruleFieldRoleSchema,
  ruleFieldValueSourceSchema,
  ruleListEnvelopeSchema,
  ruleParameterFieldSchema,
  ruleParameterFieldWithRoleSchema,
  ruleParametersEnvelopeSchema,
  ruleParametersSchema,
  ruleParametersWithRoleSchema,
  ruleResolverSchema,
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

  it('ruleResolverSchema accepts resolverInputFieldKeys (T-114)', () => {
    expect(
      ruleResolverSchema.safeParse({
        id: 1,
        resolverCode: 'TRACKER_STATE_LOOKUP',
        name: 'Sibling Tracker Component Lookup',
        description: null,
        status: 'active',
        resolverInputFieldKeys: ['targetComponentCode'],
      }).success,
    ).toBe(true);
  });

  it('ruleResolverSchema rejects a row missing resolverInputFieldKeys — strict', () => {
    expect(
      ruleResolverSchema.safeParse({
        id: 1,
        resolverCode: 'JSONPATH_PAYLOAD',
        name: 'Incoming Event Payload',
        description: null,
        status: 'active',
      }).success,
    ).toBe(false);
  });
});

/**
 * T-114 — `13-REWARD-MASTER-VALUE-SOURCES.md` §2: a parameter field's `role` is server-computed
 * and response-only. `ruleParameterFieldSchema` (the write shape `createRuleRequestSchema`/
 * `updateRuleRequestSchema` embed) never gains a `role` key — a request that supplies one 400s
 * (TC-6). `ruleParameterFieldWithRoleSchema`/`ruleParametersWithRoleSchema` (the response shape
 * `ruleSchema`/`ruleParametersEnvelopeSchema` embed) require it on every field.
 */
describe('T-114 — resolver-driven parameter-field role', () => {
  it('ruleFieldRoleSchema accepts exactly compare_value / resolver_input', () => {
    expect(ruleFieldRoleSchema.safeParse('compare_value').success).toBe(true);
    expect(ruleFieldRoleSchema.safeParse('resolver_input').success).toBe(true);
    expect(ruleFieldRoleSchema.safeParse('resolver_output').success).toBe(false);
  });

  describe('the write shape (ruleParameterFieldSchema) never accepts role — TC-6', () => {
    it('rejects a field body that supplies role', () => {
      const result = ruleParameterFieldSchema.safeParse({
        key: 'targetComponentCode',
        label: 'Sibling Component Code',
        type: 'string',
        required: true,
        role: 'resolver_input',
      });
      expect(result.success).toBe(false);
    });

    it('createRuleRequestSchema 400s a parameters.fields[].role from the client (TC-6)', () => {
      const result = createRuleRequestSchema.safeParse({
        ruleCode: 'RULE_X',
        name: 'x',
        subCategoryId: 1,
        parameters: {
          fields: [
            {
              key: 'targetComponentCode',
              label: 'Sibling Component Code',
              type: 'string',
              required: true,
              role: 'resolver_input',
            },
          ],
        },
      });
      expect(result.success).toBe(false);
    });

    it('updateRuleRequestSchema 400s a parameters.fields[].role from the client (TC-6)', () => {
      const result = updateRuleRequestSchema.safeParse({
        parameters: {
          fields: [
            { key: 'value', label: 'Value', type: 'string', required: true, role: 'compare_value' },
          ],
        },
      });
      expect(result.success).toBe(false);
    });

    it('a plain field with no role key is still accepted — role is additive, not required here', () => {
      expect(
        ruleParameterFieldSchema.safeParse({
          key: 'value',
          label: 'Value',
          type: 'string',
          required: true,
        }).success,
      ).toBe(true);
    });
  });

  describe('the response shape (ruleParameterFieldWithRoleSchema / ruleParametersWithRoleSchema)', () => {
    it('accepts a field with role: resolver_input', () => {
      expect(
        ruleParameterFieldWithRoleSchema.safeParse({
          key: 'targetComponentCode',
          label: 'Sibling Component Code',
          type: 'string',
          required: true,
          role: 'resolver_input',
        }).success,
      ).toBe(true);
    });

    it('rejects a field missing role — response shape requires it', () => {
      expect(
        ruleParameterFieldWithRoleSchema.safeParse({
          key: 'value',
          label: 'Value',
          type: 'string',
          required: true,
        }).success,
      ).toBe(false);
    });

    it('rejects an unrecognised role value', () => {
      expect(
        ruleParameterFieldWithRoleSchema.safeParse({
          key: 'value',
          label: 'Value',
          type: 'string',
          required: true,
          role: 'not_a_role',
        }).success,
      ).toBe(false);
    });

    it('still requires options on a select field, role notwithstanding', () => {
      expect(
        ruleParameterFieldWithRoleSchema.safeParse({
          key: 'tier',
          label: 'Tier',
          type: 'select',
          required: true,
          role: 'compare_value',
        }).success,
      ).toBe(false);
    });

    it('ruleParametersWithRoleSchema accepts a mix of resolver_input and compare_value fields', () => {
      const result = ruleParametersWithRoleSchema.safeParse({
        fields: [
          {
            key: 'targetComponentCode',
            label: 'Sibling Component Code',
            type: 'string',
            required: true,
            role: 'resolver_input',
          },
          {
            key: 'value',
            label: 'Expected Status',
            type: 'select',
            required: true,
            options: ['COMPLETED'],
            role: 'compare_value',
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('ruleParametersWithRoleSchema still normalises a bare {} to { fields: [] } (T-074 parity)', () => {
      const result = ruleParametersWithRoleSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toEqual({ fields: [] });
    });

    it('ruleParametersWithRoleSchema still rejects duplicate keys', () => {
      const result = ruleParametersWithRoleSchema.safeParse({
        fields: [
          { key: 'a', label: 'A', type: 'string', required: true, role: 'compare_value' },
          { key: 'a', label: 'A again', type: 'string', required: false, role: 'compare_value' },
        ],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ruleSchema / ruleParametersEnvelopeSchema — the response paths that embed the with-role shape', () => {
    it('ruleSchema accepts a rule whose parameters fields all carry role', () => {
      const rule = {
        ...validRule(),
        parameters: {
          fields: [
            {
              key: 'targetComponentCode',
              label: 'Sibling Component Code',
              type: 'string',
              required: true,
              role: 'resolver_input',
            },
          ],
        },
      };
      expect(ruleSchema.safeParse(rule).success).toBe(true);
    });

    it('ruleSchema rejects a rule whose parameters field is missing role', () => {
      const rule = {
        ...validRule(),
        parameters: {
          fields: [{ key: 'value', label: 'Value', type: 'string', required: true }],
        },
      };
      expect(ruleSchema.safeParse(rule).success).toBe(false);
    });

    it('ruleParametersEnvelopeSchema wraps the role-annotated parameters shape', () => {
      expect(
        ruleParametersEnvelopeSchema.safeParse({
          data: {
            fields: [
              {
                key: 'value',
                label: 'Value',
                type: 'string',
                required: true,
                role: 'compare_value',
              },
            ],
          },
        }).success,
      ).toBe(true);
    });
  });
});

/**
 * T-122 — `13-REWARD-MASTER-VALUE-SOURCES.md` §3: a `select` parameter field may take its options
 * from a registered context/API lookup provider instead of a hand-typed `options` array.
 *
 * The schema decides *shape* only. Whether the referenced provider code actually exists is a live
 * registry read and belongs to `rules.service.ts` (TC-4/TC-5) — nothing here can or should assert
 * it, which is why every code below is well-formed and none of these cases is about existence.
 */
describe('T-122 — rule parameter-field value source', () => {
  function selectField(overrides: Record<string, unknown> = {}) {
    return { key: 'tier', label: 'Tier', type: 'select', required: true, ...overrides };
  }

  const CONTEXT_SOURCE = { kind: 'CONTEXT_LOOKUP', contextProvider: 'SIBLING_COMPONENTS' };
  const API_SOURCE = { kind: 'API_LOOKUP', apiProvider: 'PRODUCT_CATALOG' };

  describe('ruleFieldValueSourceSchema — the discriminated union itself', () => {
    it('accepts a CONTEXT_LOOKUP naming a context provider', () => {
      expect(ruleFieldValueSourceSchema.safeParse(CONTEXT_SOURCE).success).toBe(true);
    });

    it('accepts an API_LOOKUP naming an api provider', () => {
      expect(ruleFieldValueSourceSchema.safeParse(API_SOURCE).success).toBe(true);
    });

    it('rejects a STATIC_LIST kind — a plain select with options already is the fixed-list case', () => {
      expect(
        ruleFieldValueSourceSchema.safeParse({ kind: 'STATIC_LIST', options: ['a'] }).success,
      ).toBe(false);
    });

    it('rejects the wrong provider key for the kind (each variant is .strict())', () => {
      expect(
        ruleFieldValueSourceSchema.safeParse({
          kind: 'CONTEXT_LOOKUP',
          apiProvider: 'PRODUCT_CATALOG',
        }).success,
      ).toBe(false);
      expect(
        ruleFieldValueSourceSchema.safeParse({
          kind: 'API_LOOKUP',
          contextProvider: 'SIBLING_COMPONENTS',
        }).success,
      ).toBe(false);
    });

    it('rejects an extra key alongside a valid variant', () => {
      expect(
        ruleFieldValueSourceSchema.safeParse({ ...CONTEXT_SOURCE, endpointUrl: 'http://x' })
          .success,
      ).toBe(false);
    });

    it('rejects a provider code that is not upper snake case, and an empty one', () => {
      expect(
        ruleFieldValueSourceSchema.safeParse({
          kind: 'CONTEXT_LOOKUP',
          contextProvider: 'sibling components',
        }).success,
      ).toBe(false);
      expect(
        ruleFieldValueSourceSchema.safeParse({ kind: 'CONTEXT_LOOKUP', contextProvider: '' })
          .success,
      ).toBe(false);
    });
  });

  describe('the select refinement — options OR valueSource, never both required', () => {
    it('TC-1 — a select field with options and no valueSource is still valid (unchanged)', () => {
      expect(ruleParameterFieldSchema.safeParse(selectField({ options: ['gold'] })).success).toBe(
        true,
      );
    });

    it('TC-2 — a select field with a valueSource and no options is valid', () => {
      expect(
        ruleParameterFieldSchema.safeParse(selectField({ valueSource: CONTEXT_SOURCE })).success,
      ).toBe(true);
      expect(
        ruleParameterFieldSchema.safeParse(selectField({ valueSource: API_SOURCE })).success,
      ).toBe(true);
    });

    it('TC-3 — a select field with neither options nor valueSource is rejected', () => {
      expect(ruleParameterFieldSchema.safeParse(selectField()).success).toBe(false);
    });

    it('TC-3 — an empty options array with no valueSource is still rejected', () => {
      expect(ruleParameterFieldSchema.safeParse(selectField({ options: [] })).success).toBe(false);
    });

    it('accepts both together — a fixed list plus a provider is a meaningful authoring state', () => {
      expect(
        ruleParameterFieldSchema.safeParse(
          selectField({ options: ['gold'], valueSource: CONTEXT_SOURCE }),
        ).success,
      ).toBe(true);
    });
  });

  describe('TC-6 — a valueSource only makes sense on a select field', () => {
    it.each(['string', 'number', 'boolean', 'date'])(
      'rejects a %s field that declares a valueSource',
      (type) => {
        const result = ruleParameterFieldSchema.safeParse({
          key: 'targetComponentCode',
          label: 'Target component',
          type,
          required: true,
          valueSource: CONTEXT_SOURCE,
        });
        expect(result.success).toBe(false);
      },
    );

    it('still accepts a non-select field with no valueSource', () => {
      expect(
        ruleParameterFieldSchema.safeParse({
          key: 'minSpend',
          label: 'Minimum spend',
          type: 'number',
          required: true,
        }).success,
      ).toBe(true);
    });
  });

  describe('the request schemas embed the same rules', () => {
    it('createRuleRequestSchema accepts a sourced select field (TC-2)', () => {
      expect(
        createRuleRequestSchema.safeParse({
          ruleCode: 'RULE_X',
          name: 'x',
          subCategoryId: 1,
          parameters: { fields: [selectField({ valueSource: CONTEXT_SOURCE })] },
        }).success,
      ).toBe(true);
    });

    it('createRuleRequestSchema rejects an optionless, sourceless select field (TC-3)', () => {
      expect(
        createRuleRequestSchema.safeParse({
          ruleCode: 'RULE_X',
          name: 'x',
          subCategoryId: 1,
          parameters: { fields: [selectField()] },
        }).success,
      ).toBe(false);
    });

    it('updateRuleRequestSchema rejects a valueSource on a non-select field (TC-6)', () => {
      expect(
        updateRuleRequestSchema.safeParse({
          parameters: {
            fields: [
              {
                key: 'targetComponentCode',
                label: 'Target component',
                type: 'string',
                required: true,
                valueSource: CONTEXT_SOURCE,
              },
            ],
          },
        }).success,
      ).toBe(false);
    });
  });

  describe('the response shape carries valueSource too — T-125 has to render it back', () => {
    it('ruleParameterFieldWithRoleSchema accepts a sourced select field', () => {
      expect(
        ruleParameterFieldWithRoleSchema.safeParse(
          selectField({ valueSource: CONTEXT_SOURCE, role: 'resolver_input' }),
        ).success,
      ).toBe(true);
    });

    it('ruleParameterFieldWithRoleSchema applies the same two refinements', () => {
      expect(
        ruleParameterFieldWithRoleSchema.safeParse(selectField({ role: 'compare_value' })).success,
      ).toBe(false);
      expect(
        ruleParameterFieldWithRoleSchema.safeParse({
          key: 'targetComponentCode',
          label: 'Target component',
          type: 'string',
          required: true,
          role: 'resolver_input',
          valueSource: CONTEXT_SOURCE,
        }).success,
      ).toBe(false);
    });

    it('ruleSchema round-trips a rule whose parameters carry a valueSource', () => {
      const rule = {
        ...validRule(),
        parameters: {
          fields: [selectField({ valueSource: CONTEXT_SOURCE, role: 'resolver_input' })],
        },
      };
      const result = ruleSchema.safeParse(rule);
      expect(result.success).toBe(true);
      expect(result.success && result.data.parameters.fields[0]?.valueSource).toEqual(
        CONTEXT_SOURCE,
      );
    });
  });
});
