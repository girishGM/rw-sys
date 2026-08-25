/**
 * T-047 — gRPC status codes and the one error type the internal surface throws.
 *
 * ### Why this does not reuse `common/errors`
 *
 * `AppError`/`ErrorNormalizationFilter` (T-014) map a failure onto an **HTTP** status and the
 * portal's `{ error: { code, message } }` envelope, and every one of their decisions is made for a
 * browser: 404-not-403 so a cross-tenant id leaks nothing (02-SECURITY.md §5.1), a message
 * resolved through the localisable catalogue, a correlation id the SPA can quote to support.
 *
 * None of that is right here, and one of them is actively wrong. This is a **peer service**, not a
 * user, and 09-INTEGRATION.md §7 says so explicitly:
 *
 * > a request for a tenant outside that set → `PERMISSION_DENIED`, **not** `NOT_FOUND` … leaking
 * > existence to a peer service is not the same threat.
 *
 * A runtime that is told `NOT_FOUND` for a campaign it is entitled to would silently skip
 * transactions; told `PERMISSION_DENIED`, its operators get paged and fix the grant. So the two
 * surfaces deliberately disagree about the same situation, and the disagreement is expressed by
 * having two error types rather than by a flag on one.
 */

/**
 * The subset of canonical gRPC status codes this service uses, with their wire values.
 *
 * Numbers are from the gRPC specification and are what the client library maps back to names —
 * they are not ours to choose.
 */
export const GrpcStatus = Object.freeze({
  OK: 0,
  INVALID_ARGUMENT: 3,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const);

export type GrpcStatusCode = (typeof GrpcStatus)[keyof typeof GrpcStatus];

/** The name of a status code, for logs. */
export function grpcStatusName(code: number): string {
  const entry = Object.entries(GrpcStatus).find(([, value]) => value === code);
  return entry === undefined ? `UNKNOWN(${code})` : entry[0];
}

/**
 * A failure carrying the status the peer should see.
 *
 * `message` **is** sent to the caller, in the `grpc-message` trailer. That is deliberate and is
 * the opposite of the portal's rule about internal messages: the caller is an operated service
 * whose team needs to know *which section* was refused or *which version* failed to resolve, and
 * every message this class is constructed with is written for that reader. Nothing derived from
 * user data, a password, a token or a PII column may be put in one.
 */
export class GrpcError extends Error {
  constructor(
    readonly status: GrpcStatusCode,
    message: string,
    readonly options: { readonly cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'GrpcError';
  }
}

/** No client certificate, or one this portal does not recognise (§7, TC-9/TC-10). */
export class MutualTlsRequiredError extends GrpcError {
  constructor(detail: string) {
    super(GrpcStatus.UNAUTHENTICATED, `mutual TLS required: ${detail}`);
    this.name = 'MutualTlsRequiredError';
  }
}

/**
 * A portal session credential was presented on the internal surface (§7, TC-12/TC-41).
 *
 * Refused rather than ignored. A cookie arriving here means something is misconfigured — a
 * browser, a proxy, or a service reusing the wrong client — and silently serving it would let
 * that misconfiguration persist until the day it mattered.
 */
export class PortalCredentialRejectedError extends GrpcError {
  constructor(header: string) {
    super(
      GrpcStatus.UNAUTHENTICATED,
      `portal session credentials are not accepted on the internal service port ` +
        `(offending header: ${header}); this is a separate trust domain`,
    );
    this.name = 'PortalCredentialRejectedError';
  }
}

/** The identity holds no usable grant, or none covering the requested tenant (§7, TC-11). */
export class ServiceScopeDeniedError extends GrpcError {
  constructor(identity: string, tenantId: number) {
    super(
      GrpcStatus.PERMISSION_DENIED,
      `service identity "${identity}" holds no active grant for tenant ${tenantId}`,
    );
    this.name = 'ServiceScopeDeniedError';
  }
}

/** An **explicit** request for a section the identity is not granted (§4c, TC-32). */
export class SectionNotGrantedError extends GrpcError {
  constructor(identity: string, section: string) {
    super(
      GrpcStatus.PERMISSION_DENIED,
      `service identity "${identity}" is not granted section ${section}`,
    );
    this.name = 'SectionNotGrantedError';
  }
}

/**
 * The configuration could not be assembled completely (§10, TC-26).
 *
 * *"The portal's obligation is to make [fail closed] possible: never return a partial or 'best
 * effort' configuration. A `CampaignConfig` is complete and internally consistent, or it is an
 * error."*
 */
export class IncompleteConfigError extends GrpcError {
  constructor(detail: string) {
    super(
      GrpcStatus.INTERNAL,
      `campaign configuration is incomplete and was not served: ${detail}`,
    );
    this.name = 'IncompleteConfigError';
  }
}

/** The per-identity rate limit was exceeded (§7, TC-28). */
export class RateLimitExceededError extends GrpcError {
  constructor(identity: string, limit: number) {
    super(
      GrpcStatus.RESOURCE_EXHAUSTED,
      `service identity "${identity}" exceeded ${limit} calls per minute`,
    );
    this.name = 'RateLimitExceededError';
  }
}
