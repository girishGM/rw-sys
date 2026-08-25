/**
 * T-024 — the mutation hooks every auth screen calls into, kept separate from the screens
 * themselves for two reasons: it lets `LoginPage.tsx`/`ChangePasswordPage.tsx`/etc. stay
 * presentation-focused, and it keeps this file free of components, so it exports freely without
 * tripping `react-refresh/only-export-components` (the workspace lint gate runs at
 * `--max-warnings=0`) — the same split `auth/useBootstrap.ts` / `auth/BootstrapProvider.tsx`
 * already establishes for the guard chain.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BOOTSTRAP_QUERY_KEY } from '../../auth/useBootstrap';
import { changePassword, forgotPassword, login, resetPassword, type LoginResult } from './api';

/**
 * `POST /auth/login`.
 *
 * On a real, session-issuing success, invalidates the shared bootstrap query
 * (`BOOTSTRAP_QUERY_KEY`, `auth/useBootstrap.ts`) so whatever mounts next — the destination the
 * caller navigates to — fetches fresh, rather than serving a cached 401 (never logged in) or a
 * cached 403 `PASSWORD_CHANGE_REQUIRED` (a previous, now-resolved confined session) left over
 * from before this login. Skipped on the `mfaRequired` branch: no session was actually created
 * there (02-SECURITY.md §2a), so there is nothing new for the next mount to see.
 */
export function useLoginMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      login(email, password),
    onSuccess: (result: LoginResult) => {
      if (result.mfaRequired) return;
      void queryClient.invalidateQueries({ queryKey: BOOTSTRAP_QUERY_KEY });
    },
  });
}

/**
 * `POST /auth/change-password`.
 *
 * Invalidates the bootstrap query on success for the same reason `useLoginMutation` does: a
 * session that was confined (`must_change_password`, surfaced to the SPA as a cached 403
 * `PASSWORD_CHANGE_REQUIRED` on `/me/bootstrap` — see `RequireBootstrap.tsx`) is no longer
 * confined the instant this call succeeds, and the next protected route the caller navigates to
 * must not still be redirected back here by stale, pre-change error state.
 */
export function useChangePasswordMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      currentPassword,
      newPassword,
    }: {
      currentPassword: string;
      newPassword: string;
    }) => changePassword(currentPassword, newPassword),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOOTSTRAP_QUERY_KEY });
    },
  });
}

/** `POST /auth/forgot-password` — always resolves the same way regardless of whether the
 * address exists (02-SECURITY.md §2); this hook has no branch to take on that account. */
export function useForgotPasswordMutation() {
  return useMutation({ mutationFn: (email: string) => forgotPassword(email) });
}

/** `POST /auth/reset-password`. No bootstrap invalidation: this call never creates or changes a
 * session, only a password — the user still has to log in afterwards. */
export function useResetPasswordMutation() {
  return useMutation({
    mutationFn: ({ token, newPassword }: { token: string; newPassword: string }) =>
      resetPassword(token, newPassword),
  });
}
