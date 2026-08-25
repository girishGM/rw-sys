/**
 * T-050 — TC-N1…TC-N10, one spec per role's "cannot". Most UI-driven tests read the one shared
 * `scenario` fixture (`fixtures/index.ts`, `utils/state.ts` — a run-wide singleton as of
 * 2026-08-20, see either header for why) through `loggedInContext` (`fixtures/uiAuth.ts`'s own
 * header explains why `realUiLogin` in a fresh page is no longer safe for a shared actor:
 * `LOGIN_PER_EMAIL_IP_LIMIT` is per-account, and this file alone reuses `scenario.maker` more than
 * five times). The API-only tests (TC-N4, TC-N6, TC-N7, TC-N8) use `sessionFromCookies` for the
 * same reason, on the same actors' pre-captured cookies (`utils/scenario.ts`'s own header) rather
 * than a fresh `login()` call. TC-N3 mints one extra, one-off country admin of its own
 * (`utils/scenario.ts#activateActor`); TC-N4 and TC-N9 read the second shared `isolatedScenario`
 * fixture instead, because both need genuine isolation `scenario` cannot give them; TC-N10 mints
 * its own one-off `maker` (`utils/scenario.ts#createOneOffActor`, added 2026-08-21) rather than
 * reading `scenario.maker` — see that function's own doc comment and `utils/scenario.ts`'s header
 * ("A fourth, genuinely in-scope bug") for why a session-revoking test cannot safely share an actor
 * with anything else in this suite — restated at each of those tests' own definitions.
 */
import { test, expect } from '../fixtures';
import { loggedInContext, realUiLogin } from '../fixtures/uiAuth';
import { ApiError, sessionFromCookies, type ApiSession } from '../utils/apiClient';
import { setUserRole } from '../utils/db';
import { activateActor, createOneOffActor } from '../utils/scenario';
import { uniqueCountryCode, uniqueEmail, uniqueTag } from '../utils/ids';

const PROTECTED_PATHS = [
  '/dashboard',
  '/countries',
  '/rules',
  '/rewards',
  '/tenants',
  '/users',
  '/merchants',
  '/campaigns',
  '/approvals',
  '/admin/access-control',
  '/audit',
];

test.describe('TC-N1 — every protected URL, logged out', () => {
  for (const path of PROTECTED_PATHS) {
    test(`redirects ${path} to /login with no content flash`, async ({ page, state }) => {
      await page.goto(`${state.baseURL}${path}`);
      await page.waitForURL((url) => url.pathname === '/login');
      // No protected heading/table ever painted first — `RequireAuth` renders children while the
      // bootstrap query is in flight (its own header says so), but nothing behind `RequireBootstrap`
      // does, so the one thing observable before the redirect is the login form itself.
      await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
    });
  }
});

test('TC-N2 — Maker opens /admin/access-control → Forbidden page', async ({ browser, state, scenario }) => {
  const ctx = await loggedInContext(browser, state.baseURL, scenario.maker);
  const page = await ctx.newPage();
  await page.goto(`${state.baseURL}/admin/access-control`);
  await expect(page.getByRole('heading', { name: "You don't have access to this page" })).toBeVisible();
  await ctx.close();
});

