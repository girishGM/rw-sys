import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { mockMutateAsync, mockUseCreateRewardMutation } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseCreateRewardMutation: vi.fn(),
}));

vi.mock('./api', () => ({ useCreateRewardMutation: mockUseCreateRewardMutation }));

import { AddRewardModal } from './AddRewardModal';
import { ApiError } from '../../lib/apiError';

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AddRewardModal open onClose={onClose} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseCreateRewardMutation.mockReset();
  mockUseCreateRewardMutation.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
});

describe('AddRewardModal', () => {
  it('rejects a too-short system code before calling the API — the shared Zod schema catches it client-side', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/system code/i), 'X');
    await user.type(screen.getByLabelText(/^name$/i), 'Standard cashback');
    await user.type(screen.getByLabelText(/reward type/i), 'monetary');
    await user.click(screen.getByRole('combobox', { name: /connector type/i }));
    await user.click(screen.getByRole('option', { name: 'internal_api' }));
    await user.click(screen.getByRole('button', { name: /create reward/i }));

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('shows the server error message when creation fails', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError({ code: 'REWARD_SYSTEM_CODE_EXISTS', message: 'Already exists.', status: 409 }),
    );
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/system code/i), 'CASHBACK_STANDARD');
    await user.type(screen.getByLabelText(/^name$/i), 'Standard cashback');
    await user.type(screen.getByLabelText(/reward type/i), 'monetary');
    await user.click(screen.getByRole('combobox', { name: /connector type/i }));
    await user.click(screen.getByRole('option', { name: 'internal_api' }));
    await user.click(screen.getByRole('button', { name: /create reward/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Already exists.');
  });

  it('submits a valid reward with no connector config', async () => {
    mockMutateAsync.mockResolvedValue({
      id: 1,
      systemCode: 'CASHBACK_STANDARD',
      name: 'Standard cashback',
      description: null,
      rewardType: 'monetary',
      deliveryMode: 'realtime',
      connectorType: 'internal_api',
      connectorConfig: null,
      maintenanceWindowEnabled: false,
      maintenanceSchedule: {},
      retryEnabled: true,
      retryConfig: {},
      merchantId: null,
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/system code/i), 'CASHBACK_STANDARD');
    await user.type(screen.getByLabelText(/^name$/i), 'Standard cashback');
    await user.type(screen.getByLabelText(/reward type/i), 'monetary');
    await user.click(screen.getByRole('combobox', { name: /connector type/i }));
    await user.click(screen.getByRole('option', { name: 'internal_api' }));

    await user.click(screen.getByRole('button', { name: /create reward/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        systemCode: 'CASHBACK_STANDARD',
        name: 'Standard cashback',
        rewardType: 'monetary',
        connectorType: 'internal_api',
      }),
    );
    const call = mockMutateAsync.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call['connectorConfig']).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });

  it('adds a connectorConfig field through the embedded editor and includes it on submit (implementation note 4)', async () => {
    mockMutateAsync.mockResolvedValue({
      id: 1,
      systemCode: 'X',
      name: 'x',
      description: null,
      rewardType: 'monetary',
      deliveryMode: 'realtime',
      connectorType: 'internal_api',
      connectorConfig: { apiKey: '••••1234' },
      maintenanceWindowEnabled: false,
      maintenanceSchedule: {},
      retryEnabled: true,
      retryConfig: {},
      merchantId: null,
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/system code/i), 'CASHBACK_STANDARD');
    await user.type(screen.getByLabelText(/^name$/i), 'Standard cashback');
    await user.type(screen.getByLabelText(/reward type/i), 'monetary');
    await user.click(screen.getByRole('combobox', { name: /connector type/i }));
    await user.click(screen.getByRole('option', { name: 'internal_api' }));

    await user.click(screen.getByRole('button', { name: /add field/i }));
    await user.type(screen.getByPlaceholderText('apiKey'), 'apiKey');
    await user.type(screen.getByPlaceholderText(/sk_live/i), 'sk_live_1234');

    await user.click(screen.getByRole('button', { name: /create reward/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ connectorConfig: { apiKey: 'sk_live_1234' } }),
    );
  });
});
