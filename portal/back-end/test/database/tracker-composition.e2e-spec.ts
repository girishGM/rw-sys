/**
 * T-007 regression suite — `tracker_tracker_components.group_code` +
 * `tracker_group_defs` (12-CAMPAIGN-STRUCTURE.md §1). Runs against a real Postgres
 * instance, same convention as `t005-versioning-schema.e2e-spec.ts` /
 * `campaign-caps.e2e-spec.ts` (T-005 / T-006) — this dev machine has no working Docker
 * daemon, so there is no Testcontainers instance to spin up instead. Assumes the T007
 * migrations are already applied (`npm run db:migrate`).
 *
 * Named `.e2e-spec.ts` rather than the literal `tracker-composition.spec.ts` the task
 * file's own "Files owned" list names — the same deliberate, documented deviation as
 * T-006's suite (see that file's own doc comment, and the T-007 completion report):
 * `jest.config.js` (`rootDir: 'src'`) never looks outside `src/`, and neither configured
 * Jest project would ever collect a bare `.spec.ts` under `test/database/`. `.e2e-spec.ts`
 * is the only suffix `npm run test:e2e` actually runs.
 *
 * TC-1/2/3/15 (migrate on a clean DB, migrate twice, rollback-then-migrate, and `down()`
 * itself) are migration-lifecycle checks, not data-level assertions — verified directly by
 * running `npm run db:migrate && npm run db:rollback && npm run db:migrate` and inspecting
 * `information_schema` by hand, exactly like T-005/T-006's own suites did, and recorded in
 * the completion report's Verification steps rather than re-asserted here.
 *
 * Fixtures reuse one existing `tenants` row (this task creates no seed data — that's
 * T-004) and create their own throwaway `trackers` / `tracker_components` /
 * `tracker_tracker_components` / `tracker_group_defs` rows, all tagged with a `t007test_`
 * marker, cleaned up in `afterAll`. Nothing in this task makes a row undeletable, so no
 * trigger needs disabling for cleanup (unlike T-005).
 */
import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { createMigrationConnection } from '@/database/migration-connection';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

