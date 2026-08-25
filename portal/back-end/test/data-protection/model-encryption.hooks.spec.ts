/**
 * T-017 — enforcement point ②. TC-1 … TC-5, driven through a Sequelize-shaped double so that
 * the awkward paths are reachable: a primary key that does not exist yet, a corrupted
 * ciphertext, a `raw: true` result, a set-based UPDATE.
 *
 * Real `FieldCryptoService` and `BlindIndexService` throughout — the guarantees under test
 * (AAD binding, refusal to double-encrypt, the sentinel on a tag failure) are only observable
 * through real AES-GCM. `data-protection.e2e-spec.ts` runs the same paths against real Postgres.
 */
import { Logger } from '@nestjs/common';
import { looksLikeCiphertext, parseCiphertext } from '@/common/crypto';
import {
  attributeForColumn,
  BLIND_INDEX_SUFFIX,
  installEncryptionHooks,
  PROVISIONAL_PK,
  qualifiedTableName,
  resolveField,
  UnencryptableWriteError,
  type EncryptionHookDeps,
} from '@/common/data-protection/model-encryption.hooks';
import { UNDECRYPTABLE_SENTINEL } from '@/common/data-protection/data-protection.constants';
import { FakeInstance, FakeModel, cryptoHarness, type CryptoHarness } from './support/fake-model';
import { policy, policySet } from './support/policies';

/** `portal_users`-shaped: identity pk, encrypted email with a blind index. */
function userModel(): FakeModel {
  return new FakeModel(
    'PortalUser',
    { tableName: 'portal_users', schema: 'reward_portal' },
    {
      id: {},
      email: {},
      emailBidx: { field: 'email_bidx' },
      displayName: { field: 'display_name' },
    },
  );
}

/** `portal_sessions`-shaped: client-assigned UUID pk, one encrypted column, no blind index. */
function sessionModel(): FakeModel {
  return new FakeModel(
    'PortalSession',
    { tableName: 'portal_sessions', schema: 'reward_portal' },
    { id: {}, transportKeyEnc: { field: 'transport_key_enc' } },
  );
}

const USER_POLICIES = policySet([
  policy({
    policyKey: 'reward_portal.portal_users.email',
    classification: 'pii',
    atRest: 'aes_256_gcm',
    blindIndex: true,
    keyPurpose: 'field',
    logTreatment: 'mask',
    maskStrategy: 'email',
  }),
]);

const SESSION_POLICIES = policySet([
  policy({
    policyKey: 'reward_portal.portal_sessions.transport_key_enc',
    classification: 'secret',
    atRest: 'aes_256_gcm',
    keyPurpose: 'transport',
    logTreatment: 'omit',
    uiVisibility: 'never',
  }),
]);

let crypto: CryptoHarness;
let deps: EncryptionHookDeps;
const logs = { warn: [] as string[], error: [] as string[], log: [] as string[] };
const recorder = {
  warn: (m: unknown) => logs.warn.push(String(m)),
  error: (m: unknown) => logs.error.push(String(m)),
  log: (m: unknown) => logs.log.push(String(m)),
} as unknown as Pick<Logger, 'log' | 'warn' | 'error'>;

beforeAll(async () => {
  crypto = await cryptoHarness();
});

beforeEach(() => {
  logs.warn = [];
  logs.error = [];
  logs.log = [];
  deps = {
    policies: USER_POLICIES,
    fieldCrypto: crypto.fieldCrypto,
    blindIndex: crypto.blindIndex,
    logger: recorder,
  };
});

