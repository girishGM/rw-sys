/**
 * T-022 — the one error shape every feature renders (04-FRONTEND.md §8 implementation
 * note 5).
 *
 * The server's error envelope (`ErrorNormalizationFilter`, T-014; 03-API-CONTRACT.md §1)
 * is
 * ```jsonc
 * { "error": { "code": "PERM_DENIED", "message": "…", "details": [{ "field", "code" }], "traceId": "…" } }
 * ```
 * — `code` is a `system_messages` key, `message` is that key's text, already localised
 * server-side (07a of 04-FRONTEND.md: v1 is English-only, so "localised" today just means
 * "not invented by the client"). {@link toApiError} is the **only** place in the SPA that
 * reads that envelope; everything else — every feature hook, every toast — reads the
 * typed {@link ApiError} it produces. That is the whole point of implementation note 5:
 * *"Feature code renders `message`... and never invents its own copy for a server-side
 * failure."*
 *
 * `toApiError` is total: every input — a real `AxiosError` with a server envelope, an
 * `AxiosError` with no `response` (offline, CORS, timeout), a thrown
 * `TransportCryptoError` from the request/response encryption layer (T-018), or literally
 * anything else a `try`/`catch` can catch — produces a well-formed `ApiError`. A feature
 * that calls `toApiError(error)` never has to `instanceof` its way through a raw axios
 * error again.
 */
import axios from 'axios';
import { TransportCryptoError } from './transportCrypto';

/** One entry of a validation failure's `details` array. Mirrors `ErrorDetail` (back-end `app-error.ts`). */
export interface ApiErrorDetail {
  readonly field: string;
  readonly code: string;
}

export interface ApiErrorParams {
  readonly code: string;
  readonly message: string;
  /** `0` for a failure that never reached the server (network, encryption). */
  readonly status: number;
  readonly details?: readonly ApiErrorDetail[];
  readonly traceId?: string;
  /** Present only for a 429 that carried a parseable `Retry-After` (TC-11). */
  readonly retryAfterSeconds?: number;
  /** The original error, kept for `console.error`/telemetry. Never serialised or rendered. */
  readonly cause?: unknown;
}

/**
 * The typed error every `apiClient` call rejects with.
 *
 * A plain `class extends Error` rather than a bare object so `instanceof ApiError` keeps
 * working after the object crosses a `Promise` rejection / TanStack Query's own error
 * plumbing, both of which are known to preserve prototype chains but not arbitrary object
 * shape checks.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: readonly ApiErrorDetail[];
  readonly traceId?: string;
  readonly retryAfterSeconds?: number;

  constructor(params: ApiErrorParams) {
    super(params.message);
    this.name = 'ApiError';
    this.code = params.code;
    this.status = params.status;
    this.details = params.details;
    this.traceId = params.traceId;
    this.retryAfterSeconds = params.retryAfterSeconds;
    if (params.cause !== undefined) {
      // `cause` is a standard `Error` field (ES2022); assigned rather than passed to
      // `super` for the same older-lib-target reason `back-end/app-error.ts` documents.
      Object.defineProperty(this, 'cause', { value: params.cause, enumerable: false });
    }
  }
}

/** Client-only codes for failures that never reach the server's own catalogue. */
export const CLIENT_ERROR_CODE = Object.freeze({
  NETWORK_ERROR: 'NETWORK_ERROR',
  TRANSPORT_CRYPTO_ERROR: 'TRANSPORT_CRYPTO_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
});

const NETWORK_ERROR_MESSAGE =
  "You appear to be offline, or the server can't be reached right now. Check your connection and try again.";
const UNKNOWN_ERROR_MESSAGE = 'Something went wrong. Please try again.';

/**
 * `status` → catalogue code, used only when a response carried no `{ error: { code } }`
 * envelope at all (a proxy/gateway error in front of Nest, for instance — the application
 * itself always sends one). Mirrors `STATUS_CODE_MAP` in the back end's
 * `error-normalization.filter.ts`, deliberately: a client-guessed code should read as the
 * same vocabulary a server-guessed one would.
 */
