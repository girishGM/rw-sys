/**
 * T-051 TC-3 — **the session cookies, judged by a real browser's own cookie jar.**
 *
 * ## Why this cannot be done with supertest, and why that is the whole point
 *
 * AGENT-PROTOCOL §3 names this exact test as the cautionary tale of the project:
 *
 * > T-011 shipped a refresh cookie every browser silently rejects (`__Host-` with a non-root
 * > path), with **full unit, HTTP and e2e coverage green** — because its TC-3 asserted the literal
 * > string `Path=/api/v1/auth`, and `curl`/`supertest` do not implement cookie-prefix rules.
 * > Code, test and spec agreed perfectly with each other and with nothing real.
 *
 * A `Set-Cookie` header is a *request* to store a cookie. Whether it is honoured is decided by the
 * client, against RFC 6265bis §4.1.3 — and supertest has no cookie jar at all, so it will happily
 * report a header that Chrome discards on sight. So this file asserts the **outcome**: it boots the
 * real application on a real port, drives a real Chromium at it, performs a real login from a page
 * context, and then reads `BrowserContext.cookies()` — the jar itself, after the browser has
 * applied every prefix rule, `Secure` rule and `SameSite` rule it enforces in production.
 *
 * If the `__Host-` contract were violated again in any of the three ways it can be (a `Domain`
 * attribute, a non-root `Path`, or a missing `Secure`), the cookie would simply not be in that
 * jar, and every assertion below would fail — regardless of what the header said.
 *
 * ## Why `http://127.0.0.1` is a valid place to test `Secure` cookies
 *
 * `Secure` normally requires HTTPS, which would make this test need a certificate. It does not:
 * browsers class loopback as a *trustworthy origin* (W3C Secure Contexts §3.1), so Chromium
 * accepts and stores `Secure` cookies — including `__Host-`-prefixed ones — over plain HTTP to
 * `127.0.0.1`, while still enforcing every other prefix rule. That is what makes a real-browser
 * assertion possible here at all, and it is why the loopback address is used deliberately rather
 * than as a convenience.
 */
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import {
  ACCESS_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
} from '@/modules/auth/session.constants';
import { asExpressApplication, configureHttpSecurity } from '@/common/security/security.middleware';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import { FORBIDDEN_CSP_TOKENS } from './support/csp-tokens';

jest.setTimeout(300_000);

const SUITE = 't051ck';
const EMAIL = 't051-cookie-flags@example.invalid';
const PASSWORD = 'correct horse battery staple 7!';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let browser: Browser;
let context: BrowserContext;
let origin: string;

interface JarCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
  expires: number;
}

let jar: JarCookie[];

