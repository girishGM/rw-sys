/**
 * T-016 unit-test support — building key registries without a database.
 *
 * Every key here is a *test* key generated from a seed byte, so the file contains no secret
 * and `npm run scan:secrets` has nothing to find. They are never valid anywhere: 32 identical
 * bytes is exactly the sort of key the registry would happily accept and no operator would
 * ever generate. That is fine for round-trip and branch tests; it is not fine for the
 * distinctness assertions, which is why `keyMaterial()` takes a seed.
 */
import {
  EnvKeyMaterialResolver,
  KeyRegistryService,
  UnconfiguredKmsResolver,
  type KeyMaterialResolver,
} from '@/common/crypto';
import { FakeDb, type FakeKeyRow } from './fake-db';

/** 32 bytes of `seed`, base64 — the encoding `EnvKeyMaterialResolver` expects by default. */
export function keyMaterial(seed: number, bytes = 32): string {
  return Buffer.alloc(bytes, seed).toString('base64');
}

export const FIELD_KID = 'fld_2026_01';
export const FIELD_KID_V2 = 'fld_2026_02';
export const BLIND_KID = 'bidx_2026_01';

export const FIELD_ENV = 'TEST_FIELD_KEY_1';
export const FIELD_ENV_V2 = 'TEST_FIELD_KEY_2';
export const BLIND_ENV = 'TEST_BLIND_KEY_1';

/** The default environment: one field key, one blind-index key, distinct material. */
export function testEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [FIELD_ENV]: keyMaterial(0x11),
    [FIELD_ENV_V2]: keyMaterial(0x22),
    [BLIND_ENV]: keyMaterial(0x33),
    ...overrides,
  };
}

export function fieldKeyRow(overrides: Partial<FakeKeyRow> = {}): FakeKeyRow {
  return {
    kid: FIELD_KID,
    purpose: 'field',
    algorithm: 'AES-256-GCM',
    key_ref: `env:${FIELD_ENV}`,
    status: 'active',
    ...overrides,
  };
}

export function blindKeyRow(overrides: Partial<FakeKeyRow> = {}): FakeKeyRow {
  return {
    kid: BLIND_KID,
    purpose: 'blind_index',
    algorithm: 'HMAC-SHA256',
    key_ref: `env:${BLIND_ENV}`,
    status: 'active',
    ...overrides,
  };
}

export function resolvers(env: NodeJS.ProcessEnv): KeyMaterialResolver[] {
  return [new EnvKeyMaterialResolver(env), new UnconfiguredKmsResolver()];
}

/** Builds a registry over `rows` and loads it. Throws exactly as boot would. */
export async function buildRegistry(
  rows: FakeKeyRow[],
  env: NodeJS.ProcessEnv = testEnv(),
  db: FakeDb = new FakeDb(),
): Promise<KeyRegistryService> {
  db.keyRows = rows;
  const registry = new KeyRegistryService(db.asSequelize(), resolvers(env));
  await registry.load();
  return registry;
}

/** The common case: one active field key and one active blind-index key. */
export async function buildDefaultRegistry(db: FakeDb = new FakeDb()): Promise<KeyRegistryService> {
  return buildRegistry([fieldKeyRow(), blindKeyRow()], testEnv(), db);
}
