/**
 * T-171 — AGENT-PROTOCOL R7 for this task's one migration ("every migration has a working
 * `down()`, proven by migrate → rollback → migrate on a clean DB"), plus TC-1 and TC-4's
 * constraint half.
 *
 * ### Why `up()`/`down()` are called directly rather than through the CLI
 *
 * Two independent reasons, both mechanical:
 *
 *  1. `npm run db:rollback` with no `--all` reverts the **last** migration in name order, which on
 *     this database is `T900_004_seed_demo_activity_rules` — not this one. Running it would delete
 *     the shared dev deployment's demo data and still prove nothing about `T171_001`.
 *  2. `npm run db:rollback -- --all` is blocked on this database by an earlier crypto migration
 *     whose own `down()` is irreversible — the same obstacle `T165_001`'s spec documents, and the
 *     same reason it uses this pattern.
 *
 * So the round trip is driven here, against the real Postgres, on exactly the one file this task
 * owns, and nothing else on the shared database is disturbed.
 *
 * ### Deviation from this task's own "Files owned" filename (flagged per AGENT-PROTOCOL §3)
 *
 * T-171 names this spec `test/database/activity-external-codes.migration.spec.ts`. That exact name
 * runs under neither Jest config: `jest.config.js`'s `roots` do not include `test/database` (so
 * `npm test` never sees it), and `test/jest-e2e.json`'s `testRegex` is `.e2e-spec.ts$` (so
 * `npm run test:e2e` doesn't either). Every other migration-behaviour suite here (`t119`, `t126`,
 * `t165`, ...) is named `*.e2e-spec.ts` for that reason. Same directory, same base name, the suffix
 * that actually runs — a test nobody executes would satisfy R10 only on paper.
 */
import 'reflect-metadata';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { createMigrationConnection } from '@/database/migration-connection';
import * as migration from '@/database/migrations/T171_001_activity_external_codes';

const TABLE = 'activity_external_codes';

let db: Sequelize;
/** Whether the migration was already applied when this suite started. See `afterAll`. */
let wasApplied: boolean;

async function sql<T extends object>(
  text: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return db.query<T>(text, { type: QueryTypes.SELECT, replacements });
}

async function tableExists(): Promise<boolean> {
  const rows = await sql<{ count: string }>(
    `SELECT count(*)::text AS count FROM information_schema.tables
      WHERE table_schema = 'reward_portal' AND table_name = :table`,
    { table: TABLE },
  );
  return rows[0].count === '1';
}

