/**
 * T-RR-013. Fast, mocked-dependency unit tests for `IngestTokenGuard` — the real end-to-end 401
 * behavior against a running HTTP server lives in `reward-entries.controller.spec.ts`/
 * `reward-entries.e2e-spec.ts` (TC-3/TC-4); this file isolates the guard's own logic, including
 * the "missing env var fails fast at construction" branch that a controller-level test can't
 * exercise directly (constructing `RewardEntriesModule` with the var unset would fail the whole
 * test file's boot, not just one test).
 */
import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import {
  IngestTokenGuard,
  MissingRewardEntryIngestTokenError,
} from '@/rest/reward-entries/ingest-token.guard';

const REAL_TOKEN = 'a-real-reward-entry-ingest-token';

function buildContext(authorizationHeader?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: authorizationHeader } }),
    }),
  } as unknown as ExecutionContext;
}

describe('T-RR-013 — IngestTokenGuard (unit)', () => {
  const originalEnv = process.env.REWARD_ENTRY_INGEST_TOKEN;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.REWARD_ENTRY_INGEST_TOKEN;
    } else {
      process.env.REWARD_ENTRY_INGEST_TOKEN = originalEnv;
    }
  });

  it('throws MissingRewardEntryIngestTokenError at construction when the env var is unset', () => {
    delete process.env.REWARD_ENTRY_INGEST_TOKEN;
    expect(() => new IngestTokenGuard()).toThrow(MissingRewardEntryIngestTokenError);
  });

  it('throws MissingRewardEntryIngestTokenError at construction when the env var is blank', () => {
    process.env.REWARD_ENTRY_INGEST_TOKEN = '   ';
    expect(() => new IngestTokenGuard()).toThrow(MissingRewardEntryIngestTokenError);
  });

  // TC-3
  it('TC-3: no Authorization header at all — rejects with UnauthorizedException', () => {
    process.env.REWARD_ENTRY_INGEST_TOKEN = REAL_TOKEN;
    const guard = new IngestTokenGuard();

    expect(() => guard.canActivate(buildContext(undefined))).toThrow(UnauthorizedException);
  });

  it('a malformed (non-Bearer) Authorization header is rejected', () => {
    process.env.REWARD_ENTRY_INGEST_TOKEN = REAL_TOKEN;
    const guard = new IngestTokenGuard();

    expect(() => guard.canActivate(buildContext(`Basic ${REAL_TOKEN}`))).toThrow(
      UnauthorizedException,
    );
  });

  // TC-4
  it("TC-4: an incorrect bearer token (e.g. another guard's own token value) is rejected", () => {
    process.env.REWARD_ENTRY_INGEST_TOKEN = REAL_TOKEN;
    const guard = new IngestTokenGuard();

    expect(() => guard.canActivate(buildContext('Bearer some-other-services-token'))).toThrow(
      UnauthorizedException,
    );
  });

  it('an empty bearer token value is rejected', () => {
    process.env.REWARD_ENTRY_INGEST_TOKEN = REAL_TOKEN;
    const guard = new IngestTokenGuard();

    expect(() => guard.canActivate(buildContext('Bearer '))).toThrow(UnauthorizedException);
  });

  it('the correct bearer token is accepted', () => {
    process.env.REWARD_ENTRY_INGEST_TOKEN = REAL_TOKEN;
    const guard = new IngestTokenGuard();

    expect(guard.canActivate(buildContext(`Bearer ${REAL_TOKEN}`))).toBe(true);
  });
});
