/**
 * T-161 — verification step 4, in a **real Chromium browser**.
 *
 * ### Why this file exists
 *
 * T-161's verification step 4 is explicit: *"Manual: reproduce TC-1/TC-2 end-to-end through the
 * real login UI, not just at the service layer."* `t161-forced-password-change.e2e-spec.ts` already
 * proves the fix at the HTTP + SQL layer, and for this particular defect that is strong evidence —
 * the bug is a missing column write, and that file reads the column back out of real Postgres.
 *
 * But the *reported symptom* was a UI one: "logging in as a Maker prompts to change the password on
 * every login". Between the API response and that prompt sits a whole redirect chain the API tests
 * never execute — `LoginPage` branching on `mustChangePassword`, `/me/bootstrap`, and
 * `RequireBootstrap`, which independently re-reads the flag and sends a confined session back to
 * `/change-password`. A green API suite cannot tell you the user stops being redirected; only the
 * SPA can. This file closes that gap by driving the actual login form and the actual change-password
 * form, then logging in again in a **fresh cookie jar** and asserting where the browser lands.
 *
 * Same opt-in gate, and for the same reason, as the harness this project already established for
 * this class of evidence (T-033, T-045, T-049, T-058): a browser is strictly more host-load
 * flakiness than the deterministic suites, so the default `npm run test:e2e -- t161` sees this file
 * and *visibly skips* it.
 *
 *   RUN_UI_VERIFICATION=1 npm run test:e2e -- test/auth/t161-verify-ui.e2e-spec.ts
 *
 * ### One deliberate departure from the T-058 harness, and why
 *
 * T-058's spec spawns its *own* Nest app (on the Vite proxy's target port) and its *own* Vite dev
 * server. This file drives the **already-running local dev environment** instead, and creates its
 * fixtures against the deployment's own active encryption keys rather than throwaway ones.
 *
 * That is forced by how key material resolves, not a shortcut. `KeyRegistryService` resolves each
 * `encryption_keys.key_ref` against the **environment of the process that booted it**, and
 * `portal_users.email` is an envelope plus a blind index computed from those keys. The browser talks
 * to whichever backend serves `/api`, which is a *different process* from this test. If this suite
 * minted throwaway keys (`ensureEncryptionKeys`) and inserted a user encrypted under them, that
 * backend would compute a different `email_bidx` on login and simply not find the row — a failure
 * that looks exactly like the defect under test and is not it. Sharing the running deployment's
 * active keys is what makes the login this file performs the *same* login a human performs.
 *
 * Consequences worth stating plainly:
 *
 *  - It needs `npm run dev` already up (SPA on 5173, API on the port `vite.config.ts` proxies to).
 *    If either is absent the suite fails with a precondition message rather than a confusing
 *    element-not-found thirty seconds later.
 *  - It asserts against whatever code that backend currently has loaded. That is the point — it is
 *    the only leg of this task that tests the deployed artefact rather than an in-process import —
 *    but it means a stale dev server reports red. That is a true negative, not flakiness: re-run it
 *    after the watcher picks the fix up.
 *  - It creates and deletes only its own `t161-ui-*` fixture rows and mints no key rows, so it
 *    cannot disturb a real key configuration (the hazard `ensureEncryptionKeys` documents at
 *    length) or leave the orphaned-key residue T-067 filed.
 *
 * ### The control is the load-bearing part
 *
 * "The user reached /dashboard" is only meaningful if this harness is capable of observing the
 * failure. So the first test drives a *still-pending* forced change end to end and asserts the
 * browser **is** held at `/change-password` — the same assertion, in the same harness, with the
 * opposite expected outcome. If that test ever goes green-by-default, the redirect assertions below
 * are not evidence of anything.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { chromium, type Browser, type Page } from 'playwright';
import * as argon2 from 'argon2';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  insertPortalUser,
} from './support/portal-user-fixture';

const RUN = process.env.RUN_UI_VERIFICATION === '1';

/** The reported role. A second account carries the control case. */
const FIXED_EMAIL = 't161-ui-fixed@example.invalid';
const CONTROL_EMAIL = 't161-ui-control@example.invalid';

const TEMP_PASSWORD = 'Issued-By-Admin-Once!7';
const CHOSEN_PASSWORD = 'Tr0ubador-Zephyr-Quill!42';

/** The running dev SPA. Overridable so this can be pointed at a deployed environment. */
const FRONTEND_URL = process.env.T161_UI_BASE_URL ?? 'http://localhost:5173';

jest.setTimeout(300_000);

