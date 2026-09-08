/**
 * T-INT-021 — mirrors `rap-client/errors.ts`'s/`reward-tracking-client/errors.ts`'s split: a
 * network-level failure is a different situation from a reached-but-rejected request, so a call
 * site never has to guess which one happened. Two kinds are unique to this client:
 *
 *  - {@link RapProgressTransportNotAvailableError} — a locally-detected misconfiguration for one
 *    transport (e.g. an invalid/partial gRPC TLS setup) that fails that one transport closed,
 *    never a silent hang or an attempted connection with bad material.
 *  - {@link RapProgressUnavailableError} — the *final* failure `ConfigurableRapProgressClient`
 *    throws once both the primary transport and its automatic fallback have failed to reach RAP at
 *    all. This is the one error `routes/dashboard.ts` catches to render the "progress unknown"
 *    state (this task's own Implementation note 4) — a reached-but-rejected request
 *    ({@link RapProgressRequestError}) is deliberately NOT folded into this, and is left to
 *    propagate immediately: a 401/403/etc. from RAP is a real, actionable misconfiguration, not a
 *    "RAP is currently unreachable" situation a fallback attempt could ever fix.
 */

export class RapProgressUnreachableError extends Error {
  constructor(
    public readonly transport: 'REST' | 'GRPC',
    public readonly target: string,
    public readonly cause: unknown,
  ) {
    super(
      `realtime-activity-processing-service progress API (${transport}) at ${target} is ` +
        `unreachable: ${describeCause(cause)}`,
    );
    this.name = 'RapProgressUnreachableError';
  }
}

/** The request reached RAP but was rejected — a real HTTP status (REST) or gRPC status code
 * (`UNAUTHENTICATED`, `PERMISSION_DENIED`, `INVALID_ARGUMENT`, ...) came back. */
export class RapProgressRequestError extends Error {
  constructor(
    public readonly transport: 'REST' | 'GRPC',
    public readonly status: number,
    public readonly details: string,
  ) {
    super(
      `progress request reached RAP (${transport}) but was rejected: status ${status} — ${details}`,
    );
    this.name = 'RapProgressRequestError';
  }
}

export class RapProgressTransportNotAvailableError extends Error {
  constructor(
    public readonly transport: 'REST' | 'GRPC',
    reason: string,
  ) {
    super(`rap-progress-client: ${transport} is not available for this leg right now: ${reason}`);
    this.name = 'RapProgressTransportNotAvailableError';
  }
}

/** Thrown by {@link import('./client').ConfigurableRapProgressClient} once every attempted
 * transport (primary, then its automatic fallback) has failed to reach RAP. `routes/dashboard.ts`
 * is the one place in this task's own scope that catches this. */
export class RapProgressUnavailableError extends Error {
  constructor(
    public readonly primaryError: unknown,
    public readonly fallbackError: unknown,
  ) {
    super(
      `realtime-activity-processing-service progress API is unavailable on every attempted ` +
        `transport — primary: ${describeCause(primaryError)}; fallback: ${describeCause(fallbackError)}`,
    );
    this.name = 'RapProgressUnavailableError';
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
