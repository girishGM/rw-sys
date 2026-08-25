/**
 * T-050 — a thin wrapper around Playwright's `APIRequestContext`, used two ways in this suite:
 *
 *  1. By `global-setup.ts` to complete the `super_admin` bootstrap + MFA enrolment once, outside
 *     any spec.
 *  2. By `utils/scenario.ts` to provision each spec's own country/tenant/rule/reward/merchant/
 *     users quickly, against the **real, unmocked API** — no different from a browser's own
 *     requests except that nothing renders. The golden-journey spec does not use this for the
 *     product flow it exists to prove; every other spec uses it for the preconditions that flow
 *     already proved once, so that spec's own assertions are not re-testing setup.
 *
 * ### CSRF (T-012), for real
 *
 * `csrf.guard.ts` accepts a session-bound double-submit token, seeded into the (non-`HttpOnly`)
 * `rs_csrf` cookie on login/verify and echoed back as `X-CSRF-Token`. Playwright's request
 * context behaves like a browser's cookie jar (`HttpOnly` cookies are stored and re-sent
 * automatically, exactly not-readable-by-script, same as a real browser) — reading `rs_csrf` back
 * out of `storageState()` between calls and attaching it as a header is the same thing
 * `front-end/src/auth/readCsrfCookie.ts` does from `document.cookie`, just from the Node side.
 *
 * ### No transport-key handshake
 *
 * This client never sends `X-Transport-Public-Key`. `HandshakeService.establish` returns `null`
 * for a caller that offers no key, and `PayloadEncryptInterceptor` then leaves the body in
 * cleartext (T-018's own header) — so every request/response here is plain JSON. Nothing is
 * bypassed by that: it is the same "client declined the optional encryption layer" path any
 * pre-T-018 client, or a `curl`, takes today.
 */
import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';

/** The exact cookie shape both `BrowserContext.addCookies()` and `APIRequestContext.storageState()`
 * use — extracted once here so `utils/state.ts` (JSON-serialising a captured `super_admin` session,
 * T-050 2026-08-20) and `cookiesForBrowser()` below share one name for it rather than each
 * re-deriving the same `Awaited<ReturnType<...>>` expression. */
export type BrowserCookie = Awaited<ReturnType<APIRequestContext['storageState']>>['cookies'][number];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiSession {
  constructor(
    private readonly request: APIRequestContext,
    private readonly baseURL: string,
  ) {}

  private async csrfHeader(): Promise<Record<string, string>> {
    const state = await this.request.storageState();
    const cookie = state.cookies.find((c) => c.name === 'rs_csrf');
    return cookie ? { 'x-csrf-token': cookie.value } : {};
  }

  private async unwrap<T>(responsePromise: Promise<import('@playwright/test').APIResponse>): Promise<T> {
    const response = await responsePromise;
    const status = response.status();
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // A 204 (or a non-JSON error page) has no body — that is fine, callers of `T = void`
      // endpoints never look at it.
    }
    if (!response.ok()) {
      const asRecord = json as { error?: { code?: string; message?: string } } | null;
      throw new ApiError(
        status,
        asRecord?.error?.code,
        asRecord?.error?.message ?? `${String(status)} ${response.statusText()} on ${response.url()}`,
        json,
      );
    }
    const asEnvelope = json as { data?: T } | null;
    return (asEnvelope && 'data' in asEnvelope ? asEnvelope.data : (json as T)) as T;
  }

  async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    return this.unwrap<T>(
      this.request.get(this.baseURL + path, {
        params: params as Record<string, string> | undefined,
      }),
    );
  }

  async post<T>(path: string, data?: unknown): Promise<T> {
    return this.unwrap<T>(
      this.request.post(this.baseURL + path, { data, headers: await this.csrfHeader() }),
    );
  }

  async patch<T>(path: string, data?: unknown): Promise<T> {
    return this.unwrap<T>(
      this.request.patch(this.baseURL + path, { data, headers: await this.csrfHeader() }),
    );
  }

  async put<T>(path: string, data?: unknown): Promise<T> {
    return this.unwrap<T>(
      this.request.put(this.baseURL + path, { data, headers: await this.csrfHeader() }),
    );
  }

  async delete<T>(path: string): Promise<T> {
    return this.unwrap<T>(
      this.request.delete(this.baseURL + path, { headers: await this.csrfHeader() }),
    );
  }

  /**
   * The cookies this session currently holds, in the exact shape `BrowserContext.addCookies()`
   * accepts — how a super_admin's API-only session (see the file header on why the SPA cannot
   * complete this login itself) gets handed to a real browser context so every step *after*
   * login runs through the real UI.
   *
   * Passed through unchanged, including `domain`/`secure`/`httpOnly`/`sameSite`: cookies are not
   * port-specific (RFC 6265) and both the back end (`:3000`) and front end (`:5173`) in this
   * suite share the same hostname (`localhost`), so a cookie captured against the API's own
   * origin is already valid for the front end's — no rewriting needed.
   */
  async cookiesForBrowser(): Promise<readonly BrowserCookie[]> {
    const state = await this.request.storageState();
    return state.cookies.map((c) => ({ ...c, expires: Math.round(c.expires) }));
  }

  /**
   * Releases the underlying `APIRequestContext`. Only meaningful for a session that owns its own,
   * dedicated context (`utils/scenario.ts`'s per-actor sessions, T-050 2026-08-20 — see that
   * file's header on why every actor needs one: a shared context is a shared cookie jar, and a
   * second login on it silently signs the first session out). Never call this on a session built
   * from a fixture-owned or worker-cached context (`superAdminSession.ts`, a spec's own `request`
   * fixture) — those are not this session's to close.
   */
  async dispose(): Promise<void> {
    await this.request.dispose();
  }
}

