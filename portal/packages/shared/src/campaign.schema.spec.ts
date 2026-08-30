/**
 * T-037 — the shared `/campaigns` wire contract.
 *
 * The bulk of this file is {@link buildRuleValueSchema}, because that function is the **one**
 * definition both `DynamicParameterForm` and the server's re-validation are built from
 * (implementation note 9). TC-17, TC-18, TC-19 and TC-20 are all properties of it, and they are
 * tested here — in the shared package — rather than twice, once per side, which is exactly the
 * duplication the single definition exists to avoid.
 */
import {
  buildRuleValueSchema,
  campaignCapInputSchema,
  createCampaignRequestSchema,
  isBeforeTodayInItsOwnOffset,
  isoDateTimeSchema,
  missingRequiredParameterKeys,
  moneySchema,
  ruleOptionSchema,
} from './campaign.schema';
import type { RuleParameters } from './rule.schema';

const NOW = new Date('2026-08-19T12:00:00Z');

function inDays(days: number, offset = 'Z'): string {
  const date = new Date(NOW.getTime() + days * 86_400_000);
  return `${date.toISOString().slice(0, 19)}${offset}`;
}

describe('campaign.schema — dates', () => {
  describe('isoDateTimeSchema', () => {
    it('accepts an instant with a Z or a numeric offset', () => {
      expect(isoDateTimeSchema.safeParse('2026-09-01T00:00:00Z').success).toBe(true);
      expect(isoDateTimeSchema.safeParse('2026-09-01T00:00:00+08:00').success).toBe(true);
      expect(isoDateTimeSchema.safeParse('2026-09-01T00:00:00.123-05:00').success).toBe(true);
    });

    it('refuses an instant with no offset — the ambiguity TC-10 is about', () => {
      expect(isoDateTimeSchema.safeParse('2026-09-01T00:00:00').success).toBe(false);
    });

    it('refuses a date with no time', () => {
      expect(isoDateTimeSchema.safeParse('2026-09-01').success).toBe(false);
    });

    it('refuses a well-shaped string that is not a real date', () => {
      expect(isoDateTimeSchema.safeParse('2026-13-45T00:00:00Z').success).toBe(false);
    });
  });

  describe('isBeforeTodayInItsOwnOffset — implementation note 11', () => {
    it('accepts today in UTC', () => {
      expect(isBeforeTodayInItsOwnOffset('2026-08-19T00:00:00Z', NOW)).toBe(false);
    });

    it('accepts today in Kuala Lumpur even though the instant is already past in UTC', () => {
      // 2026-08-19T00:00+08:00 is 2026-08-18T16:00Z — an instant in the past. Comparing instants
      // would reject a perfectly ordinary same-day campaign for eight hours every day.
      expect(isBeforeTodayInItsOwnOffset('2026-08-19T00:00:00+08:00', NOW)).toBe(false);
    });

    it('rejects yesterday', () => {
      expect(isBeforeTodayInItsOwnOffset('2026-08-18T23:59:59Z', NOW)).toBe(true);
    });

    it('accepts a value with an unparseable offset rather than rejecting it here', () => {
      // `isoDateTimeSchema` has already refused anything without an offset; this branch exists so
      // the refinement never throws on input another rule is responsible for.
      expect(isBeforeTodayInItsOwnOffset('nonsense', NOW)).toBe(false);
    });
  });

  describe('createCampaignRequestSchema', () => {
    const valid = {
      campaignCode: 'RAYA_2026',
      name: 'Raya bonus',
      startDate: inDays(1),
      endDate: inDays(30),
    };

    // T-135 — `createCampaignRequestSchema`'s own `startDate must not be in the past` refinement
    // calls `isBeforeTodayInItsOwnOffset` with **no** `now` override (`campaign.schema.ts`'s
    // `refineDates`), so it reads the real wall clock, not this file's `NOW`. Every fixture above
    // is built relative to `NOW` on the assumption that `NOW` *is* "today" — true only the day
    // this file was written. Left unfrozen, the suite silently rots the moment the real clock
    // drifts past `NOW`: `inDays(1)` stops being "tomorrow" and starts being "11 days ago",
    // exactly the past-dated `startDate` this describe block's own tests exist to reject.
    // Freezing Jest's clock to `NOW` for this block alone is what T-105/T-111/T-112 and everyone
    // else who ever runs this file again from a later date needs — it is not a one-off patch for
    // today's failure, since without it the same rot returns on whatever future date next passes
    // `NOW` by more than `endDate`'s 30-day margin.
    beforeAll(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      jest.setSystemTime(NOW);
    });

    afterAll(() => {
      jest.useRealTimers();
    });

    it('accepts a well-formed request', () => {
      expect(createCampaignRequestSchema.safeParse(valid).success).toBe(true);
    });

    it('TC-8: refuses endDate before startDate', () => {
      const result = createCampaignRequestSchema.safeParse({
        ...valid,
        startDate: inDays(30),
        endDate: inDays(1),
      });
      expect(result.success).toBe(false);
    });

    it('TC-9: refuses a startDate in the past', () => {
      expect(
        createCampaignRequestSchema.safeParse({ ...valid, startDate: inDays(-5) }).success,
      ).toBe(false);
    });

    it('TC-11: refuses a budget amount with no currency', () => {
      expect(
        createCampaignRequestSchema.safeParse({ ...valid, budgetAmount: '500000' }).success,
      ).toBe(false);
    });

    it('accepts a currency with no amount — a campaign may declare its currency first', () => {
      expect(
        createCampaignRequestSchema.safeParse({ ...valid, budgetCurrency: 'MYR' }).success,
      ).toBe(true);
    });

    it('R3: refuses a body carrying tenantId', () => {
      expect(createCampaignRequestSchema.safeParse({ ...valid, tenantId: 1 }).success).toBe(false);
    });
  });

  describe('moneySchema', () => {
    it('accepts decimal strings within the column scale', () => {
      for (const value of ['0', '1', '500000', '1.5', '0.0001']) {
        expect(moneySchema.safeParse(value).success).toBe(true);
      }
    });

    it('refuses a float, a negative, an exponent and more than four places', () => {
      for (const value of ['-1', '1e5', '1.00001', '1,000']) {
        expect(moneySchema.safeParse(value).success).toBe(false);
      }
    });
  });
});

