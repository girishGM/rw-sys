import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../../lib/apiError';

const { mockMutateAsync, mockUseCreateStoreMutation } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseCreateStoreMutation: vi.fn(),
}));

vi.mock('./api', () => ({ useCreateStoreMutation: mockUseCreateStoreMutation }));

import { AddMerchantStoreModal } from './AddMerchantStoreModal';

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AddMerchantStoreModal open onClose={onClose} merchantId={100} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseCreateStoreMutation.mockReset();
  mockUseCreateStoreMutation.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
});

describe('AddMerchantStoreModal', () => {
  it('rejects an empty storeCode before calling the API', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/store name/i), 'Main Store');
    await user.click(screen.getByRole('button', { name: /add store/i }));

    await vi.waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    });
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('submits a valid store and closes the modal (TC-12)', async () => {
    mockMutateAsync.mockResolvedValue({
      id: 200,
      tenantId: 10,
      merchantId: 100,
      storeCode: 'S001',
      name: 'Main Store',
      address: null,
      city: null,
      state: null,
      postalCode: null,
      region: null,
      latitude: null,
      longitude: null,
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/store code/i), 'S001');
    await user.type(screen.getByLabelText(/store name/i), 'Main Store');
    await user.click(screen.getByRole('button', { name: /add store/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ storeCode: 'S001', name: 'Main Store' }),
    );
    await vi.waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('submits every optional field populated, including coordinates', async () => {
    mockMutateAsync.mockResolvedValue({
      id: 200,
      tenantId: 10,
      merchantId: 100,
      storeCode: 'S001',
      name: 'Main Store',
      address: '1 Main St',
      city: 'Kuala Lumpur',
      state: 'WP',
      postalCode: '50000',
      region: 'Central',
      latitude: '3.139',
      longitude: '101.6869',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/store code/i), 'S001');
    await user.type(screen.getByLabelText(/store name/i), 'Main Store');
    await user.type(screen.getByLabelText(/address/i), '1 Main St');
    await user.type(screen.getByLabelText(/city/i), 'Kuala Lumpur');
    await user.type(screen.getByLabelText(/state/i), 'WP');
    await user.type(screen.getByLabelText(/postal code/i), '50000');
    await user.type(screen.getByLabelText(/region/i), 'Central');
    await user.type(screen.getByLabelText(/latitude/i), '3.139');
    await user.type(screen.getByLabelText(/longitude/i), '101.6869');
    await user.click(screen.getByRole('button', { name: /add store/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      storeCode: 'S001',
      name: 'Main Store',
      address: '1 Main St',
      city: 'Kuala Lumpur',
      state: 'WP',
      postalCode: '50000',
      region: 'Central',
      latitude: 3.139,
      longitude: 101.6869,
    });
  });

  it('rejects an out-of-range latitude before calling the API', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/store code/i), 'S001');
    await user.type(screen.getByLabelText(/store name/i), 'Main Store');
    await user.type(screen.getByLabelText(/latitude/i), '95');
    await user.click(screen.getByRole('button', { name: /add store/i }));

    await vi.waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    });
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('shows the server message on a duplicate store-code conflict', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError({
        code: 'MERCHANT_STORE_CODE_EXISTS',
        message: 'Already in use.',
        status: 409,
      }),
    );
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/store code/i), 'S001');
    await user.type(screen.getByLabelText(/store name/i), 'Main Store');
    await user.click(screen.getByRole('button', { name: /add store/i }));

    expect(await screen.findByText('Already in use.')).toBeInTheDocument();
  });

  it('falls back to a generic message for a non-ApiError failure', async () => {
    mockMutateAsync.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/store code/i), 'S001');
    await user.type(screen.getByLabelText(/store name/i), 'Main Store');
    await user.click(screen.getByRole('button', { name: /add store/i }));

    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
  });

  it('resets the form and calls onClose when Cancel is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/store name/i), 'Main Store');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
