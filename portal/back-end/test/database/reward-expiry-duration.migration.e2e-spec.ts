/**
 * T-173 — AGENT-PROTOCOL R7 for this task's two migrations ("every migration has a working
 * `down()`, proven by migrate → rollback → migrate on a clean DB"), plus TC-1, TC-4, TC-5 and TC-6.
 *
 * ### Why `up()`/`down()` are called directly rather than through the CLI
 *
 * The same two mechanical reasons `activity-external-codes.migration.e2e-spec.ts` (T-171) and
 * `t165`'s spec document:
 *
 *  1. `npm run db:rollback` with no `--all` reverts the **last** migration in name order, which on
 *     this database is `T900_004_seed_demo_activity_rules` — not either of these. Running it would
 *     delete the shared dev deployment's demo data and still prove nothing about `T173_001`.
 *  2. `npm run db:rollback -- --all` is blocked on this database by an earlier crypto migration
 *     whose own `down()` is irreversible.
 *
 * So the round trip is driven here, against the real Postgres, over exactly the two files this task
 * owns, and nothing else on the shared database is disturbed.
 *
 * ### Order matters, and that is itself part of what is being proven
 *
 * `T173_002`'s trigger body references `NEW.expiry_value`. Dropping the columns underneath it would
 * make *every* UPDATE on `reward_versions` fail, not just one touching expiry — so `down()` runs
 * 002 before 001 and `up()` runs 001 before 002, which is what the task file's Rollback section
 * means by "in reverse order". The test asserts that ordering works rather than assuming it.
 *
 * ### Deviation from this task's own "Files owned" filename (flagged per AGENT-PROTOCOL §3)
 *
 * T-173 names this spec `test/database/reward-expiry-duration.migration.spec.ts`. That exact name
 * runs under neither Jest config: `jest.config.js`'s `roots` do not include `test/database` (so
 * `npm test` never sees it), and `test/jest-e2e.json`'s `testRegex` is `.e2e-spec.ts$` (so
 * `npm run test:e2e` doesn't either). Every other migration-behaviour suite here (`t119`, `t126`,
 * `t165`, `activity-external-codes`, ...) is named `*.e2e-spec.ts` for that reason. Same directory,
 * same base name, the suffix that actually runs — a test nobody executes would satisfy R10 only on
 * paper.
 *
 * ### Fixtures
 *
 * A throwaway `reward_systems` row (`ZT173_*`) plus its own versions, never a pre-existing reward:
 * `uq_rewv_one_draft` allows exactly one draft per reward, so borrowing a real one would make this
 * suite fight whatever else is mid-authoring on the shared dev database. Teardown temporarily
 * disables `trg_reward_versions_undeletable` for the same reason, and with the same justification,
 * that T-005's and T-119's suites do.
 */
import 'reflect-metadata';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { createMigrationConnection } from '@/database/migration-connection';
import * as columns from '@/database/migrations/T173_001_reward_expiry_duration';
import * as trigger from '@/database/migrations/T173_002_extend_reward_version_immutability';

let db: Sequelize;
/** Whether the two migrations were already applied when this suite started. See `afterAll`. */
let wasApplied: boolean;
let rewardSystemId: number;
const versionIds: number[] = [];

async function sql<T extends object>(
  text: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return db.query<T>(text, { type: QueryTypes.SELECT, replacements });
}

async function exec(text: string, replacements: Record<string, unknown> = {}): Promise<void> {
  await db.query(text, { type: QueryTypes.RAW, replacements });
}

async function expiryColumns(): Promise<
  { column_name: string; data_type: string; is_nullable: string; max_length: number | null }[]
> {
  return sql(
    `SELECT column_name, data_type, is_nullable,
            character_maximum_length AS max_length
       FROM information_schema.columns
      WHERE table_schema = 'reward_config' AND table_name = 'reward_versions'
        AND column_name IN ('expiry_value','expiry_unit')
      ORDER BY column_name`,
  );
}

async function columnsExist(): Promise<boolean> {
  return (await expiryColumns()).length === 2;
}

