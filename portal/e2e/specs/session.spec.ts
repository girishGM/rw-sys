/**
 * T-050 — TC-3 (login → logout → back button), TC-4 (session expiry mid-form), and the inherited
 * T-058 TC-4 criterion (`project-plan/tasks/T-050-e2e-tests.md`'s "Inherited acceptance criteria"
 * table): *"let the access token expire, then act in the UI → session refreshes, not logged out"*.
 *
 * The first two perform a session-destroying action (a real logout, a real `logout-all`) — which
 * `utils/scenario.ts`'s own header ("A fourth, genuinely in-scope bug", 2026-08-21) explains is
 * unsafe to do on any of `scenario`'s shared actors: `fullyParallel: true` means another spec can
 * be genuinely mid-request on that same, literal session at the exact instant this one revokes it,
 * and no self-healing check protects an *in-flight* request the way it protects the next one.
 * Reproduced live before this fix: `responsive.spec.ts`'s `scenario.tenantAdmin` context was
 * logged out mid-navigation by this file's own TC-3, in a `--workers` run, once both specs
 * happened to be scheduled concurrently. All three tests below therefore mint their own, dedicated
 * one-off actor (`utils/scenario.ts#createOneOffActor`) that nothing else in this suite ever reads,
 * rather than reusing `scenario.tenantAdmin`/`scenario.maker` directly — the third test's own
 * reason is `REFRESH_TOKEN_TTL_SECONDS`'s single-use rotation: consuming a shared actor's refresh
 * token would invalidate it for whichever other test's `loggedInContext` cache is relying on that
 * exact token next, the same "never touch a shared actor's live session" discipline, just for a
 * refresh rather than a logout.
 */
import { test, expect } from '../fixtures';
import { realUiLogin, expectOnDashboard } from '../fixtures/uiAuth';
import { ApiSession, login } from '../utils/apiClient';
import { forgeExpiredAccessToken } from '../utils/accessToken';
import { createOneOffActor } from '../utils/scenario';
import { uniqueTag } from '../utils/ids';

test('TC-3 — login, logout, back button: no cached data reachable', async ({
  browser,
  state,
  scenario,
}) => {
  // A one-off `maker` (nobody else's actor — see this file's header) — `maker` has `merchant:view`
  // (`T004_001_seed_role_entity_permissions.ts`), so `/merchants` renders the same way it would for
  // `tenant_admin`, the only thing this test actually needs.
  const actor = await createOneOffActor(
    state.apiBaseURL,
    scenario.tenantAdmin.cookies,
    'maker',
    uniqueTag('SESS3'),
  );
  const page = await (await browser.newContext()).newPage();
  await realUiLogin(page, state.baseURL, actor);
  await page.goto(`${state.baseURL}/merchants`);
  await expect(page.getByRole('cell', { name: scenario.merchant.merchantCode })).toBeVisible();

  // Log out through the real UI (avatar menu → "Log out").
  await page.locator('button[aria-haspopup="menu"]').click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await page.waitForURL((url) => url.pathname === '/login');

  // Back button after logout must not resurrect the merchants table from bfcache/query cache.
  await page.goBack();
  await page.waitForURL((url) => url.pathname === '/login' || url.pathname === '/merchants');
  if (new URL(page.url()).pathname === '/merchants') {
    // If the browser served a bfcache snapshot, the guard chain must still redirect once the
    // page's own effects re-run — assert it does, rather than assuming bfcache never happens.
    await page.waitForURL((url) => url.pathname === '/login', { timeout: 10_000 });
  }
  await expect(page.getByRole('cell', { name: scenario.merchant.merchantCode })).toHaveCount(0);
  await page.context().close();
});

