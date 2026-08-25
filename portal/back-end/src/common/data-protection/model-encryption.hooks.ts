/**
 * T-017 — enforcement point ②, at rest (07-DATA-PROTECTION.md §6, implementation note 3).
 *
 * > *"Sequelize hooks are **generated from the policy table at boot**, not hand-written per
 * > model. `beforeCreate`/`beforeUpdate` encrypt and compute blind indexes; `afterFind`
 * > decrypts. A developer writing `user.email = x` must not need to know."*
 *
 * ---
 *
 * ## Four problems this file solves, none of which is obvious from the sentence above
 *
 * ### 1. The AAD is the record's primary key, which does not exist during `beforeCreate`
 *
 * §4 binds the record's identity in as additional authenticated data, so a ciphertext lifted from
 * row A into row B fails its tag check. But `portal_users.id` is `int generated always as
 * identity`: the value is assigned by Postgres during the INSERT, so at `beforeCreate` there is
 * nothing to bind. The three ways out, and why this file takes the third:
 *
 *  - *Bind something else* (table+column only). Reopens the ciphertext-swap attack §4 exists to
 *    close, permanently, for the sake of one INSERT. No.
 *  - *Write plaintext, then encrypt in `afterCreate`.* Plaintext touches the database. No.
 *  - **Encrypt under a provisional AAD, then re-bind in `afterCreate`** once the real id is
 *    known. Only ciphertext is ever written; the re-bind is an UPDATE inside the same
 *    transaction. This is what {@link PROVISIONAL_PK} implements.
 *
 * The cost is one extra UPDATE per INSERT on an encrypted table. That is acceptable for user and
 * session creation, and it is *not* acceptable for a table with an immutability trigger — see
 * problem 4.
 *
 * When the primary key **is** available at `beforeCreate` (a client-assigned UUID, as
 * `portal_sessions.id` is), the provisional step is skipped entirely and the ciphertext is bound
 * to the real id on the first write.
 *
 * ### 2. A bulk UPDATE has no instance, so it cannot be encrypted — and must not be allowed
 *
 * `ScopedRepository.update()` compiles to `Model.update(values, { where })`, a set-based
 * statement that never materialises a row. There is no id to bind and no instance to transform,
 * so `beforeBulkUpdate` **throws** when the update touches an encrypted column. Failing the write
 * is the only fail-closed option: silently letting it through writes plaintext into a column
 * everything else assumes is ciphertext, and the `afterFind` hook would then hand that plaintext
 * back as though it had decrypted it. The error names the two supported alternatives
 * (`instance.save()`, or `individualHooks: true`).
 *
 * ### 3. Re-encrypting an already-encrypted value would destroy it
 *
 * `afterFind` decrypts, so a loaded-then-saved instance holds plaintext and re-encrypts
 * correctly. But an instance built from a raw query, or a value assigned from another row, may
 * already be a `v1.…` envelope — and encrypting it again produces a ciphertext whose plaintext is
 * a ciphertext, which decrypts to gibberish exactly once and is then unrecoverable. Every write
 * path therefore checks {@link looksLikeCiphertext} first and leaves an existing envelope alone.
 * The same check makes the hooks idempotent, which is what allows the `afterCreate` re-bind to be
 * safe to retry.
 *
 * ### 4. One bad row must not deny the whole page
 *
 * Implementation note 3: *"Decryption failure on read must **not** crash a list endpoint: log at
 * `error`, return a sentinel (`<undecryptable>`), and continue."* (TC-5.) A `DecryptionError` in
 * `afterFind` is caught per field, per row.
 *
 * The inverse is deliberately **not** true on the write path: a failure to *encrypt* throws and
 * fails the write. Degrading there would mean storing plaintext, and a write that half-succeeds
 * into a protected column is not a degraded outcome, it is a breach.
 *
 * ## What this file does not do
 *
 * It never decides *which* columns are encrypted — that is a policy row, read at boot. Adding a
 * protected column is a policy row plus a migration, in both directions, which is the entire
 * point of 07-DATA-PROTECTION.md §1.
 */
import { Logger } from '@nestjs/common';
import type { Model, ModelStatic } from 'sequelize';
import {
  BlindIndexService,
  FieldCryptoService,
  looksLikeCiphertext,
  normaliserForField,
  type BlindIndexNormaliserName,
} from '@/common/crypto';
import { UNDECRYPTABLE_SENTINEL } from './data-protection.constants';
import type { DataProtectionPolicy, PolicyLookup } from './policy.service';

