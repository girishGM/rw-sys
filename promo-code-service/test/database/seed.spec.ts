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
import {
  DEMO_ACTOR_ID,
  DEMO_MERCHANT_ID,
  DEMO_TENANT_ID,
  DEMO_PROMO_CODE_CONFIGS,
} from '@/database/seeds/seed-data.constants';

// A UUID has hyphens at fixed positions and hex-only segments — a cheap, honest shape check
// (not a full RFC-4122 validator) sufficient to prove these are plain strings, not the UUIDs
// they used to be pre-T-PC-052.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

describe('T-PC-052 — demo ids are plain strings, not UUIDs, unless overridden', () => {
  // TC-4: with no override present, the default demo ids are plain strings that don't happen to
  // look like UUIDs — proves the T-PC-052 fix actually took (a value that merely *validates* as
  // varchar(64) could still coincidentally be UUID-shaped; this rules that out for the defaults).
  it('TC-4: DEMO_TENANT_ID/DEMO_MERCHANT_ID/DEMO_ACTOR_ID are plain strings, not UUID-shaped', () => {
    expect(DEMO_TENANT_ID).toBe('1');
    expect(DEMO_TENANT_ID).not.toMatch(UUID_SHAPE);
    expect(DEMO_MERCHANT_ID).not.toMatch(UUID_SHAPE);
    expect(DEMO_ACTOR_ID).not.toMatch(UUID_SHAPE);
  });

  // TC-5: `DEMO_PORTAL_TENANT_ID` overrides the `'1'` default. `seed-data.constants.ts` reads
  // `process.env` at module-evaluation time, so the override must be set *before* a fresh
  // `require` of that module — `jest.isolateModules` + `resetModules` gives each of these two
  // assertions its own clean module registry rather than relying on Node's require cache from
  // the top-level import above (which already froze in the no-override value).
  it('TC-5: DEMO_PORTAL_TENANT_ID env var overrides the default', () => {
    const previous = process.env.DEMO_PORTAL_TENANT_ID;
    try {
      process.env.DEMO_PORTAL_TENANT_ID = '999';
      let overridden: { DEMO_TENANT_ID: string } | undefined;
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires -- isolated re-require needed to observe env at module-eval time
        overridden = require('@/database/seeds/seed-data.constants');
      });
      expect(overridden?.DEMO_TENANT_ID).toBe('999');
    } finally {
      if (previous === undefined) {
        delete process.env.DEMO_PORTAL_TENANT_ID;
      } else {
        process.env.DEMO_PORTAL_TENANT_ID = previous;
      }
    }
  });

  it('adjacent behaviour: with no override, a fresh module load still resolves to the default', () => {
    const previous = process.env.DEMO_PORTAL_TENANT_ID;
    delete process.env.DEMO_PORTAL_TENANT_ID;
    try {
      let fresh: { DEMO_TENANT_ID: string } | undefined;
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires -- isolated re-require needed to observe env at module-eval time
        fresh = require('@/database/seeds/seed-data.constants');
      });
      expect(fresh?.DEMO_TENANT_ID).toBe('1');
    } finally {
      if (previous === undefined) {
        delete process.env.DEMO_PORTAL_TENANT_ID;
      } else {
        process.env.DEMO_PORTAL_TENANT_ID = previous;
      }
    }
  });
});