test('TC-4 — session expiry mid-form redirects with `next`, and returns there after login', async ({
  browser,
  state,
  scenario,
  request,
}) => {
  // A one-off `maker` (nobody else's actor — see this file's header); `loggedInContext` is not used
  // here precisely because this test is about to revoke this actor's own session, and that cache is
  // shared across every caller in this worker for the *shared* scenario actors — a one-off actor
  // has no cache entry to protect either way, so a plain `realUiLogin` is simplest.
  const actor = await createOneOffActor(
    state.apiBaseURL,
    scenario.tenantAdmin.cookies,
    'maker',
    uniqueTag('SESS4'),
  );
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await realUiLogin(page, state.baseURL, actor);
  await page.goto(`${state.baseURL}/campaigns/new`);
  await page.getByLabel('Campaign name').fill('Mid-form campaign');

  // Revoke every session for this account server-side (a second, independent session sharing the
  // same credential — the same faithful "expired/revoked elsewhere" simulation TC-N10 uses).
  // Safe here: this actor is a one-off nobody else reads, so revoking it cannot race any other spec.
  const secondSession = new ApiSession(request, state.apiBaseURL);
  await login(secondSession, actor.email, actor.password);
  await secondSession.post('/auth/logout-all', {});

  await page.goto(`${state.baseURL}/campaigns/new`);
  await page.waitForURL((url) => url.pathname === '/login', { timeout: 15_000 });
  const next = new URL(page.url()).searchParams.get('next');
  expect(next).toBe('/campaigns/new');

  await page.getByLabel('Email').fill(actor.email);
  await page.getByLabel('Password').fill(actor.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL((url) => url.pathname === '/campaigns/new');
  await ctx.close();
});

test('T-058 TC-4 (inherited) — access token expiry mid-session refreshes silently, does not log the user out', async ({
  browser,
  state,
  scenario,
}) => {
  // A one-off `maker` (this file's own header, third reason: rotating a refresh token below would
  // invalidate it for anyone else relying on the same shared actor's cached session).
  const actor = await createOneOffActor(
    state.apiBaseURL,
    scenario.tenantAdmin.cookies,
    'maker',
    uniqueTag('SESS-ATEXP'),
  );
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await realUiLogin(page, state.baseURL, actor);
  await page.goto(`${state.baseURL}/dashboard`);
  await expectOnDashboard(page);

  // Forge an already-expired copy of this session's own, real, currently-valid access token —
  // signed with the same ephemeral RSA key the back end itself verifies against
  // (`state.jwtKeys`, `utils/accessToken.ts`'s own header) — and swap it into this context's
  // cookie jar in place of the genuine one, leaving the refresh and CSRF cookies untouched.
  const cookiesBefore = await ctx.cookies();
  const accessCookie = cookiesBefore.find((cookie) => cookie.name === '__Host-rs_at');
  if (!accessCookie) {
    throw new Error(
      'T-058 TC-4: no __Host-rs_at cookie present after a real login — has the access cookie ' +
        'name changed (auth.cookies.ts)?',
    );
  }
  const expiredAccessToken = forgeExpiredAccessToken(accessCookie.value, state.jwtKeys);
  await ctx.addCookies([{ ...accessCookie, value: expiredAccessToken }]);

  // Root-caused 2026-08-22 (retry 2/3, review failure on this exact test): under `--workers=4`
  // contention, the three checks that used to gate the cookie assertion below — no loading
  // status, no alert, url is `/campaigns` — can all be satisfied *before* `apiClient.ts` has
  // even sent the retried request, not just after it succeeds. React Router updates
  // `location.pathname` synchronously on click, but `CampaignsListPage`'s own `Table` does not
  // paint its `role="status"` loading skeleton until the next commit; a CPU-starved worker can
  // let Playwright's poll observe that brief "navigated, nothing rendered yet — so zero status
  // elements, zero alerts" gap and pass all three assertions on the very first poll, well
  // before the 401 → refresh → retry round trip has even started. `toHaveCount(0)` cannot tell
  // "never appeared" from "appeared and resolved" apart — that is the actual gap, not an
  // environment fluke, and it is why the cookie read that followed sometimes saw a request that
  // simply had not happened yet. Reproduced by instrumenting this exact run: the failing
  // instance's `page.url()` was already `/campaigns` while the network log showed no
  // `/auth/refresh` call had been made at all yet.
  //
  // Fixed by waiting for the actual network evidence the criterion is about — the refresh
  // response and the retried, now-successful `GET /campaigns` — registered *before* the click so
  // there is no window in which either request could complete unobserved, rather than inferring
  // "it must be done by now" from DOM state that can look identical whether the request has not
  // started or has already finished. This also still exercises the real UI path end to end (a
  // **client-side** navigation, clicking the sidebar, no `page.goto()` — `useBootstrap.ts`'s own
  // header explains why a full reload would not prove this criterion at all: `GET /me/bootstrap`
  // runs on a bare axios instance with no refresh-retry, by design ("a 401 here is meaningful on
  // its own... introducing the full client's retry machinery here would risk masking the very
  // 401 RequireAuth needs to see"), so a hard reload would always land back on `/login`
  // regardless of the refresh token's validity — that is not this criterion, it is T-058 TC-3's
  // already-covered "no session at all" case).
  const refreshResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes('/auth/refresh'),
    { timeout: 15_000 },
  );
  const retriedCampaignsResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      response.url().includes('/campaigns') &&
      response.status() === 200,
    { timeout: 15_000 },
  );

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'My Campaigns' })
    .click();
  await page.waitForURL((url) => url.pathname === '/campaigns', { timeout: 15_000 });

  // Positive proof, not an inference: the refresh actually happened and the retried request the
  // forged token triggered actually succeeded — both awaited before anything below reads the
  // cookie jar, so there is no remaining window for the assertion to outrun the network.
  const [refreshResult, campaignsResult] = await Promise.all([
    refreshResponse,
    retriedCampaignsResponse,
  ]);
  expect(refreshResult.status()).toBe(200);
  expect(campaignsResult.status()).toBe(200);

  // Not redirected to `/login`, and the list genuinely finished loading rather than showing
  // `Table.tsx`'s own `role="alert"` error state — a refresh that merely avoided a redirect
  // without the retried request actually succeeding would still show that error, forever, not a
  // settled table. Deliberately does not assert the table is *empty*: this one-off maker shares
  // `scenario`'s tenant (`createOneOffActor`'s own contract), and other specs running in the same
  // full-suite invocation may have created real campaigns in it — the row count is not this
  // criterion's concern, only whether the request the forged-token click triggered ultimately
  // succeeded.
  await expect(page.getByRole('status', { name: 'Loading table data' })).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/campaigns');

  // Proves a refresh actually happened, not that the forged token was merely tolerated: the
  // access-token cookie on this context is now neither the forged one nor the original —
  // `apiClient.ts`'s own single-flight refresh (implementation note 4) minted a fresh pair. By
  // this point `refreshResult`/`campaignsResult` above have already proven the network round
  // trip completed, so this is confirming the concrete artefact of that round trip, not racing
  // to observe it for the first time.
  const cookiesAfter = await ctx.cookies();
  const accessCookieAfter = cookiesAfter.find((cookie) => cookie.name === '__Host-rs_at');
  expect(accessCookieAfter?.value).not.toBe(expiredAccessToken);
  expect(accessCookieAfter?.value).not.toBe(accessCookie.value);

  await ctx.close();
});
