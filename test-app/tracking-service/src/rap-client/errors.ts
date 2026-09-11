/** Mirrors `promo-code-client/errors.ts`'s split: a network-level failure, a reached-but-rejected
 * request, and a request this client itself refused to even send are three different situations —
 * so a log/catch site (`routes/activities.ts`) never has to guess which one happened. All three
 * are equally "this optional integration didn't work this time" for that call site's purposes
 * (see its own comment on why none of them may ever affect the customer-facing response), but
 * distinguishing them makes the logged message actually useful for whoever is running RAP locally
 * to debug why a submission didn't land. */

/** T-INT-054: `target` names whichever transport/address actually failed (a gRPC `host:port`, or a
 * REST URL) — this class is shared by both transports (`client.ts`'s gRPC client and
 * `rest.client.ts`'s REST client) rather than each having its own, so `configurable.client.ts`'s
 * fallback logic only needs one `instanceof` check regardless of which transport is primary. */
export class RapServiceUnreachableError extends Error {
  constructor(
    public readonly target: string,
    public readonly cause: unknown,
  ) {
    super(
      `realtime-activity-processing-service at ${target} is unreachable: ${describeCause(cause)}`,
    );
    this.name = 'RapServiceUnreachableError';
  }
}

/** The request reached RAP but was rejected — a real gRPC status code (`INVALID_ARGUMENT`,
 * `PERMISSION_DENIED` from `MtlsGuard`, `UNAUTHENTICATED`, ...) or a real HTTP status code (`401`
 * from `ActivityIngestRestTokenGuard`, `400` from request validation, ...), depending on which
 * transport made the call (T-INT-054: shared by both, same reasoning `RapServiceUnreachableError`'s
 * own header just gave). */
export class RapServiceRequestError extends Error {
  constructor(
    public readonly code: number,
    public readonly details: string,
  ) {
    super(`SubmitActivity request reached RAP but was rejected: status ${code} — ${details}`);
    this.name = 'RapServiceRequestError';
  }
}

/** This client's own local check — mirroring the exact required-field rules RAP's real
 * `ActivityIngestController.toInboundActivity` enforces (`activity-ingest.controller.ts`) — failed
 * before any network call was attempted. Kept distinct from {@link RapServiceRequestError} because
 * no gRPC status code exists yet for it; it never left this process. Reused verbatim (not a new,
 * transport-specific subclass) by `rest.client.ts`'s own local validation (e.g. a missing
 * `tenantId`) — same "failed before any network call" meaning, regardless of which transport. */
export class RapServiceValidationError extends Error {
  constructor(message: string) {
    super(`SubmitActivity request is invalid: ${message}`);
    this.name = 'RapServiceValidationError';
  }
}

/**
 * T-INT-054. A locally-detected misconfiguration for one transport (e.g. `RAP_ACTIVITY_REST_TOKEN`
 * unset while `RAP_ACTIVITY_REST_BASE_URL` implies REST should be usable) that fails that one
 * transport closed, never a silent hang or a request sent with bad/missing credentials — mirrors
 * `rap-progress-client/errors.ts`'s own `RapProgressTransportNotAvailableError`.
 */
export class RapServiceTransportNotAvailableError extends Error {
  constructor(
    public readonly transport: 'REST' | 'GRPC',
    reason: string,
  ) {
    super(`rap-client: ${transport} is not available for this leg right now: ${reason}`);
    this.name = 'RapServiceTransportNotAvailableError';
  }
}

/**
 * T-INT-054. Thrown by {@link import('./configurable.client').ConfigurableRapActivityClient} once
 * every attempted transport (primary, then its automatic fallback) has failed to reach RAP at all —
 * the one error `routes/activities.ts` catches and logs, exactly as it already does for every other
 * `submitActivity` failure mode (this integration's own "must never affect this app's own response"
 * contract, unchanged by this task). Mirrors `rap-progress-client/errors.ts`'s own
 * `RapProgressUnavailableError`.
 */
export class RapServiceUnavailableError extends Error {
  constructor(
    public readonly primaryError: unknown,
    public readonly fallbackError: unknown,
  ) {
    super(
      `realtime-activity-processing-service SubmitActivity is unavailable on every attempted ` +
        `transport — primary: ${describeCause(primaryError)}; fallback: ${describeCause(fallbackError)}`,
    );
    this.name = 'RapServiceUnavailableError';
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
