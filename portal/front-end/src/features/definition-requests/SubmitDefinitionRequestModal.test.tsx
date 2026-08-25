import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { mockMutateAsync, mockUseCreateDefinitionRequestMutation } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseCreateDefinitionRequestMutation: vi.fn(),
}));

vi.mock('./api', () => ({
  useCreateDefinitionRequestMutation: mockUseCreateDefinitionRequestMutation,
}));

import { SubmitDefinitionRequestModal } from './SubmitDefinitionRequestModal';

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SubmitDefinitionRequestModal open onClose={onClose} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseCreateDefinitionRequestMutation.mockReset();
  mockUseCreateDefinitionRequestMutation.mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  });
});

describe('SubmitDefinitionRequestModal', () => {
  it('TC-1: submits a well-formed new_rule request', async () => {
    mockMutateAsync.mockResolvedValue({ id: 1, status: 'submitted' });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/^title$/i), 'Weekend multiplier');
    await user.type(
      screen.getByLabelText(/description/i),
      'We need a weekend transaction multiplier rule for this country.',
    );
    await user.click(screen.getByRole('button', { name: /submit request/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        requestType: 'new_rule',
        title: 'Weekend multiplier',
        priority: 'normal',
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('rejects a too-short title before calling the API — the shared Zod schema catches it client-side', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/^title$/i), 'x');
    await user.type(
      screen.getByLabelText(/description/i),
      'We need a weekend transaction multiplier rule for this country.',
    );
    await user.click(screen.getByRole('button', { name: /submit request/i }));

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('shows the entityId field only for update_rule/update_reward', async () => {
    const user = userEvent.setup();
    renderModal();

    expect(screen.queryByLabelText(/existing rule\/reward id/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: /request type/i }));
    await user.click(screen.getByRole('option', { name: 'Change an existing rule' }));

    expect(screen.getByLabelText(/existing rule\/reward id/i)).toBeInTheDocument();
  });

  it('shows the server error message on a failed submit', async () => {
    mockMutateAsync.mockRejectedValue(
      Object.assign(new Error('Permission denied.'), { message: 'Permission denied.' }),
    );
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/^title$/i), 'Weekend multiplier');
    await user.type(
      screen.getByLabelText(/description/i),
      'We need a weekend transaction multiplier rule for this country.',
    );
    await user.click(screen.getByRole('button', { name: /submit request/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('cancels and resets the form', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/^title$/i), 'Weekend multiplier');
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onClose).toHaveBeenCalled();
  });
});
