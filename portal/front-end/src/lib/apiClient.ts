/**
 * T-022 — the one API client every feature uses (04-FRONTEND.md §8, AGENT-PROTOCOL R5).
 *
 * Four responsibilities, in interceptor order:
 *
 * 1. **Cookies, never headers, carry the session.** `withCredentials: true` and nothing
 *    else — this client never reads or writes an auth token; the access/refresh JWTs are
 *    `HttpOnly` and invisible to every line of JS in this SPA.
 * 2. **CSRF.** `X-CSRF-Token` mirrors the `rs_csrf` cookie (`./csrf.ts`) onto every
 *    non-GET/HEAD/OPTIONS request.
 * 3. **Transport payload encryption** (T-018, 07-DATA-PROTECTION.md §5). Every request
 *    body is offered to `encryptRequestBody`; every response body is offered to
 *    `decryptResponseBody`. Both are no-ops with no session key established (before
 *    login, or after `resetTransport`), which is exactly the "the app continues on TLS
 *    alone" degraded path that module documents — nothing here needs to know whether
 *    encryption is currently on.
 * 4. **Single-flight 401 refresh** (implementation note 3). Five concurrent 401s trigger
 *    exactly one `POST /auth/refresh` (`./refreshQueue.ts`); every caller that was waiting
 *    on it retries its own request exactly once; a refresh that fails ends the session
 *    (`endSession`) instead of looping.
 *
 * Every error this client can reject with — a real HTTP error, a request that never left
 * the browser, an encryption failure — is normalised to `ApiError` (`./apiError.ts`)
 * before it reaches feature code.
 *
 * **T-061 — `304 Not Modified` is a success, not a failure.** Express serves `ETag`s by
 * default, and axios's own default `validateStatus` (`status >= 200 && status < 300`) does
 * not accept 304 — so an honestly unchanged conditional GET was rejected and surfaced to the
 * user as "Something went wrong". `validateStatus` below is widened by exactly one status
 * code to fix that; genuine 4xx/5xx failures are unaffected. A 304 carries no body by
 * design, so it is never handed to the caller as `undefined` — the response interceptor
 * instead re-serves the last successful body this same instance saw for that exact
 * request (`conditionalGetCache`), which is precisely what "not modified" means: the data
 * the caller already has is still current.
 */
