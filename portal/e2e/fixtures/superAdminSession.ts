/**
 * T-050 — a real, working `super_admin` browser session, without repeating `/login` per worker.
 *
 * `global-setup.ts` performs `super_admin`'s one, real "first login" — `/login` →
 * `/mfa-challenge` (enrol, then a real TOTP code) → the forced `/change-password` redirect →
 * `/dashboard` — through an actual headless browser, exactly once, before any Playwright worker
 * exists (see that file's own header for the full flow and why it must be honoured this way: the
 * inherited T-060 TC-1 criterion, `T-050-e2e-tests.md`'s "Inherited acceptance criteria" table).
 * `LoginPage.tsx`'s own header confirms the SPA has had a working `/mfa-challenge` screen since
 * T-060 — this module is not working around a missing one.
 *
 * What this function does: replay the cookies that one real login already produced
 * (`utils/apiClient.ts#sessionFromCookies` — the counterpart to `cookiesForBrowser`) into a fresh
 * `BrowserContext` per caller (`addCookies`, the documented way to seed a context's cookie jar),
 * rather than performing the login again. `super_admin` can only ever have *one* "first login" in
 * this run at all (`bootstrap-superadmin.ts` refuses a second `super_admin` outright), so every
 * caller after `global-setup.ts` itself is, by construction, a repeat login — and repeating it
 * costs a real charge against `LOGIN_PER_EMAIL_IP_LIMIT`/`MFA_VERIFY_PER_IP_LIMIT` for zero
 * additional proof, since the screens were already exercised for real once. This mirrors
 * `fixtures/uiAuth.ts#loggedInContext`'s reasoning for every other role, just with no cache-miss
 * path at all — there is nothing to log in with a *second* time even if this file wanted to.
 *
 * ### Two real bugs this used to expose, live — both now resolved, restated for the record
 *
 *  1. `context.addCookies()` used to throw on `__Host-rs_rt` (`REFRESH_COOKIE.path` not `/`,
 *     violating the `__Host-` prefix rule) — fixed by T-058.
 *  2. This session used to perform a **fresh** `POST /auth/login` + `POST /auth/mfa/verify` in
 *     **every Playwright worker process** (module-level cache, but the cache itself is per-worker
 *     — Playwright workers are separate OS processes). Five or more workers needing a
 *     `super_admin` session inside the same 15-minute window reliably exhausted
 *     `LOGIN_PER_EMAIL_IP_LIMIT`/`MFA_VERIFY_PER_IP_LIMIT` (`security.constants.ts`, T-012's file
 *     scope, not T-050's — AGENT-PROTOCOL R9). Worker-scoping the *fixture* (`fixtures/index.ts`)
 *     already capped this at one login per worker rather than one per test, but "one per worker"
 *     still scales with however many workers Playwright starts — confirmed still a real, measured
 *     contributor to `RATE_LIMITED` failures (T-050, 2026-08-20) even after that fix, and even
 *     after `scenario` itself became a run-wide singleton (`utils/state.ts`'s own header).
 *
 * **The fix applied here, 2026-08-20: stop logging in more than once, full stop.** A session
 * cookie is not worker-bound — the back end validates it against `portal_sessions`, nothing about
 * which OS process presents it — so there is no reason for a second worker to authenticate at all
 * when the first one's cookies are sitting in `state.superAdmin.cookies`, captured once by
 * `global-setup.ts` right after the real login + MFA verify it was always going to perform anyway.
 * This is not a weakening of anything MFA is meant to guard: the challenge still ran, for real,
 * exactly once, before any worker existed; every worker after that is presenting a credential
 * (the session cookie) it was legitimately handed, the same trust a second browser tab given the
 * same cookies would have.
 */
import type { Browser, BrowserContext } from '@playwright/test';
import { ApiSession, sessionFromCookies } from '../utils/apiClient';
import type { E2eState } from '../utils/state';

/** One `sessionFromCookies` call per worker process, memoised for the worker's whole lifetime —
 * cheap (no network round trip beyond whatever the first real request makes), but still avoids
 * building a redundant `APIRequestContext` per call. */
let cachedSession: Promise<ApiSession> | null = null;

export async function superAdminApiSession(state: E2eState): Promise<ApiSession> {
  cachedSession ??= sessionFromCookies(state.apiBaseURL, state.superAdmin.cookies);
  return cachedSession;
}

export async function superAdminContext(browser: Browser, state: E2eState): Promise<BrowserContext> {
  const session = await superAdminApiSession(state);
  const cookiesForBrowser = await session.cookiesForBrowser();

  const context = await browser.newContext();
  await context.addCookies(cookiesForBrowser);
  return context;
}
