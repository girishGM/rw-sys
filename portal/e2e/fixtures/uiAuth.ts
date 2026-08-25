/**
 * T-050 — real, browser-driven login, used by every spec (implementation note 3: *"the login
 * spec itself must log in for real, since login is the thing under test"* — `login.spec.ts`
 * reuses this same real flow directly, deliberately, because a genuine login is its own point).
 *
 * ### `loggedInContext`, and why it is not optional for `scenario`'s shared actors
 *
 * `LOGIN_PER_EMAIL_IP_LIMIT = 5` per 15 minutes (`security.constants.ts`, T-012's file scope, no
 * e2e override exists) is keyed by the **specific email**, not just the source IP — a fact that
 * `scenario`/`isolatedScenario` becoming run-wide singletons (`utils/state.ts`'s own header)
 * exposed for the first time: every spec that logs in as `scenario.maker` (or any other shared
 * actor) through a *fresh* `realUiLogin(page, …)` charges the exact same counter, so five or more
 * specs sharing one actor reliably trips `RATE_LIMITED` on whichever runs sixth — reproduced live
 * (T-050, 2026-08-20), consistently, not flakily: `negative-journeys.spec.ts`'s TC-N10 alone
 * pushed `scenario.maker` past five real logins across that one file.
 *
 * `loggedInContext` is the fix: one real login per distinct email, per worker, ever — every
 * caller after the first gets a new `BrowserContext` seeded from the cached `storageState`
 * instead. **Every spec that only needs a logged-in page for one of `scenario`'s or
 * `isolatedScenario`'s shared actors must use this, not `realUiLogin`, in a fresh page.** The
 * exceptions are narrow and each is called out at its own call site: `login.spec.ts` (a genuine
 * login is the point), `negative-journeys.spec.ts`'s TC-N9 (a one-off actor nothing else shares,
 * so there is no cache to protect either way), and the *second*, independent session a handful of
 * tests mint on top of an otherwise-`loggedInContext`-backed primary one, specifically because
 * that second session must be observably distinct from the first at the same moment in time —
 * reusing the cache for it would hand back the *same* session, not a second one
 * (`negative-journeys.spec.ts`'s TC-N10).
 *
 * **Added 2026-08-21: any test that revokes a session (`logout`, `logout-all`) must do so on a
 * one-off actor (`utils/scenario.ts#createOneOffActor`), never on `loggedInContext`'s cache for a
 * shared `scenario`/`isolatedScenario` actor.** This cache's self-heal protects the *next* caller
 * from a stale entry — it cannot protect a *concurrent* one already mid-request on the same, live
 * session at the moment this test revokes it (`fullyParallel: true`). See `utils/scenario.ts`'s
 * header, "A fourth, genuinely in-scope bug", for the live reproduction. `session.spec.ts`'s TC-3
 * and TC-4 used to be exceptions like TC-N10 above; both now mint their own one-off actor instead
 * and no longer touch this cache at all.
 */
import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  expect,
} from '@playwright/test';
import type { BrowserCookie } from '../utils/apiClient';

export interface Credentials {
  readonly email: string;
  readonly password: string;
  /** This actor's one real login's cookies, if the caller already has them —
   * `utils/scenario.ts`'s `ActorCredentials` always does (that file's own header, "every actor's
   * cookies, captured once, here"). `loggedInContext` seeds its cache from these instead of
   * logging in at all, on any worker that has not seen this email before. Absent for `Credentials`
   * built by hand (`login.spec.ts`'s fresh, one-off accounts; `golden-journey.spec.ts`'s own UI-
   * created actors) — nothing requires it, `realUiLogin`'s own callers ignore it either way. */
  readonly cookies?: readonly BrowserCookie[];
}

/**
 * Fills and submits the real `/login` form, and — because every account this suite provisions
 * (T-030/T-034/T-035/the bootstrap CLI) starts `must_change_password = true` — transparently
 * completes the forced `/change-password` redirect when the server sends one. Returns the
 * password the account now actually has, so the caller's own credential stays correct for any
 * further login.
 */
export async function realUiLogin(
  page: Page,
  baseURL: string,
  credentials: Credentials,
  newPasswordIfForced = 'Ui-Login-Forced-9-Change!',
): Promise<Credentials> {
  await page.goto(`${baseURL}/login`);
  await page.getByLabel('Email').fill(credentials.email);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Log in' }).click();

  await page.waitForURL((url) => url.pathname === '/change-password' || url.pathname === '/dashboard');

  if (new URL(page.url()).pathname === '/change-password') {
    await page.getByLabel('Current password').fill(credentials.password);
    await page.getByLabel('New password', { exact: true }).fill(newPasswordIfForced);
    await page.getByLabel('Confirm new password').fill(newPasswordIfForced);
    await page.getByRole('button', { name: 'Change password' }).click();
    await page.waitForURL((url) => url.pathname === '/dashboard');
    return { email: credentials.email, password: newPasswordIfForced };
  }

  return credentials;
}

/** Asserts the dashboard actually rendered — the one screen every role lands on, so this is a
 * cheap, role-agnostic "login genuinely succeeded" check every spec can reuse. */
export async function expectOnDashboard(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/dashboard');
}

const storageStateCache = new Map<string, Awaited<ReturnType<BrowserContext['storageState']>>>();

