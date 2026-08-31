import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const {
  mockMutateAsync,
  mockUseCreateRuleMutation,
  mockUseFieldApiLookupProvidersQuery,
  mockUseFieldContextProvidersQuery,
  mockUseRuleCategoriesQuery,
  mockUseRuleResolversQuery,
  mockUseRuleSubCategoriesQuery,
} = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseCreateRuleMutation: vi.fn(),
  mockUseFieldApiLookupProvidersQuery: vi.fn(),
  mockUseFieldContextProvidersQuery: vi.fn(),
  mockUseRuleCategoriesQuery: vi.fn(),
  mockUseRuleResolversQuery: vi.fn(),
  mockUseRuleSubCategoriesQuery: vi.fn(),
}));

vi.mock('./api', () => ({
  useCreateRuleMutation: mockUseCreateRuleMutation,
  useFieldApiLookupProvidersQuery: mockUseFieldApiLookupProvidersQuery,
  useFieldContextProvidersQuery: mockUseFieldContextProvidersQuery,
  useRuleCategoriesQuery: mockUseRuleCategoriesQuery,
  useRuleResolversQuery: mockUseRuleResolversQuery,
  useRuleSubCategoriesQuery: mockUseRuleSubCategoriesQuery,
}));

import { AddRuleModal } from './AddRuleModal';

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AddRuleModal open onClose={onClose} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseCreateRuleMutation.mockReset();
  mockUseCreateRuleMutation.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
  mockUseRuleCategoriesQuery.mockReturnValue({
    data: [{ id: 13, categoryCode: 'TRANSACTION', name: 'TRANSACTION', status: 'active' }],
  });
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
      {
        id: 2,
        resolverCode: 'JSONPATH_PAYLOAD',
        name: 'JSON path payload',
        description: null,
        status: 'active',
        resolverInputFieldKeys: [],
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
  mockUseFieldApiLookupProvidersQuery.mockReturnValue({
    data: [
      {
        id: 1,
        providerCode: 'PRODUCT_CATALOG',
        name: 'Product catalog',
        description: null,
        endpointUrl: 'PLACEHOLDER',
        httpMethod: 'GET',
        authType: 'none',
        responseValueKey: 'id',
        responseLabelKey: 'name',
        status: 'planned',
      },
    ],
  });
});

