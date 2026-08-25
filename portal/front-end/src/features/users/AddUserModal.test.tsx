import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';

const { mockMutateAsync, mockUseCreateUserMutation, mockUseCountriesQuery, mockUseTenantsQuery } =
  vi.hoisted(() => ({
    mockMutateAsync: vi.fn(),
    mockUseCreateUserMutation: vi.fn(),
    mockUseCountriesQuery: vi.fn(),
    mockUseTenantsQuery: vi.fn(),
  }));

vi.mock('./api', () => ({ useCreateUserMutation: mockUseCreateUserMutation }));
vi.mock('../countries/api', () => ({ useCountriesQuery: mockUseCountriesQuery }));
vi.mock('../tenants/api', () => ({ useTenantsQuery: mockUseTenantsQuery }));

import { AddUserModal } from './AddUserModal';

function bootstrapValue(role: string): BootstrapContextValue {
  return {
    user: { id: 1, displayName: 'Test User', role: role as never, locale: 'en', timezone: null },
    scope: { countryId: 1, tenantId: 10, merchantId: null },
    nav: [],
    permissions: {},
    widgets: [],
    messages: {},
    isLoading: false,
    isError: false,
    isUnauthorized: false,
    hasPermission: () => true,
    refetch: () => undefined,
  };
}

function renderModal(role: string, onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(role)}>
        <AddUserModal open onClose={onClose} />
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseCreateUserMutation.mockReset();
  mockUseCreateUserMutation.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
  mockUseCountriesQuery.mockReset();
  mockUseCountriesQuery.mockReturnValue({
    data: { data: [{ id: 3, code: 'MY', name: 'Malaysia' }] },
  });
  mockUseTenantsQuery.mockReset();
  mockUseTenantsQuery.mockReturnValue({
    data: { data: [{ id: 10, code: 'T001', name: 'Acme Retail' }] },
  });
});

