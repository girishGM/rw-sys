/**
 * T-016 — `RotateKeysCommand`. Covers TC-13, TC-14, TC-16 and TC-17.
 *
 * These run against `FakeDb`, which models the handful of statement shapes the rotation
 * queries produce and gives a real ROLLBACK on a throw. That is what makes TC-17 meaningful:
 * an interrupted batch really does lose its writes here, so "resumable" is being tested rather
 * than asserted. It is **not** evidence that the emitted SQL is valid Postgres —
 * `crypto.e2e-spec.ts` runs the same rotation against the real database for that.
 *
 * The invariant every test below is ultimately checking is the one that matters during a real
 * rotation: **at no point is any row unreadable.** Mixed-vintage rows are fine, because the
 * kid travels inside the ciphertext; a row that is neither on the old key nor the new one is
 * data loss.
 */
import {
  assertTarget,
  DecryptionError,
  FieldCryptoService,
  KeyRegistryError,
  RotateKeysCommand,
  type RotationTarget,
} from '@/common/crypto';
import { BlindIndexService } from '@/common/crypto';
import { FakeDb, type FakeRow } from './support/fake-db';
import {
  BLIND_KID,
  blindKeyRow,
  FIELD_ENV_V2,
  FIELD_KID,
  FIELD_KID_V2,
  fieldKeyRow,
  resolvers,
  testEnv,
} from './support/keys';
import { KeyRegistryService } from '@/common/crypto';

const TABLE = 'reward_portal.portal_users';

const TARGET: RotationTarget = {
  table: TABLE,
  pkColumn: 'id',
  columns: ['email_enc'],
};

interface Harness {
  db: FakeDb;
  registry: KeyRegistryService;
  fieldCrypto: FieldCryptoService;
  blindIndex: BlindIndexService;
  command: RotateKeysCommand;
}

/**
 * A registry holding the old field key (active), a replacement (rotating, i.e. already
 * inserted but not yet promoted) and the blind-index key — the exact state an operator is in
 * at the start of a rotation.
 */
async function buildHarness(): Promise<Harness> {
  const db = new FakeDb();
  db.keyRows = [
    fieldKeyRow(),
    fieldKeyRow({ kid: FIELD_KID_V2, key_ref: `env:${FIELD_ENV_V2}`, status: 'rotating' }),
    blindKeyRow(),
  ];
  const registry = new KeyRegistryService(db.asSequelize(), resolvers(testEnv()));
  await registry.load();

  const fieldCrypto = new FieldCryptoService(registry);
  const blindIndex = new BlindIndexService(registry);
  const command = new RotateKeysCommand(db.asSequelize(), registry, fieldCrypto, blindIndex);

  return { db, registry, fieldCrypto, blindIndex, command };
}

/** Seeds `count` rows, each with `email_enc` encrypted under whatever key is active now. */
function seedRows(h: Harness, count: number, table = TABLE): string[] {
  const plaintexts: string[] = [];
  const rows: FakeRow[] = [];
  for (let id = 1; id <= count; id += 1) {
    const plaintext = `user${id}@example.com`;
    plaintexts.push(plaintext);
    rows.push({
      id,
      email_enc: h.fieldCrypto.encrypt(plaintext, {
        aad: FieldCryptoService.aadFor(table, id),
      }),
      email_bidx: h.blindIndex.compute(plaintext, 'email'),
    });
  }
  h.db.setTable(table, rows);
  return plaintexts;
}

/** Decrypts every row and returns the plaintexts, in id order. */
function readAll(h: Harness, table = TABLE): (string | null)[] {
  return [...h.db.getTable(table)]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((row) =>
      h.fieldCrypto.decrypt(row.email_enc as string | null, {
        aad: FieldCryptoService.aadFor(table, row.id as number),
      }),
    );
}

function kidsOf(h: Harness, table = TABLE): Set<string> {
  return new Set(
    h.db
      .getTable(table)
      .filter((row) => typeof row.email_enc === 'string')
      .map((row) => (row.email_enc as string).split('.')[1]),
  );
}

