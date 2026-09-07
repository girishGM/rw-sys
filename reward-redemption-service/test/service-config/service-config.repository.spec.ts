/**
 * T-RR-006 — `ServiceConfigRepository`, exercised against the real Postgres 16 server
 * (root `CLAUDE.md`), connected as the real least-privilege `rr_app` role, never a mock/in-memory
 * DB — same real-DB convention `FieldEncryptionConfigRepository`'s own spec (T-RR-005) and
 * `RewardRedemptionEntryClaimRepository`'s own spec (T-RR-020) already established for this
 * service's repositories.
 *
 * Uses a dedicated, random `config_key` per test run so this suite's own rows never collide with
 * anything a later task seeds for a real knob.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type { ConfigService } from '@nestjs/config';
import { createMigrationConnection } from '@/database/migration-connection';
import { ServiceConfigRepository } from '@/modules/service-config/service-config.repository';
import type { Config } from '@/config/config.schema';

const CONFIG_KEY = `test.key.${randomUUID().slice(0, 8)}`;

/** Same substitution idiom as `field-encryption-config.repository.spec.ts`'s own
 * `realDbConfigService()` — reads the real `.env.development` values already loaded by
 * `test/database/env.setup.ts`. */
function realDbConfigService(): ConfigService<Config, true> {
  const values: Partial<Config> = {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: Number(process.env.DB_PORT),
    DB_NAME: process.env.DB_NAME,
    DB_SSL: process.env.DB_SSL === 'true',
    DB_APP_USERNAME: process.env.DB_APP_USERNAME,
    DB_APP_PASSWORD: process.env.DB_APP_PASSWORD,
  } as Partial<Config>;
  return {
    get: ((key: keyof Config) => values[key]) as ConfigService<Config, true>['get'],
  } as ConfigService<Config, true>;
}

async function insertRow(
  migrationDb: Sequelize,
  overrides: {
    scope_level: 'CAMPAIGN' | 'TENANT' | 'COUNTRY' | 'GLOBAL';
    scope_ref: string | null;
    config_value: string;
    value_type?: string;
  },
): Promise<void> {
  await migrationDb.query(
    `INSERT INTO reward_redemption.service_config
       (config_key, scope_level, scope_ref, config_value, value_type)
     VALUES (:configKey, :scopeLevel, :scopeRef, :configValue, :valueType)`,
    {
      type: QueryTypes.RAW,
      replacements: {
        configKey: CONFIG_KEY,
        scopeLevel: overrides.scope_level,
        scopeRef: overrides.scope_ref,
        configValue: overrides.config_value,
        valueType: overrides.value_type ?? 'string',
      },
    },
  );
}

describe('T-RR-006 — ServiceConfigRepository', () => {
  let migrationDb: Sequelize;
  let repository: ServiceConfigRepository;

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
    repository = new ServiceConfigRepository(realDbConfigService());
  });

  afterAll(async () => {
    await migrationDb.query(
      'DELETE FROM reward_redemption.service_config WHERE config_key = :configKey',
      { type: QueryTypes.RAW, replacements: { configKey: CONFIG_KEY } },
    );
    await migrationDb.close();
    await repository.onModuleDestroy();
  });

  it('findFirstMatch returns null when no row exists at any scope for the key', async () => {
    await expect(repository.findFirstMatch(`${CONFIG_KEY}.unseeded`, {})).resolves.toBeNull();
  });

  it('findFirstMatch returns the GLOBAL row when no more specific scope matches', async () => {
    await insertRow(migrationDb, {
      scope_level: 'GLOBAL',
      scope_ref: null,
      config_value: '5',
      value_type: 'int',
    });

    const row = await repository.findFirstMatch(CONFIG_KEY, {});

    expect(row?.scope_level).toBe('GLOBAL');
    expect(row?.config_value).toBe('5');
  });

  it('findFirstMatch prefers a CAMPAIGN row over the GLOBAL row when both match the given context', async () => {
    await insertRow(migrationDb, {
      scope_level: 'CAMPAIGN',
      scope_ref: 'CAMP1',
      config_value: '99',
      value_type: 'int',
    });

    const row = await repository.findFirstMatch(CONFIG_KEY, { campaignCode: 'CAMP1' });

    expect(row?.scope_level).toBe('CAMPAIGN');
    expect(row?.config_value).toBe('99');
  });

  it('findFirstMatch falls through CAMPAIGN (no match) to a matching TENANT row', async () => {
    await insertRow(migrationDb, {
      scope_level: 'TENANT',
      scope_ref: 'TEN1',
      config_value: '42',
      value_type: 'int',
    });

    const row = await repository.findFirstMatch(CONFIG_KEY, {
      campaignCode: 'CAMP_NO_MATCH',
      tenantCode: 'TEN1',
    });

    expect(row?.scope_level).toBe('TENANT');
    expect(row?.config_value).toBe('42');
  });

  it('findAll includes every seeded row for this key', async () => {
    const rows = await repository.findAll();
    const mine = rows.filter((r) => r.config_key === CONFIG_KEY);

    expect(mine).toHaveLength(3);
    expect(mine.map((r) => r.scope_level).sort()).toEqual(['CAMPAIGN', 'GLOBAL', 'TENANT']);
  });

  // A non-NULL `scope_ref` duplicate (e.g. the CAMPAIGN row seeded above), not a second GLOBAL
  // row: `uq_sc_key_scope UNIQUE (config_key, scope_level, scope_ref)` is a standard Postgres
  // unique constraint, and standard SQL treats every NULL as distinct from every other NULL for
  // uniqueness purposes — this plan deliberately did not opt into Postgres 15's `NULLS NOT
  // DISTINCT` for this table (root `CLAUDE.md`'s AR-02 note, made for a different table but the
  // same underlying decision), so two GLOBAL (`scope_ref IS NULL`) rows for the same `config_key`
  // are NOT rejected by this constraint. That is a pre-existing, accepted property of the schema
  // T-RR-003 already built and reviewed, not something this task's resolver needs to guard
  // against — `ServiceConfigResolverService.resolve()` would simply pick whichever GLOBAL row
  // `findFirstMatch`'s `LIMIT 1` happens to return first if that ever occurred in practice.
  it('a duplicate (config_key, scope_level, scope_ref) insert is rejected by the DB for a non-NULL scope_ref', async () => {
    await expect(
      migrationDb.query(
        `INSERT INTO reward_redemption.service_config
           (config_key, scope_level, scope_ref, config_value, value_type)
         VALUES (:configKey, 'CAMPAIGN', 'CAMP1', '1', 'int')`,
        { type: QueryTypes.RAW, replacements: { configKey: CONFIG_KEY } },
      ),
    ).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ code: '23505' }),
    });
  });
});
