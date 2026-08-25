/**
 * T-050 — boots the entire stack this suite runs against, once, before any spec: a real,
 * disposable Postgres (Testcontainers, implementation note 1 — "no mocked API"), the real
 * migrated `reward_portal` schema plus the legacy `reward_config` schema it sits beside, the
 * real NestJS API and the real React SPA, and the one `super_admin` this database will ever have
 * (created "via CLI" exactly as the golden journey's step 1 requires — see below).
 *
 * ### `super_admin`'s first login + MFA enrolment happens here, through a real, headless browser
 *
 * T-055 made MFA structurally mandatory for `super_admin`: `POST /auth/login` for that role
 * answers `{ mfaRequired: true }` with no session. For a while nothing consumed that branch —
 * `front-end/src/features/auth/LoginPage.tsx`'s header used to record that gap plainly (*"a
 * super_admin cannot complete a login through this SPA"*), and this file used to complete the
 * challenge via the raw, unmocked API instead, exactly because no screen existed to drive.
 * **That gap is closed (T-060, `MfaChallengePage.tsx`)** — `LoginPage.tsx`'s own header now says
 * so directly. `T-050-e2e-tests.md`'s "Inherited acceptance criteria" table holds this task to
 * proving it for real: T-060 TC-1, *"Super Admin first browser login → reaches the MFA enrolment
 * screen and completes it"*.
 *
 * This is the one place in the whole suite that can happen, and it can only happen once:
 * `bootstrap-superadmin.ts` refuses a second `super_admin` outright, so there is exactly one
 * "first login" for the entire run, and it must be spent honestly rather than through a raw API
 * call taken for setup convenience. `mfaEnrolSuperAdminThroughBrowser` below launches a real,
 * separate headless Chromium instance (not a spec — no worker exists yet at this point in
 * Playwright's own lifecycle) and drives the actual screens: `/login` → `/mfa-challenge`'s enrol
 * phase (reading the real, rendered TOTP secret out of the DOM, exactly as a human would copy it
 * into an authenticator app) → a real RFC 6238 code computed by `utils/totp.ts` → the recovery-
 * codes screen → the forced `/change-password` redirect → `/dashboard`. Every other spec's
 * `super_admin` actions (`superAdminSession.ts`) replay the resulting session cookies rather than
 * repeating this flow — not because the SPA cannot do it again, but because a second real login
 * would be a second, wasted charge against `LOGIN_PER_IP_LIMIT` for no additional proof (the
 * screens were already exercised, for real, right here).
 *
 * ### Order of operations
 *
 * 1. Start Postgres (Testcontainers) — or, if no container runtime is reachable at all (a
 *    Docker-less sandbox; see `provisionDatabase` below and `utils/localPostgres.ts`'s header),
 *    fall back to a fresh, disposable database on the real local Postgres this repo's own
 *    `CLAUDE.md` already documents. CI (`.github/workflows/e2e.yml`) always has Docker and never
 *    takes the fallback path.
 * 2. Load `database/reward_config_postgres.sql` (schema only — the legacy system, ported; see
 *    `utils/db.ts`'s header) into it.
 * 3. Generate a fresh RSA keypair (JWT) and two fresh AES/HMAC keys (field/blind-index
 *    encryption) — never committed anywhere (R4) — and seed the two `encryption_keys` rows
 *    T-016/T-056 deliberately leave for a deployment to insert. The RSA keypair is also written to
 *    `.tmp/e2e-state.json` (`utils/state.ts`'s own `jwtKeys`) — the inherited T-058 TC-4 criterion
 *    (`utils/accessToken.ts`) needs it to forge an expired-but-otherwise-genuine access token.
 * 3a. Ensure the `reward_app` role exists (`utils/db.ts#ensureAppRoleExists`, T-078) — a fresh
 *     Testcontainers instance starts with only the `postgres` superuser, and the migrations run
 *     next assume `reward_app` already exists, exactly as a real deployment's own out-of-band
 *     provisioning would have guaranteed by this point.
 * 4. Run the portal's own migrations (`npm run db:migrate -w back-end`) against that database.
 * 5. Seed the `reward_config` reference rows (`utils/db.ts#seedReferenceData`) nothing in this
 *    portal can create through its own API.
 * 6. Start the real back end and the real front end as child processes, wait for both to answer.
 *    The back end normally runs under `ts-node` (fast, no build step); setting
 *    `E2E_BACKEND_MODE=built` instead runs `npm run build -w back-end` and spawns the **compiled**
 *    `dist/main.js` with plain `node` — the inherited T-057 TC-3 criterion ("the suite runs
 *    against the built artefact at least once"), exercised as an explicit, opt-in mode rather than
 *    the default, since a build step is real wall-clock cost this task's own three-consecutive-run
 *    DoD does not need paying on every run.
 * 7. Bootstrap the one `super_admin` via the real CLI script (`bootstrap:superadmin`).
 * 8. Complete that account's first login + MFA enrolment through a real, headless browser (see
 *    above) and capture the resulting session cookies.
 * 9. Build the one shared `scenario` (`utils/scenario.ts`) every spec reads from
 *    (`utils/state.ts`'s own header, "why `scenario` lives here now" — a real, measured
 *    `LOGIN_PER_IP_LIMIT` blocker, T-050 2026-08-20).
 * 10. Write every fact a spec needs to `.tmp/e2e-state.json` (`utils/state.ts`).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { GenericContainer, Wait } from 'testcontainers';
import { chromium } from '@playwright/test';
import {
  ensureAppRoleExists,
  insertEncryptionKey,
  loadRewardConfigSchema,
  seedReferenceData,
  waitForDatabase,
  type DbConnectionInfo,
} from './utils/db';
import { createEphemeralDatabase, localSuperuserConnection } from './utils/localPostgres';
import { sessionFromCookies, type BrowserCookie } from './utils/apiClient';
import { buildScenario } from './utils/scenario';
import { totpCodeAt } from './utils/totp';
import { writeState } from './utils/state';

const PORTAL_ROOT = path.resolve(__dirname, '..');
const BACK_END_DIR = path.join(PORTAL_ROOT, 'back-end');
const FRONT_END_DIR = path.join(PORTAL_ROOT, 'front-end');

const FRONT_END_PORT = 5173;
const BACK_END_PORT = 3000; // front-end/vite.config.ts's dev proxy target is hard-coded to this.
const DB_CONTAINER_PORT = 5432;

const SUPER_ADMIN_EMAIL = 'super.admin@e2e.invalid';
const SUPER_ADMIN_NAME = 'E2E Super Admin';
/** The bootstrap CLI's temporary password — used exactly once, by `POST /auth/change-password`
 * below, then never again (`portal_user_credentials` no longer accepts it). */
