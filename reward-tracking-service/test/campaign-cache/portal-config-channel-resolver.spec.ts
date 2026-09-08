/**
 * T-INT-013 — `PortalConfigChannelResolverService`, unit-tested against a fake `pg.Pool`
 * substitute (mirroring `FIND_ONE_SQL`'s own exact-triple lookup in plain JS) — same "the
 * precedence logic is pure and doesn't need a real DB round trip to verify" reasoning
 * `reward-redemption-service`'s own `promo-code-channel-resolver.service.spec.ts` (the reference
 * this task's own file names) documents for its sibling table. The real table's own SQL
 * (`IS NOT DISTINCT FROM`, the `uq_pccc_scope` unique constraint, the seeded `GLOBAL` row from
 * migration `009`) is exercised for real by `campaign-hierarchy.client.spec.ts`'s own fallback
 * behavior once migration `009` is applied against the real local Postgres.
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

  constructor(private readonly rows: PortalConfigChannelConfigRow[]) {}

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

function buildResolver(rows: PortalConfigChannelConfigRow[]): {
  resolver: PortalConfigChannelResolverService;
  pool: FakePool;
} {
  const pool = new FakePool(rows);
  const resolver = new PortalConfigChannelResolverService(pool as unknown as Pool);
  return { resolver, pool };
}

/** Migration `009`'s own seeded `GLOBAL` row, exactly. */
const GLOBAL_ROW = makeRow({
  scope_level: 'GLOBAL',
  rest_enabled: true,
  grpc_enabled: true,
  primary_channel: 'REST',
  fallback_channel: 'GRPC',
});

describe('T-INT-013 — PortalConfigChannelResolverService', () => {
  // TC-1 (task file).
  it('TC-1: only the seeded GLOBAL row exists -> resolves REST primary / GRPC fallback', async () => {
    const { resolver } = buildResolver([GLOBAL_ROW]);

    const resolved = await resolver.resolve({ campaignCode: 'ANY_CAMPAIGN', tenantId: 1 });

    expect(resolved).toEqual({
      primaryChannel: 'REST',
      fallbackChannel: 'GRPC',
      restEnabled: true,
      grpcEnabled: true,
    });
  });

  it('a CAMPAIGN-level row with primary_channel=GRPC overrides GLOBAL', async () => {
    const campaignRow = makeRow({
      scope_level: 'CAMPAIGN',
      scope_ref_code: 'CAMP_GRPC',
      primary_channel: 'GRPC',
      fallback_channel: 'REST',
    });
    const { resolver } = buildResolver([GLOBAL_ROW, campaignRow]);

    const resolved = await resolver.resolve({ campaignCode: 'CAMP_GRPC' });

    expect(resolved.primaryChannel).toBe('GRPC');
    expect(resolved.fallbackChannel).toBe('REST');
  });

  it('within CAMPAIGN scope, a tenant-specific row wins over the tenant-agnostic row at that same level', async () => {
    const tenantAgnostic = makeRow({
      scope_level: 'CAMPAIGN',
      scope_ref_code: 'CAMP_TENANT',
      tenant_id: null,
      primary_channel: 'REST',
    });
    const tenantSpecific = makeRow({
      scope_level: 'CAMPAIGN',
      scope_ref_code: 'CAMP_TENANT',
      tenant_id: 42,
      primary_channel: 'GRPC',
    });
    const { resolver } = buildResolver([GLOBAL_ROW, tenantAgnostic, tenantSpecific]);

    const resolvedForTenant42 = await resolver.resolve({
      campaignCode: 'CAMP_TENANT',
      tenantId: 42,
    });
    const resolvedForOtherTenant = await resolver.resolve({
      campaignCode: 'CAMP_TENANT',
      tenantId: 99,
    });

    expect(resolvedForTenant42.primaryChannel).toBe('GRPC');
    expect(resolvedForOtherTenant.primaryChannel).toBe('REST');
  });

  it('no campaignCode supplied -> CAMPAIGN level is skipped entirely, only GLOBAL is queried', async () => {
    const { resolver, pool } = buildResolver([GLOBAL_ROW]);

    // No tenantId either — with one supplied, resolveAtLevel's own tenant-specific-then-tenant-
    // agnostic check would add a second call within the GLOBAL level itself (correct behavior,
    // not what this test is about); omitting it isolates the one thing this test asserts: CAMPAIGN
    // is skipped entirely because campaignCode is undefined, so exactly one call (GLOBAL) happens.
    const resolved = await resolver.resolve({});

    expect(resolved.primaryChannel).toBe('REST');
    expect(pool.callCount).toBe(1);
  });

  it("a disabled channel is still returned verbatim — normalizing it is the caller's own job, not this resolver's", async () => {
    const misconfigured = makeRow({
      scope_level: 'CAMPAIGN',
      scope_ref_code: 'CAMP_MISCONFIG',
      grpc_enabled: false,
      primary_channel: 'GRPC',
      fallback_channel: 'REST',
    });
    const { resolver } = buildResolver([GLOBAL_ROW, misconfigured]);

    const resolved = await resolver.resolve({ campaignCode: 'CAMP_MISCONFIG' });

    expect(resolved).toEqual({
      primaryChannel: 'GRPC',
      fallbackChannel: 'REST',
      restEnabled: true,
      grpcEnabled: false,
    });
  });

  it('resolution is never a merge across levels — the first matching level wins outright, every field from that one row', async () => {
    const campaignRow = makeRow({
      scope_level: 'CAMPAIGN',
      scope_ref_code: 'CAMP_MERGE',
      rest_enabled: false,
      grpc_enabled: true,
      primary_channel: 'GRPC',
      fallback_channel: 'GRPC',
    });
    const { resolver } = buildResolver([GLOBAL_ROW, campaignRow]);

    const resolved = await resolver.resolve({ campaignCode: 'CAMP_MERGE' });

    expect(resolved).toEqual({
      primaryChannel: 'GRPC',
      fallbackChannel: 'GRPC',
      restEnabled: false,
      grpcEnabled: true,
    });
  });

  it('no row resolves at any scope, including no GLOBAL row -> throws PortalConfigChannelResolutionError, never a guessed default', async () => {
    const { resolver } = buildResolver([]);

    await expect(resolver.resolve({ campaignCode: 'NOTHING_HERE' })).rejects.toThrow(
      PortalConfigChannelResolutionError,
    );
  });
});
