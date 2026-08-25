/**
 * T-049 — verification steps 3, 4 and 5, in a **real Chromium browser** against the **real** Vite
 * dev server and the **real** Nest back end, over real HTTP with real session cookies.
 *
 * The same tool, harness and opt-in gate `test/trace/verify-step-2.e2e-spec.ts` (T-045) and
 * `test/access-control/verify-step-2.e2e-spec.ts` (T-033) established for exactly this class of
 * evidence — see those files' headers for why the gate exists (two extra processes and a real
 * browser are strictly more host-load flakiness than the deterministic suites, so the default
 * `npm run test:e2e` sees this file and *visibly skips* it):
 *
 *   RUN_UI_VERIFICATION=1 npm run test:e2e -- test/campaign-agent/verify-ui.e2e-spec.ts
 *
 * ### The model is real HTTP too
 *
 * Rather than overriding `LLM_PROVIDER` in the container — which would prove nothing about the
 * transport — this suite starts a **fake Ollama** on a loopback port and points the real
 * `OllamaLlmProvider` at it with `AGENT_LLM_BASE_URL` (§8's own switch point). So:
 *
 *  - **step 3** — *"stop the model service, reload"*: the fake answers HTTP 500, which is what a
 *    stopped Ollama's port would produce a connection error for, and both land on
 *    `LlmUnavailableError` → 503. The banner and its working wizard link are then a property of the
 *    running system, not of a mocked module.
 *  - **step 4** — *"force an assistant reply containing `<img onerror=…>`"*: the fake returns
 *    exactly that, inside a well-formed model turn, and it travels the whole way — Ollama response
 *    → orchestrator → `agent_session_events` → JSON → the SPA — before being rendered. If any layer
 *    on that path ever interpreted it as markup, this test fails with a real `<img>` in a real DOM.
 *  - **step 5** — *"complete a campaign keyboard-only"*: the keyboard path through the composer and
 *    the send control, driven by real key events. The *whole* seven-slot conversation needs the
 *    full master-data fixture set that `campaign-agent.e2e-spec.ts` builds (merchants, activities,
 *    country-assigned rule and reward versions); rather than duplicate ~400 lines of fixtures here,
 *    the keyboard evidence is the turn cycle, and the chip/review/confirm keyboard paths are proven
 *    against the same components in `front-end/test/features/campaign-agent/AgentChatPage.spec.tsx`
 *    (TC-16, which drives the full conversation with the keyboard only). Disclosed rather than
 *    quietly substituted.
 */
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import * as argon2 from 'argon2';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';

const RUN = process.env.RUN_UI_VERIFICATION === '1';
const SUITE = 't049ui';
const EMAIL = 't049-ui-verify@example.invalid';
const PASSWORD = 'correct horse battery staple 9!';
const DISPLAY_NAME = 'T-049 UI verify';
const BACKEND_PORT = 3000;
const FAKE_MODEL_PORT = 21_434;
const FRONTEND_URL = 'http://localhost:5173';
const FRONTEND_ROOT = path.resolve(__dirname, '../../../front-end');

/** The payload verification step 4 names, plus a `<script>` for good measure. */
const MARKUP_PAYLOAD =
  'Good — here is what I found: <img src=x onerror="document.title=\'pwned\'"> <script>document.title="pwned"</script> shall we continue?';

jest.setTimeout(240_000);

/** What the fake model does on the next call. Flipped per test. */
let modelMode: 'down' | 'markup' | 'plain' = 'plain';

function fakeModelBody(): string {
  const turn =
    modelMode === 'markup'
      ? { reply: MARKUP_PAYLOAD }
      : { reply: 'Understood. What should the campaign be called?' };
  return JSON.stringify({
    message: { content: JSON.stringify(turn) },
    prompt_eval_count: 12,
    eval_count: 8,
  });
}

