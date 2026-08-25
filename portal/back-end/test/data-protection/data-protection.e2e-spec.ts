/**
 * T-017 — the data-protection engine against the **real** Postgres instance.
 *
 * The unit suites drive doubles, which is what makes 100% branch coverage reachable and proves
 * nothing about whether the DDL is valid, whether `ck_dpp_blind_index_class` actually rejects a
 * bad row, whether the seeds are idempotent, or whether the hooks survive a real INSERT with a
 * generated identity key inside a real transaction. This file covers exactly that gap, and
 * evidences T-017 verification steps 3 and 5 and test cases TC-1 … TC-5 and TC-22 … TC-24.
 *
 * ### Isolation
 *
 * TC-1 … TC-5 run against a **TEMP table** and a model defined for this spec — session-scoped, gone
 * on disconnect, and not DDL against any permanent schema, so R1 and R7 are untouched while the
 * test still exercises real transactions, a real `int generated always as identity` primary key,
 * real constraints and the real `afterFind` path. The same arrangement T-016's `crypto.e2e-spec.ts`
 * uses, for the same reasons.
 *
 * *(Originally the probe table also existed because `portal_users.email` was **not** encrypted and
 * TC-1 … TC-5 could not be run against it without breaking login. T-056 has since encrypted that
 * column, and verification step 3 below now asserts it on the real table. The probe table stays:
 * it can exercise cases — a deliberately corrupted ciphertext, a value moved between rows — that
 * must not be inflicted on the table the portal authenticates against.)*
 *
 * Policy rows inserted here are keyed `t017_e2e.…` and removed in `afterAll`, so a failed run
 * cannot collide with the seeded rows or with anything else.
 *
 * ### Why the reveal endpoint is not exercised here
 *
 * It writes `portal_audit_log`, and `T002_008_grants.ts` deliberately does
 * `REVOKE UPDATE, DELETE ON reward_portal.portal_audit_log` — the table is append-only for
 * tamper-resistance. A test that revealed a field would therefore leave a permanent row, with a
 * fabricated actor id, in the real audit trail of a shared database, on every run. Weakening that
 * grant to make a test tidy up after itself is exactly the trade AGENT-PROTOCOL §7 says not to
 * make, so the reveal path is covered in `reveal.spec.ts` against an audit double instead — where
 * TC-18's assertion is in fact *stronger*, because it inspects the event object handed to
 * `AuditService` and can prove the value is structurally absent rather than merely absent from
 * one rendering of one row. That `AuditService` really does insert what it is given is T-014's
 * `audit.e2e-spec.ts`, against this same table. Recorded against verification step 6 in the
 * completion report.
 */
import { randomBytes } from 'node:crypto';
import { DataType } from 'sequelize-typescript';
import { QueryTypes, type Model, type ModelStatic } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import {
  BlindIndexService,
  EnvKeyMaterialResolver,
  FieldCryptoService,
  KeyRegistryService,
  UnconfiguredKmsResolver,
  looksLikeCiphertext,
} from '@/common/crypto';
import {
  DEFAULT_DATA_PROTECTION_CONFIG,
  installEncryptionHooks,
  PolicySet,
  UNDECRYPTABLE_SENTINEL,
  type DataProtectionPolicy,
} from '@/common/data-protection';
import { PolicyRepository } from '@/common/data-protection/policy.repository';
import { SEEDED_POLICIES } from '@/database/migrations/T017_002_seed_policies';
import { buildAppSequelize } from '../database/build-app-sequelize';
import { sweepOrphanedTestKeys } from '../support/encryption-keys';

const KEY_PREFIX = 't017_e2e_';
const FIELD_KID = `${KEY_PREFIX}fld`;
const BIDX_KID = `${KEY_PREFIX}bidx`;
const FIELD_ENV = 'T017_E2E_FIELD_KEY';
const BIDX_ENV = 'T017_E2E_BLIND_KEY';

const PROBE_TABLE = 't017_probe_users';
const POLICY_PREFIX = 't017_e2e';

/**
 * A model over the TEMP probe table, defined with `sequelize.define` rather than a decorated
 * class.
 *
 * `sequelize-typescript`'s `addModels()` on an already-constructed instance leaves
 * `Model.options.hooks` uninitialised, so `addHook` throws — which is a property of *that*
 * helper, not of the hooks under test, and not something to work around inside production code.
 * `define()` returns a fully initialised `ModelStatic` and keeps the test honest.
 */
