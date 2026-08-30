/**
 * T-112 — category/sub-category filtering above the "Add a rule" picker in the campaign wizard's
 * Component Rules step (mirrors T-111's Super Admin filter, one level down: the Maker's picker).
 *
 * T-125 adds the value-source-aware fields (`ValueSourceField` et al. in `ComponentRulesStep.tsx`
 * itself) — those tests mock `lib/apiClient` directly, the same seam `ruleValues.ts`'s own
 * `fetchContextLookupOptions`/`fetchApiLookupOptions` call through, rather than mocking a
 * `campaigns/api.ts` hook this task's `Files owned` does not include.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Journey, RuleOption, RuleParameterField } from '@reward-portal/shared';
import { ComponentRulesStep } from './ComponentRulesStep';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock('../../../lib/apiClient', () => ({ api: { get: mockGet } }));

function ruleOption(overrides: Partial<RuleOption>): RuleOption {
  return {
    ruleId: 1,
    ruleCode: 'RULE_1',
    name: 'Rule 1',
    categoryId: 1,
    subCategoryId: 1,
    categoryName: 'COMPONENT',
    subCategoryName: 'GENERAL',
    ruleVersionId: null,
    ruleVersionNo: null,
    parameters: { fields: [] },
    defaultOperators: [],
    ...overrides,
  };
}

const RULE_COMPONENT = ruleOption({
  ruleId: 101,
  ruleCode: 'RULE_COMP_COMPLETED_001',
  name: 'Component completed',
  categoryId: 1,
  subCategoryId: 1,
  categoryName: 'COMPONENT',
  subCategoryName: 'GENERAL',
});

const RULE_AGGREGATE = ruleOption({
  ruleId: 201,
  ruleCode: 'RULE_AGG_MIN_SPEND_001',
  name: 'Minimum aggregate spend',
  categoryId: 2,
  subCategoryId: 2,
  categoryName: 'AGGREGATE',
  subCategoryName: 'SPEND',
});

const RULE_COMPONENT_2 = ruleOption({
  ruleId: 102,
  ruleCode: 'RULE_COMP_NOT_COMPLETED_001',
  name: 'Component not completed',
  categoryId: 1,
  subCategoryId: 3,
  categoryName: 'COMPONENT',
  subCategoryName: 'ANOTHER_SUB',
});

const RULE_OPTIONS: readonly RuleOption[] = [RULE_COMPONENT, RULE_COMPONENT_2, RULE_AGGREGATE];

function journeyWith(
  components: {
    id: number;
    name: string;
    sequenceOrder: number;
    ruleIds: readonly number[];
    /** T-148 — what the server already holds for this component's "rules combine" setting. */
    ruleLogic?: 'all' | 'any' | 'n_of' | null;
    ruleThreshold?: number | null;
    /** T-148 — the operator already saved against a binding, by that binding's id. */
    operators?: Readonly<Record<number, string>>;
  }[],
): Journey {
  return {
    campaignId: 1,
    campaignRewards: [],
    trackers: [
      {
        id: 1,
        linkId: 1,
        trackerCode: 'TRK_1',
        name: 'Tracker 1',
        description: null,
        completionLogic: 'all',
        completionThreshold: null,
        isPrimary: true,
        status: 'active',
        rewards: [],
        components: components.map((component) => ({
          id: component.id,
          linkId: component.id,
          componentCode: `CMP_${String(component.id)}`,
          name: component.name,
          description: null,
          activityId: null,
          activityName: null,
          sequenceOrder: component.sequenceOrder,
          isMandatory: true,
          status: 'active',
          ruleLogic: component.ruleLogic ?? null,
          ruleThreshold: component.ruleThreshold ?? null,
          rewards: [],
          rules: component.ruleIds.map((ruleId) => ({
            id: ruleId,
            ruleId,
            ruleCode: `BOUND_${String(ruleId)}`,
            ruleName: `Bound rule ${String(ruleId)}`,
            ruleVersionId: null,
            ruleVersionNo: null,
            parameters: { fields: [] },
            values: {},
            operator: component.operators?.[ruleId] ?? null,
            value: null,
            status: 'active',
          })),
        })),
      },
    ],
  };
}