describe('campaign.schema — campaignCapInputSchema', () => {
  const budget = {
    capClass: 'budget' as const,
    scopeLevel: 'campaign' as const,
    periodType: 'lifetime' as const,
    unitType: 'currency' as const,
    unitCode: 'MYR',
    maxTotalAmount: '500000',
  };

  it('accepts a campaign lifetime budget', () => {
    expect(campaignCapInputSchema.safeParse(budget).success).toBe(true);
  });

  it('TC-21w: refuses an amount with no unit (ck_cc_unit)', () => {
    const { unitType, unitCode, ...rest } = budget;
    void unitType;
    void unitCode;
    expect(campaignCapInputSchema.safeParse(rest).success).toBe(false);
  });

  it('refuses a cap that caps nothing (ck_cc_has_ceiling)', () => {
    const { maxTotalAmount, ...rest } = budget;
    void maxTotalAmount;
    expect(campaignCapInputSchema.safeParse(rest).success).toBe(false);
  });

  it('refuses maxCustomers on a limit (ck_cc_customers)', () => {
    expect(
      campaignCapInputSchema.safeParse({
        capClass: 'limit',
        scopeLevel: 'campaign',
        periodType: 'lifetime',
        maxCustomers: 100,
      }).success,
    ).toBe(false);
  });

  it('accepts maxCustomers on a budget', () => {
    expect(
      campaignCapInputSchema.safeParse({
        capClass: 'budget',
        scopeLevel: 'campaign',
        periodType: 'lifetime',
        maxCustomers: 10_000,
      }).success,
    ).toBe(true);
  });

  it('accepts an explicit null scopeRefId at campaign scope', () => {
    expect(campaignCapInputSchema.safeParse({ ...budget, scopeRefId: null }).success).toBe(true);
  });
});