/** Fails loudly and specifically when the dev environment this suite requires is not up. */
async function requireRunningSpa(): Promise<void> {
  try {
    await fetch(FRONTEND_URL);
  } catch (error) {
    throw new Error(
      `T-161 UI verification needs the local dev environment already running at ${FRONTEND_URL} ` +
        `(start it with \`npm run dev\` from portal/, which also brings up the API this SPA ` +
        `proxies to). See this file's header for why it drives the running deployment rather ` +
        `than spawning its own. Original error: ${String(error)}`,
    );
  }
}

(RUN ? describe : describe.skip)(
  'T-161 verification step 4 — the reported flow through the real login UI (opt-in, real browser)',
  () => {
    let app: INestApplication;
    let db: Sequelize;
    let browser: Browser | undefined;
    const userIds = new Map<string, number>();

    /**
     * Puts an account into the exact state the temporary-password flow leaves it in: a known hash,
     * `must_change_password = true`, and an *elapsed* `password_expires_at` — the reliably
     * reproducing case from the product report.
     */
    async function provisionAsTemporary(email: string): Promise<void> {
      const userId = userIds.get(email);
      await db.query(
        `UPDATE reward_portal.portal_users
            SET must_change_password = true, status = 'active', updated_at = now()
          WHERE id = :userId`,
        { type: QueryTypes.UPDATE, replacements: { userId } },
      );
      await db.query(
        `UPDATE reward_portal.portal_user_credentials
            SET password_hash = :hash, password_algo = 'argon2id', previous_hashes = NULL,
                failed_attempts = 0, locked_until = NULL,
                password_expires_at = now() - interval '1 hour',
                password_updated_at = now(), updated_at = now()
          WHERE user_id = :userId`,
        {
          type: QueryTypes.UPDATE,
          replacements: {
            userId,
            hash: await argon2.hash(TEMP_PASSWORD, ARGON2_OPTIONS),
          },
        },
      );
      await db.query(`DELETE FROM reward_portal.portal_sessions WHERE user_id = :userId`, {
        type: QueryTypes.DELETE,
        replacements: { userId },
      });
    }

    async function expiryOf(email: string): Promise<Date | null> {
      const [row] = await db.query<{ password_expires_at: Date | null }>(
        `SELECT password_expires_at FROM reward_portal.portal_user_credentials
          WHERE user_id = :userId`,
        { type: QueryTypes.SELECT, replacements: { userId: userIds.get(email) } },
      );
      if (row === undefined) throw new Error(`no credential row for ${email}`);
      return row.password_expires_at;
    }

    /**
     * Logs in through the **real login form** and returns the path the SPA settled on.
     *
     * Deliberately does not assert the destination: both the "held at /change-password" control and
     * the "reaches /dashboard" fix assertion go through this same function, so the destination is
     * the *observation*, not a precondition baked into the helper.
     */
    async function loginThroughTheUi(page: Page, email: string, password: string): Promise<string> {
      // The login form is `front-end/src/features/auth/**` — another task's files. If the SPA fails
      // to compile the symptom here is a bare "element not found" thirty seconds later, which reads
      // like a T-161 failure and is not one. Capture what the browser actually said instead.
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));

      await page.goto(`${FRONTEND_URL}/login`);
      try {
        await page.getByLabel('Email').waitFor({ timeout: 30_000 });
      } catch (error) {
        const body = ((await page.locator('body').textContent()) ?? '').trim().slice(0, 300);
        throw new Error(
          `The login form never rendered at ${page.url()} — this is the SPA failing to load, not ` +
            `the behaviour under test. Body text: "${body}". Browser errors: ` +
            `${pageErrors.join(' | ') || '(none)'}. Original error: ${String(error)}`,
        );
      }

      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Log in' }).click();

      // Either destination is a legitimate outcome of a *successful* login; wait for whichever
      // arrives rather than for one and timing out on the other.
      await page.waitForURL(/\/(dashboard|change-password)/, { timeout: 60_000 });
      return new URL(page.url()).pathname;
    }

    /** Completes the forced change through the **real change-password form**. */
    async function changePasswordThroughTheUi(page: Page, next: string): Promise<void> {
      await page.getByLabel('Current password').fill(TEMP_PASSWORD);
      await page.getByLabel('New password', { exact: true }).fill(next);
      await page.getByLabel('Confirm new password').fill(next);
      await page.getByRole('button', { name: 'Change password' }).click();
      await page.waitForURL(/\/dashboard/, { timeout: 60_000 });
    }

    beforeAll(async () => {
      await requireRunningSpa();

      // `init()`, not `listen()`: the HTTP surface under test is the *already-running* dev API, so
      // binding a port here would either collide with it or, worse, quietly serve a second backend
      // the browser never talks to. This app instance exists only to reach the database through the
      // application's own `PortalUserEmailCrypto` — the fixture rule T-056 established.
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      await app.init();

      db = app.get<Sequelize>(SEQUELIZE);
      const emailCrypto = emailCryptoOf(app);

      const [tenant] = await db.query<{ id: number; country_id: number }>(
        `SELECT id, country_id FROM reward_config.tenants
          WHERE deleted_at IS NULL ORDER BY id LIMIT 1`,
        { type: QueryTypes.SELECT },
      );
      if (tenant === undefined) throw new Error('no tenant — cannot place a maker');

      await deletePortalUsersByEmail(db, emailCrypto, [FIXED_EMAIL, CONTROL_EMAIL]);

      for (const email of [FIXED_EMAIL, CONTROL_EMAIL]) {
        const userId = await insertPortalUser(db, emailCrypto, {
          email,
          displayName: `T-161 UI ${email}`,
          role: 'maker',
          countryId: tenant.country_id,
          tenantId: tenant.id,
          merchantId: null,
          status: 'active',
          mustChangePassword: true,
        });
        userIds.set(email, userId);
        await db.query(
          `INSERT INTO reward_portal.portal_user_credentials
                  (user_id, password_hash, password_algo, password_updated_at,
                   failed_attempts, created_at, updated_at)
           VALUES (:userId, :hash, 'argon2id', now(), 0, now(), now())`,
          {
            type: QueryTypes.INSERT,
            replacements: { userId, hash: await argon2.hash(TEMP_PASSWORD, ARGON2_OPTIONS) },
          },
        );
      }

      browser = await chromium.launch();
    });

    afterAll(async () => {
      if (browser !== undefined) await browser.close();

      if (db !== undefined) {
        for (const userId of userIds.values()) {
          await db.query(
            `DELETE FROM reward_portal.portal_user_credentials WHERE user_id = :userId`,
            { type: QueryTypes.RAW, replacements: { userId } },
          );
        }
        await deletePortalUsersByEmail(db, emailCryptoOf(app), [FIXED_EMAIL, CONTROL_EMAIL]);
        // No `removeEncryptionKeys` counterpart: this suite mints no key rows (see the header), so
        // it has none to sweep and must not touch the deployment's real ones.
      }
      if (app !== undefined) await app.close();
    });

    /**
     * The control. Runs first on purpose: if the browser does *not* get held at `/change-password`
     * when a forced change is genuinely pending, this harness cannot observe the reported symptom
     * and nothing else in this file is evidence.
     */
    it('control — a pending forced change really does hold the browser at /change-password', async () => {
      await provisionAsTemporary(CONTROL_EMAIL);
      const context = await (browser as Browser).newContext();
      const page = await context.newPage();

      const landing = await loginThroughTheUi(page, CONTROL_EMAIL, TEMP_PASSWORD);
      expect(landing).toBe('/change-password');

      await context.close();
    });

    /**
     * TC-1 / TC-2, exactly as reported: log in, change the password, log in again in a clean jar.
     * Before the fix, the second login landed on `/change-password` again — forever.
     */
    it('TC-1/TC-2 — after changing the password, the next login is not prompted again', async () => {
      await provisionAsTemporary(FIXED_EMAIL);

      // --- first login: the forced change is correct here and must stay (task "Out of scope").
      const first = await (browser as Browser).newContext();
      const firstPage = await first.newPage();
      expect(await loginThroughTheUi(firstPage, FIXED_EMAIL, TEMP_PASSWORD)).toBe(
        '/change-password',
      );

      await changePasswordThroughTheUi(firstPage, CHOSEN_PASSWORD);
      expect(await expiryOf(FIXED_EMAIL)).toBeNull();
      await first.close();

      // --- second login, in a brand-new cookie jar: the leg that reproduced the defect.
      const second = await (browser as Browser).newContext();
      const secondPage = await second.newPage();
      const landing = await loginThroughTheUi(secondPage, FIXED_EMAIL, CHOSEN_PASSWORD);
      expect(landing).toBe('/dashboard');

      // The SPA must also stay there: `RequireBootstrap` re-reads `mustChangePassword` from
      // `/me/bootstrap` after the route settles, so a stale flag would bounce the user a moment
      // later rather than at `waitForURL` time.
      await secondPage.waitForTimeout(2_000);
      expect(new URL(secondPage.url()).pathname).toBe('/dashboard');

      // ...and the login must not have written the flag back onto the user row.
      const [row] = await db.query<{ must_change_password: boolean }>(
        `SELECT must_change_password FROM reward_portal.portal_users WHERE id = :userId`,
        { type: QueryTypes.SELECT, replacements: { userId: userIds.get(FIXED_EMAIL) } },
      );
      expect(row?.must_change_password).toBe(false);
      expect(await expiryOf(FIXED_EMAIL)).toBeNull();

      await second.close();
    });
  },
);