function startFakeModel(): Promise<Server> {
  const server = createServer((request, response) => {
    if (modelMode === 'down') {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('model unavailable');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(fakeModelBody());
  });
  return new Promise((resolve) => {
    server.listen(FAKE_MODEL_PORT, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

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

/** A maker logs in through the **real login form** — no MFA stands in the way of this role. */
async function loginAsMaker(page: Page): Promise<void> {
  await page.goto(`${FRONTEND_URL}/login`);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
}

async function openAssistant(page: Page): Promise<void> {
  await page.goto(`${FRONTEND_URL}/campaigns/assistant`);
  await page.getByRole('heading', { name: 'Create with AI' }).waitFor({ timeout: 30_000 });
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByLabel('Your message').fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

(RUN ? describe : describe.skip)(
  'T-049 verification steps 3, 4 and 5 (opt-in, real browser)',
  () => {
    let app: INestApplication;
    let db: Sequelize;
    let model: Server | undefined;
    let vite: ChildProcessWithoutNullStreams | undefined;
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let userId: number | undefined;

    beforeAll(async () => {
      model = await startFakeModel();
      // Read by `OllamaLlmProvider`'s constructor, so it must be set before the module compiles.
      process.env.AGENT_LLM_BASE_URL = `http://127.0.0.1:${String(FAKE_MODEL_PORT)}`;
      process.env.AGENT_LLM_MODEL = 't049-fake';

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

      await deletePortalUsersByEmail(db, emailCryptoOf(app), [EMAIL]);
      userId = await insertPortalUser(db, emailCryptoOf(app), {
        email: EMAIL,
        displayName: DISPLAY_NAME,
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
          replacements: { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
        },
      );

      vite = spawn('npm', ['run', 'dev', '--', '--port', '5173', '--strictPort'], {
        cwd: FRONTEND_ROOT,
        stdio: 'pipe',
      });
      vite.stdout.on('data', () => undefined);
      vite.stderr.on('data', () => undefined);
      await waitForHttp(FRONTEND_URL, 90_000);

      browser = await chromium.launch();
      context = await browser.newContext();
    });

    afterAll(async () => {
      if (context !== undefined) await context.close();
      if (browser !== undefined) await browser.close();
      if (vite !== undefined) vite.kill();
      if (model !== undefined) await new Promise((resolve) => model?.close(resolve));

      if (userId !== undefined) {
        await db.query(
          `DELETE FROM reward_portal.agent_session_events
            WHERE session_id IN (SELECT id FROM reward_portal.agent_sessions WHERE portal_user_id = :userId)`,
          { type: QueryTypes.RAW, replacements: { userId } },
        );
        await db.query(`DELETE FROM reward_portal.agent_sessions WHERE portal_user_id = :userId`, {
          type: QueryTypes.RAW,
          replacements: { userId },
        });
        await db.query(
          `DELETE FROM reward_portal.portal_user_credentials WHERE user_id = :userId`,
          {
            type: QueryTypes.RAW,
            replacements: { userId },
          },
        );
        await deletePortalUsersByEmail(db, emailCryptoOf(app), [EMAIL]);
      }

      // Same hygiene `campaign-agent.e2e-spec.ts` documents: a leftover key row stops other suites
      // — and `db:rollback` — from booting.
      await removeEncryptionKeys(db, SUITE);
      await app.close();
    });

    it('step 3 — the model is not answering: the banner and a working wizard link', async () => {
      modelMode = 'down';
      const page = await (context as BrowserContext).newPage();
      await loginAsMaker(page);
      await openAssistant(page);

      await sendMessage(page, 'I want a weekend cashback campaign');

      const banner = page.getByText(
        /The assistant is unavailable — you can still create this campaign in the wizard/,
      );
      await banner.waitFor({ timeout: 30_000 });

      // Nothing internal leaks into the maker's view.
      const body = (await page.locator('body').textContent()) ?? '';
      expect(body).not.toMatch(/ECONNREFUSED|11434|21434|ollama/i);

      const link = page.getByRole('link', { name: 'Create this campaign in the wizard' });
      expect(await link.getAttribute('href')).toBe('/campaigns/new');
      await link.click();
      await page.getByRole('heading', { name: 'New campaign' }).waitFor({ timeout: 30_000 });

      await page.close();
    });

    it('step 4 — an assistant reply carrying <img onerror=…> is rendered as literal text', async () => {
      modelMode = 'markup';
      const page = await (context as BrowserContext).newPage();
      await loginAsMaker(page);
      await openAssistant(page);

      await sendMessage(page, 'tell me what you found');

      const bubble = page.getByText(MARKUP_PAYLOAD, { exact: false });
      await bubble.waitFor({ timeout: 30_000 });

      const chat = page.getByRole('list', { name: 'Conversation with the assistant' });
      expect(await chat.locator('img').count()).toBe(0);
      expect(await chat.locator('script').count()).toBe(0);
      expect(await chat.locator('[onerror]').count()).toBe(0);
      // The handler never ran: the payload's only effect would have been to rename the document.
      expect(await page.title()).not.toBe('pwned');

      await page.close();
    });

    it('step 5 — a turn can be completed with the keyboard alone', async () => {
      modelMode = 'plain';
      const page = await (context as BrowserContext).newPage();
      await loginAsMaker(page);
      await openAssistant(page);

      await page.getByLabel('Your message').focus();
      await page.keyboard.type('an instant cashback campaign for the weekend');
      await page.keyboard.press('Tab');
      // `:focus` rather than `page.evaluate(() => document…)`: the back end's `tsconfig` has no DOM
      // lib, and Playwright's own selector answers the same question.
      expect((await page.locator(':focus').textContent())?.trim()).toContain('Send');
      await page.keyboard.press('Enter');

      await page
        .getByText('Understood. What should the campaign be called?')
        .waitFor({ timeout: 30_000 });

      await page.close();
    });
  },
);