describe('campaign.schema — buildRuleValueSchema', () => {
  const parameters: RuleParameters = {
    fields: [
      {
        key: 'minSpend',
        label: 'Minimum spend',
        type: 'number',
        required: true,
        min: 10,
        max: 1000,
      },
      {
        key: 'period',
        label: 'Period',
        type: 'select',
        required: true,
        options: ['daily', 'weekly'],
      },
      { key: 'note', label: 'Note', type: 'string', required: false },
      { key: 'active', label: 'Active', type: 'boolean', required: false },
      { key: 'from', label: 'From', type: 'date', required: false },
    ],
  };

  const valid = { minSpend: 50, period: 'daily' };

  it('TC-16: accepts values that satisfy every declared field', () => {
    expect(buildRuleValueSchema(parameters).safeParse(valid).success).toBe(true);
  });

  it('TC-17: refuses a number below the declared minimum', () => {
    expect(buildRuleValueSchema(parameters).safeParse({ ...valid, minSpend: 9 }).success).toBe(
      false,
    );
  });

  it('refuses a number above the declared maximum', () => {
    expect(buildRuleValueSchema(parameters).safeParse({ ...valid, minSpend: 1001 }).success).toBe(
      false,
    );
  });

  it('TC-18: refuses a missing required field', () => {
    expect(buildRuleValueSchema(parameters).safeParse({ minSpend: 50 }).success).toBe(false);
  });

  it('TC-19: refuses an extra field the schema does not declare', () => {
    expect(buildRuleValueSchema(parameters).safeParse({ ...valid, sneaky: 1 }).success).toBe(false);
  });

  it('refuses a select value outside the declared options', () => {
    expect(buildRuleValueSchema(parameters).safeParse({ ...valid, period: 'hourly' }).success).toBe(
      false,
    );
  });

  it('refuses a number supplied as a string — a form that did not parse its own input', () => {
    expect(buildRuleValueSchema(parameters).safeParse({ ...valid, minSpend: '50' }).success).toBe(
      false,
    );
  });

  it('accepts every optional field when supplied with the right type', () => {
    expect(
      buildRuleValueSchema(parameters).safeParse({
        ...valid,
        note: 'a note',
        active: true,
        from: '2026-09-01',
      }).success,
    ).toBe(true);
  });

  it('refuses a date field carrying an instant rather than a calendar day', () => {
    expect(
      buildRuleValueSchema(parameters).safeParse({ ...valid, from: '2026-09-01T00:00:00Z' })
        .success,
    ).toBe(false);
  });

  it('accepts an empty object for a rule that declares no parameters', () => {
    expect(buildRuleValueSchema({ fields: [] }).safeParse({}).success).toBe(true);
  });

  it('refuses any key at all for a rule that declares no parameters', () => {
    expect(buildRuleValueSchema({ fields: [] }).safeParse({ anything: 1 }).success).toBe(false);
  });

  it('fails closed for a malformed select field with no options', () => {
    // A row written before `ruleParameterFieldSchema`'s own refine existed. Accepting nothing is
    // safer than accepting anything, and safer than throwing inside a maker's form.
    const malformed: RuleParameters = {
      fields: [{ key: 'choice', label: 'Choice', type: 'select', required: true }],
    };
    expect(buildRuleValueSchema(malformed).safeParse({ choice: 'anything' }).success).toBe(false);
  });

  it('TC-20: renders and round-trips ten parameters of mixed types', () => {
    const ten: RuleParameters = {
      fields: Array.from({ length: 10 }, (_unused, index) => {
        const types = ['string', 'number', 'boolean', 'date', 'select'] as const;
        const type = types[index % types.length];
        return {
          key: `field${String(index)}`,
          label: `Field ${String(index)}`,
          type,
          required: index % 2 === 0,
          ...(type === 'select' ? { options: ['a', 'b'] } : {}),
        };
      }),
    };

    const values: Record<string, unknown> = {};
    for (const field of ten.fields) {
      values[field.key] =
        field.type === 'number'
          ? 1
          : field.type === 'boolean'
            ? true
            : field.type === 'date'
              ? '2026-09-01'
              : field.type === 'select'
                ? 'a'
                : 'text';
    }

    const result = buildRuleValueSchema(ten).safeParse(values);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(values);
  });
});

