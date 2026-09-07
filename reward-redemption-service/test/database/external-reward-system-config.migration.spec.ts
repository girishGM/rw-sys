/**
 * T-RR-003 regression suite for `external_reward_system_config` (`01-DATABASE.md` §3). See
 * `reward-redemption-entry.migration.spec.ts`'s header (T-RR-002) for this suite's own
 * conventions (real Postgres, migration-privileged connection, tenant/system codes randomized
 * per run so parallel runs never collide).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import type { ExternalRewardSystemConfigRow } from '@/database/models/external-reward-system-config.model';

const TENANT_ID = 900_000 + Math.floor(Math.random() * 99_999);

function systemCode(): string {
  return `TEST_SYS_${randomUUID().slice(0, 8)}`;
}

describe('T-RR-003 — external_reward_system_config migration', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    await sequelize.query(
      "DELETE FROM reward_redemption.external_reward_system_config WHERE system_code LIKE 'TEST_SYS_%'",
      { type: QueryTypes.RAW },
    );
    await sequelize.close();
  });

  it('the table and its generated tenant_key column exist with the expected shape', async () => {
    const columns = await sequelize.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'reward_redemption' AND table_name = 'external_reward_system_config'`,
      { type: QueryTypes.SELECT },
    );
    expect(columns.map((c) => c.column_name)).toEqual(
      expect.arrayContaining(['system_code', 'tenant_id', 'tenant_key', 'retryable_error_codes']),
    );

    const constraints = await sequelize.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
         WHERE conrelid = 'reward_redemption.external_reward_system_config'::regclass AND contype = 'u'`,
      { type: QueryTypes.SELECT },
    );
    expect(constraints.map((c) => c.conname)).toContain('uq_ersc_system_tenant');
  });

  // TC-2: a NULL-tenant row and a real-tenant row for the same system_code both succeed (distinct
  // tenant_key values); a second NULL-tenant row for the same system_code is rejected.
  it('TC-2: NULL-tenant and tenant=7 rows for the same system_code coexist; a second NULL-tenant row is rejected', async () => {
    const code = systemCode();
    const insert = (tenantId: number | null) =>
      sequelize.query(
        `INSERT INTO reward_redemption.external_reward_system_config
           (system_code, tenant_id, connector_type, endpoint_url, auth_secret_ref)
         VALUES (:system_code, :tenant_id, 'PROMO_CODE_SERVICE', 'https://example.test', 'SECRET_REF')`,
        { type: QueryTypes.RAW, replacements: { system_code: code, tenant_id: tenantId } },
      );

    await expect(insert(null)).resolves.toBeDefined();
    await expect(insert(7)).resolves.toBeDefined();
    await expect(insert(null)).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ code: '23505' }),
    });
  });

  // TC-3: retryable_error_codes defaults to '[]'::jsonb, never NULL, when not supplied explicitly.
  it('TC-3: retryable_error_codes defaults to [] (not NULL) when not supplied', async () => {
    const code = systemCode();
    await sequelize.query(
      `INSERT INTO reward_redemption.external_reward_system_config
         (system_code, tenant_id, connector_type, endpoint_url, auth_secret_ref)
       VALUES (:system_code, :tenant_id, 'CORE_BANKING', 'https://example.test', 'SECRET_REF')`,
      { type: QueryTypes.RAW, replacements: { system_code: code, tenant_id: TENANT_ID } },
    );

    const [row] = await sequelize.query<ExternalRewardSystemConfigRow>(
      'SELECT * FROM reward_redemption.external_reward_system_config WHERE system_code = :system_code',
      { type: QueryTypes.SELECT, replacements: { system_code: code } },
    );
    expect(row.retryable_error_codes).not.toBeNull();
    expect(row.retryable_error_codes).toEqual([]);
  });
});
