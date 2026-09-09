/**
 * T-INT-030 — `RewardTrackingChannelResolverService`, unit-tested against a fake `Sequelize`
 * substitute mirroring the real `findOne` SQL's `IS NOT DISTINCT FROM` semantics in plain JS —
 * same "the precedence logic is pure and doesn't need a real DB round trip to verify" reasoning
 * `promo-code-channel-resolver.service.spec.ts` (T-RR-080) documents for its own fake-pool suite.
 * The real table's own SQL (the `T172_001` migration, the `uq_rtcc` unique constraint, the seeded
 * `GLOBAL` row) is exercised for real by `npm run db:migrate && npm run db:rollback && npm run
 * db:migrate` (this task's own Verification steps) against the actual local Postgres server.
 */
import type { Sequelize } from 'sequelize-typescript';
import {
  RewardTrackingChannelResolutionError,
  RewardTrackingChannelResolverService,
  type RewardTrackingChannel,
  type RewardTrackingChannelScopeLevel,
} from '@/modules/reward-tracking-integration/reward-tracking-channel-resolver.service';

interface Row {
  scope_level: RewardTrackingChannelScopeLevel;
  scope_ref_code: string | null;
  tenant_id: number | null;
  rest_enabled: boolean;
  grpc_enabled: boolean;
  primary_channel: RewardTrackingChannel;
  fallback_channel: RewardTrackingChannel;
}

function makeRow(overrides: Partial<Row> & Pick<Row, 'scope_level'>): Row {
  return {
    scope_ref_code: null,
    tenant_id: null,
    rest_enabled: true,
    grpc_enabled: false,
    primary_channel: 'REST',
    fallback_channel: 'REST',
    ...overrides,
  };
}

/** Fake `Sequelize` substitute exposing only the `.query()` shape the resolver calls —
 * `IS NOT DISTINCT FROM` reproduced in plain JS: `null` matches `null` on both nullable columns,
 * exactly like real Postgres would. */
class FakeSequelize {
  public callCount = 0;

  constructor(private readonly rows: Row[]) {}

  async query(
    _sql: string,
    options: {
      replacements: {
        level: RewardTrackingChannelScopeLevel;
        refCode: string | null;
        tenantId: number | null;
      };
    },
  ): Promise<Row[]> {
    this.callCount += 1;
    const { level, refCode, tenantId } = options.replacements;
    const match = this.rows.find(
      (row) =>
        row.scope_level === level && row.scope_ref_code === refCode && row.tenant_id === tenantId,
    );
    return match ? [match] : [];
  }
}

function buildResolver(rows: Row[]): {
  resolver: RewardTrackingChannelResolverService;
  fake: FakeSequelize;
} {
  const fake = new FakeSequelize(rows);
  const resolver = new RewardTrackingChannelResolverService(fake as unknown as Sequelize);
  return { resolver, fake };
}

const GLOBAL_ROW = makeRow({
  scope_level: 'GLOBAL',
  rest_enabled: true,
  grpc_enabled: false,
  primary_channel: 'REST',
  fallback_channel: 'REST',
});

describe('T-INT-030 — RewardTrackingChannelResolverService', () => {
  it("TC-5: only the seeded GLOBAL row exists -> resolves REST primary (R1's own default)", async () => {
    const { resolver } = buildResolver([GLOBAL_ROW]);

    const resolved = await resolver.resolve({ campaignCode: 'CAMP_X', tenantId: 1 });

    expect(resolved).toEqual({
      primaryChannel: 'REST',
      fallbackChannel: 'REST',
      restEnabled: true,
      grpcEnabled: false,
    });
  });

  it('a CAMPAIGN-level row overrides GLOBAL for a matching campaignCode', async () => {
    const campaignRow = makeRow({
      scope_level: 'CAMPAIGN',
      scope_ref_code: 'CAMP_GRPC',
      grpc_enabled: true,
      primary_channel: 'GRPC',
    });
    const { resolver } = buildResolver([GLOBAL_ROW, campaignRow]);

    const resolved = await resolver.resolve({ campaignCode: 'CAMP_GRPC' });

    expect(resolved.primaryChannel).toBe('GRPC');
    expect(resolved.grpcEnabled).toBe(true);
  });

  it('full precedence: REWARD wins over TRACKER, CAMPAIGN and GLOBAL for the same request', async () => {
    const campaignRow = makeRow({ scope_level: 'CAMPAIGN', scope_ref_code: 'CAMP_2' });
    const trackerRow = makeRow({
      scope_level: 'TRACKER',
      scope_ref_code: 'TRK_2',
      primary_channel: 'GRPC',
      grpc_enabled: true,
    });
    const rewardRow = makeRow({
      scope_level: 'REWARD',
      scope_ref_code: 'RWD_2',
      primary_channel: 'REST',
    });
    const { resolver } = buildResolver([GLOBAL_ROW, campaignRow, trackerRow, rewardRow]);

    const resolved = await resolver.resolve({
      rewardCode: 'RWD_2',
      trackerCode: 'TRK_2',
      campaignCode: 'CAMP_2',
    });

    expect(resolved.primaryChannel).toBe('REST');
  });

  it('within one scope level, a tenant-specific row wins over the tenant-agnostic row at that same level', async () => {
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
      grpc_enabled: true,
      primary_channel: 'GRPC',
    });
    const { resolver } = buildResolver([GLOBAL_ROW, tenantAgnostic, tenantSpecific]);

    const forTenant42 = await resolver.resolve({ campaignCode: 'CAMP_TENANT', tenantId: 42 });
    const forOtherTenant = await resolver.resolve({ campaignCode: 'CAMP_TENANT', tenantId: 99 });

    expect(forTenant42.primaryChannel).toBe('GRPC');
    expect(forOtherTenant.primaryChannel).toBe('REST');
  });

  it('a level with no ref code supplied by the caller is skipped entirely, never matched against a NULL-ref-code row of a different level', async () => {
    const trackerRow = makeRow({
      scope_level: 'TRACKER',
      scope_ref_code: 'TRK_ONLY',
      grpc_enabled: true,
      primary_channel: 'GRPC',
    });
    const { resolver, fake } = buildResolver([GLOBAL_ROW, trackerRow]);

    const resolved = await resolver.resolve({ trackerCode: 'TRK_ONLY' });

    expect(resolved.primaryChannel).toBe('GRPC');
    expect(fake.callCount).toBe(1);
  });

  it('no row resolves at any scope, including no GLOBAL row -> throws RewardTrackingChannelResolutionError, never a guessed default', async () => {
    const { resolver } = buildResolver([]);

    await expect(resolver.resolve({ campaignCode: 'NOTHING_HERE' })).rejects.toThrow(
      RewardTrackingChannelResolutionError,
    );
  });

  it('resolution is never a merge across levels — every field comes from the one matching row', async () => {
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

  it("an empty context (no campaignCode/tenantId at all) still resolves via GLOBAL — the tenant/country/alerts endpoints' own shape", async () => {
    const { resolver } = buildResolver([GLOBAL_ROW]);

    const resolved = await resolver.resolve({});

    expect(resolved.primaryChannel).toBe('REST');
  });
});