function cookie(name: string): JarCookie {
  const found = jar.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(
      `Chromium did not store "${name}". Cookies actually in the jar: ` +
        `${jar.map((entry) => entry.name).join(', ') || '(none)'}. ` +
        'A __Host- cookie is dropped silently when it carries a Domain, a non-root Path, or no Secure.',
    );
  }
  return found;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), SUITE);

  app = moduleRef.createNestApplication<NestExpressApplication>();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  configureHttpSecurity(asExpressApplication(app), {
    apiOrigin: process.env.API_ORIGIN ?? 'https://api.t051.example.test',
    corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS,
    trustProxy: undefined,
    enforceHttps: false,
  });

  // A real listener on a real port — `app.getHttpServer()` alone is not reachable by a browser.
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (address === null || typeof address === 'string') throw new Error('no bound port');
  origin = `http://127.0.0.1:${address.port}`;

  db = app.get<Sequelize>(SEQUELIZE);
  emailCrypto = emailCryptoOf(app);

  await deletePortalUsersByEmail(db, emailCrypto, [EMAIL]);

  const [country] = await db.query<{ id: number }>(
    `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code, status)
     VALUES ('ZK', 'T-051 cookies', 'UTC', 'USD', '+000', 'active')
     ON CONFLICT (code) DO UPDATE SET status = 'active' RETURNING id`,
    { type: QueryTypes.SELECT },
  );
  const [tenant] = await db.query<{ id: number }>(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES ('T051_CK', 'T051_CK', :countryId, 'active')
     ON CONFLICT (code) DO UPDATE SET status = 'active', deleted_at = NULL RETURNING id`,
    { type: QueryTypes.SELECT, replacements: { countryId: country.id } },
  );

  const userId = await insertPortalUser(db, emailCrypto, {
    email: EMAIL,
    displayName: 'T-051 cookie flags',
    role: 'maker',
    countryId: country.id,
    tenantId: tenant.id,
    merchantId: null,
  });
  await db.query(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    {
      type: QueryTypes.INSERT,
      replacements: { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
    },
  );

  browser = await chromium.launch();
  context = await browser.newContext();
  const page = await context.newPage();

  // Same-origin navigation first, so the subsequent `fetch` is same-origin and `SameSite=Strict`
  // cookies are stored exactly as they would be for the real SPA.
  await page.goto(`${origin}/api/v1/health`);

  const status = await page.evaluate(
    async ([base, email, password]) => {
      const response = await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      return response.status;
    },
    [origin, EMAIL, PASSWORD],
  );
  expect(status).toBe(200);

  jar = (await context.cookies()) as unknown as JarCookie[];
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  if (db !== undefined) {
    await deletePortalUsersByEmail(db, emailCrypto, [EMAIL]);
    await removeEncryptionKeys(db, SUITE);
  }
  await app?.close();
});

describe('TC-3: the browser actually stored the session cookies', () => {
  it('stored all three — the login was not silently discarded', () => {
    // The T-058 failure mode in one assertion: the refresh cookie was being *sent* and *dropped*.
    expect(jar.map((entry) => entry.name).sort()).toEqual(
      [ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME].sort(),
    );
  });

  it('names the two session cookies with the __Host- prefix', () => {
    expect(ACCESS_COOKIE_NAME).toMatch(/^__Host-/);
    expect(REFRESH_COOKIE_NAME).toMatch(/^__Host-/);
  });
});

describe('TC-3: the access cookie', () => {
  it('is httpOnly, Secure, SameSite=Strict and Path=/', () => {
    const access = cookie(ACCESS_COOKIE_NAME);

    expect(access.httpOnly).toBe(true);
    expect(access.secure).toBe(true);
    expect(access.sameSite).toBe('Strict');
    // `__Host-` mandates this; Chromium storing the cookie at all already proves it, and this
    // states it so a reader does not have to know the rule.
    expect(access.path).toBe('/');
  });

  it('is host-locked — no Domain attribute, so no subdomain can claim it', () => {
    // A `__Host-` cookie may not carry `Domain`. Chromium reports a host-only cookie's domain
    // without the leading dot a domain cookie would have.
    expect(cookie(ACCESS_COOKIE_NAME).domain).toBe('127.0.0.1');
    expect(cookie(ACCESS_COOKIE_NAME).domain.startsWith('.')).toBe(false);
  });
});

describe('TC-3: the refresh cookie — the one T-058 was filed for', () => {
  it('is httpOnly, Secure, SameSite=Strict', () => {
    const refresh = cookie(REFRESH_COOKIE_NAME);

    expect(refresh.httpOnly).toBe(true);
    expect(refresh.secure).toBe(true);
    expect(refresh.sameSite).toBe('Strict');
  });

  it('has Path=/ and not the /api/v1/auth that a __Host- cookie forbids', () => {
    // The precise regression T-058 fixed. Asserted as the browser's stored value, not as a
    // substring of a header — the header was *always* what the old test said it was.
    const refresh = cookie(REFRESH_COOKIE_NAME);

    expect(refresh.path).toBe('/');
    expect(refresh.path).not.toBe('/api/v1/auth');
  });

  it('is host-locked', () => {
    expect(cookie(REFRESH_COOKIE_NAME).domain).toBe('127.0.0.1');
  });
});

describe('TC-3 / R5: what JavaScript can and cannot read', () => {
  it('hides both session cookies from document.cookie', async () => {
    const page = await context.newPage();
    await page.goto(`${origin}/api/v1/health`);
    // Evaluated as a source string rather than a closure: this package's tsconfig has no `dom`
    // lib (it is a Node service), so a `document` reference would not type-check — and widening
    // the shared tsconfig for one test would be the wrong trade.
    const visible = (await page.evaluate('document.cookie')) as string;
    await page.close();

    // The XSS containment property of 02-SECURITY.md §1: an attacker running script in the page
    // cannot walk away with the session.
    expect(visible).not.toContain(ACCESS_COOKIE_NAME);
    expect(visible).not.toContain(REFRESH_COOKIE_NAME);
  });

  it('exposes only the CSRF cookie to JavaScript, by design', () => {
    const csrf = cookie(CSRF_COOKIE_NAME);

    // Deliberately readable — the SPA's interceptor mirrors it into `X-CSRF-Token` (§1, §4).
    expect(csrf.httpOnly).toBe(false);
    expect(csrf.secure).toBe(true);
    expect(csrf.sameSite).toBe('Strict');
  });

  it('makes the CSRF cookie readable in the page, confirming the split is real', async () => {
    const page = await context.newPage();
    await page.goto(`${origin}/api/v1/health`);
    // Evaluated as a source string rather than a closure: this package's tsconfig has no `dom`
    // lib (it is a Node service), so a `document` reference would not type-check — and widening
    // the shared tsconfig for one test would be the wrong trade.
    const visible = (await page.evaluate('document.cookie')) as string;
    await page.close();

    // Without this, the previous test would also pass if *no* cookie were readable — which would
    // break the SPA rather than secure it.
    expect(visible).toContain(CSRF_COOKIE_NAME);
  });
});

describe('TC-3: the access cookie is short-lived', () => {
  it('expires in about 15 minutes, not at the end of the session', () => {
    const access = cookie(ACCESS_COOKIE_NAME);
    const secondsFromNow = access.expires - Date.now() / 1000;

    // 02-SECURITY.md §1: 15 minutes. Asserted as a range, because the clock moves between the
    // server writing the cookie and this line reading it.
    expect(secondsFromNow).toBeGreaterThan(13 * 60);
    expect(secondsFromNow).toBeLessThanOrEqual(15 * 60 + 30);
  });

  it('gives the refresh cookie the 7-day lifetime', () => {
    const refresh = cookie(REFRESH_COOKIE_NAME);
    const daysFromNow = (refresh.expires - Date.now() / 1000) / 86_400;

    expect(daysFromNow).toBeGreaterThan(6.9);
    expect(daysFromNow).toBeLessThanOrEqual(7.01);
  });
});

describe('TC-16 / §7: security headers as the browser receives them', () => {
  it('serves a CSP with no unsafe-inline and no unsafe-eval', async () => {
    const page = await context.newPage();
    const response = await page.goto(`${origin}/api/v1/health`);
    const headers = response?.headers() ?? {};
    await page.close();

    const csp = headers['content-security-policy'];
    expect(csp).toBeDefined();
    for (const forbidden of FORBIDDEN_CSP_TOKENS) {
      expect(csp).not.toContain(forbidden);
    }
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('sets the rest of §7’s header set', async () => {
    const page = await context.newPage();
    const response = await page.goto(`${origin}/api/v1/health`);
    const headers = response?.headers() ?? {};
    await page.close();

    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']?.toLowerCase()).toBe('deny');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    // `x-powered-by` is disabled in main.ts — it names the framework and version to an attacker.
    expect(headers['x-powered-by']).toBeUndefined();
  });
});
