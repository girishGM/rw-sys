/**
 * T-050 — builds one spec's own, fully isolated slice of the delegation chain
 * (country → country admin → rule/reward → tenant → tenant admin → maker/checker/merchant →
 * merchant/store/activity), through the real, unmocked API. Every id is unique per call
 * (`utils/ids.ts`), so two specs — or two runs of the same spec (TC-8) — never collide.
 *
 * This is **not** how the golden-journey spec builds its own scenario — that spec drives every
 * one of these same steps through the real browser, because proving the UI screens work end to
 * end against the real API is the entire point of TC-1. Every other spec (negative journeys,
 * access control, a11y, timezone, session, concurrency) is testing something else, and re-driving
 * ten screens of setup through the browser for each of them would make this suite slow without
 * making it more correct — this module gets those specs to their own starting line quickly, using
 * the same endpoints the UI calls, so it is not "faking" the precondition, just building it fast.
 *
 * ### One of the two real bugs this once exposed is now fixed (T-059); the other is still live
 *
 * Both were originally found by reproduction (T-050 retry 1/3), both outside this task's file
 * scope (AGENT-PROTOCOL R9):
 *
 *  1. **`POST /tenants` 404s for every real `country_admin`.** Fixed by T-059
 *     (`tenants.service.ts`'s `provisionTenantAdmin` now calls the narrow `CredentialProvisioner`
 *     port instead of `this.scoped.create(PortalUserCredential, …)`, which `scope-strategy.ts`
 *     denied on every axis). Re-confirmed fixed by direct reproduction in this task's own run
 *     (T-050, 2026-08-20): tenant creation via `country_admin` now completes.
 *  2. **`POST /users`' response leaks the new user's `email` as ciphertext, not plaintext — still
 *     live, re-confirmed by direct reproduction (T-050, 2026-08-20).** `user-response.dto.ts`'s
 *     `toUserDto` reads `user.email` straight off the just-`create`d Sequelize instance.
 *     `model-encryption.hooks.ts`'s own header explains why that instance still holds ciphertext
 *     at that point: `afterFind` decrypts, `afterCreate` only re-binds the AAD once the real
 *     primary key is known — it does not decrypt back to plaintext. The result: `POST /users`
 *     returns something shaped like `v1.e2e-field-1.<iv>.<ciphertext>` in its `email` field, where
 *     a caller reasonably expects the address it just submitted. Reproduced live: `createUser`
 *     below, before its own workaround was added, failed every call with `ApiError:
 *     VALIDATION_FAILED` from the immediately following `POST /auth/login` — the ciphertext string
 *     is not a syntactically valid email address, so login's own DTO validation rejects it before
 *     any rate limiter is even reached. `back-end/src/modules/users/**` is T-035/T-046's file
 *     scope, not this task's (AGENT-PROTOCOL R9); no task in `progress.json` currently owns this
 *     fix (unlike bug 1, which became T-059). The fix is likely one line: return the
 *     already-validated `dto.email.trim()` the caller already has in hand, the same way
 *     `tenants.service.ts#provisionTenantAdmin` returns `dto.email.trim()` rather than
 *     `user.email` (and the same way `temporaryPassword` is threaded through as an explicit
 *     parameter rather than read back off the model) — `countries.service.ts#provisionCountryAdmin`
 *     already does this correctly, so `users.service.ts#create` is the one remaining call site.
 *     Flagged again, in full, in the completion report; escalated per AGENT-PROTOCOL §7 rather
 *     than patched here.
 *
 * **Workaround applied here (and in `login.spec.ts`'s own fresh-maker case), entirely inside this
 * task's own files.** `createUser` below never reads the broken `email` field back off the
 * `POST /users` response — it already knows the plaintext address it just submitted (the local
 * `email` const), so it uses that directly, the exact same "use the value the caller already has"
 * pattern the eventual backend fix would apply. This is not a fix for the underlying defect and
 * does not hide it: neither this module's nor `login.spec.ts`'s own test is *about* what
 * `POST /users` echoes back, so depending on the known-good local value instead of the broken
 * response field changes nothing about what either actually asserts — it only stops an unrelated
 * backend defect from also taking down every setup step and login flow that merely needs a
 * working account, which is not what this task is chartered to prove. The defect itself is
 * restated in full in the completion report either way.
 *
 * ### Every actor's cookies, captured once, here — the other half of the `LOGIN_PER_EMAIL_IP_
 * ### LIMIT` fix (T-050, 2026-08-20)
 *
 * `scenario`/`isolatedScenario` becoming run-wide singletons (`utils/state.ts`'s own header) cut
 * *setup* logins to one per role, but `fixtures/uiAuth.ts`'s `loggedInContext` cache is a
 * **module-level** variable — one per Playwright *worker process*, not one for the whole run.
 * With several workers each independently asking for, say, `scenario.maker` for the first time,
 * each pays its own real login, and `LOGIN_PER_EMAIL_IP_LIMIT = 5` (`security.constants.ts`,
 * T-012's file scope) is reachable again this way alone — reproduced live (T-050, 2026-08-20).
 * Every `ActorCredentials` below therefore also carries the **cookies** the one real login this
 * module already performs produced (`ApiSession.cookiesForBrowser()`), captured right before that
 * session is disposed. `loggedInContext` seeds its cache from these on first use instead of
 * logging in at all, the same way `superAdminSession.ts` already does for `super_admin` — the only
 * real login any actor in `scenario`/`isolatedScenario` ever needs, for the whole run, is the one
 * this module performs to build them in the first place.
 *
 * ### A third, genuinely-in-scope bug, only reachable once bugs 1 and 2 above stopped masking it
 * ### — found and fixed here (T-050, 2026-08-20)
 *
 * `buildScenario` used to take a single, caller-supplied `APIRequestContext` (the spec's own
 * `request` fixture) and build *every* actor's `ApiSession` on top of it — country admin, tenant
 * admin, and (via `activateActor`) every one of maker/checker/merchant. An `APIRequestContext` is
 * one cookie jar; `POST /auth/login` sets that jar's session cookies. Building five sessions on
 * one jar therefore did not build five sessions at all — each new login silently signed the
 * previous actor out, so by the time `createUser('checker')` ran, `tenantAdminSession.post(...)`
 * was actually presenting the **maker's** cookies (confirmed live: the second `POST /users` call
 * failed with `PERM_DENIED`, actor role `maker`, not `tenant_admin`). This never surfaced before
 * bugs 1 and 2 were fixed because `buildScenario` never got far enough to mint a second session.
 * The fix: every actor this module logs in — `countryAdminSession`, `tenantAdminSession`, and each
 * transient session `createUser` mints — now gets its own, dedicated `APIRequestContext`
 * (`newActorSession`), the same isolation `superAdminSession.ts` and `global-setup.ts` already
 * give the `super_admin` session, disposed once no longer needed. `buildScenario` no longer takes
 * a shared `request` at all, for the same reason: accepting one would invite this exact bug back
 * the next time a caller passed in something already in use for another login.
 *
 * ### A fourth, genuinely in-scope bug — concurrent tests colliding on one *live* shared session
 * ### (T-050, 2026-08-21)
 *
 * `fixtures/index.ts`'s own header claims sharing `scenario` across the whole run is safe because
 * every test that mutates one of its actors "only revokes their live sessions... which does not
 * stop the same account logging in again, so it cannot poison a later test." That is true for
 * *sequential* poisoning (`fixtures/uiAuth.ts#loggedInContext`'s self-heal handles exactly that
 * case) — it is false for a *concurrent* one. `playwright.config.ts` sets `fullyParallel: true`, so
 * with more than one worker another spec can be genuinely mid-request on `scenario.tenantAdmin` or
 * `scenario.maker` — the literal same session cookie, not a copy — at the exact instant a test
 * elsewhere calls `POST /auth/logout`/`logout-all` on that same account. Reproduced live (T-050,
 * 2026-08-21, `npm run e2e -- --grep login`, which also matches `responsive.spec.ts`'s own title):
 * `responsive.spec.ts`'s `scenario.tenantAdmin` context lost its session and was redirected to
 * `/login?next=%2Fmerchants` mid-navigation, concurrently with `session.spec.ts`'s TC-3 logging the
 * very same account out through its own, separate context. This is exactly the "fail at 5 workers,
 * pass at 1 and 4" fixture-sharing effect flagged for this task to fix. `createOneOffActor` below
 * is the fix: any test that performs a session-destroying action (`logout`, `logout-all`) must do
 * it on an actor **nobody else in this suite ever reads**, never on one of `scenario`'s or
 * `isolatedScenario`'s shared actors — no self-healing check can protect a session another worker
 * is using at that very moment, only never sharing it can.
 */
