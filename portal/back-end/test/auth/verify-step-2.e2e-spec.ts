/**
 * T-058 — verification steps 2, 3 and 4, and TC-3/TC-4/TC-5, in a **real Chromium browser**.
 *
 * ### Why this file exists
 *
 * T-058's Definition of Done is unusually specific: *"Verification step 2 must use a real
 * browser — the entire defect is invisible to any client that does not enforce cookie prefixes,
 * and that is the lesson this task exists to encode."* The first submission of this task proved
 * the fix at the header level (supertest + the real Nest app + real Postgres) and then handed
 * TC-3/TC-4 to T-050, which is `blocked`. The review failed it for exactly that: a header-level
 * proof of a *browser-level* claim is the same category error that let the original defect ship.
 * `curl` and `supertest` store and replay whatever `Set-Cookie` says; only a browser implements
 * RFC 6265bis §4.1.3. So this file runs a browser.
 *
 * It needs no fixture from T-050 and edits none of its files (R9): the harness is the one T-033
 * (`test/access-control/verify-step-2.e2e-spec.ts`), T-045 (`test/trace/verify-step-2.e2e-spec.ts`)
 * and T-049 (`test/campaign-agent/verify-ui.e2e-spec.ts`) already established on this project for
 * precisely this class of evidence — real Chromium, real Vite dev server, real Nest app, real
 * Postgres, real session cookies — and the same opt-in gate, for the same reason (two extra
 * processes and a browser are strictly more host-load flakiness than the deterministic suites, so
 * the default `npm run test:e2e -- auth` sees this file and *visibly skips* it):
 *
 *   RUN_UI_VERIFICATION=1 npm run test:e2e -- test/auth/verify-step-2.e2e-spec.ts
 *
 * ### The control experiment is the load-bearing part
 *
 * A green "the cookie is in the jar" assertion proves nothing on its own — it would also be green
 * on a browser that ignored cookie prefixes entirely, which is exactly the false negative that
 * made this defect survive review the first time. So `TC-3 control` below emits **two** cookies
 * from a real `Set-Cookie` header, built by the real {@link buildSetCookie}, differing in nothing
 * but `Path`: one at `/` and one at `/api/v1/auth` (the historical, defective value). It asserts
 * the first is stored and the second is **not**. That is a direct, in-browser reproduction of the
 * defect (TC-1) and, at the same time, the proof that this harness is capable of failing — which
 * is what makes the other assertions in this file mean something.
 *
 * ### One honest substitution, disclosed rather than glossed
 *
 * TC-4 says "let the access token expire". `ACCESS_TOKEN_TTL_SECONDS` is a compile-time constant
 * (15 minutes) with no environment override, and Playwright cannot fast-forward Chromium's cookie
 * store, so this file reproduces expiry by **deleting the access cookie from the jar** —
 * `context.clearCookies({ name })`. That is not an approximation of what a browser does at
 * `Max-Age`; it is *literally* what a browser does at `Max-Age`: the cookie is evicted from the
 * store and stops being sent. The access cookie's `Max-Age` and the JWT's `exp` are both
 * `ACCESS_TOKEN_TTL_SECONDS`, so the two die in the same second in production, and the server sees
 * the same thing either way — a request with no usable access token, answered 401.
 *
 * What matters for this task is untouched and unfaked: the refresh cookie in the jar is one the
 * *browser itself* stored from a real `Set-Cookie` at login, and the refresh that follows is a
 * real request carrying it. Only the access cookie — the one whose absence is being simulated —
 * is manipulated, and only by removal, never by injection.
 */
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { chromium, type Browser, type Cookie, type Page } from 'playwright';
import * as argon2 from 'argon2';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import { buildSetCookie } from '@/modules/auth/auth.cookies';
import {
  ACCESS_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  ROOT_COOKIE_PATH,
} from '@/modules/auth/session.constants';
import { CSRF_HEADER_NAME } from '@/common/security/security.constants';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from './support/portal-user-fixture';

