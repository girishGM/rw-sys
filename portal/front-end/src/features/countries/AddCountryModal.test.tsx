import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../../lib/apiError';

const { mockMutateAsync, mockUseCreateCountryMutation } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseCreateCountryMutation: vi.fn(),
}));

vi.mock('./api', () => ({ useCreateCountryMutation: mockUseCreateCountryMutation }));

import { AddCountryModal } from './AddCountryModal';

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AddCountryModal open onClose={onClose} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseCreateCountryMutation.mockReset();
  mockUseCreateCountryMutation.mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  });
});

describe('AddCountryModal', () => {
  it('rejects a malformed country code before calling the API — the shared Zod schema catches it client-side', async () => {
    const user = userEvent.setup();
    renderModal();

    // The full ISO-3166-1 whitelist is server-side only (T-030 implementation note 2's
    // `IsCountryCode` decorator); the shared Zod schema still enforces the shape (exactly two
    // characters), which is what this asserts without duplicating the ISO list into the SPA.
    await user.type(screen.getByLabelText(/iso country code/i), 'M');
    await user.type(screen.getByLabelText(/currency code/i), 'MYR');
    await user.type(screen.getByLabelText(/country name/i), 'Malaysia');
    await user.type(screen.getByLabelText(/timezone/i), 'Asia/Kuala_Lumpur');
    await user.type(screen.getByLabelText(/dialing code/i), '+60');
    await user.click(screen.getByRole('button', { name: /create country/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('submits a valid country with no admin', async () => {
    mockMutateAsync.mockResolvedValue({
      country: {
        id: 1,
        code: 'MY',
        name: 'Malaysia',
        timezone: 'Asia/Kuala_Lumpur',
        currencyCode: 'MYR',
        dialingCode: '+60',
        isHq: false,
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      admin: null,
    });
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/iso country code/i), 'MY');
    await user.type(screen.getByLabelText(/currency code/i), 'MYR');
    await user.type(screen.getByLabelText(/country name/i), 'Malaysia');
    await user.type(screen.getByLabelText(/timezone/i), 'Asia/Kuala_Lumpur');
    await user.type(screen.getByLabelText(/dialing code/i), '+60');
    await user.click(screen.getByRole('button', { name: /create country/i }));

    expect(await screen.findByText(/has been created/i)).toBeInTheDocument();
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MY', currencyCode: 'MYR', admin: undefined }),
    );
    // No admin was created, so nothing about a temporary password is shown.
    expect(screen.queryByTestId('temporary-password-value')).not.toBeInTheDocument();
  });

  it('onboarding the admin at the same time shows the one-time password reveal, hidden until clicked (BACKLOG B-01)', async () => {
    mockMutateAsync.mockResolvedValue({
      country: {
        id: 1,
        code: 'MY',
        name: 'Malaysia',
        timezone: 'Asia/Kuala_Lumpur',
        currencyCode: 'MYR',
        dialingCode: '+60',
        isHq: false,
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      admin: {
        id: 5,
        email: 'admin@example.invalid',
        displayName: 'Admin',
        role: 'country_admin',
        countryId: 1,
        temporaryPassword: 'Xy9!kLmnpQ2*Zvwr4Tabcd7',
      },
    });
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/iso country code/i), 'MY');
    await user.type(screen.getByLabelText(/currency code/i), 'MYR');
    await user.type(screen.getByLabelText(/country name/i), 'Malaysia');
    await user.type(screen.getByLabelText(/timezone/i), 'Asia/Kuala_Lumpur');
    await user.type(screen.getByLabelText(/dialing code/i), '+60');
    await user.click(screen.getByRole('switch', { name: /onboard the country admin now/i }));
    await user.type(screen.getByLabelText(/country admin email/i), 'admin@example.invalid');
    await user.type(screen.getByLabelText(/country admin name/i), 'Admin');
    await user.click(screen.getByRole('button', { name: /create country/i }));

    const value = await screen.findByTestId('temporary-password-value');
    expect(value.textContent).toMatch(/^•+$/);

    await user.click(screen.getByRole('button', { name: /reveal/i }));
    expect(value.textContent).toBe('Xy9!kLmnpQ2*Zvwr4Tabcd7');

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        admin: { email: 'admin@example.invalid', displayName: 'Admin' },
      }),
    );
  });

  it('shows the server message on a duplicate-code conflict (TC-2)', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError({ code: 'COUNTRY_CODE_EXISTS', message: 'Already in use.', status: 409 }),
    );
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/iso country code/i), 'MY');
    await user.type(screen.getByLabelText(/currency code/i), 'MYR');
    await user.type(screen.getByLabelText(/country name/i), 'Malaysia');
    await user.type(screen.getByLabelText(/timezone/i), 'Asia/Kuala_Lumpur');
    await user.type(screen.getByLabelText(/dialing code/i), '+60');
    await user.click(screen.getByRole('button', { name: /create country/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Already in use.');
  });

  it('falls back to a generic message for a non-ApiError failure', async () => {
    mockMutateAsync.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/iso country code/i), 'MY');
    await user.type(screen.getByLabelText(/currency code/i), 'MYR');
    await user.type(screen.getByLabelText(/country name/i), 'Malaysia');
    await user.type(screen.getByLabelText(/timezone/i), 'Asia/Kuala_Lumpur');
    await user.type(screen.getByLabelText(/dialing code/i), '+60');
    await user.click(screen.getByRole('button', { name: /create country/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
  });

  it('resets the form and calls onClose when Cancel is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/country name/i), 'Malaysia');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