describe('RotateKeysCommand', () => {
  describe('activateKey — step 1 of the lifecycle', () => {
    it('promotes the new key and demotes the previous one in the same transaction', async () => {
      const h = await buildHarness();
      expect(h.registry.getActiveKey('field').kid).toBe(FIELD_KID);

      await h.command.activateKey(FIELD_KID_V2);

      expect(h.registry.getActiveKey('field').kid).toBe(FIELD_KID_V2);
      // The old key stays usable for decryption — that overlap is what makes this zero-downtime.
      expect(h.registry.getKeyForDecryption(FIELD_KID).status).toBe('rotating');
    });

    it('demotes before it promotes, so the partial unique index is never violated', async () => {
      const h = await buildHarness();
      await h.command.activateKey(FIELD_KID_V2);
      const updates = h.db.statements.filter((s) =>
        s.includes('UPDATE reward_portal.encryption_keys'),
      );
      expect(updates[0]).toContain("SET status = 'rotating'");
      expect(updates[1]).toContain("SET status = 'active'");
    });

    it('does not disturb other key rings', async () => {
      const h = await buildHarness();
      await h.command.activateKey(FIELD_KID_V2);
      expect(h.registry.getActiveKey('blind_index').kid).toBe(BLIND_KID);
    });

    it('refuses an unknown kid', async () => {
      const h = await buildHarness();
      await expect(h.command.activateKey('never_existed')).rejects.toThrow(
        /No encryption_keys row with kid='never_existed'/,
      );
    });

    it('refuses to resurrect a retired key', async () => {
      const h = await buildHarness();
      h.db.keyRows[1].status = 'retired';
      await expect(h.command.activateKey(FIELD_KID_V2)).rejects.toThrow(
        /Refusing to re-activate retired key/,
      );
    });
  });

  describe('TC-13 — a value encrypted under the old key still decrypts after rotation', () => {
    it('decrypts via the kid embedded in the ciphertext', async () => {
      const h = await buildHarness();
      const aad = FieldCryptoService.aadFor(TABLE, 1);
      const ciphertext = h.fieldCrypto.encrypt('alice@example.com', { aad });
      expect(ciphertext.split('.')[1]).toBe(FIELD_KID);

      await h.command.activateKey(FIELD_KID_V2);

      // Nothing about the stored value changed, and it still reads back.
      expect(h.fieldCrypto.decrypt(ciphertext, { aad })).toBe('alice@example.com');
    });

    it('lets mixed-vintage rows coexist and all remain readable', async () => {
      const h = await buildHarness();
      seedRows(h, 5);
      await h.command.activateKey(FIELD_KID_V2);

      // Two more rows written *after* the switch, alongside the five written before it.
      const table = h.db.getTable(TABLE);
      for (const id of [6, 7]) {
        table.push({
          id,
          email_enc: h.fieldCrypto.encrypt(`user${id}@example.com`, {
            aad: FieldCryptoService.aadFor(TABLE, id),
          }),
          email_bidx: null,
        });
      }

      expect(kidsOf(h)).toEqual(new Set([FIELD_KID, FIELD_KID_V2]));
      expect(readAll(h)).toEqual([
        'user1@example.com',
        'user2@example.com',
        'user3@example.com',
        'user4@example.com',
        'user5@example.com',
        'user6@example.com',
        'user7@example.com',
      ]);
    });
  });

  describe('TC-14 — after rotation, new encryptions use the new kid', () => {
    it('writes under the new key immediately, without a restart', async () => {
      const h = await buildHarness();
      await h.command.activateKey(FIELD_KID_V2);
      const fresh = h.fieldCrypto.encrypt('bob@example.com', {
        aad: FieldCryptoService.aadFor(TABLE, 2),
      });
      expect(fresh.split('.')[1]).toBe(FIELD_KID_V2);
    });
  });

  describe('TC-16 — rotating 10,000 rows', () => {
    it('re-encrypts every row onto the new kid, leaving every value unchanged', async () => {
      const h = await buildHarness();
      const expected = seedRows(h, 10_000);
      expect(kidsOf(h)).toEqual(new Set([FIELD_KID]));

      await h.command.activateKey(FIELD_KID_V2);
      const result = await h.command.rotate(TARGET, { batchSize: 500 });

      expect(result.pending).toBe(10_000);
      expect(result.rewritten).toBe(10_000);
      expect(result.batches).toBe(20);
      expect(result.dryRun).toBe(false);

      // The two assertions TC-16 actually asks for.
      expect(kidsOf(h)).toEqual(new Set([FIELD_KID_V2]));
      expect(readAll(h)).toEqual(expected);

      // ...and it is genuinely finished.
      expect(await h.command.countStale(TARGET)).toBe(0);
      expect(await h.command.countUnder(TARGET, FIELD_KID)).toBe(0);
    });

    it('is idempotent — a second run rewrites nothing', async () => {
      const h = await buildHarness();
      const expected = seedRows(h, 200);
      await h.command.activateKey(FIELD_KID_V2);

      await h.command.rotate(TARGET, { batchSize: 50 });
      const second = await h.command.rotate(TARGET, { batchSize: 50 });

      expect(second.pending).toBe(0);
      expect(second.rewritten).toBe(0);
      expect(second.batches).toBe(0);
      expect(readAll(h)).toEqual(expected);
    });

    it('reports progress per batch', async () => {
      const h = await buildHarness();
      seedRows(h, 30);
      await h.command.activateKey(FIELD_KID_V2);

      const seen: number[] = [];
      await h.command.rotate(TARGET, { batchSize: 10, onProgress: (p) => seen.push(p.rewritten) });
      expect(seen).toEqual([10, 20, 30]);
    });

    it('counts without writing in a dry run', async () => {
      const h = await buildHarness();
      const expected = seedRows(h, 10);
      await h.command.activateKey(FIELD_KID_V2);

      const result = await h.command.rotate(TARGET, { dryRun: true });
      expect(result).toEqual({
        table: TABLE,
        pending: 10,
        rewritten: 0,
        batches: 0,
        dryRun: true,
      });
      expect(kidsOf(h)).toEqual(new Set([FIELD_KID]));
      expect(readAll(h)).toEqual(expected);
    });

    it('skips NULL columns rather than encrypting a NULL', async () => {
      const h = await buildHarness();
      seedRows(h, 3);
      h.db.getTable(TABLE)[1].email_enc = null;
      await h.command.activateKey(FIELD_KID_V2);

      const result = await h.command.rotate(TARGET);
      expect(result.rewritten).toBe(2);
      expect(h.db.getTable(TABLE)[1].email_enc).toBeNull();
      expect(readAll(h)[1]).toBeNull();
    });

    /**
     * The single-column case above never reaches the per-column NULL guard: a row whose only
     * encrypted column is NULL does not satisfy the stale predicate at all, so it is never
     * selected. The guard exists for the *multi-column* case, where the predicate is an OR —
     * one stale column pulls the row in and its NULL sibling must be stepped over rather than
     * fed to `decrypt()` (which would throw) or overwritten with an encrypted empty string.
     */
    it('steps over a NULL sibling column while rotating a stale one on the same row', async () => {
      const h = await buildHarness();
      const target: RotationTarget = {
        table: TABLE,
        pkColumn: 'id',
        columns: ['email_enc', 'phone_enc'],
      };
      const aad = FieldCryptoService.aadFor(TABLE, 1);
      h.db.setTable(TABLE, [
        { id: 1, email_enc: h.fieldCrypto.encrypt('a@example.com', { aad }), phone_enc: null },
      ]);

      await h.command.activateKey(FIELD_KID_V2);
      const result = await h.command.rotate(target);

      expect(result.rewritten).toBe(1);
      const [row] = h.db.getTable(TABLE);
      expect(row.phone_enc).toBeNull();
      expect(h.fieldCrypto.decrypt(row.email_enc as string, { aad })).toBe('a@example.com');
      expect((row.email_enc as string).split('.')[1]).toBe(FIELD_KID_V2);
    });

    /**
     * A blind index is declared against one specific source column. With several encrypted
     * columns in the target, the inner loop sees every column for every index and must
     * recompute only the pairing that was actually declared — recomputing `email_bidx` from
     * `phone_enc` would silently make every login lookup miss.
     */
    it('recomputes only the blind index whose source column it is looking at', async () => {
      const h = await buildHarness();
      const aad = FieldCryptoService.aadFor(TABLE, 1);
      h.db.setTable(TABLE, [
        {
          id: 1,
          email_enc: h.fieldCrypto.encrypt('a@example.com', { aad }),
          phone_enc: h.fieldCrypto.encrypt('+60123457788', { aad }),
          email_bidx: 'stale',
          phone_bidx: 'stale',
        },
      ]);

      await h.command.activateKey(FIELD_KID_V2);
      await h.command.rotate({
        table: TABLE,
        pkColumn: 'id',
        // `email_enc` is listed second so the loop meets `phone_enc` — a non-matching source
        // for the only declared index — before it meets the matching one.
        columns: ['phone_enc', 'email_enc'],
        blindIndex: [{ column: 'email_bidx', sourceColumn: 'email_enc', normaliser: 'email' }],
      });

      const [row] = h.db.getTable(TABLE);
      expect(row.email_bidx).toBe(h.blindIndex.compute('a@example.com', 'email'));
      // Untouched: no index was declared over it, so rotation must leave it exactly as found.
      expect(row.phone_bidx).toBe('stale');
    });

    it('recomputes blind indexes in the same pass', async () => {
      const h = await buildHarness();
      seedRows(h, 4);
      const before = h.db.getTable(TABLE).map((r) => r.email_bidx);
      // Blow the indexes away, as a blind-index key change would.
      for (const row of h.db.getTable(TABLE)) row.email_bidx = 'stale';

      await h.command.activateKey(FIELD_KID_V2);
      await h.command.rotate({
        ...TARGET,
        blindIndex: [{ column: 'email_bidx', sourceColumn: 'email_enc', normaliser: 'email' }],
      });

      expect(h.db.getTable(TABLE).map((r) => r.email_bidx)).toEqual(before);
    });

    it('rotates several targets in order', async () => {
      const h = await buildHarness();
      seedRows(h, 3, TABLE);
      seedRows(h, 2, 'reward_portal.portal_sessions');
      await h.command.activateKey(FIELD_KID_V2);

      const results = await h.command.rotateAll([
        TARGET,
        { table: 'reward_portal.portal_sessions', pkColumn: 'id', columns: ['email_enc'] },
      ]);
      expect(results.map((r) => [r.table, r.rewritten])).toEqual([
        [TABLE, 3],
        ['reward_portal.portal_sessions', 2],
      ]);
    });
  });

  describe('TC-17 — an interrupted rotation is resumable and leaves no row unreadable', () => {
    it('resumes from where it stopped when simply re-run', async () => {
      const h = await buildHarness();
      const expected = seedRows(h, 1_000);
      await h.command.activateKey(FIELD_KID_V2);

      // activateKey used transaction #0; make the third rotation batch (#3) fail.
      h.db.failTransactionAtIndex = 3;
      await expect(h.command.rotate(TARGET, { batchSize: 100 })).rejects.toThrow(
        /simulated failure/,
      );

      // The invariant: mid-rotation, every single row still decrypts. Some are on the old
      // kid and some on the new one, and that is fine — the kid is in the ciphertext.
      expect(readAll(h)).toEqual(expected);
      expect(kidsOf(h)).toEqual(new Set([FIELD_KID, FIELD_KID_V2]));

      // Two batches committed before the failure; the third rolled back.
      const remaining = await h.command.countStale(TARGET);
      expect(remaining).toBe(800);

      // No cursor, no --resume flag: just run it again.
      h.db.failTransactionAtIndex = null;
      const result = await h.command.rotate(TARGET, { batchSize: 100 });

      expect(result.pending).toBe(800);
      expect(result.rewritten).toBe(800);
      expect(kidsOf(h)).toEqual(new Set([FIELD_KID_V2]));
      expect(readAll(h)).toEqual(expected);
    });

    it('rolls the failed batch back completely — no half-written batch', async () => {
      const h = await buildHarness();
      seedRows(h, 100);
      await h.command.activateKey(FIELD_KID_V2);

      h.db.failTransactionAtIndex = 1; // the first rotation batch
      await expect(h.command.rotate(TARGET, { batchSize: 100 })).rejects.toThrow();

      expect(kidsOf(h)).toEqual(new Set([FIELD_KID]));
      expect(await h.command.countStale(TARGET)).toBe(100);
    });

    it('locks the batch FOR UPDATE so a concurrent writer cannot be overwritten', async () => {
      const h = await buildHarness();
      seedRows(h, 5);
      await h.command.activateKey(FIELD_KID_V2);
      await h.command.rotate(TARGET, { batchSize: 5 });

      const selects = h.db.statements.filter(
        (s) => s.includes(`FROM ${TABLE}`) && s.includes('LIMIT'),
      );
      expect(selects.length).toBeGreaterThan(0);
      for (const statement of selects) expect(statement).toContain('FOR UPDATE');
    });

    it('aborts rather than looping when the predicate and the data disagree', async () => {
      const h = await buildHarness();
      seedRows(h, 1);
      await h.command.activateKey(FIELD_KID_V2);
      // A row that matches "not on the active kid" but has nothing rotatable would otherwise
      // be selected forever. Modelled by making the column non-string after selection.
      h.db.getTable(TABLE)[0].email_enc = 12345;
      await expect(h.command.rotate(TARGET)).rejects.toThrow(/is not a string/);
    });

    /**
     * The other non-convergence guard: a row the selector returned but that has nothing to
     * rewrite. The batch loop terminates on "0 rows returned", so a row that is returned
     * forever and rewritten never is an infinite loop that also holds a `FOR UPDATE` lock —
     * far worse than an aborted rotation.
     *
     * Reaching it requires the selector and the row to disagree, which the production
     * predicate cannot do on its own (a row whose columns are all NULL does not match
     * `col IS NOT NULL AND NOT starts_with(...)`). That is precisely why the guard is
     * defensive, and precisely why it has to be driven from the double rather than from the
     * data: the closest real-world analogue is a concurrent writer NULLing the column between
     * the predicate being evaluated and the row being locked. Postgres' EvalPlanQual re-check
     * makes even that unreachable today — but "unreachable today" is an argument for keeping
     * the guard cheap, not for deleting it and finding out.
     */
    it('aborts rather than looping when a selected row has nothing to rewrite', async () => {
      const h = await buildHarness();
      seedRows(h, 1);
      await h.command.activateKey(FIELD_KID_V2);

      // Hand the batch loop — and only the batch loop, not the preceding count — a row that
      // passed the predicate and then lost its value. The spy dies with `h.db`, which is
      // built fresh per test.
      const realQuery = h.db.query.bind(h.db);
      jest.spyOn(h.db, 'query').mockImplementation(async (...args: Parameters<FakeDb['query']>) => {
        if (args[0].includes('LIMIT')) return [{ id: 1, email_enc: null }];
        return realQuery(...args);
      });

      await expect(h.command.rotate(TARGET, { batchSize: 1 })).rejects.toThrow(
        /matched the rotation predicate but has no rotatable column value/,
      );
    });

    it('refuses to spin past maxBatches', async () => {
      const h = await buildHarness();
      seedRows(h, 100);
      await h.command.activateKey(FIELD_KID_V2);
      await expect(h.command.rotate(TARGET, { batchSize: 10, maxBatches: 2 })).rejects.toThrow(
        /exceeded 2 batches without completing/,
      );
    });

    it.each([0, -1, 1.5, Number.NaN])('refuses the batchSize %p', async (batchSize) => {
      const h = await buildHarness();
      await expect(h.command.rotate(TARGET, { batchSize })).rejects.toThrow(
        /batchSize must be a positive integer/,
      );
    });

    it('surfaces a row that cannot be decrypted instead of silently skipping it', async () => {
      const h = await buildHarness();
      seedRows(h, 3);
      // Plaintext sitting in a ciphertext column — the shape a botched backfill leaves behind.
      h.db.getTable(TABLE)[1].email_enc = 'not-a-ciphertext';
      await h.command.activateKey(FIELD_KID_V2);
      await expect(h.command.rotate(TARGET)).rejects.toThrow(DecryptionError);
    });
  });

  describe('retireKey — step 3 of the lifecycle', () => {
    it('retires a rotating key once nothing references it', async () => {
      const h = await buildHarness();
      seedRows(h, 10);
      await h.command.activateKey(FIELD_KID_V2);
      await h.command.rotate(TARGET);

      await h.command.retireKey(FIELD_KID, [TARGET]);

      expect(() => h.registry.getKeyForDecryption(FIELD_KID)).toThrow(DecryptionError);
    });

    it('TC-15 — after retirement, ciphertext under that kid no longer decrypts', async () => {
      const h = await buildHarness();
      const aad = FieldCryptoService.aadFor(TABLE, 1);
      const old = h.fieldCrypto.encrypt('alice@example.com', { aad });
      await h.command.activateKey(FIELD_KID_V2);
      await h.command.retireKey(FIELD_KID);

      let error: unknown;
      let result: unknown;
      try {
        result = h.fieldCrypto.decrypt(old, { aad });
      } catch (err) {
        error = err;
      }
      expect(result).toBeUndefined();
      expect((error as DecryptionError).reason).toBe('retired_key');
      expect((error as DecryptionError).kid).toBe(FIELD_KID);
    });

    it('refuses while rows are still encrypted under it', async () => {
      const h = await buildHarness();
      seedRows(h, 7);
      await h.command.activateKey(FIELD_KID_V2);

      await expect(h.command.retireKey(FIELD_KID, [TARGET])).rejects.toThrow(
        /7 row\(s\) in reward_portal.portal_users are still encrypted under it/,
      );
      // ...and the key is genuinely still usable, not left half-retired.
      expect(readAll(h)).toHaveLength(7);
    });

    it('force skips the row check, and the report says what that costs', async () => {
      const h = await buildHarness();
      seedRows(h, 3);
      await h.command.activateKey(FIELD_KID_V2);

      await h.command.retireKey(FIELD_KID, [TARGET], { force: true });
      expect(() => h.registry.getKeyForDecryption(FIELD_KID)).toThrow(/retired/);
      // Exactly the consequence the doc comment warns about: those rows are now unreadable.
      expect(() => readAll(h)).toThrow(DecryptionError);
    });

    it('refuses to retire the active key', async () => {
      const h = await buildHarness();
      await expect(h.command.retireKey(FIELD_KID)).rejects.toThrow(/it is the active key/);
    });

    it('refuses an unknown kid', async () => {
      const h = await buildHarness();
      await expect(h.command.retireKey('never_existed')).rejects.toThrow(
        /No encryption_keys row with kid='never_existed'/,
      );
    });
  });

  describe('counting', () => {
    it('counts rows under a given kid, and rows not yet on the active one', async () => {
      const h = await buildHarness();
      seedRows(h, 6);
      expect(await h.command.countUnder(TARGET, FIELD_KID)).toBe(6);
      expect(await h.command.countUnder(TARGET, FIELD_KID_V2)).toBe(0);
      expect(await h.command.countStale(TARGET)).toBe(0);

      await h.command.activateKey(FIELD_KID_V2);
      expect(await h.command.countStale(TARGET)).toBe(6);
      expect(await h.command.countStale(TARGET, FIELD_KID)).toBe(0);
    });
  });

  describe('assertTarget — identifiers are interpolated, so they are validated', () => {
    const base: RotationTarget = { table: 't', pkColumn: 'id', columns: ['c'] };

    it('accepts a schema-qualified table with unqualified columns', () => {
      expect(() => assertTarget({ ...base, table: 'reward_portal.portal_users' })).not.toThrow();
    });

    it.each([
      ['a quoted table', { ...base, table: 'users"; DROP TABLE x; --' }],
      ['an uppercase table', { ...base, table: 'Users' }],
      ['a table with a space', { ...base, table: 'reward_portal.portal users' }],
      ['a qualified pk', { ...base, pkColumn: 'a.b' }],
      ['a qualified column', { ...base, columns: ['a.b'] }],
      ['an injected column', { ...base, columns: ['c = 1; --'] }],
      ['no columns at all', { ...base, columns: [] }],
      ['a bad aadTable', { ...base, aadTable: 'Bad Table' }],
      [
        'a bad blind-index column',
        {
          ...base,
          blindIndex: [{ column: 'B!', sourceColumn: 'c', normaliser: 'email' as const }],
        },
      ],
      [
        'a blind index whose source is not rotated',
        {
          ...base,
          blindIndex: [{ column: 'c_bidx', sourceColumn: 'other', normaliser: 'email' as const }],
        },
      ],
    ])('rejects %s', (_label, target) => {
      expect(() => assertTarget(target as RotationTarget)).toThrow(KeyRegistryError);
    });

    it('is enforced by rotate, countStale and countUnder, not just callable', async () => {
      const h = await buildHarness();
      const bad = { ...base, table: 'Bad' };
      await expect(h.command.rotate(bad)).rejects.toThrow(KeyRegistryError);
      await expect(h.command.countStale(bad)).rejects.toThrow(KeyRegistryError);
      await expect(h.command.countUnder(bad, FIELD_KID)).rejects.toThrow(KeyRegistryError);
    });
  });

  describe('aadTable', () => {
    it('binds the AAD to an overridden table name when the ciphertext was written that way', async () => {
      const h = await buildHarness();
      // Rows encrypted under a legacy AAD table name...
      const rows: FakeRow[] = [1, 2].map((id) => ({
        id,
        email_enc: h.fieldCrypto.encrypt(`user${id}@example.com`, {
          aad: FieldCryptoService.aadFor('legacy_users', id),
        }),
      }));
      h.db.setTable(TABLE, rows);
      await h.command.activateKey(FIELD_KID_V2);

      // ...rotate fails without the override (the AAD would not match)...
      await expect(h.command.rotate(TARGET)).rejects.toThrow(DecryptionError);
      // ...and succeeds with it.
      await expect(
        h.command.rotate({ ...TARGET, aadTable: 'legacy_users' }),
      ).resolves.toMatchObject({ rewritten: 2 });
    });
  });
});