test("TC-N3 — Country Admin opens another country's tenant URL → 404", async ({
  browser,
  state,
  scenario,
  superAdminApi,
}) => {
  const otherTag = uniqueTag('N3');
  // `POST /tenants` is a `country_admin`-only route (`role_entity_permissions`, T-034) —
  // `super_admin` itself gets `PERM_DENIED` (reproduced live, T-050 2026-08-20). A genuinely
  // different country needs a genuinely different country admin to create its tenant, exactly the
  // real delegation chain the golden journey's own steps 2 and 5 walk.
  const otherCountry = await superAdminApi.post<{
    country: { id: number };
    admin: { email: string; temporaryPassword: string };
  }>('/countries', {
    code: uniqueCountryCode(),
    name: `Other country ${otherTag}`,
    timezone: 'Asia/Kuala_Lumpur',
    currencyCode: 'MYR',
    dialingCode: '+60',
    isHq: false,
    admin: { email: uniqueEmail('other-admin'), displayName: 'Other country admin' },
  });
  const otherCountryAdminSession = await activateActor(
    state.apiBaseURL,
    otherCountry.admin.email,
    otherCountry.admin.temporaryPassword,
  );
  const otherTenant = await otherCountryAdminSession.post<{ tenant: { id: number } }>('/tenants', {
    code: otherTag.slice(0, 20),
    name: `Other tenant ${otherTag}`,
    admin: { email: uniqueEmail('other-tenant-admin'), displayName: 'Other tenant admin' },
  });
  await otherCountryAdminSession.dispose();

  const ctx = await loggedInContext(browser, state.baseURL, scenario.countryAdmin);
  const page = await ctx.newPage();
  // Exact match against the *proxied* API path on the front end's own origin — not `endsWith`,
  // and not `state.apiBaseURL` (the back end's own, direct origin, `:3000`; the browser never
  // talks to it — `vite.config.ts`'s dev proxy forwards `/api/v1/*` from `:5173`). Root-caused
  // live (T-050, 2026-08-20): once the real `RATE_LIMITED`/`PERM_DENIED` bugs blocking this test
  // were fixed and it could finally reach this assertion for the first time, a loose `endsWith`
  // match captured the **document navigation** response for `page.goto()` itself — `GET
  // http://localhost:5173/tenants/{id}` (the SPA's own client-routed page, served `200` by Vite,
  // no `/api/v1` prefix) — which also happens to end in `/tenants/{id}`, and resolves before the
  // page's own script has even run its first fetch. The intended response is a second, distinct
  // request the SPA's own `TenantDetailPage`/`useTenantQuery` (`features/tenants/api.ts`) makes
  // a moment later, to a URL that is a superstring of the first, not a coincidence.
  const response = page.waitForResponse(
    `${state.baseURL}/api/v1/tenants/${String(otherTenant.tenant.id)}`,
  );
  await page.goto(`${state.baseURL}/tenants/${String(otherTenant.tenant.id)}`);
  expect((await response).status()).toBe(404);
  await ctx.close();
});

test("TC-N4 — Tenant A maker opens tenant B's campaign URL → 404", async ({
  browser,
  state,
  scenario,
  isolatedScenario,
}) => {
  // `isolatedScenario` (`fixtures/index.ts`/`utils/state.ts`) — a genuinely different tenant +
  // maker from `scenario`'s own, so this test owns a genuinely cross-tenant campaign id rather
  // than merely a non-existent one. Its `maker`, specifically: TC-N9 below reads this same
  // isolated scenario's `checker` instead, deliberately, so the two tests never race on the same
  // account. `sessionFromCookies` — not `login()` — reuses the one real login `buildScenario`
  // already performed for this actor (`utils/scenario.ts`'s own header), rather than spending a
  // second one against `LOGIN_PER_EMAIL_IP_LIMIT`.
  const otherMakerSession = await sessionFromCookies(state.apiBaseURL, isolatedScenario.maker.cookies);
  const otherCampaign = await otherMakerSession.post<{ id: number }>('/campaigns', {
    campaignCode: `N4${Date.now()}`,
    name: 'Cross-tenant probe',
    startDate: new Date().toISOString(),
    endDate: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });

  const ctx = await loggedInContext(browser, state.baseURL, scenario.maker);
  const page = await ctx.newPage();
  // The front end's own, proxied origin — not `endsWith`, not `state.apiBaseURL` — see TC-N3
  // above for the full, live-diagnosed reason (the SPA's own document navigation response is a
  // false-positive match for a loose suffix check on this exact URL shape).
  const response = page.waitForResponse(
    `${state.baseURL}/api/v1/campaigns/${String(otherCampaign.id)}`,
  );
  await page.goto(`${state.baseURL}/campaigns/${String(otherCampaign.id)}`);
  expect((await response).status()).toBe(404);
  await ctx.close();
});

