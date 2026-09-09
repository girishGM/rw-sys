/**
 * T-INT-022 — mirrors `promo-code-client/errors.ts`'s split: a network-level failure is distinct
 * from a reached-but-rejected request, so a catch site never has to guess which one happened. A
 * third kind is unique to this client: {@link RewardTrackingTransportNotAvailableError}, thrown
 * when `REWARD_TRACKING_TRANSPORT_PRIMARY=GRPC` is selected but reward-tracking-service has no
 * read-facing gRPC surface today (confirmed by direct read of `reward-tracking-service/src/grpc/**`
 * — ingest-only, see this task's own completion report) — a deliberate fail-closed error, never a
 * silent hang or an attempted connection to a service that was never built.
 */

export class RewardTrackingUnreachableError extends Error {
  constructor(
    public readonly baseUrl: string,
    public readonly cause: unknown,
  ) {
    super(`reward-tracking-service at ${baseUrl} is unreachable: ${describeCause(cause)}`);
    this.name = 'RewardTrackingUnreachableError';
  }
}

export class RewardTrackingRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`reward-tracking-service request failed: HTTP ${status} — ${truncate(body)}`);
    this.name = 'RewardTrackingRequestError';
  }
}

/** Thrown by {@link import('./client').RewardTrackingClient} itself (never by `rest.client.ts`)
 * when the configured transport has nothing real behind it yet. */
export class RewardTrackingTransportNotAvailableError extends Error {
  constructor(public readonly transport: string) {
    super(
      `reward-tracking-client: ${transport} is not available for this leg yet — ` +
        'reward-tracking-service exposes no read-facing gRPC surface today (ingest-only). ' +
        "Set REWARD_TRACKING_TRANSPORT_PRIMARY=REST, or see this task's completion report for " +
        'the filed follow-up defect that would add one.',
    );
    this.name = 'RewardTrackingTransportNotAvailableError';
  }
}

function truncate(value: string, max = 300): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
