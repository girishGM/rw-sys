/**
 * T-RR-033 — `DispatchChannelResolverService`, unit-tested against a fake
 * `DispatchChannelConfigRepository` and a fake-backed `ServiceConfigResolverService` (this
 * service's own precedence/caching logic is pure and doesn't need a real DB round trip to verify —
 * the repository's own SQL is covered separately, against the real database, by
 * `dispatch-channel-config.repository.spec.ts`).
 *
 * The fake repository below implements exact-triple lookup the same way the real
 * `FIND_ONE_SQL` does (`dispatch-channel-config.repository.ts`), so these tests exercise the
 * resolver's own contract exactly as the real repository would present it, without opening a
 * socket. A deterministic injectable clock (rather than a real `setTimeout`/sleep) drives TTL
 * expiry so TC-7's "within/after TTL" assertions never depend on real wall-clock time.
 */
import 'reflect-metadata';
import type { DispatchChannelConfigRow } from '@/database/models/dispatch-channel-config.model';
import type { ServiceConfigRow } from '@/database/models/service-config.model';
import {
  DispatchChannelConfigCache,
  DISPATCH_CHANNEL_CONFIG_CACHE_NAME,
  TtlCache,
} from '@/modules/dispatch/dispatch-channel-config.cache';
import type { DispatchChannelConfigRepository } from '@/modules/dispatch/dispatch-channel-config.repository';
import {
  DispatchChannelResolutionError,
  DispatchChannelResolverService,
} from '@/modules/dispatch/dispatch-channel-resolver.service';
import { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import type { ServiceConfigRepository } from '@/modules/service-config/service-config.repository';

let nextId = 1;

function makeRow(
  overrides: Partial<DispatchChannelConfigRow> & Pick<DispatchChannelConfigRow, 'scope_level'>,
): DispatchChannelConfigRow {
  return {
    id: nextId++,
    scope_ref_code: null,
    tenant_id: null,
    kafka_enabled: true,
    rest_enabled: true,
    primary_channel: 'KAFKA',
    fallback_channel: 'REST',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

/** Fake repository mirroring `FIND_ONE_SQL`'s own exact-triple lookup in plain JS, seeded from a
 * mutable array so tests can simulate an out-of-band DB change (TC-9) between calls. Tracks call
 * count so TC-7/TC-9 can assert "no repeated DB query" / "re-fetches after invalidate" directly. */
class FakeDispatchChannelConfigRepository implements Pick<
  DispatchChannelConfigRepository,
  'findOne'
> {
  public callCount = 0;

  constructor(private readonly rows: DispatchChannelConfigRow[]) {}

  async findOne(
    scopeLevel: DispatchChannelConfigRow['scope_level'],
    scopeRefCode: string | null,
    tenantId: number | null,
  ): Promise<DispatchChannelConfigRow | null> {
    this.callCount += 1;
    return (
      this.rows.find(
        (row) =>
          row.scope_level === scopeLevel &&
          row.scope_ref_code === scopeRefCode &&
          row.tenant_id === tenantId,
      ) ?? null
    );
  }
}

/** A `ServiceConfigResolverService` whose `cache.ttl.dispatchChannelConfig.seconds` always
 * resolves to `ttlSeconds`, via a fake `ServiceConfigRepository` — same substitution idiom
 * `service-config-resolver.service.spec.ts` (T-RR-006) already established. */
function makeServiceConfigResolver(ttlSeconds: number): ServiceConfigResolverService {
  const row: ServiceConfigRow = {
    id: 1,
    config_key: 'cache.ttl.dispatchChannelConfig.seconds',
    scope_level: 'GLOBAL',
    scope_ref: null,
    config_value: String(ttlSeconds),
    value_type: 'int',
    created_at: new Date(),
    updated_at: new Date(),
  };
  const fakeRepo: Pick<ServiceConfigRepository, 'findFirstMatch'> = {
    findFirstMatch: async () => row,
  };
  return new ServiceConfigResolverService(fakeRepo as unknown as ServiceConfigRepository);
}

interface Harness {
  repo: FakeDispatchChannelConfigRepository;
  cache: DispatchChannelConfigCache;
  resolver: DispatchChannelResolverService;
  advance: (ms: number) => void;
}

function setup(rows: DispatchChannelConfigRow[], ttlSeconds = 60): Harness {
  const repo = new FakeDispatchChannelConfigRepository(rows);
  const serviceConfig = makeServiceConfigResolver(ttlSeconds);
  let currentTime = 0;
  const cache = new DispatchChannelConfigCache(
    repo as unknown as DispatchChannelConfigRepository,
    serviceConfig,
    () => currentTime,
  );
  const resolver = new DispatchChannelResolverService(cache);
  return { repo, cache, resolver, advance: (ms: number) => (currentTime += ms) };
}

describe('T-RR-033 — DispatchChannelResolverService', () => {
  // TC-1.
  it('TC-1: a REWARD-scope row wins over TRACKER/CAMPAIGN/GLOBAL rows also present', async () => {
    const { resolver } = setup([
      makeRow({ scope_level: 'GLOBAL', primary_channel: 'REST', fallback_channel: 'KAFKA' }),
      makeRow({ scope_level: 'CAMPAIGN', scope_ref_code: 'CAMP1', primary_channel: 'REST' }),
      makeRow({ scope_level: 'TRACKER', scope_ref_code: 'TRK1', primary_channel: 'REST' }),
      makeRow({
        scope_level: 'REWARD',
        scope_ref_code: 'RWD1',
        primary_channel: 'KAFKA',
        fallback_channel: 'REST',
      }),
    ]);

    const result = await resolver.resolve({
      rewardCode: 'RWD1',
      trackerCode: 'TRK1',
      campaignCode: 'CAMP1',
    });

    expect(result).toEqual({
      primaryChannel: 'KAFKA',
      fallbackChannel: 'REST',
      kafkaEnabled: true,
      restEnabled: true,
    });
  });

  // TC-2.
  it('TC-2: no REWARD row, a TRACKER row wins over CAMPAIGN/GLOBAL', async () => {
    const { resolver } = setup([
      makeRow({ scope_level: 'GLOBAL', primary_channel: 'REST' }),
      makeRow({ scope_level: 'CAMPAIGN', scope_ref_code: 'CAMP1', primary_channel: 'REST' }),
      makeRow({ scope_level: 'TRACKER', scope_ref_code: 'TRK1', primary_channel: 'KAFKA' }),
    ]);

    const result = await resolver.resolve({
      rewardCode: 'RWD_NO_MATCH',
      trackerCode: 'TRK1',
      campaignCode: 'CAMP1',
    });

    expect(result.primaryChannel).toBe('KAFKA');
  });

  // TC-3.
  it('TC-3: no REWARD/TRACKER row, a CAMPAIGN row wins over GLOBAL', async () => {
    const { resolver } = setup([
      makeRow({ scope_level: 'GLOBAL', primary_channel: 'REST' }),
      makeRow({ scope_level: 'CAMPAIGN', scope_ref_code: 'CAMP1', primary_channel: 'KAFKA' }),
    ]);

    const result = await resolver.resolve({
      trackerCode: 'TRK_NO_MATCH',
      campaignCode: 'CAMP1',
    });

    expect(result.primaryChannel).toBe('KAFKA');
  });

  // TC-4.
  it('TC-4: no scope-specific row at all falls through to the GLOBAL row', async () => {
    const { resolver } = setup([
      makeRow({ scope_level: 'GLOBAL', primary_channel: 'REST', fallback_channel: 'KAFKA' }),
    ]);

    const result = await resolver.resolve({
      rewardCode: 'RWD_NO_MATCH',
      trackerCode: 'TRK_NO_MATCH',
      campaignCode: 'CAMP_NO_MATCH',
    });

    expect(result).toEqual({
      primaryChannel: 'REST',
      fallbackChannel: 'KAFKA',
      kafkaEnabled: true,
      restEnabled: true,
    });
  });

  // TC-5.
  it('TC-5: a tenant-specific REWARD row wins over a tenant-agnostic REWARD row for that tenant, but not for a different tenant', async () => {
    const { resolver } = setup([
      makeRow({ scope_level: 'GLOBAL', primary_channel: 'REST' }),
      makeRow({
        scope_level: 'REWARD',
        scope_ref_code: 'RWD1',
        tenant_id: null,
        primary_channel: 'REST',
      }),
      makeRow({
        scope_level: 'REWARD',
        scope_ref_code: 'RWD1',
        tenant_id: 42,
        primary_channel: 'KAFKA',
      }),
    ]);

    const forTenant42 = await resolver.resolve({ rewardCode: 'RWD1', tenantId: 42 });
    expect(forTenant42.primaryChannel).toBe('KAFKA');

    const forOtherTenant = await resolver.resolve({ rewardCode: 'RWD1', tenantId: 99 });
    expect(forOtherTenant.primaryChannel).toBe('REST');

    const forNoTenant = await resolver.resolve({ rewardCode: 'RWD1' });
    expect(forNoTenant.primaryChannel).toBe('REST');
  });

  // TC-6.
  it('TC-6: kafka_enabled=false on the resolved row is returned as-is, never silently swapped to the fallback channel', async () => {
    const { resolver } = setup([
      makeRow({
        scope_level: 'GLOBAL',
        primary_channel: 'KAFKA',
        fallback_channel: 'REST',
        kafka_enabled: false,
        rest_enabled: true,
      }),
    ]);

    const result = await resolver.resolve({});

    expect(result).toEqual({
      primaryChannel: 'KAFKA',
      fallbackChannel: 'REST',
      kafkaEnabled: false,
      restEnabled: true,
    });
  });

  // TC-7.
  it('TC-7: a cache hit within TTL issues no repeated DB query for the same resolve() context', async () => {
    const { resolver, repo } = setup([
      makeRow({ scope_level: 'GLOBAL', primary_channel: 'KAFKA' }),
    ]);

    await resolver.resolve({ rewardCode: 'RWD1' });
    const callsAfterFirst = repo.callCount;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await resolver.resolve({ rewardCode: 'RWD1' });

    expect(repo.callCount).toBe(callsAfterFirst);
  });

  it('re-fetches from the DB once the cached entry has aged past its TTL', async () => {
    const { resolver, repo, advance } = setup(
      [makeRow({ scope_level: 'GLOBAL', primary_channel: 'KAFKA' })],
      60,
    );

    await resolver.resolve({ rewardCode: 'RWD1' });
    const callsAfterFirst = repo.callCount;

    advance(61_000);
    await resolver.resolve({ rewardCode: 'RWD1' });

    expect(repo.callCount).toBeGreaterThan(callsAfterFirst);
  });

  // TC-8.
  it('TC-8: throws DispatchChannelResolutionError when no row resolves at any level, including a missing GLOBAL row', async () => {
    const { resolver } = setup([]);

    await expect(resolver.resolve({ rewardCode: 'RWD1' })).rejects.toThrow(
      DispatchChannelResolutionError,
    );
  });

  // TC-9.
  it('TC-9: invalidate() clears the cache so the next resolve() call re-reads the current DB state', async () => {
    const rows: DispatchChannelConfigRow[] = [
      makeRow({ scope_level: 'GLOBAL', primary_channel: 'KAFKA' }),
    ];
    const { resolver, cache } = setup(rows);

    const first = await resolver.resolve({});
    expect(first.primaryChannel).toBe('KAFKA');

    // Simulate an out-of-band DB update: replace the row object entirely (not a mutation of the
    // cached reference) so a stale cache would keep returning the old value.
    rows[0] = { ...rows[0], primary_channel: 'REST' };

    const stillCached = await resolver.resolve({});
    expect(stillCached.primaryChannel).toBe('KAFKA');

    cache.invalidate();

    const afterInvalidate = await resolver.resolve({});
    expect(afterInvalidate.primaryChannel).toBe('REST');
  });

  it('exposes its cache name for the generic invalidation endpoint to address it by (§3)', () => {
    const { cache } = setup([]);
    expect(cache.cacheName).toBe(DISPATCH_CHANNEL_CONFIG_CACHE_NAME);
  });

  // TC-10.
  it('TC-10: two different reward codes resolving to two different scope levels resolve independently, concurrently', async () => {
    const { resolver } = setup([
      makeRow({ scope_level: 'GLOBAL', primary_channel: 'REST', fallback_channel: 'KAFKA' }),
      makeRow({
        scope_level: 'REWARD',
        scope_ref_code: 'RWD1',
        primary_channel: 'KAFKA',
        fallback_channel: 'REST',
      }),
    ]);

    const [rwd1Result, rwd2Result] = await Promise.all([
      resolver.resolve({ rewardCode: 'RWD1' }),
      resolver.resolve({ rewardCode: 'RWD2' }),
    ]);

    expect(rwd1Result.primaryChannel).toBe('KAFKA');
    expect(rwd2Result.primaryChannel).toBe('REST');
  });
});

describe('T-RR-033 — TtlCache (generic Map-backed TTL store)', () => {
  it('returns undefined for a key that was never set', () => {
    const cache = new TtlCache<string>();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('returns the cached value before TTL expiry and undefined after', () => {
    let now = 0;
    const cache = new TtlCache<string>(() => now);

    cache.set('k', 'v', 1000);
    expect(cache.get('k')).toBe('v');

    now = 1001;
    expect(cache.get('k')).toBeUndefined();
  });

  it('invalidate() with no key clears every entry; with a key clears only that one', () => {
    const cache = new TtlCache<string>();
    cache.set('a', '1', 10_000);
    cache.set('b', '2', 10_000);

    cache.invalidate('a');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('2');

    cache.invalidate();
    expect(cache.get('b')).toBeUndefined();
  });

  it('caches a null value distinctly from "not cached at all"', () => {
    const cache = new TtlCache<string | null>();
    cache.set('k', null, 10_000);
    expect(cache.get('k')).toBeNull();
    expect(cache.get('other')).toBeUndefined();
  });
});