async function checkConstraints(): Promise<string[]> {
  const rows = await sql<{ conname: string }>(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'reward_config.reward_versions'::regclass
        AND contype = 'c' AND conname LIKE 'ck_rewv_expiry%'
      ORDER BY conname`,
  );
  return rows.map((row) => row.conname);
}

/** The live body of the immutability trigger function, straight out of the catalogue. */
async function triggerBody(): Promise<string> {
  const [row] = await sql<{ definition: string }>(
    `SELECT pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'reward_config' AND p.proname = 'fn_reward_version_immutable'`,
  );
  return row.definition;
}

/**
 * The Postgres constraint an insert actually violated, or `null` if it succeeded.
 *
 * Asserting on the rendered message would pass just as happily if a *different* constraint had
 * fired. The driver keeps the real constraint name on the wrapped error, and that is what the
 * assertions below read.
 */
async function constraintViolatedBy(
  text: string,
  replacements: Record<string, unknown> = {},
): Promise<string | null> {
  try {
    await exec(text, replacements);
    return null;
  } catch (err) {
    return (err as { parent?: { constraint?: string } }).parent?.constraint ?? null;
  }
}

/** Inserts a `draft` version of the throwaway reward and returns its id. */
async function insertDraft(
  versionNo: number,
  expiry: { value: number | null; unit: string | null },
): Promise<number> {
  const [row] = await sql<{ id: number }>(
    `INSERT INTO reward_config.reward_versions
       (reward_id, version_no, status, created_by, expiry_value, expiry_unit)
     VALUES (:rewardId, :versionNo, 'draft', 1, :value, :unit)
     RETURNING id`,
    { rewardId: rewardSystemId, versionNo, value: expiry.value, unit: expiry.unit },
  );
  versionIds.push(row.id);
  return row.id;
}

async function publish(versionId: number): Promise<void> {
  await exec(
    `UPDATE reward_config.reward_versions
        SET status = 'published', published_at = now(), published_by = 1
      WHERE id = :id`,
    { id: versionId },
  );
}

beforeAll(async () => {
  db = createMigrationConnection();
  await db.authenticate();
  // Self-contained rather than dependent on whether `npm run db:migrate` has run on this machine
  // yet: the suite's subject is `up()`/`down()` themselves, so it establishes its own starting
  // state instead of asserting somebody else's.
  wasApplied = await columnsExist();
  if (!wasApplied) {
    await columns.up({ context: db });
    await trigger.up({ context: db });
  }

  const [system] = await sql<{ id: number }>(
    `INSERT INTO reward_config.reward_systems
       (tenant_id, system_code, name, reward_type, connector_type)
     VALUES ((SELECT id FROM reward_config.tenants ORDER BY id LIMIT 1),
             'ZT173_EXPIRY_FIXTURE', 'ZT173 expiry fixture', 'cashback', 'internal_api')
     RETURNING id`,
  );
  rewardSystemId = system.id;
}, 60_000);

afterAll(async () => {
  if (db === undefined) return;
  // Superuser-only teardown — a published version is undeletable by design, and every assertion
  // has already run by this point. See this file's own doc comment, and T-119's.
  await exec(
    `ALTER TABLE reward_config.reward_versions DISABLE TRIGGER trg_reward_versions_undeletable`,
  );
  try {
    if (versionIds.length > 0) {
      await exec(`DELETE FROM reward_config.reward_versions WHERE id IN (:ids)`, {
        ids: versionIds,
      });
    }
    await exec(`DELETE FROM reward_config.reward_systems WHERE id = :id`, { id: rewardSystemId });
  } finally {
    await exec(
      `ALTER TABLE reward_config.reward_versions ENABLE TRIGGER trg_reward_versions_undeletable`,
    );
  }

  // Restore the state this suite found — which is NOT unconditionally "applied". The umzug meta
  // table is the runner's record of what has run and this suite never writes to it; leaving the
  // columns behind on a database where `db:migrate` has not applied T173_001 would desynchronise
  // the two and make the next `db:migrate` die on "column already exists".
  const applied = await columnsExist();
  if (wasApplied && !applied) {
    await columns.up({ context: db });
    await trigger.up({ context: db });
  }
  if (!wasApplied && applied) {
    await trigger.down({ context: db });
    await columns.down({ context: db });
  }
  await db.close();
});

describe('T-173 — T173_001_reward_expiry_duration', () => {
  it('TC-1 — round-trips: the columns are present, absent, then present again', async () => {
    // Starting state is "applied". Prove down() first, so a failure to drop cannot be hidden by a
    // re-create that happens to work. 002 comes off first and goes back on last — see the header.
    expect(await columnsExist()).toBe(true);

    await trigger.down({ context: db });
    await columns.down({ context: db });
    expect(await columnsExist()).toBe(false);
    expect(await checkConstraints()).toEqual([]);

    await columns.up({ context: db });
    await trigger.up({ context: db });
    expect(await columnsExist()).toBe(true);

    // And again, to prove down() is repeatable rather than accidentally working once.
    await trigger.down({ context: db });
    await columns.down({ context: db });
    await columns.up({ context: db });
    await trigger.up({ context: db });
    expect(await columnsExist()).toBe(true);
  }, 60_000);

  it('adds expiry_value int NULL and expiry_unit varchar(10) NULL', async () => {
    expect(await expiryColumns()).toEqual([
      {
        column_name: 'expiry_unit',
        data_type: 'character varying',
        is_nullable: 'YES',
        max_length: 10,
      },
      { column_name: 'expiry_value', data_type: 'integer', is_nullable: 'YES', max_length: null },
    ]);
  });

  it('creates all three CHECK constraints', async () => {
    expect(await checkConstraints()).toEqual([
      'ck_rewv_expiry_pair',
      'ck_rewv_expiry_positive',
      'ck_rewv_expiry_unit',
    ]);
  });

  it('accepts a NULL pair — "never expires" is a legitimate, and the default, state', async () => {
    // The reading the migration header insists on: an existing row that predates this migration is
    // not misconfigured. If this were rejected, every legacy reward would be unwritable.
    const id = await insertDraft(1, { value: null, unit: null });
    const [stored] = await sql<{ expiry_value: number | null; expiry_unit: string | null }>(
      `SELECT expiry_value, expiry_unit FROM reward_config.reward_versions WHERE id = :id`,
      { id },
    );

    expect(stored).toEqual({ expiry_value: null, expiry_unit: null });
    await publish(id);
  });

  it('accepts each of the three units', async () => {
    for (const [index, unit] of ['minutes', 'hours', 'days'].entries()) {
      // One draft per reward (`uq_rewv_one_draft`) — publish each before the next is inserted.
      const id = await insertDraft(10 + index, { value: 15, unit });
      await publish(id);
    }

    const [{ count }] = await sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_config.reward_versions
        WHERE reward_id = :id AND expiry_unit IS NOT NULL`,
      { id: rewardSystemId },
    );
    expect(count).toBe('3');
  });

  it('TC-4 — a value with no unit is rejected by ck_rewv_expiry_pair', async () => {
    expect(
      await constraintViolatedBy(
        `INSERT INTO reward_config.reward_versions
           (reward_id, version_no, status, created_by, expiry_value)
         VALUES (:id, 20, 'draft', 1, 15)`,
        { id: rewardSystemId },
      ),
    ).toBe('ck_rewv_expiry_pair');
  });

  it('TC-4 — a unit with no value is rejected by the same constraint', async () => {
    expect(
      await constraintViolatedBy(
        `INSERT INTO reward_config.reward_versions
           (reward_id, version_no, status, created_by, expiry_unit)
         VALUES (:id, 21, 'draft', 1, 'days')`,
        { id: rewardSystemId },
      ),
    ).toBe('ck_rewv_expiry_pair');
  });

  it('TC-4 — an UPDATE cannot split the pair either', async () => {
    // The INSERT path is not the only way in: a direct UPDATE that clears one half would leave the
    // same meaningless half-state, and only the constraint (not any service) stops it.
    const id = await insertDraft(22, { value: 7, unit: 'days' });

    expect(
      await constraintViolatedBy(
        `UPDATE reward_config.reward_versions SET expiry_unit = NULL WHERE id = :id`,
        { id },
      ),
    ).toBe('ck_rewv_expiry_pair');
    await publish(id);
  });

  it('TC-5 — a unit outside minutes|hours|days is rejected by ck_rewv_expiry_unit', async () => {
    expect(
      await constraintViolatedBy(
        `INSERT INTO reward_config.reward_versions
           (reward_id, version_no, status, created_by, expiry_value, expiry_unit)
         VALUES (:id, 23, 'draft', 1, 3, 'weeks')`,
        { id: rewardSystemId },
      ),
    ).toBe('ck_rewv_expiry_unit');
  });

  it('up() surfaces a failure and rolls its transaction back rather than half-applying', async () => {
    // Re-running `up()` against a database that already has the columns is the cheapest real
    // failure this migration can be given. What matters is not the message but that the
    // transaction is rolled back: a migration that left an aborted transaction open would make
    // every later statement on this connection fail with "current transaction is aborted", which
    // is exactly the state that turns one bad migration into an unusable session.
    await expect(columns.up({ context: db })).rejects.toThrow(/already exists/);

    expect(await columnsExist()).toBe(true);
    expect(await checkConstraints()).toEqual([
      'ck_rewv_expiry_pair',
      'ck_rewv_expiry_positive',
      'ck_rewv_expiry_unit',
    ]);
  });

  it('down() rolls back and rethrows when the ALTER fails', async () => {
    // The `down()` half of the same property. It cannot be provoked against the real database —
    // every clause is `IF EXISTS`, which is deliberate — so the failure is injected through a
    // stand-in context. Asserting `rollback` was called (and `commit` was not) is the observable
    // property; the error merely has to reach the caller instead of being swallowed.
    const rollback = jest.fn(async () => undefined);
    const commit = jest.fn(async () => undefined);
    const failing = {
      transaction: async () => ({ commit, rollback }),
      query: async () => {
        throw new Error('injected ALTER failure');
      },
    } as unknown as Sequelize;

    await expect(columns.down({ context: failing })).rejects.toThrow('injected ALTER failure');
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('rejects a zero or negative duration (ck_rewv_expiry_positive)', async () => {
    // `NULL` is how "no expiry" is said; `0` would be "already expired when granted", which is
    // never a thing a maker means. Both directions asserted, because a `>= 0` typo would pass one.
    expect(
      await constraintViolatedBy(
        `INSERT INTO reward_config.reward_versions
           (reward_id, version_no, status, created_by, expiry_value, expiry_unit)
         VALUES (:id, 24, 'draft', 1, 0, 'days')`,
        { id: rewardSystemId },
      ),
    ).toBe('ck_rewv_expiry_positive');
    expect(
      await constraintViolatedBy(
        `INSERT INTO reward_config.reward_versions
           (reward_id, version_no, status, created_by, expiry_value, expiry_unit)
         VALUES (:id, 25, 'draft', 1, -5, 'days')`,
        { id: rewardSystemId },
      ),
    ).toBe('ck_rewv_expiry_positive');
  });
});

