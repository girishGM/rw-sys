import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { mockMutateAsync, mockUseCreateRewardPolicyMutation } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseCreateRewardPolicyMutation: vi.fn(),
}));

vi.mock('./api', () => ({ useCreateRewardPolicyMutation: mockUseCreateRewardPolicyMutation }));

import { AddPolicyModal } from './AddPolicyModal';
import { ApiError } from '../../lib/apiError';

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AddPolicyModal open onClose={onClose} rewardId={1} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseCreateRewardPolicyMutation.mockReset();
  mockUseCreateRewardPolicyMutation.mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  });
});

describe('AddPolicyModal', () => {
  it('TC-17: submits a valid policy', async () => {
    mockMutateAsync.mockResolvedValue({
      id: 10,
      rewardSystemId: 1,
      policyCode: 'STANDARD',
      name: 'Standard policy',
      description: null,
      config: {},
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/policy code/i), 'STANDARD');
    await user.type(screen.getByLabelText(/^name$/i), 'Standard policy');
    await user.click(screen.getByRole('button', { name: /add policy/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ policyCode: 'STANDARD', name: 'Standard policy' }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the server error message when creating the policy fails', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError({ code: 'REWARD_POLICY_CODE_EXISTS', message: 'Already exists.', status: 409 }),
    );
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/policy code/i), 'DUP');
    await user.type(screen.getByLabelText(/^name$/i), 'Duplicate');
    await user.click(screen.getByRole('button', { name: /add policy/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Already exists.');
  });

  it("rejects a too-short policy code before calling the API — the shared Zod schema catches it client-side (the full upper-snake-case pattern is server-side only, matching AddRuleModal.test.tsx's own precedent)", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/policy code/i), 'X');
    await user.type(screen.getByLabelText(/^name$/i), 'Standard policy');
    await user.click(screen.getByRole('button', { name: /add policy/i }));

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });
});
