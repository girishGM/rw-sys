/**
 * T-RR-007 — `ExternalRewardSystemConfigCache`. TC-1/TC-2 from the task file are literally about
 * this cache; the rest mirror `tenant-schema-config.cache.spec.ts`'s own coverage shape.
 */
import type { ExternalRewardSystemConfigRow } from '@/database/models/external-reward-system-config.model';
import { ExternalRewardSystemConfigCache } from '@/modules/tenant-schema-cache/external-reward-system-config.cache';
import type { ExternalRewardSystemConfigRepository } from '@/modules/tenant-schema-cache/external-reward-system-config.repository';
import type { ServiceConfigCache } from '@/modules/tenant-schema-cache/service-config.cache';

function makeRow(
  overrides: Partial<ExternalRewardSystemConfigRow> = {},
): ExternalRewardSystemConfigRow {
  return {
    id: 1,
    system_code: 'PROMO_CODE_SERVICE',
    tenant_id: null,
    connector_type: 'PROMO_CODE_SERVICE',
    endpoint_url: 'https://example.invalid/generate',
    auth_secret_ref: 'GENERATION_SERVICE_TOKEN',
    retryable_error_codes: ['GENERATION_EXHAUSTED'],
    max_retry_attempts: 5,
    retry_backoff_base_ms: 500,
    retry_backoff_max_ms: 30000,
    status: 'active',
    created_at: new Date(),
    updated_at: new Date(),
    tenant_key: -1,
    ...overrides,
  };
}

function build(ttlSeconds = 300): {
  cache: ExternalRewardSystemConfigCache;
  findOne: jest.Mock;
  findAll: jest.Mock;
} {
  const findOne = jest.fn();
  const findAll = jest.fn();
  const repository = {
    findBySystemCodeAndTenantKey: findOne,
    findAll,
  } as unknown as ExternalRewardSystemConfigRepository;
  const serviceConfigCache = {
    resolve: jest.fn().mockResolvedValue(ttlSeconds),
  } as unknown as ServiceConfigCache;
  const cache = new ExternalRewardSystemConfigCache(repository, serviceConfigCache);
  return { cache, findOne, findAll };
}

describe('T-RR-007 — ExternalRewardSystemConfigCache', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // TC-1.
  it('TC-1: a second read within TTL returns the cached value without a second DB query', async () => {
    const { cache, findOne } = build();
    findOne.mockResolvedValue(makeRow());

    await cache.get({ systemCode: 'PROMO_CODE_SERVICE', tenantId: null });
    await cache.get({ systemCode: 'PROMO_CODE_SERVICE', tenantId: null });

    expect(findOne).toHaveBeenCalledTimes(1);
  });

  // TC-2.
  it('TC-2: re-fetches from the DB once the TTL has elapsed', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
    const { cache, findOne } = build(1);
    findOne.mockResolvedValue(makeRow());

    await cache.get({ systemCode: 'PROMO_CODE_SERVICE', tenantId: null });
    nowSpy.mockReturnValue(2_000_000 + 1_001);
    await cache.get({ systemCode: 'PROMO_CODE_SERVICE', tenantId: null });

    expect(findOne).toHaveBeenCalledTimes(2);
  });

  it('coalesces a missing tenantId to tenant_key -1, distinct from a real tenant override', async () => {
    const { cache, findOne } = build();
    findOne.mockResolvedValue(makeRow());

    await cache.get({ systemCode: 'PROMO_CODE_SERVICE' });
    await cache.get({ systemCode: 'PROMO_CODE_SERVICE', tenantId: 7 });

    expect(findOne).toHaveBeenNthCalledWith(1, 'PROMO_CODE_SERVICE', -1);
    expect(findOne).toHaveBeenNthCalledWith(2, 'PROMO_CODE_SERVICE', 7);
  });

  it('caches a confirmed "no row" result as null, distinct from "not yet cached"', async () => {
    const { cache, findOne } = build();
    findOne.mockResolvedValue(null);

    const first = await cache.get({ systemCode: 'UNKNOWN_SYSTEM' });
    const second = await cache.get({ systemCode: 'UNKNOWN_SYSTEM' });

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(findOne).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces the next read to re-fetch even within the TTL window', async () => {
    const { cache, findOne } = build(300);
    findOne.mockResolvedValue(makeRow());

    await cache.get({ systemCode: 'PROMO_CODE_SERVICE', tenantId: null });
    cache.invalidate();
    await cache.get({ systemCode: 'PROMO_CODE_SERVICE', tenantId: null });

    expect(findOne).toHaveBeenCalledTimes(2);
  });

  it('refreshAll() repopulates by the row’s own real tenant_key column', async () => {
    const { cache, findOne, findAll } = build();
    findAll.mockResolvedValue([
      makeRow({ system_code: 'PROMO_CODE_SERVICE', tenant_id: null, tenant_key: -1 }),
      makeRow({ system_code: 'PROMO_CODE_SERVICE', tenant_id: 7, tenant_key: 7 }),
    ]);

    await cache.refreshAll();
    const globalRow = await cache.get({ systemCode: 'PROMO_CODE_SERVICE' });
    const tenantRow = await cache.get({ systemCode: 'PROMO_CODE_SERVICE', tenantId: 7 });

    expect(findAll).toHaveBeenCalledTimes(1);
    expect(findOne).not.toHaveBeenCalled();
    expect(globalRow?.tenant_key).toBe(-1);
    expect(tenantRow?.tenant_key).toBe(7);
  });
});