let ProbeUser: ModelStatic<Model>;

/** Row shape of the probe table, for the assertions below. */
interface ProbeRow {
  id: number;
  email: string | null;
  emailBidx: string | null;
  displayName: string | null;
}

/** `Model.get()` typed to the probe's shape — the instances are dynamic by construction. */
function probe(instance: Model | null): Partial<ProbeRow> {
  return (instance?.get({ plain: true }) ?? {}) as Partial<ProbeRow>;
}

let sequelize: Sequelize;
let fieldCrypto: FieldCryptoService;
let blindIndex: BlindIndexService;

beforeAll(async () => {
  process.env[FIELD_ENV] = randomBytes(32).toString('base64');
  process.env[BIDX_ENV] = randomBytes(32).toString('base64');

  sequelize = buildAppSequelize();
  await sequelize.authenticate();

  // T-067 — drop key rows an interrupted run left behind before booting anything that reads
  // the whole table. See `test/support/encryption-keys.ts`.
  await sweepOrphanedTestKeys(sequelize);

  await sequelize.query(
    `INSERT INTO reward_portal.encryption_keys (kid, purpose, algorithm, key_ref, status)
     VALUES (:fieldKid, 'field', 'AES-256-GCM', :fieldRef, 'rotating'),
            (:bidxKid, 'blind_index', 'HMAC-SHA256', :bidxRef, 'rotating')`,
    {
      type: QueryTypes.INSERT,
      replacements: {
        fieldKid: FIELD_KID,
        fieldRef: `env:${FIELD_ENV}`,
        bidxKid: BIDX_KID,
        bidxRef: `env:${BIDX_ENV}`,
      },
    },
  );

  // `rotating` above, then promoted here: `uq_ek_active_purpose` allows one active key per
  // purpose, and a deployment may legitimately already have one. The registry is loaded from
  // these rows and then the rows are demoted again in afterAll, so nothing about the real key
  // configuration is disturbed for longer than this file runs.
  await sequelize.query(
    `UPDATE reward_portal.encryption_keys SET status = 'active'
      WHERE kid IN (:kids)
        AND NOT EXISTS (SELECT 1 FROM reward_portal.encryption_keys e2
                         WHERE e2.purpose = reward_portal.encryption_keys.purpose
                           AND e2.status = 'active')`,
    { type: QueryTypes.UPDATE, replacements: { kids: [FIELD_KID, BIDX_KID] } },
  );

  const registry = new KeyRegistryService(sequelize, [
    new EnvKeyMaterialResolver(),
    new UnconfiguredKmsResolver(),
  ]);
  await registry.load();
  fieldCrypto = new FieldCryptoService(registry);
  blindIndex = new BlindIndexService(registry);

  await sequelize.query(
    `CREATE TEMP TABLE ${PROBE_TABLE} (
        id           int generated always as identity primary key,
        email        varchar(512) null,
        email_bidx   varchar(64)  null,
        display_name varchar(100) null
     )`,
    { type: QueryTypes.RAW },
  );

  ProbeUser = sequelize.define(
    PROBE_TABLE,
    {
      id: { type: DataType.INTEGER, autoIncrement: true, primaryKey: true },
      email: { type: DataType.STRING(512), allowNull: true },
      emailBidx: { type: DataType.STRING(64), allowNull: true, field: 'email_bidx' },
      displayName: { type: DataType.STRING(100), allowNull: true, field: 'display_name' },
    },
    { tableName: PROBE_TABLE, timestamps: false, freezeTableName: true },
  );

  installEncryptionHooks([ProbeUser], {
    policies: new PolicySet(
      [
        {
          policyKey: `${PROBE_TABLE}.email`,
          scope: 'column',
          classification: 'pii',
          atRest: 'aes_256_gcm',
          blindIndex: false,
          inTransit: 'tls_only',
          logTreatment: 'mask',
          maskStrategy: 'email',
          uiVisibility: 'masked',
          revealRoles: null,
          keyPurpose: 'field',
          enabled: true,
          note: null,
        },
      ],
      DEFAULT_DATA_PROTECTION_CONFIG,
    ),
    fieldCrypto,
    blindIndex,
  });
}, 30_000);

