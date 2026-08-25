/**
 * T-020 — validates the `?next=` query value used by the guard chain
 * (04-FRONTEND.md §2, implementation note 4).
 *
 * `RequireAuth` builds `next` from the path the user was trying to reach before it
 * redirects to `/login`; the login screen (T-024, `features/auth/**`) reads it back after
 * a successful sign-in to send the user where they meant to go. Both sides must agree on
 * what counts as a *safe* value, so that logic lives once, here, rather than being
 * duplicated (and potentially drifting) between this task and T-024.
 *
 * **This is the direct fix for an open redirect.** `next` is attacker-controlled (it comes
 * straight off the URL), so only an in-app, same-origin, relative path is ever honoured —
 * never an absolute URL (`https://evil.com`) and never a protocol-relative one (`//evil.com`,
 * which the browser resolves as absolute using the current protocol).
 */

/** Where an invalid, missing or unsafe `next` value falls back to. */
export const DEFAULT_NEXT_PATH = '/dashboard';

export function resolveNextPath(next: string | null | undefined): string {
  if (!next) {
    return DEFAULT_NEXT_PATH;
  }

  // Must be a single-slash-prefixed, in-app path. `//evil.com` and `/\evil.com` (some
  // browsers normalise a leading backslash to a slash) both resolve as protocol-relative
  // absolute URLs, so both are rejected here before any parsing happens.
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
    return DEFAULT_NEXT_PATH;
  }

  try {
    // Resolving against the current origin turns any remaining absolute-URL trick (e.g. an
    // embedded scheme) into something `URL` either rejects or normalises safely; comparing
    // the resulting origin is the actual guard.
    const resolved = new URL(next, window.location.origin);
    if (resolved.origin !== window.location.origin) {
      return DEFAULT_NEXT_PATH;
    }
    return `${resolved.pathname}${resolved.search}${resolved.hash}` || DEFAULT_NEXT_PATH;
  } catch {
    return DEFAULT_NEXT_PATH;
  }
}

/** Builds the `?next=` query value `RequireAuth` redirects unauthenticated users with. */
export function buildLoginRedirect(pathname: string, search: string): string {
  return `/login?next=${encodeURIComponent(`${pathname}${search}`)}`;
}