import { request as playwrightRequest } from '@playwright/test';
import { ApiSession, login, sessionFromCookies, type BrowserCookie } from './apiClient';
import { createActivity, type DbConnectionInfo } from './db';
import { uniqueCountryCode, uniqueEmail, uniqueTag } from './ids';

export interface ActorCredentials {
  readonly email: string;
  readonly password: string;
  /** This actor's one real login's cookies — see this file's header, "every actor's cookies,
   * captured once, here". `fixtures/uiAuth.ts#loggedInContext` seeds its per-worker cache from
   * these instead of performing its own login. */
  readonly cookies: readonly BrowserCookie[];
}

/**
 * Exactly the slice of `E2eState` (`utils/state.ts`) `buildScenario` needs — declared locally,
 * deliberately not `import type { E2eState } from './state'`, because `E2eState` itself now
 * carries a `scenario: Scenario` field (the run-wide singleton this file's header describes) and
 * `global-setup.ts` needs to call `buildScenario` to produce that very value *before* a complete
 * `E2eState` exists to pass it. Structural typing means a real `E2eState` still satisfies this
 * interface without any cast — every other caller (`fixtures/index.ts`) passes its `state` fixture
 * straight through unchanged.
 */
export interface ScenarioContext {
  readonly apiBaseURL: string;
  readonly db: DbConnectionInfo;
  readonly seedData: {
    readonly ruleSubCategoryId: number;
    readonly activityTypeId: number;
  };
}

