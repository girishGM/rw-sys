/**
 * T-162 TC-3/TC-4 — `AddApiLookupProviderModal` (`POST /field-api-lookup-providers`).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../../lib/apiError';

const { mockMutateAsync, mockUseCreateFieldApiLookupProviderMutation } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseCreateFieldApiLookupProviderMutation: vi.fn(),
}));

vi.mock('./api', () => ({
  useCreateFieldApiLookupProviderMutation: mockUseCreateFieldApiLookupProviderMutation,
}));

import { AddApiLookupProviderModal } from './AddApiLookupProviderModal';

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AddApiLookupProviderModal open onClose={onClose} />
    </QueryClientProvider>,
  );
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/provider code/i), 'PRODUCT_CATALOG');
  await user.type(screen.getByLabelText(/^name$/i), 'Product catalog service');
  await user.type(screen.getByLabelText(/endpoint url/i), 'https://internal.example.com/catalog');
  await user.type(screen.getByLabelText(/response value key/i), 'productId');
  await user.type(screen.getByLabelText(/response label key/i), 'productName');
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseCreateFieldApiLookupProviderMutation.mockReset();
  mockUseCreateFieldApiLookupProviderMutation.mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  });
});

describe('AddApiLookupProviderModal', () => {
  it('rejects a missing endpoint URL before calling the API — the shared Zod schema catches it client-side', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/provider code/i), 'PRODUCT_CATALOG');
    await user.type(screen.getByLabelText(/^name$/i), 'Product catalog service');
    await user.type(screen.getByLabelText(/response value key/i), 'productId');
    await user.type(screen.getByLabelText(/response label key/i), 'productName');
    await user.click(screen.getByRole('button', { name: /create provider/i }));

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('TC-3: submits a valid API lookup provider with its GET/none/planned defaults and closes on success', async () => {
    mockMutateAsync.mockResolvedValue({
      id: 1,
      providerCode: 'PRODUCT_CATALOG',
      name: 'Product catalog service',
      description: null,
      endpointUrl: 'https://internal.example.com/catalog',
      httpMethod: 'GET',
      authType: 'none',
      responseValueKey: 'productId',
      responseLabelKey: 'productName',
      status: 'planned',
    });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create provider/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        providerCode: 'PRODUCT_CATALOG',
        name: 'Product catalog service',
        endpointUrl: 'https://internal.example.com/catalog',
        httpMethod: 'GET',
        authType: 'none',
        status: 'planned',
        responseValueKey: 'productId',
        responseLabelKey: 'productName',
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('parses the optional auth config JSON and includes it on submit', async () => {
    mockMutateAsync.mockResolvedValue({
      id: 1,
      providerCode: 'PRODUCT_CATALOG',
      name: 'Product catalog service',
      description: null,
      endpointUrl: 'https://internal.example.com/catalog',
      httpMethod: 'GET',
      authType: 'api_key',
      responseValueKey: 'productId',
      responseLabelKey: 'productName',
      status: 'planned',
    });
    const user = userEvent.setup();
    renderModal();

    await fillRequiredFields(user);
    // `user.type` treats `{`/`}` as special-key syntax (see `EditVersionDraftModal.test.tsx`'s
    // own `'{{not json'` escaping); a controlled textarea's value is exercised directly instead.
    fireEvent.change(screen.getByLabelText(/auth config/i), {
      target: { value: '{"headerName":"X-Api-Key","apiKey":"secret"}' },
    });
    await user.click(screen.getByRole('button', { name: /create provider/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        authConfig: { headerName: 'X-Api-Key', apiKey: 'secret' },
      }),
    );
  });

  it('rejects invalid auth config JSON before calling the API', async () => {
    const user = userEvent.setup();
    renderModal();

    await fillRequiredFields(user);
    fireEvent.change(screen.getByLabelText(/auth config/i), {
      target: { value: '{not valid json' },
    });
    await user.click(screen.getByRole('button', { name: /create provider/i }));

    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText(/must be valid json/i)).toBeInTheDocument();
  });

  it('TC-4: surfaces a server validation/conflict error instead of failing silently', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError({
        code: 'FIELD_API_LOOKUP_PROVIDER_CODE_EXISTS',
        message: 'That provider code is already in use.',
        status: 409,
      }),
    );
    const user = userEvent.setup();
    renderModal();

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create provider/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That provider code is already in use.',
    );
  });
});