const RUN = process.env.RUN_UI_VERIFICATION === '1';
const SUITE = 't058ui';
const EMAIL = 't058-ui-verify@example.invalid';
/** The SPA-independent leg's own account — see `createMaker`'s call site for why it is separate. */
const API_EMAIL = 't058-api-verify@example.invalid';
const PASSWORD = 'correct horse battery staple 9!';
const DISPLAY_NAME = 'T-058 UI verify';
const BACKEND_PORT = 3000; // front-end/vite.config.ts's dev proxy target is hard-coded to this.
const API_BASE_URL = `http://localhost:${String(BACKEND_PORT)}/api/v1`;
const FRONTEND_URL = 'http://localhost:5173';
const FRONTEND_ROOT = path.resolve(__dirname, '../../../front-end');

/** The prefix-oracle server (TC-3 control). Same host as the SPA — cookies ignore ports. */
const ORACLE_PORT = 21_058;
const ORACLE_URL = `http://localhost:${String(ORACLE_PORT)}`;

/**
 * The value `REFRESH_COOKIE_PATH` held before this task, quoted from the task file's own Evidence
 * block. Deliberately a local constant and not an import: nothing in `src/**` may name this string
 * as a cookie path any more (TC-8), and a test that re-imported it would be asserting against
 * whatever the code currently says rather than against the historical defect.
 */
const HISTORICAL_REFRESH_COOKIE_PATH = '/api/v1/auth';

const PROBE_ROOT = '__Host-t058_probe_root';
const PROBE_NARROW = '__Host-t058_probe_narrow';

jest.setTimeout(240_000);

function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      fetch(url)
        .then(() => {
          resolve();
        })
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

/**
 * Serves one response carrying two `__Host-` cookies that differ **only** in `Path`.
 *
 * Both headers come out of the application's own {@link buildSetCookie}, so this is not a
 * hand-written approximation of what the server emits — it is the same function, with the same
 * `Secure; SameSite=Strict; HttpOnly` attributes and the same no-`Domain` rule, called twice.
 */