afterAll(async () => {
  if (sequelize === undefined) return;
  await sequelize.query(
    `DELETE FROM reward_portal.data_protection_policies WHERE policy_key LIKE :prefix`,
    { type: QueryTypes.DELETE, replacements: { prefix: `${POLICY_PREFIX}.%` } },
  );
  await sequelize.query(`DELETE FROM reward_portal.encryption_keys WHERE starts_with(kid, :p)`, {
    type: QueryTypes.DELETE,
    replacements: { p: KEY_PREFIX },
  });
  await sequelize.close();
  delete process.env[FIELD_ENV];
  delete process.env[BIDX_ENV];
});

/** Reads the probe table with raw SQL — what a `SELECT` outside the ORM actually sees. */
async function rawRead(id: number): Promise<{ email: string | null; email_bidx: string | null }> {
  const [row] = await sequelize.query<{ email: string | null; email_bidx: string | null }>(
    `SELECT email, email_bidx FROM ${PROBE_TABLE} WHERE id = :id`,
    { type: QueryTypes.SELECT, replacements: { id } },
  );
  return row;
}

describe('the migration: table and constraints', () => {
  it('created every column 07-DATA-PROTECTION.md §2 specifies', async () => {
    const columns = await sequelize.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'reward_portal' AND table_name = 'data_protection_policies'`,
      { type: QueryTypes.SELECT },
    );
    expect(columns.map((c) => c.column_name).sort()).toEqual([
      'at_rest',
      'blind_index',
      'classification',
      'created_at',
      'enabled',
      'id',
      'in_transit',
      'key_purpose',
      'log_treatment',
      'mask_strategy',
      'note',
      'policy_key',
      'reveal_roles',
      'scope',
      'ui_visibility',
      'updated_at',
    ]);
    expect(columns.find((c) => c.column_name === 'reveal_roles')?.data_type).toBe('jsonb');
  });

  /** Attempts one INSERT and returns the constraint it violated, or null if it succeeded. */
  async function rejectedBy(overrides: Record<string, unknown>): Promise<string | null> {
    const values = {
      policy_key: `${POLICY_PREFIX}.probe.col`,
      scope: 'column',
      classification: 'internal',
      at_rest: 'none',
      blind_index: false,
      in_transit: 'tls_only',
      log_treatment: 'plain',
      mask_strategy: null,
      ui_visibility: 'plain',
      reveal_roles: null,
      key_purpose: null,
      ...overrides,
    };
    try {
      await sequelize.query(
        `INSERT INTO reward_portal.data_protection_policies
             (policy_key, scope, classification, at_rest, blind_index, in_transit,
              log_treatment, mask_strategy, ui_visibility, reveal_roles, key_purpose)
         VALUES (:policy_key, :scope, :classification, :at_rest, :blind_index, :in_transit,
                 :log_treatment, :mask_strategy, :ui_visibility, CAST(:reveal_roles AS jsonb),
                 :key_purpose)`,
        { type: QueryTypes.INSERT, replacements: values },
      );
      await sequelize.query(
        `DELETE FROM reward_portal.data_protection_policies WHERE policy_key = :k`,
        { type: QueryTypes.DELETE, replacements: { k: values.policy_key } },
      );
      return null;
    } catch (error) {
      // Sequelize renders a unique violation as "Validation error" and hides the constraint on
      // `parent`; a CHECK violation keeps it in the message. Both are reported here so an
      // assertion can always name the constraint it means.
      const parent = (error as { parent?: { constraint?: string } }).parent;
      return `${(error as Error).message} ${parent?.constraint ?? ''}`;
    }
  }

  it('accepts a well-formed row', async () => {
    expect(await rejectedBy({})).toBeNull();
  });

  // TC-23 — a blind index over low-cardinality data is broken by counting, not by cracking.
  it('rejects blind_index=true on a public field (TC-23)', async () => {
    for (const classification of ['public', 'internal', 'confidential']) {
      const message = await rejectedBy({
        classification,
        blind_index: true,
        at_rest: 'aes_256_gcm',
        key_purpose: 'field',
      });
      expect(message).toContain('ck_dpp_blind_index_class');
    }
    expect(
      await rejectedBy({
        classification: 'pii',
        blind_index: true,
        at_rest: 'aes_256_gcm',
        key_purpose: 'field',
      }),
    ).toBeNull();
  });

  // TC-24 — a masked presentation with no strategy silently degrades to plain.
  it("rejects log_treatment='mask' with a null mask_strategy (TC-24)", async () => {
    expect(await rejectedBy({ log_treatment: 'mask' })).toContain('ck_dpp_mask_strategy');
    expect(await rejectedBy({ log_treatment: 'mask', mask_strategy: 'email' })).toBeNull();
  });

  it('rejects reveal_on_demand with no reveal_roles', async () => {
    expect(await rejectedBy({ ui_visibility: 'reveal_on_demand' })).toContain(
      'ck_dpp_reveal_roles',
    );
  });

  it('rejects at_rest without a key_purpose — the hook generator would have no key ring', async () => {
    expect(await rejectedBy({ at_rest: 'aes_256_gcm' })).toContain('ck_dpp_at_rest_key_purpose');
  });

  it('rejects a policy_key that is not three identifier segments', async () => {
    for (const policy_key of [`${POLICY_PREFIX}.two`, `${POLICY_PREFIX}.a.b.c`, '1bad.a.b']) {
      expect(await rejectedBy({ policy_key })).toContain('ck_dpp_key_shape');
    }
  });

  it('rejects every out-of-range enum value', async () => {
    expect(await rejectedBy({ scope: 'nope' })).toContain('ck_dpp_scope');
    expect(await rejectedBy({ classification: 'nope' })).toContain('ck_dpp_class');
    expect(await rejectedBy({ at_rest: 'rot13', key_purpose: 'field' })).toContain(
      'ck_dpp_at_rest',
    );
    expect(await rejectedBy({ in_transit: 'carrier_pigeon' })).toContain('ck_dpp_transit');
    expect(await rejectedBy({ log_treatment: 'shout' })).toContain('ck_dpp_log');
    expect(await rejectedBy({ ui_visibility: 'sometimes' })).toContain('ck_dpp_ui');
    expect(await rejectedBy({ mask_strategy: 'rot13' })).toContain('ck_dpp_mask_value');
  });

  it('rejects a duplicate policy_key', async () => {
    expect(await rejectedBy({ policy_key: SEEDED_POLICIES[0].policyKey })).toContain('uq_dpp_key');
  });
});

describe('the seeds', () => {
  // TC-22.
  it('are idempotent: re-running inserts nothing (TC-22)', async () => {
    const count = async (): Promise<number> => {
      const [row] = await sequelize.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM reward_portal.data_protection_policies`,
        { type: QueryTypes.SELECT },
      );
      return row.n;
    };

    const before = await count();
    // Exactly what the migration does, every column and `ON CONFLICT DO NOTHING` included.
    for (const seed of SEEDED_POLICIES) {
      await sequelize.query(
        `INSERT INTO reward_portal.data_protection_policies
             (policy_key, scope, classification, at_rest, blind_index, in_transit,
              log_treatment, mask_strategy, ui_visibility, reveal_roles, key_purpose, note)
         VALUES (:k, :s, :c, :a, :b, :i, :l, :m, :u, CAST(:r AS jsonb), :p, :n)
         ON CONFLICT (policy_key) DO NOTHING`,
        {
          type: QueryTypes.INSERT,
          replacements: {
            k: seed.policyKey,
            s: seed.scope,
            c: seed.classification,
            a: seed.atRest ?? 'none',
            b: seed.blindIndex ?? false,
            i: seed.inTransit ?? 'tls_only',
            l: seed.logTreatment,
            m: seed.maskStrategy ?? null,
            u: seed.uiVisibility,
            r: seed.revealRoles == null ? null : JSON.stringify(seed.revealRoles),
            p: seed.keyPurpose ?? null,
            n: seed.note,
          },
        },
      );
    }
    expect(await count()).toBe(before);
  });

  /**
   * `at_rest` is asserted against the seed for every row **except** `portal_users.email`, which a
   * later migration deliberately moves past its seeded value.
   *
   * T017_002 seeds that row `none` and documents, in a table in its own header, the four things
   * that had to change before it could be anything else. T056_001 makes those four changes and then
   * `UPDATE`s the row to `aes_256_gcm`. Both are true, in migration order, so pinning the live row
   * to the seed constant would assert that the second migration never ran. The row's *own* state is
   * asserted in full just below, and `at_rest` is what the two disagree about — nothing else is
   * exempted here.
   */
  const AT_REST_CHANGED_BY_LATER_MIGRATION = new Set(['reward_portal.portal_users.email']);

  it('are all present and readable through PolicyRepository', async () => {
    const rows = await new PolicyRepository(sequelize).findAllPolicies();
    const byKey = new Map(rows.map((row) => [row.policyKey, row]));
    for (const seed of SEEDED_POLICIES) {
      const row = byKey.get(seed.policyKey);
      expect(row).toBeDefined();
      expect(row?.classification).toBe(seed.classification);
      expect(row?.logTreatment).toBe(seed.logTreatment);
      expect(row?.uiVisibility).toBe(seed.uiVisibility);
      if (!AT_REST_CHANGED_BY_LATER_MIGRATION.has(seed.policyKey)) {
        expect(row?.atRest).toBe(seed.atRest ?? 'none');
      }
    }
  });

  it('build a valid PolicySet — every row passes validation against real data', async () => {
    const rows = await new PolicyRepository(sequelize).findAllPolicies();
    const set = new PolicySet(rows, DEFAULT_DATA_PROTECTION_CONFIG);
    expect(set.size).toBeGreaterThanOrEqual(SEEDED_POLICIES.length);
    expect(set.resolveColumn('reward_config.merchants', 'contact_email').uiVisibility).toBe(
      'reveal_on_demand',
    );
  });

  /**
   * The regression guard for `T017_002_seed_policies.ts`'s claim that every seeded column was
   * checked against the live schema before it was listed. A policy row naming a column that does
   * not exist is a silent no-op — the field is simply never protected and nothing says so.
   */
  it('name only columns that actually exist', async () => {
    const columns = await sequelize.query<{ key: string }>(
      `SELECT table_schema || '.' || table_name || '.' || column_name AS key
         FROM information_schema.columns
        WHERE table_schema IN ('reward_portal', 'reward_config')`,
      { type: QueryTypes.SELECT },
    );
    const existing = new Set(columns.map((c) => c.key));

    const missing = SEEDED_POLICIES.filter(
      (seed) => seed.scope === 'column' && !existing.has(seed.policyKey),
    ).map((seed) => seed.policyKey);

    expect(missing).toEqual([]);
  });

  /**
   * Was *"leave portal_users.email unencrypted at rest, as the migration documents"*, asserting
   * `none`/`false` — with a comment saying that the day somebody flips it this test should fail and
   * force them to read why. T-056 is that day: it made the four changes T017_002's header lists as
   * blockers, and `T056_001` flipped the row.
   *
   * `blind_index` is asserted alongside `at_rest` because the pair is what makes the column usable.
   * `at_rest` alone would encrypt the address and never maintain `email_bidx`, and since the login
   * lookup is *only* on that index the result would be a portal nobody can log into — with no error
   * anywhere, which is precisely why it is pinned here rather than left implied.
   */
  it('encrypt portal_users.email at rest, with the blind index its lookup depends on', async () => {
    const rows = await new PolicyRepository(sequelize).findAllPolicies();
    const email = rows.find((row) => row.policyKey === 'reward_portal.portal_users.email');
    expect(email?.atRest).toBe('aes_256_gcm');
    expect(email?.blindIndex).toBe(true);
    // Unchanged by T-056 — the column is still masked in logs and still shown in full in the UI.
    expect(email?.logTreatment).toBe('mask');
    expect(email?.uiVisibility).toBe('plain');
  });
});

