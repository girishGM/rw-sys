/**
 * T-RR-080 — `PromoCodeChannelResolverService`, unit-tested against a fake `pg.Pool` substitute
 * (mirroring `FIND_ONE_SQL`'s own exact-triple lookup in plain JS) — same "the precedence/caching
 * logic is pure and doesn't need a real DB round trip to verify" reasoning
 * `dispatch-channel-resolver.spec.ts` (T-RR-033) documents for its own fake-repository suite. The
 * real table's own SQL (`IS NOT DISTINCT FROM`, the `uq_pccc` unique constraint, the seeded
 * `GLOBAL` row) is exercised for real by `promo-code-service.connector.channel-switch.spec.ts`
 * against the actual local Postgres server.
 */
import 'reflect-metadata';
import type { Pool } from 'pg';
import type {
  PromoCodeChannelConfigRow,
  PromoCodeChannelScopeLevel,
} from '@/database/models/promo-code-channel-config.model';
import {
  PromoCodeChannelResolutionError,
  PromoCodeChannelResolverService,
} from '@/modules/connectors/promo-code-channel-resolver.service';

let nextId = 1;

function makeRow(
  overrides: Partial<PromoCodeChannelConfigRow> & Pick<PromoCodeChannelConfigRow, 'scope_level'>,
): PromoCodeChannelConfigRow {
  return {
    id: nextId++,
    scope_ref_code: null,
    tenant_id: null,
    rest_enabled: true,
    grpc_enabled: false,
    // T-RR-081, migration `019`.
    kafka_enabled: false,
    primary_channel: 'REST',
    fallback_channel: 'REST',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

/** Fake `pg.Pool` substitute mirroring `FIND_ONE_SQL`'s own `IS NOT DISTINCT FROM` semantics in
 * plain JS — `null` matches `null` on both nullable columns, exactly like real Postgres would. */
class FakePool {
  public callCount = 0;

  constructor(private readonly rows: PromoCodeChannelConfigRow[]) {}

  async query(
    _text: string,
    params: [PromoCodeChannelScopeLevel, string | null, number | null],
  ): Promise<{ rows: PromoCodeChannelConfigRow[] }> {
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

function buildResolver(rows: PromoCodeChannelConfigRow[]): {
  resolver: PromoCodeChannelResolverService;
  pool: FakePool;
} {
  const pool = new FakePool(rows);
  const resolver = new PromoCodeChannelResolverService(
    // Never actually called — the fake pool is always supplied, so `new Pool(...)` in the real
    // constructor branch never runs.
    { get: () => undefined } as never,
    pool as unknown as Pool,
  );
  return { resolver, pool };
}

const GLOBAL_ROW = makeRow({
  scope_level: 'GLOBAL',
  rest_enabled: true,
  grpc_enabled: false,
  primary_channel: 'REST',
  fallback_channel: 'REST',
});

describe('T-RR-080 — PromoCodeChannelResolverService', () => {
  it("TC-1: no override row anywhere, only the seeded GLOBAL row -> resolves REST/REST (today's exact behavior)", async () => {
    const { resolver } = buildResolver([GLOBAL_ROW]);

    const resolved = await resolver.resolve({
      rewardCode: 'REWARD_X',
      trackerCode: 'TRACKER_X',
      campaignCode: 'CAMPAIGN_X',
      tenantId: 1,
    });

    expect(resolved).toEqual({
      primaryChannel: 'REST',
      fallbackChannel: 'REST',
      restEnabled: true,
      grpcEnabled: false,
      kafkaEnabled: false,
    });
  });

  it('TC-2: a CAMPAIGN-level row with primary_channel=GRPC, grpc_enabled=true overrides GLOBAL', async () => {
    const campaignRow = makeRow({
      scope_level: 'CAMPAIGN',
      scope_ref_code: 'CAMP_GRPC',
      grpc_enabled: true,
      primary_channel: 'GRPC',
      fallback_channel: 'REST',
    });
    const { resolver } = buildResolver([GLOBAL_ROW, campaignRow]);

    const resolved = await resolver.resolve({ campaignCode: 'CAMP_GRPC' });

    expect(resolved.primaryChannel).toBe('GRPC');
    expect(resolved.grpcEnabled).toBe(true);
  });

  it("TC-3: a misconfigured row (grpc_enabled=false, primary_channel=GRPC) is returned verbatim — normalizing it to REST is the caller's own job, not this resolver's", async () => {
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
      kafkaEnabled: false,
    });
  });

  it('TC-4: TRACKER-level row wins over a CAMPAIGN-level row for the same request', async () => {
    const campaignRow = makeRow({
      scope_level: 'CAMPAIGN',
      scope_ref_code: 'CAMP_1',
      primary_channel: 'REST',
    });
    const trackerRow = makeRow({
      scope_level: 'TRACKER',
      scope_ref_code: 'TRK_1',
      grpc_enabled: true,
      primary_channel: 'GRPC',
    });
    const { resolver } = buildResolver([GLOBAL_ROW, campaignRow, trackerRow]);

    const resolved = await resolver.resolve({ trackerCode: 'TRK_1', campaignCode: 'CAMP_1' });

    expect(resolved.primaryChannel).toBe('GRPC');
  });

  it('TC-5: REWARD-level row wins over TRACKER and CAMPAIGN for the same request (full precedence)', async () => {
    const campaignRow = makeRow({ scope_level: 'CAMPAIGN', scope_ref_code: 'CAMP_2' });
    const trackerRow = makeRow({
      scope_level: 'TRACKER',
      scope_ref_code: 'TRK_2',
      grpc_enabled: true,
      primary_channel: 'GRPC',
    });
    const rewardRow = makeRow({
      scope_level: 'REWARD',
      scope_ref_code: 'RWD_2',
      rest_enabled: true,
      grpc_enabled: false,
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

  it('TC-6: within one scope level, a tenant-specific row wins over the tenant-agnostic row at that same level', async () => {
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

  it('TC-7: a level with no ref code supplied by the caller is skipped entirely, never matched against a NULL-ref-code row of a different level', async () => {
    const trackerRow = makeRow({
      scope_level: 'TRACKER',
      scope_ref_code: 'TRK_ONLY',
      grpc_enabled: true,
      primary_channel: 'GRPC',
    });
    const { resolver, pool } = buildResolver([GLOBAL_ROW, trackerRow]);

    // No rewardCode/campaignCode supplied at all — only REWARD is skipped since it's the one
    // undefined field; TRACKER/CAMPAIGN/GLOBAL are still walked in order.
    const resolved = await resolver.resolve({ trackerCode: 'TRK_ONLY' });

    expect(resolved.primaryChannel).toBe('GRPC');
    // TRACKER matched on the very first candidate that could ever match it — never fell through
    // to a CAMPAIGN/GLOBAL lookup unnecessarily beyond the one exact-triple call per level tried.
    expect(pool.callCount).toBe(1);
  });

  it('TC-8: no row resolves at any scope, including no GLOBAL row -> throws PromoCodeChannelResolutionError, never a guessed default', async () => {
    const { resolver } = buildResolver([]);

    await expect(resolver.resolve({ campaignCode: 'NOTHING_HERE' })).rejects.toThrow(
      PromoCodeChannelResolutionError,
    );
  });

  it('TC-9: resolution is never a merge across levels — the first matching level wins outright, every field from that one row', async () => {
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

    // Every field comes from the CAMPAIGN row, none from GLOBAL — including restEnabled=false,
    // which a naive "merge, GLOBAL fills gaps" implementation could have wrongly left as `true`.
    expect(resolved).toEqual({
      primaryChannel: 'GRPC',
      fallbackChannel: 'GRPC',
      restEnabled: false,
      grpcEnabled: true,
      kafkaEnabled: false,
    });
  });
});
