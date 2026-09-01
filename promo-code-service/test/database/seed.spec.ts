/**
 * T-PC-003 regression suite. Runs against the real Postgres 16 server documented in root
 * `CLAUDE.md` (same connection convention as `test/database/migrations.spec.ts`) — assumes the
 * schema is already migrated (as it is by the time `npm test` runs in the completion-report
 * verification sequence).
 *
 * Deliberately does **not** clean up the rows it inserts in an `afterAll`, unlike
 * `migrations.spec.ts`'s own per-test random-tenant rows: the whole point of this seed (task
 * file "Objective") is that the demo `promo_code_config` rows persist as real, usable local
 * dev/demo data after the suite runs — the task file's own "Rollback" section documents the
 * manual `DELETE ... WHERE created_by = <demo actor>` for whoever wants to remove them, not an
 * automatic per-test-run teardown.
 */
import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import { seedDemoPromoCodeConfigs } from '@/database/seeds/001_seed_demo_promo_code_configs';
import { DEMO_ACTOR_ID, DEMO_PROMO_CODE_CONFIGS } from '@/database/seeds/seed-data.constants';

interface DemoRow {
  reward_value_type: string;
  character_set: string;
}

async function fetchDemoRows(sequelize: Sequelize): Promise<DemoRow[]> {
  return sequelize.query<DemoRow>(
    `SELECT reward_value_type, character_set
       FROM promo_code.promo_code_config
      WHERE created_by = :actor`,
    { type: QueryTypes.SELECT, replacements: { actor: DEMO_ACTOR_ID } },
  );
}

describe('T-PC-003 — seed demo promo code configs', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
    // Idempotent by construction (ON CONFLICT DO NOTHING) — safe to run once up front so every
    // `it()` below observes the same, already-seeded state regardless of run order.
    await seedDemoPromoCodeConfigs(sequelize);
  });

  afterAll(async () => {
    await sequelize.close();
  });

  // TC-1
  it('TC-1: inserts one row per demo config constant', async () => {
    const rows = await fetchDemoRows(sequelize);
    expect(rows).toHaveLength(DEMO_PROMO_CODE_CONFIGS.length);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  // TC-2 — the actual, real-Postgres-enforced property (row count unchanged after a second
  // run), not a mocked/stubbed "did I call INSERT" check (AGENT-PROTOCOL.md §3).
  it('TC-2: running the seed a second time inserts no duplicate rows', async () => {
    const before = await fetchDemoRows(sequelize);
    await expect(seedDemoPromoCodeConfigs(sequelize)).resolves.toBeUndefined();
    const after = await fetchDemoRows(sequelize);
    expect(after).toHaveLength(before.length);
  });

  // TC-3
  it('TC-3: covers all three reward_value_type values', async () => {
    const rows = await fetchDemoRows(sequelize);
    const types = new Set(rows.map((r) => r.reward_value_type));
    expect(types).toEqual(new Set(['FIXED_AMOUNT', 'PERCENTAGE', 'POINTS']));
  });

  // TC-4
  it('TC-4: covers at least two distinct character_set values', async () => {
    const rows = await fetchDemoRows(sequelize);
    const characterSets = new Set(rows.map((r) => r.character_set));
    expect(characterSets.size).toBeGreaterThanOrEqual(2);
  });
});