const SUPER_ADMIN_TEMP_PASSWORD = 'Correct-Horse-Battery-Staple-9!';
/** What every spec's `super_admin` API session (and the golden journey's browser session)
 * authenticates with from this point on. */
const SUPER_ADMIN_PASSWORD = 'Another-Correct-Horse-42-Staple!';

const spawned: ChildProcess[] = [];

function pemToEnvValue(pem: string): string {
  return pem; // real newlines — see this file's header on why no `\n`-escaping is needed.
}

type ProvisionedDatabase =
  | { readonly strategy: 'container'; readonly db: DbConnectionInfo; readonly containerId: string }
  | { readonly strategy: 'local'; readonly db: DbConnectionInfo };

/** Testcontainers itself throws this exact message (see
 * `node_modules/testcontainers/src/container-runtime/clients/client.ts`) when it has tried every
 * strategy it knows (env var, Docker Desktop socket, Podman, `~/.testcontainers.properties`, …)
 * and none answered — i.e. genuinely "no container runtime here", not some other, unrelated
 * failure this fallback should not swallow. */
function isContainerRuntimeUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /could not find a working container runtime strategy/i.test(message);
}

/**
 * Implementation note 1 ("Real Postgres via Testcontainers") stays the primary path, and is the
 * only path CI (`.github/workflows/e2e.yml`, a Docker-equipped GitHub Actions runner) ever takes.
 * The fallback below exists only because the first review round found the previous, Testcontainers
 * only version of this function could not get past its own first line in a Docker-less sandbox —
 * see `utils/localPostgres.ts`'s header for the full reasoning. Any error *other* than "no
 * container runtime at all" (a bad image name, a Docker daemon that is reachable but refuses the
 * pull, …) is a real failure and is rethrown, not silently swallowed into the fallback.
 */
