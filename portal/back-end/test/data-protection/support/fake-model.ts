/**
 * T-017 — a Sequelize-shaped double for the hook tests.
 *
 * It implements exactly the surface `model-encryption.hooks.ts` touches — `getTableName`,
 * `getAttributes`, `primaryKeyAttribute`, `addHook`, `update`, and an instance with
 * `getDataValue`/`setDataValue`/`changed`. Driving the hooks through a double is what makes the
 * awkward branches reachable: a pk that is absent at `beforeCreate`, a `raw: true` result, a
 * corrupted ciphertext, a bulk update. `data-protection.e2e-spec.ts` covers the same paths
 * against real Postgres, and neither substitutes for the other — the same split T-016 drew
 * between `FakeDb` and `crypto.e2e-spec.ts`.
 */
import { BlindIndexService, FieldCryptoService, KeyRegistryService } from '@/common/crypto';
import { buildDefaultRegistry } from '../../crypto/support/keys';

export interface FakeAttribute {
  field?: string;
}

/** A recorded hook, so a test can invoke it directly. */
export type HookFn = (...args: unknown[]) => unknown;

/** The hook types this task installs. Anything else passed as a type is a caller bug. */
const KNOWN_HOOK_TYPES = [
  'beforeCreate',
  'beforeBulkCreate',
  'beforeUpdate',
  'beforeBulkUpdate',
  'afterCreate',
  'afterBulkCreate',
  'afterFind',
];

export class FakeInstance {
  readonly dirty = new Set<string>();

  constructor(private readonly values: Record<string, unknown>) {}

  getDataValue(key: string): unknown {
    return this.values[key];
  }

  setDataValue(key: string, value: unknown): void {
    this.values[key] = value;
    this.dirty.add(key);
  }

  changed(key: string, value?: boolean): boolean {
    if (value === false) this.dirty.delete(key);
    return this.dirty.has(key);
  }

  /** Direct access for assertions — deliberately not through `getDataValue`. */
  raw(key: string): unknown {
    return this.values[key];
  }

  get all(): Record<string, unknown> {
    return this.values;
  }
}

export class FakeModel {
  readonly hooks = new Map<string, HookFn>();
  readonly updates: { values: Record<string, unknown>; options: Record<string, unknown> }[] = [];
  updateThrows: Error | null = null;

  constructor(
    readonly name: string,
    private readonly table: { tableName: string; schema?: string } | string,
    private readonly attributes: Record<string, FakeAttribute>,
    readonly primaryKeyAttribute = 'id',
  ) {}

  getTableName(): { tableName: string; schema?: string } | string {
    return this.table;
  }

  getAttributes(): Record<string, FakeAttribute> {
    return this.attributes;
  }

  /**
   * `addHook(type, name, fn)` — the three-argument form, matching Sequelize exactly.
   *
   * An earlier version of this double accepted `(name, fn)` and happily recorded anything. The
   * production code was calling the two-argument form, which Sequelize interprets as
   * `(type, fn)` — so every hook was registered under the type `'dp:beforeCreate'`, which is not
   * a hook type, and every registration was a `TypeError` inside Sequelize's proxy table. The
   * unit suite passed; the e2e suite caught it on the first real INSERT. A double that accepts a
   * signature the real thing rejects is worse than no double, so this one asserts the shape.
   */
  addHook(type: string, name: string, fn: HookFn): void {
    if (!KNOWN_HOOK_TYPES.includes(type)) {
      throw new TypeError(
        `'${type}' is not a Sequelize hook type. addHook takes (type, name, fn) — passing the ` +
          `name first silently registers nothing.`,
      );
    }
    if (typeof fn !== 'function') {
      throw new TypeError('addHook(type, name, fn) requires all three arguments.');
    }
    this.hooks.set(name, fn);
  }

  update(values: Record<string, unknown>, options: Record<string, unknown>): Promise<unknown> {
    if (this.updateThrows !== null) return Promise.reject(this.updateThrows);
    this.updates.push({ values, options });
    return Promise.resolve([1]);
  }

  /** Invokes a registered hook by its unprefixed name. Throws if it was never installed. */
  async fire(name: string, ...args: unknown[]): Promise<unknown> {
    const fn = this.hooks.get(`dp:${name}`);
    if (fn === undefined) throw new Error(`hook dp:${name} was not installed on ${this.name}`);
    return fn(...args);
  }

  has(name: string): boolean {
    return this.hooks.has(`dp:${name}`);
  }
}

/**
 * Real crypto services over T-016's own test key registry.
 *
 * Reuses `test/crypto/support/keys.ts` rather than reimplementing it: the hooks must be tested
 * against the *actual* `FieldCryptoService` and `BlindIndexService`, because half of what they
 * guarantee (AAD binding, double-encryption refusal, the sentinel on a tag failure) is only
 * observable through real AES-GCM. Those keys are generated test material, so nothing here is a
 * committed secret (R4) — see that file's header.
 */
export interface CryptoHarness {
  registry: KeyRegistryService;
  fieldCrypto: FieldCryptoService;
  blindIndex: BlindIndexService;
}

export async function cryptoHarness(): Promise<CryptoHarness> {
  const registry = await buildDefaultRegistry();
  return {
    registry,
    fieldCrypto: new FieldCryptoService(registry),
    blindIndex: new BlindIndexService(registry),
  };
}
