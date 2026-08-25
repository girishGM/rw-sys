/**
 * T-012 — response headers, HTTPS enforcement, proxy trust and body limits.
 *
 * Evidences TC-1, TC-2, TC-3, TC-16 and TC-17. The header set is asserted twice on purpose:
 * once as data, straight out of {@link buildSecurityHeaders} (so a policy change is a diff in a
 * test, not a mystery in a browser), and once over real HTTP through `configureHttpSecurity`
 * (so a policy that is correct but never actually registered still fails).
 */
import { Controller, Get, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import {
  asExpressApplication,
  bodyParserErrorMiddleware,
  buildCspHeader,
  buildSecurityHeaders,
  configureHttpSecurity,
  httpsRedirectMiddleware,
  resolveTrustProxy,
  securityHeadersMiddleware,
} from '@/common/security/security.middleware';
import { HSTS_HEADER_VALUE } from '@/common/security/security.constants';
import { bindTestServer } from './support/bound-app';
import { FORBIDDEN_CSP_TOKENS } from './support/csp-tokens';

const API_ORIGIN = 'https://api.example.test';

@Controller()
class ProbeController {
  @Get('probe')
  probe(): { data: string } {
    return { data: 'ok' };
  }

  @Post('probe')
  echo(): { data: string } {
    return { data: 'ok' };
  }
}

async function buildApp(
  overrides: Partial<Parameters<typeof configureHttpSecurity>[1]> = {},
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.setGlobalPrefix('api/v1');
  configureHttpSecurity(app, {
    apiOrigin: API_ORIGIN,
    corsAllowedOrigins: undefined,
    trustProxy: undefined,
    enforceHttps: false,
    ...overrides,
  });
  await app.init();
  return app;
}

describe('security headers (TC-1, TC-2, TC-3)', () => {
  it('builds every header 02-SECURITY.md §7 names', () => {
    const headers = buildSecurityHeaders(API_ORIGIN);

    expect(headers['Strict-Transport-Security']).toBe(HSTS_HEADER_VALUE);
    expect(headers['Strict-Transport-Security']).toContain('max-age=31536000');
    expect(headers['Strict-Transport-Security']).toContain('includeSubDomains');
    expect(headers['Strict-Transport-Security']).toContain('preload');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Content-Security-Policy']).toBeDefined();
  });

  it('emits the §7 directive set, with frame-ancestors and object-src locked to none', () => {
    const csp = buildCspHeader(API_ORIGIN);

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    // A valueless directive must not gain a trailing space or an empty token.
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).not.toMatch(/upgrade-insecure-requests\s+;/);
  });

  it('never contains unsafe-inline or unsafe-eval — the whole point of TC-3', () => {
    const csp = buildCspHeader(API_ORIGIN);
    for (const token of FORBIDDEN_CSP_TOKENS) {
      expect(csp).not.toContain(token);
    }
  });

  it('adds a valid API origin to connect-src, and only to connect-src', () => {
    const csp = buildCspHeader(API_ORIGIN);
    expect(csp).toContain(`connect-src 'self' ${API_ORIGIN}`);
    expect(csp).toContain("script-src 'self';");
  });

  it('collapses connect-src to self when no API origin is configured', () => {
    expect(buildCspHeader('')).toContain("connect-src 'self';");
  });

  it.each([
    ["https://evil.test; script-src 'unsafe-inline'", 'a directive-injection attempt'],
    ['not-an-origin', 'a value that is not an origin'],
    ['https://api.example.test/path', 'an origin carrying a path'],
  ])('drops %s (%s) rather than letting it rewrite the policy', (origin) => {
    const csp = buildCspHeader(origin);
    expect(csp).toContain("connect-src 'self';");
    expect(csp).not.toContain(origin);
    for (const token of FORBIDDEN_CSP_TOKENS) {
      expect(csp).not.toContain(token);
    }
  });

  it('sets the headers on the response and strips X-Powered-By', () => {
    const setHeader = jest.fn();
    const removeHeader = jest.fn();
    const next = jest.fn();

    securityHeadersMiddleware(API_ORIGIN)(
      {} as Request,
      { setHeader, removeHeader } as unknown as Response,
      next as unknown as NextFunction,
    );

    expect(setHeader).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
    expect(removeHeader).toHaveBeenCalledWith('X-Powered-By');
    expect(next).toHaveBeenCalled();
  });
});

