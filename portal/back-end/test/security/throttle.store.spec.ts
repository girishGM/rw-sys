/**
 * T-012 — the rate-limit counter stores (02-SECURITY.md §8).
 *
 * The Redis paths are covered against a fake client rather than a real server, and the loader
 * against a fake `require`. That is not a compromise made because no Redis is installed here;
 * it is the only way to test the branches that matter — a `PEXPIRE` that never happened, a
 * module that exports the wrong shape, a connection that throws — none of which a healthy Redis
 * would ever produce on demand.
 */
import {
  createThrottleStore,
  defaultRedisClientFactory,
  MemoryThrottleStore,
  RedisThrottleStore,
  resolveRedisConstructor,
  ThrottleStoreUnavailableError,
  UnavailableThrottleStore,
  type RedisThrottleClient,
} from '@/common/security/throttle.store';
import { THROTTLE_MULTI_INSTANCE_WARNING } from '@/common/security/security.constants';

const WINDOW = 60_000;

describe('MemoryThrottleStore', () => {
  it('counts within a window and reports a stable reset time', async () => {
    const store = new MemoryThrottleStore();

    const first = await store.consume('k', WINDOW, 1_000);
    const second = await store.consume('k', WINDOW, 1_500);

    expect(first).toEqual({ count: 1, resetAt: 61_000 });
    expect(second).toEqual({ count: 2, resetAt: 61_000 });
  });

  it('starts a new window once the old one has passed', async () => {
    const store = new MemoryThrottleStore();

    await store.consume('k', WINDOW, 1_000);
    const afterExpiry = await store.consume('k', WINDOW, 61_001);

    expect(afterExpiry).toEqual({ count: 1, resetAt: 121_001 });
  });

  it('keeps counters for different keys apart', async () => {
    const store = new MemoryThrottleStore();

    await store.consume('a', WINDOW, 0);
    await store.consume('a', WINDOW, 0);
    const b = await store.consume('b', WINDOW, 0);

    expect(b.count).toBe(1);
  });

  it('sweeps expired entries rather than growing without bound', async () => {
    const store = new MemoryThrottleStore(2);

    await store.consume('old-1', WINDOW, 0);
    await store.consume('old-2', WINDOW, 0);
    expect(store.size).toBe(2);

    // Both existing windows have closed by now, so the new key reuses their space.
    await store.consume('new', WINDOW, WINDOW + 1);
    expect(store.size).toBe(1);
  });

  it('evicts the soonest-to-expire live counter when the cap is reached', async () => {
    const store = new MemoryThrottleStore(2);

    await store.consume('expires-first', 1_000, 0);
    await store.consume('expires-later', 100_000, 0);
    await store.consume('newcomer', WINDOW, 0);

    expect(store.size).toBe(2);
    // The evicted counter restarts at 1; the retained one keeps counting.
    expect((await store.consume('expires-first', 1_000, 0)).count).toBe(1);
    expect((await store.consume('expires-later', 100_000, 0)).count).toBe(2);
  });
});

describe('UnavailableThrottleStore', () => {
  it('rejects every call with the configured reason', async () => {
    const store = new UnavailableThrottleStore('redis missing');

    expect(store.kind).toBe('unavailable');
    await expect(store.consume()).rejects.toBeInstanceOf(ThrottleStoreUnavailableError);
    await expect(store.consume()).rejects.toThrow('redis missing');
  });
});

describe('RedisThrottleStore', () => {
  const fakeClient = (overrides: Partial<RedisThrottleClient> = {}): RedisThrottleClient => ({
    incr: jest.fn().mockResolvedValue(1),
    pexpire: jest.fn().mockResolvedValue(1),
    pttl: jest.fn().mockResolvedValue(WINDOW),
    ...overrides,
  });

  it('sets the expiry on the first hit of a window', async () => {
    const client = fakeClient();
    const store = new RedisThrottleStore(client);

    const result = await store.consume('k', WINDOW, 1_000);

    expect(client.incr).toHaveBeenCalledWith('k');
    expect(client.pexpire).toHaveBeenCalledWith('k', WINDOW);
    expect(client.pttl).not.toHaveBeenCalled();
    expect(result).toEqual({ count: 1, resetAt: 61_000 });
  });

  it('derives the reset time from the remaining TTL on later hits', async () => {
    const client = fakeClient({
      incr: jest.fn().mockResolvedValue(4),
      pttl: jest.fn().mockResolvedValue(12_000),
    });

    const result = await new RedisThrottleStore(client).consume('k', WINDOW, 1_000);

    expect(result).toEqual({ count: 4, resetAt: 13_000 });
    expect(client.pexpire).not.toHaveBeenCalled();
  });

  it('re-arms an expiry that was never set, rather than banning the key forever', async () => {
    const client = fakeClient({
      incr: jest.fn().mockResolvedValue(9),
      // -1: the key exists with no TTL. Without the re-arm this counter never resets.
      pttl: jest.fn().mockResolvedValue(-1),
    });

    const result = await new RedisThrottleStore(client).consume('k', WINDOW, 1_000);

    expect(client.pexpire).toHaveBeenCalledWith('k', WINDOW);
    expect(result).toEqual({ count: 9, resetAt: 61_000 });
  });

  it('propagates a connection failure so the guard can apply the route policy', async () => {
    const client = fakeClient({ incr: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });

    await expect(new RedisThrottleStore(client).consume('k', WINDOW, 0)).rejects.toThrow(
      'ECONNREFUSED',
    );
  });
});

