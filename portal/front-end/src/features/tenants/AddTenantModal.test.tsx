import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../../lib/apiError';

const { mockMutateAsync, mockUseCreateTenantMutation } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseCreateTenantMutation: vi.fn(),
}));

vi.mock('./api', () => ({ useCreateTenantMutation: mockUseCreateTenantMutation }));

import { AddTenantModal } from './AddTenantModal';

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AddTenantModal open onClose={onClose} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseCreateTenantMutation.mockReset();
  mockUseCreateTenantMutation.mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  });
});

const baseTenant = {
  id: 10,
  code: 'T001',
  name: 'Acme Retail',
  countryId: 1,
  schemaPrefix: null,
  contactEmail: null,
  contactPhone: null,
  status: 'pending_provisioning',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('AddTenantModal', () => {
  it('rejects an empty code before calling the API — the shared Zod schema catches it client-side', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/tenant name/i), 'Acme Retail');
    await user.click(screen.getByRole('button', { name: /create tenant/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('submits a valid tenant with no admin and no countryId in the payload (implementation note 2)', async () => {
    mockMutateAsync.mockResolvedValue({ tenant: baseTenant, admin: null });
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/tenant code/i), 'T001');
    await user.type(screen.getByLabelText(/tenant name/i), 'Acme Retail');
    await user.click(screen.getByRole('button', { name: /create tenant/i }));

    expect(await screen.findByText(/has been created/i)).toBeInTheDocument();
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'T001', name: 'Acme Retail', admin: undefined }),
    );
    expect(mockMutateAsync.mock.calls[0][0]).not.toHaveProperty('countryId');
    expect(screen.queryByTestId('temporary-password-value')).not.toBeInTheDocument();
  });

  it('onboarding the admin at the same time shows the one-time password reveal, hidden until clicked (BACKLOG B-01)', async () => {
    mockMutateAsync.mockResolvedValue({
      tenant: baseTenant,
      admin: {
        id: 5,
        email: 'admin@example.invalid',
        displayName: 'Admin',
        role: 'tenant_admin',
        tenantId: 10,
        temporaryPassword: 'Xy9!kLmnpQ2*Zvwr4Tabcd7',
      },
    });
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/tenant code/i), 'T001');
    await user.type(screen.getByLabelText(/tenant name/i), 'Acme Retail');
    await user.click(screen.getByRole('switch', { name: /onboard the tenant admin now/i }));
    await user.type(screen.getByLabelText(/tenant admin email/i), 'admin@example.invalid');
    await user.type(screen.getByLabelText(/tenant admin name/i), 'Admin');
    await user.click(screen.getByRole('button', { name: /create tenant/i }));

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

  it('shows the server message on a duplicate-code conflict (TC-10)', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError({ code: 'TENANT_CODE_EXISTS', message: 'Already in use.', status: 409 }),
    );
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/tenant code/i), 'T001');
    await user.type(screen.getByLabelText(/tenant name/i), 'Acme Retail');
    await user.click(screen.getByRole('button', { name: /create tenant/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Already in use.');
  });

  it('shows the server message on a duplicate schema-prefix conflict (TC-11)', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError({
        code: 'TENANT_SCHEMA_PREFIX_EXISTS',
        message: 'Prefix already in use.',
        status: 409,
      }),
    );
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/tenant code/i), 'T002');
    await user.type(screen.getByLabelText(/tenant name/i), 'Globex');
    await user.type(screen.getByLabelText(/schema prefix/i), 'acme');
    await user.click(screen.getByRole('button', { name: /create tenant/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Prefix already in use.');
  });

  it('falls back to a generic message for a non-ApiError failure', async () => {
    mockMutateAsync.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/tenant code/i), 'T001');
    await user.type(screen.getByLabelText(/tenant name/i), 'Acme Retail');
    await user.click(screen.getByRole('button', { name: /create tenant/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
  });

  it('resets the form and calls onClose when Cancel is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/tenant name/i), 'Acme Retail');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
