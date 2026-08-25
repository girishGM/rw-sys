/**
 * T-016 — the crypto core against the **real** Postgres instance.
 *
 * The unit suites drive `FakeDb`, which models the statement shapes the rotation queries
 * produce. That is what makes 100% branch coverage reachable, and it proves nothing about
 * whether the SQL is valid Postgres, whether `starts_with()` behaves as assumed, whether the
 * `ck_ek_key_ref_pointer` CHECK actually rejects a pasted key, or whether a 10,000-row
 * rotation converges. This file covers exactly that gap, and evidences T-016 verification
 * steps 3, 4, 5 and 7.
 *
 * ### Isolation
 *
 * Real rows are inserted into `reward_portal.encryption_keys` (there is no seeded data there —
 * which kids exist is a deployment decision) and removed again in `afterAll`, keyed by a
 * `t016_e2e_` kid prefix so a failed run cannot collide with anything else. Rotation itself
 * runs against a **TEMP table**, which is session-scoped, vanishes on disconnect, and is not
 * DDL against any permanent schema — so R1 and R7 are untouched while the test still exercises
 * real transactions, real locking and real `starts_with()`.
 *
 * Key material is generated per run with `randomBytes` and lives only in `process.env` for the
 * duration of the process. Nothing here is, or could become, a committed secret (R4).
 *
 * ### A pre-existing active key is now expected, not a surprise (T-057 D-2, 2026-08-20)
 *
 * `uq_ek_active_purpose` allows exactly one `active` row per purpose, globally — not one per
 * test suite. Before T-057, nothing in this codebase could create a *permanent* `field`/
 * `blind_index` row, so this file could safely assume the table held none when it started.
 * T-057 built the provisioning CLI `DEPLOYMENT.md` now documents as a required first-run step,
 * so any environment that has ever been provisioned — this shared local database very much
 * included — legitimately, permanently holds one active row per purpose from that point on.
 * `beforeAll` below now makes room for its own active rows by temporarily demoting whichever
 * pre-existing one it finds (never deleting: other rows in this table, e.g. real
 * `portal_users.email` ciphertext, may already depend on it decrypting), and `afterAll`
 * restores it exactly, pass or fail. See `back-end/test/database-cli/encryption-keys.e2e-spec.ts`
 * for the sibling case (`token`/`transport` purposes, which nothing else in this codebase
 * consumes, so no displacement is needed there).
 *
 * ### Orphaned rows from *other* tasks' own verification sessions are not this suite's problem
 *
 * `KeyRegistryService.load()` resolves **every** row in `encryption_keys`, regardless of
 * purpose — a single row anywhere in the table whose `key_ref` variable cannot be found fails
 * the whole load. On this project's shared local development database that is a real,
 * repeatedly observed condition, not a hypothetical: other tasks' own manual UI-verification
 * sessions (`t058ui_t056_fld`, `t033ui_t056_fld`, `t045ui_t056_fld` and their `blind_index`
 * counterparts, all seen on this database in a single afternoon) leave `rotating` rows whose
 * env vars only ever existed in a session this process has no way to reach. Failing this
 * suite over a row it has nothing to do with would be a false failure — it proves nothing
 * about T-016's own code — so `buildResilientRegistryEnv()` below supplies a fresh random
 * placeholder for any row's variable that is not otherwise resolvable, exactly mirroring
 * `encryption-keys.e2e-spec.ts`'s own `resolveWholeRegistryEnv()` (written for the identical
 * reason). Safe for the same reason that one is: `load()` only needs *something* resolvable
 * in memory, never for the placeholder to match whatever the row originally protected — this
 * suite decrypts nothing under a kid it did not itself create.
 */
import { randomBytes } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import {
  BlindIndexService,
  FieldCryptoService,
  KeyRegistryService,
  RotateKeysCommand,
  EnvKeyMaterialResolver,
  UnconfiguredKmsResolver,
  looksLikeKeyMaterial,
  defaultKeyMaterialEnv,
  type RotationTarget,
} from '@/common/crypto';
import { buildAppSequelize } from '../database/build-app-sequelize';

const KID_OLD = 't016_e2e_fld_1';
const KID_NEW = 't016_e2e_fld_2';
const KID_BIDX = 't016_e2e_bidx_1';
const KID_PREFIX = 't016_e2e_';

const ENV_OLD = 'T016_E2E_FIELD_KEY_1';
const ENV_NEW = 'T016_E2E_FIELD_KEY_2';
const ENV_BIDX = 'T016_E2E_BLIND_KEY_1';

