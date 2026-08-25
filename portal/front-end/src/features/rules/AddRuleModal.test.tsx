import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const {
  mockMutateAsync,
  mockUseCreateRuleMutation,
  mockUseRuleCategoriesQuery,
  mockUseRuleSubCategoriesQuery,
} = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseCreateRuleMutation: vi.fn(),
  mockUseRuleCategoriesQuery: vi.fn(),
  mockUseRuleSubCategoriesQuery: vi.fn(),
}));

vi.mock('./api', () => ({
  useCreateRuleMutation: mockUseCreateRuleMutation,
  useRuleCategoriesQuery: mockUseRuleCategoriesQuery,
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
});

describe('AddRuleModal', () => {
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
});
