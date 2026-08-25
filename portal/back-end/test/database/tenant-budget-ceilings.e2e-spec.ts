/**
 * T-006 regression suite — `reward_config.tenant_budget_ceilings` (11-BUDGETS-AND-LIMITS.md
 * §8, the "typo guard", G18 in progress.json). Same live-Postgres convention as
 * `campaign-caps.e2e-spec.ts` — see that file's own doc comment for why this is
 * `.e2e-spec.ts` rather than the task file's literal `tenant-budget-ceilings.spec.ts`
 * filename (documented deviation, T-006 completion report).
 *
 * Fixtures create their own throwaway `tenants` rows (rather than reusing one shared row,
 * unlike the other T-005/T-006 suites) specifically *because* `uq_tbc` is scoped to
 * `(tenant_id, unit_type, unit_code)` — sharing a tenant across test cases would make TC-47's
 * "second ceiling for the same tenant/unit is rejected" bleed into every other accept-path
 * test that also wants a MYR ceiling on some tenant. A fresh tenant per test case keeps every
 * case independent.
 */
import 'reflect-metadata';
import { createMigrationConnection } from '@/database/migration-connection';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

describe('T-006 — tenant_budget_ceilings', () => {
  let sequelize: Sequelize;
  let countryId: number;

  const tenantIds: number[] = [];
  const ceilingIds: number[] = [];

  async function insertReturningId(sql: string): Promise<number> {
    const [row] = await sequelize.query<{ id: number }>(sql, { type: QueryTypes.SELECT });
    return row.id;
  }

  async function createTenant(suffix: string): Promise<number> {
    const id = await insertReturningId(
      `INSERT INTO reward_config.tenants (code, name, country_id, status)
       VALUES ('t006tbc_${suffix}', 'T006 TBC Test ${suffix}', ${countryId}, 'active')
       RETURNING id`,
    );
    tenantIds.push(id);
    return id;
  }

  async function insertCeiling(tenantId: number, fields: Record<string, string>): Promise<number> {
    const cols = ['tenant_id', 'created_by', ...Object.keys(fields)];
    const vals = [String(tenantId), '1', ...Object.values(fields)];
    const id = await insertReturningId(
      `INSERT INTO reward_config.tenant_budget_ceilings (${cols.join(', ')})
       VALUES (${vals.join(', ')}) RETURNING id`,
    );
    ceilingIds.push(id);
    return id;
  }

  const s = (v: string) => `'${v}'`;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
    countryId = await insertReturningId(
      `SELECT id FROM reward_config.countries ORDER BY id LIMIT 1`,
    );
  });

  afterAll(async () => {
    if (ceilingIds.length > 0) {
      await sequelize.query(
        `DELETE FROM reward_config.tenant_budget_ceilings WHERE id IN (${ceilingIds.join(',')})`,
        { type: QueryTypes.RAW },
      );
    }
    if (tenantIds.length > 0) {
      await sequelize.query(
        `DELETE FROM reward_config.tenants WHERE id IN (${tenantIds.join(',')})`,
        { type: QueryTypes.RAW },
      );
    }
    await sequelize.close();
  });

  describe('schema shape (TC-1) — every CHECK and index this migration owns', () => {
    it('all named CHECK constraints exist on tenant_budget_ceilings', async () => {
      const rows = await sequelize.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'reward_config.tenant_budget_ceilings'::regclass`,
        { type: QueryTypes.SELECT },
      );
      const names = rows.map((r) => r.conname);
      for (const expected of ['uq_tbc', 'ck_tbc_unit', 'ck_tbc_positive', 'ck_tbc_warn']) {
        expect(names).toContain(expected);
      }
    });

    it('ix_tbc_tenant index exists', async () => {
      const rows = await sequelize.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = 'reward_config' AND tablename = 'tenant_budget_ceilings'`,
        { type: QueryTypes.SELECT },
      );
      expect(rows.map((r) => r.indexname)).toContain('ix_tbc_tenant');
    });
  });

  describe('§8.2 accept and reject paths (TC-44 .. TC-48)', () => {
    it('TC-44: insert a tenant ceiling — MYR 5,000,000, warn above 4,000,000 — accepted', async () => {
      const tenantId = await createTenant('tc44');
      await expect(
        insertCeiling(tenantId, {
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_campaign_budget: '5000000',
          warn_above_amount: '4000000',
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('TC-45: warn_above_amount above max_campaign_budget — rejected by ck_tbc_warn', async () => {
      const tenantId = await createTenant('tc45');
      await expect(
        insertCeiling(tenantId, {
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_campaign_budget: '1000000',
          warn_above_amount: '2000000',
        }),
      ).rejects.toThrow(/ck_tbc_warn/);
    });

    it('TC-46: max_campaign_budget = 0 — rejected by ck_tbc_positive', async () => {
      const tenantId = await createTenant('tc46');
      await expect(
        insertCeiling(tenantId, {
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_campaign_budget: '0',
        }),
      ).rejects.toThrow(/ck_tbc_positive/);
    });

    it('TC-47: two ceilings, same tenant, same unit — second rejected by uq_tbc', async () => {
      const tenantId = await createTenant('tc47');
      const fields = {
        unit_type: s('currency'),
        unit_code: s('MYR'),
        max_campaign_budget: '5000000',
      };
      await expect(insertCeiling(tenantId, fields)).resolves.toBeGreaterThan(0);
      await expect(insertCeiling(tenantId, fields)).rejects.toMatchObject({
        name: 'SequelizeUniqueConstraintError',
        parent: expect.objectContaining({ constraint: 'uq_tbc' }),
      });
    });

    it('TC-48: two ceilings, same tenant, different units — both accepted', async () => {
      const tenantId = await createTenant('tc48');
      await expect(
        insertCeiling(tenantId, {
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_campaign_budget: '5000000',
        }),
      ).resolves.toBeGreaterThan(0);
      await expect(
        insertCeiling(tenantId, {
          unit_type: s('points'),
          unit_code: s('PTS'),
          max_campaign_budget: '20000000',
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('rejects an invalid unit_type outside currency|points|voucher (ck_tbc_unit)', async () => {
      const tenantId = await createTenant('tc_unit');
      await expect(
        insertCeiling(tenantId, {
          unit_type: s('dollars'),
          unit_code: s('USD'),
          max_campaign_budget: '5000000',
        }),
      ).rejects.toThrow(/ck_tbc_unit/);
    });
  });

  describe('no ceiling row means unlimited (TC-49)', () => {
    it('a tenant with no ceiling row is valid — query simply returns zero rows', async () => {
      const tenantId = await createTenant('tc49');
      const rows = await sequelize.query(
        `SELECT id FROM reward_config.tenant_budget_ceilings WHERE tenant_id = ${tenantId}`,
        { type: QueryTypes.SELECT },
      );
      expect(rows).toHaveLength(0);
    });
  });
});
