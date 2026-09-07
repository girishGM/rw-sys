/**
 * T-RR-005 — `FieldEncryptionConfigRepository`, exercised against the real Postgres 16 server
 * (root `CLAUDE.md`), connected as the real least-privilege `rr_app` role, never a mock/in-memory
 * DB — same real-DB convention `RewardRedemptionEntryClaimRepository`'s own spec (T-RR-020)
 * already established for this service's repositories.
 *
 * Uses a dedicated, random `field_name` per test run so this suite's own rows never collide with
 * anything a later task seeds for the real `'customerId'` field name.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type { ConfigService } from '@nestjs/config';
import { createMigrationConnection } from '@/database/migration-connection';
import { FieldEncryptionConfigRepository } from '@/modules/encryption/field-encryption-config.repository';
import type { Config } from '@/config/config.schema';

const TEST_FIELD_NAME = `test_field_${randomUUID().slice(0, 8)}`;

/** Same substitution idiom as `reward-redemption-entry-claim.repository.spec.ts`'s own
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

describe('T-RR-005 — FieldEncryptionConfigRepository', () => {
  let migrationDb: Sequelize;
  let repository: FieldEncryptionConfigRepository;

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
    repository = new FieldEncryptionConfigRepository(realDbConfigService());
  });

  afterAll(async () => {
    await migrationDb.query(
      'DELETE FROM reward_redemption.field_encryption_config WHERE field_name = :fieldName',
      { type: QueryTypes.RAW, replacements: { fieldName: TEST_FIELD_NAME } },
    );
    await migrationDb.close();
    await repository.onModuleDestroy();
  });

  it('isEnabled fails safe to true when no row exists for the given field_name', async () => {
    await expect(repository.isEnabled(TEST_FIELD_NAME)).resolves.toBe(true);
  });

  it('isEnabled reflects a real enabled=true row', async () => {
    await migrationDb.query(
      `INSERT INTO reward_redemption.field_encryption_config (field_name, enabled)
       VALUES (:fieldName, true)`,
      { type: QueryTypes.RAW, replacements: { fieldName: TEST_FIELD_NAME } },
    );

    await expect(repository.isEnabled(TEST_FIELD_NAME)).resolves.toBe(true);
  });

  // TC-9.
  it('isEnabled reflects enabled=false once the row is updated — the disabled state is not silently ignored', async () => {
    await migrationDb.query(
      `UPDATE reward_redemption.field_encryption_config SET enabled = false, updated_at = now()
       WHERE field_name = :fieldName`,
      { type: QueryTypes.RAW, replacements: { fieldName: TEST_FIELD_NAME } },
    );

    await expect(repository.isEnabled(TEST_FIELD_NAME)).resolves.toBe(false);
  });

  it('findAll includes the seeded row with the expected shape', async () => {
    const rows = await repository.findAll();
    const row = rows.find((r) => r.field_name === TEST_FIELD_NAME);

    expect(row).toBeDefined();
    expect(row?.enabled).toBe(false);
    expect(row?.id).toEqual(expect.anything());
    expect(row?.created_at).toBeInstanceOf(Date);
  });

  it('field_name is unique — a duplicate insert is rejected by the DB', async () => {
    await expect(
      migrationDb.query(
        `INSERT INTO reward_redemption.field_encryption_config (field_name, enabled)
         VALUES (:fieldName, true)`,
        { type: QueryTypes.RAW, replacements: { fieldName: TEST_FIELD_NAME } },
      ),
    ).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ code: '23505' }),
    });
  });
});
