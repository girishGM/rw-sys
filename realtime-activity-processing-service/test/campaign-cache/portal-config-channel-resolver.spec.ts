/**
 * T-INT-011 — `PortalConfigChannelResolverService`, unit-tested against a fake `pg.Pool`
 * substitute (mirroring `FIND_ONE_SQL`'s own exact-triple lookup in plain JS), same "the
 * precedence/caching logic is pure and doesn't need a real DB round trip to verify" reasoning
 * `promo-code-channel-resolver.service.spec.ts` (T-RR-080) and `dispatch-channel-resolver.spec.ts`
 * (T-RR-033) both document for their own fake-repository suites. The real table's own SQL
 * (`IS NOT DISTINCT FROM`, `uq_portal_config_channel_config_scope`, the seeded `GLOBAL` row from
 * migration `016`) is exercised for real as part of this task's own Verification steps 2-3
 * (against a real, locally running portal back-end).
 */
import 'reflect-metadata';
import type { Pool } from 'pg';
import {
  PortalConfigChannelResolutionError,
  PortalConfigChannelResolverService,
  type PortalConfigChannelConfigRow,
  type PortalConfigChannelScopeLevel,
} from '@/modules/campaign-cache/portal-config-channel-resolver.service';

let nextId = 1;

function makeRow(
  overrides: Partial<PortalConfigChannelConfigRow> &
    Pick<PortalConfigChannelConfigRow, 'scope_level'>,
): PortalConfigChannelConfigRow {
  return {
    id: nextId++,
    scope_ref_code: null,
    tenant_id: null,
    rest_enabled: true,
    grpc_enabled: true,
    primary_channel: 'REST',
    fallback_channel: 'GRPC',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

/** Fake `pg.Pool` substitute mirroring `FIND_ONE_SQL`'s own `IS NOT DISTINCT FROM` semantics in
 * plain JS — `null` matches `null` on both nullable columns, exactly like real Postgres would. */
class FakePool {
  public callCount = 0;

  constructor(public rows: PortalConfigChannelConfigRow[]) {}

  async query(
    _text: string,
    params: [PortalConfigChannelScopeLevel, string | null, number | null],
  ): Promise<{ rows: PortalConfigChannelConfigRow[] }> {
    this.callCount += 1;
    const [scopeLevel, scopeRefCode, tenantId] = params;
    const match = this.rows.find(
      (row) =>
        row.scope_level === scopeLevel &&
        row.scope_ref_code === scopeRefCode &&
        row.tenant_id === tenantId,
    );
    return { rows: match ? [match] : [] };
  }
}

function buildResolver(
  rows: PortalConfigChannelConfigRow[],
  options: { ttlMs?: number; now?: () => number } = {},
): { resolver: PortalConfigChannelResolverService; pool: FakePool } {
  const pool = new FakePool(rows);
  const resolver = new PortalConfigChannelResolverService(
    pool as unknown as Pool,
    options.now,
    options.ttlMs ?? 60_000,
  );
  return { resolver, pool };
}

const GLOBAL_ROW = makeRow({
  scope_level: 'GLOBAL',
  rest_enabled: true,
  grpc_enabled: true,
  primary_channel: 'REST',
  fallback_channel: 'GRPC',
});

describe('T-INT-011 — PortalConfigChannelResolverService', () => {
  it('TC-1: only the seeded GLOBAL row exists -> resolves REST primary / GRPC fallback', async () => {
    const { resolver } = buildResolver([GLOBAL_ROW]);

    const resolved = await resolver.resolve({ tenantId: 1, campaignCode: 'CMP-1' });

    expect(resolved).toEqual({
      primaryChannel: 'REST',
      fallbackChannel: 'GRPC',
      restEnabled: true,
      grpcEnabled: true,
    });
  });

  it('a CAMPAIGN-level row overrides GLOBAL for that campaign code', async () => {
    const campaignRow = makeRow({
      scope_level: 'CAMPAIGN',
      scope_ref_code: 'CAMP_GRPC',
      primary_channel: 'GRPC',
      fallback_channel: 'REST',
    });
    const { resolver } = buildResolver([GLOBAL_ROW, campaignRow]);

    const resolved = await resolver.resolve({ campaignCode: 'CAMP_GRPC' });

    expect(resolved.primaryChannel).toBe('GRPC');
  });

  it('a CAMPAIGN code with no matching row falls through to GLOBAL', async () => {
    const { resolver } = buildResolver([GLOBAL_ROW]);

    const resolved = await resolver.resolve({ campaignCode: 'SOME_OTHER_CAMPAIGN' });

    expect(resolved.primaryChannel).toBe('REST');
  });

  it('a tenant-specific CAMPAIGN row wins over the tenant-agnostic row at the same level', async () => {
    const tenantAgnostic = makeRow({
      scope_level: 'CAMPAIGN',
      scope_ref_code: 'CAMP-1',
      primary_channel: 'REST',
    });
    const tenantSpecific = makeRow({
      scope_level: 'CAMPAIGN',
      scope_ref_code: 'CAMP-1',
      tenant_id: 42,
      primary_channel: 'GRPC',
    });
    const { resolver } = buildResolver([GLOBAL_ROW, tenantAgnostic, tenantSpecific]);

    const resolved = await resolver.resolve({ campaignCode: 'CAMP-1', tenantId: 42 });

    expect(resolved.primaryChannel).toBe('GRPC');
  });

  it('throws PortalConfigChannelResolutionError when no row resolves at any scope, including GLOBAL', async () => {
    const { resolver } = buildResolver([]);

    await expect(resolver.resolve({ campaignCode: 'ANY' })).rejects.toThrow(
      PortalConfigChannelResolutionError,
    );
  });

  describe('TTL cache', () => {
    it('caches a resolved row so a second lookup within the TTL window does not re-query the DB', async () => {
      const clock = 0;
      const { resolver, pool } = buildResolver([GLOBAL_ROW], { ttlMs: 60_000, now: () => clock });

      // A `tenantId`-bearing resolve() legitimately costs two distinct cache entries — the
      // tenant-specific candidate (a confirmed miss, since only the tenant-agnostic GLOBAL row
      // exists) and the tenant-agnostic candidate itself (a hit) — so the meaningful assertion is
      // "the second call adds zero further queries", not a hardcoded absolute count.
      await resolver.resolve({ tenantId: 1 });
      const queriesAfterFirstResolve = pool.callCount;

      await resolver.resolve({ tenantId: 1 });

      expect(pool.callCount).toBe(queriesAfterFirstResolve);
    });

    it('re-queries the DB once the TTL window elapses', async () => {
      let clock = 0;
      const { resolver, pool } = buildResolver([GLOBAL_ROW], { ttlMs: 1_000, now: () => clock });

      await resolver.resolve({ tenantId: 1 });
      const queriesAfterFirstResolve = pool.callCount;

      clock += 1_001;
      await resolver.resolve({ tenantId: 1 });

      expect(pool.callCount).toBeGreaterThan(queriesAfterFirstResolve);
    });

    it(
      'TC-4 (unit level): invalidate() clears the cache so a DB change made after the first ' +
        "resolve() (mirroring set-transport-primary.js's own UPDATE) is picked up by the next " +
        'resolve() with no restart and no TTL wait',
      async () => {
        const { resolver, pool } = buildResolver([GLOBAL_ROW], { ttlMs: 60_000 });

        const first = await resolver.resolve({ tenantId: 1 });
        expect(first.primaryChannel).toBe('REST');

        // Mutate the underlying row exactly like `set-transport-primary.js --primary=GRPC` would.
        pool.rows[0] = { ...pool.rows[0], primary_channel: 'GRPC', fallback_channel: 'REST' };

        // Without invalidation, still within the TTL window, the stale value is returned.
        const stillCached = await resolver.resolve({ tenantId: 1 });
        expect(stillCached.primaryChannel).toBe('REST');

        resolver.invalidate();

        const afterInvalidate = await resolver.resolve({ tenantId: 1 });
        expect(afterInvalidate.primaryChannel).toBe('GRPC');
      },
    );
  });
});
