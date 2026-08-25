/**
 * T-049 — AGENT-PROTOCOL R7 for this task's one migration, `T049_001_seed_agent_nav`, plus the
 * evidence that the seeded row is the one the *"Create with AI"* nav entry needs.
 *
 * ### Why the cycle is driven directly rather than through `npm run db:rollback`
 *
 * The same two reasons `t048-migrations.e2e-spec.ts` records, and its third one applies here too in
 * reverse: `T049_001` sorts **before** `T055_001`/`T056_001` by filename, so a bare
 * `npm run db:rollback` immediately after applying it rolls back `T056_001`, not this one. The CLI
 * cycle was still run for real (three rollbacks, then one `db:migrate` re-applying all three — see
 * the completion report); this suite is the per-migration proof, and it additionally asserts what
 * the CLI cannot: that the row is scoped to `maker` and to no other role.
 *
 * ### The row is a discoverability decision, never an access one
 *
 * `role_nav_configs` decides what appears in the menu. What decides who may *use* the screen is
 * `@Roles('maker')` + `@RequirePermission('campaign','create')` on `agent.controller.ts` (T-048),
 * re-checked on every request. The assertion below that no other role gets a row is therefore about
 * not showing anyone a door they cannot open — it is not, and must not be read as, the lock.
 */
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { createMigrationConnection } from '@/database/migration-connection';
import * as agentNav from '@/database/migrations/T049_001_seed_agent_nav';

jest.setTimeout(120_000);

let db: Sequelize;

interface NavRow {
  readonly role: string;
  readonly nav_key: string;
  readonly label: string;
  readonly path: string;
  readonly sort_order: number;
}

async function assistantRows(): Promise<NavRow[]> {
  return db.query<NavRow>(
    `SELECT role, nav_key, label, path, sort_order
       FROM reward_config.role_nav_configs
      WHERE nav_key = 'campaign_assistant'
      ORDER BY role`,
    { type: QueryTypes.SELECT },
  );
}

async function makerMenu(): Promise<NavRow[]> {
  return db.query<NavRow>(
    `SELECT role, nav_key, label, path, sort_order
       FROM reward_config.role_nav_configs
      WHERE role = 'maker'
      ORDER BY sort_order`,
    { type: QueryTypes.SELECT },
  );
}

beforeAll(async () => {
  db = createMigrationConnection();
  await db.authenticate();
  // The suite starts from "applied", whatever state the shared dev database was left in.
  await agentNav.up({ context: db });
});

afterAll(async () => {
  // Left applied, which is the state `npm run db:status` reports and the SPA expects.
  await agentNav.up({ context: db });
  await db.close();
});

describe('T049_001 — the "Create with AI" nav row', () => {
  it('seeds exactly one row, for the maker, pointing at the assistant route', async () => {
    const rows = await assistantRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'maker',
      nav_key: 'campaign_assistant',
      label: 'Create with AI',
      path: '/campaigns/assistant',
    });
  });

  it('sits directly after "Create Campaign" — the wizard is still offered first', async () => {
    const menu = await makerMenu();
    const labels = menu.map((row) => row.label);

    expect(labels).toEqual(['Dashboard', 'My Campaigns', 'Create Campaign', 'Create with AI']);
    const wizard = menu.find((row) => row.nav_key === 'campaign_new');
    const assistant = menu.find((row) => row.nav_key === 'campaign_assistant');
    expect(assistant?.sort_order).toBeGreaterThan(wizard?.sort_order ?? 0);
  });

  it('gives no other role a link to a screen it cannot open', async () => {
    const rows = await db.query<{ role: string }>(
      `SELECT DISTINCT role FROM reward_config.role_nav_configs WHERE path = '/campaigns/assistant'`,
      { type: QueryTypes.SELECT },
    );

    expect(rows.map((row) => row.role)).toEqual(['maker']);
  });

  it('is idempotent — re-applying inserts no duplicate (ON CONFLICT DO NOTHING)', async () => {
    await agentNav.up({ context: db });
    await agentNav.up({ context: db });

    expect(await assistantRows()).toHaveLength(1);
  });

  it('down() removes exactly its own row and leaves the rest of the menu intact', async () => {
    await agentNav.down({ context: db });

    expect(await assistantRows()).toHaveLength(0);
    expect((await makerMenu()).map((row) => row.nav_key)).toEqual([
      'dashboard',
      'campaigns',
      'campaign_new',
    ]);
  });

  it('survives a second full cycle — rollback and re-apply are both repeatable', async () => {
    await agentNav.up({ context: db });
    expect(await assistantRows()).toHaveLength(1);
    await agentNav.down({ context: db });
    expect(await assistantRows()).toHaveLength(0);
    await agentNav.up({ context: db });
    expect(await assistantRows()).toHaveLength(1);
  });
});