/**
 * The primary-key stand-in used while a row has no id yet. See problem 1 in the file header.
 *
 * A literal that no real key can collide with: primary keys in this schema are positive integers
 * and UUIDs, and `#new` contains a character neither of those alphabets uses. A collision would
 * mean a real row's ciphertext validated against the provisional AAD, which is the one thing the
 * two-phase scheme must not permit.
 */
export const PROVISIONAL_PK = '#new';

/** The `_bidx` suffix convention — `email` ⇒ `email_bidx` (07-DATA-PROTECTION.md §6). */
export const BLIND_INDEX_SUFFIX = '_bidx';

/** One encrypted column of one model, resolved from a policy row to concrete attribute names. */
export interface EncryptedField {
  /** Schema-qualified table, e.g. `reward_portal.portal_users`. */
  readonly table: string;
  /** Database column name — `contact_email`. */
  readonly column: string;
  /** Sequelize attribute name — `contactEmail`. */
  readonly attribute: string;
  /** Attribute holding the blind index, or `null` when the policy does not ask for one. */
  readonly blindIndexAttribute: string | null;
  readonly normaliser: BlindIndexNormaliserName | null;
  readonly policyKey: string;
}

export interface EncryptionHookDeps {
  readonly policies: PolicyLookup;
  readonly fieldCrypto: FieldCryptoService;
  readonly blindIndex: BlindIndexService;
  /** From `config.atRest.bindRecordIdAsAAD`. Turning it off is a security decision (§4). */
  readonly bindRecordIdAsAAD?: boolean;
  readonly logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
}

/** What {@link installEncryptionHooks} did, for the boot log and for the tests. */
export interface InstalledHooks {
  readonly models: readonly string[];
  readonly fields: readonly EncryptedField[];
  /** Policy rows that named a column no model exposes. Loud, because it means a silent no-op. */
  readonly unmatched: readonly string[];
}

/** Raised when a write cannot be encrypted safely. Never downgraded to a warning — see problem 2. */
export class UnencryptableWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnencryptableWriteError';
    Error.captureStackTrace?.(this, UnencryptableWriteError);
  }
}

/** The hook name prefix, so a re-install can find and skip what it already added. */
const HOOK_PREFIX = 'dp:';

/**
 * The subset of Sequelize's `UpdateOptions` this file reads.
 *
 * Declared structurally rather than imported: `UpdateOptions<TAttributes>` types `fields` as
 * `(keyof TAttributes)[]`, i.e. `string | number | symbol`, which is not assignable to
 * `readonly string[]`. Widening it here — and stringifying at the point of use — keeps the file
 * free of `any` and `@ts-ignore` (R8) while being honest that the values are attribute names.
 */
interface BulkUpdateOptions {
  fields?: readonly (string | number | symbol)[];
  attributes?: Record<string, unknown>;
  individualHooks?: boolean;
}

/**
 * A Sequelize instance, or the plain object a `raw: true` query returns.
 *
 * The methods are optional because the `raw` form has none of them; every read and write below
 * goes through {@link readAttribute}/{@link writeAttribute}, which branch on their presence. This
 * type exists so that branching needs no `any` and no assertion at each call site — just one, in
 * {@link asRow}, with this comment on it.
 */
type RowLike = Record<string, unknown> & {
  getDataValue?: (key: string) => unknown;
  setDataValue?: (key: string, value: unknown) => void;
  changed?: (key: string, dirty?: boolean) => unknown;
};

/**
 * The one narrowing in this file (R8: no `any`, and none is used — `Model` is a class with
 * declared members, so widening it to an index signature needs the two-step cast).
 *
 * It is sound: every property access that follows is guarded, and every method call is guarded by
 * a `typeof === 'function'` check.
 */
function asRow(value: object): RowLike {
  return value as unknown as RowLike;
}

/**
 * Installs encryption hooks on every supplied model, generated from the policy table.
 *
 * Idempotent: hooks are registered under stable names (`dp:beforeCreate`, …) and Sequelize
 * replaces a hook of the same name rather than stacking a second one. That matters because a
 * policy reload re-invokes this function, and a stacked hook would encrypt twice.
 */