describe('at rest, against a real table (TC-1 … TC-5)', () => {
  it('stores ciphertext and reads back plaintext, through a real INSERT (TC-1, TC-2, TC-4)', async () => {
    const created = probe(
      await ProbeUser.create({ email: 'John.Doe@Example.com', displayName: 'John' } as never),
    );

    // TC-4 — what a raw SELECT sees.
    const raw = await rawRead(created.id as number);
    expect(looksLikeCiphertext(raw.email)).toBe(true);
    expect(raw.email).not.toContain('John.Doe');

    // TC-2 — read back through the model.
    const found = probe(await ProbeUser.findByPk(created.id as number));
    expect(found.email).toBe('John.Doe@Example.com');
    expect(found.displayName).toBe('John');
  });

  it('binds the generated identity key as AAD, so a ciphertext cannot be moved between rows', async () => {
    const a = probe(await ProbeUser.create({ email: 'a@example.com' } as never));
    const b = probe(await ProbeUser.create({ email: 'b@example.com' } as never));

    const rawA = await rawRead(a.id as number);
    // Move A's ciphertext onto B's row, exactly as an attacker with UPDATE would.
    await sequelize.query(`UPDATE ${PROBE_TABLE} SET email = :ct WHERE id = :id`, {
      type: QueryTypes.UPDATE,
      replacements: { ct: rawA.email, id: b.id },
    });

    expect(probe(await ProbeUser.findByPk(b.id as number)).email).toBe(UNDECRYPTABLE_SENTINEL);
  });

  it('re-encrypts on update without double-encrypting', async () => {
    const row = await ProbeUser.create({ email: 'before@example.com' } as never);
    row.set('email', 'after@example.com');
    await row.save();

    const id = probe(row).id as number;
    expect(looksLikeCiphertext((await rawRead(id)).email)).toBe(true);
    expect(probe(await ProbeUser.findByPk(id)).email).toBe('after@example.com');
  });

  it('leaves a null column null rather than encrypting "no value"', async () => {
    const row = probe(await ProbeUser.create({ email: null, displayName: 'No email' } as never));
    expect((await rawRead(row.id as number)).email).toBeNull();
    expect(probe(await ProbeUser.findByPk(row.id as number)).email).toBeNull();
  });

  // TC-5 — one corrupted row must not deny the whole page.
  it('returns a sentinel for a corrupted row and still renders the list (TC-5)', async () => {
    const good = probe(await ProbeUser.create({ email: 'intact@example.com' } as never));
    const bad = probe(await ProbeUser.create({ email: 'corrupt@example.com' } as never));

    const rawBad = await rawRead(bad.id as number);
    // Flip the tail of the ciphertext body — GCM's tag check must catch it.
    const corrupted = `${String(rawBad.email).slice(0, -4)}AAAA`;
    await sequelize.query(`UPDATE ${PROBE_TABLE} SET email = :ct WHERE id = :id`, {
      type: QueryTypes.UPDATE,
      replacements: { ct: corrupted, id: bad.id },
    });

    const page = await ProbeUser.findAll({
      where: { id: [good.id, bad.id] as never },
      order: [['id', 'ASC']],
    });

    expect(page).toHaveLength(2);
    expect(probe(page[0]).email).toBe('intact@example.com');
    expect(probe(page[1]).email).toBe(UNDECRYPTABLE_SENTINEL);
  });

  // TC-3 — the property that makes login possible on an encrypted column.
  it('finds a row by its blind index, which is what keeps a login path working (TC-3)', async () => {
    const email = 'Lookup.User@Example.com';
    const index = blindIndex.compute(email, 'email');
    const row = probe(await ProbeUser.create({ email } as never));
    await sequelize.query(`UPDATE ${PROBE_TABLE} SET email_bidx = :b WHERE id = :id`, {
      type: QueryTypes.UPDATE,
      replacements: { b: index, id: row.id },
    });

    // The lookup a login performs: query the deterministic index, then decrypt the real column.
    const found = probe(await ProbeUser.findOne({ where: { emailBidx: index } as never }));
    expect(found.id).toBe(row.id);
    expect(found.email).toBe(email);

    // Deterministic across processes and case/whitespace-insensitive, per T-016's `email` rule.
    expect(blindIndex.compute('  lookup.user@example.com ', 'email')).toBe(index);
    // …and it is not the value: an index in a dump discloses nothing on its own.
    expect(index).not.toContain('Lookup');
    expect(index).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a set-based UPDATE on an encrypted column rather than writing plaintext', async () => {
    await expect(
      ProbeUser.update({ email: 'plaintext@example.com' } as never, { where: { id: 1 } as never }),
    ).rejects.toThrow(/never materialises a row|instance\.save/);

    // …and nothing was written.
    const [row] = await sequelize.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${PROBE_TABLE} WHERE email = 'plaintext@example.com'`,
      { type: QueryTypes.SELECT },
    );
    expect(row.n).toBe(0);
  });
});

describe('verification step 3 — the seeded PII columns as a raw SELECT sees them', () => {
  /**
   * **T-017's verification step 3, now actually satisfied.** It asks for ciphertext in
   * `portal_users.email`. That was impossible when T-017 shipped — the column was plaintext, and
   * the previous version of this test asserted so honestly rather than skipping the step — and
   * T-056 is the task that closed it.
   *
   * The row is written and read here rather than the test merely `SELECT`ing whatever happens to be
   * in the table. On a clean database `LIMIT 3` returns nothing, and a loop over zero rows asserts
   * zero things: the old shape would have passed just as happily against an empty table as against
   * a correctly encrypted one. Writing a row first is what makes this evidence.
   */
  it('portal_users.email is ciphertext at rest, and decrypts back to the address', async () => {
    const address = 'T017.Step3@Example.com';
    const userId = await sequelize
      .query<{ id: number }>(
        `INSERT INTO reward_portal.portal_users (email, email_bidx, display_name, role, status)
         VALUES (:email, :bidx, 'T-017 step 3 probe', 'super_admin', 'active')
         RETURNING id`,
        {
          type: QueryTypes.SELECT,
          replacements: {
            // Written through the same two services the application writes with. The provisional
            // AAD is re-bound below, exactly as `model-encryption.hooks.ts` does after an INSERT.
            email: fieldCrypto.encrypt(address, {
              aad: FieldCryptoService.aadFor('reward_portal.portal_users', '#new'),
            }),
            bidx: blindIndex.computeForField('reward_portal.portal_users.email', address),
          },
        },
      )
      .then(([row]) => row.id);

    try {
      await sequelize.query(`UPDATE reward_portal.portal_users SET email = :email WHERE id = :id`, {
        type: QueryTypes.UPDATE,
        replacements: {
          email: fieldCrypto.encrypt(address, {
            aad: FieldCryptoService.aadFor('reward_portal.portal_users', userId),
          }),
          id: userId,
        },
      });

      // The step itself: what a raw SELECT — a `pg_dump`, a DBA, a stolen backup — sees.
      const [row] = await sequelize.query<{ email: string; email_bidx: string }>(
        `SELECT email, email_bidx FROM reward_portal.portal_users WHERE id = :id`,
        { type: QueryTypes.SELECT, replacements: { id: userId } },
      );

      expect(looksLikeCiphertext(row.email)).toBe(true);
      expect(row.email).not.toContain('Step3');
      expect(row.email).not.toContain('Example.com');
      // The index is present and is a digest, not the address — an index in a dump discloses
      // nothing on its own.
      expect(row.email_bidx).toMatch(/^[0-9a-f]{64}$/);
      expect(row.email_bidx).not.toContain('Step3');

      // …and it is genuinely recoverable, so the column is encrypted rather than merely mangled.
      expect(
        fieldCrypto.decrypt(row.email, {
          aad: FieldCryptoService.aadFor('reward_portal.portal_users', userId),
        }),
      ).toBe(address);
    } finally {
      await sequelize.query(`DELETE FROM reward_portal.portal_users WHERE id = :id`, {
        type: QueryTypes.DELETE,
        replacements: { id: userId },
      });
    }
  });

  it('the policy row backing that column says aes_256_gcm with a blind index', async () => {
    const [policy] = await sequelize.query<{
      at_rest: string;
      blind_index: boolean;
      key_purpose: string;
    }>(
      `SELECT at_rest, blind_index, key_purpose FROM reward_portal.data_protection_policies
        WHERE policy_key = 'reward_portal.portal_users.email'`,
      { type: QueryTypes.SELECT },
    );
    expect(policy.at_rest).toBe('aes_256_gcm');
    expect(policy.blind_index).toBe(true);
    // `ck_dpp_at_rest_key_purpose` requires this alongside `at_rest`; it names the key ring.
    expect(policy.key_purpose).toBe('field');
  });
});

describe('the policy cache against real rows', () => {
  it('reads, validates and indexes every seeded row', async () => {
    const rows: DataProtectionPolicy[] = await new PolicyRepository(sequelize).findAllPolicies();
    const set = new PolicySet(rows, DEFAULT_DATA_PROTECTION_CONFIG);

    // A seeded secret is omitted from logs and absent from responses.
    const mfa = set.resolveColumn('reward_portal.portal_users', 'mfa_secret_enc');
    expect(mfa.logTreatment).toBe('omit');
    expect(mfa.uiVisibility).toBe('never');

    // TC-12 against real seeded data: `portal_users` is `secret` (mfa_secret_enc), so an
    // unlisted column of it inherits the strict default rather than being logged in full.
    const unlisted = set.resolveColumn('reward_portal.portal_users', 'preferred_locale');
    expect(unlisted.source).toBe('classification_default');
    expect(unlisted.logTreatment).toBe('omit');
  });
});
