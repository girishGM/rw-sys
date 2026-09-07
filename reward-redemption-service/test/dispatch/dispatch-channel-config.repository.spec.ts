/**
 * T-RR-033 — `DispatchChannelConfigRepository`, exercised against the real Postgres 16 server
 * (root `CLAUDE.md`), connected as the real least-privilege `rr_app` role — same real-DB
 * convention `ServiceConfigRepository`'s own spec (T-RR-006) already established, exactly because
 * a fake can't catch a real SQL mistake (in particular, `IS NOT DISTINCT FROM`'s null-safe
 * behaviour, which a plain `=` comparison would silently get wrong for every `GLOBAL`/
 * tenant-agnostic row).
 *
 * Uses dedicated, random `scope_ref_code` values per test run so this suite's own rows never
 * collide with the one real `GLOBAL` row T-RR-003's own migration seeds
 * (`scope_level='GLOBAL', scope_ref_code=NULL, tenant_id=NULL`), which this suite only ever reads,
 * never mutates.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type { ConfigService } from '@nestjs/config';
import { createMigrationConnection } from '@/database/migration-connection';
import { DispatchChannelConfigRepository } from '@/modules/dispatch/dispatch-channel-config.repository';
import type { Config } from '@/config/config.schema';

const SUFFIX = randomUUID().slice(0, 8);
const REWARD_CODE = `TEST_RWD_${SUFFIX}`;
const TRACKER_CODE = `TEST_TRK_${SUFFIX}`;

/** Same substitution idiom as `service-config.repository.spec.ts`'s own `realDbConfigService()`. */
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
    scope_level: 'REWARD' | 'TRACKER' | 'CAMPAIGN' | 'GLOBAL';
    scope_ref_code: string | null;
    tenant_id: number | null;
    primary_channel?: string;
    fallback_channel?: string;
  },
): Promise<void> {
  await migrationDb.query(
    `INSERT INTO reward_redemption.dispatch_channel_config
       (scope_level, scope_ref_code, tenant_id, primary_channel, fallback_channel)
     VALUES (:scopeLevel, :scopeRefCode, :tenantId, :primaryChannel, :fallbackChannel)`,
    {
      type: QueryTypes.RAW,
      replacements: {
        scopeLevel: overrides.scope_level,
        scopeRefCode: overrides.scope_ref_code,
        tenantId: overrides.tenant_id,
        primaryChannel: overrides.primary_channel ?? 'KAFKA',
        fallbackChannel: overrides.fallback_channel ?? 'REST',
      },
    },
  );
}

describe('T-RR-033 — DispatchChannelConfigRepository', () => {
  let migrationDb: Sequelize;
  let repository: DispatchChannelConfigRepository;

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
    repository = new DispatchChannelConfigRepository(realDbConfigService());

    await insertRow(migrationDb, {
      scope_level: 'REWARD',
      scope_ref_code: REWARD_CODE,
      tenant_id: null,
      primary_channel: 'REST',
    });
    await insertRow(migrationDb, {
      scope_level: 'REWARD',
      scope_ref_code: REWARD_CODE,
      tenant_id: 4242,
      primary_channel: 'KAFKA',
    });
    await insertRow(migrationDb, {
      scope_level: 'TRACKER',
      scope_ref_code: TRACKER_CODE,
      tenant_id: null,
      primary_channel: 'KAFKA',
    });
  });

  afterAll(async () => {
    await migrationDb.query(
      `DELETE FROM reward_redemption.dispatch_channel_config
       WHERE scope_ref_code IN (:rewardCode, :trackerCode)`,
      {
        type: QueryTypes.RAW,
        replacements: { rewardCode: REWARD_CODE, trackerCode: TRACKER_CODE },
      },
    );
    await migrationDb.close();
    await repository.onModuleDestroy();
  });

  it('findOne returns null when no row matches the exact triple', async () => {
    await expect(
      repository.findOne('CAMPAIGN', `${REWARD_CODE}.unseeded`, null),
    ).resolves.toBeNull();
  });

  it('findOne matches a tenant-agnostic row via IS NOT DISTINCT FROM (tenant_id IS NULL)', async () => {
    const row = await repository.findOne('REWARD', REWARD_CODE, null);

    expect(row?.scope_level).toBe('REWARD');
    expect(row?.tenant_id).toBeNull();
    expect(row?.primary_channel).toBe('REST');
  });

  it('findOne matches the tenant-specific row for that exact tenant, independent of the tenant-agnostic row', async () => {
    const row = await repository.findOne('REWARD', REWARD_CODE, 4242);

    expect(row?.tenant_id).toBe(4242);
    expect(row?.primary_channel).toBe('KAFKA');
  });

  it('findOne matches the real seeded GLOBAL row (scope_ref_code IS NULL, tenant_id IS NULL)', async () => {
    const row = await repository.findOne('GLOBAL', null, null);

    expect(row).not.toBeNull();
    expect(row?.scope_level).toBe('GLOBAL');
    expect(row?.scope_ref_code).toBeNull();
    expect(row?.tenant_id).toBeNull();
  });

  it('findAll includes every row this suite seeded', async () => {
    const rows = await repository.findAll();
    const mine = rows.filter((row) => row.scope_ref_code === REWARD_CODE);

    expect(mine).toHaveLength(2);
    expect(mine.map((row) => row.tenant_id).sort()).toEqual([null, 4242].sort());
  });

  // `uq_dcc_scope UNIQUE (scope_level, scope_ref_code, tenant_id)` — a real DB-enforced
  // constraint, not just an assumption this repository's own SQL relies on. Deliberately a
  // duplicate of the *non-null*-`tenant_id` row seeded above (REWARD/REWARD_CODE/4242): standard
  // SQL treats every `NULL` as distinct from every other `NULL` for uniqueness purposes (this
  // table's own model header, `dispatch-channel-config.model.ts`'s sibling note, and
  // `service-config.repository.spec.ts`'s own equivalent test document the identical fact for
  // `scope_ref`) — a duplicate `tenant_id IS NULL` row would NOT be rejected by this constraint,
  // so it would prove nothing about `uq_dcc_scope` actually being enforced.
  it('a duplicate (scope_level, scope_ref_code, tenant_id) insert is rejected by the DB', async () => {
    await expect(
      migrationDb.query(
        `INSERT INTO reward_redemption.dispatch_channel_config
           (scope_level, scope_ref_code, tenant_id, primary_channel, fallback_channel)
         VALUES ('REWARD', :rewardCode, 4242, 'KAFKA', 'REST')`,
        { type: QueryTypes.RAW, replacements: { rewardCode: REWARD_CODE } },
      ),
    ).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ code: '23505' }),
    });
  });
});
