/**
 * T-022 — the CSRF half of `apiClient` (04-FRONTEND.md §8, 02-SECURITY.md §4).
 *
 * `rs_csrf` is a **non-HttpOnly**, `Secure; SameSite=Strict` cookie the server sets on
 * login specifically so JavaScript can read it and mirror it into the `X-CSRF-Token`
 * header on every mutating request — it is a double-submit token, not a secret, and
 * reading it here is not a violation of AGENT-PROTOCOL R5 (which is about the *auth*
 * tokens: the access/refresh JWTs stay in `HttpOnly` cookies and are never read by any
 * code in this SPA, this file included).
 *
 * `auth/readCsrfCookie.ts` (T-020) holds a near-identical, deliberately duplicated copy
 * used only by `useLogout`, which could not wait for this task to land — see that file's
 * own banner. The two are trivial enough that keeping them in sync by inspection is a
 * non-issue; this module is the one every other consumer (`apiClient`) should use.
 */

/** The cookie the server sets on login and rotates on refresh. */
export const CSRF_COOKIE_NAME = 'rs_csrf';

/** The header `apiClient` mirrors {@link CSRF_COOKIE_NAME} into. */
export const CSRF_HEADER_NAME = 'X-CSRF-Token';

/**
 * Reads the current `rs_csrf` cookie value, or `null` when it is not set — e.g. before
 * the first login, or after `resetTransport`-style cleanup on logout.
 *
 * Takes the cookie string as an optional parameter (defaulting to `document.cookie`) so
 * it is trivially unit-testable without mutating the real `document.cookie` jar.
 */
export function readCsrfToken(cookieString: string = document.cookie): string | null {
  const match = cookieString.match(/(?:^|; )rs_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Whether a request method needs `X-CSRF-Token` at all.
 *
 * Mirrors `CsrfGuard` on the server exactly (02-SECURITY.md §4: *"`GET`/`HEAD`/`OPTIONS`
 * are exempt... no `GET` endpoint may ever mutate state"*) — TC-1 depends on this staying
 * in lock-step with the server's own exemption list.
 */
export function requiresCsrfHeader(method: string | undefined): boolean {
  const normalised = (method ?? 'get').toLowerCase();
  return normalised !== 'get' && normalised !== 'head' && normalised !== 'options';
}
