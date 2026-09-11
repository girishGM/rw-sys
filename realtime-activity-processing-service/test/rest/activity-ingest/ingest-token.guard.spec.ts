/**
 * T-INT-054. Fast, mocked-dependency unit tests for `ActivityIngestRestTokenGuard` — the real
 * end-to-end round trip against a running HTTP server lives in `activity-ingest-rest.e2e-spec.ts`.
 * Unlike RR's own `IngestTokenGuard` (this guard's own precedent), there is no "missing env var
 * fails fast at construction" branch to test here — this guard reads its secret lazily, per
 * request (see its own header for why) — so the missing-secret case is exercised as a real
 * `canActivate` outcome (TC below) instead.
 */
import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ActivityIngestRestTokenGuard } from '@/rest/activity-ingest/ingest-token.guard';

const REAL_TOKEN = 'a-real-activity-ingest-rest-token';

function buildContext(authorizationHeader?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: authorizationHeader } }),
    }),
  } as unknown as ExecutionContext;
}

describe('T-INT-054 — ActivityIngestRestTokenGuard (unit)', () => {
  const originalEnv = process.env.ACTIVITY_INGEST_REST_TOKEN;
  const guard = new ActivityIngestRestTokenGuard();

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ACTIVITY_INGEST_REST_TOKEN;
    } else {
      process.env.ACTIVITY_INGEST_REST_TOKEN = originalEnv;
    }
  });

  it('throws ServiceUnavailableException (not a construction-time throw) when the env var is unset', () => {
    delete process.env.ACTIVITY_INGEST_REST_TOKEN;
    expect(() => guard.canActivate(buildContext(`Bearer ${REAL_TOKEN}`))).toThrow(
      ServiceUnavailableException,
    );
  });

  it('throws ServiceUnavailableException when the env var is blank', () => {
    process.env.ACTIVITY_INGEST_REST_TOKEN = '   ';
    expect(() => guard.canActivate(buildContext(`Bearer ${REAL_TOKEN}`))).toThrow(
      ServiceUnavailableException,
    );
  });

  it('no Authorization header at all — rejects with UnauthorizedException', () => {
    process.env.ACTIVITY_INGEST_REST_TOKEN = REAL_TOKEN;
    expect(() => guard.canActivate(buildContext(undefined))).toThrow(UnauthorizedException);
  });

  it('a malformed (non-Bearer) Authorization header is rejected', () => {
    process.env.ACTIVITY_INGEST_REST_TOKEN = REAL_TOKEN;
    expect(() => guard.canActivate(buildContext(`Basic ${REAL_TOKEN}`))).toThrow(
      UnauthorizedException,
    );
  });

  it("an incorrect bearer token (e.g. another guard's own token value) is rejected", () => {
    process.env.ACTIVITY_INGEST_REST_TOKEN = REAL_TOKEN;
    expect(() => guard.canActivate(buildContext('Bearer some-other-services-token'))).toThrow(
      UnauthorizedException,
    );
  });

  it('an empty bearer token value is rejected', () => {
    process.env.ACTIVITY_INGEST_REST_TOKEN = REAL_TOKEN;
    expect(() => guard.canActivate(buildContext('Bearer '))).toThrow(UnauthorizedException);
  });

  it('the correct bearer token is accepted', () => {
    process.env.ACTIVITY_INGEST_REST_TOKEN = REAL_TOKEN;
    expect(guard.canActivate(buildContext(`Bearer ${REAL_TOKEN}`))).toBe(true);
  });
});
