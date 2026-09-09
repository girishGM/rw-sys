/**
 * T-RR-023 — `ExternalRewardSystemConfigResolver`. Unit-tested against a fake
 * `ExternalRewardSystemConfigCache` (the TTL/keying behaviour itself is already covered by
 * T-RR-007's own `external-reward-system-config.cache.spec.ts`) — this file isolates the
 * tenant-specific-overrides-tenant-agnostic fallback logic (implementation note 1) and the
 * "no active row" non-throwing outcome (implementation note 2).
 */
import type { ExternalRewardSystemConfigRow } from '@/database/models/external-reward-system-config.model';
import { ExternalRewardSystemConfigResolver } from '@/modules/reward-system-config/external-reward-system-config.resolver';
import type {
  ExternalRewardSystemConfigCache,
  ExternalRewardSystemConfigKey,
} from '@/modules/tenant-schema-cache/external-reward-system-config.cache';

function buildRow(
  overrides: Partial<ExternalRewardSystemConfigRow> = {},
): ExternalRewardSystemConfigRow {
  return {
    id: 1,
    system_code: 'PROMO_CODE_SERVICE',
    tenant_id: null,
    connector_type: 'PROMO_CODE_SERVICE',
    endpoint_url: 'https://promo-code-service.internal/api',
    auth_secret_ref: 'PROMO_CODE_SERVICE_AUTH',
    retryable_error_codes: ['GENERATION_EXHAUSTED'],
    max_retry_attempts: 5,
    retry_backoff_base_ms: 500,
    retry_backoff_max_ms: 30000,
    status: 'active',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    tenant_key: -1,
    ...overrides,
  };
}

function buildResolver(rows: Map<string, ExternalRewardSystemConfigRow | null>): {
  resolver: ExternalRewardSystemConfigResolver;
  get: jest.Mock;
} {
  const get = jest.fn(async (key: ExternalRewardSystemConfigKey) => {
    const tenantKey = key.tenantId ?? -1;
    return rows.get(`${key.systemCode}::${tenantKey}`) ?? null;
  });
  const cache = { get } as unknown as ExternalRewardSystemConfigCache;
  return { resolver: new ExternalRewardSystemConfigResolver(cache), get };
}

describe('T-RR-023 — ExternalRewardSystemConfigResolver', () => {
  // TC-1.
  it('TC-1: returns the tenant-specific row when both a NULL-tenant row and a tenant-specific row exist', async () => {
    const tenantRow = buildRow({
      id: 2,
      tenant_id: 42,
      tenant_key: 42,
      endpoint_url: 'https://tenant-42.example',
    });
    const globalRow = buildRow({ id: 1, tenant_id: null, tenant_key: -1 });
    const { resolver, get } = buildResolver(
      new Map([
        ['PROMO_CODE_SERVICE::42', tenantRow],
        ['PROMO_CODE_SERVICE::-1', globalRow],
      ]),
    );

    const result = await resolver.resolve('PROMO_CODE_SERVICE', 42);

    expect(result).toEqual(tenantRow);
    expect(get).toHaveBeenCalledWith({ systemCode: 'PROMO_CODE_SERVICE', tenantId: 42 });
  });

  // TC-2.
  it('TC-2: falls back to the NULL-tenant row when no tenant-specific override exists', async () => {
    const globalRow = buildRow({ id: 1, tenant_id: null, tenant_key: -1 });
    const { resolver, get } = buildResolver(new Map([['PROMO_CODE_SERVICE::-1', globalRow]]));

    const result = await resolver.resolve('PROMO_CODE_SERVICE', 42);

    expect(result).toEqual(globalRow);
    expect(get).toHaveBeenCalledWith({ systemCode: 'PROMO_CODE_SERVICE', tenantId: 42 });
    expect(get).toHaveBeenCalledWith({ systemCode: 'PROMO_CODE_SERVICE', tenantId: null });
  });

  // TC-3.
  it('TC-3: returns null (not a throw) when no active row exists at all', async () => {
    const { resolver } = buildResolver(new Map());

    const result = await resolver.resolve('UNKNOWN_SYSTEM', 42);

    expect(result).toBeNull();
  });

  it('falls back to the NULL-tenant row when the tenant-specific row exists but is inactive', async () => {
    const inactiveTenantRow = buildRow({
      id: 2,
      tenant_id: 42,
      tenant_key: 42,
      status: 'inactive',
    });
    const globalRow = buildRow({ id: 1, tenant_id: null, tenant_key: -1 });
    const { resolver } = buildResolver(
      new Map([
        ['PROMO_CODE_SERVICE::42', inactiveTenantRow],
        ['PROMO_CODE_SERVICE::-1', globalRow],
      ]),
    );

    const result = await resolver.resolve('PROMO_CODE_SERVICE', 42);

    expect(result).toEqual(globalRow);
  });

  it('returns null when the only resolvable row (NULL-tenant) is inactive', async () => {
    const inactiveGlobalRow = buildRow({
      id: 1,
      tenant_id: null,
      tenant_key: -1,
      status: 'inactive',
    });
    const { resolver } = buildResolver(new Map([['PROMO_CODE_SERVICE::-1', inactiveGlobalRow]]));

    const result = await resolver.resolve('PROMO_CODE_SERVICE', 42);

    expect(result).toBeNull();
  });

  it('resolves the NULL-tenant row directly when no tenantId is supplied at all', async () => {
    const globalRow = buildRow({ id: 1, tenant_id: null, tenant_key: -1 });
    const { resolver, get } = buildResolver(new Map([['PROMO_CODE_SERVICE::-1', globalRow]]));

    const result = await resolver.resolve('PROMO_CODE_SERVICE', null);

    expect(result).toEqual(globalRow);
    // Never issues a redundant "tenant-specific" lookup for a null tenantId.
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith({ systemCode: 'PROMO_CODE_SERVICE', tenantId: null });
  });
});
