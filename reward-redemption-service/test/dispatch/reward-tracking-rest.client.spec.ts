/**
 * T-RR-035 — `RewardTrackingRestClient` against a mocked global `fetch` (Node 20's own built-in
 * `undici`-backed implementation, no extra HTTP-client dependency added, this file's own header
 * for why) — deterministic, no real network I/O needed. `04-REST-CONTRACT.md` §3's own contract
 * (`POST /api/v1/redemptions/completed`, `Authorization: Bearer <REWARD_TRACKING_REST_TOKEN>`,
 * `200 {"status":"accepted"}` on success) is asserted against the *outgoing request* this client
 * actually builds, not just against a change-detector on an internal constant — `AGENT-PROTOCOL.md`
 * §3's own "assert the observable property" discipline.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  DEFAULT_REWARD_TRACKING_REST_BASE_URL,
  DEFAULT_REWARD_TRACKING_REST_TIMEOUT_MS,
  MissingRewardTrackingRestTokenError,
  REWARD_TRACKING_COMPLETED_PATH,
  RewardTrackingRestClient,
  loadRewardTrackingRestClientOptions,
  loadRewardTrackingRestToken,
} from '@/modules/dispatch/reward-tracking-rest.client';

const ORIGINAL_ENV = { ...process.env };

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('T-RR-035 — RewardTrackingRestClient', () => {
  let fetchSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    fetchSpy = jest.spyOn(global, 'fetch');
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
    process.env = { ...ORIGINAL_ENV };
  });

  function buildClient(token = 'reward-tracking-token'): RewardTrackingRestClient {
    return new RewardTrackingRestClient({
      baseUrl: 'http://reward-tracking.test',
      token,
      timeoutMs: 1000,
    });
  }

  describe('loadRewardTrackingRestToken / loadRewardTrackingRestClientOptions', () => {
    it('throws MissingRewardTrackingRestTokenError when REWARD_TRACKING_REST_TOKEN is unset', () => {
      delete process.env.REWARD_TRACKING_REST_TOKEN;
      expect(() => loadRewardTrackingRestToken()).toThrow(MissingRewardTrackingRestTokenError);
    });

    it('throws when REWARD_TRACKING_REST_TOKEN is only whitespace', () => {
      process.env.REWARD_TRACKING_REST_TOKEN = '   ';
      expect(() => loadRewardTrackingRestToken()).toThrow(MissingRewardTrackingRestTokenError);
    });

    it('returns the configured token', () => {
      process.env.REWARD_TRACKING_REST_TOKEN = 'my-real-token';
      expect(loadRewardTrackingRestToken()).toBe('my-real-token');
    });

    it('falls back to documented defaults for base URL/timeout when unset', () => {
      process.env.REWARD_TRACKING_REST_TOKEN = 'tok';
      delete process.env.REWARD_TRACKING_REST_BASE_URL;
      delete process.env.REWARD_TRACKING_REST_TIMEOUT_MS;
      const options = loadRewardTrackingRestClientOptions();
      expect(options.baseUrl).toBe(DEFAULT_REWARD_TRACKING_REST_BASE_URL);
      expect(options.timeoutMs).toBe(DEFAULT_REWARD_TRACKING_REST_TIMEOUT_MS);
    });

    it('rejects a non-positive-integer REWARD_TRACKING_REST_TIMEOUT_MS', () => {
      process.env.REWARD_TRACKING_REST_TOKEN = 'tok';
      process.env.REWARD_TRACKING_REST_TIMEOUT_MS = 'not-a-number';
      expect(() => loadRewardTrackingRestClientOptions()).toThrow(
        /REWARD_TRACKING_REST_TIMEOUT_MS/,
      );
    });

    it('TC-12: never equals or is derived from GENERATION_SERVICE_TOKEN/CACHE_ADMIN_TOKEN/REWARD_ENTRY_INGEST_TOKEN in any test fixture', () => {
      process.env.REWARD_TRACKING_REST_TOKEN = 'rt-token-AAA';
      process.env.GENERATION_SERVICE_TOKEN = 'gen-token-BBB';
      process.env.CACHE_ADMIN_TOKEN = 'cache-token-CCC';
      process.env.REWARD_ENTRY_INGEST_TOKEN = 'ingest-token-DDD';

      const token = loadRewardTrackingRestToken();

      expect(token).toBe('rt-token-AAA');
      expect(token).not.toBe(process.env.GENERATION_SERVICE_TOKEN);
      expect(token).not.toBe(process.env.CACHE_ADMIN_TOKEN);
      expect(token).not.toBe(process.env.REWARD_ENTRY_INGEST_TOKEN);
      expect(token.includes(process.env.GENERATION_SERVICE_TOKEN)).toBe(false);
      expect(token.includes(process.env.CACHE_ADMIN_TOKEN)).toBe(false);
      expect(token.includes(process.env.REWARD_ENTRY_INGEST_TOKEN)).toBe(false);
    });
  });

  describe('dispatch', () => {
    it('04-REST-CONTRACT.md §3: POSTs the exact path with a bearer token and JSON content-type', async () => {
      fetchSpy.mockResolvedValue(jsonResponse(200, { status: 'accepted' }));
      const client = buildClient('super-secret-token');

      await client.dispatch({ rewardEntryId: 'entry-1', customerId: 'CUST-1' });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(`http://reward-tracking.test${REWARD_TRACKING_COMPLETED_PATH}`);
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        'Content-Type': 'application/json',
        Authorization: 'Bearer super-secret-token',
      });
      expect(JSON.parse(init.body as string)).toEqual({
        rewardEntryId: 'entry-1',
        customerId: 'CUST-1',
      });
    });

    it('TC-3: 200 {"status":"accepted"} resolves without throwing', async () => {
      fetchSpy.mockResolvedValue(jsonResponse(200, { status: 'accepted' }));
      const client = buildClient();

      await expect(client.dispatch({ rewardEntryId: 'entry-1' })).resolves.toBeUndefined();
    });

    it('TC-4: a 500 response is treated as a failure — throws, same as a Kafka publish failure', async () => {
      fetchSpy.mockResolvedValue(jsonResponse(500, { error: 'boom' }));
      const client = buildClient();

      await expect(client.dispatch({ rewardEntryId: 'entry-1' })).rejects.toThrow(/500/);
    });

    it('a 200 with an unexpected body shape is still treated as a failure', async () => {
      fetchSpy.mockResolvedValue(jsonResponse(200, { status: 'something-else' }));
      const client = buildClient();

      await expect(client.dispatch({ rewardEntryId: 'entry-1' })).rejects.toThrow(
        /unexpected body/,
      );
    });

    it('a connection-level failure (fetch rejects) is treated as a failure', async () => {
      fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
      const client = buildClient();

      await expect(client.dispatch({ rewardEntryId: 'entry-1' })).rejects.toThrow('ECONNREFUSED');
    });

    it('TC-11: the plaintext customerId in the payload is never logged, on either the success or the failure path', async () => {
      fetchSpy.mockRejectedValue(new Error('network down'));
      const client = buildClient();

      await expect(
        client.dispatch({ rewardEntryId: 'entry-1', customerId: 'CUST-SECRET-11' }),
      ).rejects.toThrow();

      const loggedText = warnSpy.mock.calls.map((call) => JSON.stringify(call)).join('\n');
      expect(loggedText).not.toContain('CUST-SECRET-11');
    });

    it('never logs the bearer token, on either the success or the failure path', async () => {
      fetchSpy.mockRejectedValue(new Error('network down'));
      const client = buildClient('SUPER-SECRET-BEARER');

      await expect(client.dispatch({ rewardEntryId: 'entry-1' })).rejects.toThrow();

      const loggedText = warnSpy.mock.calls.map((call) => JSON.stringify(call)).join('\n');
      expect(loggedText).not.toContain('SUPER-SECRET-BEARER');
    });
  });

  /**
   * T-RR-064 regression. `test/redemption/redemption-completion-side-effects.spec.ts` and
   * `test/processing/claim-worker-module-di.e2e-spec.ts` (both outside this file's own scope —
   * `test/redemption/**`/`test/processing/**` are owned by other tasks) are the tests that
   * actually caught this defect for real, by compiling `DispatchModule` as part of a bigger
   * `RedemptionStateMachineModule`/`ClaimWorkerRootModule` graph. This test reproduces the same
   * failure mode directly against `RewardTrackingRestClient` alone, in the one file this task
   * owns, so the defect and its fix both have a test living next to the code that caused it —
   * not only in another task's file. Confirmed to fail with
   * "Nest can't resolve dependencies of the RewardTrackingRestClient (?)" when `@Optional()` is
   * removed from the constructor (reverted locally to verify, not committed).
   */
  describe('T-RR-064 — real Nest DI compiles this provider with no matching provider for `options`', () => {
    it('resolves via NestFactory-style DI (no explicit options provider bound) using the env-derived default', async () => {
      process.env.REWARD_TRACKING_REST_TOKEN = 'di-resolved-token';
      process.env.REWARD_TRACKING_REST_BASE_URL = 'http://reward-tracking.di-test';

      const moduleRef = await Test.createTestingModule({
        providers: [RewardTrackingRestClient],
      }).compile();

      const client = moduleRef.get(RewardTrackingRestClient);
      expect(client).toBeInstanceOf(RewardTrackingRestClient);

      fetchSpy.mockResolvedValue(jsonResponse(200, { status: 'accepted' }));
      await client.dispatch({ rewardEntryId: 'entry-1' });

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(`http://reward-tracking.di-test${REWARD_TRACKING_COMPLETED_PATH}`);
      expect(init.headers).toMatchObject({ Authorization: 'Bearer di-resolved-token' });

      await moduleRef.close();
    });
  });
});
