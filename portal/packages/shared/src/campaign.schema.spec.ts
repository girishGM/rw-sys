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
