import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RewardVersion, RuleOperator, RuleResolver, RuleVersion } from '@reward-portal/shared';
import { ApiError } from '../../lib/apiError';

const {
  mockMutateAsync,
  mockUseUpdateDraftMutation,
  mockUseRuleResolversQuery,
  mockUseRuleOperatorsQuery,
} = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseUpdateDraftMutation: vi.fn(),
  mockUseRuleResolversQuery: vi.fn(),
  mockUseRuleOperatorsQuery: vi.fn(),
}));

vi.mock('./api', () => ({ useUpdateDraftMutation: mockUseUpdateDraftMutation }));
vi.mock('../rules/api', () => ({
  useRuleResolversQuery: mockUseRuleResolversQuery,
  useRuleOperatorsQuery: mockUseRuleOperatorsQuery,
}));

import { EditVersionDraftModal } from './EditVersionDraftModal';

const resolvers: RuleResolver[] = [
  {
    id: 1,
    resolverCode: 'TRACKER_STATE_LOOKUP',
    name: 'Tracker State Lookup',
    description: null,
    status: 'active',
    resolverInputFieldKeys: ['targetComponentCode'],
  },
  {
    id: 2,
    resolverCode: 'JSONPATH_PAYLOAD',
    name: 'JSON Path Payload',
    description: null,
    status: 'active',
    resolverInputFieldKeys: [],
  },
];

const operators: RuleOperator[] = [
  {
    id: 1,
    operatorCode: 'equals',
    displayName: 'Equals',
    expectedValueType: 'string',
    status: 'active',
  },
  {
    id: 2,
    operatorCode: 'not_equals',
    displayName: 'Not Equals',
    expectedValueType: 'string',
    status: 'active',
  },
  { id: 3, operatorCode: 'in', displayName: 'In', expectedValueType: 'array', status: 'active' },
];

const ruleVersion: RuleVersion = {
  id: 10,
  ruleId: 1,
  versionNo: 2,
  expression: 'amount >= :minSpend',
  parameters: { fields: [] },
  changeSummary: 'Adds a tier',
  isBreaking: false,
  status: 'draft',
  supersedesVersionId: 9,
  originRequestId: null,
  createdBy: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  publishedBy: null,
  publishedAt: null,
  deprecatedAt: null,
  retiredAt: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  suggestedIsBreaking: null,
  // T-110 — a seeded, already-wired draft (mirrors RULE_COMP_COMPLETED_001 from T-105).
  resolverId: 1,
  resolverConfig: { statusKey: 'status' },
  evaluationContext: 'tracker_state',
  defaultOperators: ['equals', 'not_equals', 'in'],
};

const rewardVersion: RewardVersion = {
  id: 20,
  rewardId: 1,
  versionNo: 1,
  connectorConfig: { endpoint: 'https://example.invalid' },
  deliveryMode: 'sync',
  retryConfig: {},
  policiesSnapshot: null,
  unitType: null,
  unitCode: null,
  changeSummary: null,
  isBreaking: false,
  status: 'draft',
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

function renderModal(
  version: RuleVersion | RewardVersion,
  entityType: 'rule' | 'reward',
  onClose = vi.fn(),
) {
  return render(
    <EditVersionDraftModal
      open
      onClose={onClose}
      entityType={entityType}
      entityId={1}
      version={version}
    />,
  );
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseUpdateDraftMutation.mockReset();
  mockUseUpdateDraftMutation.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
  mockUseRuleResolversQuery.mockReset();
  mockUseRuleResolversQuery.mockReturnValue({ data: resolvers });
  mockUseRuleOperatorsQuery.mockReset();
  mockUseRuleOperatorsQuery.mockReturnValue({ data: operators });
});

