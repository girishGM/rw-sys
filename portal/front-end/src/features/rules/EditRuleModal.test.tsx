import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Rule } from '@reward-portal/shared';

const {
  mockMutateAsync,
  mockUseFieldApiLookupProvidersQuery,
  mockUseFieldContextProvidersQuery,
  mockUseUpdateRuleMutation,
  mockUseRuleResolversQuery,
  mockUseRuleSubCategoriesQuery,
} = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseFieldApiLookupProvidersQuery: vi.fn(),
  mockUseFieldContextProvidersQuery: vi.fn(),
  mockUseUpdateRuleMutation: vi.fn(),
  mockUseRuleResolversQuery: vi.fn(),
  mockUseRuleSubCategoriesQuery: vi.fn(),
}));

vi.mock('./api', () => ({
  useUpdateRuleMutation: mockUseUpdateRuleMutation,
  useFieldApiLookupProvidersQuery: mockUseFieldApiLookupProvidersQuery,
  useFieldContextProvidersQuery: mockUseFieldContextProvidersQuery,
  useRuleResolversQuery: mockUseRuleResolversQuery,
  useRuleSubCategoriesQuery: mockUseRuleSubCategoriesQuery,
}));

import { EditRuleModal } from './EditRuleModal';

const rule: Rule = {
  id: 1,
  ruleCode: 'MIN_SPEND_TIER',
  name: 'Minimum spend tier',
  categoryId: 13,
  categoryName: 'TRANSACTION',
  subCategoryId: 13,
  subCategoryName: 'General',
  expression: 'amount >= :minSpend',
  parameters: { fields: [] },
  status: 'active',
  createdBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EditRuleModal open onClose={onClose} rule={rule} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseUpdateRuleMutation.mockReset();
  mockUseUpdateRuleMutation.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
  mockUseRuleSubCategoriesQuery.mockReturnValue({
    data: [
      { id: 13, categoryId: 13, subCategoryCode: 'GENERAL', name: 'General', status: 'active' },
    ],
  });
  mockUseRuleResolversQuery.mockReturnValue({
    data: [
      {
        id: 1,
        resolverCode: 'TRACKER_STATE_LOOKUP',
        name: 'Tracker state lookup',
        description: null,
        status: 'active',
        resolverInputFieldKeys: ['targetComponentCode'],
      },
    ],
  });
  mockUseFieldContextProvidersQuery.mockReturnValue({
    data: [
      {
        id: 1,
        providerCode: 'SIBLING_COMPONENTS',
        name: 'Sibling components',
        description: null,
        status: 'active',
      },
    ],
  });
  mockUseFieldApiLookupProvidersQuery.mockReturnValue({ data: [] });
});

describe('EditRuleModal', () => {
  it('does not render ruleCode as an editable field — immutable (matches UpdateRuleDto)', () => {
    renderModal();
    expect(screen.queryByLabelText(/rule code/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Edit MIN_SPEND_TIER/)).toBeInTheDocument();
  });

  it('TC-19: submits a name change', async () => {
    mockMutateAsync.mockResolvedValue({ ...rule, name: 'New name' });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    const nameInput = screen.getByLabelText(/^name$/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'New name');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New name', status: 'active' }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('TC-22: submits a status change to inactive', async () => {
    mockMutateAsync.mockResolvedValue({ ...rule, status: 'inactive' });
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('combobox', { name: /status/i }));
    await user.click(screen.getByRole('option', { name: 'Inactive' }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ status: 'inactive' }));
  });

  // T-114 — `rule.parameters.fields` is the response shape: every field carries a
  // server-computed `role`. Seeding this modal's editable state directly from that response
  // must not leak `role` back into the PATCH body — `updateRuleRequestSchema` still 400s on it
  // (its own `.strict()`, unchanged by T-114) — so a rule that already has parameters must
  // still be editable and saveable at all.
  it('T-114: strips the response-only role before resubmitting existing parameter fields', async () => {
    const ruleWithParameters: Rule = {
      ...rule,
      parameters: {
        fields: [
          {
            key: 'minSpend',
            label: 'Minimum spend',
            type: 'number',
            required: true,
            role: 'compare_value',
          },
        ],
      },
    };
    mockMutateAsync.mockResolvedValue(ruleWithParameters);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <EditRuleModal open onClose={vi.fn()} rule={ruleWithParameters} />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        parameters: {
          fields: [{ key: 'minSpend', label: 'Minimum spend', type: 'number', required: true }],
        },
      }),
    );
    const [[submitted]] = mockMutateAsync.mock.calls as [[{ parameters: { fields: unknown[] } }]];
    expect(submitted.parameters.fields[0]).not.toHaveProperty('role');
  });

  // T-115 — the same preview-only Resolver picker `AddRuleModal.test.tsx` covers; here it must
  // also recompute against a field seeded from an already-saved rule (role stripped by
  // `toEditableFields`, so the preview is the only source of a badge in this form).
  it('T-115: previewing a resolver badges an existing field named after its input key', async () => {
    const ruleWithParameters: Rule = {
      ...rule,
      parameters: {
        fields: [
          {
            key: 'targetComponentCode',
            label: 'Target component',
            type: 'string',
            required: true,
            role: 'compare_value',
          },
        ],
      },
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <EditRuleModal open onClose={vi.fn()} rule={ruleWithParameters} />
      </QueryClientProvider>,
    );

    // `{ selector: 'span' }` targets the read-only role `Badge` specifically — T-160
    // (`ParameterFieldsEditor`, shared by this modal) added a static "Role matters: **Compared
    // value** / **Resolver input**" help paragraph (rendered as `<strong>`) with this same wording.
    expect(screen.getByText('Compared value', { selector: 'span' })).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: /resolver/i }));
    await user.click(screen.getByRole('option', { name: /tracker state lookup/i }));

    expect(screen.getByText('Resolver input', { selector: 'span' })).toBeInTheDocument();
    expect(screen.queryByText('Compared value', { selector: 'span' })).not.toBeInTheDocument();
  });

  // T-125 — the same field-builder value-source picker `AddRuleModal.test.tsx` covers; this only
  // confirms `EditRuleModal` wires the two provider queries through to the shared editor.
  it('T-125: an existing select field can be switched to "This journey"', async () => {
    const ruleWithSelectField: Rule = {
      ...rule,
      parameters: {
        fields: [
          {
            key: 'targetComponentCode',
            label: 'Target component',
            type: 'select',
            required: true,
            options: ['a', 'b'],
            role: 'compare_value',
          },
        ],
      },
    };
    mockMutateAsync.mockResolvedValue(ruleWithSelectField);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <EditRuleModal open onClose={vi.fn()} rule={ruleWithSelectField} />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole('combobox', { name: /where do the options come from/i }));
    await user.click(screen.getByRole('option', { name: 'This journey' }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        parameters: {
          fields: [
            expect.objectContaining({
              key: 'targetComponentCode',
              valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: 'SIBLING_COMPONENTS' },
            }),
          ],
        },
      }),
    );
  });
});
