/**
 * T-162 TC-3/TC-4 — `EditApiLookupProviderModal` (`PATCH /field-api-lookup-providers/:id`).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FieldApiLookupProvider } from '@reward-portal/shared';
import { ApiError } from '../../lib/apiError';

const { mockMutateAsync, mockUseUpdateFieldApiLookupProviderMutation } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseUpdateFieldApiLookupProviderMutation: vi.fn(),
}));

vi.mock('./api', () => ({
  useUpdateFieldApiLookupProviderMutation: mockUseUpdateFieldApiLookupProviderMutation,
}));

import { EditApiLookupProviderModal } from './EditApiLookupProviderModal';

const provider: FieldApiLookupProvider = {
  id: 2,
  providerCode: 'PRODUCT_CATALOG',
  name: 'Product catalog',
  description: 'Active products for the tenant/country the campaign is being built in.',
  endpointUrl: '/api/lookups/products',
  httpMethod: 'GET',
  authType: 'none',
  responseValueKey: 'code',
  responseLabelKey: 'name',
  status: 'active',
};

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EditApiLookupProviderModal open onClose={onClose} provider={provider} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseUpdateFieldApiLookupProviderMutation.mockReset();
  mockUseUpdateFieldApiLookupProviderMutation.mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  });
});

describe('EditApiLookupProviderModal', () => {
  it('never renders providerCode as an editable field, and opens with the auth config box blank', () => {
    renderModal();

    expect(screen.queryByLabelText(/provider code/i)).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /edit product_catalog/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/auth config/i)).toHaveValue('');
  });

  it('TC-3: pre-fills the form from the provider and submits scoped to its id', async () => {
    mockMutateAsync.mockResolvedValue(provider);
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    expect(screen.getByLabelText(/^name$/i)).toHaveValue('Product catalog');
    expect(screen.getByLabelText(/endpoint url/i)).toHaveValue('/api/lookups/products');

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      id: 2,
      input: expect.objectContaining({
        name: 'Product catalog',
        endpointUrl: '/api/lookups/products',
      }),
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('omits authConfig from the request when left blank — leaving the stored credential untouched', async () => {
    mockMutateAsync.mockResolvedValue(provider);
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    const [[submitted]] = mockMutateAsync.mock.calls as [[{ input: { authConfig?: unknown } }]];
    expect(submitted.input.authConfig).toBeUndefined();
  });

  it('replaces the stored credential when a new auth config JSON is entered', async () => {
    mockMutateAsync.mockResolvedValue(provider);
    const user = userEvent.setup();
    renderModal();

    // `user.type` treats `{`/`}` as special-key syntax; exercise the controlled textarea's
    // value directly instead (see `AddApiLookupProviderModal.test.tsx`'s identical comment).
    fireEvent.change(screen.getByLabelText(/auth config/i), {
      target: { value: '{"token":"new-secret"}' },
    });
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      id: 2,
      input: expect.objectContaining({ authConfig: { token: 'new-secret' } }),
    });
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
