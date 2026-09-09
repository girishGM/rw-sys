/**
 * T-RR-007 — `ServiceConfigCache`. Covers the ordinary cache-then-expire contract every cache in
 * this module shares, plus the one behaviour unique to this cache: the `cache.ttl.serviceConfig.
 * seconds` bootstrap exception (`06-CACHING-AND-TENANT-CONFIG.md` §2) — this file's own header
 * explains the mechanism these tests exercise directly.
 */
import {
  SERVICE_CONFIG_CACHE_BOOTSTRAP_TTL_MS,
  SERVICE_CONFIG_TTL_KEY,
  ServiceConfigCache,
} from '@/modules/tenant-schema-cache/service-config.cache';
import type { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import type { ServiceConfigRepository } from '@/modules/service-config/service-config.repository';

function build(): {
  cache: ServiceConfigCache;
  resolverResolve: jest.Mock;
  findAll: jest.Mock;
} {
  const resolverResolve = jest.fn();
  const findAll = jest.fn().mockResolvedValue([]);
  const resolver = { resolve: resolverResolve } as unknown as ServiceConfigResolverService;
  const repository = { findAll } as unknown as ServiceConfigRepository;
  const cache = new ServiceConfigCache(resolver, repository);
  return { cache, resolverResolve, findAll };
}

describe('T-RR-007 — ServiceConfigCache', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // TC-1-equivalent.
  it('a second resolve() for the same (configKey, context) within TTL does not re-hit the resolver', async () => {
    const { cache, resolverResolve } = build();
    resolverResolve.mockImplementation(async (configKey: string) =>
      configKey === SERVICE_CONFIG_TTL_KEY ? 120 : 'some-value',
    );

    await cache.resolve('some.other.knob', 'string', {});
    resolverResolve.mockClear();
    const value = await cache.resolve('some.other.knob', 'string', {});

    expect(value).toBe('some-value');
    expect(resolverResolve).not.toHaveBeenCalled();
  });

  // TC-2-equivalent.
  it('re-fetches once the cached entry has expired', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
    const { cache, resolverResolve } = build();
    resolverResolve.mockImplementation(
      async (configKey: string) => (configKey === SERVICE_CONFIG_TTL_KEY ? 1 : 'some-value'), // 1 second TTL for every other key
    );

    await cache.resolve('some.other.knob', 'string', {});
    resolverResolve.mockClear();
    nowSpy.mockReturnValue(1_001);
    await cache.resolve('some.other.knob', 'string', {});

    expect(resolverResolve).toHaveBeenCalledWith('some.other.knob', 'string', {});
  });

  it('distinguishes cache entries by scope context, not just configKey', async () => {
    const { cache, resolverResolve } = build();
    resolverResolve.mockImplementation(async (configKey: string) =>
      configKey === SERVICE_CONFIG_TTL_KEY ? 300 : 'value',
    );

    await cache.resolve('some.knob', 'string', { campaignCode: 'CAMP1' });
    resolverResolve.mockClear();
    await cache.resolve('some.knob', 'string', { campaignCode: 'CAMP2' });

    expect(resolverResolve).toHaveBeenCalledWith('some.knob', 'string', { campaignCode: 'CAMP2' });
  });

  it('invalidate() forces the next resolve() to re-hit the resolver even within the TTL window', async () => {
    const { cache, resolverResolve } = build();
    resolverResolve.mockImplementation(async (configKey: string) =>
      configKey === SERVICE_CONFIG_TTL_KEY ? 300 : 'value',
    );

    await cache.resolve('some.knob', 'string', {});
    cache.invalidate();
    resolverResolve.mockClear();
    await cache.resolve('some.knob', 'string', {});

    expect(resolverResolve).toHaveBeenCalledWith('some.knob', 'string', {});
  });

  it('refreshAll() proves a real repository round trip and invalidates so the next resolve() re-fetches', async () => {
    const { cache, resolverResolve, findAll } = build();
    resolverResolve.mockImplementation(async (configKey: string) =>
      configKey === SERVICE_CONFIG_TTL_KEY ? 300 : 'value',
    );
    await cache.resolve('some.knob', 'string', {});

    await cache.refreshAll();
    resolverResolve.mockClear();
    await cache.resolve('some.knob', 'string', {});

    expect(findAll).toHaveBeenCalledTimes(1);
    expect(resolverResolve).toHaveBeenCalledWith('some.knob', 'string', {});
  });

  // The bootstrap exception itself (§2).
  it('caches every OTHER key using the real resolved TTL value, from the very first call onward', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
    const { cache, resolverResolve } = build();
    resolverResolve.mockImplementation(async (configKey: string) =>
      configKey === SERVICE_CONFIG_TTL_KEY ? 120 : 'some-value',
    );

    const value = await cache.resolve('some.other.knob', 'string', {});
    expect(value).toBe('some-value');
    // Two resolver calls: one for the requested key, one nested call resolving this cache's own
    // TTL key so it knows how long to remember the first result for.
    expect(resolverResolve).toHaveBeenCalledTimes(2);

    resolverResolve.mockClear();
    // Past the 60s compiled-in bootstrap default, but well within the real, resolved 120s TTL —
    // proves the entry was stored using 120s, not the bootstrap default.
    nowSpy.mockReturnValue(SERVICE_CONFIG_CACHE_BOOTSTRAP_TTL_MS + 1_000);
    const cachedValue = await cache.resolve('some.other.knob', 'string', {});

    expect(cachedValue).toBe('some-value');
    expect(resolverResolve).not.toHaveBeenCalled();
  });

  it('caches its OWN TTL key using the compiled-in bootstrap default, never a value resolved from itself', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
    const { cache, resolverResolve } = build();
    resolverResolve.mockResolvedValue(120);

    await cache.resolve(SERVICE_CONFIG_TTL_KEY, 'int', {});
    resolverResolve.mockClear();
    // Just past the bootstrap default's own window — if this entry had instead been (impossibly)
    // cached using its own 120s resolved value, this read would still be a hit.
    nowSpy.mockReturnValue(SERVICE_CONFIG_CACHE_BOOTSTRAP_TTL_MS + 1);
    await cache.resolve(SERVICE_CONFIG_TTL_KEY, 'int', {});

    expect(resolverResolve).toHaveBeenCalledTimes(1);
  });
});
