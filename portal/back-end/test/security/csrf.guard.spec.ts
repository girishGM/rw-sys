/**
 * T-012 — the double-submit CSRF guard. Evidences TC-7, TC-8, TC-9, TC-10 and TC-11.
 *
 * The guard is exercised over real HTTP against a real `TokenService`, because the value it
 * compares against is an HMAC that service derives: a test that stubbed the expected token
 * would be testing `timingSafeEqual` rather than testing CSRF.
 *
 * `POST /probe` stands in for `POST /auth/logout` and `GET /probe` for `GET /me`. TC-7…TC-10
 * are phrased against those two routes; `/me` belongs to T-015 and does not exist yet, and
 * mounting `AuthController` here would drag in the credential and session stores to test a
 * guard that never looks at either. What the test cases are about — a mutating route and a safe
 * route behind the global guard — is exactly what these two probes are.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Delete, Get, Patch, Post, Put, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ExecutionContext } from '@nestjs/common';
import request from 'supertest';
import { CsrfGuard, constantTimeEquals } from '@/common/security/csrf.guard';
import { asExpressApplication, configureHttpSecurity } from '@/common/security/security.middleware';
import { bindTestServer } from './support/bound-app';
import { TokenService } from '@/modules/auth/services/token.service';
import {
  ACCESS_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
} from '@/modules/auth/session.constants';
import { fakeConfigService, generateTestKeyPair } from '../auth/support/test-keys';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';

@Controller()
class ProbeController {
  @Get('probe')
  read(): { data: string } {
    return { data: 'read' };
  }

  @Post('probe')
  create(): { data: string } {
    return { data: 'created' };
  }

  @Put('probe')
  replace(): { data: string } {
    return { data: 'replaced' };
  }

  @Patch('probe')
  amend(): { data: string } {
    return { data: 'amended' };
  }

  @Delete('probe')
  remove(): { data: string } {
    return { data: 'removed' };
  }
}

let app: INestApplication;
let tokens: TokenService;
/**
 * T-087: one listener, bound once, for all 15 cases below.
 *
 * `request(app.getHttpServer())` on an app that only ever called `init()` makes supertest
 * `listen(0)`/`close()` a *fresh* ephemeral port per request. The port is captured in the `Test`
 * constructor and the listener closed once the response lands, so under the port pressure of a
 * parallel Jest run the address can be rebound by another listener between those two moments —
 * and the answer then comes from a different server. In a CSRF suite that matters more than
 * most: a stray listener answering 200 where the guard would have said 403 reads exactly like a
 * bypass, and one answering 404 where the guard would have said 403 hides one. See
 * `support/bound-app.ts` for the full diagnosis.
 */
let base: string;

function buildTokenService(): TokenService {
  const keys = generateTestKeyPair();
  return new TokenService(
    fakeConfigService({ JWT_PRIVATE_KEY: keys.privateKey, JWT_PUBLIC_KEY: keys.publicKey }),
  );
}

/** A cookie header for a live session, exactly as the browser would send it. */
function sessionCookies(options: { csrf?: boolean; refresh?: boolean } = {}): string {
  const accessToken = tokens.signAccessToken(
    {
      userId: 42,
      sessionId: SESSION_ID,
      role: 'maker',
      countryId: 1,
      tenantId: 2,
      merchantId: null,
      rbacVersion: 1,
    },
    new Date(),
  ).token;

  const parts = [`${ACCESS_COOKIE_NAME}=${encodeURIComponent(accessToken)}`];
  if (options.csrf === true) {
    parts.push(`${CSRF_COOKIE_NAME}=${encodeURIComponent(tokens.csrfTokenFor(SESSION_ID))}`);
  }
  if (options.refresh === true) {
    parts.push(`${REFRESH_COOKIE_NAME}=opaque-refresh-value`);
  }
  return parts.join('; ');
}