const STATUS_FALLBACK_CODE: Readonly<Record<number, string>> = Object.freeze({
  400: 'VALIDATION_FAILED',
  401: 'AUTH_SESSION_INVALID',
  403: 'PERM_DENIED',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'BUSINESS_RULE_VIOLATION',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
});

function fallbackCodeForStatus(status: number): string {
  return STATUS_FALLBACK_CODE[status] ?? 'INTERNAL_ERROR';
}

function fallbackMessageForStatus(status: number): string {
  return status >= 500
    ? 'The server ran into a problem handling that. Please try again.'
    : 'The request could not be completed.';
}

/**
 * `Retry-After` is either delta-seconds (`"120"`) or an HTTP-date
 * (`"Wed, 21 Oct 2026 07:28:00 GMT"`) — RFC 9110 §10.2.3 allows both. Returns `undefined`
 * for anything unparseable rather than guessing, so a malformed header degrades to "no
 * special wait", not a wrong one.
 */
function parseRetryAfterSeconds(headerValue: unknown): number | undefined {
  if (typeof headerValue !== 'string' || headerValue.trim() === '') return undefined;

  if (/^\d+$/.test(headerValue.trim())) {
    return Number(headerValue.trim());
  }

  const asDate = Date.parse(headerValue);
  if (Number.isNaN(asDate)) return undefined;
  const deltaSeconds = Math.ceil((asDate - Date.now()) / 1000);
  return deltaSeconds > 0 ? deltaSeconds : 0;
}

/** The shape of a well-formed server error envelope — everything is checked before use. */
interface ErrorEnvelopeBody {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly details?: unknown;
    readonly traceId?: unknown;
  };
}

function isApiErrorDetail(value: unknown): value is ApiErrorDetail {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { field?: unknown; code?: unknown };
  return typeof candidate.field === 'string' && typeof candidate.code === 'string';
}

/** Maps *anything* a `try`/`catch` around an `apiClient` call might see into an {@link ApiError}. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  if (error instanceof TransportCryptoError) {
    // The message is already scrubbed of payload/key detail — see the module's own
    // "failure contract: surface, never retry" section — so it is safe to show as-is.
    return new ApiError({
      code: CLIENT_ERROR_CODE.TRANSPORT_CRYPTO_ERROR,
      message: error.message,
      status: 0,
      cause: error,
    });
  }

  if (axios.isAxiosError(error)) {
    const response = error.response;
    if (!response) {
      // No `response` at all is axios's own signal for "the request never got an answer":
      // offline, DNS failure, CORS rejection, a client-side timeout. There is no server
      // envelope to read, and no server-side detail was ever produced to leak.
      return new ApiError({
        code: CLIENT_ERROR_CODE.NETWORK_ERROR,
        message: NETWORK_ERROR_MESSAGE,
        status: 0,
        cause: error,
      });
    }

    const body = isJsonRecord(response.data) ? (response.data as ErrorEnvelopeBody) : undefined;
    const envelope = body?.error;

    const code =
      typeof envelope?.code === 'string' ? envelope.code : fallbackCodeForStatus(response.status);
    const message =
      typeof envelope?.message === 'string' && envelope.message.length > 0
        ? envelope.message
        : fallbackMessageForStatus(response.status);
    const details = Array.isArray(envelope?.details)
      ? envelope.details.filter(isApiErrorDetail)
      : undefined;
    const traceId = typeof envelope?.traceId === 'string' ? envelope.traceId : undefined;
    const retryAfterSeconds =
      response.status === 429
        ? parseRetryAfterSeconds(readHeader(response.headers, 'retry-after'))
        : undefined;

    return new ApiError({
      code,
      message,
      status: response.status,
      details: details && details.length > 0 ? details : undefined,
      traceId,
      retryAfterSeconds,
      cause: error,
    });
  }

  return new ApiError({
    code: CLIENT_ERROR_CODE.UNKNOWN_ERROR,
    message: UNKNOWN_ERROR_MESSAGE,
    status: 0,
    cause: error,
  });
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reads one header off whatever shape axios handed back — a plain object or an `AxiosHeaders`. */
function readHeader(headers: unknown, name: string): string | undefined {
  if (headers && typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get: (n: string) => unknown }).get(name);
    return typeof value === 'string' ? value : undefined;
  }
  const record = (headers ?? {}) as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}