async function provisionDatabase(): Promise<ProvisionedDatabase> {
  console.log('[global-setup] starting Postgres (testcontainers)…');
  try {
    const container = await new GenericContainer('postgres:16')
      .withEnvironment({
        POSTGRES_USER: 'postgres',
        POSTGRES_PASSWORD: 'postgres',
        POSTGRES_DB: 'reward_system',
      })
      .withExposedPorts(DB_CONTAINER_PORT)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    return {
      strategy: 'container',
      containerId: container.getId(),
      db: {
        host: container.getHost(),
        port: container.getMappedPort(DB_CONTAINER_PORT),
        database: 'reward_system',
        username: 'postgres',
        password: 'postgres',
      },
    };
  } catch (error) {
    if (!isContainerRuntimeUnavailable(error)) throw error;
    console.warn(
      '[global-setup] no container runtime available ' +
        `(${(error as Error).message}) — falling back to the real, already-running local ` +
        "Postgres this machine documents in CLAUDE.md. This is a disclosed deviation from " +
        'implementation note 1 for a Docker-less sandbox only; CI always has Docker and never ' +
        'takes this path (see utils/localPostgres.ts).',
    );
    const superuser = localSuperuserConnection();
    const db = await createEphemeralDatabase(superuser);
    return { strategy: 'local', db };
  }
}

function spawnProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; name: string },
): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'pipe',
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[${options.name}] ${chunk.toString()}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[${options.name}] ${chunk.toString()}`);
  });
  spawned.push(child);
  return child;
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${url} answered ${String(response.status)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} never became ready: ${String(lastError)}`);
}

interface SuperAdminMfaResult {
  readonly totpSecretBase32: string;
  readonly cookies: readonly BrowserCookie[];
}

/**
 * Drives `super_admin`'s one, real "first login" through an actual headless Chromium instance —
 * this file's own header explains why this must happen here, exactly once, rather than in a spec.
 * Every selector below matches `front-end/src/features/auth/{LoginPage,MfaChallengePage,
 * ChangePasswordPage}.tsx`'s real, rendered markup; nothing here is stubbed or skipped.
 */
