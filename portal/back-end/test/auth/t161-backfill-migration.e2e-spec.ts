/**
 * T-161 TC-5 — the backfill migration, against a table that is **not** empty.
 *
 * The `migrate → rollback → migrate` round trip proves the migration applies and reverses, but on
 * this database it runs over rows that happen to be fine and therefore proves nothing about the
 * predicate, which is the whole migration. The risk here is entirely one of *aim*: too narrow and
 * already-broken accounts stay locked in the forced-change loop; too wide and it disarms a
 * forced password change that is still legitimately pending — a security control, cleared by a
 * data migration, silently.
 *
 * So this suite drives `up()` and `down()` directly, as functions, around four rows chosen to sit
 * on both sides of that line:
 *
 *  | Row | `password_expires_at` | `password_updated_at` | Expected |
 *  |-----|-----------------------|------------------------|----------|
 *  | stuck    | past   | **after** the expiry | cleared — already changed, can only re-prompt |
 *  | expired-unused | past | before the expiry | **kept** — issued, never changed, still pending |
 *  | pending  | future | before the expiry    | **kept** — inside its 72-hour window |
 *  | ordinary | NULL   | any                  | untouched |
 *
 * The `expired-unused` row is the one that matters most: it is past its deadline *and* must still
 * force a change, so it is the row a careless `WHERE password_expires_at < now()` would wrongly
 * clear. Its presence is what makes this suite able to fail.
 */
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { randomBytes } from 'node:crypto';
import { up, down } from '@/database/migrations/T161_001_backfill_stuck_password_expiry';
// The migration connection, not the app one — migrations run as the migration role in production,
// so that is the role this must be proven under. See `t056-backfill.e2e-spec.ts`'s own note.
import { createMigrationConnection } from '@/database/migration-connection';

jest.setTimeout(300_000);

const DISPLAY_NAME = 'T-161 backfill probe';

type RowName = 'stuck' | 'expired-unused' | 'pending' | 'ordinary';

let db: Sequelize;
const userIds = new Map<RowName, number>();

async function removeProbeUsers(): Promise<void> {
  // `portal_user_credentials` cascades from the user row.
  await db.query(`DELETE FROM reward_portal.portal_users WHERE display_name = :displayName`, {
    type: QueryTypes.DELETE,
    replacements: { displayName: DISPLAY_NAME },
  });
}

/**
 * A `super_admin` row, because that is the one role whose check constraint
 * (`ck_portal_users_scope`) is satisfied with every scope column NULL — no country, tenant or
 * merchant fixture needed. These rows are never authenticated against; only their credential row
 * is read, so the email columns just have to be unique and non-null.
 */
async function insertProbeUser(): Promise<number> {
  const unique = randomBytes(12).toString('hex');
  const [created] = await db.query<{ id: number }>(
    `INSERT INTO reward_portal.portal_users
            (email, email_bidx, display_name, role, status, must_change_password)
     VALUES (:email, :bidx, :displayName, 'super_admin', 'active', false)
     RETURNING id`,
    {
      type: QueryTypes.SELECT,
      replacements: {
        email: `t161-backfill-${unique}@example.invalid`,
        bidx: unique.padEnd(64, '0'),
        displayName: DISPLAY_NAME,
      },
    },
  );
  return created.id;
}

/**
 * Writes a credential row with the two timestamps set to explicit offsets from now, in hours.
 * `null` for `expiresAtHours` means "this account never had a temporary password".
 */
async function insertCredential(
  userId: number,
  expiresAtHours: number | null,
  updatedAtHours: number,
): Promise<void> {
  await db.query(
    `INSERT INTO reward_portal.portal_user_credentials
            (user_id, password_hash, password_algo, password_expires_at,
             password_updated_at, created_at, updated_at)
     VALUES (:userId, '$argon2id$probe', 'argon2id',
             CASE WHEN CAST(:expiresAtHours AS double precision) IS NULL THEN NULL
                  ELSE now() + make_interval(secs => CAST(:expiresAtHours AS double precision) * 3600)
             END,
             now() + make_interval(secs => CAST(:updatedAtHours AS double precision) * 3600),
             now(), now())`,
    { type: QueryTypes.INSERT, replacements: { userId, expiresAtHours, updatedAtHours } },
  );
}

