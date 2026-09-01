/**
 * T-PC-011. `InternalServiceTokenGuard` — unit-level coverage of every branch a mocked
 * `ExecutionContext` can exercise directly (missing header, malformed header, unconfigured
 * secret, wrong token, empty token, valid token) — the auth path this task's own Verification
 * step 5 requires 100% coverage on. `promo-code-config.controller.spec.ts`'s TC-6/TC-7 already
 * prove the same guard's `401` behaviour over real HTTP; this file additionally reaches the
 * "secret unconfigured" branch, which is otherwise unreachable in any real test run (the real
 * process always has `INTERNAL_SERVICE_TOKEN` set by `test/jest-e2e.setup.ts`/`.env.development`).
 */
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { InternalServiceTokenGuard } from '@/modules/promo-code-config/guards/internal-service-token.guard';

function contextWithHeader(header: string | string[] | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: header } }),
    }),
  } as unknown as ExecutionContext;
}

describe('T-PC-011 — InternalServiceTokenGuard', () => {
  const guard = new InternalServiceTokenGuard();
  const originalToken = process.env.INTERNAL_SERVICE_TOKEN;

  afterEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = originalToken;
  });

  it('rejects a request with no Authorization header', () => {
    expect(() => guard.canActivate(contextWithHeader(undefined))).toThrow(UnauthorizedException);
  });

  it('rejects a request whose Authorization header is not "Bearer <token>"-shaped', () => {
    expect(() => guard.canActivate(contextWithHeader('Basic abc123'))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a request whose Authorization header is an array (malformed/duplicated header)', () => {
    expect(() => guard.canActivate(contextWithHeader(['Bearer a', 'Bearer b']))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects every request when INTERNAL_SERVICE_TOKEN is unset, even a well-formed header', () => {
    delete process.env.INTERNAL_SERVICE_TOKEN;
    expect(() => guard.canActivate(contextWithHeader('Bearer anything'))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an empty bearer token', () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'real-token';
    expect(() => guard.canActivate(contextWithHeader('Bearer '))).toThrow(UnauthorizedException);
  });

  it('rejects a wrong bearer token', () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'real-token';
    expect(() => guard.canActivate(contextWithHeader('Bearer wrong-token'))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token of a different length than the configured one (safeEqual length branch)', () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'real-token';
    expect(() => guard.canActivate(contextWithHeader('Bearer short'))).toThrow(
      UnauthorizedException,
    );
  });

  it('accepts a request with the correct bearer token', () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'real-token';
    expect(guard.canActivate(contextWithHeader('Bearer real-token'))).toBe(true);
  });
});
