/** Mirrors `portal-client/errors.ts`'s split: a network-level failure is distinct from a
 * reached-but-rejected request, so a log/catch site never has to guess which one happened. */

export class PromoCodeServiceUnreachableError extends Error {
  constructor(
    public readonly baseUrl: string,
    public readonly cause: unknown,
  ) {
    super(`promo-code-service at ${baseUrl} is unreachable: ${describeCause(cause)}`);
    this.name = 'PromoCodeServiceUnreachableError';
  }
}

/** A real HTTP error status — the generate endpoint's own contract reserves this for `401` (bad
 * `GENERATION_SERVICE_TOKEN`), `400` (malformed request body), or `500`; a business rejection
 * (no active binding, an inactive config, ...) is a `200` with `status: 'FAILED'` instead, never
 * this error. */
export class PromoCodeServiceRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`promo-code-service generate request failed: HTTP ${status} — ${truncate(body)}`);
    this.name = 'PromoCodeServiceRequestError';
  }
}

function truncate(value: string, max = 300): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