beforeAll(async () => {
  tokens = buildTokenService();

  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
    providers: [
      { provide: TokenService, useValue: tokens },
      CsrfGuard,
      { provide: APP_GUARD, useExisting: CsrfGuard },
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestExpressApplication>();
  app.setGlobalPrefix('api/v1');
  configureHttpSecurity(asExpressApplication(app), {
    apiOrigin: '',
    corsAllowedOrigins: undefined,
    trustProxy: undefined,
    enforceHttps: false,
  });
  await app.init();
  base = await bindTestServer(app);
});

afterAll(async () => {
  await app.close();
});

describe('mutating requests with a session', () => {
  it('TC-7: no X-CSRF-Token header at all → 403 CSRF_TOKEN_MISSING', async () => {
    const response = await request(base)
      .post('/api/v1/probe')
      .set('Cookie', sessionCookies())
      .expect(403);

    expect(response.body).toEqual({ error: { code: 'CSRF_TOKEN_MISSING' } });
  });

  it('TC-8: a mismatched token → 403 CSRF_TOKEN_INVALID', async () => {
    const response = await request(base)
      .post('/api/v1/probe')
      .set('Cookie', sessionCookies({ csrf: true }))
      .set('X-CSRF-Token', 'not-the-right-value')
      .expect(403);

    expect(response.body).toEqual({ error: { code: 'CSRF_TOKEN_INVALID' } });
  });

  it('TC-9: the matching token → the request proceeds', async () => {
    const response = await request(base)
      .post('/api/v1/probe')
      .set('Cookie', sessionCookies({ csrf: true }))
      .set('X-CSRF-Token', tokens.csrfTokenFor(SESSION_ID))
      .expect(201);

    expect(response.body).toEqual({ data: 'created' });
  });

  it('rejects an empty header the same way as a missing one', async () => {
    const response = await request(base)
      .post('/api/v1/probe')
      .set('Cookie', sessionCookies())
      .set('X-CSRF-Token', '')
      .expect(403);

    expect(response.body).toEqual({ error: { code: 'CSRF_TOKEN_MISSING' } });
  });

  it('rejects another session’s token — the value is bound to this sid', async () => {
    const otherSessionToken = tokens.csrfTokenFor('99999999-8888-4777-8666-555555555555');

    await request(base)
      .post('/api/v1/probe')
      .set('Cookie', sessionCookies({ csrf: true }))
      .set('X-CSRF-Token', otherSessionToken)
      .expect(403);
  });

  it('ignores the rs_csrf cookie when a verified session is present (cookie injection)', async () => {
    // An attacker who can *set* a cookie on a sibling subdomain can forge a matching
    // cookie/header pair. The session-bound HMAC is what makes that useless.
    const forged = 'forged-cookie-and-header';
    const cookies = `${sessionCookies()}; ${CSRF_COOKIE_NAME}=${forged}`;

    const response = await request(base)
      .post('/api/v1/probe')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', forged)
      .expect(403);

    expect(response.body).toEqual({ error: { code: 'CSRF_TOKEN_INVALID' } });
  });

  it.each(['put', 'patch', 'delete'] as const)('applies to %s as well as post', async (method) => {
    await request(base)[method]('/api/v1/probe').set('Cookie', sessionCookies()).expect(403);

    await request(base)
      [method]('/api/v1/probe')
      .set('Cookie', sessionCookies())
      .set('X-CSRF-Token', tokens.csrfTokenFor(SESSION_ID))
      .expect(200);
  });
});

describe('safe methods', () => {
  it('TC-10: GET with no CSRF token is 200 — GET is exempt', async () => {
    const response = await request(base)
      .get('/api/v1/probe')
      .set('Cookie', sessionCookies())
      .expect(200);

    expect(response.body).toEqual({ data: 'read' });
  });

  it('HEAD is exempt too', async () => {
    await request(base).head('/api/v1/probe').set('Cookie', sessionCookies()).expect(200);
  });
});

describe('requests without a verified session', () => {
  it('lets a credential-less mutating request through (login has nothing to double-submit)', async () => {
    await request(base).post('/api/v1/probe').expect(201);
  });

  it('falls back to the rs_csrf cookie when there is no verified session (refresh)', async () => {
    const csrf = tokens.csrfTokenFor(SESSION_ID);
    const cookies = `${REFRESH_COOKIE_NAME}=opaque; ${CSRF_COOKIE_NAME}=${csrf}`;

    await request(base).post('/api/v1/probe').set('Cookie', cookies).expect(403);

    await request(base)
      .post('/api/v1/probe')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrf)
      .expect(201);
  });

  it('treats an expired access token as no session and falls back to the cookie', async () => {
    const expired = tokens.signAccessToken(
      {
        userId: 42,
        sessionId: SESSION_ID,
        role: 'maker',
        countryId: null,
        tenantId: null,
        merchantId: null,
        rbacVersion: 1,
      },
      new Date(Date.now() - 60 * 60 * 1000),
    ).token;
    const csrf = tokens.csrfTokenFor(SESSION_ID);

    await request(base)
      .post('/api/v1/probe')
      .set('Cookie', `${ACCESS_COOKIE_NAME}=${expired}; ${CSRF_COOKIE_NAME}=${csrf}`)
      .set('X-CSRF-Token', csrf)
      .expect(201);
  });

  it('treats a forged access token as no session rather than failing open on a 500', async () => {
    await request(base)
      .post('/api/v1/probe')
      .set('Cookie', `${ACCESS_COOKIE_NAME}=not.a.token; ${CSRF_COOKIE_NAME}=abc`)
      .set('X-CSRF-Token', 'abc')
      .expect(201);
  });
});

