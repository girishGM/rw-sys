/**
 * T-PC-056. `GenerationServiceTokenGuard` — unit-level coverage of every branch a mocked
 * `ExecutionContext` can exercise directly (missing header, malformed header, unconfigured
 * secret, wrong token, empty token, valid token, and — TC-4 — `INTERNAL_SERVICE_TOKEN`'s own
 * value presented instead), mirroring `test/config/internal-service-token.guard.spec.ts`'s own
 * coverage of the sibling guard it was copied from.
 */
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { GenerationServiceTokenGuard } from '@/modules/generation/generation-service-token.guard';

function contextWithHeader(header: string | string[] | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: header } }),
    }),
  } as unknown as ExecutionContext;
}

describe('T-PC-056 — GenerationServiceTokenGuard', () => {
  const guard = new GenerationServiceTokenGuard();
  const originalGenerationToken = process.env.GENERATION_SERVICE_TOKEN;
  const originalInternalToken = process.env.INTERNAL_SERVICE_TOKEN;

  afterEach(() => {
    process.env.GENERATION_SERVICE_TOKEN = originalGenerationToken;
    process.env.INTERNAL_SERVICE_TOKEN = originalInternalToken;
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

  it('rejects every request when GENERATION_SERVICE_TOKEN is unset, even a well-formed header', () => {
    delete process.env.GENERATION_SERVICE_TOKEN;
    expect(() => guard.canActivate(contextWithHeader('Bearer anything'))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an empty bearer token', () => {
    process.env.GENERATION_SERVICE_TOKEN = 'real-generation-token';
    expect(() => guard.canActivate(contextWithHeader('Bearer '))).toThrow(UnauthorizedException);
  });

  it('rejects a wrong bearer token', () => {
    process.env.GENERATION_SERVICE_TOKEN = 'real-generation-token';
    expect(() => guard.canActivate(contextWithHeader('Bearer wrong-token'))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token of a different length than the configured one (safeEqual length branch)', () => {
    process.env.GENERATION_SERVICE_TOKEN = 'real-generation-token';
    expect(() => guard.canActivate(contextWithHeader('Bearer short'))).toThrow(
      UnauthorizedException,
    );
  });

  // TC-4: the two secrets are not interchangeable — presenting INTERNAL_SERVICE_TOKEN's own
  // value against GenerationServiceTokenGuard must fail, because this guard only ever compares
  // against process.env.GENERATION_SERVICE_TOKEN, a distinct key.
  it('TC-4: rejects a request bearing the value of INTERNAL_SERVICE_TOKEN, not GENERATION_SERVICE_TOKEN', () => {
    process.env.GENERATION_SERVICE_TOKEN = 'real-generation-token';
    process.env.INTERNAL_SERVICE_TOKEN = 'real-internal-token';
    expect(() =>
      guard.canActivate(contextWithHeader(`Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`)),
    ).toThrow(UnauthorizedException);
  });

  it('accepts a request with the correct bearer token', () => {
    process.env.GENERATION_SERVICE_TOKEN = 'real-generation-token';
    expect(guard.canActivate(contextWithHeader('Bearer real-generation-token'))).toBe(true);
  });
});