function startPrefixOracle(): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/plain',
      'set-cookie': [
        buildSetCookie(
          { name: PROBE_ROOT, path: ROOT_COOKIE_PATH, httpOnly: true, maxAgeSeconds: 600 },
          'probe',
        ),
        buildSetCookie(
          {
            name: PROBE_NARROW,
            path: HISTORICAL_REFRESH_COOKIE_PATH,
            httpOnly: true,
            maxAgeSeconds: 600,
          },
          'probe',
        ),
      ],
    });
    response.end('ok');
  });
  return new Promise((resolve) => {
    server.listen(ORACLE_PORT, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

/** Logs the fixture maker in through the **real login form**. No MFA stands in this role's way. */
async function loginThroughTheUi(page: Page): Promise<void> {
  // The login form is `front-end/src/features/auth/**` — another task's files, and one that was
  // being edited by another agent (T-060, `in_progress`) while this suite ran. If the SPA fails to
  // compile mid-edit the symptom here is a bare "element not found" thirty seconds later, which
  // reads like a T-058 failure and is not one. Capture what the browser actually said instead.
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`${FRONTEND_URL}/login`);

  try {
    await page.getByLabel('Email').waitFor({ timeout: 20_000 });
  } catch (error) {
    const body = ((await page.locator('body').textContent()) ?? '').trim().slice(0, 300);
    throw new Error(
      `The login form never rendered at ${page.url()} — this is the SPA failing to load, not the ` +
        `cookie under test. Body text: "${body}". Browser errors: ` +
        `${pageErrors.join(' | ') || '(none)'}. Original error: ${String(error)}`,
    );
  }

  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
}

/**
 * Every link in the primary nav, as `href (label)`.
 *
 * Read through Playwright's own locator API rather than `evaluateAll` because the back end's
 * `tsconfig` has no `DOM` lib — the same constraint T-049's browser spec records.
 */
async function navHrefs(page: Page): Promise<string[]> {
  const links = page.locator('nav[aria-label="Primary"] a');
  const total = await links.count();
  const described: string[] = [];
  for (let index = 0; index < total; index += 1) {
    const link = links.nth(index);
    const href = (await link.getAttribute('href')) ?? '?';
    const label = ((await link.textContent()) ?? '').trim();
    described.push(`${href} (${label})`);
  }
  return described;
}

function cookieNamed(jar: readonly Cookie[], name: string): Cookie | undefined {
  return jar.find((cookie) => cookie.name === name);
}

/** Renders the jar the way DevTools → Application → Cookies would, for the completion report. */
function describeJar(label: string, jar: readonly Cookie[]): void {
  const rows = jar
    .map(
      (cookie) =>
        `    ${cookie.name}  domain=${cookie.domain}  path=${cookie.path}  ` +
        `secure=${String(cookie.secure)}  httpOnly=${String(cookie.httpOnly)}  ` +
        `sameSite=${String(cookie.sameSite)}`,
    )
    .join('\n');
  console.warn(
    `[T-058] ${label} — ${String(jar.length)} cookie(s) in the real browser jar:\n${rows}`,
  );
}

(RUN ? describe : describe.skip)(
  'T-058 verification steps 2, 3 and 4 (opt-in, real browser)',
  () => {
    let app: INestApplication;
    let db: Sequelize;
    let vite: ChildProcessWithoutNullStreams | undefined;
    let oracle: Server | undefined;
    let browser: Browser | undefined;
    let userId: number | undefined;
    let apiUserId: number | undefined;

    /** Creates a fixture maker and its credential. Returns the new `portal_users.id`. */
    async function createMaker(
      email: string,
      displayName: string,
      tenant: { id: number; country_id: number },
    ): Promise<number> {
      await deletePortalUsersByEmail(db, emailCryptoOf(app), [email]);
      const id = await insertPortalUser(db, emailCryptoOf(app), {
        email,
        displayName,
        role: 'maker',
        countryId: tenant.country_id,
        tenantId: tenant.id,
        merchantId: null,
        mustChangePassword: false,
      });
      await db.query(
        `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
         VALUES (:userId, :hash, 'argon2id')`,
        {
          type: QueryTypes.INSERT,
          replacements: { userId: id, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
        },
      );
      return id;
    }

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

      const [tenant] = await db.query<{ id: number; country_id: number }>(
        `SELECT id, country_id FROM reward_config.tenants WHERE status = 'active' ORDER BY id LIMIT 1`,
        { type: QueryTypes.SELECT },
      );
      if (tenant === undefined) throw new Error('no active tenant — cannot place a maker');

      // Two accounts, deliberately: `LOGIN_PER_EMAIL_IP_LIMIT` is 5 per fifteen minutes per
      // email+IP (T-012), and this file logs in four times through the SPA plus once through the
      // API. Splitting them across two emails keeps both counters comfortably under the limit
      // without touching the limit itself — never weaken a control to make a suite fit (§7).
      userId = await createMaker(EMAIL, DISPLAY_NAME, tenant);
      apiUserId = await createMaker(API_EMAIL, `${DISPLAY_NAME} (API)`, tenant);

      vite = spawn('npm', ['run', 'dev', '--', '--port', '5173', '--strictPort'], {
        cwd: FRONTEND_ROOT,
        stdio: 'pipe',
      });
      vite.stdout.on('data', () => undefined);
      vite.stderr.on('data', () => undefined);
      await waitForHttp(FRONTEND_URL, 90_000);

      oracle = await startPrefixOracle();
      browser = await chromium.launch();
    });

    afterAll(async () => {
      if (browser !== undefined) await browser.close();
      if (oracle !== undefined) await new Promise((resolve) => oracle?.close(resolve));
      if (vite !== undefined) vite.kill();

      for (const id of [userId, apiUserId]) {
        if (id === undefined) continue;
        await db.query(
          `DELETE FROM reward_portal.portal_user_credentials WHERE user_id = :userId`,
          { type: QueryTypes.RAW, replacements: { userId: id } },
        );
      }
      await deletePortalUsersByEmail(db, emailCryptoOf(app), [EMAIL, API_EMAIL]);

      // Same hygiene every e2e suite here documents: a leftover key row fail-closes the next
      // app boot — and `db:rollback` — at `KeyRegistryService.onModuleInit`.
      await removeEncryptionKeys(db, SUITE);
      await app.close();
    });

    /**
     * TC-3 control / TC-1 reproduced in a browser.
     *
     * Runs first on purpose: if this fails, every other assertion in this file is untrustworthy,
     * because it would mean Chromium is not enforcing prefix rules here at all.
     */
    it('TC-3 control — Chromium stores a __Host- cookie at Path=/ and rejects the same cookie at /api/v1/auth', async () => {
      const context = await (browser as Browser).newContext();
      const page = await context.newPage();
      await page.goto(`${ORACLE_URL}/`);

      const jar = await context.cookies();
      describeJar('prefix oracle', jar);
      const names = jar.map((cookie) => cookie.name);

      // The harness can see a `__Host-` cookie at all…
      expect(names).toContain(PROBE_ROOT);
      // …and it drops the identical cookie whose only difference is the historical narrow path.
      expect(names).not.toContain(PROBE_NARROW);

      const stored = cookieNamed(jar, PROBE_ROOT);
      expect(stored?.path).toBe('/');
      expect(stored?.secure).toBe(true);

      await context.close();
    });

    /**
     * TC-3 / TC-4 / TC-5 again, through the browser's cookie jar but **without the SPA**.
     *
     * ### Why this exists
     *
     * The four tests below it drive the real React app, which is the right way to evidence
     * "verification step 2 in a real browser". Mid-verification they all stopped being runnable
     * for a reason with nothing to do with cookies: `packages/shared/package.json` was repointed
     * from `./src/index.ts` to a CommonJS-only `./dist/index.js` (T-057 D-1, `agent-qa`, landing
     * while this suite ran), and Vite serves that file to the browser as-is for a linked workspace
     * package — so the SPA died at load with *"does not provide an export named
     * 'traceResponseSchema'"* and rendered nothing at all. T-057 has since shipped the dual
     * CJS+ESM build that fixes it, and every test in this file is green again; the episode is
     * recorded here because it is exactly why this test earns its place.
     *
     * A verification that can only be performed while a *different*, unrelated package happens to
     * be mid-refactor is not much of a verification. This test proves the same three cookie claims
     * through a path the SPA cannot break: `context.request`, which Playwright documents as
     * sharing cookie storage with the browser context. **Its first assertion is that this path
     * enforces cookie prefixes too** — without that guard the whole test could pass vacuously on a
     * client that ignores them, which is the exact failure mode that let the original defect ship.
     * It is a supplement to the SPA-driven tests, never a substitute: only those exercise
     * `lib/apiClient`'s single-flight refresh and the real logout control.
     */
    it('TC-3/4/5 (SPA-independent) — the browser jar stores, sends, rotates and clears __Host-rs_rt', async () => {
      const context = await (browser as Browser).newContext();

      // Guard: this request path enforces prefix rules, so nothing below can pass vacuously.
      await context.request.get(`${ORACLE_URL}/`);
      const probes = (await context.cookies()).map((cookie) => cookie.name);
      expect(probes).toContain(PROBE_ROOT);
      expect(probes).not.toContain(PROBE_NARROW);
      await context.clearCookies({ name: PROBE_ROOT });

      // TC-3 — a real login, cookies stored by the browser's own jar.
      const login = await context.request.post(`${API_BASE_URL}/auth/login`, {
        data: { email: API_EMAIL, password: PASSWORD },
      });
      expect(login.status()).toBe(200);

      const afterLogin = await context.cookies();
      describeJar('SPA-independent: after login', afterLogin);
      const refreshBefore = cookieNamed(afterLogin, REFRESH_COOKIE_NAME);
      expect(refreshBefore).toBeDefined();
      expect(refreshBefore?.path).toBe('/');
      expect(refreshBefore?.secure).toBe(true);
      expect(refreshBefore?.httpOnly).toBe(true);
      expect(refreshBefore?.domain).toBe('localhost');

      const csrf = cookieNamed(afterLogin, CSRF_COOKIE_NAME)?.value ?? '';
      expect(csrf).not.toBe('');

      // TC-4 — the access token is gone; an authenticated call fails, the refresh succeeds using
      // the cookie the browser is holding, and the same call then succeeds.
      await context.clearCookies({ name: ACCESS_COOKIE_NAME });
      expect((await context.request.get(`${API_BASE_URL}/me/bootstrap`)).status()).toBe(401);

      const refreshed = await context.request.post(`${API_BASE_URL}/auth/refresh`, {
        headers: { [CSRF_HEADER_NAME]: csrf },
      });
      expect(refreshed.status()).toBe(200);
      expect((await context.request.get(`${API_BASE_URL}/me/bootstrap`)).status()).toBe(200);

      const afterRefresh = await context.cookies();
      describeJar('SPA-independent: after refresh', afterRefresh);
      const refreshAfter = cookieNamed(afterRefresh, REFRESH_COOKIE_NAME);
      expect(refreshAfter).toBeDefined();
      expect(refreshAfter?.path).toBe('/');
      // Single-use rotation actually happened (T-011); an unchanged value would mean it did not.
      expect(refreshAfter?.value).not.toBe(refreshBefore?.value);

      // TC-5 — logout clears it from the jar, not merely "a Max-Age=0 header was sent".
      const rotatedCsrf = cookieNamed(afterRefresh, CSRF_COOKIE_NAME)?.value ?? '';
      const loggedOut = await context.request.post(`${API_BASE_URL}/auth/logout`, {
        headers: { [CSRF_HEADER_NAME]: rotatedCsrf },
      });
      expect(loggedOut.status()).toBe(204);

      const afterLogout = await context.cookies();
      describeJar('SPA-independent: after logout', afterLogout);
      expect(cookieNamed(afterLogout, REFRESH_COOKIE_NAME)).toBeUndefined();
      expect(cookieNamed(afterLogout, ACCESS_COOKIE_NAME)).toBeUndefined();

      await context.close();
    });

    /**
     * The blocker T-058 exists to clear, checked directly — and a contradiction between two files'
     * headers, settled.
     *
     * `e2e/fixtures/superAdminSession.ts` (T-050, `blocked`) records that
     * `context.addCookies()` throws *"Protocol error (Storage.setCookies): Invalid cookie fields"*
     * on `__Host-rs_rt` while accepting `__Host-rs_at` and `rs_csrf`, and correctly diagnoses the
     * narrow `Path` as the cause. `test/trace/verify-step-2.e2e-spec.ts` (T-045) concluded from its
     * own earlier experiment that CDP rejects **any** `__Host-` cookie regardless of attributes.
     * Both cannot be right, and which one is right decides whether T-058 actually unblocks T-050.
     * The experiment below is the same cookie twice, differing only in `Path`: T-050's account is
     * the correct one, and the fix therefore removes T-050's blocker rather than merely being
     * adjacent to it.
     *
     * Nothing in `e2e/**` is edited to establish this (R9) — it is asserted here, in this task's
     * own file scope, and reported for T-050's owner to act on.
     */
    it('TC-3 addendum — addCookies now accepts __Host-rs_rt at Path=/, and still refuses it at /api/v1/auth', async () => {
      const context = await (browser as Browser).newContext();
      const shape = {
        name: REFRESH_COOKIE_NAME,
        value: 'probe',
        domain: 'localhost',
        httpOnly: true,
        secure: true,
        sameSite: 'Strict' as const,
      };

      await context.addCookies([{ ...shape, path: ROOT_COOKIE_PATH }]);
      expect(cookieNamed(await context.cookies(), REFRESH_COOKIE_NAME)).toBeDefined();

      await expect(
        context.addCookies([{ ...shape, path: HISTORICAL_REFRESH_COOKIE_PATH }]),
      ).rejects.toThrow(/Invalid cookie fields/i);

      await context.close();
    });

    /** TC-3 / verification step 2 — the assertion that fails before this task's fix. */
    it('TC-3 / step 2 — after a real login, __Host-rs_rt is present in the browser cookie jar', async () => {
      const context = await (browser as Browser).newContext();
      const page = await context.newPage();
      await loginThroughTheUi(page);

      const jar = await context.cookies();
      describeJar('after login', jar);

      const refresh = cookieNamed(jar, REFRESH_COOKIE_NAME);
      expect(refresh).toBeDefined();
      expect(refresh?.value.length ?? 0).toBeGreaterThan(0);

      // TC-2's attribute set, as the browser actually recorded it — not as the header claimed it.
      expect(refresh?.path).toBe('/');
      expect(refresh?.secure).toBe(true);
      expect(refresh?.httpOnly).toBe(true);
      expect(refresh?.sameSite).toBe('Strict');
      // Host-only. A cookie carrying a `Domain` attribute is reported with a leading dot, and a
      // `__Host-` cookie with a `Domain` is rejected outright — so this asserts both halves.
      expect(refresh?.domain).toBe('localhost');

      // The other two cookies a login issues, so a regression that dropped one is visible here.
      expect(cookieNamed(jar, ACCESS_COOKIE_NAME)).toBeDefined();
      expect(cookieNamed(jar, CSRF_COOKIE_NAME)).toBeDefined();

      await context.close();
    });

    /**
     * TC-4 / verification step 3 — the consequence the defect actually had for users.
     *
     * See this file's header for why the access token is expired by evicting its cookie rather
     * than by waiting fifteen minutes, and why that is the same thing from the server's side.
     *
     * ### Why the notification bell, and not a nav link
     *
     * The action has to be one that goes through `lib/apiClient` — the client with the
     * single-flight 401→refresh queue (T-022) — and it has to exist for every role regardless of
     * how `role_nav_configs` happens to be configured in whatever database this runs against. The
     * bell is in `AppShell`'s top bar unconditionally and its drawer query (`GET /notifications`)
     * is `enabled: open`, i.e. it fires on the click and not before, which makes the 401 land
     * exactly where this test wants it. A nav link would have been the more obvious choice and
     * was the first attempt; the maker's primary nav turned out to be **empty** in the shared
     * local database this suite runs against (logged below, and reported as an environment
     * finding — not something this task may fix, and not something a browser-level cookie test
     * should depend on).
     */
    it('TC-4 / step 3 — with the access token gone, the session refreshes silently and survives', async () => {
      const context = await (browser as Browser).newContext();
      const page = await context.newPage();
      await loginThroughTheUi(page);

      const refreshBefore = cookieNamed(await context.cookies(), REFRESH_COOKIE_NAME);
      expect(refreshBefore).toBeDefined();

      console.warn(`[T-058] primary nav: [${(await navHrefs(page)).join(', ')}]`);

      // Exactly what the browser itself does when `Max-Age` elapses.
      await context.clearCookies({ name: ACCESS_COOKIE_NAME });
      expect(cookieNamed(await context.cookies(), ACCESS_COOKIE_NAME)).toBeUndefined();

      // Armed *before* the click: this is the request that carries `__Host-rs_rt`. Under the
      // defect it could not exist at all, because the cookie was never in the jar to send.
      const refreshCall = page.waitForResponse(
        (response) =>
          response.url().includes('/api/v1/auth/refresh') && response.request().method() === 'POST',
        { timeout: 30_000 },
      );

      // A real user action in a real browser — no reload. (The reload path goes through
      // `useBootstrap`'s bare axios instance, which by design does not refresh; see the
      // completion report's "Findings" for that separate, pre-existing gap.)
      await page.locator('button[aria-label^="Notifications"]').first().click();

      const refreshResponse = await refreshCall;
      console.warn(
        `[T-058] POST /api/v1/auth/refresh → ${String(refreshResponse.status())} ` +
          '(issued by the SPA itself, carrying the __Host- refresh cookie from the browser jar)',
      );
      expect(refreshResponse.status()).toBe(200);

      // Still authenticated: the SPA did not bounce to /login.
      await page.getByRole('dialog', { name: 'Notifications' }).waitFor({ timeout: 30_000 });
      expect(page.url()).toContain('/dashboard');
      expect(page.url()).not.toContain('/login');

      const jarAfter = await context.cookies();
      describeJar('after silent refresh', jarAfter);

      // The refresh really happened: a new access cookie exists, and the refresh token rotated
      // (single-use rotation, T-011 — an unchanged value would mean no refresh took place).
      expect(cookieNamed(jarAfter, ACCESS_COOKIE_NAME)).toBeDefined();
      const refreshAfter = cookieNamed(jarAfter, REFRESH_COOKIE_NAME);
      expect(refreshAfter).toBeDefined();
      expect(refreshAfter?.path).toBe('/');
      expect(refreshAfter?.value).not.toBe(refreshBefore?.value);

      await context.close();
    });

    /**
     * TC-4 control — the counterfactual, i.e. what a user actually experienced before this fix.
     *
     * `TC-3 control` proves the browser refuses to store `__Host-rs_rt` at the old narrow path.
     * This reproduces the *consequence* of that refusal end to end: the same jar state the defect
     * produced (an access token that has expired, and no refresh cookie, because the browser threw
     * it away at login), the same user action — and the session is over, with a hard bounce to
     * `/login`. Without this, "the session survived" in the test above would have no baseline to
     * be measured against.
     */
    it('TC-4 control — with no refresh cookie in the jar, the same action ends the session at /login', async () => {
      const context = await (browser as Browser).newContext();
      const page = await context.newPage();
      await loginThroughTheUi(page);

      // The exact jar the defect produced: access cookie expired, refresh cookie never stored.
      await context.clearCookies({ name: ACCESS_COOKIE_NAME });
      await context.clearCookies({ name: REFRESH_COOKIE_NAME });
      describeJar('defect state (no refresh cookie)', await context.cookies());

      const sessionOver = page.waitForURL(/\/login/, { timeout: 30_000 });

      // Best-effort, and deliberately not awaited for success: with no refresh cookie the session
      // can end from *any* 401 the shell happens to make first (the bell's own unread-count
      // query, a focus-triggered refetch), in which case `apiClient`'s `endSession` has already
      // hard-redirected to `/login` and this button no longer exists to be clicked. Either route
      // to `/login` is the same observation — the session did not survive — and insisting the
      // click be the trigger would make this control fail for the wrong reason.
      await page
        .locator('button[aria-label^="Notifications"]')
        .first()
        .click({ timeout: 10_000 })
        .catch(() => undefined);

      await sessionOver;
      expect(page.url()).toContain('/login');

      await context.close();
    });

    /**
     * TC-5 / verification step 4 — "the cookie is gone from the jar", which is a different and
     * stronger claim than "a `Set-Cookie` with `Max-Age=0` was sent". Only the first one is the
     * claim that breaks when the clearing path's `Path` drifts from the setting path's.
     */
    it('TC-5 / step 4 — logging out removes __Host-rs_rt from the jar', async () => {
      const context = await (browser as Browser).newContext();
      const page = await context.newPage();
      await loginThroughTheUi(page);
      expect(cookieNamed(await context.cookies(), REFRESH_COOKIE_NAME)).toBeDefined();

      await page.locator('button[aria-haspopup="menu"]').first().click();
      await page.getByRole('menuitem', { name: 'Log out' }).click();
      await page.waitForURL(/\/login/, { timeout: 30_000 });

      const jar = await context.cookies();
      describeJar('after logout', jar);
      expect(cookieNamed(jar, REFRESH_COOKIE_NAME)).toBeUndefined();
      expect(cookieNamed(jar, ACCESS_COOKIE_NAME)).toBeUndefined();

      await context.close();
    });
  },
);
