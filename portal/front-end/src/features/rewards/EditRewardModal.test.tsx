import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Reward } from '@reward-portal/shared';

const { mockMutateAsync, mockUseUpdateRewardMutation } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseUpdateRewardMutation: vi.fn(),
}));

vi.mock('./api', () => ({ useUpdateRewardMutation: mockUseUpdateRewardMutation }));

import { EditRewardModal } from './EditRewardModal';
import { ApiError } from '../../lib/apiError';

const reward: Reward = {
  id: 1,
  systemCode: 'CASHBACK_STANDARD',
  name: 'Standard cashback',
  description: null,
  rewardType: 'monetary',
  deliveryMode: 'realtime',
  connectorType: 'internal_api',
  connectorConfigPreview: { apiKey: '••••1234' },
  maintenanceWindowEnabled: false,
  maintenanceSchedule: {},
  retryEnabled: true,
  retryConfig: {},
  merchantId: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EditRewardModal open onClose={onClose} reward={reward} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseUpdateRewardMutation.mockReset();
  mockUseUpdateRewardMutation.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
});

describe('EditRewardModal', () => {
  it('does not render systemCode as an editable field — immutable (matches UpdateRewardDto)', () => {
    renderModal();
    expect(screen.queryByLabelText(/system code/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Edit CASHBACK_STANDARD/)).toBeInTheDocument();
  });

  it('never pre-fills connectorConfig — the server never returns the plaintext (implementation note 4)', () => {
    renderModal();
    expect(screen.queryByDisplayValue('••••1234')).not.toBeInTheDocument();
    expect(screen.getByText(/no connector configuration set/i)).toBeInTheDocument();
  });

  it('submits a name change, omitting connectorConfig entirely', async () => {
    mockMutateAsync.mockResolvedValue({ ...reward, name: 'New name' });
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
    const call = mockMutateAsync.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call['connectorConfig']).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });

  it('TC-22: submits a status change to inactive', async () => {
    mockMutateAsync.mockResolvedValue({ ...reward, status: 'inactive' });
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('combobox', { name: /status/i }));
    await user.click(screen.getByRole('option', { name: 'Inactive' }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ status: 'inactive' }));
  });

  it('shows the server error message when the update fails', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError({ code: 'PERM_DENIED', message: 'You may not do this.', status: 403 }),
    );
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('You may not do this.');
  });

  it('TC-13: replacing connectorConfig sends the new plaintext value (encrypted server-side)', async () => {
    mockMutateAsync.mockResolvedValue({ ...reward, connectorConfig: { apiKey: '••••5678' } });
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('button', { name: /add field/i }));
    await user.type(screen.getByPlaceholderText('apiKey'), 'apiKey');
    await user.type(screen.getByPlaceholderText(/sk_live/i), 'sk_live_5678');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ connectorConfig: { apiKey: 'sk_live_5678' } }),
    );
  });
});