/**
 * Builds a ready-to-use `ApiSession` from cookies a *previous* login already produced, rather than
 * performing a new `POST /auth/login` — the counterpart to `cookiesForBrowser()`, for a session's
 * own origin instead of a `BrowserContext`'s.
 *
 * Added T-050 2026-08-20: `superAdminSession.ts`'s own header explains why `super_admin` used to
 * pay one real login per Playwright worker process (a real, measured contributor to exhausting
 * `LOGIN_PER_IP_LIMIT`, `security.constants.ts`, T-012's file scope — no e2e override exists to
 * opt into instead). A session cookie is not worker-bound — the back end validates it against
 * `portal_sessions`, nothing about the HTTP client that presents it — so replaying the *one*
 * cookie set `global-setup.ts` obtains, once, into every worker's own dedicated
 * `APIRequestContext` is exactly as valid as that same worker performing its own login, at zero
 * additional cost to the rate limiter.
 */
export async function sessionFromCookies(
  apiBaseURL: string,
  cookies: readonly BrowserCookie[],
): Promise<ApiSession> {
  const context = await playwrightRequest.newContext({
    baseURL: apiBaseURL,
    storageState: { cookies: [...cookies], origins: [] },
  });
  return new ApiSession(context, apiBaseURL);
}

export interface LoginOutcome {
  readonly mfaRequired: boolean;
  readonly mustChangePassword: boolean;
  readonly role: string;
}

/** `POST /auth/login`. Never throws on a `mfaRequired` outcome — that is a legitimate, expected
 * branch for `super_admin`, not a failure (see `mfaLogin` below). */
export async function login(
  session: ApiSession,
  email: string,
  password: string,
): Promise<LoginOutcome> {
  return session.post<LoginOutcome>('/auth/login', { email, password });
}

/** Completes a pending challenge with `POST /auth/mfa/verify`. Callers that have never enrolled
 * this account must call `enrolMfa` first — `global-setup.ts` is the only caller that ever does;
 * every spec-side session reuses the secret it already produced (see that file's header). */
export async function verifyMfa(
  session: ApiSession,
  totpCode: string,
): Promise<LoginOutcome & { recoveryCodes?: readonly string[] }> {
  return session.post('/auth/mfa/verify', { totpCode });
}

export interface EnrolmentOffer {
  readonly secret: string;
  readonly otpauthUri: string;
}

export async function enrolMfa(session: ApiSession): Promise<EnrolmentOffer> {
  return session.post<EnrolmentOffer>('/auth/mfa/enrol', {});
}