describe("AddUserModal — TC-26/TC-27: the role dropdown offers only the actor's allowed roles", () => {
  it('tenant_admin sees only maker, checker and merchant (TC-26)', async () => {
    const user = userEvent.setup();
    renderModal('tenant_admin');

    await user.click(screen.getByRole('combobox', { name: /^role$/i }));

    expect(screen.getByRole('option', { name: 'Maker' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Checker' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Merchant' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Tenant Admin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Country Admin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Super Admin' })).not.toBeInTheDocument();
  });

  it('country_admin sees only tenant_admin (TC-27)', async () => {
    const user = userEvent.setup();
    renderModal('country_admin');

    await user.click(screen.getByRole('combobox', { name: /^role$/i }));

    expect(screen.getByRole('option', { name: 'Tenant Admin' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Maker' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Checker' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Merchant' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Country Admin' })).not.toBeInTheDocument();
  });

  it('super_admin sees only country_admin', async () => {
    const user = userEvent.setup();
    renderModal('super_admin');

    await user.click(screen.getByRole('combobox', { name: /^role$/i }));

    expect(screen.getByRole('option', { name: 'Country Admin' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Tenant Admin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Super Admin' })).not.toBeInTheDocument();
  });
});

describe("AddUserModal — the scope field mirrors the actor's own axis", () => {
  it('shows a Country picker for a super_admin actor, not a Tenant or Merchant field', () => {
    renderModal('super_admin');
    expect(screen.getByRole('combobox', { name: /^country$/i })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /^tenant$/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/merchant id/i)).not.toBeInTheDocument();
  });

  it('shows a Tenant picker for a country_admin actor, not a Country or Merchant field', () => {
    renderModal('country_admin');
    expect(screen.getByRole('combobox', { name: /^tenant$/i })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /^country$/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/merchant id/i)).not.toBeInTheDocument();
  });

  it('shows a Merchant ID field for a tenant_admin actor only once "merchant" is the selected role', async () => {
    const user = userEvent.setup();
    renderModal('tenant_admin');

    expect(screen.queryByLabelText(/merchant id/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: /^role$/i }));
    await user.click(screen.getByRole('option', { name: 'Merchant' }));

    expect(screen.getByLabelText(/merchant id/i)).toBeInTheDocument();
  });
});

describe('AddUserModal — submission', () => {
  it('rejects an invalid email before calling the API', async () => {
    const user = userEvent.setup();
    renderModal('tenant_admin');

    await user.click(screen.getByRole('combobox', { name: /^role$/i }));
    await user.click(screen.getByRole('option', { name: 'Maker' }));
    await user.type(screen.getByLabelText(/email/i), 'not-an-email');
    await user.type(screen.getByLabelText(/display name/i), 'A Maker');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    expect(await screen.findByText(/invalid email/i)).toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('requires a role to be selected before submitting', async () => {
    const user = userEvent.setup();
    renderModal('tenant_admin');

    await user.type(screen.getByLabelText(/email/i), 'maker@example.invalid');
    await user.type(screen.getByLabelText(/display name/i), 'A Maker');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    await waitFor(() => expect(mockMutateAsync).not.toHaveBeenCalled());
    expect(screen.getByRole('combobox', { name: /^role$/i })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it("a super_admin submitting without picking a country sends countryId: undefined — the server, not this form, is the authority on that requirement (T-035 TC-14's sibling)", async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError({ code: 'VALIDATION_FAILED', message: 'countryId is required.', status: 400 }),
    );
    const user = userEvent.setup();
    renderModal('super_admin');

    await user.click(screen.getByRole('combobox', { name: /^role$/i }));
    await user.click(screen.getByRole('option', { name: 'Country Admin' }));
    await user.type(screen.getByLabelText(/email/i), 'ca@example.invalid');
    await user.type(screen.getByLabelText(/display name/i), 'A Country Admin');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'country_admin', countryId: undefined }),
      ),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('countryId is required.');
  });

  it('a tenant_admin submitting a merchant without a merchant id sends merchantId: undefined (TC-14)', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError({ code: 'VALIDATION_FAILED', message: 'merchantId is required.', status: 400 }),
    );
    const user = userEvent.setup();
    renderModal('tenant_admin');

    await user.click(screen.getByRole('combobox', { name: /^role$/i }));
    await user.click(screen.getByRole('option', { name: 'Merchant' }));
    await user.type(screen.getByLabelText(/email/i), 'm@example.invalid');
    await user.type(screen.getByLabelText(/display name/i), 'A Merchant User');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'merchant', merchantId: undefined }),
      ),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('merchantId is required.');
  });

  it('falls back to a generic message for a non-ApiError failure', async () => {
    mockMutateAsync.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderModal('tenant_admin');

    await user.click(screen.getByRole('combobox', { name: /^role$/i }));
    await user.click(screen.getByRole('option', { name: 'Maker' }));
    await user.type(screen.getByLabelText(/email/i), 'maker@example.invalid');
    await user.type(screen.getByLabelText(/display name/i), 'A Maker');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
  });

  it('submits a tenant_admin-created maker with no scope field in the payload', async () => {
    mockMutateAsync.mockResolvedValue({
      id: 500,
      email: 'maker@example.invalid',
      displayName: 'A Maker',
      role: 'maker',
      countryId: 1,
      tenantId: 10,
      merchantId: null,
      status: 'active',
      mustChangePassword: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      temporaryPassword: 'Xy9!kLmnpQ2*Zvwr4Tabcd7',
    });
    const user = userEvent.setup();
    renderModal('tenant_admin');

    await user.click(screen.getByRole('combobox', { name: /^role$/i }));
    await user.click(screen.getByRole('option', { name: 'Maker' }));
    await user.type(screen.getByLabelText(/email/i), 'maker@example.invalid');
    await user.type(screen.getByLabelText(/display name/i), 'A Maker');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    expect(await screen.findByTestId('temporary-password-value')).toBeInTheDocument();
    expect(mockMutateAsync).toHaveBeenCalledWith({
      email: 'maker@example.invalid',
      displayName: 'A Maker',
      role: 'maker',
      countryId: undefined,
      tenantId: undefined,
      merchantId: undefined,
    });
  });

  it('submits a country_admin-created tenant_admin with the picked tenantId', async () => {
    mockMutateAsync.mockResolvedValue({
      id: 501,
      email: 'ta@example.invalid',
      displayName: 'A Tenant Admin',
      role: 'tenant_admin',
      countryId: 1,
      tenantId: 10,
      merchantId: null,
      status: 'active',
      mustChangePassword: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      temporaryPassword: 'Xy9!kLmnpQ2*Zvwr4Tabcd7',
    });
    const user = userEvent.setup();
    renderModal('country_admin');

    await user.click(screen.getByRole('combobox', { name: /^role$/i }));
    await user.click(screen.getByRole('option', { name: 'Tenant Admin' }));
    await user.type(screen.getByLabelText(/email/i), 'ta@example.invalid');
    await user.type(screen.getByLabelText(/display name/i), 'A Tenant Admin');
    await user.click(screen.getByRole('combobox', { name: /^tenant$/i }));
    await user.click(screen.getByRole('option', { name: /Acme Retail/ }));
    await user.click(screen.getByRole('button', { name: /create user/i }));

    expect(await screen.findByTestId('temporary-password-value')).toBeInTheDocument();
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'tenant_admin', tenantId: 10 }),
    );
  });

  it('shows the server message on an ApiError failure (TC-2/TC-3 escalation refusal surfaced)', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError({
        code: 'ROLE_CREATION_NOT_PERMITTED',
        message: 'You may not create a user with this role.',
        status: 403,
      }),
    );
    const user = userEvent.setup();
    renderModal('tenant_admin');

    await user.click(screen.getByRole('combobox', { name: /^role$/i }));
    await user.click(screen.getByRole('option', { name: 'Maker' }));
    await user.type(screen.getByLabelText(/email/i), 'maker@example.invalid');
    await user.type(screen.getByLabelText(/display name/i), 'A Maker');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You may not create a user with this role.',
    );
  });

  it('resets the form and calls onClose when Cancel is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal('tenant_admin', onClose);

    await user.type(screen.getByLabelText(/email/i), 'maker@example.invalid');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
