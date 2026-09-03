/**
 * T-RAP-013. Integration tests against the real local Postgres 16 server (root `CLAUDE.md`),
 * connected as the real least-privilege `rap_app` role — same real-DB convention
 * `field-encryption-config.repository.spec.ts` (T-RAP-012) already established for this
 * project's `agent-rap-cache` file-scope owner.
 *
 * Also serves as Verification step 2 from the task file: a tenant-scoped override inserted
 * directly via SQL is found by `findAll()` and, through `ServiceConfigResolverService`, resolved
 * in preference to the seeded global default.
 */
import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { ServiceConfigRepository } from '@/modules/service-config/service-config.repository';
import { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';

// A scope_ref far outside any real tenant id this repo would ever use, so this suite's own rows
// never collide with T-RAP-003's seeded global defaults (whose scope_ref is always NULL).
const TEST_TENANT_ID = String(900_000 + Math.floor(Math.random() * 90_000));

describe('ServiceConfigRepository (real Postgres, rap_app role)', () => {
  let sequelize: Sequelize;
  let repository: ServiceConfigRepository;

  beforeAll(async () => {
    sequelize = new Sequelize({
      dialect: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_NAME,
      username: process.env.DB_APP_USERNAME,
      password: process.env.DB_APP_PASSWORD,
      logging: false,
    });
    await sequelize.authenticate();
    repository = new ServiceConfigRepository(sequelize);
  });

  afterAll(async () => {
    await sequelize.query(
      `DELETE FROM realtime_activity_processing.service_config WHERE scope_ref = :scopeRef`,
      { type: QueryTypes.RAW, replacements: { scopeRef: TEST_TENANT_ID } },
    );
    await sequelize.close();
  });

  // T-RAP-003 seeds exactly four global rows — 01-DATABASE.md §11's own examples.
  it('findAll returns the T-RAP-003 seeded global default rows', async () => {
    const rows = await repository.findAll();

    const pollInterval = rows.find(
      (row) =>
        row.config_key === 'reconciliation_poll_interval_seconds' && row.scope_level === 'global',
    );
    expect(pollInterval).toBeDefined();
    expect(pollInterval?.scope_ref).toBeNull();
    expect(pollInterval?.config_value).toBe('300');

    expect(
      rows.find(
        (row) =>
          row.config_key === 'dedup_composite_fallback_enabled' && row.scope_level === 'global',
      ),
    ).toBeDefined();
    expect(
      rows.find(
        (row) =>
          row.config_key === 'reward_dispatch_max_retry_attempts' && row.scope_level === 'global',
      ),
    ).toBeDefined();
    expect(
      rows.find(
        (row) => row.config_key === 'advisory_lock_wait_timeout_ms' && row.scope_level === 'global',
      ),
    ).toBeDefined();
  });

  // Verification step 2: insert a tenant-scoped override directly via SQL, resolve with that
  // tenant in context, and confirm the override wins over the global default.
  it('a tenant-scoped override inserted directly via SQL is resolved in preference to the global default', async () => {
    await sequelize.query(
      `INSERT INTO realtime_activity_processing.service_config
         (config_key, config_value, scope_level, scope_ref, description)
       VALUES ('reconciliation_poll_interval_seconds', '45', 'tenant', :scopeRef, 'T-RAP-013 test override')`,
      { type: QueryTypes.RAW, replacements: { scopeRef: TEST_TENANT_ID } },
    );

    const resolver = new ServiceConfigResolverService(repository);
    await resolver.refresh();

    expect(
      resolver.getReconciliationPollIntervalSeconds({ tenantId: Number(TEST_TENANT_ID) }),
    ).toBe(45);
    // A different tenant, not covered by the override, still gets the global default.
    expect(resolver.getReconciliationPollIntervalSeconds({ tenantId: -1 })).toBe(300);
  });
});
