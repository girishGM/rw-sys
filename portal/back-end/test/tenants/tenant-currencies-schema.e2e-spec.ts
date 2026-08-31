/**
 * T-126 — `reward_config.tenant_currencies` schema shape, against the **real** Postgres instance,
 * through the migration connection — same convention `test/database/tenant-budget-ceilings.
 * e2e-spec.ts` (T-006) establishes for its own table, placed under `test/tenants/` rather than
 * `test/database/` because that is the directory this task's file scope grants it
 * (`back-end/test/tenants/**`), not `back-end/test/database/**`.
 *
 * Fixtures create their own throwaway `tenants` row per test case, the same reason
 * `tenant-budget-ceilings.e2e-spec.ts`'s own header gives: `uq_tc_tenant_currency` and
 * `uq_tc_one_default` are both scoped to `tenant_id`, so sharing one tenant across cases would
 * make one test's "second default rejected" bleed into another's "second currency accepted".
 */
import 'reflect-metadata';
import { createMigrationConnection } from '@/database/migration-connection';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

describe('T-126 — tenant_currencies', () => {
  let sequelize: Sequelize;
  let countryId: number;

  const tenantIds: number[] = [];
  const currencyIds: number[] = [];

  async function insertReturningId(sql: string): Promise<number> {
    const [row] = await sequelize.query<{ id: number }>(sql, { type: QueryTypes.SELECT });
    return row.id;
  }

  async function createTenant(suffix: string): Promise<number> {
    const id = await insertReturningId(
      `INSERT INTO reward_config.tenants (code, name, country_id, status)
       VALUES ('t126_${suffix}', 'T126 Currency Test ${suffix}', ${countryId}, 'active')
       RETURNING id`,
    );
    tenantIds.push(id);
    return id;
  }

  async function insertCurrency(
    tenantId: number,
    currencyCode: string,
    isDefault = false,
  ): Promise<number> {
    const id = await insertReturningId(
      `INSERT INTO reward_config.tenant_currencies (tenant_id, currency_code, is_default)
       VALUES (${tenantId}, '${currencyCode}', ${isDefault})
       RETURNING id`,
    );
    currencyIds.push(id);
    return id;
  }

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
    countryId = await insertReturningId(
      `SELECT id FROM reward_config.countries ORDER BY id LIMIT 1`,
    );
  });

  afterAll(async () => {
    if (currencyIds.length > 0) {
      await sequelize.query(
        `DELETE FROM reward_config.tenant_currencies WHERE id IN (${currencyIds.join(',')})`,
        { type: QueryTypes.RAW },
      );
    }
    if (tenantIds.length > 0) {
      await sequelize.query(
        `DELETE FROM reward_config.tenants WHERE id IN (${tenantIds.join(',')})`,
        {
          type: QueryTypes.RAW,
        },
      );
    }
    await sequelize.close();
  });

  describe('schema shape — every CHECK/index this migration owns', () => {
    it('all named constraints exist on tenant_currencies', async () => {
      const rows = await sequelize.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'reward_config.tenant_currencies'::regclass`,
        { type: QueryTypes.SELECT },
      );
      const names = rows.map((r) => r.conname);
      for (const expected of ['uq_tc_tenant_currency', 'ck_tc_status', 'ck_tc_currency_code']) {
        expect(names).toContain(expected);
      }
    });

    it('uq_tc_one_default and ix_tc_tenant indexes exist', async () => {
      const rows = await sequelize.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = 'reward_config' AND tablename = 'tenant_currencies'`,
        { type: QueryTypes.SELECT },
      );
      const names = rows.map((r) => r.indexname);
      expect(names).toContain('uq_tc_one_default');
      expect(names).toContain('ix_tc_tenant');
    });
  });

  describe('TC-1 — backfill', () => {
    it('every existing, live tenant has exactly one is_default: true row', async () => {
      const rows = await sequelize.query<{ count: string }>(
        `SELECT count(*)::int AS count
           FROM reward_config.tenants t
          WHERE t.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM reward_config.tenant_currencies tc
               WHERE tc.tenant_id = t.id AND tc.is_default
            )`,
        { type: QueryTypes.SELECT },
      );
      expect(Number(rows[0].count)).toBe(0);
    });

    it('a freshly created tenant carries no currency row of its own (this migration backfills once, at migrate time)', async () => {
      const tenantId = await createTenant('fresh');
      const rows = await sequelize.query(
        `SELECT id FROM reward_config.tenant_currencies WHERE tenant_id = ${tenantId}`,
        { type: QueryTypes.SELECT },
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('accept and reject paths (TC-2, TC-3)', () => {
    it('TC-2: a second currency for the same tenant is accepted', async () => {
      const tenantId = await createTenant('tc2');
      await expect(insertCurrency(tenantId, 'MYR', true)).resolves.toBeGreaterThan(0);
      await expect(insertCurrency(tenantId, 'SGD', false)).resolves.toBeGreaterThan(0);
    });

    it('TC-3: a second is_default row for the same tenant is rejected by uq_tc_one_default', async () => {
      const tenantId = await createTenant('tc3');
      await insertCurrency(tenantId, 'MYR', true);
      await expect(insertCurrency(tenantId, 'SGD', true)).rejects.toMatchObject({
        name: 'SequelizeUniqueConstraintError',
        parent: expect.objectContaining({ constraint: 'uq_tc_one_default' }),
      });
    });

    it('the same tenant/currency pair twice is rejected by uq_tc_tenant_currency', async () => {
      const tenantId = await createTenant('tc_dup');
      await insertCurrency(tenantId, 'MYR', false);
      await expect(insertCurrency(tenantId, 'MYR', false)).rejects.toMatchObject({
        name: 'SequelizeUniqueConstraintError',
        parent: expect.objectContaining({ constraint: 'uq_tc_tenant_currency' }),
      });
    });

    it('rejects a currency_code outside three upper-case letters (ck_tc_currency_code)', async () => {
      const tenantId = await createTenant('tc_fmt');
      await expect(insertCurrency(tenantId, 'myr', false)).rejects.toThrow(/ck_tc_currency_code/);
    });

    it('two different tenants may each mark their own default independently', async () => {
      const tenantA = await createTenant('tc_a');
      const tenantB = await createTenant('tc_b');
      await expect(insertCurrency(tenantA, 'MYR', true)).resolves.toBeGreaterThan(0);
      await expect(insertCurrency(tenantB, 'MYR', true)).resolves.toBeGreaterThan(0);
    });
  });
});
