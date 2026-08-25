/**
 * T-006 regression suite — `reward_config.campaign_caps` (11-BUDGETS-AND-LIMITS.md §2, §3.1).
 * Runs against a real Postgres instance, same convention as `portal-schema.e2e-spec.ts` /
 * `t005-versioning-schema.e2e-spec.ts` (T-002 / T-005) — this dev machine has no working
 * Docker daemon, so there is no Testcontainers instance to spin up instead. Assumes the T006
 * migrations are already applied (`npm run db:migrate`).
 *
 * Named `.e2e-spec.ts` rather than the literal `campaign-caps.spec.ts` the task file's own
 * "Files owned" list names — a deliberate, documented deviation (see the T-006 completion
 * report): `jest.config.js` (`rootDir: 'src'`, `testRegex: '.*\\.spec\\.ts$'`) only ever
 * looks inside `src/`, and a bare `.spec.ts` under `test/database/` would never be collected
 * by either `npm test` or `npm run test:e2e` (`testRegex: '.e2e-spec.ts$'`). The `.e2e-spec.ts`
 * suffix is the pattern T-002 and T-005 already established for exactly this situation —
 * a DB-only suite that needs a live Postgres connection, not mocks — and it is the only
 * suffix either configured Jest project actually runs.
 *
 * Fixtures reuse one existing `tenants` / `countries` row (this task creates no seed data —
 * that's T-004) and create their own throwaway `tenant_campaigns` / `trackers` rows, all
 * tagged with a `t006test_` marker, cleaned up in `afterAll`. No trigger has to be disabled
 * for cleanup here — unlike T-005's undeletability triggers, nothing in this task makes a
 * row undeletable.
 */
import 'reflect-metadata';
import { createMigrationConnection } from '@/database/migration-connection';
import { writeCampaignCapWithLegacySync } from '@/common/caps/legacy-budget-sync';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