async function mfaEnrolSuperAdminThroughBrowser(baseURL: string): Promise<SuperAdminMfaResult> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(`${baseURL}/login`);
    await page.getByLabel('Email').fill(SUPER_ADMIN_EMAIL);
    await page.getByLabel('Password').fill(SUPER_ADMIN_TEMP_PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();

    try {
      await page.waitForURL((url) => url.pathname === '/mfa-challenge', { timeout: 30_000 });
    } catch (error) {
      throw new Error(
        'Expected a freshly bootstrapped super_admin to be redirected to /mfa-challenge ' +
          `(T-055/T-060) — ended up at ${page.url()} instead. Either T-055/T-060 regressed or ` +
          `this database was not fresh. (${String(error)})`,
      );
    }
    await page
      .getByRole('heading', { name: 'Set up two-factor authentication' })
      .waitFor({ state: 'visible', timeout: 30_000 });

    // The setup-key `<code>` is the first `<code>` element on the enrol phase
    // (`MfaChallengePage.tsx`'s own markup: it renders before the collapsed `<details>` holding
    // the otpauth:// URI) — read exactly as a human copying it into an authenticator app would.
    const rawSecret = (await page.locator('code').first().innerText()).replace(/\s+/g, '');
    if (!/^[A-Z2-7]+$/.test(rawSecret)) {
      throw new Error(
        'Read something that does not look like a base32 TOTP secret from the MFA enrolment ' +
          `screen: "${rawSecret}". Has MfaChallengePage.tsx's markup changed?`,
      );
    }

    await page.getByLabel('Verification code').fill(totpCodeAt(rawSecret));
    await page.getByRole('button', { name: 'Enable two-factor authentication' }).click();

    await page
      .getByRole('heading', { name: 'Save your recovery codes' })
      .waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByRole('button', { name: /saved these codes/i }).click();

    try {
      await page.waitForURL((url) => url.pathname === '/change-password', { timeout: 30_000 });
    } catch (error) {
      throw new Error(
        'Expected the freshly bootstrapped super_admin to still be must_change_password=true ' +
          `right after MFA verify (bootstrap-superadmin.ts rule 4) — ended up at ${page.url()} ` +
          `instead of /change-password. (${String(error)})`,
      );
    }
    await page.getByLabel('Current password').fill(SUPER_ADMIN_TEMP_PASSWORD);
    await page.getByLabel('New password', { exact: true }).fill(SUPER_ADMIN_PASSWORD);
    await page.getByLabel('Confirm new password').fill(SUPER_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Change password' }).click();

    await page.waitForURL((url) => url.pathname === '/dashboard', { timeout: 30_000 });
    try {
      await page.getByRole('heading', { level: 1 }).first().waitFor({ state: 'visible', timeout: 30_000 });
    } catch (error) {
      throw new Error(
        `super_admin reached /dashboard but no <h1> ever rendered — has AppShell changed? (${String(error)})`,
      );
    }

    // Captured last, after the password change: `AuthService.changePassword`'s own header says
    // the current session survives that call, deliberately, but this is the moment the cookies
    // are final — nothing else touches this session again before every worker starts replaying
    // them (`utils/state.ts`'s own header on `superAdmin.cookies`).
    const cookies = await context.cookies();
    return { totpSecretBase32: rawSecret, cookies };
  } finally {
    await browser.close();
  }
}