describe('installation', () => {
  it('installs the whole hook set on a model with an at-rest policy', () => {
    const model = userModel();
    const result = installEncryptionHooks([model as never], deps);
    for (const hook of [
      'beforeCreate',
      'beforeBulkCreate',
      'beforeUpdate',
      'beforeBulkUpdate',
      'afterCreate',
      'afterBulkCreate',
      'afterFind',
    ]) {
      expect(model.has(hook)).toBe(true);
    }
    expect(result.models).toEqual(['PortalUser']);
    expect(result.fields[0].blindIndexAttribute).toBe('emailBidx');
    expect(result.unmatched).toEqual([]);
  });

  it('installs nothing on a model with no policy, or with only non-encrypted policies', () => {
    const model = userModel();
    installEncryptionHooks([model as never], {
      ...deps,
      policies: policySet([
        policy({ policyKey: 'reward_portal.portal_users.email', classification: 'pii' }),
      ]),
    });
    expect(model.hooks.size).toBe(0);
  });

  it('is idempotent — a reload replaces hooks rather than stacking a second encrypt', () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    const first = model.hooks.get('dp:beforeCreate');
    installEncryptionHooks([model as never], deps);
    expect(model.hooks.size).toBe(7);
    expect(model.hooks.get('dp:beforeCreate')).not.toBe(first);
  });

  it('reports a policy naming a column no model exposes, loudly, and does not encrypt it', () => {
    const model = new FakeModel(
      'PortalUser',
      { tableName: 'portal_users', schema: 'reward_portal' },
      { id: {} },
    );
    const result = installEncryptionHooks([model as never], deps);
    expect(result.unmatched).toEqual(['reward_portal.portal_users.email']);
    expect(model.hooks.size).toBe(0);
    expect(logs.warn.join('\n')).toContain('will NOT be encrypted');
  });

  it('refuses to encrypt a blind-indexed column with no index attribute', () => {
    const model = new FakeModel(
      'PortalUser',
      { tableName: 'portal_users', schema: 'reward_portal' },
      { id: {}, email: {} },
    );
    expect(() => installEncryptionHooks([model as never], deps)).toThrow(UnencryptableWriteError);
    expect(() => installEncryptionHooks([model as never], deps)).toThrow(/silently/);
  });

  it('refuses a blind index on a field with no registered normalisation rule', () => {
    const model = new FakeModel(
      'Thing',
      { tableName: 'things', schema: 'x' },
      {
        id: {},
        secretCol: { field: 'secret_col' },
        secretColBidx: { field: `secret_col${BLIND_INDEX_SUFFIX}` },
      },
    );
    expect(() =>
      installEncryptionHooks([model as never], {
        ...deps,
        policies: policySet([
          policy({
            policyKey: 'x.things.secret_col',
            classification: 'secret',
            atRest: 'aes_256_gcm',
            blindIndex: true,
            keyPurpose: 'field',
          }),
        ]),
      }),
    ).toThrow(/No blind-index normalisation rule/);
  });

  it('resolves the table name in both getTableName shapes', () => {
    expect(qualifiedTableName(userModel() as never)).toBe('reward_portal.portal_users');
    expect(qualifiedTableName(new FakeModel('X', 'flat_table', { id: {} }) as never)).toBe(
      'flat_table',
    );
    expect(
      qualifiedTableName(new FakeModel('X', { tableName: 'no_schema' }, { id: {} }) as never),
    ).toBe('no_schema');
  });

  it('falls back to its own Logger when the caller supplies none', () => {
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const model = userModel();
      installEncryptionHooks([model as never], { ...deps, logger: undefined });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to model.tableName when getTableName omits it', () => {
    const model = new FakeModel('X', { schema: 's' } as never, { id: {} });
    (model as unknown as { tableName: string }).tableName = 'fallback';
    expect(qualifiedTableName(model as never)).toBe('s.fallback');
  });

  it('maps a column to its attribute, by field or by name', () => {
    const model = userModel();
    expect(attributeForColumn(model as never, 'email_bidx')).toBe('emailBidx');
    expect(attributeForColumn(model as never, 'email')).toBe('email');
    expect(attributeForColumn(model as never, 'nope')).toBeNull();
  });

  it('resolveField returns null (not a throw) for an unmatched source column', () => {
    const model = new FakeModel('X', { tableName: 't', schema: 's' }, { id: {} });
    expect(
      resolveField(model as never, 's.t', policy({ policyKey: 's.t.missing' }), recorder),
    ).toBeNull();
  });
});

