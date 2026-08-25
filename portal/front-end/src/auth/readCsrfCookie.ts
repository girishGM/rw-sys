/**
 * T-020 — reads the `rs_csrf` cookie so `useLogout` can attach `X-CSRF-Token` to its
 * `POST /auth/logout` call.
 *
 * This is deliberately the **only** thing auth code reads from `document.cookie`, and it is
 * not the auth token — `rs_csrf` is a non-HttpOnly, non-secret double-submit cookie that
 * exists precisely so JS may read it (04-FRONTEND.md §8). The access/refresh tokens
 * themselves are HttpOnly and never visible to this code, which is what AGENT-PROTOCOL R5
 * requires.
 *
 * T-022 (API client) formalises this as `lib/csrf.ts` for every request the shared
 * `apiClient` makes; this copy exists only so T-020's logout mechanism does not have to wait
 * for T-022 to land. The implementation is intentionally trivial enough that the two staying
 * in sync is a non-issue.
 */
export function readCsrfCookie(): string | null {
  const match = document.cookie.match(/(?:^|; )rs_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}