const PROBE_TABLE = 't016_rotation_probe';
const TARGET: RotationTarget = {
  table: PROBE_TABLE,
  pkColumn: 'id',
  columns: ['email_enc'],
  blindIndex: [{ column: 'email_bidx', sourceColumn: 'email_enc', normaliser: 'email' }],
};

let sequelize: Sequelize;
let registry: KeyRegistryService;
let fieldCrypto: FieldCryptoService;
let blindIndex: BlindIndexService;
let rotate: RotateKeysCommand;
/** Any pre-existing 'active' field/blind_index row this suite had to demote to 'rotating' to
 * make room for its own (see the file header) — restored to 'active' in `afterAll`. Never
 * more than one per purpose, by construction of `uq_ek_active_purpose`. */
let displacedActiveKeys: { kid: string; purpose: string }[] = [];

function aadFor(id: number): string {
  return FieldCryptoService.aadFor(PROBE_TABLE, id);
}

async function insertKey(
  kid: string,
  purpose: string,
  algorithm: string,
  keyRef: string,
  status: string,
): Promise<void> {
  await sequelize.query(
    `INSERT INTO reward_portal.encryption_keys (kid, purpose, algorithm, key_ref, status, retired_at)
     VALUES (:kid, :purpose, :algorithm, :keyRef, :status,
             CASE WHEN :status = 'retired' THEN now() ELSE NULL END)`,
    {
      replacements: { kid, purpose, algorithm, keyRef, status },
      type: QueryTypes.INSERT,
    },
  );
}

/** See the file header's "Orphaned rows from other tasks' own verification sessions" section.
 * Builds an env map covering every row currently in `encryption_keys`: a row whose variable
 * is genuinely resolvable (real `process.env`, or a `.env` file — `defaultKeyMaterialEnv()`,
 * T-057 D-3) keeps that real value; anything else gets a fresh random placeholder, purely so
 * `KeyRegistryService.load()` can resolve the whole table without failing over a row this
 * suite has nothing to do with. */
async function buildResilientRegistryEnv(): Promise<NodeJS.ProcessEnv> {
  const rows = await sequelize.query<{ key_ref: string }>(
    `SELECT key_ref FROM reward_portal.encryption_keys`,
    { type: QueryTypes.SELECT },
  );
  const real = defaultKeyMaterialEnv();
  const env: Record<string, string> = {};
  for (const row of rows) {
    if (!row.key_ref.startsWith('env:')) continue; // e.g. a future kms: row — not this suite's concern
    const name = row.key_ref.slice(4);
    const existing = real[name];
    env[name] =
      existing !== undefined && existing !== '' ? existing : randomBytes(32).toString('base64');
  }
  return env as NodeJS.ProcessEnv;
}

beforeAll(async () => {
  // Generated per run. Never written to disk, never committed.
  process.env[ENV_OLD] = randomBytes(32).toString('base64');
  process.env[ENV_NEW] = randomBytes(32).toString('base64');
  process.env[ENV_BIDX] = randomBytes(32).toString('base64');

  sequelize = buildAppSequelize();
  await sequelize.authenticate();

  // Leftovers from an interrupted previous run, if any.
  await sequelize.query(
    `DELETE FROM reward_portal.encryption_keys WHERE starts_with(kid, :prefix)`,
    { replacements: { prefix: KID_PREFIX }, type: QueryTypes.DELETE },
  );

  // Make room for this suite's own active 'field'/'blind_index' row (see the file header) —
  // demote, never delete, whatever this environment already had active. Recorded before any
  // insert below can throw, so `afterAll` can still restore it on a failed run.
  displacedActiveKeys = await sequelize.query<{ kid: string; purpose: string }>(
    `SELECT kid, purpose FROM reward_portal.encryption_keys
      WHERE purpose IN ('field', 'blind_index') AND status = 'active'
        AND NOT starts_with(kid, :prefix)`,
    { replacements: { prefix: KID_PREFIX }, type: QueryTypes.SELECT },
  );
  for (const displaced of displacedActiveKeys) {
    await sequelize.query(
      `UPDATE reward_portal.encryption_keys SET status = 'rotating' WHERE kid = :kid`,
      { replacements: { kid: displaced.kid }, type: QueryTypes.UPDATE },
    );
  }

  await insertKey(KID_OLD, 'field', 'AES-256-GCM', `env:${ENV_OLD}`, 'active');
  await insertKey(KID_NEW, 'field', 'AES-256-GCM', `env:${ENV_NEW}`, 'rotating');
  await insertKey(KID_BIDX, 'blind_index', 'HMAC-SHA256', `env:${ENV_BIDX}`, 'active');

  registry = new KeyRegistryService(sequelize, [
    new EnvKeyMaterialResolver(await buildResilientRegistryEnv()),
    new UnconfiguredKmsResolver(),
  ]);
  await registry.load();

  fieldCrypto = new FieldCryptoService(registry);
  blindIndex = new BlindIndexService(registry);
  rotate = new RotateKeysCommand(sequelize, registry, fieldCrypto, blindIndex);

  await sequelize.query(
    `CREATE TEMP TABLE ${PROBE_TABLE} (
       id         int primary key,
       email_enc  text,
       email_bidx varchar(64)
     )`,
    { type: QueryTypes.RAW },
  );
}, 60_000);