describe('the guard reuses an identity a previous guard established', () => {
  it('prefers request.authUser over re-verifying the cookie', () => {
    const guard = new CsrfGuard(tokens);
    const verify = jest.spyOn(tokens, 'verifyAccessToken');

    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          headers: { 'x-csrf-token': tokens.csrfTokenFor(SESSION_ID) },
          authUser: { userId: 42, sessionId: SESSION_ID },
        }),
      }),
    } as unknown as ExecutionContext;

    expect(guard.canActivate(context)).toBe(true);
    expect(verify).not.toHaveBeenCalled();
    verify.mockRestore();
  });
});

describe('TC-11: the comparison is timing-safe, not ===', () => {
  it('uses crypto.timingSafeEqual', () => {
    // The guard's `import { timingSafeEqual }` compiles to a property access on the module
    // object, so replacing that property intercepts the real call site. Done by hand rather
    // than with `jest.spyOn`, which cannot redefine a non-configurable native export.
    const crypto = jest.requireActual<typeof import('node:crypto')>('node:crypto');
    const original = crypto.timingSafeEqual;
    const calls: number[] = [];
    Object.defineProperty(crypto, 'timingSafeEqual', {
      configurable: true,
      value: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
        calls.push(a.byteLength);
        return original(a, b);
      },
    });

    try {
      expect(constantTimeEquals('abcdef', 'abcdef')).toBe(true);
      expect(calls).toEqual([6]);
    } finally {
      Object.defineProperty(crypto, 'timingSafeEqual', { configurable: true, value: original });
    }
  });

  it('returns false for a length mismatch instead of throwing', () => {
    // `timingSafeEqual` throws a RangeError on unequal lengths; without the length guard a
    // wrong-length header would be a 500 rather than a 403.
    expect(() => constantTimeEquals('short', 'a-much-longer-value')).not.toThrow();
    expect(constantTimeEquals('short', 'a-much-longer-value')).toBe(false);
    expect(constantTimeEquals('', 'x')).toBe(false);
  });

  it('compares equal and unequal same-length values correctly', () => {
    expect(constantTimeEquals('abcdef', 'abcdef')).toBe(true);
    expect(constantTimeEquals('abcdef', 'abcdeg')).toBe(false);
  });

  it('is not implemented with === (source check)', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', 'src', 'common', 'security', 'csrf.guard.ts'),
      'utf8',
    );

    expect(source).toContain('timingSafeEqual');
    expect(source).not.toMatch(/presented\s*===\s*expected/);
  });
});
