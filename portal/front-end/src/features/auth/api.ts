/**
 * T-024 — the `/auth/*` calls this feature makes: login, change-password, forgot-password,
 * reset-password (`back-end/src/modules/auth/auth.controller.ts`). `logout`/`refresh` already
 * live in `lib/apiClient.ts`/`auth/useBootstrap.ts` (T-020/T-022) and are not duplicated here.
 *
 * Every call goes through the shared `api` client (T-022, `lib/apiClient.ts`) rather than a
 * bare axios instance. CSRF injection is a harmless no-op before a session exists (there is no
 * `rs_csrf` cookie yet to mirror), and T-018's transport encryption degrades to TLS-only for
 * the same reason (no session key yet) — both start applying automatically the moment a session
 * exists, with nothing this file has to do differently for "before" versus "after" login.
 */
import { z } from 'zod';
import { portalRoleSchema, type SharedPortalRole } from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { ApiError, toApiError } from '../../lib/apiError';

/**
 * `AUTH_ERROR_CODE` (`back-end/src/modules/auth/session.constants.ts`) — the subset this
 * feature branches on. Duplicated by necessity: the back end is not importable from the SPA,
 * and these codes are not part of `packages/shared` (out of this task's file scope, R9). Every
 * other error is rendered generically via `ApiError.message`, per `lib/apiError.ts`'s own
 * contract — this list only names the codes a screen needs to react to *differently*.
 */
export const AUTH_ERROR_CODE = Object.freeze({
  INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  PASSWORD_POLICY: 'AUTH_PASSWORD_POLICY',
  RESET_TOKEN_INVALID: 'AUTH_RESET_TOKEN_INVALID',
});

const loginResponseSchema = z
  .object({
    role: portalRoleSchema,
    mustChangePassword: z.boolean(),
    mfaRequired: z.boolean(),
  })
  .strict();

export interface LoginResult {
  readonly role: SharedPortalRole;
  readonly mustChangePassword: boolean;
  /** `true` when a second factor is still outstanding — **no session was created** (02-SECURITY
   * §2a). MFA verification itself is out of T-024's scope; see `LoginPage.tsx`'s own comment. */
  readonly mfaRequired: boolean;
}

async function postAuthVoid(path: string, body: unknown): Promise<void> {
  try {
    await api.post(path, body);
  } catch (error) {
    throw toApiError(error);
  }
}

async function postAuthData<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  try {
    const response = await api.post<{ data: unknown }>(path, body);
    const parsed = schema.safeParse(response.data.data);
    if (!parsed.success) {
      throw new Error(
        `${path} response did not match the expected shape: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    return parsed.data;
  } catch (error) {
    throw toApiError(error);
  }
}

/** `POST /auth/login`. Never resolves with a token of any kind — see `LoginResponseDto`'s own
 * comment; the session lives entirely in the `Set-Cookie` headers the browser handles itself. */
export function login(email: string, password: string): Promise<LoginResult> {
  return postAuthData('/auth/login', { email, password }, loginResponseSchema);
}

/** `POST /auth/change-password`. 204 on success — nothing to parse. */
export function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  return postAuthVoid('/auth/change-password', { currentPassword, newPassword });
}

/** `POST /auth/forgot-password`. Always 204, whether or not the address exists
 * (02-SECURITY.md §2) — the caller must not read anything into the fact that this resolved. */
export function forgotPassword(email: string): Promise<void> {
  return postAuthVoid('/auth/forgot-password', { email });
}

/** `POST /auth/reset-password`. 204 on success; a 400 `AUTH_RESET_TOKEN_INVALID` covers an
 * unknown, expired *and* already-used token identically (implementation note 7). */
export function resetPassword(token: string, newPassword: string): Promise<void> {
  return postAuthVoid('/auth/reset-password', { token, newPassword });
}

/**
 * TC-5: "Rate-limited (429) → 'Too many attempts, try again in N minutes'". Built from
 * `ApiError.retryAfterSeconds` (parsed from the `Retry-After` header by `lib/apiError.ts`)
 * rather than from `ApiError.message`, because the catalogue message for `RATE_LIMITED` is a
 * static string that does not know the caller's specific wait — the whole reason
 * `retryAfterSeconds` is surfaced on `ApiError` in the first place (see that field's own
 * comment: "TC-11" there). Returns `null` for anything else, so a caller can fall back to
 * `error.message` uniformly.
 */
export function describeRateLimit(error: ApiError): string | null {
  if (error.status !== 429 || error.retryAfterSeconds === undefined) return null;
  const minutes = Math.max(1, Math.ceil(error.retryAfterSeconds / 60));
  return `Too many attempts, try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

/** The one line every screen in this feature uses to turn a caught error into display copy. */
export function describeAuthError(error: ApiError): string {
  return describeRateLimit(error) ?? error.message;
}