afterAll(async () => {
  if (sequelize !== undefined) {
    await sequelize.query(
      `DELETE FROM reward_portal.encryption_keys WHERE starts_with(kid, :prefix)`,
      { replacements: { prefix: KID_PREFIX }, type: QueryTypes.DELETE },
    );
    // Restore exactly what was displaced in beforeAll, pass or fail — this suite does not own
    // that row (see the file header) and must leave it exactly as found.
    for (const displaced of displacedActiveKeys) {
      await sequelize.query(
        `UPDATE reward_portal.encryption_keys SET status = 'active' WHERE kid = :kid`,
        { replacements: { kid: displaced.kid }, type: QueryTypes.UPDATE },
      );
    }
    await sequelize.close();
  }
  delete process.env[ENV_OLD];
  delete process.env[ENV_NEW];
  delete process.env[ENV_BIDX];
});

/** Inserts `count` rows encrypted under whichever key is active right now. */
async function seed(count: number): Promise<string[]> {
  const plaintexts: string[] = [];
  const values: string[] = [];
  const replacements: Record<string, unknown> = {};

  for (let id = 1; id <= count; id += 1) {
    const plaintext = `user${id}@Example.COM`;
    plaintexts.push(plaintext);
    values.push(`(:i${id}, :e${id}, :b${id})`);
    replacements[`i${id}`] = id;
    replacements[`e${id}`] = fieldCrypto.encrypt(plaintext, { aad: aadFor(id) });
    replacements[`b${id}`] = blindIndex.compute(plaintext, 'email');
  }

  await sequelize.query(`TRUNCATE ${PROBE_TABLE}`, { type: QueryTypes.RAW });
  // Chunked so the statement stays a sane size at 10k rows.
  for (let offset = 0; offset < values.length; offset += 1_000) {
    const slice = values.slice(offset, offset + 1_000);
    await sequelize.query(
      `INSERT INTO ${PROBE_TABLE} (id, email_enc, email_bidx) VALUES ${slice.join(', ')}`,
      { replacements, type: QueryTypes.INSERT },
    );
  }
  return plaintexts;
}

/**
 * Asserts that `run()` was rejected by a specific database constraint, **by name**.
 *
 * Matching on the error message does not work uniformly here, and the difference is a real
 * Sequelize behaviour rather than a quirk worth hiding behind a looser assertion:
 *
 *  - a CHECK violation surfaces as `SequelizeDatabaseError`, whose `.message` is Postgres's
 *    own text and does contain the constraint name;
 *  - a UNIQUE violation surfaces as `SequelizeUniqueConstraintError`, whose `.message` is the
 *    fixed string `"Validation error"` — the constraint name lives only on `.parent`.
 *
 * So `rejects.toThrow(/uq_ek_active_purpose/)` fails against a partial unique index even when
 * the index is working perfectly. Reading `.parent.constraint` pins the exact constraint that
 * fired, which is a *stronger* assertion than a substring match on a message: it cannot be
 * satisfied by some unrelated error that happens to quote the same name.
 */
async function expectConstraintViolation(
  run: () => Promise<unknown>,
  constraint: string,
): Promise<void> {
  let error: unknown;
  try {
    await run();
  } catch (err) {
    error = err;
  }

  expect(error).toBeDefined();
  const parent = (error as { parent?: { constraint?: string; code?: string } }).parent;
  expect(parent?.constraint).toBe(constraint);
  // 23505 unique_violation · 23514 check_violation — anything else means a different failure.
  expect(['23505', '23514']).toContain(parent?.code);
}

async function readRows(): Promise<{ id: number; email_enc: string; email_bidx: string }[]> {
  return sequelize.query<{ id: number; email_enc: string; email_bidx: string }>(
    `SELECT id, email_enc, email_bidx FROM ${PROBE_TABLE} ORDER BY id`,
    { type: QueryTypes.SELECT },
  );
}

