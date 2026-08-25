/**
 * T-056 TC-8 — the migration's backfill, against a table that is **not** empty.
 *
 * The plain `migrate → rollback → migrate` round trip proves the DDL reverses cleanly, but on a
 * fresh database it runs over zero rows and therefore proves nothing about the part of this
 * migration that touches data. The task file is explicit that *"the migration must not assume the
 * table is empty"*, and the backfill is the riskiest code in it: it rewrites a column every login
 * depends on, one row at a time, binding each ciphertext to its own primary key.
 *
 * So this suite drives `up()` and `down()` directly, as functions, around real rows:
 *
 *  - a live user, an already-encrypted user (the idempotency case, which a re-run after a partial
 *    failure hits), and a **soft-deleted** user, which must be encrypted too — the policy is a
 *    property of the column, not of the live subset;
 *  - `down()` must put the plaintext back, or a rollback silently destroys every address.
 *
 * The suite leaves the schema migrated, whatever happens, so a failure here cannot strand the
 * database for the next suite.
 */
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { randomBytes } from 'node:crypto';
import {
  BlindIndexService,
  EnvKeyMaterialResolver,
  FieldCryptoService,
  KeyRegistryService,
  looksLikeCiphertext,
  UnconfiguredKmsResolver,
} from '@/common/crypto';
import { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import { dataProtectionConfigFactory } from '@/common/data-protection/data-protection.config';
import { up, down } from '@/database/migrations/T056_001_portal_users_email_blind_index';
// The **migration** connection, not the app one: `up()`/`down()` issue DDL (`ALTER TABLE`,
// `DROP INDEX`), and `reward_app` deliberately has no DDL rights on `reward_portal` — the same
// split `migration-connection.ts` exists to enforce. Running these as the app role fails on the
// first `DROP INDEX`, which is the correct outcome and not what this suite is testing.
import { createMigrationConnection } from '@/database/migration-connection';
import { sweepOrphanedTestKeys } from '../support/encryption-keys';
// T-070 — the precondition this suite needs before it may roll the whole table. See that file's
// header for why "no foreign rows at all" was the wrong shape for it.
import {
  classifyForeignRow,
  preflightForeignRows,
  type ForeignRow,
  type ForeignRowCheck,
} from './support/portal-users-preflight';

jest.setTimeout(300_000);

const KEY_PREFIX = 't056_backfill_';
const FIELD_KID = `${KEY_PREFIX}fld`;
const BLIND_KID = `${KEY_PREFIX}bidx`;
const FIELD_ENV = 'T056_BACKFILL_FIELD_KEY';
const BLIND_ENV = 'T056_BACKFILL_BLIND_KEY';

const DISPLAY_NAME = 'T-056 backfill probe';
const LIVE_EMAIL = 'Backfill.Live@Example.invalid';
const DELETED_EMAIL = 'backfill.deleted@example.invalid';

let db: Sequelize;

async function removeProbeUsers(): Promise<void> {
  await db.query(`DELETE FROM reward_portal.portal_users WHERE display_name = :displayName`, {
    type: QueryTypes.DELETE,
    replacements: { displayName: DISPLAY_NAME },
  });
}

/**
 * The probe rows in the **migrated** shape, read raw so no hook can decrypt anything on the way out.
 */
async function readProbes(): Promise<{ id: number; email: string; email_bidx: string | null }[]> {
  return db.query(
    `SELECT id, email, email_bidx FROM reward_portal.portal_users
      WHERE display_name = :displayName ORDER BY id`,
    { type: QueryTypes.SELECT, replacements: { displayName: DISPLAY_NAME } },
  );
}

/**
 * The same rows in the **rolled-back** shape. A separate query because `down()` drops `email_bidx`
 * entirely, so selecting it after a rollback is a SQL error rather than a null.
 */
async function readProbesWithoutIndex(): Promise<{ id: number; email: string }[]> {
  return db.query(
    `SELECT id, email FROM reward_portal.portal_users
      WHERE display_name = :displayName ORDER BY id`,
    { type: QueryTypes.SELECT, replacements: { displayName: DISPLAY_NAME } },
  );
}

/**
 * T-070 — every row this suite did **not** create, read raw.
 *
 * These are rows the round trip unavoidably takes with it (`up()`/`down()` name
 * `reward_portal.portal_users` literally, so there is no scratch-table seam), which is why they
 * are checked before and verified after. `email_bidx` is not selected: this is also called while
 * the schema is rolled back, when that column does not exist.
 */
async function readForeignRows(): Promise<ForeignRow[]> {
  return db.query(
    `SELECT id, email FROM reward_portal.portal_users
      WHERE display_name <> :displayName ORDER BY id`,
    { type: QueryTypes.SELECT, replacements: { displayName: DISPLAY_NAME } },
  );
}

/**
 * The same crypto the migration builds for itself, so the preflight judges a row by exactly the
 * standard `T056_001.down()` will hold it to.
 *
 * `buildCrypto` is private to the migration and deliberately left that way — exporting a helper
 * from a migration so a test can call it makes the test's opinion part of the production surface.
 * The wiring is short enough to restate, and if it ever drifts the preflight simply becomes
 * stricter or looser than `down()`, which the round trip below would catch.
 */
async function buildEmailCrypto(): Promise<PortalUserEmailCrypto> {
  const registry = new KeyRegistryService(db, [
    new EnvKeyMaterialResolver(),
    new UnconfiguredKmsResolver(),
  ]);
  await registry.load();

  return new PortalUserEmailCrypto(
    new FieldCryptoService(registry),
    new BlindIndexService(registry),
    dataProtectionConfigFactory().atRest.bindRecordIdAsAAD,
  );
}

/**
 * T-070 — proves the round trip gave every foreign row back exactly as it found it.
 *
 * This is the assertion the old `expect(foreign).toBe(0)` guard was standing in for. Counting rows
 * asserted that the suite could not harm anyone else's data because there was nobody else's data;
 * this asserts the property directly, with the data present.
 *
 * Addresses are compared as blind indexes, not plaintext. The index is a pure function of the
 * address under the active `blind_index` key, so within one process two indexes match exactly when
 * the addresses do — and a diff printed by a failing `expect` cannot spill somebody's email into
 * the test log. Ciphertext could not be compared at all: the IV is random, so a re-encrypted row
 * differs byte-for-byte from the one that went in even when nothing was lost.
 *
 * The check is deliberately one-directional — *every row that was here is still here, unchanged* —
 * rather than a set comparison against the rows read at the start. A row that **appeared** during
 * the run is not evidence of damage: this database is shared, and another agent's suite creating
 * its own fixture mid-run is normal (observed while building this: `t004-seeds-bootstrap`'s
 * super-admin row was recreated with a new id between two runs of this suite). Asserting the ids
 * match exactly would turn that into a red suite for a healthy system, which is the same class of
 * mistake as the guard being fixed here.
 */
async function expectForeignRowsUnharmed(
  before: readonly ForeignRowCheck[],
  crypto: PortalUserEmailCrypto,
): Promise<void> {
  const rows = await db.query<{ id: number; email: string; email_bidx: string | null }>(
    `SELECT id, email, email_bidx FROM reward_portal.portal_users
      WHERE display_name <> :displayName ORDER BY id`,
    { type: QueryTypes.SELECT, replacements: { displayName: DISPLAY_NAME } },
  );
  const after = new Map(
    rows.map((row) => [row.id, { row, check: classifyForeignRow(row, crypto) }]),
  );

  for (const wasThere of before) {
    const now = after.get(wasThere.id);

    // A row that vanished is the failure this check exists for: `up()`/`down()` only ever UPDATE,
    // so nothing in this suite may remove one.
    expect(now).toBeDefined();
    if (now === undefined) continue; // Unreachable after the assertion; narrows the type.

    // Encrypted and indexed — including a row that arrived as plaintext, which the backfill is
    // supposed to have picked up. This is the state the policy row requires of the column.
    expect(now.check.verdict).toBe('decryptable');
    expect(now.row.email_bidx).toMatch(/^[0-9a-f]{64}$/);

    // And it still holds the address it held before the round trip.
    expect(now.check.fingerprint).toBe(wasThere.fingerprint);
  }
}

beforeAll(async () => {
  process.env[FIELD_ENV] = randomBytes(32).toString('base64');
  process.env[BLIND_ENV] = randomBytes(32).toString('base64');

  db = createMigrationConnection();
  await db.authenticate();

  // T-067 — drop key rows an interrupted run left behind. See `test/support/encryption-keys.ts`.
  await sweepOrphanedTestKeys(db);

  await db.query(`DELETE FROM reward_portal.encryption_keys WHERE kid IN (:kids)`, {
    type: QueryTypes.DELETE,
    replacements: { kids: [FIELD_KID, BLIND_KID] },
  });
  await db.query(
    `INSERT INTO reward_portal.encryption_keys (kid, purpose, algorithm, key_ref, status)
     VALUES (:fieldKid, 'field', 'AES-256-GCM', :fieldRef,
             CASE WHEN EXISTS (SELECT 1 FROM reward_portal.encryption_keys
                                WHERE purpose = 'field' AND status = 'active')
                  THEN 'rotating' ELSE 'active' END),
            (:bidxKid, 'blind_index', 'HMAC-SHA256', :bidxRef,
             CASE WHEN EXISTS (SELECT 1 FROM reward_portal.encryption_keys
                                WHERE purpose = 'blind_index' AND status = 'active')
                  THEN 'rotating' ELSE 'active' END)`,
    {
      type: QueryTypes.INSERT,
      replacements: {
        fieldKid: FIELD_KID,
        fieldRef: `env:${FIELD_ENV}`,
        bidxKid: BLIND_KID,
        bidxRef: `env:${BLIND_ENV}`,
      },
    },
  );

  await removeProbeUsers();
});

afterAll(async () => {
  if (db === undefined) return;
  await removeProbeUsers();
  await db.query(`DELETE FROM reward_portal.encryption_keys WHERE kid IN (:kids)`, {
    type: QueryTypes.DELETE,
    replacements: { kids: [FIELD_KID, BLIND_KID] },
  });
  await db.close();
  delete process.env[FIELD_ENV];
  delete process.env[BLIND_ENV];
});

describe('T056_001 backfill over a populated table', () => {
  it('encrypts and indexes every pre-existing row, live and soft-deleted, and restores them on down()', async () => {
    /**
     * This suite rolls the whole table back and forward, so it can only run when every row in it is
     * decryptable with the keys currently configured. A row left behind by another suite whose
     * ephemeral key has since been deleted is *permanently* undecryptable, and `down()` refuses to
     * touch it — correctly, since replacing an address with a placeholder is silent data loss.
     *
     * Checked up front so that situation reports itself as "clean this up first" rather than as a
     * confusing decryption failure from inside the migration.
     *
     * **T-070.** That paragraph is unchanged, because it was always the right requirement — what
     * was wrong was the code beneath it, which asserted `count(foreign rows) === 0`. That is a
     * strictly stronger condition and an unrelated one: a perfectly decryptable row created by a
     * developer logging into the portal failed it, and three such rows had accumulated on the
     * shared development database (ids 3235, 3344, 4657) by the time the defect was looked at,
     * from three different sources, one of which appeared *after* the defect was filed. Deleting
     * them would have fixed nothing that the next login would not immediately re-break.
     *
     * So the guard now checks what the paragraph says: every foreign row must be readable with the
     * key material this process can reach. Rows that are get carried through the round trip, and
     * `expectForeignRowsUnharmed` below proves their addresses came back unchanged — the property
     * the count was standing in for.
     */
    // One crypto instance for both ends of the round trip: the fingerprints below are only
    // comparable if the same `blind_index` key computed them.
    const emailCrypto = await buildEmailCrypto();
    const foreignBefore = preflightForeignRows(await readForeignRows(), emailCrypto);

    // Start from the pre-migration shape. The database is migrated when this suite starts, so
    // `down()` first — with no probe rows yet, so it needs no keys and touches no data.
    await down({ context: db });

    let migratedBack = false;
    try {
      // Two rows as they would have existed before T-056: plaintext, no index column at all.
      await db.query(
        `INSERT INTO reward_portal.portal_users (email, display_name, role, status)
         VALUES (:live, :displayName, 'super_admin', 'active'),
                (:deleted, :displayName, 'super_admin', 'active')`,
        {
          type: QueryTypes.INSERT,
          replacements: { live: LIVE_EMAIL, deleted: DELETED_EMAIL, displayName: DISPLAY_NAME },
        },
      );
      // One of them is soft-deleted — it must still be encrypted (see the file header).
      await db.query(
        `UPDATE reward_portal.portal_users SET deleted_at = now()
          WHERE email = :email AND display_name = :displayName`,
        {
          type: QueryTypes.UPDATE,
          replacements: { email: DELETED_EMAIL, displayName: DISPLAY_NAME },
        },
      );

      const before = await readProbesWithoutIndex();
      expect(before).toHaveLength(2);
      for (const row of before) expect(looksLikeCiphertext(row.email)).toBe(false);

      // --- the backfill ---------------------------------------------------------------------
      await up({ context: db });
      migratedBack = true;

      const after = await readProbes();
      expect(after).toHaveLength(2);
      for (const row of after) {
        expect(looksLikeCiphertext(row.email)).toBe(true);
        expect(row.email_bidx).toMatch(/^[0-9a-f]{64}$/);
      }
      // Including the soft-deleted one — the whole point of backfilling every row.
      expect(after.every((row) => looksLikeCiphertext(row.email))).toBe(true);
      // No address survives in the clear anywhere in the column.
      expect(after.map((row) => row.email).join(' ')).not.toContain('Backfill');

      // The two distinct addresses produce two distinct indexes.
      expect(after[0].email_bidx).not.toBe(after[1].email_bidx);

      // --- idempotency: a re-run must not double-encrypt -------------------------------------
      // `up()` cannot be called twice (the column already exists), so the property is asserted the
      // way a partial re-run would hit it: down() restores plaintext, and a second up() re-encrypts
      // from plaintext rather than from an envelope. A double-encrypted value would decrypt to a
      // ciphertext and never back to the address, which the final assertion below would catch.
      await down({ context: db });
      migratedBack = false;

      const restored = await readProbesWithoutIndex();
      expect(restored).toHaveLength(2);
      for (const row of restored) expect(looksLikeCiphertext(row.email)).toBe(false);

      // down() put the *exact* addresses back, casing included — a rollback that mangled them
      // would be silent data loss.
      expect(restored.map((row) => row.email).sort()).toEqual([LIVE_EMAIL, DELETED_EMAIL].sort());

      await up({ context: db });
      migratedBack = true;

      const again = await readProbes();
      for (const row of again) {
        expect(looksLikeCiphertext(row.email)).toBe(true);
        expect(row.email_bidx).toMatch(/^[0-9a-f]{64}$/);
      }
      // The index is a pure function of the address, so it is identical across both runs even
      // though the ciphertext (random IV) is not.
      expect(again.map((r) => r.email_bidx).sort()).toEqual(after.map((r) => r.email_bidx).sort());

      // T-070 — everyone else's rows came back untouched. Last, so it runs against the final
      // state, and inside the `try` so a failure still hits the `finally` below.
      await expectForeignRowsUnharmed(foreignBefore, emailCrypto);
    } finally {
      // Never leave the schema rolled back for the next suite, whatever failed above.
      if (!migratedBack) {
        await removeProbeUsers();
        await up({ context: db });
      }
    }
  });
});