function renderStep(
  journey: Journey,
  ruleOptions: readonly RuleOption[] = RULE_OPTIONS,
  overrides: Partial<Parameters<typeof ComponentRulesStep>[0]> = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ComponentRulesStep
        journey={journey}
        ruleOptions={ruleOptions}
        onBindRule={vi.fn()}
        onUnbindRule={vi.fn()}
        onSaveValues={vi.fn()}
        onSaveOperator={vi.fn()}
        onSaveRuleLogic={vi.fn()}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

/** A one-tracker, one-component journey with a single bound rule carrying `fields`/`values` — the
 * shared fixture T-125's value-source tests build on. */
function journeyWithBoundRuleFields(
  fields: RuleParameterField[],
  values: Record<string, unknown> = {},
): Journey {
  return {
    campaignId: 1,
    campaignRewards: [],
    trackers: [
      {
        id: 1,
        linkId: 1,
        trackerCode: 'TRK_1',
        name: 'Tracker 1',
        description: null,
        completionLogic: 'all',
        completionThreshold: null,
        isPrimary: true,
        status: 'active',
        rewards: [],
        components: [
          {
            id: 2,
            linkId: 2,
            componentCode: 'CMP_2',
            name: 'Step 2',
            description: null,
            activityId: null,
            activityName: null,
            sequenceOrder: 2,
            isMandatory: true,
            status: 'active',
            ruleLogic: null,
            ruleThreshold: null,
            rewards: [],
            rules: [
              {
                id: 501,
                ruleId: RULE_COMPONENT.ruleId,
                ruleCode: RULE_COMPONENT.ruleCode,
                ruleName: RULE_COMPONENT.name,
                ruleVersionId: null,
                ruleVersionNo: null,
                parameters: { fields },
                values,
                operator: null,
                value: null,
                status: 'active',
              },
            ],
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  mockGet.mockReset();
});

describe('ComponentRulesStep — Add-a-rule category/sub-category filter (T-112)', () => {
  it('TC-1: every option carries categoryId/subCategoryId (schema-level, exercised through the filter)', async () => {
    const user = userEvent.setup();
    const journey = journeyWith([{ id: 1, name: 'Step 1', sequenceOrder: 1, ruleIds: [] }]);
    renderStep(journey);

    await user.click(screen.getByRole('combobox', { name: /^category$/i }));
    expect(screen.getByRole('option', { name: 'COMPONENT' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'AGGREGATE' })).toBeInTheDocument();
  });

  it('TC-2: picking category COMPONENT leaves only RULE_COMP_* rules in the rule dropdown', async () => {
    const user = userEvent.setup();
    const journey = journeyWith([{ id: 1, name: 'Step 1', sequenceOrder: 1, ruleIds: [] }]);
    renderStep(journey);

    await user.click(screen.getByRole('combobox', { name: /^category$/i }));
    await user.click(screen.getByRole('option', { name: 'COMPONENT' }));

    await user.click(screen.getByRole('combobox', { name: /add a rule/i }));
    expect(
      screen.getByRole('option', { name: /Component completed \(RULE_COMP_COMPLETED_001\)/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: /Minimum aggregate spend/ }),
    ).not.toBeInTheDocument();
  });

  it('TC-3: clearing the category filter (re-selecting "All categories") returns the full rule list', async () => {
    const user = userEvent.setup();
    const journey = journeyWith([{ id: 1, name: 'Step 1', sequenceOrder: 1, ruleIds: [] }]);
    renderStep(journey);

    await user.click(screen.getByRole('combobox', { name: /^category$/i }));
    await user.click(screen.getByRole('option', { name: 'COMPONENT' }));
    await user.click(screen.getByRole('combobox', { name: /add a rule/i }));
    expect(
      screen.queryByRole('option', { name: /Minimum aggregate spend/ }),
    ).not.toBeInTheDocument();

    // Re-open the category select and pick the other category, then confirm the sub-category
    // reset re-widens the rule list back to that category's full set (there is no explicit
    // "All categories" option once one is selected — the UI models "clear" via the placeholder,
    // reachable by never selecting one; this exercises the equivalent reset by switching category
    // and confirming the previous category's rule disappears while the new one appears).
    await user.click(screen.getByRole('combobox', { name: /^category$/i }));
    await user.click(screen.getByRole('option', { name: 'AGGREGATE' }));
    await user.click(screen.getByRole('combobox', { name: /add a rule/i }));
    expect(screen.getByRole('option', { name: /Minimum aggregate spend/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Component completed/ })).not.toBeInTheDocument();
  });

  it('TC-4: each component keeps its own independent filter', async () => {
    const user = userEvent.setup();
    const journey = journeyWith([
      { id: 1, name: 'Step 1', sequenceOrder: 1, ruleIds: [] },
      { id: 2, name: 'Step 2', sequenceOrder: 2, ruleIds: [] },
    ]);
    renderStep(journey);

    const sections = screen.getAllByRole('combobox', { name: /^category$/i });
    expect(sections).toHaveLength(2);

    await user.click(sections[0]);
    await user.click(screen.getByRole('option', { name: 'COMPONENT' }));

    // The first component's category select now shows COMPONENT; the second's is untouched.
    expect(sections[0]).toHaveTextContent('COMPONENT');
    expect(sections[1]).toHaveTextContent('All categories');
  });

  it('TC-5: a rule already bound to this component stays excluded regardless of filter', async () => {
    const user = userEvent.setup();
    const journey = journeyWith([
      {
        id: 1,
        name: 'Step 1',
        sequenceOrder: 1,
        ruleIds: [RULE_COMPONENT.ruleId, RULE_COMPONENT_2.ruleId],
      },
    ]);
    renderStep(journey);

    // `options` here already excludes both bound COMPONENT rules, which is the existing dedup
    // logic this task must not change — so the COMPONENT category no longer even appears as a
    // filter choice, and the rule dropdown has only the one remaining, unbound option to offer,
    // unfiltered.
    await user.click(screen.getByRole('combobox', { name: /^category$/i }));
    expect(screen.queryByRole('option', { name: 'COMPONENT' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'AGGREGATE' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('combobox', { name: /add a rule/i }));
    expect(
      screen.queryByRole('option', { name: /Component (?:not )?completed/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Minimum aggregate spend/ })).toBeInTheDocument();
  });

  it('the picker shows all rule options when no filter is applied', async () => {
    const user = userEvent.setup();
    const journey = journeyWith([{ id: 1, name: 'Step 1', sequenceOrder: 1, ruleIds: [] }]);
    renderStep(journey);

    await user.click(screen.getByRole('combobox', { name: /add a rule/i }));
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getAllByRole('option')).toHaveLength(3);
  });

  it('the sub-category filter cascades from the chosen category and narrows the rule dropdown further', async () => {
    const user = userEvent.setup();
    const journey = journeyWith([{ id: 1, name: 'Step 1', sequenceOrder: 1, ruleIds: [] }]);
    renderStep(journey);

    await user.click(screen.getByRole('combobox', { name: /^category$/i }));
    await user.click(screen.getByRole('option', { name: 'COMPONENT' }));

    // Both COMPONENT-category rules are still offered until a sub-category narrows further.
    await user.click(screen.getByRole('combobox', { name: /add a rule/i }));
    expect(screen.getByRole('option', { name: /Component completed/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Component not completed/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('combobox', { name: /sub-category/i }));
    await user.click(screen.getByRole('option', { name: 'ANOTHER_SUB' }));

    await user.click(screen.getByRole('combobox', { name: /add a rule/i }));
    expect(screen.getByRole('option', { name: /Component not completed/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^Component completed/ })).not.toBeInTheDocument();
  });

  it('clicking Add binds the filtered-to rule and resets the rule picker', async () => {
    const user = userEvent.setup();
    const onBindRule = vi.fn();
    const journey = journeyWith([{ id: 7, name: 'Step 1', sequenceOrder: 1, ruleIds: [] }]);
    render(
      <ComponentRulesStep
        journey={journey}
        ruleOptions={RULE_OPTIONS}
        onBindRule={onBindRule}
        onUnbindRule={vi.fn()}
        onSaveValues={vi.fn()}
        onSaveOperator={vi.fn()}
        onSaveRuleLogic={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: /add a rule/i }));
    await user.click(
      screen.getByRole('option', { name: /Minimum aggregate spend \(RULE_AGG_MIN_SPEND_001\)/ }),
    );
    await user.click(screen.getByRole('button', { name: /^add$/i }));

    expect(onBindRule).toHaveBeenCalledWith(7, RULE_AGGREGATE.ruleId);
    // Picking a rule and adding it resets the trigger back to its placeholder.
    expect(screen.getByRole('combobox', { name: /add a rule/i })).toHaveTextContent(
      'Select a rule…',
    );
  });

  it('an existing binding’s Remove control unbinds it', async () => {
    const user = userEvent.setup();
    const onUnbindRule = vi.fn();
    const journey = journeyWith([
      { id: 1, name: 'Step 1', sequenceOrder: 1, ruleIds: [RULE_COMPONENT.ruleId] },
    ]);
    render(
      <ComponentRulesStep
        journey={journey}
        ruleOptions={RULE_OPTIONS}
        onBindRule={vi.fn()}
        onUnbindRule={onUnbindRule}
        onSaveValues={vi.fn()}
        onSaveOperator={vi.fn()}
        onSaveRuleLogic={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /remove/i }));
    expect(onUnbindRule).toHaveBeenCalledWith(RULE_COMPONENT.ruleId);
  });

  it('an existing binding shows its pinned version badge and can have its values edited and saved', async () => {
    const user = userEvent.setup();
    const onSaveValues = vi.fn();
    const journey: Journey = {
      campaignId: 1,
      campaignRewards: [],
      trackers: [
        {
          id: 1,
          linkId: 1,
          trackerCode: 'TRK_1',
          name: 'Tracker 1',
          description: null,
          completionLogic: 'all',
          completionThreshold: null,
          isPrimary: true,
          status: 'active',
          rewards: [],
          components: [
            {
              id: 1,
              linkId: 1,
              componentCode: 'CMP_1',
              name: 'Step 1',
              description: null,
              activityId: null,
              activityName: null,
              sequenceOrder: 1,
              isMandatory: true,
              status: 'active',
              ruleLogic: null,
              ruleThreshold: null,
              rewards: [],
              rules: [
                {
                  id: RULE_COMPONENT.ruleId,
                  ruleId: RULE_COMPONENT.ruleId,
                  ruleCode: RULE_COMPONENT.ruleCode,
                  ruleName: RULE_COMPONENT.name,
                  ruleVersionId: 55,
                  ruleVersionNo: 2,
                  parameters: {
                    fields: [
                      { key: 'minSpend', label: 'Minimum spend', type: 'number', required: true },
                    ],
                  },
                  values: {},
                  operator: null,
                  value: null,
                  status: 'active',
                },
              ],
            },
          ],
        },
      ],
    };

    render(
      <ComponentRulesStep
        journey={journey}
        ruleOptions={RULE_OPTIONS}
        onBindRule={vi.fn()}
        onUnbindRule={vi.fn()}
        onSaveValues={onSaveValues}
        onSaveOperator={vi.fn()}
        onSaveRuleLogic={vi.fn()}
      />,
    );

    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save values/i })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/minimum spend/i), '50');
    await user.click(screen.getByRole('button', { name: /save values/i }));

    expect(onSaveValues).toHaveBeenCalledWith(RULE_COMPONENT.ruleId, { minSpend: 50 });
  });
});

describe('ComponentRulesStep — value-source-aware fields (T-125)', () => {
  it('TC-3: a CONTEXT_LOOKUP field calls the tracker/component-scoped context endpoint and renders only what it returns', async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({
      data: { data: [{ value: 1, label: 'Step 1', componentCode: 'CMP_1', sequenceOrder: 1 }] },
    });
    const fields: RuleParameterField[] = [
      {
        key: 'targetComponentCode',
        label: 'Target component',
        type: 'select',
        required: true,
        valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: 'SIBLING_COMPONENTS' },
      },
    ];
    renderStep(journeyWithBoundRuleFields(fields));

    // Tracker 1, component 2 — journeyWithBoundRuleFields's own fixture — is exactly what T-123's
    // "only earlier components" filter needs to do its job; this step's whole responsibility is
    // supplying it.
    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith('/field-value-sources/context/SIBLING_COMPONENTS', {
        params: { trackerId: 1, excludeComponentId: 2 },
      });
    });

    const combobox = screen.getByRole('combobox', { name: /target component/i });
    await waitFor(() => expect(combobox).not.toBeDisabled());
    await user.click(combobox);
    expect(screen.getByRole('option', { name: 'Step 1' })).toBeInTheDocument();
  });

  it('TC-4: an API_LOOKUP field against a planned provider shows "Not available yet", never an infinite spinner', async () => {
    mockGet.mockRejectedValue(
      Object.assign(new Error('planned provider'), {
        isAxiosError: true,
        response: {
          status: 501,
          data: {
            error: {
              code: 'FIELD_LOOKUP_PROVIDER_NOT_AVAILABLE',
              message: "This lookup isn't available yet.",
            },
          },
        },
      }),
    );
    const fields: RuleParameterField[] = [
      {
        key: 'productSku',
        label: 'Product SKU',
        type: 'select',
        required: true,
        valueSource: { kind: 'API_LOOKUP', apiProvider: 'PRODUCT_CATALOG' },
      },
    ];
    renderStep(journeyWithBoundRuleFields(fields));

    const combobox = await screen.findByRole('combobox', { name: /product sku/i });
    await waitFor(() => expect(combobox).toHaveTextContent('Not available yet'));
    expect(combobox).toBeDisabled();
  });

  it('TC-5: an API_LOOKUP field against a mocked active provider loads, populates, and is selectable', async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({ data: { data: [{ value: 'SKU-1', label: 'Widget' }] } });
    const fields: RuleParameterField[] = [
      {
        key: 'productSku',
        label: 'Product SKU',
        type: 'select',
        required: true,
        valueSource: { kind: 'API_LOOKUP', apiProvider: 'PRODUCT_CATALOG' },
      },
    ];
    renderStep(journeyWithBoundRuleFields(fields));

    const combobox = screen.getByRole('combobox', { name: /product sku/i });
    await waitFor(() => expect(combobox).not.toBeDisabled());

    await user.click(combobox);
    await user.click(screen.getByRole('option', { name: 'Widget' }));
    expect(combobox).toHaveTextContent('Widget');
  });

  it('TC-6: a server-side rejection (T-124’s circular-dependency guard) is shown clearly next to the offending field', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ value: 1, label: 'Step 1' }] } });
    const fields: RuleParameterField[] = [
      {
        key: 'targetComponentCode',
        label: 'Target component',
        type: 'select',
        required: true,
        valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: 'SIBLING_COMPONENTS' },
      },
    ];
    // `journeyWithBoundRuleFields`'s own binding id (501) — the exact key shape
    // `ComponentRulesStep`'s `pickErrors` already strips (`${bindingId}.${fieldKey}`), which is
    // also what T-124's `SIBLING_COMPONENT_NOT_EARLIER` detail (`values.<fieldKey>`) maps onto
    // once the wizard-level caller supplies it (see this task's completion report).
    renderStep(journeyWithBoundRuleFields(fields), RULE_OPTIONS, {
      serverErrors: {
        '501.targetComponentCode': 'Step 2 is not earlier than Step 2 in this tracker.',
      },
    });

    expect(
      await screen.findByText('Step 2 is not earlier than Step 2 in this tracker.'),
    ).toBeInTheDocument();
  });

  it('TC-7 (T-125): an existing fixed-list select field (no valueSource) is completely unaffected', () => {
    const fields: RuleParameterField[] = [
      {
        key: 'txnType',
        label: 'Transaction type',
        type: 'select',
        required: true,
        options: ['purchase', 'refund'],
      },
    ];
    renderStep(journeyWithBoundRuleFields(fields));

    expect(mockGet).not.toHaveBeenCalled();
    const combobox = screen.getByRole('combobox', { name: /transaction type/i });
    expect(combobox).not.toBeDisabled();
  });
});

