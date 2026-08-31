/**
 * T-162 TC-2/TC-4 — `EditContextProviderModal` (`PATCH /field-context-providers/:id`).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FieldContextProvider } from '@reward-portal/shared';
import { ApiError } from '../../lib/apiError';

const { mockMutateAsync, mockUseUpdateFieldContextProviderMutation } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseUpdateFieldContextProviderMutation: vi.fn(),
}));

vi.mock('./api', () => ({
  useUpdateFieldContextProviderMutation: mockUseUpdateFieldContextProviderMutation,
}));

import { EditContextProviderModal } from './EditContextProviderModal';

const provider: FieldContextProvider = {
  id: 1,
  providerCode: 'SIBLING_COMPONENTS',
  name: 'Sibling components',
  description: 'Every other tracker component already defined in the campaign draft.',
  status: 'active',
};

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EditContextProviderModal open onClose={onClose} provider={provider} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseUpdateFieldContextProviderMutation.mockReset();
  mockUseUpdateFieldContextProviderMutation.mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  });
});

describe('EditContextProviderModal', () => {
  it('never renders providerCode as an editable field — the immutable identifier T-122 relies on', () => {
    renderModal();

    expect(screen.queryByLabelText(/provider code/i)).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /edit sibling_components/i })).toBeInTheDocument();
  });

  it('TC-2: pre-fills the form and submits changes scoped to this provider id', async () => {
    mockMutateAsync.mockResolvedValue({ ...provider, name: 'Sibling components (renamed)' });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    expect(screen.getByLabelText(/^name$/i)).toHaveValue('Sibling components');

    await user.clear(screen.getByLabelText(/^name$/i));
    await user.type(screen.getByLabelText(/^name$/i), 'Sibling components (renamed)');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      id: 1,
      input: expect.objectContaining({ name: 'Sibling components (renamed)' }),
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('TC-4: surfaces a server error instead of failing silently', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError({ code: 'NOT_FOUND', message: 'That provider no longer exists.', status: 404 }),
    );
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That provider no longer exists.');
  });
});