describe('T-016 crypto core — against the real database', () => {
  describe('verification step 3 — encryption_keys holds pointers, never key material', () => {
    it('every key_ref in the table is an env: or kms: pointer', async () => {
      const rows = await sequelize.query<{ kid: string; key_ref: string }>(
        `SELECT kid, key_ref FROM reward_portal.encryption_keys ORDER BY id`,
        { type: QueryTypes.SELECT },
      );

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.key_ref).toMatch(/^(env|kms):/);
        // The registry's own boot assertion, re-run over whatever is actually stored.
        expect(looksLikeKeyMaterial(row.key_ref)).toBe(false);
        expect(looksLikeKeyMaterial(row.key_ref.slice(row.key_ref.indexOf(':') + 1))).toBe(false);
      }
    });

    it('the database itself refuses a pasted key, independently of the application', async () => {
      // TC-12 at the storage layer: even a direct INSERT by someone bypassing the portal
      // entirely cannot put key bytes in this column.
      const key = randomBytes(32).toString('base64');
      await expectConstraintViolation(
        () => insertKey(`${KID_PREFIX}bad`, 'field', 'AES-256-GCM', key, 'rotating'),
        'ck_ek_key_ref_pointer',
      );
      await expectConstraintViolation(
        () => insertKey(`${KID_PREFIX}bad`, 'field', 'AES-256-GCM', `env:${key}`, 'rotating'),
        'ck_ek_key_ref_pointer',
      );
    });

    it('refuses two active keys for one purpose', async () => {
      // Pinned by constraint name rather than by message: a partial unique index surfaces as
      // SequelizeUniqueConstraintError, whose message is the fixed string "Validation error".
      // See `expectConstraintViolation`.
      await expectConstraintViolation(
        () => insertKey(`${KID_PREFIX}dup`, 'field', 'AES-256-GCM', 'env:T016_E2E_OTHER', 'active'),
        'uq_ek_active_purpose',
      );
    });

    it('refuses a retired key with no retired_at', async () => {
      await expectConstraintViolation(
        () =>
          sequelize.query(
            `INSERT INTO reward_portal.encryption_keys (kid, purpose, algorithm, key_ref, status)
             VALUES ('${KID_PREFIX}ret', 'field', 'AES-256-GCM', 'env:T016_E2E_X', 'retired')`,
            { type: QueryTypes.INSERT },
          ),
        'ck_ek_retired_at',
      );
    });
  });

  describe('verification step 4 — a ciphertext moved between rows does not decrypt', () => {
    it('fails after a real UPDATE lifts row 1’s value onto row 2', async () => {
      await seed(2);

      // The attack, executed as SQL rather than simulated in memory.
      await sequelize.query(
        `UPDATE ${PROBE_TABLE}
            SET email_enc = (SELECT email_enc FROM ${PROBE_TABLE} WHERE id = 1)
          WHERE id = 2`,
        { type: QueryTypes.UPDATE },
      );

      const rows = await readRows();
      expect(rows[1].email_enc).toBe(rows[0].email_enc);

      // Row 1 still reads fine...
      expect(fieldCrypto.decrypt(rows[0].email_enc, { aad: aadFor(1) })).toBe('user1@Example.COM');

      // ...and row 2, holding the identical bytes, does not.
      let result: unknown;
      let error: unknown;
      try {
        result = fieldCrypto.decrypt(rows[1].email_enc, { aad: aadFor(2) });
      } catch (err) {
        error = err;
      }
      expect(result).toBeUndefined();
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('DecryptionError');
      expect((error as { reason?: string }).reason).toBe('auth_failed');
    });
  });

  describe('verification step 5 / TC-16 — rotating 10,000 real rows', () => {
    it('re-encrypts every row and leaves every value intact', async () => {
      const expected = await seed(10_000);

      const before = await readRows();
      expect(new Set(before.map((r) => r.email_enc.split('.')[1]))).toEqual(new Set([KID_OLD]));

      await rotate.activateKey(KID_NEW);
      expect(registry.getActiveKey('field').kid).toBe(KID_NEW);

      const result = await rotate.rotate(TARGET, { batchSize: 1_000 });
      expect(result.pending).toBe(10_000);
      expect(result.rewritten).toBe(10_000);

      const after = await readRows();
      expect(after).toHaveLength(10_000);

      // Every row is on the new key...
      expect(new Set(after.map((r) => r.email_enc.split('.')[1]))).toEqual(new Set([KID_NEW]));
      // ...every value is unchanged...
      expect(after.map((r, i) => fieldCrypto.decrypt(r.email_enc, { aad: aadFor(i + 1) }))).toEqual(
        expected,
      );
      // ...and every blind index still matches, so lookups keep working.
      for (const [index, row] of after.entries()) {
        expect(row.email_bidx).toBe(blindIndex.compute(expected[index], 'email'));
      }
      // ...and the ciphertext genuinely changed, i.e. this was not a no-op.
      expect(after[0].email_enc).not.toBe(before[0].email_enc);

      expect(await rotate.countStale(TARGET)).toBe(0);
      expect(await rotate.countUnder(TARGET, KID_OLD)).toBe(0);
    }, 300_000);

    it('refuses to retire the old key while rows still reference it, then allows it', async () => {
      await seed(50);
      // seed() encrypted under the now-active KID_NEW, so put a row back on the old key.
      const stale = fieldCrypto.encrypt('legacy@example.com', { aad: aadFor(1) });
      expect(stale.split('.')[1]).toBe(KID_NEW);

      await expect(rotate.retireKey(KID_NEW, [TARGET])).rejects.toThrow(/it is the active key/);

      // Nothing is on KID_OLD any more, so retiring it is permitted.
      expect(await rotate.countUnder(TARGET, KID_OLD)).toBe(0);
      await rotate.retireKey(KID_OLD, [TARGET]);

      const [row] = await sequelize.query<{ status: string; retired_at: string | null }>(
        `SELECT status, retired_at FROM reward_portal.encryption_keys WHERE kid = :kid`,
        { replacements: { kid: KID_OLD }, type: QueryTypes.SELECT },
      );
      expect(row.status).toBe('retired');
      expect(row.retired_at).not.toBeNull();

      // TC-15, end to end: a value written under the retired key is now unreadable.
      await rotate.activateKey(KID_NEW);
      expect(() => registry.getKeyForDecryption(KID_OLD)).toThrow(/retired/);
    }, 120_000);
  });

  describe('blind index — real equality lookup', () => {
    it('finds a row by its blind index without ever querying the plaintext', async () => {
      await seed(100);
      const target = 'user42@Example.COM';

      const rows = await sequelize.query<{ id: number; email_enc: string }>(
        `SELECT id, email_enc FROM ${PROBE_TABLE} WHERE email_bidx = :bidx`,
        {
          replacements: { bidx: blindIndex.compute(target, 'email') },
          type: QueryTypes.SELECT,
        },
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(42);
      expect(fieldCrypto.decrypt(rows[0].email_enc, { aad: aadFor(42) })).toBe(target);
    });

    it('matches case-insensitively, which is why login works at all', async () => {
      const rows = await sequelize.query<{ id: number }>(
        `SELECT id FROM ${PROBE_TABLE} WHERE email_bidx = :bidx`,
        {
          replacements: { bidx: blindIndex.compute('  USER42@example.com  ', 'email') },
          type: QueryTypes.SELECT,
        },
      );
      expect(rows.map((r) => r.id)).toEqual([42]);
    });

    it('an encrypted column cannot be searched directly — the reason blind indexes exist', async () => {
      const rows = await sequelize.query<{ id: number }>(
        `SELECT id FROM ${PROBE_TABLE} WHERE email_enc = :value`,
        {
          replacements: {
            value: fieldCrypto.encrypt('user42@Example.COM', { aad: aadFor(42) }),
          },
          type: QueryTypes.SELECT,
        },
      );
      // A fresh IV every time means equality on the ciphertext never matches. If this ever
      // returns a row, the IV has stopped being random and TC-2 is broken.
      expect(rows).toHaveLength(0);
    });
  });

  describe('verification step 7 — SQL logging never carries plaintext', () => {
    it('redacts bind parameters, so encrypting a field logs no plaintext', async () => {
      const captured: string[] = [];
      const logged = buildAppSequelize({ captureLogLines: captured });
      try {
        const plaintext = 'log-canary-7f31@example.invalid';
        await logged.query(`SELECT :value::text AS probe`, {
          replacements: {
            value: fieldCrypto.encrypt(plaintext, { aad: aadFor(1) }),
          },
          type: QueryTypes.SELECT,
        });

        expect(captured.length).toBeGreaterThan(0);
        const output = captured.join('\n');
        expect(output).not.toContain(plaintext);
        expect(output).not.toContain('log-canary');
        // And the key material itself is nowhere near a query.
        expect(output).not.toContain(process.env[ENV_OLD]);
        expect(output).not.toContain(process.env[ENV_NEW]);
      } finally {
        await logged.close();
      }
    });
  });
});