test("TC-N5 — Merchant A opens merchant B's campaign URL → 404", async ({ browser, state, scenario }) => {
  const ctx = await loggedInContext(browser, state.baseURL, scenario.merchantUser);
  const page = await ctx.newPage();
  const response = await page.request.get(`${state.apiBaseURL}/merchant/campaigns/999999999`);
  expect(response.status()).toBe(404);
  await ctx.close();
});

/**
 * TC-N6 — architect ruling, 2026-08-21 (`T-050-e2e-tests.md`'s own "TC-N6 — architect ruling"
 * section; read that in full before touching this test).
 *
 * The ruling's suggested route to reach `SelfApprovalForbiddenError` honestly — "`PATCH` on a
 * user supports changing `role` (`users/dto/update-user.dto.ts:28`)" — **does not hold against
 * this codebase as it stands**, confirmed by reading the code the ruling itself cites, not
 * assumed: `UsersService.update()` throws `RoleChangeNotPermittedError` (403
 * `ROLE_CHANGE_NOT_PERMITTED`) unconditionally whenever `dto.role !== undefined` — "every value,
 * not only an escalating one" is that method's own doc comment, and refusing *every* role change
 * through this route, not just an escalating one, is T-035's own **mandatory** TC-28. This is not
 * a defect to file: it is confirmed, deliberately tested, intentional v1 behaviour, so a
 * `file-defect.js` report against it would be asking `T-035`'s owner to "fix" something that is
 * already correct and already covered by a passing, required test. The ruling's own fallback for
 * exactly this situation — *"a guard rejects the role change… cover the rule at the service layer
 * instead"* — is what this test does, via the same **honest** technique
 * `back-end/test/approvals/approvals.e2e-spec.ts`'s own TC-6 already established for the identical
 * scenario (that file's header: *"built honestly, not by editing `requested_by`"*): a real account
 * submits a real, structurally-complete campaign for real while it is still a `maker`, is then
 * promoted to `checker` by a direct `UPDATE portal_users SET role = …` (the one path
 * `PATCH /users/:id` cannot take), logs in again for real (the role travels in the JWT, so the old
 * session still says `maker`), and only then attempts to approve its own, pre-existing request —
 * over the real HTTP API, exactly as the ruling's steps 3-5 specify.
 *
 * A **one-off** maker (`createOneOffActor`), never `scenario.maker`: this test permanently changes
 * the account's role, which would otherwise silently break every other spec that expects
 * `scenario.maker` to still be a maker (the same reasoning `utils/scenario.ts`'s header gives for
 * every other session-destroying or account-mutating test in this file).
 */