export function installEncryptionHooks(
  models: readonly ModelStatic<Model>[],
  deps: EncryptionHookDeps,
): InstalledHooks {
  const logger = deps.logger ?? new Logger('DataProtectionHooks');
  const installed: string[] = [];
  const fields: EncryptedField[] = [];
  const unmatched: string[] = [];

  for (const model of models) {
    const table = qualifiedTableName(model);
    const policies = deps.policies
      .columnPoliciesFor(table)
      .filter((policy) => policy.atRest === 'aes_256_gcm');
    if (policies.length === 0) continue;

    const resolved: EncryptedField[] = [];
    for (const policy of policies) {
      const field = resolveField(model, table, policy, logger);
      if (field === null) {
        unmatched.push(policy.policyKey);
        continue;
      }
      resolved.push(field);
    }
    if (resolved.length === 0) continue;

    attachHooks(model, resolved, deps, logger);
    installed.push(model.name);
    fields.push(...resolved);
  }

  logger.log(
    `Encryption hooks installed on ${String(installed.length)} model(s), ` +
      `${String(fields.length)} column(s): ${fields.map((f) => f.policyKey).join(', ') || 'none'}.`,
  );
  if (unmatched.length > 0) {
    logger.warn(
      `${String(unmatched.length)} at-rest policy row(s) name a column no model exposes and are ` +
        `therefore doing nothing: ${unmatched.join(', ')}. Either the model is missing the ` +
        `attribute or the policy_key is wrong — both are silent data-protection failures.`,
    );
  }

  return { models: installed, fields, unmatched };
}

/** `reward_portal.portal_users`, whatever form `getTableName()` returns. */
export function qualifiedTableName(model: ModelStatic<Model>): string {
  const raw: unknown = model.getTableName();
  if (typeof raw === 'string') return raw;
  const parts = raw as { tableName?: string; schema?: string };
  const name = parts.tableName ?? model.tableName;
  return parts.schema === undefined ? name : `${parts.schema}.${name}`;
}

/**
 * Maps a policy's column to a Sequelize attribute, or `null` with a warning.
 *
 * Returning `null` rather than throwing is deliberate: a policy row naming a column that this
 * build's model does not have is a *configuration* problem (a newer deployment, a typo), and
 * refusing to boot the whole application over it would be a self-inflicted outage. It is reported
 * loudly instead — `unmatched` in the result, plus a `warn` — because the failure mode is
 * otherwise invisible: the column is simply never encrypted and nothing says so.
 */
export function resolveField(
  model: ModelStatic<Model>,
  table: string,
  policy: DataProtectionPolicy,
  logger: Pick<Logger, 'warn'>,
): EncryptedField | null {
  const column = policy.policyKey.slice(policy.policyKey.lastIndexOf('.') + 1);
  const attribute = attributeForColumn(model, column);
  if (attribute === null) {
    logger.warn(
      `Policy '${policy.policyKey}' has at_rest=aes_256_gcm but ${model.name} exposes no ` +
        `attribute for column '${column}'. The column will NOT be encrypted.`,
    );
    return null;
  }

  let blindIndexAttribute: string | null = null;
  let normaliser: BlindIndexNormaliserName | null = null;

  if (policy.blindIndex) {
    blindIndexAttribute = attributeForColumn(model, `${column}${BLIND_INDEX_SUFFIX}`);
    if (blindIndexAttribute === null) {
      // Hard failure, unlike the missing source column above: the policy says this field is the
      // lookup key, and encrypting it without maintaining the index makes every equality query
      // against it return nothing — a login that silently stops working for new rows only.
      throw new UnencryptableWriteError(
        `Policy '${policy.policyKey}' sets blind_index=true, but ${model.name} has no attribute ` +
          `for column '${column}${BLIND_INDEX_SUFFIX}'. Encrypting the source column without its ` +
          `blind index would make every lookup by that field fail to match, silently. Add the ` +
          `column and the attribute, or clear blind_index on the policy row.`,
      );
    }
    // Throws for a field with no registered normalisation rule — T-016's fail-closed default.
    normaliser = normaliserForField(policy.policyKey);
  }

  return {
    table,
    column,
    attribute,
    blindIndexAttribute,
    normaliser,
    policyKey: policy.policyKey,
  };
}

/** Attribute whose `field` (or own name) is `column`, or `null`. */
export function attributeForColumn(model: ModelStatic<Model>, column: string): string | null {
  const attributes = model.getAttributes() as Record<string, { field?: string } | undefined>;
  for (const [name, definition] of Object.entries(attributes)) {
    if ((definition?.field ?? name) === column) return name;
  }
  return null;
}

