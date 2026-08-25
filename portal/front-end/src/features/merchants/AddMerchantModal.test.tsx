import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../../lib/apiError';

const { mockMutateAsync, mockUseCreateMerchantMutation } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseCreateMerchantMutation: vi.fn(),
}));

vi.mock('./api', () => ({ useCreateMerchantMutation: mockUseCreateMerchantMutation }));

import { AddMerchantModal } from './AddMerchantModal';

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AddMerchantModal open onClose={onClose} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseCreateMerchantMutation.mockReset();
  mockUseCreateMerchantMutation.mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  });
});

const baseMerchant = {
  id: 100,
  tenantId: 10,
  merchantCode: 'M001',
  name: 'Acme Store',
  description: null,
  contactEmail: null,
  contactPhone: null,
  website: null,
  countryCode: 'MY',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('AddMerchantModal', () => {
  it('rejects an empty countryCode before calling the API — the shared Zod schema catches it client-side', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/merchant name/i), 'Acme Store');
    await user.type(screen.getByLabelText(/merchant code/i), 'M001');
    await user.click(screen.getByRole('button', { name: /create merchant/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('submits a valid merchant with no tenantId in the payload (implementation note 2)', async () => {
    mockMutateAsync.mockResolvedValue(baseMerchant);
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/merchant code/i), 'M001');
    await user.type(screen.getByLabelText(/country code/i), 'MY');
    await user.type(screen.getByLabelText(/merchant name/i), 'Acme Store');
    await user.click(screen.getByRole('button', { name: /create merchant/i }));

    expect(await screen.findByText(/has been created/i)).toBeInTheDocument();
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ merchantCode: 'M001', name: 'Acme Store', countryCode: 'MY' }),
    );
    expect(mockMutateAsync.mock.calls[0][0]).not.toHaveProperty('tenantId');
  });

  it('submits every optional field populated', async () => {
    mockMutateAsync.mockResolvedValue(baseMerchant);
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/merchant code/i), 'M001');
    await user.type(screen.getByLabelText(/country code/i), 'MY');
    await user.type(screen.getByLabelText(/merchant name/i), 'Acme Store');
    await user.type(screen.getByLabelText(/description/i), 'A great merchant');
    await user.type(screen.getByLabelText(/contact email/i), 'ops@acme.example');
    await user.type(screen.getByLabelText(/contact phone/i), '+60123456789');
    await user.type(screen.getByLabelText(/website/i), 'https://acme.example');
    await user.click(screen.getByRole('button', { name: /create merchant/i }));

    expect(await screen.findByText(/has been created/i)).toBeInTheDocument();
    expect(mockMutateAsync).toHaveBeenCalledWith({
      merchantCode: 'M001',
      name: 'Acme Store',
      countryCode: 'MY',
      description: 'A great merchant',
      contactEmail: 'ops@acme.example',
      contactPhone: '+60123456789',
      website: 'https://acme.example',
    });
  });

  it('shows the server message on a duplicate-code conflict (TC-3)', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError({ code: 'MERCHANT_CODE_EXISTS', message: 'Already in use.', status: 409 }),
    );
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/merchant code/i), 'M001');
    await user.type(screen.getByLabelText(/country code/i), 'MY');
    await user.type(screen.getByLabelText(/merchant name/i), 'Acme Store');
    await user.click(screen.getByRole('button', { name: /create merchant/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Already in use.');
  });

  it('shows the server message on a country mismatch (TC-5)', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError({
        code: 'MERCHANT_COUNTRY_MISMATCH',
        message: 'Country does not match the tenant.',
        status: 400,
      }),
    );
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/merchant code/i), 'M001');
    await user.type(screen.getByLabelText(/country code/i), 'SG');
    await user.type(screen.getByLabelText(/merchant name/i), 'Acme Store');
    await user.click(screen.getByRole('button', { name: /create merchant/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Country does not match the tenant.',
    );
  });

  it('falls back to a generic message for a non-ApiError failure', async () => {
    mockMutateAsync.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/merchant code/i), 'M001');
    await user.type(screen.getByLabelText(/country code/i), 'MY');
    await user.type(screen.getByLabelText(/merchant name/i), 'Acme Store');
    await user.click(screen.getByRole('button', { name: /create merchant/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
  });

  it('resets the form and calls onClose when Cancel is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/merchant name/i), 'Acme Store');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