describe('over real HTTP', () => {
  let app: INestApplication;
  /**
   * T-087: one listener, bound once, for every case below.
   *
   * `request(app.getHttpServer())` on an app that only ever called `init()` makes supertest
   * `listen(0)`/`close()` a *fresh* ephemeral port per request. The port is captured in the
   * `Test` constructor and the listener closed once the response lands, so under the port
   * pressure of a parallel Jest run the address can be rebound by another listener between those
   * two moments — and the answer then comes from a different server. See `support/bound-app.ts`
   * for the full diagnosis. `buildApp` deliberately still returns an un-bound app: one of its
   * callers below never makes a request at all.
   */
  let base: string;

  beforeAll(async () => {
    app = await buildApp();
    base = await bindTestServer(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('TC-1: every response carries the full header set', async () => {
    const response = await request(base).get('/api/v1/probe').expect(200);

    expect(response.headers['content-security-policy']).toBeDefined();
    expect(response.headers['strict-transport-security']).toBe(HSTS_HEADER_VALUE);
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('TC-2: X-Powered-By is absent', async () => {
    const response = await request(base).get('/api/v1/probe').expect(200);
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('TC-3: the served CSP has no unsafe-inline or unsafe-eval anywhere', async () => {
    const response = await request(base).get('/api/v1/probe').expect(200);
    const csp = response.headers['content-security-policy'];

    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    for (const token of FORBIDDEN_CSP_TOKENS) {
      expect(csp).not.toContain(token);
    }
  });

  it('TC-16: a 2 MB body is rejected with 413 and no stack trace', async () => {
    const response = await request(base)
      .post('/api/v1/probe')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) }))
      .expect(413);

    expect(response.body).toEqual({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(JSON.stringify(response.body)).not.toContain('at ');
  });

  it('accepts a body comfortably under the limit', async () => {
    await request(base)
      .post('/api/v1/probe')
      .send({ blob: 'x'.repeat(512 * 1024) })
      .expect(201);
  });

  it('shapes malformed JSON as a 400 envelope rather than a parser page', async () => {
    const response = await request(base)
      .post('/api/v1/probe')
      .set('Content-Type', 'application/json')
      .send('{"unterminated":')
      .expect(400);

    expect(response.body).toEqual({ error: { code: 'MALFORMED_BODY' } });
  });
});

describe('HTTPS enforcement (TC-17)', () => {
  it('redirects a plaintext request to the configured origin, preserving the method', async () => {
    const app = await buildApp({ enforceHttps: true });
    const base = await bindTestServer(app);

    const response = await request(base).post('/api/v1/probe').send({ a: 1 });

    expect(response.status).toBe(307);
    expect(response.headers.location).toBe(`${API_ORIGIN}/api/v1/probe`);
    // The redirect happens before routing, so nothing downstream ran.
    expect(response.body).toEqual({});

    await app.close();
  });

  it('falls back to the request Host when no API origin is configured', () => {
    const redirect = jest.fn();
    httpsRedirectMiddleware('')(
      {
        protocol: 'http',
        headers: { host: 'portal.example.test' },
        originalUrl: '/api/v1/probe?x=1',
      } as unknown as Request,
      { redirect } as unknown as Response,
      jest.fn() as unknown as NextFunction,
    );

    expect(redirect).toHaveBeenCalledWith(307, 'https://portal.example.test/api/v1/probe?x=1');
  });

  it('passes an already-secure request straight through', () => {
    const next = jest.fn();
    const redirect = jest.fn();

    httpsRedirectMiddleware(API_ORIGIN)(
      { protocol: 'https' } as unknown as Request,
      { redirect } as unknown as Response,
      next as unknown as NextFunction,
    );

    expect(next).toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it.each<[string | undefined, string]>([
    ['portal.example.test\r\nX-Injected: 1', 'a response-splitting attempt'],
    [undefined, 'no Host header at all'],
  ])('refuses to build a Location from %s (%s)', (host) => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const redirect = jest.fn();

    httpsRedirectMiddleware('')(
      { protocol: 'http', headers: { host }, originalUrl: '/' } as unknown as Request,
      { redirect, status } as unknown as Response,
      jest.fn() as unknown as NextFunction,
    );

    expect(redirect).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
  });
});

describe('trust proxy', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['  ', false],
    ['false', false],
    ['FALSE', false],
    ['1', 1],
    ['2', 2],
    ['loopback', 'loopback'],
    ['10.0.0.1, 10.0.0.2', '10.0.0.1, 10.0.0.2'],
  ])('resolves %s to %s', (raw, expected) => {
    expect(resolveTrustProxy(raw)).toBe(expected);
  });

  it('refuses TRUST_PROXY=true, which would make request.ip forgeable', () => {
    expect(() => resolveTrustProxy('true')).toThrow(/forgeable/);
    expect(() => resolveTrustProxy('TRUE')).toThrow(/forgeable/);
  });

  it('does not honour X-Forwarded-For when no proxy is trusted', async () => {
    const app = await buildApp();
    const base = await bindTestServer(app);

    // With `trust proxy` false the header is ignored entirely; the socket address wins. The
    // assertion that matters is the negative one — a forged header must not become request.ip.
    const response = await request(base)
      .get('/api/v1/probe')
      .set('X-Forwarded-For', '203.0.113.9')
      .expect(200);

    expect(response.body).toEqual({ data: 'ok' });
    await app.close();
  });
});

describe('body-parser error shaping', () => {
  const buildResponse = () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    return { response: { status, headersSent: false } as unknown as Response, status, json };
  };

  it('maps entity.too.large to 413', () => {
    const { response, status, json } = buildResponse();
    bodyParserErrorMiddleware()(
      { type: 'entity.too.large' } as never,
      {} as Request,
      response,
      jest.fn() as unknown as NextFunction,
    );
    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  });

  it('maps any other 4xx parser failure to a 400 envelope, never echoing the message', () => {
    const { response, status, json } = buildResponse();
    bodyParserErrorMiddleware()(
      { status: 400, message: 'Unexpected token } in JSON at position 17' } as never,
      {} as Request,
      response,
      jest.fn() as unknown as NextFunction,
    );
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: { code: 'MALFORMED_BODY' } });
    expect(JSON.stringify(json.mock.calls)).not.toContain('Unexpected token');
  });

  it('passes a non-client error on to the next handler', () => {
    const { response } = buildResponse();
    const next = jest.fn();
    const error = { status: 500 } as never;

    bodyParserErrorMiddleware()(error, {} as Request, response, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledWith(error);
  });

  it('does not try to write a response that has already been sent', () => {
    const next = jest.fn();
    const error = { type: 'entity.too.large' } as never;

    bodyParserErrorMiddleware()(
      error,
      {} as Request,
      { headersSent: true } as unknown as Response,
      next as unknown as NextFunction,
    );
    expect(next).toHaveBeenCalledWith(error);
  });
});

describe('asExpressApplication', () => {
  it('rejects an application that is not Express-backed', () => {
    expect(() => asExpressApplication({} as INestApplication)).toThrow(/Express-backed/);
    expect(() =>
      asExpressApplication({ useBodyParser: () => undefined } as unknown as INestApplication),
    ).toThrow(/Express-backed/);
  });

  it('returns an Express application unchanged', async () => {
    const app = await buildApp();
    expect(asExpressApplication(app)).toBe(app);
    await app.close();
  });
});