describe('T-173 — T173_002_extend_reward_version_immutability', () => {
  it('TC-6 — a published version’s expiry_value cannot be changed', async () => {
    const id = await insertDraft(30, { value: 30, unit: 'days' });
    await publish(id);

    await expect(
      exec(`UPDATE reward_config.reward_versions SET expiry_value = 1 WHERE id = :id`, { id }),
    ).rejects.toThrow(/is published and immutable/);

    const [after] = await sql<{ expiry_value: number }>(
      `SELECT expiry_value FROM reward_config.reward_versions WHERE id = :id`,
      { id },
    );
    expect(after.expiry_value).toBe(30);
  });

  it('TC-6 — a published version’s expiry_unit cannot be changed', async () => {
    const id = await insertDraft(31, { value: 30, unit: 'days' });
    await publish(id);

    await expect(
      exec(`UPDATE reward_config.reward_versions SET expiry_unit = 'minutes' WHERE id = :id`, {
        id,
      }),
    ).rejects.toThrow(/is published and immutable/);
  });

  it('TC-6 — an expiry cannot be REMOVED from a published version either', async () => {
    // The failure mode this is really about: not shortening an expiry but silently deleting the
    // promise. Clearing both halves passes `ck_rewv_expiry_pair`, so only the trigger stops it.
    const id = await insertDraft(32, { value: 30, unit: 'days' });
    await publish(id);

    await expect(
      exec(
        `UPDATE reward_config.reward_versions
            SET expiry_value = NULL, expiry_unit = NULL WHERE id = :id`,
        { id },
      ),
    ).rejects.toThrow(/is published and immutable/);
  });

  it('an expiry cannot be ADDED to a published version that never had one', async () => {
    const id = await insertDraft(33, { value: null, unit: null });
    await publish(id);

    await expect(
      exec(
        `UPDATE reward_config.reward_versions
            SET expiry_value = 5, expiry_unit = 'minutes' WHERE id = :id`,
        { id },
      ),
    ).rejects.toThrow(/is published and immutable/);
  });

  it('still freezes everything T119_002 froze — reward_kind on a published row', async () => {
    // The regression this task's `down()` is written to avoid in reverse: extending the function
    // must not drop another task's columns out of the frozen set.
    const id = await insertDraft(34, { value: 5, unit: 'hours' });
    await exec(`UPDATE reward_config.reward_versions SET reward_kind = 'POINTS' WHERE id = :id`, {
      id,
    });
    await publish(id);

    await expect(
      exec(`UPDATE reward_config.reward_versions SET reward_kind = 'PERCENTAGE' WHERE id = :id`, {
        id,
      }),
    ).rejects.toThrow(/is published and immutable/);
    await expect(
      exec(`UPDATE reward_config.reward_versions SET connector_config = '{"x":1}' WHERE id = :id`, {
        id,
      }),
    ).rejects.toThrow(/is published and immutable/);
  });

  it('leaves a draft freely editable, and still allows the lifecycle to move forward', async () => {
    const id = await insertDraft(35, { value: 5, unit: 'minutes' });

    await exec(
      `UPDATE reward_config.reward_versions
          SET expiry_value = 90, expiry_unit = 'days' WHERE id = :id`,
      { id },
    );
    const [edited] = await sql<{ expiry_value: number; expiry_unit: string }>(
      `SELECT expiry_value, expiry_unit FROM reward_config.reward_versions WHERE id = :id`,
      { id },
    );
    expect(edited).toEqual({ expiry_value: 90, expiry_unit: 'days' });

    // `status` itself may still move along the lifecycle once published (T-005's TC-8).
    await publish(id);
    await exec(
      `UPDATE reward_config.reward_versions
          SET status = 'deprecated', deprecated_at = now() WHERE id = :id`,
      { id },
    );
    const [deprecated] = await sql<{ status: string }>(
      `SELECT status FROM reward_config.reward_versions WHERE id = :id`,
      { id },
    );
    expect(deprecated.status).toBe('deprecated');
  });

  it('down() restores T119_002’s body, not T005_007’s — reward_kind stays frozen', async () => {
    // Asserted against the live catalogue rather than the migration text: rolling this task back
    // must not silently un-freeze T-119's two columns, and the only place that is observable is
    // the function Postgres is actually running.
    await trigger.down({ context: db });
    const rolledBack = await triggerBody();
    expect(rolledBack).toContain('reward_kind');
    expect(rolledBack).toContain('value_config');
    expect(rolledBack).not.toContain('expiry_value');

    await trigger.up({ context: db });
    const reapplied = await triggerBody();
    expect(reapplied).toContain('expiry_value');
    expect(reapplied).toContain('expiry_unit');
    expect(reapplied).toContain('reward_kind');
  });
});