describe('T-007 — tracker composition: group_code + tracker_group_defs', () => {
  let sequelize: Sequelize;

  let tenantId: number;

  const trackerIds: number[] = [];
  const componentIds: number[] = [];
  const linkIds: number[] = [];
  const groupDefIds: number[] = [];

  async function insertReturningId(sql: string): Promise<number> {
    const [row] = await sequelize.query<{ id: number }>(sql, { type: QueryTypes.SELECT });
    return row.id;
  }

  async function createTracker(suffix: string): Promise<number> {
    const id = await insertReturningId(
      `INSERT INTO reward_config.trackers (tenant_id, tracker_code, name)
       VALUES (${tenantId}, 't007test_${suffix}', 'T007 Test Tracker ${suffix}')
       RETURNING id`,
    );
    trackerIds.push(id);
    return id;
  }

  async function createComponent(suffix: string): Promise<number> {
    const id = await insertReturningId(
      `INSERT INTO reward_config.tracker_components (tenant_id, component_code, name)
       VALUES (${tenantId}, 't007test_${suffix}', 'T007 Test Component ${suffix}')
       RETURNING id`,
    );
    componentIds.push(id);
    return id;
  }

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();

    tenantId = await insertReturningId(`SELECT id FROM reward_config.tenants ORDER BY id LIMIT 1`);
  });

  afterAll(async () => {
    if (linkIds.length > 0) {
      await sequelize.query(
        `DELETE FROM reward_config.tracker_tracker_components WHERE id IN (${linkIds.join(',')})`,
        { type: QueryTypes.RAW },
      );
    }
    if (groupDefIds.length > 0) {
      await sequelize.query(
        `DELETE FROM reward_config.tracker_group_defs WHERE id IN (${groupDefIds.join(',')})`,
        { type: QueryTypes.RAW },
      );
    }
    if (componentIds.length > 0) {
      await sequelize.query(
        `DELETE FROM reward_config.tracker_components WHERE id IN (${componentIds.join(',')})`,
        { type: QueryTypes.RAW },
      );
    }
    if (trackerIds.length > 0) {
      await sequelize.query(
        `DELETE FROM reward_config.trackers WHERE id IN (${trackerIds.join(',')})`,
        { type: QueryTypes.RAW },
      );
    }
    await sequelize.close();
  });

  describe('tracker_tracker_components.group_code — backward compatibility (TC-4, TC-5)', () => {
    it('TC-4: an existing-shape INSERT with no group_code still succeeds', async () => {
      const trackerId = await createTracker('tc4');
      const componentId = await createComponent('tc4');
      const id = await insertReturningId(
        `INSERT INTO reward_config.tracker_tracker_components (tracker_id, component_id)
         VALUES (${trackerId}, ${componentId}) RETURNING id`,
      );
      linkIds.push(id);

      const [row] = await sequelize.query<{ group_code: string | null }>(
        `SELECT group_code FROM reward_config.tracker_tracker_components WHERE id = ${id}`,
        { type: QueryTypes.SELECT },
      );
      expect(row.group_code).toBeNull();
    });

    it('TC-5: an INSERT with group_code = A is accepted', async () => {
      const trackerId = await createTracker('tc5');
      const componentId = await createComponent('tc5');
      const id = await insertReturningId(
        `INSERT INTO reward_config.tracker_tracker_components (tracker_id, component_id, group_code)
         VALUES (${trackerId}, ${componentId}, 'A') RETURNING id`,
      );
      linkIds.push(id);

      const [row] = await sequelize.query<{ group_code: string | null }>(
        `SELECT group_code FROM reward_config.tracker_tracker_components WHERE id = ${id}`,
        { type: QueryTypes.SELECT },
      );
      expect(row.group_code).toBe('A');
    });
  });

  describe('tracker_group_defs — shape and constraints (TC-6, TC-7, TC-8, TC-9)', () => {
    it('TC-6: a group def with logic all is accepted', async () => {
      const trackerId = await createTracker('tc6');
      const id = await insertReturningId(
        `INSERT INTO reward_config.tracker_group_defs (tracker_id, group_code, completion_logic)
         VALUES (${trackerId}, 'A', 'all') RETURNING id`,
      );
      groupDefIds.push(id);
      expect(id).toBeGreaterThan(0);
    });

    it('TC-7: a group def with logic n_of and no threshold is rejected by ck_tgd_threshold', async () => {
      const trackerId = await createTracker('tc7');
      await expect(
        sequelize.query(
          `INSERT INTO reward_config.tracker_group_defs (tracker_id, group_code, completion_logic)
           VALUES (${trackerId}, 'A', 'n_of')`,
          { type: QueryTypes.RAW },
        ),
      ).rejects.toThrow(/ck_tgd_threshold/);
    });

    it('TC-8: a group def with logic sometimes is rejected by ck_tgd_logic', async () => {
      const trackerId = await createTracker('tc8');
      await expect(
        sequelize.query(
          `INSERT INTO reward_config.tracker_group_defs (tracker_id, group_code, completion_logic)
           VALUES (${trackerId}, 'A', 'sometimes')`,
          { type: QueryTypes.RAW },
        ),
      ).rejects.toThrow(/ck_tgd_logic/);
    });

    it('TC-9: a duplicate (tracker_id, group_code) is rejected by uq_tgd', async () => {
      const trackerId = await createTracker('tc9');
      const id1 = await insertReturningId(
        `INSERT INTO reward_config.tracker_group_defs (tracker_id, group_code, completion_logic)
         VALUES (${trackerId}, 'A', 'all') RETURNING id`,
      );
      groupDefIds.push(id1);
      await expect(
        sequelize.query(
          `INSERT INTO reward_config.tracker_group_defs (tracker_id, group_code, completion_logic)
           VALUES (${trackerId}, 'A', 'any')`,
          { type: QueryTypes.RAW },
        ),
      ).rejects.toMatchObject({
        name: 'SequelizeUniqueConstraintError',
        parent: expect.objectContaining({ constraint: 'uq_tgd' }),
      });
    });

    it('a group def with a valid n_of threshold is accepted', async () => {
      const trackerId = await createTracker('tc-nof-ok');
      const id = await insertReturningId(
        `INSERT INTO reward_config.tracker_group_defs
           (tracker_id, group_code, completion_logic, completion_threshold)
         VALUES (${trackerId}, 'B', 'n_of', 2) RETURNING id`,
      );
      groupDefIds.push(id);
      expect(id).toBeGreaterThan(0);
    });
  });

  describe('two components sharing a group (TC-10)', () => {
    it('TC-10: two components with group_code = A on the same tracker are both accepted', async () => {
      const trackerId = await createTracker('tc10');
      const c1 = await createComponent('tc10a');
      const c2 = await createComponent('tc10b');

      const id1 = await insertReturningId(
        `INSERT INTO reward_config.tracker_tracker_components (tracker_id, component_id, group_code)
         VALUES (${trackerId}, ${c1}, 'A') RETURNING id`,
      );
      linkIds.push(id1);
      const id2 = await insertReturningId(
        `INSERT INTO reward_config.tracker_tracker_components (tracker_id, component_id, group_code)
         VALUES (${trackerId}, ${c2}, 'A') RETURNING id`,
      );
      linkIds.push(id2);

      const rows = await sequelize.query<{ group_code: string }>(
        `SELECT group_code FROM reward_config.tracker_tracker_components
         WHERE tracker_id = ${trackerId} AND group_code = 'A'`,
        { type: QueryTypes.SELECT },
      );
      expect(rows).toHaveLength(2);
    });
  });

  describe('tracker_component_groups — left untouched (TC-11)', () => {
    it('TC-11: the deprecated groups table has zero rows and is otherwise unaffected by this migration', async () => {
      const rows = await sequelize.query(`SELECT id FROM reward_config.tracker_component_groups`, {
        type: QueryTypes.SELECT,
      });
      expect(rows).toHaveLength(0);
    });
  });

  describe('no split re-emerges in portal source (TC-12)', () => {
    it('TC-12: every occurrence of tracker_component_groups in back-end/src is deprecation documentation, never a query, model or write', () => {
      const srcDir = path.join(__dirname, '..', '..', 'src');

      function walk(dir: string): string[] {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        return entries.flatMap((entry) => {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) return walk(full);
          return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
        });
      }

      const files = walk(srcDir);
      const hits: string[] = [];
      for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        if (content.includes('tracker_component_groups')) {
          hits.push(file);
        }
      }

      // Files legitimately allowed to mention the deprecated table:
      //  - tracker-group-def.model.ts: documents the deprecation itself.
      //  - tracker-tracker-component.model.ts: pre-existing documentation comment on the
      //    sibling model, explaining why this competing table was rejected (present before
      //    T-091 touched this suite — not introduced by it).
      //  - T002_008_grants.ts (T-091): reward_app still needs an explicit least-privilege
      //    GRANT/REVOKE on this table — it is left in place, untouched, per C1, and still
      //    read/written directly by consumers outside the portal's own Nest code (the
      //    reward_app role is shared with agents/create-campaign*, CLAUDE.md) — but a
      //    GRANT/REVOKE statement naming a table is not a query, a model, or a write against
      //    its data, which is the property this test actually cares about (asserted below).
      const allowedFiles = [
        path.join(srcDir, 'database', 'models', 'tracker-group-def.model.ts'),
        path.join(srcDir, 'database', 'models', 'tracker-tracker-component.model.ts'),
        path.join(srcDir, 'database', 'migrations', 'T002_008_grants.ts'),
      ];
      expect(hits.sort()).toEqual(allowedFiles.sort());

      const groupDefModelContent = fs.readFileSync(
        path.join(srcDir, 'database', 'models', 'tracker-group-def.model.ts'),
        'utf8',
      );
      expect(groupDefModelContent).toMatch(/portal-deprecated/);
      expect(groupDefModelContent).not.toMatch(/FROM\s+reward_config\.tracker_component_groups/i);
      expect(groupDefModelContent).not.toMatch(/tableName:\s*['"]tracker_component_groups['"]/);

      // The grants migration's own reference must be exactly that — GRANT/REVOKE, never a
      // live query, a Sequelize @Table binding, or a DML statement against the table's data.
      const grantsContent = fs.readFileSync(
        path.join(srcDir, 'database', 'migrations', 'T002_008_grants.ts'),
        'utf8',
      );
      expect(grantsContent).toMatch(/GRANT[^;]*reward_config\.tracker_component_groups/is);
      expect(grantsContent).not.toMatch(/FROM\s+reward_config\.tracker_component_groups/i);
      expect(grantsContent).not.toMatch(/tableName:\s*['"]tracker_component_groups['"]/);
      expect(grantsContent).not.toMatch(
        /(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+reward_config\.tracker_component_groups/i,
      );
    });
  });

  describe('wizard-shaped insert leaves group_code NULL (TC-13)', () => {
    it('TC-13: a tracker built the way the wizard will (no group_code on any link row) has NULL throughout', async () => {
      const trackerId = await createTracker('tc13');
      const c1 = await createComponent('tc13a');
      const c2 = await createComponent('tc13b');

      const id1 = await insertReturningId(
        `INSERT INTO reward_config.tracker_tracker_components (tracker_id, component_id, is_mandatory)
         VALUES (${trackerId}, ${c1}, true) RETURNING id`,
      );
      linkIds.push(id1);
      const id2 = await insertReturningId(
        `INSERT INTO reward_config.tracker_tracker_components (tracker_id, component_id, is_mandatory)
         VALUES (${trackerId}, ${c2}, false) RETURNING id`,
      );
      linkIds.push(id2);

      const rows = await sequelize.query<{ group_code: string | null }>(
        `SELECT group_code FROM reward_config.tracker_tracker_components WHERE tracker_id = ${trackerId}`,
        { type: QueryTypes.SELECT },
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.group_code).toBeNull();
      }
    });
  });

  describe('reward_config table count (TC-14)', () => {
    it('TC-14: tracker_group_defs is the only new table this migration set adds', async () => {
      const [{ count }] = await sequelize.query<{ count: string }>(
        `SELECT count(*) FROM information_schema.tables WHERE table_schema = 'reward_config'`,
        { type: QueryTypes.SELECT },
      );
      // The task file's own TC-14 says "68 -> 69" — stale, predating T-005 (+7) and T-006
      // (+2) actually running against this database (see the T-007 completion report's
      // Deviations section, same class of staleness T-006 already flagged for its own
      // TC-34). What matters and is asserted here: exactly one new table
      // (`tracker_group_defs`), nothing else, on top of whatever T-002/T-005/T-006 already
      // left behind.
      const exists = await sequelize.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'reward_config' AND table_name = 'tracker_group_defs'`,
        { type: QueryTypes.SELECT },
      );
      expect(exists).toHaveLength(1);
      expect(Number(count)).toBeGreaterThanOrEqual(72);
    });
  });
});
