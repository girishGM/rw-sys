/**
 * T-162 TC-1/TC-4 — `AddContextProviderModal` (`POST /field-context-providers`).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../../lib/apiError';

const { mockMutateAsync, mockUseCreateFieldContextProviderMutation } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseCreateFieldContextProviderMutation: vi.fn(),
}));

vi.mock('./api', () => ({
  useCreateFieldContextProviderMutation: mockUseCreateFieldContextProviderMutation,
}));

import { AddContextProviderModal } from './AddContextProviderModal';

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AddContextProviderModal open onClose={onClose} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseCreateFieldContextProviderMutation.mockReset();
  mockUseCreateFieldContextProviderMutation.mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  });
});

describe('AddContextProviderModal', () => {
  it('rejects a lowercase provider code before calling the API — the shared Zod schema catches it client-side', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/provider code/i), 'sibling_components');
    await user.type(screen.getByLabelText(/^name$/i), 'Sibling components');
    await user.click(screen.getByRole('button', { name: /create provider/i }));

    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText(/upper snake case/i)).toBeInTheDocument();
  });

  it('TC-1: submits a valid context provider and closes on success', async () => {
    mockMutateAsync.mockResolvedValue({
      id: 1,
      providerCode: 'SIBLING_COMPONENTS',
      name: 'Sibling components',
      description: null,
      status: 'active',
    });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/provider code/i), 'SIBLING_COMPONENTS');
    await user.type(screen.getByLabelText(/^name$/i), 'Sibling components');
    await user.click(screen.getByRole('button', { name: /create provider/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      providerCode: 'SIBLING_COMPONENTS',
      name: 'Sibling components',
      description: undefined,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('TC-4: surfaces a server validation/conflict error instead of failing silently', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError({
        code: 'FIELD_CONTEXT_PROVIDER_CODE_EXISTS',
        message: 'That provider code is already in use.',
        status: 409,
      }),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/provider code/i), 'SIBLING_COMPONENTS');
    await user.type(screen.getByLabelText(/^name$/i), 'Sibling components');
    await user.click(screen.getByRole('button', { name: /create provider/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That provider code is already in use.',
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
