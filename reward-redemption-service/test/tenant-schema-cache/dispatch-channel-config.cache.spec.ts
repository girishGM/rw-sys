/**
 * T-RR-007 — `DispatchChannelConfigCache`. Same coverage shape as the other three caches' specs.
 */
import type { DispatchChannelConfigRow } from '@/database/models/dispatch-channel-config.model';
import { DispatchChannelConfigCache } from '@/modules/tenant-schema-cache/dispatch-channel-config.cache';
import type { DispatchChannelConfigRepository } from '@/modules/tenant-schema-cache/dispatch-channel-config.repository';
import type { ServiceConfigCache } from '@/modules/tenant-schema-cache/service-config.cache';

function makeRow(overrides: Partial<DispatchChannelConfigRow> = {}): DispatchChannelConfigRow {
  return {
    id: 1,
    scope_level: 'GLOBAL',
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

function build(ttlSeconds = 300): {
  cache: DispatchChannelConfigCache;
  findByScope: jest.Mock;
  findAll: jest.Mock;
} {
  const findByScope = jest.fn();
  const findAll = jest.fn();
  const repository = { findByScope, findAll } as unknown as DispatchChannelConfigRepository;
  const serviceConfigCache = {
    resolve: jest.fn().mockResolvedValue(ttlSeconds),
  } as unknown as ServiceConfigCache;
  const cache = new DispatchChannelConfigCache(repository, serviceConfigCache);
  return { cache, findByScope, findAll };
}

describe('T-RR-007 — DispatchChannelConfigCache', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a second read within TTL returns the cached value without a second repository query', async () => {
    const { cache, findByScope } = build();
    findByScope.mockResolvedValue(makeRow());

    await cache.get({ scopeLevel: 'GLOBAL', scopeRefCode: null, tenantId: null });
    await cache.get({ scopeLevel: 'GLOBAL', scopeRefCode: null, tenantId: null });

    expect(findByScope).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the cached entry has expired', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(3_000_000);
    const { cache, findByScope } = build(1);
    findByScope.mockResolvedValue(makeRow());

    await cache.get({ scopeLevel: 'GLOBAL', scopeRefCode: null, tenantId: null });
    nowSpy.mockReturnValue(3_000_000 + 1_001);
    await cache.get({ scopeLevel: 'GLOBAL', scopeRefCode: null, tenantId: null });

    expect(findByScope).toHaveBeenCalledTimes(2);
  });

  it('does not conflate a REWARD-scoped key with the GLOBAL key', async () => {
    const { cache, findByScope } = build();
    findByScope
      .mockResolvedValueOnce(makeRow({ scope_level: 'REWARD', scope_ref_code: 'RWD1' }))
      .mockResolvedValueOnce(makeRow());

    const reward = await cache.get({ scopeLevel: 'REWARD', scopeRefCode: 'RWD1', tenantId: null });
    const global = await cache.get({ scopeLevel: 'GLOBAL', scopeRefCode: null, tenantId: null });

    expect(reward?.scope_level).toBe('REWARD');
    expect(global?.scope_level).toBe('GLOBAL');
    expect(findByScope).toHaveBeenCalledTimes(2);
  });

  it('invalidate() forces the next read to re-fetch even within the TTL window', async () => {
    const { cache, findByScope } = build(300);
    findByScope.mockResolvedValue(makeRow());

    await cache.get({ scopeLevel: 'GLOBAL', scopeRefCode: null, tenantId: null });
    cache.invalidate();
    await cache.get({ scopeLevel: 'GLOBAL', scopeRefCode: null, tenantId: null });

    expect(findByScope).toHaveBeenCalledTimes(2);
  });

  it('refreshAll() reloads every row in one round trip and repopulates every key', async () => {
    const { cache, findByScope, findAll } = build();
    findAll.mockResolvedValue([
      makeRow(),
      makeRow({ scope_level: 'REWARD', scope_ref_code: 'RWD1' }),
    ]);

    await cache.refreshAll();
    const global = await cache.get({ scopeLevel: 'GLOBAL', scopeRefCode: null, tenantId: null });
    const reward = await cache.get({ scopeLevel: 'REWARD', scopeRefCode: 'RWD1', tenantId: null });

    expect(findAll).toHaveBeenCalledTimes(1);
    expect(findByScope).not.toHaveBeenCalled();
    expect(global?.scope_level).toBe('GLOBAL');
    expect(reward?.scope_level).toBe('REWARD');
  });
});
