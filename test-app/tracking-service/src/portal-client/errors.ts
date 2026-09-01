/**
 * T-003 — every failure mode `PortalClient` can produce, each distinct and thrown loudly (TC-10:
 * "fails loudly with a clear error, not a silent empty-data fallback"). No caller of this module
 * should ever see an empty array/object where a real error occurred.
 */

/** `POST /auth/login` was reachable but rejected the configured credentials, or answered with an
 * unexpected shape. Distinct from {@link PortalUnreachableError} — a bad password is not a
 * network problem, and the two should never be confused when reading a log. */
export class PortalAuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`portal login failed: HTTP ${status} — ${truncate(body)}`);
    this.name = 'PortalAuthError';
  }
}

/** `portal/back-end` could not be reached at all — DNS failure, connection refused, timeout.
 * Thrown from both `login()` and every authenticated request; never swallowed into a fallback. */
export class PortalUnreachableError extends Error {
  constructor(
    public readonly baseUrl: string,
    public readonly cause: unknown,
  ) {
    super(`portal/back-end at ${baseUrl} is unreachable: ${describeCause(cause)}`);
    this.name = 'PortalUnreachableError';
  }
}

/** Reached and authenticated, but the specific request failed (404, 500, a second 401 even after
 * re-login, etc). */
export class PortalRequestError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`portal request to ${path} failed: HTTP ${status} — ${truncate(body)}`);
    this.name = 'PortalRequestError';
  }
}

function truncate(value: string, max = 300): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