async function expiryOf(name: RowName): Promise<Date | null> {
  const [row] = await db.query<{ password_expires_at: Date | null }>(
    `SELECT password_expires_at FROM reward_portal.portal_user_credentials WHERE user_id = :userId`,
    { type: QueryTypes.SELECT, replacements: { userId: userIds.get(name) } },
  );
  if (row === undefined) throw new Error(`no credential row for ${name}`);
  return row.password_expires_at;
}

/** Rebuilds all four probe rows in their pre-migration state. */
async function seedProbeRows(): Promise<void> {
  await removeProbeUsers();
  userIds.clear();

  for (const name of ['stuck', 'expired-unused', 'pending', 'ordinary'] as const) {
    userIds.set(name, await insertProbeUser());
  }

  // Changed 1h ago, against a deadline that elapsed 48h ago — permanently stuck.
  await insertCredential(userIds.get('stuck')!, -48, -1);
  // Issued 72h ago with a 72h window that elapsed 1h ago, never changed since.
  await insertCredential(userIds.get('expired-unused')!, -1, -72);
  // Issued 1h ago, 71h left on the clock.
  await insertCredential(userIds.get('pending')!, 71, -1);
  // Never had a temporary password.
  await insertCredential(userIds.get('ordinary')!, null, -1);
}

beforeAll(async () => {
  db = createMigrationConnection();
  await db.authenticate();
});

afterAll(async () => {
  if (db !== undefined) {
    await removeProbeUsers();
    await db.close();
  }
});

beforeEach(seedProbeRows);

describe('TC-5 — the backfill clears exactly the stuck rows', () => {
  it('clears a row whose password was changed after its expiry elapsed', async () => {
    expect(await expiryOf('stuck')).not.toBeNull();

    await up({ context: db });

    expect(await expiryOf('stuck')).toBeNull();
  });

  it('leaves an elapsed-but-never-changed credential armed', async () => {
    // The row a `WHERE password_expires_at < now()` predicate would wrongly clear. This account
    // was issued a temporary password, never used it, and must still be forced to change.
    const before = await expiryOf('expired-unused');
    expect(before).not.toBeNull();

    await up({ context: db });

    expect(await expiryOf('expired-unused')).toEqual(before);
  });

  it('leaves a credential still inside its window armed', async () => {
    const before = await expiryOf('pending');

    await up({ context: db });

    expect(await expiryOf('pending')).toEqual(before);
  });

  it('leaves a credential that never had an expiry alone', async () => {
    await up({ context: db });

    expect(await expiryOf('ordinary')).toBeNull();
  });
});

describe('re-running the migration', () => {
  it('is idempotent — a second pass matches nothing and changes nothing', async () => {
    await up({ context: db });

    const after = {
      stuck: await expiryOf('stuck'),
      expiredUnused: await expiryOf('expired-unused'),
      pending: await expiryOf('pending'),
    };

    await up({ context: db });

    expect(await expiryOf('stuck')).toEqual(after.stuck);
    expect(await expiryOf('expired-unused')).toEqual(after.expiredUnused);
    expect(await expiryOf('pending')).toEqual(after.pending);
  });

  it('down() is a no-op that leaves the corrected data corrected', async () => {
    await up({ context: db });
    const cleared = await expiryOf('stuck');
    const kept = await expiryOf('expired-unused');

    await down({ context: db });

    // Documented in the migration: the old values are not restorable, and restoring them would
    // only re-create the defect on the accounts it hurt.
    expect(await expiryOf('stuck')).toEqual(cleared);
    expect(await expiryOf('expired-unused')).toEqual(kept);
  });
});