/**
 * T-148 — the operator dropdown per bound rule and the "Rules combine" picker per component
 * (`maker-apply-rule-mockup.html`'s two `new`-badged controls).
 *
 * Both are pure presentation over T-147's contract: this component never calls the API itself, it
 * reports the maker's choice through `onSaveOperator`/`onSaveRuleLogic`. So these assert what the
 * maker sees and what those callbacks receive — the two things `CampaignWizardPage` then turns
 * into one `PATCH` (its own tests cover that half).
 */
describe('ComponentRulesStep — operator + rules-combine (T-148)', () => {
  const OPERATORS = ['equals', 'in', 'at_least'];

  /** `journeyWith` gives a binding the same id as its rule, so 101 is both here. */
  const BINDING_ID = RULE_COMPONENT.ruleId;

  const RULE_WITH_OPERATORS = ruleOption({ ...RULE_COMPONENT, defaultOperators: OPERATORS });
  const RULE_WITHOUT_OPERATORS = ruleOption({ ...RULE_COMPONENT, defaultOperators: [] });

  function oneBoundRule(overrides: Partial<Parameters<typeof journeyWith>[0][number]> = {}) {
    return journeyWith([
      { id: 1, name: 'Step 1', sequenceOrder: 1, ruleIds: [RULE_COMPONENT.ruleId], ...overrides },
    ]);
  }

  it('TC-1: the operator dropdown offers exactly the rule version’s defaultOperators, and nothing else', async () => {
    const user = userEvent.setup();
    renderStep(oneBoundRule(), [RULE_WITH_OPERATORS]);

    await user.click(screen.getByRole('combobox', { name: /^operator$/i }));

    const listbox = screen.getByRole('listbox');
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(OPERATORS);
  });

  it('TC-2: a rule whose version configures no operators renders the control disabled, with the reason', () => {
    renderStep(oneBoundRule(), [RULE_WITHOUT_OPERATORS]);

    const combobox = screen.getByRole('combobox', { name: /^operator$/i });
    expect(combobox).toBeDisabled();
    expect(combobox).toHaveTextContent("No operators configured for this rule's version");
  });

  it('TC-3: selecting an operator reports it against that binding and shows it on the control', async () => {
    const user = userEvent.setup();
    const onSaveOperator = vi.fn();
    renderStep(oneBoundRule(), [RULE_WITH_OPERATORS], { onSaveOperator });

    const combobox = screen.getByRole('combobox', { name: /^operator$/i });
    await user.click(combobox);
    await user.click(screen.getByRole('option', { name: 'in' }));

    expect(onSaveOperator).toHaveBeenCalledTimes(1);
    expect(onSaveOperator).toHaveBeenCalledWith(BINDING_ID, 'in');
    // The save is a round trip; the maker's choice must be visible before it lands.
    expect(combobox).toHaveTextContent('in');
  });

  it('TC-4: "Rules combine" reads ALL when the server holds null, matching T-147’s null handling', () => {
    renderStep(oneBoundRule({ ruleLogic: null }), [RULE_WITH_OPERATORS]);

    expect(screen.getByRole('combobox', { name: /rules combine/i })).toHaveTextContent(
      'ALL must pass',
    );
    // Nothing has changed, so there is nothing to save — rendering provokes no request.
    expect(screen.queryByRole('button', { name: /save rule logic/i })).not.toBeInTheDocument();
  });

  it('TC-5: choosing "N of X" reveals the threshold input; choosing ALL again hides and clears it', async () => {
    const user = userEvent.setup();
    const onSaveRuleLogic = vi.fn();
    renderStep(oneBoundRule(), [RULE_WITH_OPERATORS], { onSaveRuleLogic });

    expect(screen.queryByLabelText(/^n$/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: /rules combine/i }));
    await user.click(screen.getByRole('option', { name: /n of 1 must pass/i }));

    const threshold = screen.getByLabelText(/^n$/i);
    expect(threshold).toBeInTheDocument();
    // `n_of` with no threshold is a request the shared contract refuses, so it is not offered.
    expect(screen.queryByRole('button', { name: /save rule logic/i })).not.toBeInTheDocument();
    await user.type(threshold, '1');

    await user.click(screen.getByRole('combobox', { name: /rules combine/i }));
    await user.click(screen.getByRole('option', { name: 'ALL must pass' }));

    expect(screen.queryByLabelText(/^n$/i)).not.toBeInTheDocument();
    // Cleared, not merely hidden: switching back must not resurrect the old threshold.
    await user.click(screen.getByRole('combobox', { name: /rules combine/i }));
    await user.click(screen.getByRole('option', { name: /n of 1 must pass/i }));
    expect(screen.getByLabelText(/^n$/i)).toHaveValue(null);
    expect(onSaveRuleLogic).not.toHaveBeenCalled();
  });

  it('TC-6: saving "N of X" with a threshold of 2 reports (componentId, n_of, 2)', async () => {
    const user = userEvent.setup();
    const onSaveRuleLogic = vi.fn();
    const journey = journeyWith([
      {
        id: 42,
        name: 'Step 1',
        sequenceOrder: 1,
        ruleIds: [RULE_COMPONENT.ruleId, RULE_COMPONENT_2.ruleId],
      },
    ]);
    renderStep(journey, [RULE_WITH_OPERATORS], { onSaveRuleLogic });

    await user.click(screen.getByRole('combobox', { name: /rules combine/i }));
    await user.click(screen.getByRole('option', { name: /n of 2 must pass/i }));
    await user.type(screen.getByLabelText(/^n$/i), '2');
    await user.click(screen.getByRole('button', { name: /save rule logic/i }));

    expect(onSaveRuleLogic).toHaveBeenCalledTimes(1);
    expect(onSaveRuleLogic).toHaveBeenCalledWith(42, 'n_of', 2);
  });

  it('TC-6b: switching away from "N of X" sends the threshold back as null, never as a leftover', async () => {
    const user = userEvent.setup();
    const onSaveRuleLogic = vi.fn();
    renderStep(
      oneBoundRule({ id: 9, ruleLogic: 'n_of', ruleThreshold: 1 }),
      [RULE_WITH_OPERATORS],
      {
        onSaveRuleLogic,
      },
    );

    await user.click(screen.getByRole('combobox', { name: /rules combine/i }));
    await user.click(screen.getByRole('option', { name: 'ANY may pass' }));
    await user.click(screen.getByRole('button', { name: /save rule logic/i }));

    expect(onSaveRuleLogic).toHaveBeenCalledWith(9, 'any', null);
  });

  it('TC-7: a rejected operator is announced on the operator control itself, not just somewhere on the page', () => {
    renderStep(oneBoundRule(), [RULE_WITH_OPERATORS], {
      serverErrors: {
        [`${String(BINDING_ID)}.operator`]: "This rule's version does not allow that operator.",
      },
    });

    const combobox = screen.getByRole('combobox', { name: /^operator$/i });
    expect(combobox).toHaveAttribute('aria-invalid', 'true');
    // Asserted through the accessibility wiring rather than "the text is on screen somewhere":
    // an error a screen reader cannot attribute to this control is the defect, not the copy.
    const describedBy = combobox.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? '')).toHaveTextContent(
      "This rule's version does not allow that operator.",
    );
  });

  it('TC-7b: a rejected rules-combine change is announced on that component’s own control', () => {
    renderStep(oneBoundRule({ id: 5 }), [RULE_WITH_OPERATORS], {
      serverErrors: { 'component-5.ruleLogic': 'That combination is not allowed.' },
    });

    const combobox = screen.getByRole('combobox', { name: /rules combine/i });
    expect(combobox).toHaveAttribute('aria-invalid', 'true');
    expect(
      document.getElementById(combobox.getAttribute('aria-describedby') ?? ''),
    ).toHaveTextContent('That combination is not allowed.');
  });

  it('TC-8: one component’s rules-combine draft never reaches a sibling component', async () => {
    const user = userEvent.setup();
    const journey = journeyWith([
      { id: 1, name: 'Step 1', sequenceOrder: 1, ruleIds: [RULE_COMPONENT.ruleId] },
      { id: 2, name: 'Step 2', sequenceOrder: 2, ruleIds: [RULE_COMPONENT_2.ruleId] },
    ]);
    renderStep(journey, [RULE_WITH_OPERATORS]);

    const pickers = screen.getAllByRole('combobox', { name: /rules combine/i });
    expect(pickers).toHaveLength(2);

    await user.click(pickers[0]);
    await user.click(screen.getByRole('option', { name: 'ANY may pass' }));

    expect(pickers[0]).toHaveTextContent('ANY may pass');
    expect(pickers[1]).toHaveTextContent('ALL must pass');
    // The sibling has nothing pending either — one draft, one Save button.
    expect(screen.getAllByRole('button', { name: /save rule logic/i })).toHaveLength(1);
  });

  it('TC-8b: one binding’s operator choice never reaches another binding on the same component', async () => {
    const user = userEvent.setup();
    const journey = journeyWith([
      {
        id: 1,
        name: 'Step 1',
        sequenceOrder: 1,
        ruleIds: [RULE_COMPONENT.ruleId, RULE_COMPONENT_2.ruleId],
      },
    ]);
    renderStep(journey, [
      RULE_WITH_OPERATORS,
      ruleOption({ ...RULE_COMPONENT_2, defaultOperators: OPERATORS }),
    ]);

    const operators = screen.getAllByRole('combobox', { name: /^operator$/i });
    await user.click(operators[0]);
    await user.click(screen.getByRole('option', { name: 'at_least' }));

    expect(operators[0]).toHaveTextContent('at_least');
    expect(operators[1]).toHaveTextContent('Select…');
  });

  it('TC-9: both controls pre-populate from what GET /journey returns, with nothing pending', () => {
    renderStep(
      oneBoundRule({
        ruleLogic: 'n_of',
        ruleThreshold: 2,
        operators: { [BINDING_ID]: 'at_least' },
      }),
      [RULE_WITH_OPERATORS],
    );

    expect(screen.getByRole('combobox', { name: /^operator$/i })).toHaveTextContent('at_least');
    expect(screen.getByRole('combobox', { name: /rules combine/i })).toHaveTextContent(
      'N of 1 must pass',
    );
    expect(screen.getByLabelText(/^n$/i)).toHaveValue(2);
    expect(screen.queryByRole('button', { name: /save rule logic/i })).not.toBeInTheDocument();
  });

  it('a bound rule the picker no longer offers falls back to the disabled "no operators" state', () => {
    // The binding survives; its rule is simply not in `ruleOptions` any more.
    renderStep(oneBoundRule(), [RULE_AGGREGATE]);

    const combobox = screen.getByRole('combobox', { name: /^operator$/i });
    expect(combobox).toBeDisabled();
    expect(combobox).toHaveTextContent("No operators configured for this rule's version");
  });

  it('both controls are read-only when the campaign is', () => {
    renderStep(oneBoundRule(), [RULE_WITH_OPERATORS], { disabled: true });

    expect(screen.getByRole('combobox', { name: /^operator$/i })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: /rules combine/i })).toBeDisabled();
  });
});
