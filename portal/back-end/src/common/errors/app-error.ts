/**
 * T-014 — the error vocabulary of the application, and the shape of every error response.
 *
 * ### One envelope, one catalogue
 *
 * 03-API-CONTRACT.md §1 fixes the wire shape:
 *
 * ```jsonc
 * { "error": { "code": "PERM_DENIED", "message": "…", "details": [ { "field": "…", "code": "…" } ],
 *              "traceId": "b7f3…" } }
 * ```
 *
 * `code` is a `system_messages` key — *"always a `system_messages` key, never an internal
 * message"*. `message` is that key's text, looked up server-side by `MessageService` as a
 * convenience for non-SPA clients and support tooling; the SPA localises `code` itself.
 * `details` exists on validation failures only. `traceId` is the correlation id
 * (08-OBSERVABILITY.md §2: *"the error-response `traceId` **is** the `correlation_id`,
 * deliberately"*).
 *
 * ### Why `AppError` is not an `HttpException`
 *
 * The service layer throws these, and services are unit-tested without a request in sight. The
 * same separation T-010 drew between `auth.errors.ts` (domain) and `auth.exceptions.ts`
 * (transport) applies here: a service says *"this campaign code is already taken"*, and
 * `ErrorNormalizationFilter` — the one component that knows about HTTP — decides that this is a
 * 409 carrying `DUPLICATE_RESOURCE`. Nest's `HttpException`s thrown by earlier tasks keep
 * working unchanged; the filter recognises both.
 *
 * ### `message` on the Error object never reaches a client
 *
 * `AppError.message` (the JS `Error` field) is a developer-facing sentence for the server log.
 * The filter never copies it into a response — the response's `message` comes from the
 * catalogue, keyed by `code`. This is the single most important invariant in this file: it is
 * why a `new ConflictError('campaign_code T042 already exists in tenant 7')` is safe to write.
 */

/** One entry of the `details` array. Validation failures only (03-API-CONTRACT.md §1). */
export interface ErrorDetail {
  readonly field: string;
  readonly code: string;
}

/** The error half of the response envelope. */
export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: readonly ErrorDetail[];
    readonly traceId: string;
  };
}

/**
 * The catalogue of codes this task introduces, on top of those T-010…T-013 already define
 * (`AUTH_*`, `PERM_DENIED`, `NOT_FOUND`, `CSRF_*`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`).
 *
 * Every one of them is a `system_messages` key. Several have **no row in the table yet** — see
 * the T-014 completion report, which lists them for the seed migration that must follow; until
 * then `MessageService` degrades to returning the key, which is safe (no internal detail) but
 * unlocalised.
 */
export const ERROR_CODE = Object.freeze({
  /** The catch-all. Anything unmapped, unexpected, or thrown by the database itself. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** A DTO failed `class-validator`. The only code that ever carries `details`. */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /**
   * Not found **or** out of scope — deliberately one code for both (02-SECURITY.md §5.1).
   * Identical to `SCOPE_ERROR_CODE.NOT_FOUND` and `AUTH_ERROR_CODE.NOT_FOUND`; asserted equal
   * in `error-normalization.filter.spec.ts` so the three cannot drift apart.
   */
  NOT_FOUND: 'NOT_FOUND',
  /** A unique constraint, or a client attempting a state transition that is not allowed. */
  CONFLICT: 'CONFLICT',
  /** A row with this business key already exists. The mapped form of `UniqueConstraintError`. */
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',
  /** A referenced row does not exist. The mapped form of `ForeignKeyConstraintError`. */
  RELATED_RESOURCE_MISSING: 'RELATED_RESOURCE_MISSING',
  /** 422 — the request is well-formed and permitted, but a business rule forbids it. */
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
  /** 403 from the authorisation layers. Mirrors `PERMISSION_DENIED_CODE` in `rbac.constants`. */
  PERM_DENIED: 'PERM_DENIED',
  /** 401. Mirrors `AUTH_ERROR_CODE.SESSION_INVALID`. */
  AUTH_SESSION_INVALID: 'AUTH_SESSION_INVALID',
  /** 429. Mirrors `SECURITY_ERROR_CODE.RATE_LIMITED`. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** 503. Mirrors `SECURITY_ERROR_CODE.SERVICE_UNAVAILABLE`. */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
});