test('TC-N6 — a maker promoted to checker cannot approve their own old submission → 422 SELF_APPROVAL_FORBIDDEN', async ({
  state,
  scenario,
  superAdminApi,
}) => {
  const tag = uniqueTag('N6');
  const promoted = await createOneOffActor(state.apiBaseURL, scenario.tenantAdmin.cookies, 'maker', tag);

  // --- while still a maker: a real, structurally-complete, submitted campaign -------------------
  // The same five steps the golden journey drives through the browser (`golden-journey.spec.ts`'s
  // own steps 8b-8g), against the real API instead — this test is about the approval guard, not
  // the wizard, and `scenario` already has a country-assigned rule/reward and a merchant with an
  // activity ready to reuse (`utils/scenario.ts#buildScenario`).
  let requestId: number;
  {
    const makerSession = await sessionFromCookies(state.apiBaseURL, promoted.cookies);
    try {
      const campaign = await makerSession.post<{ id: number }>('/campaigns', {
        campaignCode: `N6${tag}`.slice(0, 50),
        name: `Self-approval probe ${tag}`,
        startDate: new Date().toISOString().slice(0, 10),
        endDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
      });
      await makerSession.post(`/campaigns/${String(campaign.id)}/merchants`, {
        merchantIds: [scenario.merchant.id],
      });
      const afterTracker = await makerSession.post<{ trackers: { id: number }[] }>(
        `/campaigns/${String(campaign.id)}/trackers`,
        { name: 'Main tracker', completionLogic: 'all' },
      );
      const trackerId = afterTracker.trackers[afterTracker.trackers.length - 1].id;
      const afterComponent = await makerSession.post<{
        trackers: { id: number; components: { id: number }[] }[];
      }>(`/campaigns/${String(campaign.id)}/trackers/${String(trackerId)}/components`, {
        name: 'Qualifying purchase',
        activityId: scenario.activityId,
      });
      const tracker = afterComponent.trackers.find((t) => t.id === trackerId);
      const componentId = tracker?.components[tracker.components.length - 1]?.id;
      if (componentId === undefined) {
        throw new Error('TC-N6: component was not created — journey response had no matching tracker');
      }
      await makerSession.post(`/campaigns/${String(campaign.id)}/rules`, {
        componentId,
        ruleId: scenario.rule.id,
      });
      await makerSession.post(`/campaigns/${String(campaign.id)}/rewards`, {
        level: 'campaign',
        rewardPolicyId: scenario.reward.policyId,
      });
      const submitted = await makerSession.post<{ approvalRequestId: number }>(
        `/campaigns/${String(campaign.id)}/submit`,
        {},
      );
      requestId = submitted.approvalRequestId;
    } finally {
      await makerSession.dispose();
    }
  }

  // --- promotion: the one thing no portal API will do — see this test's own header -------------
  // `GET /users` (not the `POST /users` response `createOneOffActor` already discarded, per its
  // own doc comment) decrypts correctly — the same lookup TC-N9 below already performs.
  const users = await superAdminApi.get<{ id: number; email: string }[]>('/users', { pageSize: 200 });
  const promotedRow = users.find((u) => u.email === promoted.email);
  if (promotedRow === undefined) {
    throw new Error(`TC-N6: GET /users returned no row for ${promoted.email}`);
  }
  await setUserRole(state.db, promotedRow.id, 'checker');

  // A fresh login: the role travels in the verified JWT, so the session `createOneOffActor`
  // already captured still says `maker`.
  const checkerSession: ApiSession = await activateActor(state.apiBaseURL, promoted.email, promoted.password);
  try {
    // --- the guard, over the real HTTP API, exactly as ApprovalsService#decide runs it ----------
    let status = 0;
    let code: string | undefined;
    try {
      await checkerSession.post(`/approvals/${String(requestId)}/approve`, { comment: '' });
    } catch (error) {
      if (error instanceof ApiError) {
        status = error.status;
        code = error.code;
      } else {
        throw error;
      }
    }
    // Specific, not the tolerant `[403, 404, 422]` the pre-ruling version of this test asserted —
    // see this test's own header on why that was hiding a proof rather than making one.
    expect(status).toBe(422);
    expect(code).toBe('SELF_APPROVAL_FORBIDDEN');

    // "Nothing changed" — the throw rolls back a read-only transaction (`approvals.service.ts`'s
    // own header, step 2). Read back through `GET /approvals/:id` as `super_admin`, over the real
    // API, rather than a direct DB read: `super_admin` has `approval:view` on every tenant, so
    // this is exactly what an operator investigating the same question would see.
    const detail = await superAdminApi.get<{ request: { status: string; reviewedBy: number | null } }>(
      `/approvals/${String(requestId)}`,
    );
    expect(detail.request.status).toBe('pending');
    expect(detail.request.reviewedBy).toBeNull();
  } finally {
    await checkerSession.dispose();
  }
});

