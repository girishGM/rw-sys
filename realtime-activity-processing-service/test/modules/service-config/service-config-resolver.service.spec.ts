/**
 * T-RAP-013. Unit tests against a stub `ServiceConfigRepository` — pure precedence/validation
 * logic coverage, no DB. The real repository's own DB round trip is covered separately in
 * `service-config.repository.spec.ts`.
 */
import type { ServiceConfigRow } from '@/database/models/service-config.model';
import { ServiceConfigRepository } from '@/modules/service-config/service-config.repository';
import {
  SERVICE_CONFIG_KEYS,
  ServiceConfigResolverService,
} from '@/modules/service-config/service-config-resolver.service';

function row(
  overrides: Partial<ServiceConfigRow> & Pick<ServiceConfigRow, 'config_key' | 'scope_level'>,
): ServiceConfigRow {
  return {
    id: 1,
    config_value: '',
    scope_ref: null,
    description: null,
    updated_at: new Date(),
    ...overrides,
  };
}

function stubRepository(rows: ServiceConfigRow[]): ServiceConfigRepository {
  return { findAll: jest.fn().mockResolvedValue(rows) } as unknown as ServiceConfigRepository;
}

// The exact fixture T-RAP-003 seeds in the real DB — mirrored here so this suite proves the
// *precedence/validation logic*, not "does the real DB have a row", which the repository spec
// already covers.
const SEEDED_DEFAULT_ROWS: ServiceConfigRow[] = [
  row({
    id: 1,
    config_key: 'reconciliation_poll_interval_seconds',
    config_value: '300',
    scope_level: 'global',
  }),
  row({
    id: 2,
    config_key: 'dedup_composite_fallback_enabled',
    config_value: 'true',
    scope_level: 'global',
  }),
  row({
    id: 3,
    config_key: 'reward_dispatch_max_retry_attempts',
    config_value: '8',
    scope_level: 'global',
  }),
  row({
    id: 4,
    config_key: 'advisory_lock_wait_timeout_ms',
    config_value: '5000',
    scope_level: 'global',
  }),
];