// --- the hooks ---------------------------------------------------------------------------------

function attachHooks(
  model: ModelStatic<Model>,
  fields: readonly EncryptedField[],
  deps: EncryptionHookDeps,
  logger: Pick<Logger, 'log' | 'warn' | 'error'>,
): void {
  const table = qualifiedTableName(model);
  const pkAttribute = model.primaryKeyAttribute;

  // `addHook(type, name, fn)` — the **three**-argument form. The two-argument form treats its
  // first argument as the hook *type*, so `addHook('dp:beforeCreate', fn)` looks like a
  // registration and is in fact a `TypeError` deep inside Sequelize's hook proxy table. Naming
  // every hook is what makes `installEncryptionHooks` idempotent: Sequelize replaces a hook of
  // the same name rather than stacking a second one, and a stacked hook encrypts twice.
  model.addHook('beforeCreate', `${HOOK_PREFIX}beforeCreate`, (instance: Model) => {
    encryptInstance(instance, fields, deps, table, pkAttribute);
  });

  model.addHook('beforeBulkCreate', `${HOOK_PREFIX}beforeBulkCreate`, (instances: Model[]) => {
    for (const instance of instances) {
      encryptInstance(instance, fields, deps, table, pkAttribute);
    }
  });

  model.addHook('beforeUpdate', `${HOOK_PREFIX}beforeUpdate`, (instance: Model) => {
    encryptInstance(instance, fields, deps, table, pkAttribute);
  });

  // Problem 2 in the file header. `options.fields` is the attribute list Sequelize will write.
  model.addHook(
    'beforeBulkUpdate',
    `${HOOK_PREFIX}beforeBulkUpdate`,
    (options: BulkUpdateOptions) => {
      if (options.individualHooks === true) return;
      const written = new Set<string>([
        ...(options.fields ?? []).map((field) => String(field)),
        ...Object.keys(options.attributes ?? {}),
      ]);
      const touched = fields.filter((field) => written.has(field.attribute));
      if (touched.length === 0) return;
      throw new UnencryptableWriteError(
        `A set-based UPDATE on ${model.name} touches encrypted column(s) ` +
          `${touched.map((f) => f.column).join(', ')}. Such a statement never materialises a row, ` +
          `so there is no primary key to bind as AAD (07-DATA-PROTECTION.md §4) and the value ` +
          `would be written as plaintext. Load the row and call instance.save(), or pass ` +
          `individualHooks: true.`,
      );
    },
  );

  // The `afterCreate` re-bind. Only does work when the pk was unknown at `beforeCreate`.
  model.addHook(
    'afterCreate',
    `${HOOK_PREFIX}afterCreate`,
    async (instance: Model, options: { transaction?: unknown }) => {
      await rebindAfterCreate(model, instance, fields, deps, table, pkAttribute, options);
    },
  );

  model.addHook(
    'afterBulkCreate',
    `${HOOK_PREFIX}afterBulkCreate`,
    async (instances: Model[], options: { transaction?: unknown }) => {
      for (const instance of instances) {
        await rebindAfterCreate(model, instance, fields, deps, table, pkAttribute, options);
      }
    },
  );

  model.addHook('afterFind', `${HOOK_PREFIX}afterFind`, (result: unknown) => {
    decryptResult(result, fields, deps, table, pkAttribute, logger);
  });
}

/**
 * Encrypts every protected attribute of one instance in place, and recomputes its blind index.
 *
 * The blind index is computed from the **plaintext**, before encryption, and only when the source
 * attribute actually changed — recomputing it from a value that is already a ciphertext would
 * index the envelope rather than the value, which is the same class of bug as double-encrypting.
 */