/**
 * Whether a cached session, already navigated to `/dashboard`, is actually still good.
 *
 * **Found live, T-050 2026-08-20 — two real bugs in this file, not the app, found in sequence.**
 *
 * 1. `probe.goto()` only waits for the SPA shell's own `load` event, which fires long before an
 *    app-level "is this session still valid" check settles: a revoked session's redirect to
 *    `/login` goes through `apiClient.ts`'s full 401 → failed-`/auth/refresh` → `endSession()` →
 *    `window.location.href` cycle (two real network round trips), not a synchronous check.
 *    Reading `probe.url()` immediately after `goto` resolves therefore reads `/dashboard` for an
 *    already-revoked session too — the redirect just hasn't landed yet — and this fixture handed
 *    back a context whose cookies the server had already rejected.
 * 2. The first fix for (1) waited for *any* `<h1>` to render before trusting the URL — plausible,
 *    except `LoginPage.tsx` renders its own `<h1>Log in</h1>`. A revoked session that redirects to
 *    `/login` **quickly** satisfied that wait too, on the login page's own heading, not the
 *    dashboard's — the opposite of a fix for the fast-redirect case, which is exactly the case
 *    this exists to catch. Confirmed by screenshot: a run failed downstream showing the literal
 *    "Your session has expired, please sign in again." login screen from a context this function
 *    had just certified as `stillValid`.
 *
 * Both symptoms showed up downstream, not here: `timezone.spec.ts`'s TC-2 (and, before this fix,
 * `responsive.spec.ts`'s 375px wizard step) hung on `/campaigns/new` fields that were never going
 * to render, because `session.spec.ts`'s TC-4 (which deliberately revokes every session for the
 * same shared `scenario.maker` via `POST /auth/logout-all`, by design) had already poisoned this
 * module's cache for the next test that reused it.
 *
 * The only reliable signal is the **pathname after both `<h1>` and `/login` have had a chance to
 * resolve** — never one alone.
 */
async function probeSessionStillValid(probe: Page): Promise<boolean> {
  await Promise.race([
    probe.getByRole('heading', { level: 1 }).first().waitFor({ state: 'visible', timeout: 5_000 }),
    probe.waitForURL((url) => url.pathname === '/login', { timeout: 5_000 }),
  ]).catch(() => {
    // Neither settled within budget — something is genuinely wrong (not just "still settling").
    // Fall through to the pathname check below with whatever it currently reads; if that is
    // `/dashboard` this treats an unusually slow-but-valid session as valid (the common case this
    // budget already comfortably covers), and anything else correctly falls through to a fresh
    // login, the safer default either way.
  });
  return new URL(probe.url()).pathname === '/dashboard';
}

/**
 * A new browser context, already logged in as `credentials` — real UI login only if neither this
 * worker's own cache nor `credentials.cookies` (`utils/scenario.ts`'s own header: captured once,
 * globally, when `scenario`/`isolatedScenario` were built) already has a valid session for this
 * exact email; `storageState` reuse every time after (implementation note 3's "logged-in page per
 * role via storage-state reuse"). Used by specs whose subject is not the login flow itself, so
 * their own failure signal is not diluted by re-running login on every test — and, as of T-050
 * 2026-08-20, the mandatory way any such spec reads one of `scenario`'s/`isolatedScenario`'s
 * shared actors at all (this file's own header explains why: `LOGIN_PER_EMAIL_IP_LIMIT` is keyed
 * per account, and several specs — or several *workers*, each with their own cache — sharing one
 * now-singleton actor exhausts it in real, reproduced runs, not hypothetically).
 *
 * **Self-healing against a stale cache entry**, worker-local or pre-captured alike. A cached
 * session can go bad without this module ever finding out: `session.spec.ts`'s TC-4 and
 * `negative-journeys.spec.ts`'s TC-N10 both deliberately revoke *every* session for the actor
 * they test against (`POST /auth/logout-all`), and `credentials.cookies` itself can predate any
 * test in this run entirely. Rather than accept that as a real, order-dependent flake (the DoD's
 * own words: *"a flaky E2E suite is worse than none"*), any cache hit — worker-local or
 * pre-captured — is verified with one cheap navigation to `/dashboard` before being trusted; a
 * redirect to `/login` is treated exactly like a cache miss, a fresh real login, and the
 * worker-local cache entry is overwritten with the new, genuinely valid session. The common case
 * (a valid hit) pays for that one extra navigation; the rare case (a revoked one) pays for what
 * would have been a fresh login anyway.
 */
export async function loggedInContext(
  browser: Browser,
  baseURL: string,
  credentials: Credentials,
  /** Passed straight through to `browser.newContext()`, merged with the cached (or freshly
   * captured) `storageState` — `timezone.spec.ts`'s TC-2 uses this for `timezoneId`, the one spec
   * that needs a `loggedInContext` with a non-default context option. */
  contextOptions: BrowserContextOptions = {},
): Promise<BrowserContext> {
  // Worker-local cache first (a prior call in *this* worker, for *this* email) — cheaper to reuse
  // than re-validating the pre-captured cookies a second time in the same process. Falls back to
  // `credentials.cookies` (this worker's first-ever request for this email) before falling back
  // to an actual login.
  const candidateStorageState =
    storageStateCache.get(credentials.email) ??
    (credentials.cookies ? { cookies: [...credentials.cookies], origins: [] } : null);

  if (candidateStorageState) {
    const context = await browser.newContext({ ...contextOptions, storageState: candidateStorageState });
    const probe = await context.newPage();
    await probe.goto(`${baseURL}/dashboard`);
    const stillValid = await probeSessionStillValid(probe);
    await probe.close();
    if (stillValid) {
      storageStateCache.set(credentials.email, candidateStorageState);
      return context;
    }
    // Stale — this exact context's cookies are dead weight; fall through to a fresh login below,
    // on a brand new context, rather than trying to salvage this one.
    await context.close();
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await realUiLogin(page, baseURL, credentials);
  await expectOnDashboard(page);
  storageStateCache.set(credentials.email, await context.storageState());
  await page.close();
  return context;
}