describe('ServiceConfigResolverService', () => {
  // TC-1
  it('resolves a key with only a global row, returning the global value', async () => {
    const resolver = new ServiceConfigResolverService(stubRepository(SEEDED_DEFAULT_ROWS));
    await resolver.refresh();
    expect(resolver.resolve('reconciliation_poll_interval_seconds', {})).toBe('300');
  });

  // TC-2
  it('returns the tenant value when both a global and a tenant-scoped row exist and the tenant is in context', async () => {
    const rows: ServiceConfigRow[] = [
      row({
        config_key: 'reward_dispatch_max_retry_attempts',
        config_value: '8',
        scope_level: 'global',
      }),
      row({
        config_key: 'reward_dispatch_max_retry_attempts',
        config_value: '3',
        scope_level: 'tenant',
        scope_ref: '7',
      }),
    ];
    const resolver = new ServiceConfigResolverService(stubRepository(rows));
    await resolver.refresh();

    expect(resolver.resolve('reward_dispatch_max_retry_attempts', { tenantId: 7 })).toBe('3');
    // Out-of-scope tenant still falls through to the global default.
    expect(resolver.resolve('reward_dispatch_max_retry_attempts', { tenantId: 99 })).toBe('8');
  });

  // TC-3
  it('a campaign-scoped row overrides tenant/country/global even when all four exist', async () => {
    const rows: ServiceConfigRow[] = [
      row({
        config_key: 'advisory_lock_wait_timeout_ms',
        config_value: '5000',
        scope_level: 'global',
      }),
      row({
        config_key: 'advisory_lock_wait_timeout_ms',
        config_value: '4000',
        scope_level: 'country',
        scope_ref: 'US',
      }),
      row({
        config_key: 'advisory_lock_wait_timeout_ms',
        config_value: '3000',
        scope_level: 'tenant',
        scope_ref: '7',
      }),
      row({
        config_key: 'advisory_lock_wait_timeout_ms',
        config_value: '2000',
        scope_level: 'campaign',
        scope_ref: 'CAMP1',
      }),
    ];
    const resolver = new ServiceConfigResolverService(stubRepository(rows));
    await resolver.refresh();

    expect(
      resolver.resolve('advisory_lock_wait_timeout_ms', {
        campaignCode: 'CAMP1',
        tenantId: 7,
        countryCode: 'US',
      }),
    ).toBe('2000');
    // Falls through to tenant (next in precedence) when campaign doesn't match.
    expect(
      resolver.resolve('advisory_lock_wait_timeout_ms', {
        campaignCode: 'CAMP2',
        tenantId: 7,
        countryCode: 'US',
      }),
    ).toBe('3000');
    // Falls through to country when neither campaign nor tenant match.
    expect(
      resolver.resolve('advisory_lock_wait_timeout_ms', {
        campaignCode: 'CAMP2',
        tenantId: 99,
        countryCode: 'US',
      }),
    ).toBe('4000');
  });

  // TC-4
  it('throws a clear "unconfigured key" error rather than returning undefined for an unknown key', async () => {
    const resolver = new ServiceConfigResolverService(stubRepository(SEEDED_DEFAULT_ROWS));
    await resolver.refresh();

    expect(() => resolver.resolve('some_key_nobody_ever_seeded', {})).toThrow(
      /Unconfigured service_config key "some_key_nobody_ever_seeded"/,
    );
  });

  it('typed integer wrappers also throw the "unconfigured key" error rather than returning NaN/0', async () => {
    const resolver = new ServiceConfigResolverService(stubRepository([]));
    await resolver.refresh();

    expect(() => resolver.getReconciliationPollIntervalSeconds()).toThrow(
      /Unconfigured service_config key/,
    );
  });

  // TC-5
  it('a malformed integer config_value throws a clear validation error naming the offending row', async () => {
    const rows: ServiceConfigRow[] = [
      row({
        id: 42,
        config_key: 'reconciliation_poll_interval_seconds',
        config_value: 'not-a-number',
        scope_level: 'global',
      }),
    ];
    const resolver = new ServiceConfigResolverService(stubRepository(rows));
    await resolver.refresh();

    expect(() => resolver.getReconciliationPollIntervalSeconds()).toThrow(
      /Invalid service_config value for "reconciliation_poll_interval_seconds".*id=42/s,
    );
  });

  it('a zero or negative integer config_value is also rejected as malformed (implementation note 2: must be positive)', async () => {
    const rows: ServiceConfigRow[] = [
      row({
        id: 5,
        config_key: 'reward_dispatch_max_retry_attempts',
        config_value: '0',
        scope_level: 'global',
      }),
    ];
    const resolver = new ServiceConfigResolverService(stubRepository(rows));
    await resolver.refresh();

    expect(() => resolver.getRewardDispatchMaxRetryAttempts()).toThrow(
      /Invalid service_config value for "reward_dispatch_max_retry_attempts"/,
    );
  });

  it('a malformed boolean config_value throws a clear validation error naming the offending row', async () => {
    const rows: ServiceConfigRow[] = [
      row({
        id: 9,
        config_key: 'dedup_composite_fallback_enabled',
        config_value: 'yes',
        scope_level: 'global',
      }),
    ];
    const resolver = new ServiceConfigResolverService(stubRepository(rows));
    await resolver.refresh();

    expect(() => resolver.getDedupCompositeFallbackEnabled()).toThrow(
      /Invalid service_config value for "dedup_composite_fallback_enabled".*id=9/s,
    );
  });

  it('typed wrappers against the seeded default config return correctly parsed values', async () => {
    const resolver = new ServiceConfigResolverService(stubRepository(SEEDED_DEFAULT_ROWS));
    await resolver.refresh();

    expect(resolver.getReconciliationPollIntervalSeconds()).toBe(300);
    expect(resolver.getRewardDispatchMaxRetryAttempts()).toBe(8);
    expect(resolver.getAdvisoryLockWaitTimeoutMs()).toBe(5000);
    expect(resolver.getDedupCompositeFallbackEnabled()).toBe(true);
  });

  it('SERVICE_CONFIG_KEYS constants match the literal config_key strings T-RAP-003 seeds', () => {
    expect(SERVICE_CONFIG_KEYS.RECONCILIATION_POLL_INTERVAL_SECONDS).toBe(
      'reconciliation_poll_interval_seconds',
    );
    expect(SERVICE_CONFIG_KEYS.REWARD_DISPATCH_MAX_RETRY_ATTEMPTS).toBe(
      'reward_dispatch_max_retry_attempts',
    );
    expect(SERVICE_CONFIG_KEYS.ADVISORY_LOCK_WAIT_TIMEOUT_MS).toBe('advisory_lock_wait_timeout_ms');
    expect(SERVICE_CONFIG_KEYS.DEDUP_COMPOSITE_FALLBACK_ENABLED).toBe(
      'dedup_composite_fallback_enabled',
    );
  });

  it('refresh replaces the previous rule set rather than merging with it', async () => {
    const repository = stubRepository(SEEDED_DEFAULT_ROWS);
    const resolver = new ServiceConfigResolverService(repository);
    await resolver.refresh();
    expect(resolver.resolve('reconciliation_poll_interval_seconds', {})).toBe('300');

    (repository.findAll as jest.Mock).mockResolvedValue([
      row({
        config_key: 'reconciliation_poll_interval_seconds',
        config_value: '600',
        scope_level: 'global',
      }),
    ]);
    await resolver.refresh();
    expect(resolver.resolve('reconciliation_poll_interval_seconds', {})).toBe('600');
  });
});