function encryptInstance(
  instance: Model,
  fields: readonly EncryptedField[],
  deps: EncryptionHookDeps,
  table: string,
  pkAttribute: string,
): void {
  const pk = primaryKeyOf(asRow(instance), pkAttribute);
  const aad = aadFor(table, pk ?? PROVISIONAL_PK, deps);

  for (const field of fields) {
    const value: unknown = instance.getDataValue(field.attribute as never);
    if (value === null || value === undefined) continue;
    if (looksLikeCiphertext(value)) continue; // Problem 3 — already an envelope.

    if (typeof value !== 'string') {
      throw new UnencryptableWriteError(
        `${field.policyKey} is configured at_rest=aes_256_gcm but received a ` +
          `${typeof value}. Serialise it at the call site: an implicit String() here would ` +
          `store "[object Object]" and lose the value irrecoverably.`,
      );
    }

    if (field.blindIndexAttribute !== null && field.normaliser !== null) {
      instance.setDataValue(
        field.blindIndexAttribute as never,
        deps.blindIndex.compute(value, field.normaliser) as never,
      );
    }

    instance.setDataValue(
      field.attribute as never,
      deps.fieldCrypto.encrypt(value, { aad }) as never,
    );
    // Only now — after something was actually encrypted under the placeholder — is a re-bind
    // owed. Marking on entry instead would schedule an UPDATE for an insert that encrypted
    // nothing (every protected column null), which is a wasted statement on every such row.
    //
    // Nothing is owed when record binding is switched off either: the AAD is then
    // `<table>:unbound` whatever the primary key turns out to be, so the ciphertext written here
    // is already final.
    if (pk === null && deps.bindRecordIdAsAAD !== false) PROVISIONALLY_BOUND.add(instance);
  }
}

/**
 * Instances whose ciphertext is bound to {@link PROVISIONAL_PK} and still owes a re-bind.
 *
 * A `WeakSet` rather than a flag on the instance: it adds no enumerable property (which would
 * reach the log serialiser, the response interceptor and Sequelize's own `changed` tracking) and
 * it cannot keep an instance alive. Membership — not a comparison of AADs — is what
 * `rebindAfterCreate` keys on, because "the two AADs differ" is *also* true for a table whose
 * primary key was known all along, and re-binding one of those would try to decrypt a correctly
 * bound ciphertext under the placeholder AAD and fail the insert.
 */
const PROVISIONALLY_BOUND = new WeakSet<object>();

/**
 * Re-encrypts the provisional ciphertext under the real primary key, inside the same transaction.
 *
 * Skipped entirely when the pk was already known at `beforeCreate` — the common case for a
 * UUID-keyed table, and the reason this is not a blanket cost on every insert.
 *
 * The UPDATE goes through `Model.update` with a primary-key WHERE and `hooks: false`. Hooks are
 * off because the value being written is *already* the correct ciphertext; running
 * `beforeBulkUpdate` would (correctly) refuse it, and running `beforeUpdate` would re-encrypt an
 * envelope.
 *
 * The model is passed in from the installer's closure rather than read off `instance.constructor`.
 * Both work in Sequelize; only the first works when the instance is a plain object with a
 * prototype of its own, which is what a `raw` row and every test double are — and reaching for
 * `constructor` is the kind of coupling that fails at the worst moment rather than at the first.
 */
async function rebindAfterCreate(
  model: ModelStatic<Model>,
  instance: Model,
  fields: readonly EncryptedField[],
  deps: EncryptionHookDeps,
  table: string,
  pkAttribute: string,
  options: { transaction?: unknown } | undefined,
): Promise<void> {
  // The pk was known at `beforeCreate`, so the ciphertext is already bound to the real row and
  // there is nothing owed. This is the common case for a UUID-keyed table, and the reason the
  // two-phase write is not a blanket cost on every insert.
  if (!PROVISIONALLY_BOUND.has(instance)) return;
  PROVISIONALLY_BOUND.delete(instance);

  const pk = primaryKeyOf(asRow(instance), pkAttribute);
  if (pk === null) {
    throw new UnencryptableWriteError(
      `${table} has no primary key value after INSERT, so the provisional ciphertext written by ` +
        `beforeCreate cannot be re-bound to the record id. The row now holds ciphertext that ` +
        `will not decrypt; the transaction must roll back.`,
    );
  }

  const provisionalAad = aadFor(table, PROVISIONAL_PK, deps);
  const finalAad = aadFor(table, pk, deps);

  const rebound: Record<string, unknown> = {};
  for (const field of fields) {
    const value: unknown = instance.getDataValue(field.attribute as never);
    if (typeof value !== 'string' || !looksLikeCiphertext(value)) continue;

    const plaintext = deps.fieldCrypto.decrypt(value, { aad: provisionalAad });
    const bound = deps.fieldCrypto.encrypt(plaintext, { aad: finalAad });
    instance.setDataValue(field.attribute as never, bound as never);
    rebound[field.attribute] = bound;
  }
  if (Object.keys(rebound).length === 0) return;

  await model.update(rebound, {
    where: { [pkAttribute]: pk } as never,
    hooks: false,
    transaction: options?.transaction as never,
  });

  // The instance now matches the row again; without this a caller that saves it later would send
  // Sequelize a `changed` set containing the re-bound columns and re-encrypt an envelope.
  for (const attribute of Object.keys(rebound)) {
    instance.changed(attribute as never, false);
  }
}