describe('campaign.schema — missingRequiredParameterKeys', () => {
  const parameters: RuleParameters = {
    fields: [
      { key: 'a', label: 'A', type: 'string', required: true },
      { key: 'b', label: 'B', type: 'string', required: true },
      { key: 'c', label: 'C', type: 'string', required: false },
    ],
  };

  it('names every missing required key, so step 7 reports them all at once', () => {
    expect(missingRequiredParameterKeys(parameters, {})).toEqual(['a', 'b']);
  });

  it('is empty when every required key is present', () => {
    expect(missingRequiredParameterKeys(parameters, { a: '1', b: '2' })).toEqual([]);
  });

  it('does not count an optional key as missing', () => {
    expect(missingRequiredParameterKeys(parameters, { a: '1', b: '2', c: undefined })).toEqual([]);
  });
});

// --- T-112/T-138: ruleOptionSchema carries categoryId/subCategoryId, not just their display
// names — ComponentRulesStep's category/sub-category filter (T-112 implementation note 3) keys
// its client-side filtering off the id, since two categories can share a display name across
// tenants. This block is the regression for T-138: T-112's shared-schema half of that wiring was
// lost to an uncommitted-work reset and silently regressed `ruleOptionSchema` back to
// name-only, while its front-end consumer (already reading `.categoryId`) kept compiling only
// because `ruleOptionSchema` had no `.strict()` violation to report at the type level — a plain
// `RuleOption` fixture missing the fields is the shape that actually catches it. -------------
describe('campaign.schema — ruleOptionSchema (T-112/T-138)', () => {
  const VALID_OPTION = {
    ruleId: 1,
    ruleCode: 'RULE_COMP_MIN_SPEND',
    name: 'Minimum spend',
    categoryId: 7,
    subCategoryId: 42,
    categoryName: 'Component rules',
    subCategoryName: 'Spend thresholds',
    ruleVersionId: 9,
    ruleVersionNo: 1,
    parameters: { fields: [] },
    defaultOperators: [],
  };

  it('TC-1: parses a well-formed option, including categoryId/subCategoryId', () => {
    const result = ruleOptionSchema.safeParse(VALID_OPTION);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.categoryId).toBe(7);
      expect(result.data.subCategoryId).toBe(42);
    }
  });

  /** `VALID_OPTION` minus one named key — deletion, not destructuring, so no rest sibling lint noise. */
  function omit(key: keyof typeof VALID_OPTION): Record<string, unknown> {
    const copy: Record<string, unknown> = { ...VALID_OPTION };
    delete copy[key];
    return copy;
  }

  it('TC-3 regression: refuses an option missing categoryId (the T-138 defect — proven red against the unfixed schema by removing the field again)', () => {
    expect(ruleOptionSchema.safeParse(omit('categoryId')).success).toBe(false);
  });

  it('TC-3 regression: refuses an option missing subCategoryId', () => {
    expect(ruleOptionSchema.safeParse(omit('subCategoryId')).success).toBe(false);
  });

  it('TC-4: categoryName/subCategoryName stay independently nullable — unrelated to the id fields', () => {
    const result = ruleOptionSchema.safeParse({
      ...VALID_OPTION,
      categoryName: null,
      subCategoryName: null,
    });
    expect(result.success).toBe(true);
  });

  it('TC-4: rejects a non-integer categoryId/subCategoryId, same as every other *Id field here', () => {
    expect(ruleOptionSchema.safeParse({ ...VALID_OPTION, categoryId: 1.5 }).success).toBe(false);
    expect(ruleOptionSchema.safeParse({ ...VALID_OPTION, subCategoryId: 'x' }).success).toBe(false);
  });
});