import axios, {
  type AxiosAdapter,
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { CSRF_HEADER_NAME, readCsrfToken, requiresCsrfHeader } from './csrf';
import { createSingleFlight } from './refreshQueue';
import { toApiError } from './apiError';
import { queryClient } from './queryClient';
import {
  CORRELATION_HEADER,
  PAYLOAD_ENCRYPTED_HEADER,
  TRANSPORT_ENVELOPE_VERSION,
  decryptResponseBody,
  encryptRequestBody,
  resetTransport,
  type TransportResponseHeaders,
} from './transportCrypto';

/**
 * Paths whose own 401 must never trigger a refresh (implementation note 4).
 *
 * T-060 — the three `/auth/mfa/*` routes added here alongside `/auth/login`/`/auth/refresh`,
 * for exactly the reason those two already are: none of the three has an access-token session
 * to refresh (the caller holds, at most, the `__Host-rs_mfa` pending cookie — see
 * `mfa.constants.ts`), so their own `401`s (`AUTH_SESSION_INVALID` for a dead pending token,
 * `AUTH_INVALID_CREDENTIALS` for a wrong TOTP/recovery code) mean exactly what `/auth/login`'s
 * does: "this credential was rejected", not "this access token expired". Before this fix, a
 * wrong code on `/auth/mfa/verify` would fall into the same branch a stale access token does —
 * attempt `POST /auth/refresh` (which cannot succeed with no refresh cookie either), then
 * `endSession()`'s hard redirect to `/login` — silently discarding `MfaChallengePage.tsx`'s own
 * inline "wrong code, try again" handling (TC-5, TC-9) with a full page reload before that
 * component's `catch` block ever ran. Found while implementing T-060, not by inspection alone —
 * `test/lib/apiClient.spec.ts`'s new case reproduces the pre-fix behaviour directly. Flagged as
 * a deviation from T-060's "Files owned" list (this file was not on it) in the completion
 * report; same-owner (`agent-frontend-core`, T-022 and T-060 alike), additive-only change.
 */
const NO_REFRESH_PATHS = [
  '/auth/login',
  '/auth/refresh',
  '/auth/mfa/enrol',
  '/auth/mfa/verify',
  '/auth/mfa/recover',
];

/** The default base path every route in 03-API-CONTRACT.md is relative to. */
const DEFAULT_BASE_URL = '/api/v1';

interface RetryableRequestConfig extends InternalAxiosRequestConfig {
  /** Set once this exact request has already been retried after a refresh (TC-7's guard
   * against a second, recursive refresh when the retried request 401s again). */
  _retried?: boolean;
  /**
   * The plaintext body, captured the first time this config passes through the request
   * interceptor. A retried request re-derives its envelope from *this*, never from
   * `config.data`, which by the time a response interceptor sees it may already have been
   * replaced with an encrypted envelope from the first attempt — re-encrypting an
   * envelope as if it were plaintext would corrupt the request instead of resending it.
   */
  _originalData?: unknown;
}

export type SessionExpiredHandler = () => void;

function defaultSessionExpiredHandler(): void {
  if (typeof window === 'undefined') return;
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.href = `/login?next=${encodeURIComponent(next)}`;
}

let sessionExpiredHandler: SessionExpiredHandler = defaultSessionExpiredHandler;

/**
 * Overrides what happens once a session is definitively over (a refresh that failed).
 * Pass `null` to restore the default hard redirect to `/login?next=<current>`.
 *
 * Exists as a test seam and as a host seam for a future task that would rather navigate
 * with React Router than reload the page — mirrors `configureTransportCrypto` in T-018's
 * `transportCrypto.ts`, the identical pattern.
 */
export function configureSessionExpiredHandler(handler: SessionExpiredHandler | null): void {
  sessionExpiredHandler = handler ?? defaultSessionExpiredHandler;
}

/**
 * The single-flight coalescer for `/auth/refresh` (TC-5). One instance, module-scoped, so
 * every concurrent 401 anywhere in the running app shares it — which is the entire point;
 * see `./refreshQueue.ts`'s own header for the failure mode this prevents.
 */
const refreshCoalescer = createSingleFlight<void>();

/**
 * Ends the client-side session: drops the transport key, drops every cached query, and
 * hands off to whichever `sessionExpiredHandler` is configured (TC-6, TC-16).
 *
 * This is the one teardown path a failed refresh uses. It is exported so an explicit,
 * user-initiated "Log out" action can reuse it too, rather than a second implementation
 * of "what does ending a session mean on this client" drifting from this one.
 */
export function endSession(): void {
  resetTransport();
  queryClient.clear();
  sessionExpiredHandler();
}

function generateCorrelationId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  // Only reachable in a host with no WebCrypto at all. Not required to be
  // cryptographically unpredictable — it only has to bind one request to one response
  // envelope for that one request's lifetime (see `transportCrypto.ts`'s AAD).
  return `corr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Adapts whatever axios hands back as `response.headers` to the `.get(name)` contract
 * `decryptResponseBody` (T-018) expects — **always** normalising a missing header to
 * `null`, never left as-is.
 *
 * This cannot simply return a real `AxiosHeaders` instance directly even though it has its
 * own `.get` method: `AxiosHeaders.get()` returns `undefined` for a header that is not
 * present, not `null`, and `decryptResponseBody`'s own "is this response encrypted at all"
 * check is a strict `=== null`. Handing it an `AxiosHeaders` unmodified made every
 * cleartext response look, to that check, like an encrypted one with a missing session —
 * caught by this file's own tests, not a hypothetical.
 */
function toTransportHeaders(headers: unknown): TransportResponseHeaders {
  return {
    get(name: string): string | null {
      const value = readRawHeader(headers, name);
      if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : null;
      return typeof value === 'string' ? value : null;
    },
  };
}

function readRawHeader(headers: unknown, name: string): unknown {
  if (
    headers !== null &&
    typeof headers === 'object' &&
    typeof (headers as { get?: unknown }).get === 'function'
  ) {
    return (headers as { get: (headerName: string) => unknown }).get(name);
  }
  const record = (headers ?? {}) as Record<string, unknown>;
  return record[name] ?? record[name.toLowerCase()];
}

/** Whether `url` (as axios sees it — relative to `baseURL`) is one of the always-cleartext
 * auth routes that must never trigger a refresh of their own 401. */
function isNoRefreshPath(url: string | undefined): boolean {
  if (!url) return false;
  return NO_REFRESH_PATHS.some((path) => url === path || url.endsWith(path));
}

/**
 * Identifies "the same request" for the purpose of T-061's 304 cache: method plus URL plus
 * (if present) query params, exactly the parts a conditional GET's `ETag` is scoped to.
 * Deliberately ignores headers/body — a `GET` never has a meaningful body, and varying the
 * key on request headers would make a correlation id (unique per request, see
 * `generateCorrelationId`) defeat caching entirely.
 */
function conditionalGetCacheKey(config: InternalAxiosRequestConfig): string {
  const method = (config.method ?? 'get').toLowerCase();
  const params = config.params !== undefined ? JSON.stringify(config.params) : '';
  return `${method} ${config.url ?? ''}${params ? `?${params}` : ''}`;
}

async function performRefresh(instance: AxiosInstance): Promise<void> {
  // Routed through the very same instance: its request interceptor still attaches CSRF
  // (the refresh cookie is HttpOnly, but `rs_csrf` is not — see `./csrf.ts`), and its
  // response interceptor still applies, but `isNoRefreshPath` stops it recursing into a
  // second refresh attempt if this call itself comes back 401 (TC-9).
  await instance.post('/auth/refresh');
}

export interface CreateApiClientOptions {
  readonly baseURL?: string;
  /** Swappable transport, used only by `test/lib/apiClient.spec.ts` to exercise the real
   * interceptor chain without a live server. Never set outside a test. */
  readonly adapter?: AxiosAdapter;
}

/**
 * Builds one API client instance with the full interceptor chain described in this file's
 * banner. Exported as a factory — not just the default singleton `api` below — so tests
 * can build an isolated instance per case with a controllable `adapter`, rather than
 * reaching for a global mock of the `axios` module.
 */
export function createApiClient(options: CreateApiClientOptions = {}): AxiosInstance {
  const instance = axios.create({
    baseURL: options.baseURL ?? DEFAULT_BASE_URL,
    withCredentials: true,
    adapter: options.adapter,
    // T-061: accept axios's normal 2xx range plus 304 — the one addition an honest
    // conditional-GET revalidation needs. Every other status (in particular every 4xx/5xx)
    // still rejects exactly as before (TC-4).
    validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
  });

  /**
   * T-061 — the last successful (non-304) body this instance saw for each `GET`, keyed by
   * {@link conditionalGetCacheKey}. Scoped to this one instance (built inside the factory,
   * not module-level) so two clients — notably two test cases, each building their own via
   * `createApiClient` — never leak state into one another.
   */
  const conditionalGetCache = new Map<string, unknown>();

  instance.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
    const typed = config as RetryableRequestConfig;
    const method = config.method ?? 'get';

    if (requiresCsrfHeader(method)) {
      const token = readCsrfToken();
      if (token !== null) {
        config.headers.set(CSRF_HEADER_NAME, token);
      }
    }

    if (typed._originalData === undefined) {
      typed._originalData = config.data as unknown;
    }

    const correlationId = generateCorrelationId();
    config.headers.set(CORRELATION_HEADER, correlationId);

    const { body, encrypted } = await encryptRequestBody(
      method,
      config.url ?? '',
      typed._originalData,
      correlationId,
    );

    if (encrypted) {
      config.headers.set(PAYLOAD_ENCRYPTED_HEADER, TRANSPORT_ENVELOPE_VERSION);
      config.data = body;
    } else {
      config.headers.delete(PAYLOAD_ENCRYPTED_HEADER);
      config.data = typed._originalData;
    }

    return config;
  });

  instance.interceptors.response.use(
    async (response: AxiosResponse) => {
      const config = response.config as RetryableRequestConfig;

      if (response.status === 304) {
        // No body by design (implementation note 1) — nothing to decrypt (implementation
        // note 2), and nothing new to hand the caller. "Not modified" means the data the
        // caller already has is still current, so that is exactly what it gets back; a
        // cache miss (nothing successful ever seen for this exact request, e.g. this is a
        // fresh instance) degrades to `undefined` rather than inventing data, same as any
        // other never-fetched query would look to its caller.
        response.data = conditionalGetCache.get(conditionalGetCacheKey(config));
        return response;
      }

      response.data = await decryptResponseBody(
        response.data,
        toTransportHeaders(response.headers),
      );

      if ((config.method ?? 'get').toLowerCase() === 'get') {
        conditionalGetCache.set(conditionalGetCacheKey(config), response.data);
      }

      return response;
    },
    async (error: unknown) => {
      if (!axios.isAxiosError(error) || error.config === undefined) {
        // Never became a real HTTP exchange — a request-interceptor failure (e.g.
        // `encryptRequestBody` throwing), a cancelled request, or anything else with no
        // `config` to retry. Nothing to refresh; map and stop.
        return Promise.reject(toApiError(error));
      }

      const config = error.config as RetryableRequestConfig;
      const status = error.response?.status;

      if (status === 401) {
        // "Dropped... on any 401" — see `transportCrypto.ts`'s own contract for `resetTransport`.
        resetTransport();

        if (config._retried !== true && !isNoRefreshPath(config.url)) {
          try {
            await refreshCoalescer.run(() => performRefresh(instance));
          } catch (refreshError) {
            endSession();
            return Promise.reject(toApiError(refreshError));
          }

          config._retried = true;
          return instance.request(config);
        }
      }

      return Promise.reject(toApiError(error));
    },
  );

  return instance;
}

/** The one instance every feature imports — "the API T-022's HTTP client uses" (transportCrypto.ts). */
export const api = createApiClient();
