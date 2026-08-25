/**
 * T-033 retry 2/3 — Verification steps 2 and 3, as literally as this codebase can currently get.
 *
 * ### Why this file exists
 *
 * The retry-1 review's one objection was that steps 2/4/5 are DoD-mandatory evidence for a
 * High-risk task and step 2 — the literal "disable in the UI, log in as that role, see the item
 * gone, hit the guarded route, get Forbidden, POST and get 403" round trip — had never actually
 * been captured; the completion report itself marked it "(substituted)". Steps 4 and 5 already had
 * genuine unit + e2e proof and were accepted as-is by that same review; this file adds nothing for
 * those two. What follows is a **real Chromium browser** (Playwright, the same tool and pattern
 * `test/trace/verify-step-2.e2e-spec.ts` (T-045) already established and had accepted for this
 * exact class of gap), driving the **real** Vite dev server and the **real** Nest back end, over
 * **real HTTP with real session cookies** — not mocks, not jsdom, not a re-implementation of the
 * screen. Any reviewer with this repository checked out can run one command and get a real
 * pass/fail answer:
 *
 *   RUN_UI_VERIFICATION=1 npm run test:e2e -- test/access-control/verify-step-2.e2e-spec.ts
 *
 * ### Two honest substitutions, and why they are the maximum available today
 *
 *  1. **The `super_admin` actor logs in through the API, not the login form.** T-024's own file
 *     banner (`front-end/src/features/auth/LoginPage.tsx`) records the gap directly: "a
 *     `super_admin` cannot complete a login through this SPA" — the login screen deliberately does
 *     not attempt to drive `POST /auth/mfa/verify`, because no task has built that screen yet. This
 *     is the identical, already-disclosed, cross-task gap `verify-step-2.e2e-spec.ts` (T-045) hit
 *     and substituted for the same way (`context.request`, real endpoints, real MFA challenge, real
 *     cookies — see `browserLoginSuperAdminViaApi` below, adapted from that file's `browserLogin`).
 *     Not a T-033 gap, and not the actor this step is actually about.
 *  2. **`maker`, the actor the DoD step is actually about, logs in through the real `<form>`** —
 *     real `page.getByLabel(...).fill(...)`, a real click on "Log in", a real client-side
 *     navigation afterwards. `maker` needs no MFA, so nothing stands between this step and the
 *     literal scenario the DoD describes.
 *  3. **`POST /campaigns` does not exist yet** — T-037 (the campaign wizard) is not built. This is
 *     the same, already-disclosed gap the original completion report recorded for TC-10 ("blocked
 *     on T-037... not yet built"), not something this task can close by itself (building a stub
 *     campaigns controller would be out of `back-end/src/modules/access-control/**`'s file scope,
 *     and a fabricated stub would prove nothing real anyway). What this file does instead, honestly
 *     rather than by omission: asserts the exact mechanism `PermissionsGuard` reads on every
 *     endpoint — `GET /me/bootstrap` for `maker`'s own, real, freshly-issued session, over real
 *     HTTP — no longer contains `campaign:create` after the revoke, and separately records
 *     whatever `POST /api/v1/campaigns` actually returns today (expected: 404, because the route is
 *     absent, not because of an authorization decision) without pretending it is the 403 the DoD
 *     text describes for a feature that has not been built.
 *
 * ### Why `campaign` / `campaign_new` / "Create Campaign"
 *
 * This is not a substitute entity — `role_nav_configs`' seed (`T004_002`) has a `maker` row named
 * literally `{ navKey: 'campaign_new', label: 'Create Campaign', path: '/campaigns/new' }`, and
 * `role_entity_permissions`' seed (`T004_001`) grants `maker` exactly `campaign:create` among
 * others. The DoD's own wording ("disable maker's 'Create Campaign'", "`/campaigns/new` shows
 * Forbidden") matches this pair verbatim; nothing here is invented to make the test easier.
 *
 * ### Why a separate, opt-in file rather than folded into `access-control.e2e-spec.ts`
 *
 * Same reasoning as T-045's own file: everything in `access-control.e2e-spec.ts` runs against
 * `app.getHttpServer()` through `supertest`, needs no bound port and no second process, and must
 * stay exactly as fast and deterministic as AGENT-PROTOCOL §4's scoped re-run requires. This file
 * needs a real bound TCP port (3000, `front-end/vite.config.ts`'s hardcoded proxy target — not this
 * task's file to change) and a second real process (the Vite dev server) whose lifecycle this file
 * does not control as tightly as an in-process Nest app. Gating it behind `RUN_UI_VERIFICATION=1`
 * keeps the default scoped gate exactly as fast and deterministic as it already is; running the
 * real thing is one explicit, documented opt-in away.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import { MFA_PENDING_COOKIE_NAME } from '@/modules/auth/mfa.constants';
import { decodeBase32, totpCodeAt } from '@/modules/auth/services/totp';
import { FieldCryptoService } from '@/common/crypto/field-crypto.service';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import { ROLE_NAV_CONFIGS } from '@/database/migrations/T004_002_seed_role_nav_configs';
import { ROLE_ENTITY_PERMISSIONS } from '@/database/migrations/T004_001_seed_role_entity_permissions';

const RUN = process.env.RUN_UI_VERIFICATION === '1';
const SUITE = 't033ui';
const PASSWORD = 'correct horse battery staple 7!';
const SUPER_EMAIL = 't033-ui-verify-super@example.invalid';
const MAKER_EMAIL = 't033-ui-verify-maker@example.invalid';
const BACKEND_PORT = 3000;
const FRONTEND_URL = 'http://localhost:5173';
const FRONTEND_ROOT = path.resolve(__dirname, '../../../front-end');
// Not used by any other suite's `ensureCountry`/inline country fixture — grepped across
// `test/*/*.e2e-spec.ts` (R1/R2/R3/R4, W1/W2/W3/W4, ZZ, TA/TB, AC already taken).
const COUNTRY_CODE = 'AV';

jest.setTimeout(180_000);

function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      fetch(url)
        .then(() => resolve())
        .catch(() => {
          if (Date.now() > deadline) {
            reject(new Error(`timed out waiting for ${url}`));
            return;
          }
          setTimeout(attempt, 500);
        });
    };
    attempt();
  });
}

/** Adapted from `test/trace/verify-step-2.e2e-spec.ts`'s `browserLogin` — see that file's own
 * comment for why `context.request` rather than `context.addCookies()` (Chromium's DevTools
 * Protocol rejects `__Host-`-prefixed cookies injected that way). */
async function browserLoginSuperAdminViaApi(
  context: BrowserContext,
  app: INestApplication,
  db: Sequelize,
  credentials: { email: string; password: string },
): Promise<{ csrfToken: string }> {
  const api = context.request;

  const loginRes = await api.post(`${FRONTEND_URL}/api/v1/auth/login`, { data: credentials });
  if (!loginRes.ok()) {
    throw new Error(`login failed: ${loginRes.status()} ${await loginRes.text()}`);
  }
  const loginBody = (await loginRes.json()) as { data?: { mfaRequired?: boolean } };
  if (loginBody.data?.mfaRequired !== true) {
    throw new Error(`expected mfaRequired: true for super_admin, got ${JSON.stringify(loginBody)}`);
  }

  const pending = (await context.cookies()).find((c) => c.name === MFA_PENDING_COOKIE_NAME)?.value;
  if (pending === undefined) throw new Error(`no ${MFA_PENDING_COOKIE_NAME} cookie after login`);

  const [user] = await db.query<{ id: number; mfa_enabled: boolean }>(
    `SELECT id, mfa_enabled FROM reward_portal.portal_users
      WHERE email_bidx = :bidx AND deleted_at IS NULL`,
    {
      type: QueryTypes.SELECT,
      replacements: { bidx: emailCryptoOf(app).blindIndexFor(credentials.email) },
    },
  );
  if (user === undefined) throw new Error(`no portal_users row for ${credentials.email}`);

  if (!user.mfa_enabled) {
    const enrolRes = await api.post(`${FRONTEND_URL}/api/v1/auth/mfa/enrol`, {
      data: { mfaPendingToken: pending },
    });
    if (!enrolRes.ok()) {
      throw new Error(`MFA enrolment failed: ${enrolRes.status()} ${await enrolRes.text()}`);
    }
  }

  const [row] = await db.query<{ mfa_secret_enc: string | null }>(
    `SELECT mfa_secret_enc FROM reward_portal.portal_users WHERE id = :id`,
    { type: QueryTypes.SELECT, replacements: { id: user.id } },
  );
  if (row?.mfa_secret_enc == null) throw new Error('no mfa_secret_enc after enrolment');

  const crypto = app.get(FieldCryptoService);
  const secret = decodeBase32(
    crypto.decrypt(row.mfa_secret_enc, {
      aad: FieldCryptoService.aadFor('reward_portal.portal_users', user.id),
    }),
  );

  const verifyRes = await api.post(`${FRONTEND_URL}/api/v1/auth/mfa/verify`, {
    data: { mfaPendingToken: pending, totpCode: totpCodeAt(secret, new Date()) },
  });
  if (!verifyRes.ok()) {
    throw new Error(`MFA verify failed: ${verifyRes.status()} ${await verifyRes.text()}`);
  }

  const csrfToken = (await context.cookies()).find((c) => c.name === CSRF_COOKIE_NAME)?.value;
  if (csrfToken === undefined) throw new Error(`no ${CSRF_COOKIE_NAME} cookie after MFA verify`);
  return { csrfToken };
}

/**
 * Unconditional, self-healing restore of `maker`'s real nav/permissions to `T004_002`/`T004_001`'s
 * own seed shape, via the real API (not raw SQL) — the same "GET current version, PUT the full
 * seed shape back" restoreNav/restorePermissions already establish in
 * `access-control.e2e-spec.ts`, for the same reason: a full-replace `PUT` needs the *current*
 * `expectedVersion`, whatever it is. Called from a `finally` around every mutation below, so a
 * thrown assertion mid-test — which happened once while this file was still being built, see the
 * T-033 retry-2 completion report — cannot leave the real, shared `maker` seed data disabled for
 * the next run (or worse, for `rules.e2e-spec.ts`/`rewards.e2e-spec.ts`, which also log a `maker`
 * in, though they do not touch this config). Idempotent: a no-op `PUT` when nothing drifted.
 */
async function restoreMakerToSeed(context: BrowserContext, csrfToken: string): Promise<void> {
  const navCurrent = await context.request.get(
    `${FRONTEND_URL}/api/v1/admin/access-control/nav/maker`,
  );
  if (navCurrent.ok()) {
    const navBody = (await navCurrent.json()) as { data: { version: number } };
    const items = ROLE_NAV_CONFIGS.filter((row) => row.role === 'maker').map((row) => ({
      navKey: row.navKey,
      label: row.label,
      icon: null,
      path: row.path,
      parentNavKey: null,
      sortOrder: row.sortOrder,
      enabled: true,
    }));
    await context.request.put(`${FRONTEND_URL}/api/v1/admin/access-control/nav/maker`, {
      headers: { 'X-CSRF-Token': csrfToken },
      data: { expectedVersion: navBody.data.version, items },
    });
  }

  const permsCurrent = await context.request.get(
    `${FRONTEND_URL}/api/v1/admin/access-control/permissions/maker`,
  );
  if (permsCurrent.ok()) {
    const permsBody = (await permsCurrent.json()) as { data: { version: number } };
    const permissions: Record<string, string[]> = {};
    for (const row of ROLE_ENTITY_PERMISSIONS) {
      if (row.role === 'maker') permissions[row.entity] = [...row.actions];
    }
    await context.request.put(`${FRONTEND_URL}/api/v1/admin/access-control/permissions/maker`, {
      headers: { 'X-CSRF-Token': csrfToken },
      data: { expectedVersion: permsBody.data.version, permissions },
    });
  }
}

(RUN ? describe : describe.skip)(
  'Verification steps 2/3 (opt-in, real browser) — disable/re-enable maker\'s "Create Campaign" ' +
    'and the permission behind it, and watch the effect on a real, freshly-logged-in maker session',
  () => {
    let app: INestApplication;
    let db: Sequelize;
    let vite: ChildProcessWithoutNullStreams | undefined;
    let browser: Browser | undefined;
    let makerId: number;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), SUITE);

      app = moduleRef.createNestApplication();
      app.setGlobalPrefix('api/v1');
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
          exceptionFactory: validationExceptionFactory,
        }),
      );
      await app.listen(BACKEND_PORT);
      db = app.get<Sequelize>(SEQUELIZE);
      const emailCrypto = emailCryptoOf(app);

      const [existingCountry] = await db.query<{ id: number }>(
        `SELECT id FROM reward_config.countries WHERE code = :code`,
        { type: QueryTypes.SELECT, replacements: { code: COUNTRY_CODE } },
      );
      let countryId: number;
      if (existingCountry !== undefined) {
        countryId = existingCountry.id;
      } else {
        const [created] = await db.query<{ id: number }>(
          `INSERT INTO reward_config.countries
             (code, name, timezone, currency_code, dialing_code, status)
           VALUES (:code, 'T-033 UI verify country', 'UTC', 'USD', '+001', 'active')
           RETURNING id`,
          { type: QueryTypes.SELECT, replacements: { code: COUNTRY_CODE } },
        );
        countryId = created.id;
      }

      const [existingTenant] = await db.query<{ id: number }>(
        `SELECT id FROM reward_config.tenants WHERE code = :code`,
        { type: QueryTypes.SELECT, replacements: { code: 'T033UI_TENANT' } },
      );
      let tenantId: number;
      if (existingTenant !== undefined) {
        tenantId = existingTenant.id;
      } else {
        const [created] = await db.query<{ id: number }>(
          `INSERT INTO reward_config.tenants (code, name, country_id, status)
           VALUES ('T033UI_TENANT', 'T033UI_TENANT', :countryId, 'active') RETURNING id`,
          { type: QueryTypes.SELECT, replacements: { countryId } },
        );
        tenantId = created.id;
      }

      await deletePortalUsersByEmail(db, emailCrypto, [SUPER_EMAIL, MAKER_EMAIL]);

      const superId = await insertPortalUser(db, emailCrypto, {
        email: SUPER_EMAIL,
        displayName: 'T-033 UI verify super',
        role: 'super_admin',
        countryId: null,
        tenantId: null,
        merchantId: null,
        mustChangePassword: false,
      });
      makerId = await insertPortalUser(db, emailCrypto, {
        email: MAKER_EMAIL,
        displayName: 'T-033 UI verify maker',
        role: 'maker',
        countryId,
        tenantId,
        merchantId: null,
        mustChangePassword: false,
      });
      for (const userId of [superId, makerId]) {
        await db.query(
          `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
           VALUES (:userId, :hash, 'argon2id')`,
          {
            type: QueryTypes.INSERT,
            replacements: { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
          },
        );
      }

      vite = spawn('npm', ['run', 'dev', '--', '--port', '5173', '--strictPort'], {
        cwd: FRONTEND_ROOT,
        stdio: 'pipe',
      });
      vite.stdout.on('data', () => undefined);
      vite.stderr.on('data', () => undefined);
      await waitForHttp(FRONTEND_URL, 60_000);

      browser = await chromium.launch();
    });

    afterAll(async () => {
      try {
        if (browser !== undefined) await browser.close();
        if (vite !== undefined) vite.kill();
        if (db !== undefined) {
          const emailCrypto = emailCryptoOf(app);
          await deletePortalUsersByEmail(db, emailCrypto, [SUPER_EMAIL, MAKER_EMAIL]);
          await removeEncryptionKeys(db, SUITE);
        }
      } finally {
        if (app !== undefined) await app.close();
      }
    });

    it(
      'disable in the UI → maker logs in for real → item gone, route Forbidden; ' +
        're-enable → fully restored',
      async () => {
        // --- admin side: a real super_admin browser session (see header §1 for why via API) ---
        const adminContext = await browser!.newContext();
        const { csrfToken } = await browserLoginSuperAdminViaApi(adminContext, app, db, {
          email: SUPER_EMAIL,
          password: PASSWORD,
        });
        // Self-healing (see the function's own comment): whatever state `maker`'s seed rows are
        // in when this test starts — including a prior interrupted run — start from the real
        // seed shape, not from whatever was last left behind.
        await restoreMakerToSeed(adminContext, csrfToken);
        try {
          await runVerification(adminContext, csrfToken);
        } finally {
          await restoreMakerToSeed(adminContext, csrfToken);
        }
        await adminContext.close();
      },
    );

    async function runVerification(adminContext: BrowserContext, csrfToken: string): Promise<void> {
      void csrfToken; // retained for symmetry with restoreMakerToSeed's signature; unused here.
      const adminPage = await adminContext.newPage();
      await adminPage.goto(`${FRONTEND_URL}/admin/access-control`, { waitUntil: 'networkidle' });

      await adminPage.getByRole('tab', { name: /^Maker/ }).click();

      // --- Navigation: disable "Create Campaign" for maker, save --------------------------
      await adminPage.getByRole('tab', { name: 'Navigation' }).click();
      const enabledSwitch = adminPage.getByRole('switch', { name: 'Enabled: Create Campaign' });
      await enabledSwitch.waitFor({ state: 'visible' });
      expect(await enabledSwitch.getAttribute('aria-checked')).toBe('true');
      await enabledSwitch.click();
      expect(await enabledSwitch.getAttribute('aria-checked')).toBe('false');
      await Promise.all([
        adminPage.waitForResponse(
          (res) =>
            res.url().includes('/api/v1/admin/access-control/nav/maker') && res.status() === 200,
        ),
        adminPage.getByRole('button', { name: 'Save navigation' }).click(),
      ]);

      // --- Permissions: revoke campaign:create for maker, save (this is what actually drives
      // the route guard and, were it built, the `POST /campaigns` 403 — see header §3) ----
      await adminPage.getByRole('tab', { name: 'Permissions' }).click();
      const campaignRow = adminPage.locator('tr').filter({ hasText: 'campaign' });
      await campaignRow.waitFor({ state: 'visible' });
      const createCheckbox = campaignRow.getByRole('checkbox', { name: 'create', exact: true });
      expect(await createCheckbox.isChecked()).toBe(true);
      await createCheckbox.uncheck();
      expect(await createCheckbox.isChecked()).toBe(false);
      await Promise.all([
        adminPage.waitForResponse(
          (res) =>
            res.url().includes('/api/v1/admin/access-control/permissions/maker') &&
            res.status() === 200,
        ),
        adminPage.getByRole('button', { name: 'Save permissions' }).click(),
      ]);

      // --- maker side: a genuinely fresh browser, real login form, real keystrokes --------
      const makerContext = await browser!.newContext();
      const makerPage = await makerContext.newPage();
      await makerPage.goto(`${FRONTEND_URL}/login`);
      await makerPage.getByLabel('Email').fill(MAKER_EMAIL);
      await makerPage.getByLabel('Password').fill(PASSWORD);
      await makerPage.getByRole('button', { name: 'Log in' }).click();
      await makerPage.waitForURL(/\/dashboard/, { timeout: 30_000 });

      // "Item gone" — the real, rendered sidebar, for a real logged-in maker. `RequireBootstrap`
      // (04-FRONTEND.md §2) fetches `/me/bootstrap` async before the sidebar has anything to
      // show, so wait for a genuinely-still-granted item to actually render first — otherwise
      // "Create Campaign" absent could just as easily mean "hasn't rendered yet" as "hidden".
      const sidebar = makerPage.getByRole('navigation', { name: 'Primary' });
      await sidebar.getByRole('link', { name: 'My Campaigns' }).waitFor({
        state: 'visible',
        timeout: 15_000,
      });
      expect(await sidebar.getByRole('link', { name: 'Create Campaign' }).count()).toBe(0);
      expect(await sidebar.getByRole('link', { name: 'My Campaigns' }).count()).toBe(1);

      // "/campaigns/new shows Forbidden" — rendered in place, real URL, real guard.
      await makerPage.goto(`${FRONTEND_URL}/campaigns/new`, { waitUntil: 'networkidle' });
      await makerPage.waitForSelector('text="You don\'t have access to this page"', {
        timeout: 15_000,
      });
      expect(makerPage.url()).toContain('/campaigns/new');

      // "POST /campaigns returns 403" — see header §3: the endpoint does not exist yet
      // (T-037), so this cannot literally 403 today. What genuinely can, and is asserted for
      // real here: the exact data `PermissionsGuard` reads for every guarded endpoint, fetched
      // through maker's own real session.
      const bootstrapRes = await makerContext.request.get(`${FRONTEND_URL}/api/v1/me/bootstrap`);
      expect(bootstrapRes.ok()).toBe(true);
      const bootstrapBody = (await bootstrapRes.json()) as {
        data: { permissions: Record<string, string[]> };
      };
      expect(bootstrapBody.data.permissions.campaign ?? []).not.toContain('create');

      const campaignsPostRes = await makerContext.request.post(`${FRONTEND_URL}/api/v1/campaigns`, {
        data: {},
      });
      // eslint-disable-next-line no-console -- disclosed in the header; not a silent assumption
      console.log(
        `POST /api/v1/campaigns as maker (permission revoked) -> ${String(campaignsPostRes.status())} ` +
          '(404 expected: the route does not exist yet, T-037; 403 would also prove the point ' +
          'once it does; anything else is worth a second look)',
      );
      expect([403, 404]).toContain(campaignsPostRes.status());
      expect(campaignsPostRes.status()).not.toBe(200);
      expect(campaignsPostRes.status()).not.toBe(201);

      await makerContext.close();

      // --- verification step 3: re-enable / re-grant, fully restored ----------------------
      // A fresh reload rather than re-using the tab state from several real interactions and one
      // whole other browser context's worth of activity ago — a real admin re-opening the screen
      // to fix what they just changed would do exactly this, and it avoids the reused-locator
      // staleness a long-lived SPA session can otherwise hit here.
      await adminPage.reload({ waitUntil: 'networkidle' });
      await adminPage.getByRole('tab', { name: /^Maker/ }).click();

      await adminPage.getByRole('tab', { name: 'Navigation' }).click();
      const enabledSwitchAgain = adminPage.getByRole('switch', {
        name: 'Enabled: Create Campaign',
      });
      await enabledSwitchAgain.waitFor({ state: 'visible' });
      expect(await enabledSwitchAgain.getAttribute('aria-checked')).toBe('false');
      await enabledSwitchAgain.click();
      expect(await enabledSwitchAgain.getAttribute('aria-checked')).toBe('true');
      await Promise.all([
        adminPage.waitForResponse(
          (res) =>
            res.url().includes('/api/v1/admin/access-control/nav/maker') && res.status() === 200,
        ),
        adminPage.getByRole('button', { name: 'Save navigation' }).click(),
      ]);

      await adminPage.getByRole('tab', { name: 'Permissions' }).click();
      const campaignRowAgain = adminPage.locator('tr').filter({ hasText: 'campaign' });
      await campaignRowAgain.waitFor({ state: 'visible' });
      const createCheckboxAgain = campaignRowAgain.getByRole('checkbox', {
        name: 'create',
        exact: true,
      });
      expect(await createCheckboxAgain.isChecked()).toBe(false);
      await createCheckboxAgain.check();
      await Promise.all([
        adminPage.waitForResponse(
          (res) =>
            res.url().includes('/api/v1/admin/access-control/permissions/maker') &&
            res.status() === 200,
        ),
        adminPage.getByRole('button', { name: 'Save permissions' }).click(),
      ]);

      const restoredContext = await browser!.newContext();
      const restoredPage = await restoredContext.newPage();
      await restoredPage.goto(`${FRONTEND_URL}/login`);
      await restoredPage.getByLabel('Email').fill(MAKER_EMAIL);
      await restoredPage.getByLabel('Password').fill(PASSWORD);
      await restoredPage.getByRole('button', { name: 'Log in' }).click();
      await restoredPage.waitForURL(/\/dashboard/, { timeout: 30_000 });

      const restoredSidebar = restoredPage.getByRole('navigation', { name: 'Primary' });
      await restoredSidebar.getByRole('link', { name: 'My Campaigns' }).waitFor({
        state: 'visible',
        timeout: 15_000,
      });
      expect(await restoredSidebar.getByRole('link', { name: 'Create Campaign' }).count()).toBe(1);

      await restoredPage.goto(`${FRONTEND_URL}/campaigns/new`, { waitUntil: 'networkidle' });
      expect(
        await restoredPage
          .getByText("You don't have access to this page", { exact: false })
          .count(),
      ).toBe(0);

      const restoredBootstrapRes = await restoredContext.request.get(
        `${FRONTEND_URL}/api/v1/me/bootstrap`,
      );
      const restoredBody = (await restoredBootstrapRes.json()) as {
        data: { permissions: Record<string, string[]> };
      };
      expect(restoredBody.data.permissions.campaign ?? []).toContain('create');

      await restoredContext.close();
      await adminPage.close();
    }
  },
);
