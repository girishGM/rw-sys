import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { mockLogin, mockChangePassword, mockForgotPassword, mockResetPassword } = vi.hoisted(() => ({
  mockLogin: vi.fn(),
  mockChangePassword: vi.fn(),
  mockForgotPassword: vi.fn(),
  mockResetPassword: vi.fn(),
}));

vi.mock('../../../src/features/auth/api', () => ({
  login: mockLogin,
  changePassword: mockChangePassword,
  forgotPassword: mockForgotPassword,
  resetPassword: mockResetPassword,
}));

import { BOOTSTRAP_QUERY_KEY } from '../../../src/auth/useBootstrap';
import {
  useChangePasswordMutation,
  useForgotPasswordMutation,
  useLoginMutation,
  useResetPasswordMutation,
} from '../../../src/features/auth/useAuth';

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  mockLogin.mockReset();
  mockChangePassword.mockReset();
  mockForgotPassword.mockReset();
  mockResetPassword.mockReset();
});

describe('useLoginMutation', () => {
  it('invalidates the bootstrap query on a real (session-issuing) success', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    mockLogin.mockResolvedValue({ role: 'maker', mustChangePassword: false, mfaRequired: false });

    const { result } = renderHook(() => useLoginMutation(), { wrapper: makeWrapper(client) });
    await act(async () => {
      await result.current.mutateAsync({ email: 'a@b.com', password: 'x' });
    });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: BOOTSTRAP_QUERY_KEY }),
    );
  });

  it('does NOT invalidate the bootstrap query when mfaRequired (no session was created)', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    mockLogin.mockResolvedValue({
      role: 'super_admin',
      mustChangePassword: false,
      mfaRequired: true,
    });

    const { result } = renderHook(() => useLoginMutation(), { wrapper: makeWrapper(client) });
    await act(async () => {
      await result.current.mutateAsync({ email: 'a@b.com', password: 'x' });
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe('useChangePasswordMutation', () => {
  it('invalidates the bootstrap query on success (clears a cached confined 403)', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    mockChangePassword.mockResolvedValue(undefined);

    const { result } = renderHook(() => useChangePasswordMutation(), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({ currentPassword: 'old', newPassword: 'NewPassword1!' });
    });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: BOOTSTRAP_QUERY_KEY }),
    );
    expect(mockChangePassword).toHaveBeenCalledWith('old', 'NewPassword1!');
  });
});

describe('useForgotPasswordMutation', () => {
  it('calls through to forgotPassword with the given email', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockForgotPassword.mockResolvedValue(undefined);
    const { result } = renderHook(() => useForgotPasswordMutation(), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync('a@b.com');
    });
    expect(mockForgotPassword).toHaveBeenCalledWith('a@b.com');
  });
});

describe('useResetPasswordMutation', () => {
  it('calls through to resetPassword with the token and new password', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockResetPassword.mockResolvedValue(undefined);
    const { result } = renderHook(() => useResetPasswordMutation(), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({ token: 'tok', newPassword: 'NewPassword1!' });
    });
    expect(mockResetPassword).toHaveBeenCalledWith('tok', 'NewPassword1!');
  });
});