describe('EditVersionDraftModal', () => {
  it('renders the rule expression field and pre-fills the JSON payload from parameters', () => {
    renderModal(ruleVersion, 'rule');
    expect(screen.getByText(/Edit draft v2/)).toBeInTheDocument();
    expect(screen.getByLabelText(/expression/i)).toHaveValue('amount >= :minSpend');
    expect(screen.getByLabelText(/parameters \(json\)/i)).toHaveValue(
      JSON.stringify(ruleVersion.parameters, null, 2),
    );
  });

  it('renders the reward connectorConfig field instead of an expression field', () => {
    renderModal(rewardVersion, 'reward');
    expect(screen.queryByLabelText(/^expression$/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/connector config \(json\)/i)).toHaveValue(
      JSON.stringify(rewardVersion.connectorConfig, null, 2),
    );
  });

  it('T-110 TC-1: pre-fills resolver wiring from a seeded, already-wired draft', () => {
    renderModal(ruleVersion, 'rule');

    // `Select`/`MultiSelect` triggers self-reference their own id in `aria-labelledby`
    // (alongside the `<label>`'s id) — the accname algorithm's recursion guard against that
    // self-reference means the *accessible name* is only ever the field's label ("Resolver"),
    // never the selected value too; the selected value is asserted via `textContent` instead.
    expect(screen.getByRole('combobox', { name: /^resolver$/i })).toHaveTextContent(
      'Tracker State Lookup (TRACKER_STATE_LOOKUP)',
    );
    expect(screen.getByLabelText(/resolver config \(json\)/i)).toHaveValue(
      JSON.stringify(ruleVersion.resolverConfig, null, 2),
    );
    expect(screen.getByRole('combobox', { name: /^evaluation context$/i })).toHaveTextContent(
      'Tracker state',
    );
    expect(screen.getByRole('button', { name: /^default operators$/i })).toHaveTextContent(
      '3 selected',
    );
  });

  it('T-110 TC-2: changing the resolver and saving sends the new resolverId', async () => {
    mockMutateAsync.mockResolvedValue(ruleVersion);
    const user = userEvent.setup();
    renderModal(ruleVersion, 'rule');

    await user.click(screen.getByRole('combobox', { name: /^resolver/i }));
    await user.click(screen.getByRole('option', { name: /json path payload/i }));
    await user.click(screen.getByRole('button', { name: /save draft/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ resolverId: 2 }));
  });

  it('T-110 TC-3: toggling an operator off and saving persists the remaining array', async () => {
    mockMutateAsync.mockResolvedValue(ruleVersion);
    const user = userEvent.setup();
    renderModal(ruleVersion, 'rule');

    await user.click(screen.getByRole('button', { name: /default operators/i }));
    await user.click(screen.getByRole('option', { name: /^in$/i }));
    await user.click(screen.getByRole('button', { name: /save draft/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ defaultOperators: ['equals', 'not_equals'] }),
    );
  });

  it('T-110 TC-4: a reward draft renders no resolver-wiring fields', () => {
    renderModal(rewardVersion, 'reward');

    expect(screen.queryByRole('combobox', { name: /^resolver/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/resolver config/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /evaluation context/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /default operators/i })).not.toBeInTheDocument();
  });

  it('T-110: clearing resolver/context back to "None" saves the draft inert again', async () => {
    mockMutateAsync.mockResolvedValue(ruleVersion);
    const user = userEvent.setup();
    renderModal(ruleVersion, 'rule');

    await user.click(screen.getByRole('combobox', { name: /^resolver$/i }));
    await user.click(screen.getByRole('option', { name: /^none/i }));
    await user.click(screen.getByRole('combobox', { name: /^evaluation context$/i }));
    await user.click(screen.getByRole('option', { name: /^none$/i }));
    const resolverConfig = screen.getByLabelText(/resolver config \(json\)/i);
    await user.clear(resolverConfig);

    await user.click(screen.getByRole('button', { name: /save draft/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        resolverId: null,
        resolverConfig: null,
        evaluationContext: null,
      }),
    );
  });

  it('TC-3: submits an edited rule draft', async () => {
    mockMutateAsync.mockResolvedValue({ ...ruleVersion, changeSummary: 'Updated' });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(ruleVersion, 'rule', onClose);

    const summary = screen.getByLabelText(/change summary/i);
    await user.clear(summary);
    await user.type(summary, 'Updated');
    await user.click(screen.getByRole('button', { name: /save draft/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ changeSummary: 'Updated', isBreaking: false }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('submits a reward draft edit with connectorConfig, not expression/parameters', async () => {
    mockMutateAsync.mockResolvedValue(rewardVersion);
    const user = userEvent.setup();
    renderModal(rewardVersion, 'reward');

    await user.click(screen.getByRole('button', { name: /save draft/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ connectorConfig: rewardVersion.connectorConfig }),
    );
  });

  it('rejects invalid JSON in the payload textarea without submitting', async () => {
    const user = userEvent.setup();
    renderModal(ruleVersion, 'rule');

    const payload = screen.getByLabelText(/parameters \(json\)/i);
    await user.clear(payload);
    await user.type(payload, '{{not json');
    await user.click(screen.getByRole('button', { name: /save draft/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/must be valid json/i);
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('implementation note 9: a breaking-confirmation-required error surfaces the override checkbox', async () => {
    mockMutateAsync.mockRejectedValueOnce(
      new ApiError({
        status: 422,
        code: 'VERSION_BREAKING_CONFIRMATION_REQUIRED',
        message: 'Confirm the breaking override.',
      }),
    );
    const user = userEvent.setup();
    renderModal(ruleVersion, 'rule');

    await user.click(screen.getByRole('button', { name: /save draft/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/disagrees with your is_breaking/i);
    expect(screen.getByRole('checkbox', { name: /i have reviewed the diff/i })).toBeInTheDocument();
  });

  it('a generic API failure shows its message and does not close the modal', async () => {
    mockMutateAsync.mockRejectedValueOnce(
      new ApiError({ status: 409, code: 'VERSION_INVALID_TRANSITION', message: 'Not a draft.' }),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(ruleVersion, 'rule', onClose);

    await user.click(screen.getByRole('button', { name: /save draft/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Not a draft.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cancelling closes the modal without submitting', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(ruleVersion, 'rule', onClose);

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onClose).toHaveBeenCalled();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('toggling breaking change off clears a pending override confirmation', async () => {
    mockMutateAsync.mockRejectedValueOnce(
      new ApiError({
        status: 422,
        code: 'VERSION_BREAKING_CONFIRMATION_REQUIRED',
        message: 'Confirm.',
      }),
    );
    const user = userEvent.setup();
    renderModal(ruleVersion, 'rule');

    await user.click(screen.getByRole('button', { name: /save draft/i }));
    expect(
      await screen.findByRole('checkbox', { name: /i have reviewed the diff/i }),
    ).toBeChecked();

    await user.click(screen.getByRole('switch', { name: /breaking change/i }));
    expect(
      screen.queryByRole('checkbox', { name: /i have reviewed the diff/i }),
    ).not.toBeInTheDocument();
  });
});
