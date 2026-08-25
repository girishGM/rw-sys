/**
 * T-012 — the CORS allowlist. Evidences TC-4, TC-5 and TC-6.
 *
 * TC-6 ("CORS config inspected for `*` or `origin:true`") is implemented as a **source scan** as
 * well as a behavioural assertion. That is unusual and deliberate: the behavioural test proves
 * today's configuration rejects `https://evil.com`, but a future edit could add `origin: true`
 * as a "temporary" development affordance and still pass it, because a permissive config
 * happily allows the origins an exact allowlist would also have allowed. Reading the file is
 * the only check that catches the widening itself.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  buildCorsOptions,
  CorsConfigurationError,
  parseAllowedOrigins,
} from '@/common/security/cors.config';
import { asExpressApplication, configureHttpSecurity } from '@/common/security/security.middleware';
import { bindTestServer } from './support/bound-app';

const ALLOWED = 'https://portal.example.test';
const EVIL = 'https://evil.com';

@Controller()
class ProbeController {
  @Get('probe')
  probe(): { data: string } {
    return { data: 'ok' };
  }
}

type OriginDecision = boolean | undefined;

/** Drives the `origin` callback the `cors` package would call. */
function decide(origin: string | undefined, allowlist: readonly string[]): OriginDecision {
  const options = buildCorsOptions(allowlist);
  let decision: OriginDecision;
  const originOption = options.origin;
  if (typeof originOption !== 'function') throw new Error('origin must be a callback');

  originOption(origin as string, (_error, allow) => {
    decision = allow as boolean;
  });
  return decision;
}

describe('parseAllowedOrigins', () => {
  it('parses, trims, lowercases and de-duplicates a comma-separated list', () => {
    expect(
      parseAllowedOrigins(` ${ALLOWED} , HTTPS://Portal.Example.Test ,http://localhost:5173`),
    ).toEqual([ALLOWED, 'http://localhost:5173']);
  });

  it('treats an unset or empty value as an empty allowlist, not as "allow everything"', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins('  ,  ')).toEqual([]);
  });

  it('refuses a wildcard by name', () => {
    expect(() => parseAllowedOrigins('*')).toThrow(CorsConfigurationError);
    expect(() => parseAllowedOrigins(`${ALLOWED},*`)).toThrow(/wildcard/);
  });

  it.each([
    `${ALLOWED}/`,
    `${ALLOWED}/app`,
    'portal.example.test',
    'ftp://portal.example.test',
    'https://*.example.test',
    'https://portal.example.test?x=1',
  ])('refuses %s at boot rather than silently never matching it', (entry) => {
    expect(() => parseAllowedOrigins(entry)).toThrow(CorsConfigurationError);
  });

  it('accepts an origin with a port', () => {
    expect(parseAllowedOrigins('http://localhost:5173')).toEqual(['http://localhost:5173']);
  });
});

describe('buildCorsOptions', () => {
  it('allows an exact allowlisted origin and rejects everything else', () => {
    expect(decide(ALLOWED, [ALLOWED])).toBe(true);
    expect(decide(ALLOWED.toUpperCase(), [ALLOWED])).toBe(true);
    expect(decide(EVIL, [ALLOWED])).toBe(false);
    expect(decide('https://portal.example.test.evil.com', [ALLOWED])).toBe(false);
    expect(decide('null', [ALLOWED])).toBe(false);
  });

  it('rejects every origin when the allowlist is empty', () => {
    expect(decide(ALLOWED, [])).toBe(false);
  });

  it('takes the no-headers branch for a request with no Origin at all', () => {
    expect(decide(undefined, [ALLOWED])).toBe(false);
  });

  it('sets credentials, and exposes no response header to script', () => {
    const options = buildCorsOptions([ALLOWED]);
    expect(options.credentials).toBe(true);
    expect(options.exposedHeaders).toEqual([]);
    expect(options.allowedHeaders).toContain('X-CSRF-Token');
    expect(options.optionsSuccessStatus).toBe(204);
  });

  it('TC-6: the origin option is a callback, never `true` and never a wildcard', () => {
    const options = buildCorsOptions([ALLOWED]);
    expect(typeof options.origin).toBe('function');
    expect(options.origin).not.toBe(true);
    expect(options.origin).not.toBe('*');
  });
});

describe('TC-6: the source of cors.config.ts contains no permissive form', () => {
  const source = readFileSync(
    join(__dirname, '..', '..', 'src', 'common', 'security', 'cors.config.ts'),
    'utf8',
  );
  // Comments in that file discuss both forbidden forms by name, which is exactly what a naive
  // grep would trip over — so strip comments before scanning for the code.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  it.each([/origin\s*:\s*true/, /origin\s*:\s*['"`]\*['"`]/, /allowedOrigins\s*:\s*['"`]\*['"`]/])(
    'does not match %s',
    (pattern) => {
      expect(code).not.toMatch(pattern);
    },
  );
});

describe('over real HTTP', () => {
  let app: INestApplication;
  /**
   * T-087: one listener, bound once, for every case below.
   *
   * `request(app.getHttpServer())` on an app that only ever called `init()` makes supertest
   * `listen(0)`/`close()` a *fresh* ephemeral port per request. The port is captured in the
   * `Test` constructor and the listener is closed once the response lands, so under the port
   * pressure of a parallel Jest run the address can be rebound by another listener between
   * those two moments — and the answer then comes from a different server. See
   * `support/bound-app.ts` for the full diagnosis.
   */
  let base: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    configureHttpSecurity(asExpressApplication(app), {
      apiOrigin: '',
      corsAllowedOrigins: ALLOWED,
      trustProxy: undefined,
      enforceHttps: false,
    });
    await app.init();
    base = await bindTestServer(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('TC-4: a preflight from an allowed origin echoes the exact origin with credentials', async () => {
    const response = await request(base)
      .options('/api/v1/probe')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'X-CSRF-Token');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-headers']).toContain('X-CSRF-Token');
    // Never a wildcard, which with credentials would be both invalid and a leak.
    expect(response.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('TC-5: a preflight from https://evil.com gets no Access-Control-Allow-Origin', async () => {
    const response = await request(base)
      .options('/api/v1/probe')
      .set('Origin', EVIL)
      .set('Access-Control-Request-Method', 'POST');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('gives a simple cross-origin GET from an unknown origin no CORS headers either', async () => {
    const response = await request(base).get('/api/v1/probe').set('Origin', EVIL).expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('leaves same-origin requests entirely unaffected', async () => {
    const response = await request(base).get('/api/v1/probe').expect(200);
    expect(response.body).toEqual({ data: 'ok' });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