describe('writes (TC-1)', () => {
  it('encrypts and computes the blind index on create (TC-1)', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    const instance = new FakeInstance({ email: 'John@Example.com', displayName: 'John' });

    await model.fire('beforeCreate', instance);

    expect(looksLikeCiphertext(instance.raw('email'))).toBe(true);
    expect(String(instance.raw('emailBidx'))).toMatch(/^[0-9a-f]{64}$/);
    // Normalised before hashing, per T-016's `email` rule.
    expect(instance.raw('emailBidx')).toBe(
      crypto.blindIndex.compute('  john@example.com ', 'email'),
    );
    // An unprotected column is untouched.
    expect(instance.raw('displayName')).toBe('John');
  });

  it('produces a different ciphertext each time — the IV is fresh (T-016 TC-2)', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    const a = new FakeInstance({ email: 'john@example.com' });
    const b = new FakeInstance({ email: 'john@example.com' });
    await model.fire('beforeCreate', a);
    await model.fire('beforeCreate', b);
    expect(a.raw('email')).not.toBe(b.raw('email'));
    // …but the blind index is deterministic, which is what makes TC-3 possible.
    expect(a.raw('emailBidx')).toBe(b.raw('emailBidx'));
  });

  it('leaves null and undefined alone rather than encrypting "no value"', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    const instance = new FakeInstance({ email: null, emailBidx: null });
    await model.fire('beforeCreate', instance);
    expect(instance.raw('email')).toBeNull();
    expect(instance.raw('emailBidx')).toBeNull();
  });

  it('never double-encrypts an existing envelope', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    const existing = crypto.fieldCrypto.encrypt('john@example.com', {
      aad: 'reward_portal.portal_users:1',
    });
    const instance = new FakeInstance({ id: 1, email: existing });
    await model.fire('beforeUpdate', instance);
    expect(instance.raw('email')).toBe(existing);
  });

  it('refuses a non-string rather than storing "[object Object]"', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    await expect(model.fire('beforeCreate', new FakeInstance({ email: { a: 1 } }))).rejects.toThrow(
      UnencryptableWriteError,
    );
  });

  it('encrypts every instance of a bulk create', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    const rows = [new FakeInstance({ email: 'a@x.com' }), new FakeInstance({ email: 'b@x.com' })];
    await model.fire('beforeBulkCreate', rows);
    for (const row of rows) expect(looksLikeCiphertext(row.raw('email'))).toBe(true);
  });
});