export interface Scenario {
  readonly country: { readonly id: number; readonly code: string; readonly name: string };
  readonly countryAdmin: ActorCredentials;
  readonly rule: { readonly id: number; readonly ruleCode: string; readonly name: string };
  readonly reward: {
    readonly id: number;
    readonly systemCode: string;
    readonly policyId: number;
    readonly policyName: string;
  };
  readonly tenant: { readonly id: number; readonly code: string; readonly name: string };
  readonly tenantAdmin: ActorCredentials;
  readonly maker: ActorCredentials;
  readonly checker: ActorCredentials;
  readonly merchantUser: ActorCredentials;
  readonly merchant: { readonly id: number; readonly merchantCode: string; readonly name: string };
  readonly store: { readonly id: number; readonly storeCode: string };
  readonly activityId: number;
}

const NEW_PASSWORD = 'Scenario-Actor-9-Password!';

/** A fresh `ApiSession` with its own, dedicated `APIRequestContext` — its own cookie jar,
 * isolated from every other actor's. See this file's header, "bug 3": sharing one context (one
 * cookie jar) across two logins silently signs the first one out. */
async function newActorSession(apiBaseURL: string): Promise<ApiSession> {
  const context = await playwrightRequest.newContext({ baseURL: apiBaseURL });
  return new ApiSession(context, apiBaseURL);
}

/** Logs a freshly-provisioned (non-`super_admin`) user in, on their own dedicated session, and
 * clears the forced password change every such account starts with — every role
 * T-035/T-030/T-034 provisions is created with a temporary password and
 * `must_change_password = true` (`PasswordRevealPanel.tsx`'s own copy: "ask the user to change it
 * within 72 hours"), and every route but two is closed until they do
 * (`PasswordChangeRequiredGuard`). Exported: specs that need one extra, one-off activated actor
 * of their own (`negative-journeys.spec.ts`'s TC-N3) reuse this rather than re-deriving the same
 * three lines. */
export async function activateActor(
  apiBaseURL: string,
  email: string,
  temporaryPassword: string,
): Promise<ApiSession> {
  const session = await newActorSession(apiBaseURL);
  const outcome = await login(session, email, temporaryPassword);
  if (outcome.mfaRequired) {
    throw new Error(`${email}: unexpectedly required MFA — only super_admin should (T-055).`);
  }
  if (outcome.mustChangePassword) {
    await session.post('/auth/change-password', {
      currentPassword: temporaryPassword,
      newPassword: NEW_PASSWORD,
    });
  }
  return session;
}

/** `activateActor`, plus this file's header ("every actor's cookies, captured once, here"): logs
 * in, clears the forced password change, captures the resulting session's cookies, and disposes
 * the session — the caller gets back exactly the `ActorCredentials` shape `Scenario` stores,
 * ready for `fixtures/uiAuth.ts#loggedInContext` to seed a browser context from with no further
 * login, ever, from any worker. */
async function activateAndCapture(
  apiBaseURL: string,
  email: string,
  temporaryPassword: string,
): Promise<ActorCredentials> {
  const session = await activateActor(apiBaseURL, email, temporaryPassword);
  const cookies = await session.cookiesForBrowser();
  await session.dispose();
  return { email, password: NEW_PASSWORD, cookies };
}

