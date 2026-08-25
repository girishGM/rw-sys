/**
 * T-011 unit-test support — RSA key pairs and a `ConfigService` stand-in.
 *
 * **Every key here is generated at run time and exists only in this process's heap.** Nothing is
 * checked in, nothing is written to disk, and `npm run scan:secrets` has nothing to find (R4).
 * That is not incidental: a fixed test key in a repository is indistinguishable from a leaked
 * production key to every scanner and every reviewer who finds it later, and it would be a live
 * signing key for anyone who ever ran this system with the example configuration.
 *
 * Generation is memoised per key size because RSA-2048 keygen costs a few hundred milliseconds
 * and the alternative is paying it in every `beforeEach`.
 */
import { generateKeyPairSync } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.schema';

export interface TestKeyPair {
  readonly privateKey: string;
  readonly publicKey: string;
}

const cache = new Map<number, TestKeyPair>();

export function generateTestKeyPair(modulusLength = 2048): TestKeyPair {
  const cached = cache.get(modulusLength);
  if (cached !== undefined) return cached;

  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const pair: TestKeyPair = { privateKey, publicKey };
  cache.set(modulusLength, pair);
  return pair;
}

/** A second, unrelated pair — the "signed by a different key" fixture for TC-9. */
export function generateForeignKeyPair(): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKey, publicKey };
}

/**
 * Rewrites a PEM the way a `.env` file has to carry it — real newlines replaced by the literal
 * two-character sequence `\n`. `.env.example` documents exactly this, so `normalisePem` in
 * `token.service.ts` has to undo it; this helper is how that gets tested rather than assumed.
 */
export function toEnvEscaped(pem: string): string {
  return pem.replace(/\n/g, '\\n');
}

/**
 * The narrowest possible `ConfigService`: `TokenService` calls `get` for exactly two keys, so
 * this returns exactly two keys and throws for anything else rather than answering `undefined`
 * and letting a typo look like a missing configuration value.
 */
export function fakeConfigService(values: Record<string, string>): ConfigService<Env, true> {
  return {
    get(key: string): string {
      const value = values[key];
      if (value === undefined) throw new Error(`fakeConfigService has no value for ${key}`);
      return value;
    },
  } as unknown as ConfigService<Env, true>;
}
