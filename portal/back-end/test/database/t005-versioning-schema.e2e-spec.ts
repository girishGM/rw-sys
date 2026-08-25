/**
 * T-005 regression suite. Runs against a real Postgres instance (same convention as
 * `portal-schema.e2e-spec.ts` / T-002 — see that file's own doc comment). Assumes the
 * T005 migrations are already applied (`npm run db:migrate`), exactly like T-002's suite
 * assumes the T002 ones are.
 *
 * Fixtures deliberately reuse existing `reward_config` rows where they already exist
 * (tenant, country, rule sub-category, a reward system) rather than inventing new tenancy
 * — this task creates no seed data (that's T-004) — and creates its own throwaway rows,
 * all tagged with a `t005test_`/`Z*` marker, for everything else. Cleanup in `afterAll`
 * has to temporarily `DISABLE TRIGGER` the two undeletability triggers this task installs
 * — by design (06-VERSIONING.md §4.3), a published/deprecated/retired version row can
 * never be deleted through ordinary means once its lifecycle leaves `draft`, which is
 * exactly what most of these tests need to happen in order to prove TC-6/7/8/14/16. This
 * is a superuser-only teardown escape hatch for keeping the shared dev database tidy
 * between task runs, not a weakening of the guard: every trigger-rejection assertion below
 * runs, and is asserted, before cleanup ever touches the trigger.
 */
import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { createMigrationConnection } from '@/database/migration-connection';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

