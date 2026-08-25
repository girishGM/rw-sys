/**
 * T-003 regression suite — the schema-drift check itself (implementation note 8). Named
 * `.e2e-spec.ts` rather than the task file's literal `schema-drift.spec.ts` — the same
 * documented deviation T-002/T-005/T-006/T-007 already established (`jest.config.js`'s
 * `rootDir: 'src'` never collects anything under `test/`; only `test/jest-e2e.json`'s
 * `.e2e-spec.ts$` pattern does), see those tasks' completion reports.
 */
import 'reflect-metadata';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import {
  checkModelDrift,
  checkSchemaDrift,
  type AnyModelClass,
} from '@/database/util/schema-drift';
import { buildAppSequelize } from './build-app-sequelize';
import { PORTAL_MODELS } from '@/database/portal-models';
import { REWARD_CONFIG_MODELS } from '@/database/models';
import { Model, Table, Column, DataType } from 'sequelize-typescript';

// A throwaway model pointed at a scratch table this suite creates and drops itself, in
// `public` (never `reward_config` — R1) — used only by TC-12, never registered on `app`.
@Table({ schema: 'public', tableName: 'zzt003_scratch_drift', timestamps: false })
class ScratchDriftModel extends Model<ScratchDriftModel> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.STRING(50), field: 'watched_column' })
  declare watchedColumn: string;
}

describe('T-003 — schema-drift check', () => {
  let app: Sequelize;
  let migration: Sequelize;

  beforeAll(async () => {
    app = buildAppSequelize();
    // Registered on the same connection the rest of the suite already builds with every
    // T-003 model — `addModels` is additive, so this doesn't rebind anything else.
    app.addModels([ScratchDriftModel]);
    await app.authenticate();
    migration = createMigrationConnection();
    await migration.authenticate();

    await migration.query(
      `CREATE TABLE IF NOT EXISTS public.zzt003_scratch_drift (
         id int generated always as identity primary key,
         watched_column varchar(50)
       );`,
      { type: QueryTypes.RAW },
    );
    // Unlike reward_config (where reward_app already has broad default privileges
    // pre-dating this task's own migrations — confirmed live, not assumed), the `public`
    // schema grants nothing by default; without this, `information_schema.columns` (which
    // Postgres filters by the querying role's own privileges) would return zero rows for
    // this table under the `app`/`reward_app` connection the check runs on, regardless of
    // whether the column actually exists — a false positive, not real drift.
    await migration.query('GRANT SELECT ON public.zzt003_scratch_drift TO reward_app;', {
      type: QueryTypes.RAW,
    });
  });

  afterAll(async () => {
    await migration.query('DROP TABLE IF EXISTS public.zzt003_scratch_drift;', {
      type: QueryTypes.RAW,
    });
    await app.close();
    await migration.close();
  });

  it('TC-2: every registered model matches the live schema exactly', async () => {
    const allModels = [...PORTAL_MODELS, ...REWARD_CONFIG_MODELS] as AnyModelClass[];
    const issues = await checkSchemaDrift(app, allModels);
    if (issues.length > 0) {
      // eslint-disable-next-line no-console -- test diagnostics only, not app logging.
      console.error('Schema drift detected:', JSON.stringify(issues, null, 2));
    }
    expect(issues).toEqual([]);
  });

  it('TC-12: dropping a watched column makes the drift check fail, naming that column', async () => {
    const before = await checkModelDrift(app, ScratchDriftModel as unknown as AnyModelClass);
    expect(before).toEqual([]);

    await migration.query('ALTER TABLE public.zzt003_scratch_drift DROP COLUMN watched_column;', {
      type: QueryTypes.RAW,
    });

    const after = await checkModelDrift(app, ScratchDriftModel as unknown as AnyModelClass);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ column: 'watched_column' });
    expect(after[0].detail).toContain('watched_column');
  });
});