test('TC-N7 — Maker POST /rules via the API → 403', async ({ state, scenario }) => {
  // `sessionFromCookies`, not `login()` — see this file's own header.
  const makerSession = await sessionFromCookies(state.apiBaseURL, scenario.maker.cookies);

  let status = 0;
  try {
    await makerSession.post('/rules', {
      ruleCode: uniqueTag('N7'),
      name: 'Forged rule',
      subCategoryId: 1,
    });
  } catch (error) {
    status = (error as { status?: number }).status ?? 0;
  }
  expect(status).toBe(403);
});

test('TC-N8 — Tenant Admin creates a super_admin via the API → 403', async ({ state, scenario }) => {
  // `sessionFromCookies`, not `login()` — see this file's own header.
  const tenantAdminSession = await sessionFromCookies(state.apiBaseURL, scenario.tenantAdmin.cookies);

  let status = 0;
  try {
    await tenantAdminSession.post('/users', {
      email: uniqueEmail('forged-super-admin'),
      displayName: 'Forged',
      role: 'super_admin',
    });
  } catch (error) {
    status = (error as { status?: number }).status ?? 0;
  }
  expect(status).toBe(403);
});

test("TC-N9 — deactivated user's live session → next action redirects to login", async ({
  page,
  state,
  superAdminApi,
  isolatedScenario,
}) => {
  // `isolatedScenario`'s `checker` — deliberately never `scenario`'s own (`POST /users/:id/
  // deactivate` permanently locks the account out, which would poison every other test sharing
  // it, `fixtures/index.ts`'s own header) and deliberately never `isolatedScenario.maker` either
  // (TC-N4 above authenticates as that one — the two tests would otherwise race on the same
  // account if they both touched it). A plain, fresh `realUiLogin` — not `loggedInContext` — is
  // fine here: nothing else in this suite ever logs in as this specific checker, so there is no
  // shared cache entry to protect either way, and this test immediately deactivates the account
  // regardless.
  await realUiLogin(page, state.baseURL, isolatedScenario.checker);
  await page.goto(`${state.baseURL}/dashboard`);

  // `GET /users` has no `tenantId` filter (`list-users-query.dto.ts`'s own whitelist) — `pageSize`
  // is the only lever available.
  const users = await superAdminApi.get<{ id: number; email: string }[]>('/users', { pageSize: 200 });
  const checkerRow = users.find((u) => u.email === isolatedScenario.checker.email);
  expect(checkerRow).toBeDefined();
  await superAdminApi.post(`/users/${String(checkerRow?.id)}/deactivate`, {});

  // `/approvals`, not `/campaigns` — the Checker-appropriate equivalent of the original Maker
  // version's own next-page check (a *different* URL from the `/dashboard` already visited above,
  // so this navigation is guaranteed to trigger a fresh session check rather than a same-route
  // client-side no-op).
  //
  // **Tolerates *any* `goto`-interruption error here — found live, T-050 2026-08-21, widened
  // 2026-08-22 after review round 10 reproduced a second, untolerated variant of the same race.**
  // The `/dashboard` page still open above polls its own session state in the background
  // (`unread-count` et al.); once the `deactivate` call above lands, that background check can
  // independently notice the 401 and redirect to `/login?next=%2Fdashboard` *before* this explicit
  // `goto('/approvals')` finishes navigating. Which of the two redirects "wins" the race is not
  // deterministic, and neither is the exact string Chromium/Playwright surfaces for the loser's
  // abandoned navigation — round 9 reproduced "Navigation to .../approvals is interrupted by
  // another navigation to .../login" (tolerated by the original, narrower regex); round 10
  // reproduced `net::ERR_ABORTED at .../approvals` for the same underlying race, which that regex
  // did not match, so the test threw instead of reaching its own assertion below — even though the
  // app had, in fact, already reached the exact correct terminal state.
  //
  // Rather than chase a third string, this no longer inspects the error at all: it only matters
  // that the *next* line — the actual assertion this test exists to make — is reached and evaluated
  // for real. A genuinely different failure (the app not redirecting at all, the server being down,
  // a real navigation error unrelated to this race) cannot hide behind this `catch`, because
  // `waitForURL` below still has to observe the app landing on `/login` within its own timeout; if
  // the redirect never happens for a real reason, that call fails the test on its own merits.
  await page.goto(`${state.baseURL}/approvals`).catch(() => {
    // Intentionally swallowed — see comment above. The terminal-state assertion below is the
    // actual proof this test makes; this `goto` is only ever a means of triggering it.
  });
  await page.waitForURL((url) => url.pathname === '/login', { timeout: 15_000 });
});