async function indexNames(): Promise<string[]> {
  const rows = await sql<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'reward_portal' AND tablename = :table
      ORDER BY indexname`,
    { table: TABLE },
  );
  return rows.map((row) => row.indexname);
}

async function grants(): Promise<string[]> {
  const rows = await sql<{ privilege_type: string }>(
    `SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'reward_portal' AND table_name = :table AND grantee = 'reward_app'
      ORDER BY privilege_type`,
    { table: TABLE },
  );
  return rows.map((row) => row.privilege_type);
}

beforeAll(async () => {
  db = createMigrationConnection();
  await db.authenticate();
  // Self-contained rather than dependent on whether `npm run db:migrate` has run on this
  // machine yet: the suite's subject is `up()`/`down()` themselves, so it establishes its own
  // starting state instead of asserting somebody else's.
  wasApplied = await tableExists();
  if (!wasApplied) await migration.up({ context: db });
}, 60_000);

afterAll(async () => {
  if (db !== undefined) {
    // Restore the state this suite found — which is NOT unconditionally "applied".
    //
    // The umzug meta table is the migration runner's record of what has run, and this suite never
    // writes to it. On a database where `npm run db:migrate` has not yet applied `T171_001`,
    // leaving the table behind would desynchronise the two: `db:status` would still report the
    // migration as pending while its table already existed, and the next `db:migrate` would die on
    // `CREATE TABLE ... already exists`. Restoring the starting state keeps this suite runnable
    // both before and after the migration is formally applied, and leaves neither case broken.
    const applied = await tableExists();
    if (wasApplied && !applied) await migration.up({ context: db });
    if (!wasApplied && applied) await migration.down({ context: db });
    await db.close();
  }
});

describe('T-171 — T171_001_activity_external_codes', () => {
  it('TC-1 — round-trips: the table is present, absent, then present again', async () => {
    // Starting state is "applied" (npm run db:migrate has run). Prove down() first, so a failure
    // to drop cannot be hidden by a re-create that happens to work.
    expect(await tableExists()).toBe(true);

    await migration.down({ context: db });
    expect(await tableExists()).toBe(false);

    await migration.up({ context: db });
    expect(await tableExists()).toBe(true);

    // And again, to prove down() is repeatable rather than accidentally working once.
    await migration.down({ context: db });
    await migration.up({ context: db });
    expect(await tableExists()).toBe(true);
  }, 60_000);

  it('creates both indexes, with uniqueness on (tenant_id, external_code)', async () => {
    expect(await indexNames()).toEqual(
      expect.arrayContaining(['uc_activity_external_codes', 'ix_activity_external_codes_activity']),
    );

    // The columns of the unique index are asserted from the catalogue, not from the migration
    // text: a unique index on `external_code` alone would break multi-tenancy (see the migration
    // header), and this is the only place that claim is checked against what Postgres actually
    // built.
    const [unique] = await sql<{ definition: string }>(
      `SELECT indexdef AS definition FROM pg_indexes
        WHERE schemaname = 'reward_portal' AND indexname = 'uc_activity_external_codes'`,
    );
    expect(unique.definition).toMatch(/UNIQUE INDEX/);
    expect(unique.definition).toMatch(/\(tenant_id, external_code\)/);
  });

  it('grants reward_app the four DML verbs and revokes TRUNCATE', async () => {
    const privileges = await grants();

    expect(privileges).toEqual(expect.arrayContaining(['SELECT', 'INSERT', 'UPDATE', 'DELETE']));
    // The load-bearing assertion. `T002_008_grants` left
    // `ALTER DEFAULT PRIVILEGES IN SCHEMA reward_portal GRANT ALL ON TABLES TO reward_app` in
    // place, so a new table here arrives with *every* privilege — TRUNCATE included — whether the
    // migration asks for it or not. The explicit REVOKE is therefore the only thing standing
    // between the application role and `TRUNCATE reward_portal.activity_external_codes`, which is
    // the privilege class T-080 was filed about. `REFERENCES`/`TRIGGER` also arrive from that
    // schema default and are left as they are on every other reward_portal table; neither can
    // read or change a row.
    expect(privileges).not.toContain('TRUNCATE');
  });

  it('has the column shape the model declares', async () => {
    const columns = await sql<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'reward_portal' AND table_name = :table
        ORDER BY ordinal_position`,
      { table: TABLE },
    );

    expect(columns).toEqual([
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'tenant_id', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'activity_id', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'external_code', data_type: 'character varying', is_nullable: 'NO' },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
    ]);
  });

  it('adds no foreign key to reward_config — the references are by value (R1)', async () => {
    const rows = await sql<{ constraint_name: string }>(
      `SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_schema = 'reward_portal' AND table_name = :table
          AND constraint_type = 'FOREIGN KEY'`,
      { table: TABLE },
    );

    expect(rows).toEqual([]);
  });

  it('leaves reward_config.activities untouched (R1 — no new DDL there)', async () => {
    const rows = await sql<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'reward_config' AND table_name = 'activities'
          AND column_name IN ('external_code', 'external_codes', 'transaction_type')`,
    );

    expect(rows).toEqual([]);
  });

  it('generates a uuid primary key without the application supplying one', async () => {
    const [tenant] = await sql<{ id: number }>(
      'SELECT id FROM reward_config.tenants ORDER BY id LIMIT 1',
    );
    const [activity] = await sql<{ id: number }>(
      'SELECT id FROM reward_config.activities ORDER BY id LIMIT 1',
    );
    const code = 'T171MIGSPEC_DEFAULTS';

    const [inserted] = await sql<{ id: string; created_at: Date; updated_at: Date }>(
      `INSERT INTO reward_portal.activity_external_codes (tenant_id, activity_id, external_code)
       VALUES (:tenantId, :activityId, :code)
       RETURNING id, created_at, updated_at`,
      { tenantId: tenant.id, activityId: activity.id, code },
    );

    expect(inserted.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserted.created_at).toBeInstanceOf(Date);
    expect(inserted.updated_at).toBeInstanceOf(Date);

    await db.query(
      `DELETE FROM reward_portal.activity_external_codes WHERE external_code = :code`,
      { type: QueryTypes.RAW, replacements: { code } },
    );
  });
});
