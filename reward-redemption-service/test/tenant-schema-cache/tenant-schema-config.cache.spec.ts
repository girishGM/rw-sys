/**
 * T-RR-007 — `TenantSchemaConfigCache`, unit-tested against fake `TenantSchemaConfigRepository`/
 * `ServiceConfigCache` collaborators (real-DB coverage of the underlying SQL belongs to a real-DB
 * spec, not this file — same "pure logic vs. real round trip" split T-RR-006's own
 * `service-config-resolver.service.spec.ts` already established).
 */
import type { TenantSchemaConfigRow } from '@/database/models/tenant-schema-config.model';
import { TenantSchemaConfigCache } from '@/modules/tenant-schema-cache/tenant-schema-config.cache';
import type { TenantSchemaConfigRepository } from '@/modules/tenant-schema-cache/tenant-schema-config.repository';
import type { ServiceConfigCache } from '@/modules/tenant-schema-cache/service-config.cache';

function makeRow(overrides: Partial<TenantSchemaConfigRow> = {}): TenantSchemaConfigRow {
  return {
    id: 1,
    tenant_id: 1,
    tenant_code: 'TEN1',
    country_code: 'US',
    environment: 'production',
    database_name: 'reward_system',
    schema_name: 'reward_redemption',
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function build(ttlSeconds = 300): {
  cache: TenantSchemaConfigCache;
  findActive: jest.Mock;
  findAllActive: jest.Mock;
  resolve: jest.Mock;
} {
  const findActive = jest.fn();
  const findAllActive = jest.fn();
  const resolve = jest.fn().mockResolvedValue(ttlSeconds);
  const repository = {
    findActiveByTenantAndEnvironment: findActive,
    findAllActive,
  } as unknown as TenantSchemaConfigRepository;
  const serviceConfigCache = { resolve } as unknown as ServiceConfigCache;
  const cache = new TenantSchemaConfigCache(repository, serviceConfigCache);
  return { cache, findActive, findAllActive, resolve };
}

describe('T-RR-007 — TenantSchemaConfigCache', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // TC-1 (per this cache).
  it('a second read within TTL returns the cached value without a second repository query', async () => {
    const { cache, findActive } = build();
    findActive.mockResolvedValue([makeRow()]);

    const first = await cache.get({ tenantId: 1, environment: 'production' });
    const second = await cache.get({ tenantId: 1, environment: 'production' });

    expect(first).toEqual(second);
    expect(findActive).toHaveBeenCalledTimes(1);
  });

  // TC-2 (per this cache).
  it('re-fetches once the cached entry has expired', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { cache, findActive } = build(1); // 1 second TTL
    findActive.mockResolvedValue([makeRow()]);

    await cache.get({ tenantId: 1, environment: 'production' });
    nowSpy.mockReturnValue(1_000_000 + 1_001); // past the 1s TTL
    await cache.get({ tenantId: 1, environment: 'production' });

    expect(findActive).toHaveBeenCalledTimes(2);
  });

  it('does not conflate two different (tenantId, environment) keys', async () => {
    const { cache, findActive } = build();
    findActive
      .mockResolvedValueOnce([makeRow({ tenant_id: 1 })])
      .mockResolvedValueOnce([makeRow({ tenant_id: 2 })]);

    await cache.get({ tenantId: 1, environment: 'production' });
    await cache.get({ tenantId: 2, environment: 'production' });

    expect(findActive).toHaveBeenCalledTimes(2);
  });

  // TC-3-equivalent: an explicit invalidate() forces the next read to re-fetch even though TTL
  // has not elapsed.
  it('invalidate() forces the next read to re-fetch even within the TTL window', async () => {
    const { cache, findActive } = build(300);
    findActive.mockResolvedValue([makeRow()]);

    await cache.get({ tenantId: 1, environment: 'production' });
    cache.invalidate();
    await cache.get({ tenantId: 1, environment: 'production' });

    expect(findActive).toHaveBeenCalledTimes(2);
  });

  // TC-7-equivalent (this cache's own contribution to the poller's wholesale refresh).
  it('refreshAll() reloads every active row in one round trip and repopulates every key', async () => {
    const { cache, findActive, findAllActive } = build();
    findAllActive.mockResolvedValue([
      makeRow({ tenant_id: 1, environment: 'production', country_code: 'US' }),
      makeRow({ tenant_id: 1, environment: 'production', country_code: 'CA' }),
      makeRow({ tenant_id: 2, environment: 'production', country_code: 'MY' }),
    ]);

    await cache.refreshAll();
    const tenant1Rows = await cache.get({ tenantId: 1, environment: 'production' });
    const tenant2Rows = await cache.get({ tenantId: 2, environment: 'production' });

    expect(findAllActive).toHaveBeenCalledTimes(1);
    expect(findActive).not.toHaveBeenCalled();
    expect(tenant1Rows).toHaveLength(2);
    expect(tenant2Rows).toHaveLength(1);
  });

  // TC-8-equivalent: concurrent reads for the same never-yet-cached key must not double-count in
  // a way that would matter — the repository may legitimately be called more than once under a
  // genuine race (this cache does no in-flight de-duplication, which is fine: a duplicate lookup
  // is idempotent, never a crash or a corrupted map).
  it('concurrent reads for the same key never throw, and both settle to a value', async () => {
    const { cache, findActive } = build();
    findActive.mockResolvedValue([makeRow()]);

    const [a, b] = await Promise.all([
      cache.get({ tenantId: 1, environment: 'production' }),
      cache.get({ tenantId: 1, environment: 'production' }),
    ]);

    expect(a).toEqual(b);
  });
});