/**
 * A fresh, one-off actor inside an already-provisioned tenant — see this file's header, "A fourth,
 * genuinely in-scope bug", for why this exists: any test that logs an actor out (or revokes all of
 * its sessions) must do so on an account nobody else in this suite ever reads, because
 * `fullyParallel: true` means another spec can be genuinely mid-request on a *shared* actor's
 * session at that exact instant. `authorizingCookies` is used for exactly one, non-destructive
 * `POST /users` call (never a session-destroying one), so it is safe to borrow a shared actor's
 * (e.g. `scenario.tenantAdmin`'s) cookies for it — the new account this returns is what the caller
 * must actually log in, act and log out as. Only `maker`/`checker`/`merchant` are supported: the
 * only roles this suite has ever needed a spare one-off of, and the only ones `POST /users` accepts
 * as a target role for a `tenant_admin`-authorised caller (`role_entity_permissions`, T-035).
 */
export async function createOneOffActor(
  apiBaseURL: string,
  authorizingCookies: readonly BrowserCookie[],
  role: 'maker' | 'checker' | 'merchant',
  tagPrefix: string,
  merchantId?: number,
): Promise<ActorCredentials> {
  const authSession = await sessionFromCookies(apiBaseURL, authorizingCookies);
  const email = uniqueEmail(`${tagPrefix}-${role}`);
  try {
    const created = await authSession.post<{ temporaryPassword: string }>('/users', {
      email,
      displayName: `E2E one-off ${role} ${tagPrefix}`,
      role,
      ...(merchantId === undefined ? {} : { merchantId }),
    });
    return await activateAndCapture(apiBaseURL, email, created.temporaryPassword);
  } finally {
    // This session's own dedicated `APIRequestContext` — safe to dispose regardless of outcome
    // (this file's header, `newActorSession`'s own doc comment on `ApiSession#dispose`); the
    // borrowed cookies' underlying server-side session is untouched by disposing a *local*
    // request context built from a copy of them.
    await authSession.dispose();
  }
}