describe('resolveRedisConstructor', () => {
  class FakeRedis {
    constructor(readonly url: string) {}
  }

  it.each([
    ['module.exports = Redis', FakeRedis],
    ['exports.default = Redis', { default: FakeRedis }],
  ])('accepts the %s shape', (_label, module) => {
    expect(resolveRedisConstructor(module)).toBe(FakeRedis);
  });

  it.each([[{}], [null], [undefined], ['a string'], [{ default: 'not a constructor' }]])(
    'returns null for %p',
    (module) => {
      expect(resolveRedisConstructor(module)).toBeNull();
    },
  );
});

describe('defaultRedisClientFactory', () => {
  class FakeRedis {
    constructor(readonly url: string) {}
    incr = jest.fn();
    pexpire = jest.fn();
    pttl = jest.fn();
  }

  it('constructs the client from the loaded module', () => {
    const client = defaultRedisClientFactory('redis://localhost:6379', () => FakeRedis);
    expect(client).toBeInstanceOf(FakeRedis);
    expect((client as unknown as FakeRedis).url).toBe('redis://localhost:6379');
  });

  it('throws when the module exports no constructor', () => {
    expect(() => defaultRedisClientFactory('redis://x', () => ({}))).toThrow(
      ThrottleStoreUnavailableError,
    );
  });

  it('throws when ioredis is not installed at all — which is the case in this workspace', () => {
    expect(() => defaultRedisClientFactory('redis://x')).toThrow(/ioredis/);
  });
});

describe('createThrottleStore', () => {
  const buildLogger = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });

  it('uses memory when REDIS_URL is unset, silently, for a single instance', () => {
    const logger = buildLogger();
    const store = createThrottleStore({ redisUrl: undefined, instanceCount: 1, logger });

    expect(store).toBeInstanceOf(MemoryThrottleStore);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([[undefined], [''], ['   ']])('treats %p as unconfigured', (redisUrl) => {
    expect(
      createThrottleStore({ redisUrl, instanceCount: 1, logger: buildLogger() }),
    ).toBeInstanceOf(MemoryThrottleStore);
  });

  it('warns at boot when several instances share no store', () => {
    const logger = buildLogger();
    createThrottleStore({ redisUrl: undefined, instanceCount: 3, logger });

    expect(logger.warn).toHaveBeenCalledWith(THROTTLE_MULTI_INSTANCE_WARNING);
    expect(logger.warn.mock.calls[0][0]).toContain('N-times weaker');
  });

  it('uses Redis when a client can be built', () => {
    const logger = buildLogger();
    const store = createThrottleStore({
      redisUrl: 'redis://localhost:6379',
      instanceCount: 2,
      clientFactory: () => ({ incr: jest.fn(), pexpire: jest.fn(), pttl: jest.fn() }),
      logger,
    });

    expect(store).toBeInstanceOf(RedisThrottleStore);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does NOT fall back to memory when REDIS_URL is set but unusable', () => {
    const logger = buildLogger();
    const store = createThrottleStore({
      redisUrl: 'redis://localhost:6379',
      instanceCount: 4,
      clientFactory: () => {
        throw new Error('ioredis is not installed');
      },
      logger,
    });

    // The whole point: a silent memory fallback here would leave the operator believing they
    // have a shared limiter across four instances when they have four independent ones.
    expect(store).toBeInstanceOf(UnavailableThrottleStore);
    expect(logger.error).toHaveBeenCalled();
    expect(logger.error.mock.calls[0][0]).toContain('fail closed');
  });

  it('defaults its logger when none is supplied', () => {
    expect(createThrottleStore({ redisUrl: undefined, instanceCount: 1 })).toBeInstanceOf(
      MemoryThrottleStore,
    );
  });
});