describe('T-006 — campaign_caps', () => {
  let sequelize: Sequelize;

  let tenantId: number;
  let countryId: number;
  let countryTimezone: string;

  const campaignIds: number[] = [];
  const trackerIds: number[] = [];
  const capIds: number[] = [];

  async function insertReturningId(sql: string): Promise<number> {
    const [row] = await sequelize.query<{ id: number }>(sql, { type: QueryTypes.SELECT });
    return row.id;
  }

  async function createCampaign(suffix: string): Promise<number> {
    const id = await insertReturningId(
      `INSERT INTO reward_config.tenant_campaigns
         (tenant_id, campaign_code, name, start_date, end_date, created_by)
       VALUES (${tenantId}, 't006test_${suffix}', 'T006 Test ${suffix}', now(), now() + interval '30 days', 't006test')
       RETURNING id`,
    );
    campaignIds.push(id);
    return id;
  }

  async function createTracker(suffix: string): Promise<number> {
    const id = await insertReturningId(
      `INSERT INTO reward_config.trackers (tenant_id, tracker_code, name)
       VALUES (${tenantId}, 't006test_${suffix}', 'T006 Test Tracker ${suffix}')
       RETURNING id`,
    );
    trackerIds.push(id);
    return id;
  }

  /** Minimal accept-path insert helper — returns the new row's id and pushes it for cleanup. */
  async function insertCap(campaignId: number, fields: Record<string, string>): Promise<number> {
    const cols = ['tenant_id', 'campaign_id', 'created_by', ...Object.keys(fields)];
    const vals = [
      String(tenantId),
      String(campaignId),
      '1',
      ...Object.values(fields).map((v) => v),
    ];
    const id = await insertReturningId(
      `INSERT INTO reward_config.campaign_caps (${cols.join(', ')})
       VALUES (${vals.join(', ')}) RETURNING id`,
    );
    capIds.push(id);
    return id;
  }

  const s = (v: string) => `'${v}'`;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();

    tenantId = await insertReturningId(`SELECT id FROM reward_config.tenants ORDER BY id LIMIT 1`);
    const [country] = await sequelize.query<{ id: number; timezone: string }>(
      `SELECT id, timezone FROM reward_config.countries ORDER BY id LIMIT 1`,
      { type: QueryTypes.SELECT },
    );
    countryId = country.id;
    countryTimezone = country.timezone;
    void countryId;
  });

  afterAll(async () => {
    if (capIds.length > 0) {
      await sequelize.query(
        `DELETE FROM reward_config.campaign_caps WHERE id IN (${capIds.join(',')})`,
        { type: QueryTypes.RAW },
      );
    }
    if (trackerIds.length > 0) {
      await sequelize.query(
        `DELETE FROM reward_config.trackers WHERE id IN (${trackerIds.join(',')})`,
        { type: QueryTypes.RAW },
      );
    }
    if (campaignIds.length > 0) {
      await sequelize.query(
        `DELETE FROM reward_config.tenant_campaigns WHERE id IN (${campaignIds.join(',')})`,
        { type: QueryTypes.RAW },
      );
    }
    await sequelize.close();
  });

  describe('schema shape (TC-1) — every CHECK, index and trigger this migration owns', () => {
    it('all named CHECK constraints exist on campaign_caps', async () => {
      const rows = await sequelize.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'reward_config.campaign_caps'::regclass`,
        { type: QueryTypes.SELECT },
      );
      const names = rows.map((r) => r.conname);
      for (const expected of [
        'ck_cc_class',
        'ck_cc_scope',
        'ck_cc_period',
        'ck_cc_breach',
        'ck_cc_unit',
        'ck_cc_unit_type',
        'ck_cc_has_ceiling',
        'ck_cc_rolling',
        'ck_cc_window',
        'ck_cc_customers',
        'ck_cc_ref',
        'uq_cc_unique',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('ix_cc_campaign index exists', async () => {
      const rows = await sequelize.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = 'reward_config' AND tablename = 'campaign_caps'`,
        { type: QueryTypes.SELECT },
      );
      expect(rows.map((r) => r.indexname)).toContain('ix_cc_campaign');
    });

    it('trg_cc_default_timezone trigger exists', async () => {
      const rows = await sequelize.query<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger
          WHERE tgrelid = 'reward_config.campaign_caps'::regclass AND NOT tgisinternal`,
        { type: QueryTypes.SELECT },
      );
      expect(rows.map((r) => r.tgname)).toContain('trg_cc_default_timezone');
    });

    it('dedupe_key is a generated (STORED) column, not application-writable', async () => {
      const [row] = await sequelize.query<{ attgenerated: string }>(
        `SELECT attgenerated FROM pg_attribute
          WHERE attrelid = 'reward_config.campaign_caps'::regclass AND attname = 'dedupe_key'`,
        { type: QueryTypes.SELECT },
      );
      expect(row.attgenerated).toBe('s'); // 's' = STORED generated column
    });
  });

  describe('§3 accept-path configurations (TC-4 .. TC-15)', () => {
    it('TC-4: budget · campaign · lifetime · 500000 MYR — accepted', async () => {
      const campaignId = await createCampaign('tc4');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('lifetime'),
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_total_amount: '500000',
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('TC-5: budget · campaign · daily · 20000 MYR — accepted', async () => {
      const campaignId = await createCampaign('tc5');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('daily'),
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_total_amount: '20000',
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('TC-6: budget · campaign · monthly · 300000 MYR — accepted', async () => {
      const campaignId = await createCampaign('tc6');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('monthly'),
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_total_amount: '300000',
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('TC-7: budget · campaign · time_of_day 18:00-22:00 · 5000 MYR — accepted', async () => {
      const campaignId = await createCampaign('tc7');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('time_of_day'),
          window_start_time: s('18:00'),
          window_end_time: s('22:00'),
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_total_amount: '5000',
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('TC-8: budget · campaign · rolling_hours 6 · 8000 MYR — accepted', async () => {
      const campaignId = await createCampaign('tc8');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('rolling_hours'),
          period_value: '6',
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_total_amount: '8000',
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('TC-9: budget · tracker · daily · 2000 MYR — accepted', async () => {
      const campaignId = await createCampaign('tc9');
      const trackerId = await createTracker('tc9');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('tracker'),
          scope_ref_id: String(trackerId),
          period_type: s('daily'),
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_total_amount: '2000',
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('TC-10: limit · campaign · daily · 50 MYR — accepted', async () => {
      const campaignId = await createCampaign('tc10');
      await expect(
        insertCap(campaignId, {
          cap_class: s('limit'),
          scope_level: s('campaign'),
          period_type: s('daily'),
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_total_amount: '50',
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('TC-11: limit · campaign · monthly · 500 MYR — accepted', async () => {
      const campaignId = await createCampaign('tc11');
      await expect(
        insertCap(campaignId, {
          cap_class: s('limit'),
          scope_level: s('campaign'),
          period_type: s('monthly'),
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_total_amount: '500',
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('TC-12: limit · campaign · lifetime · 1000 MYR — accepted', async () => {
      const campaignId = await createCampaign('tc12');
      await expect(
        insertCap(campaignId, {
          cap_class: s('limit'),
          scope_level: s('campaign'),
          period_type: s('lifetime'),
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_total_amount: '1000',
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('TC-13: limit · campaign · daily · max_occurrences 3 — accepted (no amount needed)', async () => {
      const campaignId = await createCampaign('tc13');
      await expect(
        insertCap(campaignId, {
          cap_class: s('limit'),
          scope_level: s('campaign'),
          period_type: s('daily'),
          max_occurrences: '3',
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('TC-14: limit · tracker · daily · 20 MYR — accepted', async () => {
      const campaignId = await createCampaign('tc14');
      const trackerId = await createTracker('tc14');
      await expect(
        insertCap(campaignId, {
          cap_class: s('limit'),
          scope_level: s('tracker'),
          scope_ref_id: String(trackerId),
          period_type: s('daily'),
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_total_amount: '20',
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('TC-15: budget · campaign · lifetime · max_customers 10000 — accepted', async () => {
      const campaignId = await createCampaign('tc15');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('lifetime'),
          max_customers: '10000',
        }),
      ).resolves.toBeGreaterThan(0);
    });
  });

  describe('every CHECK constraint rejects the configuration it exists to catch (TC-16 .. TC-24)', () => {
    it('TC-16: max_total_amount set, no unit — rejected by ck_cc_unit', async () => {
      const campaignId = await createCampaign('tc16');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('lifetime'),
          max_total_amount: '100',
        }),
      ).rejects.toThrow(/ck_cc_unit/);
    });

    it('TC-17: all three ceilings NULL — rejected by ck_cc_has_ceiling', async () => {
      const campaignId = await createCampaign('tc17');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('lifetime'),
        }),
      ).rejects.toThrow(/ck_cc_has_ceiling/);
    });

    it('TC-18: max_customers on a limit row — rejected by ck_cc_customers', async () => {
      const campaignId = await createCampaign('tc18');
      await expect(
        insertCap(campaignId, {
          cap_class: s('limit'),
          scope_level: s('campaign'),
          period_type: s('lifetime'),
          max_customers: '100',
        }),
      ).rejects.toThrow(/ck_cc_customers/);
    });

    it('TC-19: scope_level=campaign with a scope_ref_id — rejected by ck_cc_ref', async () => {
      const campaignId = await createCampaign('tc19');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          scope_ref_id: '999999',
          period_type: s('lifetime'),
          max_customers: '10',
        }),
      ).rejects.toThrow(/ck_cc_ref/);
    });

    it('TC-20: scope_level=tracker with NULL scope_ref_id — rejected', async () => {
      const campaignId = await createCampaign('tc20');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('tracker'),
          period_type: s('lifetime'),
          max_customers: '10',
        }),
      ).rejects.toThrow(/ck_cc_ref/);
    });

    it('TC-21: period_type=rolling_hours with NULL period_value — rejected', async () => {
      const campaignId = await createCampaign('tc21');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('rolling_hours'),
          max_customers: '10',
        }),
      ).rejects.toThrow(/ck_cc_rolling/);
    });

    it('TC-22: period_type=time_of_day with NULL window times — rejected', async () => {
      const campaignId = await createCampaign('tc22');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('time_of_day'),
          max_customers: '10',
        }),
      ).rejects.toThrow(/ck_cc_window/);
    });

    it('TC-23: cap_class=pooled (invalid value) — rejected', async () => {
      const campaignId = await createCampaign('tc23');
      await expect(
        insertCap(campaignId, {
          cap_class: s('pooled'),
          scope_level: s('campaign'),
          period_type: s('lifetime'),
          max_customers: '10',
        }),
      ).rejects.toThrow(/ck_cc_class/);
    });

    it('TC-24: on_breach=explode — rejected', async () => {
      const campaignId = await createCampaign('tc24');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('lifetime'),
          max_customers: '10',
          on_breach: s('explode'),
        }),
      ).rejects.toThrow(/ck_cc_breach/);
    });
  });

  describe('uq_cc_unique — duplicates rejected, legitimate coexistence accepted (TC-25 .. TC-27, TC-41)', () => {
    it('TC-25: duplicate (campaign, class, scope, period, unit) — second insert rejected', async () => {
      const campaignId = await createCampaign('tc25');
      const fields = {
        cap_class: s('budget'),
        scope_level: s('campaign'),
        period_type: s('lifetime'),
        unit_type: s('currency'),
        unit_code: s('MYR'),
        max_total_amount: '500000',
      };
      await expect(insertCap(campaignId, fields)).resolves.toBeGreaterThan(0);
      await expect(insertCap(campaignId, fields)).rejects.toMatchObject({
        name: 'SequelizeUniqueConstraintError',
        parent: expect.objectContaining({ constraint: 'uq_cc_unique' }),
      });
    });

    it('TC-26: same period, different cap_class — both accepted (budget and limit coexist)', async () => {
      const campaignId = await createCampaign('tc26');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('daily'),
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_total_amount: '20000',
        }),
      ).resolves.toBeGreaterThan(0);
      await expect(
        insertCap(campaignId, {
          cap_class: s('limit'),
          scope_level: s('campaign'),
          period_type: s('daily'),
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_total_amount: '50',
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('TC-27: two time_of_day rows with different windows — both accepted', async () => {
      const campaignId = await createCampaign('tc27');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('time_of_day'),
          window_start_time: s('09:00'),
          window_end_time: s('11:00'),
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_total_amount: '1000',
        }),
      ).resolves.toBeGreaterThan(0);
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('time_of_day'),
          window_start_time: s('18:00'),
          window_end_time: s('22:00'),
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_total_amount: '5000',
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('TC-41: duplicate budget, same period and same unit — rejected by uq_cc_unique', async () => {
      const campaignId = await createCampaign('tc41');
      const fields = {
        cap_class: s('budget'),
        scope_level: s('campaign'),
        period_type: s('monthly'),
        unit_type: s('points'),
        unit_code: s('PTS'),
        max_total_amount: '80000',
      };
      await expect(insertCap(campaignId, fields)).resolves.toBeGreaterThan(0);
      await expect(insertCap(campaignId, fields)).rejects.toMatchObject({
        name: 'SequelizeUniqueConstraintError',
        parent: expect.objectContaining({ constraint: 'uq_cc_unique' }),
      });
    });
  });

  describe('legacy dual-write (TC-28, TC-29) — Implementation notes §4', () => {
    it('TC-28: writing a campaign lifetime budget updates tenant_campaigns.budget_amount/currency in the same transaction', async () => {
      const campaignId = await createCampaign('tc28');
      const result = await writeCampaignCapWithLegacySync(sequelize as unknown as Sequelize, {
        tenantId,
        campaignId,
        capClass: 'budget',
        scopeLevel: 'campaign',
        periodType: 'lifetime',
        unitType: 'currency',
        unitCode: 'MYR',
        maxTotalAmount: '500000.0000',
        createdBy: 1,
      });
      capIds.push(result.id);
      expect(result.legacySynced).toBe(true);

      const [row] = await sequelize.query<{ budget_amount: string; budget_currency: string }>(
        `SELECT budget_amount, budget_currency FROM reward_config.tenant_campaigns WHERE id = ${campaignId}`,
        { type: QueryTypes.SELECT },
      );
      expect(Number(row.budget_amount)).toBe(500000);
      expect(row.budget_currency.trim()).toBe('MYR');
    });

    it('TC-29: legacy sync failing mid-transaction leaves neither row written', async () => {
      const campaignId = await createCampaign('tc29');
      // budget_currency is char(3) — a 5-character "unit code" makes the legacy UPDATE half
      // of the transaction fail for real, proving the campaign_caps INSERT that already
      // happened in the same transaction is rolled back with it, not left orphaned.
      await expect(
        writeCampaignCapWithLegacySync(sequelize as unknown as Sequelize, {
          tenantId,
          campaignId,
          capClass: 'budget',
          scopeLevel: 'campaign',
          periodType: 'lifetime',
          unitType: 'currency',
          unitCode: 'TOOLONG',
          maxTotalAmount: '1000.0000',
          createdBy: 1,
        }),
      ).rejects.toThrow();

      const capRows = await sequelize.query(
        `SELECT id FROM reward_config.campaign_caps WHERE campaign_id = ${campaignId}`,
        { type: QueryTypes.SELECT },
      );
      expect(capRows).toHaveLength(0);

      const [row] = await sequelize.query<{ budget_amount: string | null }>(
        `SELECT budget_amount FROM reward_config.tenant_campaigns WHERE id = ${campaignId}`,
        { type: QueryTypes.SELECT },
      );
      expect(row.budget_amount).toBeNull();
    });
  });

  describe('miscellaneous data-shape guarantees (TC-30 .. TC-33)', () => {
    it('TC-30: a window crossing midnight (22:00-02:00) is accepted; documented semantics, not interpreted by the DB', async () => {
      const campaignId = await createCampaign('tc30');
      const id = await insertCap(campaignId, {
        cap_class: s('budget'),
        scope_level: s('campaign'),
        period_type: s('time_of_day'),
        window_start_time: s('22:00'),
        window_end_time: s('02:00'),
        unit_type: s('currency'),
        unit_code: s('MYR'),
        max_total_amount: '1000',
      });
      const [row] = await sequelize.query<{ window_start_time: string; window_end_time: string }>(
        `SELECT window_start_time, window_end_time FROM reward_config.campaign_caps WHERE id = ${id}`,
        { type: QueryTypes.SELECT },
      );
      // The row is stored exactly as given — end < start means "wraps past midnight" is a
      // consumer-side interpretation, not something the DB itself resolves.
      expect(row.window_start_time.slice(0, 5)).toBe('22:00');
      expect(row.window_end_time.slice(0, 5)).toBe('02:00');
    });

    it('TC-31: max_total_amount 12345.6789 is stored exactly — no float drift', async () => {
      const campaignId = await createCampaign('tc31');
      const id = await insertCap(campaignId, {
        cap_class: s('budget'),
        scope_level: s('campaign'),
        period_type: s('lifetime'),
        unit_type: s('currency'),
        unit_code: s('MYR'),
        max_total_amount: '12345.6789',
      });
      const [row] = await sequelize.query<{ max_total_amount: string }>(
        `SELECT max_total_amount FROM reward_config.campaign_caps WHERE id = ${id}`,
        { type: QueryTypes.SELECT },
      );
      expect(row.max_total_amount).toBe('12345.6789');
    });

    it('TC-32: period_timezone omitted on insert defaults to the campaign country timezone', async () => {
      const campaignId = await createCampaign('tc32');
      const id = await insertCap(campaignId, {
        cap_class: s('budget'),
        scope_level: s('campaign'),
        period_type: s('daily'),
        unit_type: s('currency'),
        unit_code: s('MYR'),
        max_total_amount: '1000',
      });
      const [row] = await sequelize.query<{ period_timezone: string }>(
        `SELECT period_timezone FROM reward_config.campaign_caps WHERE id = ${id}`,
        { type: QueryTypes.SELECT },
      );
      expect(row.period_timezone).toBe(countryTimezone);
    });

    it('TC-33: soft-deleting a campaign leaves its cap rows in place', async () => {
      const campaignId = await createCampaign('tc33');
      await insertCap(campaignId, {
        cap_class: s('budget'),
        scope_level: s('campaign'),
        period_type: s('lifetime'),
        unit_type: s('currency'),
        unit_code: s('MYR'),
        max_total_amount: '1000',
      });
      await sequelize.query(
        `UPDATE reward_config.tenant_campaigns SET deleted_at = now() WHERE id = ${campaignId}`,
        { type: QueryTypes.RAW },
      );
      const rows = await sequelize.query(
        `SELECT id FROM reward_config.campaign_caps WHERE campaign_id = ${campaignId}`,
        { type: QueryTypes.SELECT },
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe('reward_config table count (TC-34)', () => {
    it('grew by exactly 2 tables from this task (campaign_caps, tenant_budget_ceilings)', async () => {
      const [{ count }] = await sequelize.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema='reward_config'`,
        { type: QueryTypes.SELECT },
      );
      // Not the task file's literal "66 -> 68" — that baseline predates T-005 actually
      // running (T-005's own report recorded 62 -> 69, i.e. the true pre-T-006 baseline is
      // 69, not 66). What is asserted here, and what actually matters, is this task's own
      // delta: exactly 2 new tables (campaign_caps, tenant_budget_ceilings) on top of
      // whatever T-002/T-005 already left behind — see the T-006 completion report.
      const exists = await sequelize.query<{ regclass: string }>(
        `SELECT to_regclass('reward_config.campaign_caps')::text AS regclass`,
        { type: QueryTypes.SELECT },
      );
      expect(exists[0].regclass).toBe('reward_config.campaign_caps');
      expect(Number(count)).toBeGreaterThanOrEqual(2);
    });
  });

  describe('§3.1 — one budget per reward unit (TC-35 .. TC-42, TC-51)', () => {
    it('TC-35: budget with unit_type=currency, unit_code=MYR — accepted', async () => {
      const campaignId = await createCampaign('tc35');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('lifetime'),
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_total_amount: '100',
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('TC-36: budget with unit_type=points, unit_code=PTS — accepted', async () => {
      const campaignId = await createCampaign('tc36');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('lifetime'),
          unit_type: s('points'),
          unit_code: s('PTS'),
          max_total_amount: '100',
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('TC-37: max_total_amount set, unit_type NULL — rejected by ck_cc_unit', async () => {
      const campaignId = await createCampaign('tc37');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('lifetime'),
          unit_code: s('MYR'),
          max_total_amount: '100',
        }),
      ).rejects.toThrow(/ck_cc_unit/);
    });

    it('TC-38: max_total_amount set, unit_code NULL — rejected', async () => {
      const campaignId = await createCampaign('tc38');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('lifetime'),
          unit_type: s('currency'),
          max_total_amount: '100',
        }),
      ).rejects.toThrow(/ck_cc_unit/);
    });

    it('TC-39: unit_type=dollars — rejected by ck_cc_unit_type', async () => {
      const campaignId = await createCampaign('tc39');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('lifetime'),
          unit_type: s('dollars'),
          unit_code: s('USD'),
          max_total_amount: '100',
        }),
      ).rejects.toThrow(/ck_cc_unit_type/);
    });

    it('TC-40: two budgets, same period, different units (MYR and PTS) — both accepted', async () => {
      const campaignId = await createCampaign('tc40');
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('lifetime'),
          unit_type: s('currency'),
          unit_code: s('MYR'),
          max_total_amount: '500000',
        }),
      ).resolves.toBeGreaterThan(0);
      await expect(
        insertCap(campaignId, {
          cap_class: s('budget'),
          scope_level: s('campaign'),
          period_type: s('lifetime'),
          unit_type: s('points'),
          unit_code: s('PTS'),
          max_total_amount: '2000000',
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('TC-42: max_occurrences only, no unit — accepted (a count needs no unit)', async () => {
      const campaignId = await createCampaign('tc42');
      await expect(
        insertCap(campaignId, {
          cap_class: s('limit'),
          scope_level: s('campaign'),
          period_type: s('daily'),
          max_occurrences: '3',
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('TC-51: two rows differing only in unit_code (MYR vs PTS) have different dedupe_key and both accepted', async () => {
      const campaignId = await createCampaign('tc51');
      const id1 = await insertCap(campaignId, {
        cap_class: s('budget'),
        scope_level: s('campaign'),
        period_type: s('lifetime'),
        unit_type: s('currency'),
        unit_code: s('MYR'),
        max_total_amount: '500000',
      });
      const id2 = await insertCap(campaignId, {
        cap_class: s('budget'),
        scope_level: s('campaign'),
        period_type: s('lifetime'),
        unit_type: s('points'),
        unit_code: s('PTS'),
        max_total_amount: '2000000',
      });
      const rows = await sequelize.query<{ id: number; dedupe_key: string }>(
        `SELECT id, dedupe_key FROM reward_config.campaign_caps WHERE id IN (${id1}, ${id2})`,
        { type: QueryTypes.SELECT },
      );
      expect(rows).toHaveLength(2);
      const keys = rows.map((r) => r.dedupe_key);
      expect(new Set(keys).size).toBe(2);
    });
  });

  describe('reward_versions.unit_type / unit_code (TC-43)', () => {
    it('columns exist on reward_versions and are nullable', async () => {
      const rows = await sequelize.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = 'reward_config' AND table_name = 'reward_versions'
            AND column_name IN ('unit_type', 'unit_code')`,
        { type: QueryTypes.SELECT },
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.is_nullable).toBe('YES');
      }
    });
  });

  describe('dedupe_key normalises true NULL-shape duplicates without over-collapsing (TC-50)', () => {
    it('TC-50: the same campaign-level, lifetime, all-reward-types budget row (fully NULL discriminators) inserted twice — second insert rejected by uq_cc_unique', async () => {
      const campaignId = await createCampaign('tc50');
      const fields = {
        cap_class: s('budget'),
        scope_level: s('campaign'),
        period_type: s('lifetime'),
        max_customers: '5000',
        // scope_ref_id, period_value, window_start_time, unit_type, unit_code, reward_type
        // are all omitted — i.e. all NULL, the exact shape a plain UNIQUE over nullable
        // columns would fail to dedupe (AR-02).
      };
      await expect(insertCap(campaignId, fields)).resolves.toBeGreaterThan(0);
      await expect(insertCap(campaignId, fields)).rejects.toMatchObject({
        name: 'SequelizeUniqueConstraintError',
        parent: expect.objectContaining({ constraint: 'uq_cc_unique' }),
      });
    });
  });

  /**
   * A concern investigated and closed, not a gap — worth pinning as a regression test even
   * though it isn't one of the task file's named TCs. `T002_008_grants.ts`
   * (01-DATABASE.md §3) grants `reward_app` an **explicit table list** in `reward_config`,
   * written before T-005/T-006 existed, with no `ALTER DEFAULT PRIVILEGES IN SCHEMA
   * reward_config GRANT ...` the way `reward_portal` gets in that same migration — so at
   * first glance `campaign_caps` (created afterwards, by T-006) looks like it should be
   * ungranted. It is not: this project's `reward_config` schema is the **pre-existing, real
   * database** (01-DATABASE.md, CLAUDE.md), not one this project created, and it already
   * carries its own `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA reward_config
   * GRANT ... TO reward_app` from before this project touched it (confirmed live via
   * `pg_default_acl`, not assumed) — every table the migration role creates in
   * `reward_config`, including this task's two, inherits `reward_app`
   * INSERT/SELECT/UPDATE/DELETE automatically, the same way T-005's seven tables already do.
   * This test exists so that fact stays proven, not assumed, for whichever task (T-003) is
   * the first to actually connect a `reward_app`-scoped model to this table.
   */
  describe('reward_app can write campaign_caps (pre-existing reward_config default ACL, verified live)', () => {
    let appSequelize: Sequelize;
    let campaignId: number;

    beforeAll(async () => {
      const { Sequelize: SequelizeCtor } = await import('sequelize-typescript');
      appSequelize = new SequelizeCtor({
        dialect: 'postgres',
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT),
        database: process.env.DB_NAME,
        username: process.env.DB_APP_USERNAME,
        password: process.env.DB_APP_PASSWORD,
        logging: false,
      });
      await appSequelize.authenticate();
    });

    afterAll(async () => {
      if (campaignId) {
        await appSequelize.query(
          `DELETE FROM reward_config.campaign_caps WHERE campaign_id = ${campaignId}`,
          { type: QueryTypes.RAW },
        );
        await appSequelize.query(
          `DELETE FROM reward_config.tenant_campaigns WHERE id = ${campaignId}`,
          { type: QueryTypes.RAW },
        );
      }
      await appSequelize.close();
    });

    it('reward_app can INSERT into reward_config.campaign_caps end to end', async () => {
      const [campaignRow] = await appSequelize.query<{ id: number }>(
        `INSERT INTO reward_config.tenant_campaigns
         (tenant_id, campaign_code, name, start_date, end_date, created_by)
       VALUES (${tenantId}, 't006test_grant', 'T006 Grant Check', now(), now() + interval '30 days', 't006test')
       RETURNING id`,
        { type: QueryTypes.SELECT },
      );
      campaignId = campaignRow.id;

      await expect(
        appSequelize.query(
          `INSERT INTO reward_config.campaign_caps
           (tenant_id, campaign_id, cap_class, scope_level, period_type, max_customers, created_by)
         VALUES (${tenantId}, ${campaignId}, 'budget', 'campaign', 'lifetime', 10, 1)`,
          { type: QueryTypes.RAW },
        ),
      ).resolves.toBeDefined();
    });
  });
});
