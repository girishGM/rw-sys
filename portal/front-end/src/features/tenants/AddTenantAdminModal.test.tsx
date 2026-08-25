import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../../lib/apiError';

const { mockMutateAsync, mockUseCreateTenantAdminMutation } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseCreateTenantAdminMutation: vi.fn(),
}));

vi.mock('./api', () => ({ useCreateTenantAdminMutation: mockUseCreateTenantAdminMutation }));

import { AddTenantAdminModal } from './AddTenantAdminModal';

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AddTenantAdminModal open onClose={onClose} tenantId={10} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseCreateTenantAdminMutation.mockReset();
  mockUseCreateTenantAdminMutation.mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  });
});

describe('AddTenantAdminModal', () => {
  it('rejects an invalid email before calling the API', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/email/i), 'not-an-email');
    await user.type(screen.getByLabelText(/display name/i), 'Admin');
    await user.click(screen.getByRole('button', { name: /create admin/i }));

    expect(await screen.findByText(/invalid email/i)).toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('submits and reveals the one-time password on success', async () => {
    mockMutateAsync.mockResolvedValue({
      id: 5,
      email: 'admin@example.invalid',
      displayName: 'Admin',
      role: 'tenant_admin',
      tenantId: 10,
      temporaryPassword: 'Xy9!kLmnpQ2*Zvwr4Tabcd7',
    });
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/email/i), 'admin@example.invalid');
    await user.type(screen.getByLabelText(/display name/i), 'Admin');
    await user.click(screen.getByRole('button', { name: /create admin/i }));

    expect(await screen.findByTestId('temporary-password-value')).toBeInTheDocument();
    expect(mockMutateAsync).toHaveBeenCalledWith({
      email: 'admin@example.invalid',
      displayName: 'Admin',
    });
  });

  it('shows the server message on an ApiError failure (e.g. duplicate email)', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError({ code: 'TENANT_ADMIN_EMAIL_EXISTS', message: 'Already in use.', status: 409 }),
    );
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/email/i), 'admin@example.invalid');
    await user.type(screen.getByLabelText(/display name/i), 'Admin');
    await user.click(screen.getByRole('button', { name: /create admin/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Already in use.');
  });

  it('falls back to a generic message for a non-ApiError failure', async () => {
    mockMutateAsync.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/email/i), 'admin@example.invalid');
    await user.type(screen.getByLabelText(/display name/i), 'Admin');
    await user.click(screen.getByRole('button', { name: /create admin/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
  });

  it('resets the form and calls onClose when Cancel is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/email/i), 'admin@example.invalid');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose after Done, once the credential has been shown', async () => {
    mockMutateAsync.mockResolvedValue({
      id: 5,
      email: 'admin@example.invalid',
      displayName: 'Admin',
      role: 'tenant_admin',
      tenantId: 10,
      temporaryPassword: 'x',
    });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/email/i), 'admin@example.invalid');
    await user.type(screen.getByLabelText(/display name/i), 'Admin');
    await user.click(screen.getByRole('button', { name: /create admin/i }));
    await screen.findByTestId('temporary-password-value');

    await user.click(screen.getByRole('button', { name: /^done$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
