/**
 * T-INT-006 — `RewardDispatchChannelResolverService`, unit-tested against a fake `pg.Pool` (this
 * service's own precedence/caching logic is pure and doesn't need a real DB round trip to verify).
 * Same "assert the observable property" discipline as every other resolver test in this project —
 * every assertion checks the resolved shape/call count, never an internal implementation detail.
 *
 * The fake pool below implements exact-triple lookup the same way the real `FIND_ONE_SQL` does
 * (`reward-dispatch-channel-resolver.service.ts`), so these tests exercise the resolver's own
 * contract exactly as a real `pg.Pool` would present it, without opening a socket. A deterministic
 * injectable clock (rather than a real `setTimeout`/sleep) drives TTL expiry.
 */
import 'reflect-metadata';
import type { Pool } from 'pg';
import {
  RewardDispatchChannelResolutionError,
  RewardDispatchChannelResolverService,
  type RewardDispatchChannelConfigRow,
  type RewardDispatchScopeLevel,
} from '@/modules/dispatch/reward-dispatch-channel-resolver.service';

let nextId = 1;

function makeRow(
  overrides: Partial<RewardDispatchChannelConfigRow> &
    Pick<RewardDispatchChannelConfigRow, 'scope_level'>,
): RewardDispatchChannelConfigRow {
  return {
    id: nextId++,
    scope_ref_code: null,
    tenant_id: null,
    kafka_enabled: true,
    rest_enabled: true,
    grpc_enabled: true,
    primary_channel: 'REST',
    fallback_channel: 'KAFKA',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

/** Fake `pg.Pool` mirroring `FIND_ONE_SQL`'s own exact-triple lookup in plain JS, seeded from a
 * mutable array so tests can simulate an out-of-band DB change between calls. Tracks call count so
 * TTL/invalidate tests can assert "no repeated DB query" / "re-fetches after invalidate" directly. */
function fakePool(rows: RewardDispatchChannelConfigRow[]): Pool & { callCount: number } {
  let callCount = 0;
  const pool = {
    get callCount() {
      return callCount;
    },
    query: async (
      _sql: string,
      params: [RewardDispatchScopeLevel, string | null, number | null],
    ) => {
      callCount += 1;
      const [level, refCode, tenantId] = params;
      const row =
        rows.find(
          (r) =>
            r.scope_level === level && r.scope_ref_code === refCode && r.tenant_id === tenantId,
        ) ?? null;
      return { rows: row ? [row] : [] };
    },
    end: async () => undefined,
  };
  return pool as unknown as Pool & { callCount: number };
}

interface Harness {
  pool: Pool & { callCount: number };
  resolver: RewardDispatchChannelResolverService;
  advance: (ms: number) => void;
}

function setup(rows: RewardDispatchChannelConfigRow[], ttlMs = 60_000): Harness {
  const pool = fakePool(rows);
  let currentTime = 0;
  const resolver = new RewardDispatchChannelResolverService(pool, () => currentTime, ttlMs);
  return { pool, resolver, advance: (ms: number) => (currentTime += ms) };
}

describe('T-INT-006 — RewardDispatchChannelResolverService', () => {
  // TC-1.
  it('TC-1: only a GLOBAL row seeded -> resolves to that row exactly', async () => {
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
      grpcEnabled: true,
    });
  });

  // TC-2.
  it('TC-2: a TRACKER-level override wins over GLOBAL — first match, not a merge', async () => {
    const { resolver } = setup([
      makeRow({ scope_level: 'GLOBAL', primary_channel: 'REST', fallback_channel: 'KAFKA' }),
      makeRow({
        scope_level: 'TRACKER',
        scope_ref_code: 'TRK1',
        primary_channel: 'GRPC',
        fallback_channel: 'REST',
      }),
    ]);

    const result = await resolver.resolve({ trackerCode: 'TRK1', campaignCode: 'CAMP1' });

    expect(result.primaryChannel).toBe('GRPC');
    expect(result.fallbackChannel).toBe('REST');
  });

  it('a REWARD-scope row wins over TRACKER/CAMPAIGN/GLOBAL rows also present', async () => {
    const { resolver } = setup([
      makeRow({ scope_level: 'GLOBAL', primary_channel: 'REST' }),
      makeRow({ scope_level: 'CAMPAIGN', scope_ref_code: 'CAMP1', primary_channel: 'REST' }),
      makeRow({ scope_level: 'TRACKER', scope_ref_code: 'TRK1', primary_channel: 'REST' }),
      makeRow({
        scope_level: 'REWARD',
        scope_ref_code: 'RWD1',
        primary_channel: 'KAFKA',
        fallback_channel: 'GRPC',
      }),
    ]);

    const result = await resolver.resolve({
      rewardCode: 'RWD1',
      trackerCode: 'TRK1',
      campaignCode: 'CAMP1',
    });

    expect(result).toEqual({
      primaryChannel: 'KAFKA',
      fallbackChannel: 'GRPC',
      kafkaEnabled: true,
      restEnabled: true,
      grpcEnabled: true,
    });
  });

  it('no REWARD/TRACKER row, a CAMPAIGN row wins over GLOBAL', async () => {
    const { resolver } = setup([
      makeRow({ scope_level: 'GLOBAL', primary_channel: 'REST' }),
      makeRow({ scope_level: 'CAMPAIGN', scope_ref_code: 'CAMP1', primary_channel: 'GRPC' }),
    ]);

    const result = await resolver.resolve({
      trackerCode: 'TRK_NO_MATCH',
      campaignCode: 'CAMP1',
    });

    expect(result.primaryChannel).toBe('GRPC');
  });

  it('a tenant-specific REWARD row wins over a tenant-agnostic REWARD row for that tenant, but not for a different tenant', async () => {
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
  });

  it('kafka_enabled=false on the resolved row is returned as-is, never silently swapped', async () => {
    const { resolver } = setup([
      makeRow({
        scope_level: 'GLOBAL',
        primary_channel: 'KAFKA',
        fallback_channel: 'REST',
        kafka_enabled: false,
      }),
    ]);

    const result = await resolver.resolve({});

    expect(result.kafkaEnabled).toBe(false);
    expect(result.primaryChannel).toBe('KAFKA');
  });

  it('a cache hit within TTL issues no repeated DB query for the same resolve() context', async () => {
    const { resolver, pool } = setup([
      makeRow({ scope_level: 'GLOBAL', primary_channel: 'KAFKA' }),
    ]);

    await resolver.resolve({ rewardCode: 'RWD1' });
    const callsAfterFirst = pool.callCount;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await resolver.resolve({ rewardCode: 'RWD1' });

    expect(pool.callCount).toBe(callsAfterFirst);
  });

  it('re-queries once the cached entry has aged past its TTL', async () => {
    const { resolver, pool, advance } = setup(
      [makeRow({ scope_level: 'GLOBAL', primary_channel: 'KAFKA' })],
      60_000,
    );

    await resolver.resolve({ rewardCode: 'RWD1' });
    const callsAfterFirst = pool.callCount;

    advance(60_001);
    await resolver.resolve({ rewardCode: 'RWD1' });

    expect(pool.callCount).toBeGreaterThan(callsAfterFirst);
  });

  // TC-8-equivalent.
  it('throws RewardDispatchChannelResolutionError when no row resolves at any level, including a missing GLOBAL row', async () => {
    const { resolver } = setup([]);

    await expect(resolver.resolve({ rewardCode: 'RWD1' })).rejects.toThrow(
      RewardDispatchChannelResolutionError,
    );
  });

  it('invalidate() clears the cache so the next resolve() call re-reads the current DB state', async () => {
    const rows: RewardDispatchChannelConfigRow[] = [
      makeRow({ scope_level: 'GLOBAL', primary_channel: 'KAFKA' }),
    ];
    const { resolver, pool } = setup(rows);

    const first = await resolver.resolve({});
    expect(first.primaryChannel).toBe('KAFKA');

    rows[0] = { ...rows[0], primary_channel: 'REST' };

    const stillCached = await resolver.resolve({});
    expect(stillCached.primaryChannel).toBe('KAFKA');

    resolver.invalidate();

    const afterInvalidate = await resolver.resolve({});
    expect(afterInvalidate.primaryChannel).toBe('REST');
    expect(pool.callCount).toBeGreaterThan(0);
  });

  it('two different reward codes resolving to two different scope levels resolve independently', async () => {
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