export default async function globalSetup(): Promise<void> {
  // `utils/ids.ts#uniqueCountryCode` coordinates across worker processes through this directory
  // (an in-memory Set would not be visible to a sibling worker) — clear it between runs, or a
  // prior `npm run e2e` invocation's claimed codes (`.tmp/` is never committed, but does persist
  // on disk between separate invocations) would eventually exhaust the 249-code pool across the
  // DoD's own "three consecutive runs".
  rmSync(path.resolve(__dirname, '.tmp', 'used-country-codes'), { recursive: true, force: true });

  const provisioned = await provisionDatabase();
  const db = provisioned.db;
  await waitForDatabase(db);
  console.log(
    `[global-setup] Postgres ready at ${db.host}:${String(db.port)} ` +
      `(database "${db.database}", strategy: ${provisioned.strategy}).`,
  );

  console.log('[global-setup] loading reward_config (legacy) schema…');
  await loadRewardConfigSchema(db);

  console.log('[global-setup] generating ephemeral JWT + field/blind-index key material…');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const fieldKey = randomBytes(32).toString('base64');
  const blindKey = randomBytes(32).toString('base64');

  // The migration/app-role split T-002 documents is deliberately collapsed to one superuser role
  // here: this database is disposable and this suite is not what re-proves that split holds (the
  // back end's own `test/database` suite is) — a real difference from every non-test
  // environment, called out in the completion report rather than left implicit.
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(BACK_END_PORT),
    JWT_PRIVATE_KEY: pemToEnvValue(privateKey),
    JWT_PUBLIC_KEY: pemToEnvValue(publicKey),
    DB_HOST: db.host,
    DB_PORT: String(db.port),
    DB_NAME: db.database,
    DB_SSL: 'false',
    DB_APP_USERNAME: db.username,
    DB_APP_PASSWORD: db.password,
    DB_MIGRATION_USERNAME: db.username,
    DB_MIGRATION_PASSWORD: db.password,
    CORS_ALLOWED_ORIGINS: `http://localhost:${String(FRONT_END_PORT)}`,
    API_ORIGIN: `http://localhost:${String(BACK_END_PORT)}`,
    E2E_FIELD_KEY: fieldKey,
    E2E_BLIND_KEY: blindKey,
    // T-066's own env-driven override, at its maximum (`MAX_LOGIN_THROTTLE_RELAX_FACTOR = 40` —
    // `security.constants.ts`): raises `login_per_email_ip`/`login_per_ip` from 5/20 to 200/800
    // per 15 minutes, `NODE_ENV=production` ignores it outright so this can never reach a real
    // deployment. T-066's own completion report says this plainly — "deliberately unset by
    // default... The e2e environment must actually *set* it for this to help" — this is that
    // setting. Without it, this suite's own real-login volume (`utils/scenario.ts`'s header:
    // shared actors, captured once, but still several real logins across `global-setup.ts` alone)
    // reliably hits `RATE_LIMITED` well before a full run completes — reproduced live, T-050,
    // 2026-08-20/21. Never disable throttling globally (implementation note, task file) — this is
    // the opposite: the limiter still runs, still enforces a real (if relaxed) ceiling, and
    // `security.constants.ts`'s own module-level tests still assert 429 with their own explicit,
    // low, production-shaped limits, untouched by this variable.
    LOGIN_THROTTLE_RELAX_FACTOR: '40',
  };

  // T-078: a fresh Testcontainers instance has no `reward_app` role until this suite makes one —
  // T002_008_grants.ts's first statement (`GRANT ... TO reward_app`) is correct to assume it
  // already exists (true in every real, non-ephemeral environment) and fails loudly, not
  // silently, when it doesn't. Must run before db:migrate below. See `ensureAppRoleExists`'s own
  // header (utils/db.ts) for the full story, including why this is a no-op on the local fallback.
  console.log('[global-setup] ensuring the reward_app role exists…');
  await ensureAppRoleExists(db);

  console.log('[global-setup] running portal migrations (npm run db:migrate -w back-end)…');
  execFileSync('npm', ['run', 'db:migrate', '-w', 'back-end'], {
    cwd: PORTAL_ROOT,
    env: baseEnv,
    stdio: 'inherit',
  });

  console.log('[global-setup] seeding encryption_keys + reward_config reference rows…');
  await insertEncryptionKey(db, {
    kid: 'e2e-field-1',
    purpose: 'field',
    algorithm: 'AES-256-GCM',
    envVarName: 'E2E_FIELD_KEY',
  });
  await insertEncryptionKey(db, {
    kid: 'e2e-bidx-1',
    purpose: 'blind_index',
    algorithm: 'HMAC-SHA256',
    envVarName: 'E2E_BLIND_KEY',
  });
  const seedIds = await seedReferenceData(db);

  // Inherited T-057 TC-3 ("npm run build then npm start, no ts-node — the suite runs against the
  // built artefact at least once"): an explicit, opt-in mode rather than the default, since a
  // build step is real wall-clock cost the DoD's three-consecutive-run requirement does not need
  // paying on every run. `nest build` (T-057) already rewrites `@/*` path aliases to relative
  // requires in `dist/`, confirmed directly against this run's own build output — no
  // `tsconfig-paths/register` needed for the compiled artefact, unlike the `ts-node` path below.
  const useBuiltBackend = process.env.E2E_BACKEND_MODE === 'built';
  if (useBuiltBackend) {
    console.log(
      '[global-setup] E2E_BACKEND_MODE=built — building the back end ' +
        '(npm run build -w back-end), no ts-node this run (T-057 TC-3, inherited)…',
    );
    execFileSync('npm', ['run', 'build', '-w', 'back-end'], {
      cwd: PORTAL_ROOT,
      env: baseEnv,
      stdio: 'inherit',
    });
  }
  console.log(`[global-setup] starting the back end (${useBuiltBackend ? 'built dist/main.js' : 'ts-node'})…`);
  if (useBuiltBackend) {
    spawnProcess('node', ['dist/main.js'], {
      cwd: BACK_END_DIR,
      env: baseEnv,
      name: 'back-end',
    });
  } else {
    spawnProcess('npx', ['ts-node', '-T', '-r', 'tsconfig-paths/register', 'src/main.ts'], {
      cwd: BACK_END_DIR,
      env: baseEnv,
      name: 'back-end',
    });
  }
  const apiBaseURL = `http://localhost:${String(BACK_END_PORT)}/api/v1`;
  await waitForHttp(`${apiBaseURL}/health`, 90_000);
  console.log('[global-setup] back end is up.');

  console.log('[global-setup] starting the front end…');
  spawnProcess(
    'npx',
    ['vite', '--port', String(FRONT_END_PORT), '--strictPort'],
    { cwd: FRONT_END_DIR, env: { ...process.env }, name: 'front-end' },
  );
  const baseURL = `http://localhost:${String(FRONT_END_PORT)}`;
  await waitForHttp(baseURL, 60_000);
  console.log('[global-setup] front end is up.');

  console.log('[global-setup] bootstrapping the one super_admin, via the CLI (golden journey step 1)…');
  execFileSync('npm', ['run', 'bootstrap:superadmin', '-w', 'back-end'], {
    cwd: PORTAL_ROOT,
    env: {
      ...baseEnv,
      SUPERADMIN_EMAIL: SUPER_ADMIN_EMAIL,
      SUPERADMIN_NAME: SUPER_ADMIN_NAME,
      SUPERADMIN_PASSWORD: SUPER_ADMIN_TEMP_PASSWORD,
    },
    stdio: 'inherit',
  });

  // T-055/T-060/T-024: complete the MFA enrolment and the forced password change **once, here**,
  // through a real, headless browser — this file's own header explains why this must be the one
  // real "first login" for the whole run, and why it is honoured through the actual `/login` →
  // `/mfa-challenge` → `/change-password` screens rather than the raw API this block used to call
  // directly. This is still a deliberate, reported deviation from T-050's literal golden-journey
  // step 1 wording (AGENT-PROTOCOL §3) — the *assertion* that step 1 happened lives here, once,
  // for the whole run, rather than inside `golden-journey.spec.ts` itself — forced by "exactly one
  // super_admin may ever exist" (`bootstrap-superadmin.ts` rule 1) colliding with "every spec runs
  // isolated, in parallel".
  console.log(
    '[global-setup] completing super_admin first login + MFA enrolment through a real, headless ' +
      'browser (T-060 TC-1, inherited)…',
  );
  const mfaResult = await mfaEnrolSuperAdminThroughBrowser(baseURL);
  const superAdminCookies = mfaResult.cookies;
  const bootstrapSession = await sessionFromCookies(apiBaseURL, superAdminCookies);

  // The two shared scenarios every spec reads from (`utils/state.ts`'s own header on `scenario`
  // and `isolatedScenario`) — built here, once each, on the same already-authenticated
  // `bootstrapSession`, rather than per worker or per test. See those headers for the measured
  // `LOGIN_PER_IP_LIMIT` reasoning.
  const scenarioContext = {
    apiBaseURL,
    db,
    seedData: {
      ruleSubCategoryId: seedIds.ruleSubCategoryId,
      activityTypeId: seedIds.activityTypeId,
    },
  };
  console.log('[global-setup] building the one shared scenario…');
  const scenario = await buildScenario(scenarioContext, bootstrapSession);
  console.log('[global-setup] building the one shared, isolated scenario (TC-N4/TC-N9)…');
  const isolatedScenario = await buildScenario(scenarioContext, bootstrapSession);
  await bootstrapSession.dispose();

  writeState({
    baseURL,
    apiBaseURL,
    db,
    superAdmin: {
      email: SUPER_ADMIN_EMAIL,
      password: SUPER_ADMIN_PASSWORD,
      totpSecretBase32: mfaResult.totpSecretBase32,
      cookies: superAdminCookies,
    },
    jwtKeys: {
      privatePem: privateKey,
      publicPem: publicKey,
    },
    seedData: {
      ruleSubCategoryId: seedIds.ruleSubCategoryId,
      activityCategoryId: seedIds.activityCategoryId,
      activityTypeId: seedIds.activityTypeId,
    },
    scenario,
    isolatedScenario,
    pids: {
      backEnd: spawned[0]?.pid ?? 0,
      frontEnd: spawned[1]?.pid ?? 0,
    },
    dbStrategy: provisioned.strategy,
    containerId: provisioned.strategy === 'container' ? provisioned.containerId : null,
  });

  console.log('[global-setup] ready.');
}
