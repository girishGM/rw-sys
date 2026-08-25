import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Rule } from '@reward-portal/shared';

const { mockMutateAsync, mockUseUpdateRuleMutation, mockUseRuleSubCategoriesQuery } = vi.hoisted(
  () => ({
    mockMutateAsync: vi.fn(),
    mockUseUpdateRuleMutation: vi.fn(),
    mockUseRuleSubCategoriesQuery: vi.fn(),
  }),
);

vi.mock('./api', () => ({
  useUpdateRuleMutation: mockUseUpdateRuleMutation,
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
});
