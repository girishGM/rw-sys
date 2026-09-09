/** Mirrors `promo-code-client/errors.ts`'s split: a network-level failure, a reached-but-rejected
 * request, and a request this client itself refused to even send are three different situations —
 * so a log/catch site (`routes/activities.ts`) never has to guess which one happened. All three
 * are equally "this optional integration didn't work this time" for that call site's purposes
 * (see its own comment on why none of them may ever affect the customer-facing response), but
 * distinguishing them makes the logged message actually useful for whoever is running RAP locally
 * to debug why a submission didn't land. */

export class RapServiceUnreachableError extends Error {
  constructor(
    public readonly target: string,
    public readonly cause: unknown,
  ) {
    super(
      `realtime-activity-processing-service gRPC server at ${target} is unreachable: ${describeCause(cause)}`,
    );
    this.name = 'RapServiceUnreachableError';
  }
}

/** The request reached RAP's `ActivityIngestService` but was rejected — a real gRPC status code
 * (`INVALID_ARGUMENT`, `PERMISSION_DENIED` from `MtlsGuard`, `UNAUTHENTICATED`, ...) came back. */
export class RapServiceRequestError extends Error {
  constructor(
    public readonly code: number,
    public readonly details: string,
  ) {
    super(`SubmitActivity request reached RAP but was rejected: gRPC status ${code} — ${details}`);
    this.name = 'RapServiceRequestError';
  }
}

/** This client's own local check — mirroring the exact required-field rules RAP's real
 * `ActivityIngestController.toInboundActivity` enforces (`activity-ingest.controller.ts`) — failed
 * before any network call was attempted. Kept distinct from {@link RapServiceRequestError} because
 * no gRPC status code exists yet for it; it never left this process. */
export class RapServiceValidationError extends Error {
  constructor(message: string) {
    super(`SubmitActivity request is invalid: ${message}`);
    this.name = 'RapServiceValidationError';
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