describe('AAD binding and the two-phase create', () => {
  it('binds the real primary key when it is known at beforeCreate', async () => {
    const model = sessionModel();
    installEncryptionHooks([model as never], { ...deps, policies: SESSION_POLICIES });
    const instance = new FakeInstance({ id: 'e5f6a7b8-1111-2222-3333-444455556666', key: null });
    instance.setDataValue('transportKeyEnc', 'session-key-material');

    await model.fire('beforeCreate', instance);
    const ciphertext = String(instance.raw('transportKeyEnc'));
    await model.fire('afterCreate', instance, {});

    // One phase: no re-bind UPDATE at all.
    expect(model.updates).toHaveLength(0);
    expect(instance.raw('transportKeyEnc')).toBe(ciphertext);
    expect(
      crypto.fieldCrypto.decrypt(ciphertext, {
        aad: 'reward_portal.portal_sessions:e5f6a7b8-1111-2222-3333-444455556666',
      }),
    ).toBe('session-key-material');
  });

  it('re-binds to the generated id after an identity insert', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    const instance = new FakeInstance({ email: 'john@example.com' });

    await model.fire('beforeCreate', instance);
    const provisional = String(instance.raw('email'));
    // Provisional ciphertext decrypts only under the placeholder AAD.
    expect(
      crypto.fieldCrypto.decrypt(provisional, {
        aad: `reward_portal.portal_users:${PROVISIONAL_PK}`,
      }),
    ).toBe('john@example.com');

    instance.setDataValue('id', 42);
    await model.fire('afterCreate', instance, { transaction: 'T' });

    expect(model.updates).toHaveLength(1);
    expect(model.updates[0].options).toMatchObject({ hooks: false, transaction: 'T' });
    expect(model.updates[0].options.where).toEqual({ id: 42 });

    const bound = String(instance.raw('email'));
    expect(bound).not.toBe(provisional);
    expect(crypto.fieldCrypto.decrypt(bound, { aad: 'reward_portal.portal_users:42' })).toBe(
      'john@example.com',
    );
    // The re-bind is not a caller change; the attribute must not be left dirty.
    expect(instance.changed('email')).toBe(false);
  });

  it('binds a ciphertext to its row, so one copied into another row will not decrypt', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    const instance = new FakeInstance({ email: 'john@example.com' });
    await model.fire('beforeCreate', instance);
    instance.setDataValue('id', 42);
    await model.fire('afterCreate', instance, {});

    expect(() =>
      crypto.fieldCrypto.decrypt(String(instance.raw('email')), {
        aad: 'reward_portal.portal_users:43',
      }),
    ).toThrow();
  });

  it('fails the write when the insert produced no primary key', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    const instance = new FakeInstance({ email: 'john@example.com' });
    await model.fire('beforeCreate', instance);
    await expect(model.fire('afterCreate', instance, {})).rejects.toThrow(
      /transaction must roll back/,
    );
  });

  it('does nothing on afterCreate when there is no ciphertext to re-bind', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    await model.fire('afterCreate', new FakeInstance({ id: 42, email: null }), {});
    expect(model.updates).toHaveLength(0);
  });

  it('issues no UPDATE when the marked instance has had its ciphertext cleared', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    const instance = new FakeInstance({ email: 'john@example.com' });
    await model.fire('beforeCreate', instance);
    // The insert is owed a re-bind, but a caller (or a partial column list) removed the value.
    instance.setDataValue('email', null);
    instance.setDataValue('id', 42);

    await model.fire('afterCreate', instance, {});
    expect(model.updates).toHaveLength(0);
  });

  it('re-binds every instance of a bulk create', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    const rows = [new FakeInstance({ email: 'a@x.com' }), new FakeInstance({ email: 'b@x.com' })];
    await model.fire('beforeBulkCreate', rows);
    rows[0].setDataValue('id', 1);
    rows[1].setDataValue('id', 2);
    await model.fire('afterBulkCreate', rows, {});
    expect(model.updates).toHaveLength(2);
  });

  it('degrades the AAD when bindRecordIdAsAAD is off — a documented downgrade', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], { ...deps, bindRecordIdAsAAD: false });
    const instance = new FakeInstance({ email: 'john@example.com' });
    await model.fire('beforeCreate', instance);
    instance.setDataValue('id', 42);
    await model.fire('afterCreate', instance, {});

    // No re-bind, because the AAD does not depend on the row at all.
    expect(model.updates).toHaveLength(0);
    expect(
      crypto.fieldCrypto.decrypt(String(instance.raw('email')), {
        aad: 'reward_portal.portal_users:unbound',
      }),
    ).toBe('john@example.com');
  });
});

describe('set-based UPDATE is refused, not silently written as plaintext', () => {
  it('throws when a bulk update touches an encrypted column', () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    expect(() => model.hooks.get('dp:beforeBulkUpdate')?.({ fields: ['email'] })).toThrow(
      UnencryptableWriteError,
    );
    expect(() => model.hooks.get('dp:beforeBulkUpdate')?.({ attributes: { email: 'x' } })).toThrow(
      /instance.save\(\)/,
    );
  });

  it('allows a bulk update that touches no encrypted column', () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    expect(() =>
      model.hooks.get('dp:beforeBulkUpdate')?.({ fields: ['displayName'] }),
    ).not.toThrow();
    expect(() => model.hooks.get('dp:beforeBulkUpdate')?.({})).not.toThrow();
  });

  it('allows it when individualHooks is on, because beforeUpdate will then run per row', () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    expect(() =>
      model.hooks.get('dp:beforeBulkUpdate')?.({ fields: ['email'], individualHooks: true }),
    ).not.toThrow();
  });
});