export async function buildScenario(
  context: ScenarioContext,
  superAdmin: ApiSession,
): Promise<Scenario> {
  const { apiBaseURL } = context;
  const tag = uniqueTag('E2E');

  // --- Super Admin: country (+ Country Admin), rule, reward -----------------------------------
  const countryCode = uniqueCountryCode();
  const countryResult = await superAdmin.post<{
    country: { id: number; code: string; name: string };
    admin: { email: string; temporaryPassword: string };
  }>('/countries', {
    code: countryCode,
    name: `E2E Country ${tag}`,
    timezone: 'Asia/Kuala_Lumpur',
    currencyCode: 'MYR',
    dialingCode: '+60',
    isHq: false,
    admin: { email: uniqueEmail('country-admin'), displayName: `E2E Country Admin ${tag}` },
  });

  const rule = await superAdmin.post<{ id: number; ruleCode: string; name: string }>('/rules', {
    ruleCode: `${tag}_RULE`,
    name: `E2E rule ${tag}`,
    subCategoryId: context.seedData.ruleSubCategoryId,
    expression: 'amount >= :minSpend',
  });
  await superAdmin.post(`/rules/${String(rule.id)}/countries`, { countryId: countryResult.country.id });

  const reward = await superAdmin.post<{ id: number; systemCode: string; name: string }>('/rewards', {
    systemCode: `${tag}_REWARD`,
    name: `E2E reward ${tag}`,
    rewardType: 'monetary',
    deliveryMode: 'realtime',
    connectorType: 'internal_api',
  });
  await superAdmin.post(`/rewards/${String(reward.id)}/countries`, {
    countryId: countryResult.country.id,
  });
  const policy = await superAdmin.post<{ id: number; policyCode: string; name: string }>(
    `/rewards/${String(reward.id)}/policies`,
    { policyCode: `${tag}_POLICY`, name: `E2E policy ${tag}` },
  );

  // --- Country Admin: tenant (+ Tenant Admin), activation --------------------------------------
  const countryAdminSession = await activateActor(
    apiBaseURL,
    countryResult.admin.email,
    countryResult.admin.temporaryPassword,
  );
  const tenantResult = await countryAdminSession.post<{
    tenant: { id: number; code: string; name: string; status: string };
    admin: { email: string; temporaryPassword: string };
  }>('/tenants', {
    code: `T${tag}`.slice(0, 20),
    name: `E2E Tenant ${tag}`,
    admin: { email: uniqueEmail('tenant-admin'), displayName: `E2E Tenant Admin ${tag}` },
  });
  await countryAdminSession.post(`/tenants/${String(tenantResult.tenant.id)}/activate`, {});
  // Captured before disposal — see this file's header, "every actor's cookies, captured once,
  // here". Not needed again after this point for its own API calls (`tenantAdminSession` below is
  // a genuinely separate context, not a reuse of this one).
  const countryAdminCookies = await countryAdminSession.cookiesForBrowser();
  await countryAdminSession.dispose();
  const countryAdmin: ActorCredentials = {
    email: countryResult.admin.email,
    password: NEW_PASSWORD,
    cookies: countryAdminCookies,
  };

  // --- Tenant Admin: maker/checker/merchant users, merchant + store + activity -----------------
  const tenantAdminSession = await activateActor(
    apiBaseURL,
    tenantResult.admin.email,
    tenantResult.admin.temporaryPassword,
  );

  // `deriveTargetScope` (`users.service.ts`, T-035) requires a `merchantId` on the request body
  // for `role: 'merchant'` specifically — a merchant-role user is scoped to one merchant, not the
  // whole tenant, the same way `role: 'super_admin'` requires a `countryId`. That merchant has to
  // exist first, so `createUser('merchant', …)` below is called only after `POST /merchants`, not
  // before it (T-050, 2026-08-20 — reproduced live: creating the merchant user before the merchant
  // existed 400ed with `VALIDATION_FAILED`/`{field: 'merchantId', code: 'REQUIRED'}`, a real ordering
  // bug in this module, not in the backend).
  async function createUser(
    role: 'maker' | 'checker' | 'merchant',
    merchantId?: number,
  ): Promise<ActorCredentials> {
    const email = uniqueEmail(role);
    // `created.email` is deliberately never read — see this file's header, "bug 2": `POST /users`
    // currently echoes the new user's email back as ciphertext, not plaintext. `email` (the local
    // const) is the same, already-known-good plaintext address this call just submitted.
    const created = await tenantAdminSession.post<{ email: string; temporaryPassword: string }>(
      '/users',
      { email, displayName: `E2E ${role} ${tag}`, role, ...(merchantId === undefined ? {} : { merchantId }) },
    );
    // The one real login this actor ever needs, for the whole run — see this file's header.
    return activateAndCapture(apiBaseURL, email, created.temporaryPassword);
  }

  const maker = await createUser('maker');
  const checker = await createUser('checker');

  const merchant = await tenantAdminSession.post<{ id: number; merchantCode: string; name: string }>(
    '/merchants',
    {
      merchantCode: `M${tag}`.slice(0, 50),
      name: `E2E Merchant ${tag}`,
      countryCode,
    },
  );
  const store = await tenantAdminSession.post<{ id: number; storeCode: string }>(
    `/merchants/${String(merchant.id)}/stores`,
    { storeCode: `S${tag}`.slice(0, 50), name: `E2E Store ${tag}` },
  );
  const merchantUser = await createUser('merchant', merchant.id);

  // No `POST /activities` exists anywhere in this API (`AddMerchantActivityModal.tsx`'s own
  // header: "there is no /activities catalogue endpoint anywhere in this codebase yet") — a real
  // deployment's corporate system already holds this data; this suite inserts the one row it
  // needs directly, exactly as `utils/db.ts`'s header explains.
  const db: DbConnectionInfo = context.db;
  const activityId = await createActivity(db, {
    tenantId: tenantResult.tenant.id,
    typeId: context.seedData.activityTypeId,
    activityCode: `${tag}_ACT`,
    name: `E2E activity ${tag}`,
  });
  await tenantAdminSession.post(`/merchants/${String(merchant.id)}/activities`, {
    activityId,
    storeId: store.id,
  });
  const tenantAdminCookies = await tenantAdminSession.cookiesForBrowser();
  await tenantAdminSession.dispose();
  const tenantAdmin: ActorCredentials = {
    email: tenantResult.admin.email,
    password: NEW_PASSWORD,
    cookies: tenantAdminCookies,
  };

  return {
    country: countryResult.country,
    countryAdmin,
    rule: { id: rule.id, ruleCode: rule.ruleCode, name: rule.name },
    reward: {
      id: reward.id,
      systemCode: reward.systemCode,
      policyId: policy.id,
      policyName: policy.name,
    },
    tenant: tenantResult.tenant,
    tenantAdmin,
    maker,
    checker,
    merchantUser,
    merchant,
    store,
    activityId,
  };
}