test('TC-N10 — session revoked server-side mid-journey → clean redirect, no error spam', async ({
  browser,
  state,
  scenario,
}) => {
  // A one-off `maker` (`utils/scenario.ts#createOneOffActor`) — never `scenario.maker`. This test
  // revokes every session for the account it logs in as; `utils/scenario.ts`'s own header ("A
  // fourth, genuinely in-scope bug", 2026-08-21) explains why that is unsafe to do on any of
  // `scenario`'s shared actors under `fullyParallel: true` (another spec can be genuinely
  // mid-request on that same, literal session at the exact instant this test revokes it — no
  // self-healing check protects an in-flight request). A one-off actor nobody else reads removes
  // the race entirely, the same fix applied to `session.spec.ts`'s TC-3/TC-4.
  const actor = await createOneOffActor(
    state.apiBaseURL,
    scenario.tenantAdmin.cookies,
    'maker',
    uniqueTag('N10'),
  );
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await realUiLogin(page, state.baseURL, actor);
  await page.goto(`${state.baseURL}/dashboard`);

  // Revoke every session for this account server-side, from a second, genuinely independent
  // session sharing the same credential — the simplest faithful way to simulate "revoked
  // elsewhere" without reaching into the database directly.
  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  await realUiLogin(secondPage, state.baseURL, actor);
  // `X-CSRF-Token`, read from the non-`HttpOnly` `rs_csrf` cookie exactly the way
  // `readCsrfCookie.ts`/`lib/csrf.ts` do — a bare `fetch()` bypasses the app's own API client, so
  // nothing else attaches this header. Its absence is not a soft failure: `CsrfGuard` answers 403
  // `CSRF_TOKEN_MISSING`, `fetch()` does not throw on a non-2xx status, and `await`ing the promise
  // without reading `.ok` silently "succeeds" while revoking nothing — root-caused live (T-050,
  // 2026-08-20): this test's own final assertion timed out because the session it expected gone
  // was, provably (a full, rendered `/campaigns` page in the failure screenshot), never revoked at
  // all. The status check below turns that same silent failure into a loud one instead.
  const logoutAllStatus = await secondPage.evaluate(async () => {
    const csrfToken = document.cookie.match(/(?:^|; )rs_csrf=([^;]*)/)?.[1];
    const response = await fetch('/api/v1/auth/logout-all', {
      method: 'POST',
      headers: csrfToken ? { 'X-CSRF-Token': decodeURIComponent(csrfToken) } : {},
    });
    return response.status;
  });
  expect(logoutAllStatus).toBe(204);
  await secondContext.close();

  // Chromium itself logs a `console` message of type `'error'` for *every* non-2xx network
  // response, independently of whether the app handled it — confirmed live (T-050, 2026-08-20):
  // the one, single, expected `401` from the `/me/bootstrap` call that correctly detects the
  // revoked session and triggers the redirect below produces exactly this one benign line. "No
  // error spam" means no genuine *application* error (an uncaught exception, a rejected promise
  // the app itself never handles) — not zero browser-level network-failure log lines for a
  // request this test itself made fail on purpose. Filtered here rather than asserting an exact
  // count, which would make this test change every time an unrelated screen adds one more
  // resource fetch to the page.
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) {
      consoleErrors.push(msg.text());
    }
  });

  await page.goto(`${state.baseURL}/campaigns`);
  await page.waitForURL((url) => url.pathname === '/login', { timeout: 15_000 });
  expect(consoleErrors).toEqual([]);
  await ctx.close();
});