/**
 * The shape a code must have to be allowed into a response body.
 *
 * This is the mechanical half of TC-12 (*"response body scanned for `reward_config`, `SELECT`,
 * `at Object.` — zero matches on any error path"*). Rather than trusting every present and
 * future thrower to pass a safe code, the filter validates: `UPPER_SNAKE_CASE`, ≤ 60 characters
 * (the `system_messages.message_key` column width is 80, and `portal_audit_log.event_type` is
 * 60). A constraint name (`uq_tc_tenant_code`), a SQL fragment, a file path and a stack frame
 * all fail this pattern, so none of them can reach a client even if some future code path hands
 * one over by mistake.
 */
export const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,59}$/;

/** Whether `code` may appear in a response body. See {@link SAFE_ERROR_CODE_PATTERN}. */
export function isSafeErrorCode(code: unknown): code is string {
  return typeof code === 'string' && SAFE_ERROR_CODE_PATTERN.test(code);
}

/**
 * A field name is echoed back to the client in `details`, so it gets the same treatment as a
 * code: a conservative pattern that accepts DTO property paths (`policies[0].unitCode`) and
 * rejects anything that could carry a sentence, a path or SQL.
 */
export const SAFE_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_.[\]]{0,79}$/;

/** Whether one `details` entry is safe to serialise. Both halves must pass. */
export function isSafeDetail(detail: unknown): detail is ErrorDetail {
  if (detail === null || typeof detail !== 'object') return false;
  const candidate = detail as { field?: unknown; code?: unknown };
  return (
    typeof candidate.field === 'string' &&
    SAFE_FIELD_PATTERN.test(candidate.field) &&
    isSafeErrorCode(candidate.code)
  );
}

/** Options every {@link AppError} accepts. */
export interface AppErrorOptions {
  /** Validation failures only. Filtered through {@link isSafeDetail} before serialisation. */
  readonly details?: readonly ErrorDetail[];
  /** Developer-facing sentence for the **server log**. Never serialised into a response. */
  readonly logMessage?: string;
  /** Structured context for the server log. Redacted before it is written. */
  readonly logContext?: Record<string, unknown>;
  /** The underlying error, kept for the log. Never serialised. */
  readonly cause?: unknown;
}

/**
 * The base class for every error the application raises deliberately.
 *
 * Carries an HTTP status because the alternative — a filter that maps error *classes* to
 * statuses in a lookup table somewhere else — puts the two halves of one decision in two files
 * and lets them disagree.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: readonly ErrorDetail[];
  readonly logContext?: Record<string, unknown>;

  constructor(code: string, status: number, options: AppErrorOptions = {}) {
    super(options.logMessage ?? `${code} (${status})`);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = options.details;
    this.logContext = options.logContext;
    if (options.cause !== undefined) {
      // `cause` is standard on `Error` from ES2022; the project targets an older lib, so it is
      // assigned rather than passed to `super`. Server-log only, like everything else here.
      Object.defineProperty(this, 'cause', { value: options.cause, enumerable: false });
    }
  }
}

/** 400 — a DTO failed validation. The only error that carries `details`. */
export class ValidationFailedError extends AppError {
  constructor(details: readonly ErrorDetail[], options: AppErrorOptions = {}) {
    super(ERROR_CODE.VALIDATION_FAILED, 400, { ...options, details });
  }
}

/**
 * 404 — not found, or out of scope. See `scope.exceptions.ts` for why there is no 403 sibling.
 *
 * `ScopeViolationError` (T-013) remains the one Wave 3 throws from a repository; this exists for
 * service-layer code that has already loaded a row and found it unusable.
 */
export class NotFoundError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(ERROR_CODE.NOT_FOUND, 404, options);
  }
}

/** 409 — a state transition that is not allowed, or a duplicate the service detected itself. */
export class ConflictError extends AppError {
  constructor(code: string = ERROR_CODE.CONFLICT, options: AppErrorOptions = {}) {
    super(code, 409, options);
  }
}

/** 422 — well-formed, authorised, and forbidden by a business rule (e.g. self-approval). */
export class BusinessRuleError extends AppError {
  constructor(code: string = ERROR_CODE.BUSINESS_RULE_VIOLATION, options: AppErrorOptions = {}) {
    super(code, 422, options);
  }
}

/** Type guard, exported so the filter and Wave 3 tests agree on what counts as an `AppError`. */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