describe('T-005 — versioning, blast and definition-request schema', () => {
  let sequelize: Sequelize;

  // Reused, pre-existing fixture data.
  let tenantId: number;
  let countryId: number;
  let subCategoryId: number;
  let rewardSystemId: number;

  // Rows this suite creates and must clean up.
  const ruleMasterIds: number[] = [];
  const ruleVersionIds: number[] = [];
  const rewardVersionIds: number[] = [];
  const extraCountryIds: number[] = [];
  const blastIds: number[] = [];
  let tcrId: number | undefined;
  let rcaId: number | undefined;
  let trackerComponentId: number | undefined;
  let rewardPolicyId: number | undefined;
  let tenantCampaignId: number | undefined;

  async function insertReturningId(sql: string): Promise<number> {
    const [row] = await sequelize.query<{ id: number }>(sql, { type: QueryTypes.SELECT });
    return row.id;
  }

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();

    tenantId = await insertReturningId(`SELECT id FROM reward_config.tenants ORDER BY id LIMIT 1`);
    countryId = await insertReturningId(
      `SELECT id FROM reward_config.countries ORDER BY id LIMIT 1`,
    );
    subCategoryId = await insertReturningId(
      `SELECT id FROM reward_config.rule_sub_categories ORDER BY id LIMIT 1`,
    );
    rewardSystemId = await insertReturningId(
      `SELECT id FROM reward_config.reward_systems ORDER BY id LIMIT 1`,
    );
  });

  afterAll(async () => {
    // Superuser-only teardown — see the file's own doc comment for why this is safe.
    await sequelize.query(
      `ALTER TABLE reward_config.rule_versions DISABLE TRIGGER trg_rule_versions_undeletable`,
      { type: QueryTypes.RAW },
    );
    await sequelize.query(
      `ALTER TABLE reward_config.reward_versions DISABLE TRIGGER trg_reward_versions_undeletable`,
      { type: QueryTypes.RAW },
    );

    try {
      for (const blastId of blastIds) {
        await sequelize.query(
          `DELETE FROM reward_config.version_blast_targets WHERE blast_id = ${blastId}`,
          { type: QueryTypes.RAW },
        );
        await sequelize.query(`DELETE FROM reward_config.version_blasts WHERE id = ${blastId}`, {
          type: QueryTypes.RAW,
        });
      }
      if (ruleMasterIds.length > 0) {
        await sequelize.query(
          `DELETE FROM reward_config.rule_version_country_assignments WHERE rule_id IN (${ruleMasterIds.join(',')})`,
          { type: QueryTypes.RAW },
        );
      }
      if (rewardVersionIds.length > 0) {
        await sequelize.query(
          `DELETE FROM reward_config.reward_version_country_assignments WHERE reward_version_id IN (${rewardVersionIds.join(',')})`,
          { type: QueryTypes.RAW },
        );
      }
      if (tcrId) {
        await sequelize.query(
          `DELETE FROM reward_config.tracker_component_rules WHERE id = ${tcrId}`,
          { type: QueryTypes.RAW },
        );
      }
      if (rcaId) {
        await sequelize.query(
          `DELETE FROM reward_config.reward_campaign_assignments WHERE id = ${rcaId}`,
          { type: QueryTypes.RAW },
        );
      }
      if (ruleVersionIds.length > 0) {
        await sequelize.query(
          `DELETE FROM reward_config.rule_versions WHERE id IN (${ruleVersionIds.join(',')})`,
          { type: QueryTypes.RAW },
        );
      }
      if (rewardVersionIds.length > 0) {
        await sequelize.query(
          `DELETE FROM reward_config.reward_versions WHERE id IN (${rewardVersionIds.join(',')})`,
          { type: QueryTypes.RAW },
        );
      }
      if (ruleMasterIds.length > 0) {
        await sequelize.query(
          `DELETE FROM reward_config.rule_master WHERE id IN (${ruleMasterIds.join(',')})`,
          { type: QueryTypes.RAW },
        );
      }
      if (trackerComponentId) {
        await sequelize.query(
          `DELETE FROM reward_config.tracker_components WHERE id = ${trackerComponentId}`,
          { type: QueryTypes.RAW },
        );
      }
      if (rewardPolicyId) {
        await sequelize.query(
          `DELETE FROM reward_config.reward_policies WHERE id = ${rewardPolicyId}`,
          { type: QueryTypes.RAW },
        );
      }
      if (tenantCampaignId) {
        await sequelize.query(
          `DELETE FROM reward_config.tenant_campaigns WHERE id = ${tenantCampaignId}`,
          { type: QueryTypes.RAW },
        );
      }
      if (extraCountryIds.length > 0) {
        await sequelize.query(
          `DELETE FROM reward_config.countries WHERE id IN (${extraCountryIds.join(',')})`,
          { type: QueryTypes.RAW },
        );
      }
      await sequelize.query(
        `DELETE FROM reward_config.definition_requests WHERE title LIKE 'T005 test%'`,
        { type: QueryTypes.RAW },
      );
    } finally {
      await sequelize.query(
        `ALTER TABLE reward_config.rule_versions ENABLE TRIGGER trg_rule_versions_undeletable`,
        { type: QueryTypes.RAW },
      );
      await sequelize.query(
        `ALTER TABLE reward_config.reward_versions ENABLE TRIGGER trg_reward_versions_undeletable`,
        { type: QueryTypes.RAW },
      );
      await sequelize.close();
    }
  });

  async function createRuleMaster(suffix: string): Promise<number> {
    const id = await insertReturningId(
      `INSERT INTO reward_config.rule_master (tenant_id, sub_category_id, rule_code, name, created_by)
       VALUES (${tenantId}, ${subCategoryId}, 't005test_${suffix}', 'T005 Test ${suffix}', 1)
       RETURNING id`,
    );
    ruleMasterIds.push(id);
    return id;
  }

  describe('rule_versions — lifecycle and shape (TC-4, TC-5, TC-9, TC-10, TC-11)', () => {
    it('TC-4: inserts rule version v1 as draft — accepted', async () => {
      const ruleId = await createRuleMaster('tc4');
      const id = await insertReturningId(
        `INSERT INTO reward_config.rule_versions (rule_id, version_no, expression, parameters, created_by)
         VALUES (${ruleId}, 1, 'a > b', '{}', 1) RETURNING id`,
      );
      ruleVersionIds.push(id);
      expect(id).toBeGreaterThan(0);
    });

    it('TC-5: updates expression while draft — accepted', async () => {
      const ruleId = await createRuleMaster('tc5');
      const id = await insertReturningId(
        `INSERT INTO reward_config.rule_versions (rule_id, version_no, expression, parameters, created_by)
         VALUES (${ruleId}, 1, 'a > b', '{}', 1) RETURNING id`,
      );
      ruleVersionIds.push(id);
      await expect(
        sequelize.query(
          `UPDATE reward_config.rule_versions SET expression = 'a >= b' WHERE id = ${id}`,
          { type: QueryTypes.RAW },
        ),
      ).resolves.toBeDefined();
    });

    it('TC-9: a second draft for the same rule is rejected by uq_rv_one_draft', async () => {
      const ruleId = await createRuleMaster('tc9');
      const id1 = await insertReturningId(
        `INSERT INTO reward_config.rule_versions (rule_id, version_no, expression, created_by)
         VALUES (${ruleId}, 1, 'a > b', 1) RETURNING id`,
      );
      ruleVersionIds.push(id1);
      await expect(
        sequelize.query(
          `INSERT INTO reward_config.rule_versions (rule_id, version_no, expression, created_by)
           VALUES (${ruleId}, 2, 'a > c', 1)`,
          { type: QueryTypes.RAW },
        ),
      ).rejects.toMatchObject({
        name: 'SequelizeUniqueConstraintError',
        parent: expect.objectContaining({ constraint: 'uq_rv_one_draft' }),
      });
    });

    it('TC-10: a duplicate (rule_id, version_no) is rejected by uq_rv_rule_version', async () => {
      const ruleId = await createRuleMaster('tc10');
      const id1 = await insertReturningId(
        `INSERT INTO reward_config.rule_versions (rule_id, version_no, expression, created_by)
         VALUES (${ruleId}, 1, 'a > b', 1) RETURNING id`,
      );
      ruleVersionIds.push(id1);
      // Publish v1 first so the second insert doesn't also trip uq_rv_one_draft —
      // isolating the constraint this test case actually targets.
      await sequelize.query(
        `UPDATE reward_config.rule_versions
         SET status = 'published', published_by = 1, published_at = now()
         WHERE id = ${id1}`,
        { type: QueryTypes.RAW },
      );
      await expect(
        sequelize.query(
          `INSERT INTO reward_config.rule_versions (rule_id, version_no, expression, created_by)
           VALUES (${ruleId}, 1, 'a > d', 1)`,
          { type: QueryTypes.RAW },
        ),
      ).rejects.toMatchObject({
        name: 'SequelizeUniqueConstraintError',
        parent: expect.objectContaining({ constraint: 'uq_rv_rule_version' }),
      });
    });

    it('TC-11: a published row with NULL published_at is rejected by ck_rv_published_fields', async () => {
      const ruleId = await createRuleMaster('tc11');
      await expect(
        sequelize.query(
          `INSERT INTO reward_config.rule_versions (rule_id, version_no, expression, status, published_by, created_by)
           VALUES (${ruleId}, 1, 'a > b', 'published', 1, 1)`,
          { type: QueryTypes.RAW },
        ),
      ).rejects.toThrow(/ck_rv_published_fields/);
    });
  });

  describe('rule_versions — immutability trigger (TC-6, TC-7, TC-8) — the core of this task', () => {
    let ruleId: number;
    let versionId: number;

    beforeAll(async () => {
      ruleId = await createRuleMaster('tc678');
      versionId = await insertReturningId(
        `INSERT INTO reward_config.rule_versions (rule_id, version_no, expression, parameters, created_by)
         VALUES (${ruleId}, 1, 'a > b', '{"x":1}', 1) RETURNING id`,
      );
      ruleVersionIds.push(versionId);
      await sequelize.query(
        `UPDATE reward_config.rule_versions
         SET status = 'published', published_by = 1, published_at = now()
         WHERE id = ${versionId}`,
        { type: QueryTypes.RAW },
      );
    });

    it('TC-6: publish then UPDATE expression is rejected by the trigger', async () => {
      await expect(
        sequelize.query(
          `UPDATE reward_config.rule_versions SET expression = 'x != y' WHERE id = ${versionId}`,
          { type: QueryTypes.RAW },
        ),
      ).rejects.toThrow(/rule_versions\.\d+ is published and immutable/);
    });

    it('TC-7: publish then UPDATE parameters is rejected by the trigger', async () => {
      await expect(
        sequelize.query(
          `UPDATE reward_config.rule_versions SET parameters = '{"x":2}' WHERE id = ${versionId}`,
          { type: QueryTypes.RAW },
        ),
      ).rejects.toThrow(/rule_versions\.\d+ is published and immutable/);
    });

    it('TC-8: publish then UPDATE status to deprecated is accepted — status may still move', async () => {
      await expect(
        sequelize.query(
          `UPDATE reward_config.rule_versions SET status = 'deprecated', deprecated_at = now() WHERE id = ${versionId}`,
          { type: QueryTypes.RAW },
        ),
      ).resolves.toBeDefined();

      const [row] = await sequelize.query<{ status: string }>(
        `SELECT status FROM reward_config.rule_versions WHERE id = ${versionId}`,
        { type: QueryTypes.SELECT },
      );
      expect(row.status).toBe('deprecated');
    });
  });

  describe('rule_versions — undeletability trigger (TC-14, TC-15)', () => {
    it('TC-14: DELETE of a published version is rejected by the trigger', async () => {
      const ruleId = await createRuleMaster('tc14');
      const versionId = await insertReturningId(
        `INSERT INTO reward_config.rule_versions (rule_id, version_no, expression, created_by)
         VALUES (${ruleId}, 1, 'a > b', 1) RETURNING id`,
      );
      ruleVersionIds.push(versionId);
      await sequelize.query(
        `UPDATE reward_config.rule_versions
         SET status = 'published', published_by = 1, published_at = now()
         WHERE id = ${versionId}`,
        { type: QueryTypes.RAW },
      );

      await expect(
        sequelize.query(`DELETE FROM reward_config.rule_versions WHERE id = ${versionId}`, {
          type: QueryTypes.RAW,
        }),
      ).rejects.toThrow(/rule_versions\.\d+ is published and cannot be deleted/);
    });

    it('TC-15: DELETE of a draft version is accepted', async () => {
      const ruleId = await createRuleMaster('tc15');
      const versionId = await insertReturningId(
        `INSERT INTO reward_config.rule_versions (rule_id, version_no, expression, created_by)
         VALUES (${ruleId}, 1, 'a > b', 1) RETURNING id`,
      );
      // Deliberately not pushed to ruleVersionIds — it's being deleted by the test itself.
      await expect(
        sequelize.query(`DELETE FROM reward_config.rule_versions WHERE id = ${versionId}`, {
          type: QueryTypes.RAW,
        }),
      ).resolves.toBeDefined();

      const rows = await sequelize.query(
        `SELECT id FROM reward_config.rule_versions WHERE id = ${versionId}`,
        { type: QueryTypes.SELECT },
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('rule_versions — retirement is not deletion (TC-16)', () => {
    it('TC-16: a retired version stays readable', async () => {
      const ruleId = await createRuleMaster('tc16');
      const versionId = await insertReturningId(
        `INSERT INTO reward_config.rule_versions (rule_id, version_no, expression, created_by)
         VALUES (${ruleId}, 1, 'a > b', 1) RETURNING id`,
      );
      ruleVersionIds.push(versionId);
      await sequelize.query(
        `UPDATE reward_config.rule_versions
         SET status = 'published', published_by = 1, published_at = now()
         WHERE id = ${versionId}`,
        { type: QueryTypes.RAW },
      );
      await sequelize.query(
        `UPDATE reward_config.rule_versions SET status = 'retired', retired_at = now() WHERE id = ${versionId}`,
        { type: QueryTypes.RAW },
      );

      const [row] = await sequelize.query<{ status: string; expression: string }>(
        `SELECT status, expression FROM reward_config.rule_versions WHERE id = ${versionId}`,
        { type: QueryTypes.SELECT },
      );
      expect(row.status).toBe('retired');
      expect(row.expression).toBe('a > b');
    });
  });

  describe('reward_versions — mirrors the rule-side immutability and undeletability triggers', () => {
    it('rejects an UPDATE to connector_config on a published reward version', async () => {
      const versionId = await insertReturningId(
        `INSERT INTO reward_config.reward_versions (reward_id, version_no, connector_config, unit_type, unit_code, created_by)
         VALUES (${rewardSystemId}, 9001, '{"a":1}', 'points', 'PTS', 1) RETURNING id`,
      );
      rewardVersionIds.push(versionId);
      await sequelize.query(
        `UPDATE reward_config.reward_versions
         SET status = 'published', published_by = 1, published_at = now()
         WHERE id = ${versionId}`,
        { type: QueryTypes.RAW },
      );
      await expect(
        sequelize.query(
          `UPDATE reward_config.reward_versions SET connector_config = '{"a":2}' WHERE id = ${versionId}`,
          { type: QueryTypes.RAW },
        ),
      ).rejects.toThrow(/reward_versions\.\d+ is published and immutable/);
    });

    it('rejects DELETE of a published reward version', async () => {
      const versionId = await insertReturningId(
        `INSERT INTO reward_config.reward_versions (reward_id, version_no, connector_config, unit_type, unit_code, created_by)
         VALUES (${rewardSystemId}, 9002, '{"a":1}', 'currency', 'MYR', 1) RETURNING id`,
      );
      rewardVersionIds.push(versionId);
      await sequelize.query(
        `UPDATE reward_config.reward_versions
         SET status = 'published', published_by = 1, published_at = now()
         WHERE id = ${versionId}`,
        { type: QueryTypes.RAW },
      );
      await expect(
        sequelize.query(`DELETE FROM reward_config.reward_versions WHERE id = ${versionId}`, {
          type: QueryTypes.RAW,
        }),
      ).rejects.toThrow(/reward_versions\.\d+ is published and cannot be deleted/);
    });

    it('rejects an invalid unit_type outside currency|points|voucher', async () => {
      await expect(
        sequelize.query(
          `INSERT INTO reward_config.reward_versions (reward_id, version_no, unit_type, created_by)
           VALUES (${rewardSystemId}, 9003, 'bitcoin', 1)`,
          { type: QueryTypes.RAW },
        ),
      ).rejects.toThrow(/ck_rewv_unit_type/);
    });
  });

  describe('rule_version_country_assignments — the core requirement (TC-12, TC-13)', () => {
    it('TC-12: v2 AND v3 of one rule can both be assigned to one country', async () => {
      const ruleId = await createRuleMaster('tc12');
      const v1 = await insertReturningId(
        `INSERT INTO reward_config.rule_versions (rule_id, version_no, expression, created_by)
         VALUES (${ruleId}, 1, 'v1', 1) RETURNING id`,
      );
      ruleVersionIds.push(v1);
      await sequelize.query(
        `UPDATE reward_config.rule_versions SET status='published', published_by=1, published_at=now() WHERE id=${v1}`,
        { type: QueryTypes.RAW },
      );
      const v2 = await insertReturningId(
        `INSERT INTO reward_config.rule_versions (rule_id, version_no, expression, supersedes_version_id, created_by)
         VALUES (${ruleId}, 2, 'v2', ${v1}, 1) RETURNING id`,
      );
      ruleVersionIds.push(v2);
      await sequelize.query(
        `UPDATE reward_config.rule_versions SET status='published', published_by=1, published_at=now() WHERE id=${v2}`,
        { type: QueryTypes.RAW },
      );
      const v3 = await insertReturningId(
        `INSERT INTO reward_config.rule_versions (rule_id, version_no, expression, supersedes_version_id, created_by)
         VALUES (${ruleId}, 3, 'v3', ${v2}, 1) RETURNING id`,
      );
      ruleVersionIds.push(v3);
      await sequelize.query(
        `UPDATE reward_config.rule_versions SET status='published', published_by=1, published_at=now() WHERE id=${v3}`,
        { type: QueryTypes.RAW },
      );

      await expect(
        sequelize.query(
          `INSERT INTO reward_config.rule_version_country_assignments
             (rule_version_id, rule_id, country_id, assigned_by)
           VALUES (${v2}, ${ruleId}, ${countryId}, 1)`,
          { type: QueryTypes.RAW },
        ),
      ).resolves.toBeDefined();
      await expect(
        sequelize.query(
          `INSERT INTO reward_config.rule_version_country_assignments
             (rule_version_id, rule_id, country_id, assigned_by)
           VALUES (${v3}, ${ruleId}, ${countryId}, 1)`,
          { type: QueryTypes.RAW },
        ),
      ).resolves.toBeDefined();

      const rows = await sequelize.query(
        `SELECT id FROM reward_config.rule_version_country_assignments
         WHERE rule_id = ${ruleId} AND country_id = ${countryId}`,
        { type: QueryTypes.SELECT },
      );
      expect(rows).toHaveLength(2);

      // TC-13: the same version assigned to the same country a second time is rejected.
      await expect(
        sequelize.query(
          `INSERT INTO reward_config.rule_version_country_assignments
             (rule_version_id, rule_id, country_id, assigned_by)
           VALUES (${v3}, ${ruleId}, ${countryId}, 1)`,
          { type: QueryTypes.RAW },
        ),
      ).rejects.toMatchObject({
        name: 'SequelizeUniqueConstraintError',
        parent: expect.objectContaining({ constraint: 'uq_rvca' }),
      });
    });
  });

  describe('additive columns — backward compatibility (TC-17, TC-18)', () => {
    it('TC-17: an existing-shape INSERT into tracker_component_rules (no rule_version_id) still succeeds', async () => {
      const ruleId = await createRuleMaster('tc17');
      trackerComponentId = await insertReturningId(
        `INSERT INTO reward_config.tracker_components (tenant_id, component_code, name)
         VALUES (${tenantId}, 't005test_tc17_comp', 'T005 Test Component')
         RETURNING id`,
      );
      tcrId = await insertReturningId(
        `INSERT INTO reward_config.tracker_component_rules (tenant_id, tracker_component_id, rule_id)
         VALUES (${tenantId}, ${trackerComponentId}, ${ruleId})
         RETURNING id`,
      );
      expect(tcrId).toBeGreaterThan(0);

      const [row] = await sequelize.query<{ rule_version_id: number | null }>(
        `SELECT rule_version_id FROM reward_config.tracker_component_rules WHERE id = ${tcrId}`,
        { type: QueryTypes.SELECT },
      );
      expect(row.rule_version_id).toBeNull();
    });

    it('TC-18: an existing-shape INSERT into reward_campaign_assignments (no reward_version_id) still succeeds', async () => {
      rewardPolicyId = await insertReturningId(
        `INSERT INTO reward_config.reward_policies (reward_system_id, policy_code, name)
         VALUES (${rewardSystemId}, 't005test_tc18_policy', 'T005 Test Policy')
         RETURNING id`,
      );
      tenantCampaignId = await insertReturningId(
        `INSERT INTO reward_config.tenant_campaigns (tenant_id, campaign_code, name, start_date, end_date, created_by)
         VALUES (${tenantId}, 't005test_tc18_campaign', 'T005 Test Campaign', now(), now() + interval '30 days', 'test')
         RETURNING id`,
      );
      rcaId = await insertReturningId(
        `INSERT INTO reward_config.reward_campaign_assignments (tenant_id, reward_policy_id, campaign_id)
         VALUES (${tenantId}, ${rewardPolicyId}, ${tenantCampaignId})
         RETURNING id`,
      );
      expect(rcaId).toBeGreaterThan(0);

      const [row] = await sequelize.query<{ reward_version_id: number | null }>(
        `SELECT reward_version_id FROM reward_config.reward_campaign_assignments WHERE id = ${rcaId}`,
        { type: QueryTypes.SELECT },
      );
      expect(row.reward_version_id).toBeNull();
    });

    it('tenant_campaigns.definition_pinned_at exists, nullable, and is settable', async () => {
      expect(tenantCampaignId).toBeDefined();
      await expect(
        sequelize.query(
          `UPDATE reward_config.tenant_campaigns SET definition_pinned_at = now() WHERE id = ${tenantCampaignId}`,
          { type: QueryTypes.RAW },
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('definition_requests — full lifecycle (TC-20)', () => {
    it('accepts every status value in the CHECK constraint', async () => {
      const statuses = [
        'submitted',
        'under_review',
        'approved',
        'rejected',
        'fulfilled',
        'withdrawn',
      ];
      for (const status of statuses) {
        await expect(
          sequelize.query(
            `INSERT INTO reward_config.definition_requests
               (request_type, requested_by, title, description, status)
             VALUES ('new_rule', 1, 'T005 test ${status}', 'lifecycle check', '${status}')`,
            { type: QueryTypes.RAW },
          ),
        ).resolves.toBeDefined();
      }
    });

    it('rejects a request_type outside the CHECK constraint', async () => {
      await expect(
        sequelize.query(
          `INSERT INTO reward_config.definition_requests (request_type, requested_by, title, description)
           VALUES ('new_widget', 1, 'T005 test bad type', 'lifecycle check')`,
          { type: QueryTypes.RAW },
        ),
      ).rejects.toThrow(/ck_dr_type/);
    });
  });

  describe('version_blasts + version_blast_targets — a 12-country blast (TC-21)', () => {
    it('creates 1 blast row and 12 target rows', async () => {
      const ruleId = await createRuleMaster('tc21');
      const versionId = await insertReturningId(
        `INSERT INTO reward_config.rule_versions (rule_id, version_no, expression, created_by)
         VALUES (${ruleId}, 1, 'a > b', 1) RETURNING id`,
      );
      ruleVersionIds.push(versionId);
      await sequelize.query(
        `UPDATE reward_config.rule_versions SET status='published', published_by=1, published_at=now() WHERE id=${versionId}`,
        { type: QueryTypes.RAW },
      );

      const codes = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7', 'Z8', 'Z9', 'ZA', 'ZB', 'ZC'];
      expect(codes).toHaveLength(12);
      for (const code of codes) {
        const id = await insertReturningId(
          `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code)
           VALUES ('${code}', 'T005 Test ${code}', 'UTC', 'USD', '+1')
           RETURNING id`,
        );
        extraCountryIds.push(id);
      }

      const blastId = await insertReturningId(
        `INSERT INTO reward_config.version_blasts
           (entity_type, entity_id, version_id, version_no, scope, target_count, blasted_by)
         VALUES ('rule', ${ruleId}, ${versionId}, 1, 'selected', ${extraCountryIds.length}, 1)
         RETURNING id`,
      );
      blastIds.push(blastId);

      for (const cid of extraCountryIds) {
        await sequelize.query(
          `INSERT INTO reward_config.version_blast_targets (blast_id, country_id)
           VALUES (${blastId}, ${cid})`,
          { type: QueryTypes.RAW },
        );
      }

      const blastRows = await sequelize.query(
        `SELECT id FROM reward_config.version_blasts WHERE id = ${blastId}`,
        { type: QueryTypes.SELECT },
      );
      expect(blastRows).toHaveLength(1);

      const targetRows = await sequelize.query(
        `SELECT id FROM reward_config.version_blast_targets WHERE blast_id = ${blastId}`,
        { type: QueryTypes.SELECT },
      );
      expect(targetRows).toHaveLength(12);
    });
  });

  describe('scope boundary — decision/evaluation logs are out of scope (TC-22)', () => {
    it('the migration set contains zero references to rule_evaluation_log or PARTITION BY', () => {
      const migrationsDir = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
      const files = fs.readdirSync(migrationsDir).filter((f) => f.startsWith('T005_'));
      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        const content = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        expect(content).not.toMatch(/evaluation_log/i);
        expect(content).not.toMatch(/PARTITION BY/i);
      }
    });
  });
});
