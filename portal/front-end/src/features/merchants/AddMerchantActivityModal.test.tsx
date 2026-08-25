import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../../lib/apiError';

const { mockMutateAsync, mockUseCreateActivityMutation } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseCreateActivityMutation: vi.fn(),
}));

vi.mock('./api', () => ({ useCreateActivityMutation: mockUseCreateActivityMutation }));

import { AddMerchantActivityModal } from './AddMerchantActivityModal';

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AddMerchantActivityModal open onClose={onClose} merchantId={100} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseCreateActivityMutation.mockReset();
  mockUseCreateActivityMutation.mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  });
});

const link = {
  id: 300,
  tenantId: 10,
  merchantId: 100,
  activityId: 50,
  storeId: null,
  commissionRate: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('AddMerchantActivityModal', () => {
  it('links a tenant-wide activity — storeId omitted (TC-14)', async () => {
    mockMutateAsync.mockResolvedValue(link);
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/activity id/i), '50');
    await user.click(screen.getByRole('button', { name: /link activity/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith({ activityId: 50 });
    await vi.waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('links an activity scoped to a store (TC-16)', async () => {
    mockMutateAsync.mockResolvedValue({ ...link, storeId: 7 });
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/activity id/i), '50');
    await user.type(screen.getByLabelText(/store id/i), '7');
    await user.click(screen.getByRole('button', { name: /link activity/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith({ activityId: 50, storeId: 7 });
  });

  it('rejects a commissionRate above 100 before calling the API (TC-17)', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/activity id/i), '50');
    await user.type(screen.getByLabelText(/commission rate/i), '150');
    await user.click(screen.getByRole('button', { name: /link activity/i }));

    await vi.waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    });
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('accepts a two-decimal commissionRate (TC-19)', async () => {
    mockMutateAsync.mockResolvedValue({ ...link, commissionRate: '12.34' });
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/activity id/i), '50');
    await user.type(screen.getByLabelText(/commission rate/i), '12.34');
    await user.click(screen.getByRole('button', { name: /link activity/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith({ activityId: 50, commissionRate: 12.34 });
  });

  it('shows the server message on an already-linked conflict (TC-15)', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError({
        code: 'MERCHANT_ACTIVITY_ALREADY_LINKED',
        message: 'Already linked.',
        status: 409,
      }),
    );
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/activity id/i), '50');
    await user.click(screen.getByRole('button', { name: /link activity/i }));

    expect(await screen.findByText('Already linked.')).toBeInTheDocument();
  });

  it('rejects a storeId of 0 (invalid) with a field-level error, not a generic one', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/activity id/i), '50');
    await user.type(screen.getByLabelText(/store id/i), '0');
    await user.click(screen.getByRole('button', { name: /link activity/i }));

    await vi.waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    });
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('falls back to a generic message for a non-ApiError failure', async () => {
    mockMutateAsync.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/activity id/i), '50');
    await user.click(screen.getByRole('button', { name: /link activity/i }));

    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
  });

  it('resets the form and calls onClose when Cancel is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/activity id/i), '50');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