describe('reads (TC-2, TC-5)', () => {
  async function encryptedUser(id: number, email: string): Promise<FakeInstance> {
    return new FakeInstance({
      id,
      email: crypto.fieldCrypto.encrypt(email, { aad: `reward_portal.portal_users:${String(id)}` }),
    });
  }

  it('decrypts transparently on find (TC-2)', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    const row = await encryptedUser(7, 'john@example.com');
    await model.fire('afterFind', row);
    expect(row.raw('email')).toBe('john@example.com');
    // Decryption is not a caller change.
    expect(row.changed('email')).toBe(false);
  });

  it('decrypts an array and a findAndCountAll result', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    const rows = [await encryptedUser(1, 'a@x.com'), await encryptedUser(2, 'b@x.com')];
    await model.fire('afterFind', rows);
    expect(rows.map((r) => r.raw('email'))).toEqual(['a@x.com', 'b@x.com']);

    const counted = { count: 1, rows: [await encryptedUser(3, 'c@x.com')] };
    await model.fire('afterFind', counted);
    expect(counted.rows[0].raw('email')).toBe('c@x.com');
  });

  it('decrypts a raw: true plain object, which has no getDataValue', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    const raw: Record<string, unknown> = {
      id: 9,
      email: crypto.fieldCrypto.encrypt('raw@x.com', { aad: 'reward_portal.portal_users:9' }),
    };
    await model.fire('afterFind', raw);
    expect(raw.email).toBe('raw@x.com');
  });

  // TC-5 — one corrupted row must not deny the whole page.
  it('returns a sentinel and logs at error for an undecryptable value (TC-5)', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    const good = await encryptedUser(1, 'good@x.com');
    // Same shape, wrong row: the AAD check fails, exactly as a tampered or copied value would.
    const bad = new FakeInstance({
      id: 2,
      email: crypto.fieldCrypto.encrypt('other@x.com', { aad: 'reward_portal.portal_users:999' }),
    });

    await model.fire('afterFind', [good, bad]);

    expect(good.raw('email')).toBe('good@x.com');
    expect(bad.raw('email')).toBe(UNDECRYPTABLE_SENTINEL);
    expect(logs.error).toHaveLength(1);
    expect(logs.error[0]).toContain('reward_portal.portal_users:2');
  });

  it('never writes the ciphertext into the error log — that would trip our own sweep', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    const ciphertext = crypto.fieldCrypto.encrypt('x@x.com', {
      aad: 'reward_portal.portal_users:999',
    });
    await model.fire('afterFind', new FakeInstance({ id: 2, email: ciphertext }));
    expect(logs.error[0]).not.toContain(ciphertext);
    expect(logs.error[0]).not.toContain('v1.');
  });

  it('ignores a null result, a plaintext value and a row with no primary key', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    await expect(model.fire('afterFind', null)).resolves.toBeUndefined();
    await expect(model.fire('afterFind', undefined)).resolves.toBeUndefined();
    await expect(model.fire('afterFind', 'not a row')).resolves.toBeUndefined();

    const plain = new FakeInstance({ id: 1, email: 'already-plaintext@x.com' });
    await model.fire('afterFind', plain);
    expect(plain.raw('email')).toBe('already-plaintext@x.com');

    const noPk = new FakeInstance({ email: 'v1.a.b.c.d' });
    await model.fire('afterFind', noPk);
    expect(noPk.raw('email')).toBe('v1.a.b.c.d');

    const nullField = new FakeInstance({ id: 1, email: null });
    await model.fire('afterFind', nullField);
    expect(nullField.raw('email')).toBeNull();
  });
});

describe('round trip through the real primitives', () => {
  it('create → find gives back exactly what went in, and the stored form is ciphertext', async () => {
    const model = userModel();
    installEncryptionHooks([model as never], deps);
    const instance = new FakeInstance({ email: 'Round.Trip@Example.COM' });

    await model.fire('beforeCreate', instance);
    instance.setDataValue('id', 101);
    await model.fire('afterCreate', instance, {});

    const stored = String(instance.raw('email'));
    // TC-4's property, at unit level: what a raw SELECT would see.
    expect(stored).not.toContain('Round.Trip');
    expect(parseCiphertext(stored).version).toBe('v1');

    await model.fire('afterFind', instance);
    expect(instance.raw('email')).toBe('Round.Trip@Example.COM');
  });
});