/**
 * Decrypts a find result in place — instance, array, or `{ rows }` from `findAndCountAll`.
 *
 * `raw: true` queries return plain objects with no `getDataValue`; those are decrypted through
 * their own properties. That path matters because `ScopedRepository` does not forbid `raw`, and a
 * raw read of an encrypted column would otherwise hand a caller the envelope.
 */
function decryptResult(
  result: unknown,
  fields: readonly EncryptedField[],
  deps: EncryptionHookDeps,
  table: string,
  pkAttribute: string,
  logger: Pick<Logger, 'error'>,
): void {
  if (result === null || result === undefined) return;

  if (Array.isArray(result)) {
    for (const row of result) decryptResult(row, fields, deps, table, pkAttribute, logger);
    return;
  }

  if (
    typeof result === 'object' &&
    'rows' in result &&
    Array.isArray((result as { rows: unknown[] }).rows)
  ) {
    decryptResult((result as { rows: unknown[] }).rows, fields, deps, table, pkAttribute, logger);
    return;
  }

  if (typeof result !== 'object') return;

  const row = asRow(result);
  const pk = primaryKeyOf(row, pkAttribute);
  if (pk === null) return;
  const aad = aadFor(table, pk, deps);

  for (const field of fields) {
    const current = readAttribute(row, field.attribute);
    if (current === null || current === undefined) continue;
    if (!looksLikeCiphertext(current)) continue;

    try {
      writeAttribute(row, field.attribute, deps.fieldCrypto.decrypt(current as string, { aad }));
    } catch (error) {
      // Problem 4 — one bad row must not deny the page (TC-5). Logged at `error` with the
      // record's identity and *never* the ciphertext: an envelope in a log is exactly what the
      // serialiser's final sweep exists to catch, and emitting one here would trip our own alarm.
      logger.error(
        `Decryption failed for ${field.policyKey} on ${table}:${String(pk)} ` +
          `(${(error as Error).message}). Returning '${UNDECRYPTABLE_SENTINEL}' for this field ` +
          `so the request still succeeds. This row needs investigation: either its ciphertext ` +
          `was tampered with, it was copied from another row (the AAD check), or its key is gone.`,
      );
      writeAttribute(row, field.attribute, UNDECRYPTABLE_SENTINEL);
    }
  }
}

// --- small helpers -----------------------------------------------------------------------------

/**
 * `aadFor`, honouring `config.atRest.bindRecordIdAsAAD`.
 *
 * When binding is switched off the AAD degrades to the table name alone — still authenticated,
 * so the envelope's header cannot be rewritten, but no longer row-bound. §4 says record binding
 * closes the ciphertext-swap attack, so this is a documented security downgrade and the flag
 * exists only because §10 defines it.
 */
function aadFor(table: string, pk: string | number, deps: EncryptionHookDeps): string {
  return deps.bindRecordIdAsAAD === false
    ? FieldCryptoService.aadFor(table, 'unbound')
    : FieldCryptoService.aadFor(table, pk);
}

/** The instance's primary key, or `null` when it has not been assigned yet. */
function primaryKeyOf(row: RowLike, pkAttribute: string): string | number | null {
  const value = readAttribute(row, pkAttribute);
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'number' ? value : String(value);
}

/** Reads through `getDataValue` when present (a model instance), by property otherwise (`raw`). */
function readAttribute(row: RowLike, attribute: string): unknown {
  if (typeof row.getDataValue === 'function') return row.getDataValue(attribute);
  return row[attribute];
}

/** @see readAttribute */
function writeAttribute(row: RowLike, attribute: string, value: unknown): void {
  if (typeof row.setDataValue === 'function') {
    row.setDataValue(attribute, value);
    // `setDataValue` marks the attribute dirty; decryption is not a change the caller made, and
    // leaving it dirty would make a later `save()` write the plaintext back through a path that
    // re-encrypts it under a *new* IV for no reason — or, on a `raw` instance, as plaintext.
    if (typeof row.changed === 'function') row.changed(attribute, false);
    return;
  }
  row[attribute] = value;
}