// --- T-136: a `select` field sourced from a provider (`valueSource`, T-122) can actually be
// saved. `buildRuleValueSchema` switched on `field.type` alone and enumerated `field.options` for
// every `select`, so a provider-sourced field — legal since T-122 with no `options` at all —
// became `z.enum([NO_OPTIONS_SENTINEL])`: an enum of one value no JSON body can carry. Every
// value a Maker could pick from T-123's own dropdown was therefore rejected, by this one shared
// function, on both sides of the wire at once. -----------------------------------------------
describe('campaign.schema — buildRuleValueSchema and value-source select fields (T-136)', () => {
  const contextSourced: RuleParameters = {
    fields: [
      {
        key: 'targetComponentCode',
        label: 'Earlier step',
        type: 'select',
        required: true,
        valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: 'SIBLING_COMPONENTS' },
      },
    ],
  };

  const apiSourced: RuleParameters = {
    fields: [
      {
        key: 'merchantOutlet',
        label: 'Outlet',
        type: 'select',
        required: false,
        valueSource: { kind: 'API_LOOKUP', apiProvider: 'OUTLET_DIRECTORY' },
      },
    ],
  };

  it('TC-2/TC-3: accepts a CONTEXT_LOOKUP value the Maker picked from the provider dropdown', () => {
    // The exact defect: this is a component id `GET /field-value-sources/context/...` returned,
    // and before the fix it failed with `invalid_enum_value … expected '\0__no_options__'`.
    const result = buildRuleValueSchema(contextSourced).safeParse({
      targetComponentCode: '4321',
    });
    expect(result.success).toBe(true);
  });

  it('TC-3: accepts an API_LOOKUP value, and treats the optional field as omittable', () => {
    expect(buildRuleValueSchema(apiSourced).safeParse({ merchantOutlet: 'OUTLET-9' }).success).toBe(
      true,
    );
    expect(buildRuleValueSchema(apiSourced).safeParse({}).success).toBe(true);
  });

  it('normalises a numeric provider value to its string form — one stored shape per value', () => {
    // `FieldValueOption.value` is `string | number` on both sides (T-123's lookup service, the
    // SPA's `ruleValues.ts`). The SPA sends `String(value)`; an API/agent caller forwarding the
    // provider's raw number must not create a second representation of the same choice.
    const result = buildRuleValueSchema(contextSourced).safeParse({ targetComponentCode: 4321 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ targetComponentCode: '4321' });
  });

  it('still refuses an empty string, a wrong type and an undeclared key', () => {
    expect(
      buildRuleValueSchema(contextSourced).safeParse({ targetComponentCode: '' }).success,
    ).toBe(false);
    expect(
      buildRuleValueSchema(contextSourced).safeParse({ targetComponentCode: true }).success,
    ).toBe(false);
    expect(
      buildRuleValueSchema(contextSourced).safeParse({ targetComponentCode: '1', sneaky: 'x' })
        .success,
    ).toBe(false);
  });

  it('still refuses a missing required value-source field (TC-18 is unchanged by the fix)', () => {
    expect(buildRuleValueSchema(contextSourced).safeParse({}).success).toBe(false);
  });

  it('takes the provider branch when a field carries both options and a valueSource', () => {
    // `ruleParameterFieldSchema` permits both, and `ComponentRulesStep` renders such a field from
    // its provider — so validating against the list the Maker was never shown would reject
    // exactly the values they could pick.
    const both: RuleParameters = {
      fields: [
        {
          key: 'targetComponentCode',
          label: 'Earlier step',
          type: 'select',
          required: true,
          options: ['legacy-a', 'legacy-b'],
          valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: 'SIBLING_COMPONENTS' },
        },
      ],
    };
    expect(buildRuleValueSchema(both).safeParse({ targetComponentCode: '4321' }).success).toBe(
      true,
    );
    expect(buildRuleValueSchema(both).safeParse({ targetComponentCode: 'legacy-a' }).success).toBe(
      true,
    );
  });

  it('TC-4: a plain fixed-list select is untouched — its options are still the whole contract', () => {
    const fixed: RuleParameters = {
      fields: [
        {
          key: 'txnType',
          label: 'Transaction type',
          type: 'select',
          required: true,
          options: ['purchase', 'refund'],
        },
      ],
    };
    expect(buildRuleValueSchema(fixed).safeParse({ txnType: 'purchase' }).success).toBe(true);
    expect(buildRuleValueSchema(fixed).safeParse({ txnType: 'anything-else' }).success).toBe(false);
    expect(buildRuleValueSchema(fixed).safeParse({ txnType: 4321 }).success).toBe(false);
  });

  it('TC-4: a select with neither options nor a valueSource still fails closed', () => {
    const malformed: RuleParameters = {
      fields: [{ key: 'choice', label: 'Choice', type: 'select', required: true }],
    };
    expect(buildRuleValueSchema(malformed).safeParse({ choice: 'anything' }).success).toBe(false);
  });
});