describe('AddRuleModal', () => {
  // T-160 TC-1/TC-2 — modal width and the Parameter Fields help text restored from the mockup.
  it('renders at the wider "xl" Modal size, not the cramped default', () => {
    renderModal();

    expect(screen.getByRole('dialog', { name: /add rule/i })).toHaveClass('max-w-4xl');
  });

  it('renders the Parameter Fields heading and "Role matters" help text from the mockup', () => {
    renderModal();

    expect(screen.getByText(/parameter fields/i, { selector: 'h3' })).toBeInTheDocument();
    expect(
      screen.getByText(/what the maker fills in when applying this rule to a tracker component/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/role matters:/i)).toBeInTheDocument();
    expect(screen.getByText('Compared value', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('Resolver input', { selector: 'strong' })).toBeInTheDocument();
  });

  it('rejects a too-short rule code before calling the API — the shared Zod schema catches it client-side', async () => {
    const user = userEvent.setup();
    renderModal();

    // `createRuleRequestSchema.ruleCode` requires at least 2 characters; the full
    // upper-snake-case pattern is server-side only (`IsRuleCode`), matching the same split
    // `AddCountryModal.test.tsx` documents for `code`'s ISO whitelist.
    await user.type(screen.getByLabelText(/rule code/i), 'X');
    await user.type(screen.getByLabelText(/^name$/i), 'Minimum spend');
    await user.click(screen.getByRole('combobox', { name: /^category$/i }));
    await user.click(screen.getByRole('option', { name: 'TRANSACTION' }));
    await user.click(screen.getByRole('combobox', { name: /sub-category/i }));
    await user.click(screen.getByRole('option', { name: 'General' }));
    await user.click(screen.getByRole('button', { name: /create rule/i }));

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('submits a valid rule with no parameters', async () => {
    mockMutateAsync.mockResolvedValue({
      id: 1,
      ruleCode: 'MIN_SPEND_TIER',
      name: 'Minimum spend tier',
      categoryId: 13,
      categoryName: 'TRANSACTION',
      subCategoryId: 13,
      subCategoryName: 'General',
      expression: null,
      parameters: { fields: [] },
      status: 'active',
      createdBy: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/rule code/i), 'MIN_SPEND_TIER');
    await user.type(screen.getByLabelText(/^name$/i), 'Minimum spend tier');

    await user.click(screen.getByRole('combobox', { name: /^category$/i }));
    await user.click(screen.getByRole('option', { name: 'TRANSACTION' }));
    await user.click(screen.getByRole('combobox', { name: /sub-category/i }));
    await user.click(screen.getByRole('option', { name: 'General' }));

    await user.click(screen.getByRole('button', { name: /create rule/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleCode: 'MIN_SPEND_TIER',
        name: 'Minimum spend tier',
        subCategoryId: 13,
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('adds a parameter field through the embedded ParameterFieldsEditor and includes it on submit', async () => {
    mockMutateAsync.mockResolvedValue({
      id: 1,
      ruleCode: 'X',
      name: 'x',
      categoryId: 13,
      categoryName: 'TRANSACTION',
      subCategoryId: 13,
      subCategoryName: 'General',
      expression: null,
      parameters: { fields: [] },
      status: 'active',
      createdBy: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/rule code/i), 'MIN_SPEND_TIER');
    await user.type(screen.getByLabelText(/^name$/i), 'Minimum spend tier');
    await user.click(screen.getByRole('combobox', { name: /^category$/i }));
    await user.click(screen.getByRole('option', { name: 'TRANSACTION' }));
    await user.click(screen.getByRole('combobox', { name: /sub-category/i }));
    await user.click(screen.getByRole('option', { name: 'General' }));

    await user.click(screen.getByRole('button', { name: /add field/i }));
    await user.type(screen.getByPlaceholderText('minSpend'), 'minSpend');
    await user.type(screen.getByPlaceholderText('Minimum spend'), 'Minimum spend');

    await user.click(screen.getByRole('button', { name: /create rule/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        parameters: { fields: [expect.objectContaining({ key: 'minSpend' })] },
      }),
    );
  });

  // T-115 — the resolver-driven parameter-field role badge, computed client-side from `GET
  // /rule-resolvers` (T-108/T-114), never a manually-chosen value.
  describe('resolver-driven field role badge (T-115)', () => {
    it('TC-1: badges a field named after the previewed resolver’s input key "Resolver input"', async () => {
      const user = userEvent.setup();
      renderModal();

      await user.click(screen.getByRole('combobox', { name: /resolver/i }));
      await user.click(screen.getByRole('option', { name: /tracker state lookup/i }));

      await user.click(screen.getByRole('button', { name: /add field/i }));
      await user.type(screen.getByPlaceholderText('minSpend'), 'targetComponentCode');

      // `{ selector: 'span' }` targets the read-only role `Badge` specifically — T-160 added a
      // static "Role matters: **Compared value** / **Resolver input**" help paragraph (rendered
      // as `<strong>`) that shares this exact wording.
      expect(screen.getByText('Resolver input', { selector: 'span' })).toBeInTheDocument();
    });

    it('TC-2: badges every other field key "Compared value" under the same resolver', async () => {
      const user = userEvent.setup();
      renderModal();

      await user.click(screen.getByRole('combobox', { name: /resolver/i }));
      await user.click(screen.getByRole('option', { name: /tracker state lookup/i }));

      await user.click(screen.getByRole('button', { name: /add field/i }));
      await user.type(screen.getByPlaceholderText('minSpend'), 'value');

      expect(screen.getByText('Compared value', { selector: 'span' })).toBeInTheDocument();
      expect(screen.queryByText('Resolver input', { selector: 'span' })).not.toBeInTheDocument();
    });

    it('TC-3: switching the previewed resolver recomputes every badge immediately', async () => {
      const user = userEvent.setup();
      renderModal();

      await user.click(screen.getByRole('combobox', { name: /resolver/i }));
      await user.click(screen.getByRole('option', { name: /tracker state lookup/i }));
      await user.click(screen.getByRole('button', { name: /add field/i }));
      await user.type(screen.getByPlaceholderText('minSpend'), 'targetComponentCode');
      expect(screen.getByText('Resolver input', { selector: 'span' })).toBeInTheDocument();

      await user.click(screen.getByRole('combobox', { name: /resolver/i }));
      await user.click(screen.getByRole('option', { name: /json path payload/i }));

      expect(screen.queryByText('Resolver input', { selector: 'span' })).not.toBeInTheDocument();
      expect(screen.getByText('Compared value', { selector: 'span' })).toBeInTheDocument();
    });

    it('TC-4: the create-rule request payload never carries a `role` key on any field', async () => {
      mockMutateAsync.mockResolvedValue({
        id: 1,
        ruleCode: 'MIN_SPEND_TIER',
        name: 'Minimum spend tier',
        categoryId: 13,
        categoryName: 'TRANSACTION',
        subCategoryId: 13,
        subCategoryName: 'General',
        expression: null,
        parameters: { fields: [] },
        status: 'active',
        createdBy: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      const user = userEvent.setup();
      renderModal();

      await user.type(screen.getByLabelText(/rule code/i), 'MIN_SPEND_TIER');
      await user.type(screen.getByLabelText(/^name$/i), 'Minimum spend tier');
      await user.click(screen.getByRole('combobox', { name: /^category$/i }));
      await user.click(screen.getByRole('option', { name: 'TRANSACTION' }));
      await user.click(screen.getByRole('combobox', { name: /sub-category/i }));
      await user.click(screen.getByRole('option', { name: 'General' }));

      await user.click(screen.getByRole('combobox', { name: /resolver/i }));
      await user.click(screen.getByRole('option', { name: /tracker state lookup/i }));
      await user.click(screen.getByRole('button', { name: /add field/i }));
      await user.type(screen.getByPlaceholderText('minSpend'), 'targetComponentCode');
      await user.type(screen.getByPlaceholderText('Minimum spend'), 'Target component');

      await user.click(screen.getByRole('button', { name: /create rule/i }));

      const [[submitted]] = mockMutateAsync.mock.calls as [
        [{ parameters?: { fields: unknown[] } }],
      ];
      expect(submitted.parameters?.fields).toHaveLength(1);
      for (const field of submitted.parameters?.fields ?? []) {
        expect(field).not.toHaveProperty('role');
      }
    });
  });

  // T-125 — the field builder's "Where do the options come from?" value-source picker.
  describe('value-source picker (T-125)', () => {
    it('TC-1: marking a select field "This journey" submits the CONTEXT_LOOKUP shape T-122 accepts', async () => {
      mockMutateAsync.mockResolvedValue({
        id: 1,
        ruleCode: 'MIN_SPEND_TIER',
        name: 'Minimum spend tier',
        categoryId: 13,
        categoryName: 'TRANSACTION',
        subCategoryId: 13,
        subCategoryName: 'General',
        expression: null,
        parameters: { fields: [] },
        status: 'active',
        createdBy: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      const user = userEvent.setup();
      renderModal();

      await user.type(screen.getByLabelText(/rule code/i), 'MIN_SPEND_TIER');
      await user.type(screen.getByLabelText(/^name$/i), 'Minimum spend tier');
      await user.click(screen.getByRole('combobox', { name: /^category$/i }));
      await user.click(screen.getByRole('option', { name: 'TRANSACTION' }));
      await user.click(screen.getByRole('combobox', { name: /sub-category/i }));
      await user.click(screen.getByRole('option', { name: 'General' }));

      await user.click(screen.getByRole('button', { name: /add field/i }));
      await user.type(screen.getByPlaceholderText('minSpend'), 'targetComponentCode');
      await user.type(screen.getByPlaceholderText('Minimum spend'), 'Target component');
      await user.click(screen.getByRole('combobox', { name: /^type$/i }));
      await user.click(screen.getByRole('option', { name: 'Choice list' }));

      await user.click(screen.getByRole('combobox', { name: /where do the options come from/i }));
      await user.click(screen.getByRole('option', { name: 'This journey' }));
      await user.click(screen.getByRole('combobox', { name: /journey source/i }));
      await user.click(screen.getByRole('option', { name: 'Sibling components' }));

      await user.click(screen.getByRole('button', { name: /create rule/i }));

      expect(mockMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          parameters: {
            fields: [
              expect.objectContaining({
                key: 'targetComponentCode',
                type: 'select',
                valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: 'SIBLING_COMPONENTS' },
              }),
            ],
          },
        }),
      );
    });

    it('TC-2: a `planned` API lookup provider is clearly labelled and still selectable', async () => {
      const user = userEvent.setup();
      renderModal();

      await user.click(screen.getByRole('button', { name: /add field/i }));
      await user.click(screen.getByRole('combobox', { name: /^type$/i }));
      await user.click(screen.getByRole('option', { name: 'Choice list' }));

      await user.click(screen.getByRole('combobox', { name: /where do the options come from/i }));
      await user.click(screen.getByRole('option', { name: 'Live lookup' }));

      const providerPicker = screen.getByRole('combobox', { name: /live-lookup provider/i });
      expect(providerPicker).toHaveTextContent('Product catalog (not available yet)');

      await user.click(providerPicker);
      const option = screen.getByRole('option', { name: /product catalog \(not available yet\)/i });
      expect(option).not.toHaveAttribute('aria-disabled');
      await user.click(option);

      expect(providerPicker).toHaveTextContent('Product catalog (not available yet)');
    });
  });
});
