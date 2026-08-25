/**
 * T-016 — resolving a `key_ref` **pointer** into actual key bytes
 * (07-DATA-PROTECTION.md §3, Implementation notes §1).
 *
 * The whole point of `encryption_keys.key_ref` is that it is a *name*, not a value:
 * `env:FIELD_KEY_2026_01` or `kms:arn:aws:kms:...`. Key bytes sitting in the same database
 * as the ciphertext they protect is equivalent to not encrypting at all — a stolen backup
 * contains both halves. This file is the only place that turns a pointer into bytes, and it
 * runs exactly once, at boot, into memory.
 *
 * `looksLikeKeyMaterial()` is the startup assertion the task file calls out as one of the
 * two "mistakes that look fine in review" (TC-12). Someone will eventually paste a
 * base64 key into `key_ref` because it is a `varchar(200)` and it fits. The database CHECK
 * constraint in `T016_001_encryption_keys.ts` blocks the obvious shapes; this function
 * blocks the shapes that still satisfy the constraint's alphabet (a 43-character
 * alphanumeric blob is a syntactically valid environment-variable name).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { KeyRegistryError } from './crypto.errors';

/** A `key_ref` scheme this build knows how to resolve. */
export type KeyRefScheme = 'env' | 'kms';

export interface ParsedKeyRef {
  scheme: KeyRefScheme;
  /** Everything after `<scheme>:` — an env var name, or a KMS ARN. */
  locator: string;
}

/**
 * Environment-variable names, deliberately narrow: POSIX-portable characters only. This
 * excludes `+`, `/` and `=`, which removes most accidental base64 pastes before
 * `looksLikeKeyMaterial` even runs.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** KMS ARNs. Loose on the tail (partitions and regions vary), strict on the shape. */
const KMS_ARN = /^arn:[A-Za-z0-9-]+:kms:[A-Za-z0-9-]*:[0-9]*:[A-Za-z0-9:/_-]+$/;

/**
 * Threshold for "this is key material, not a pointer". 32 bytes is an AES-256 key; anything
 * that decodes to at least that much is treated as a key regardless of what it claims to be.
 */
export const KEY_MATERIAL_BYTE_THRESHOLD = 32;

/**
 * Byte length a string would decode to if read as base64 (standard **or** URL-safe, padded
 * or not), or `null` if it is not valid base64 at all.
 *
 * Computed arithmetically rather than by decoding, because `Buffer.from(s, 'base64')`
 * silently drops out-of-alphabet characters and would happily report a length for
 * `"not base64 at all!!"`.
 */
export function base64ByteLength(value: string): number | null {
  const body = value.replace(/=+$/, '');
  if (body.length === 0) return null;
  if (!/^[A-Za-z0-9+/\-_]+$/.test(body)) return null;
  if (body.length % 4 === 1) return null; // no base64 string has this length
  return Math.floor((body.length * 3) / 4);
}

/** Byte length a string would decode to if read as hex, or `null` if it is not hex. */
export function hexByteLength(value: string): number | null {
  if (value.length === 0 || value.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(value)) return null;
  return value.length / 2;
}

/**
 * True when `value` plausibly *is* a key rather than a pointer to one. Errs towards refusing
 * to boot: a false positive is a five-minute "rename your environment variable" fix, a false
 * negative is every key in the project sitting next to its own ciphertext forever.
 *
 * Both the whole `key_ref` and the part after the scheme are checked by the caller, because
 * `env:<base64 key>` is exactly the mistake this exists to catch.
 */
export function looksLikeKeyMaterial(value: string): boolean {
  const asHex = hexByteLength(value);
  if (asHex !== null && asHex >= KEY_MATERIAL_BYTE_THRESHOLD) return true;
  const asB64 = base64ByteLength(value);
  return asB64 !== null && asB64 >= KEY_MATERIAL_BYTE_THRESHOLD;
}

/**
 * Splits and validates a `key_ref`. Throws `KeyRegistryError` — i.e. refuses to boot — on
 * an unknown scheme, a malformed locator, or anything that looks like key material.
 */
export function parseKeyRef(keyRef: string, kid: string): ParsedKeyRef {
  if (looksLikeKeyMaterial(keyRef)) {
    throw new KeyRegistryError(
      `encryption_keys.key_ref for kid=${kid} looks like key material, not a pointer. ` +
        `key_ref must name a location ('env:NAME' or 'kms:arn:...'), never contain a key ` +
        `(07-DATA-PROTECTION.md §3).`,
    );
  }

  const separator = keyRef.indexOf(':');
  if (separator < 0) {
    throw new KeyRegistryError(
      `encryption_keys.key_ref for kid=${kid} has no scheme. Expected 'env:NAME' or 'kms:arn:...'.`,
    );
  }

  const scheme = keyRef.slice(0, separator);
  const locator = keyRef.slice(separator + 1);

  if (looksLikeKeyMaterial(locator)) {
    throw new KeyRegistryError(
      `encryption_keys.key_ref for kid=${kid} looks like key material behind a '${scheme}:' ` +
        `prefix. key_ref must name a location, never contain a key (07-DATA-PROTECTION.md §3).`,
    );
  }

  if (scheme === 'env') {
    if (!ENV_NAME.test(locator)) {
      throw new KeyRegistryError(
        `encryption_keys.key_ref for kid=${kid} is not a valid environment variable name.`,
      );
    }
    return { scheme: 'env', locator };
  }

  if (scheme === 'kms') {
    if (!KMS_ARN.test(locator)) {
      throw new KeyRegistryError(`encryption_keys.key_ref for kid=${kid} is not a valid KMS ARN.`);
    }
    return { scheme: 'kms', locator };
  }

  throw new KeyRegistryError(
    `encryption_keys.key_ref for kid=${kid} uses unsupported scheme '${scheme}'. ` +
      `Supported: 'env:', 'kms:'.`,
  );
}

/**
 * Resolves one scheme. Injected as a list so a deployment can add a real KMS client without
 * this file (or `KeyRegistryService`) learning anything about AWS.
 */
export interface KeyMaterialResolver {
  readonly scheme: KeyRefScheme;
  resolve(ref: ParsedKeyRef, kid: string): Promise<Buffer>;
}

/** DI token for the resolver list. */
export const KEY_MATERIAL_RESOLVERS = Symbol('KEY_MATERIAL_RESOLVERS');

/**
 * T-057 (D-3) — `.env` files never reach `EnvKeyMaterialResolver` through the normal boot
 * path, and the failure this produces is actively misleading: the operator can see the
 * variable sitting in `.env.development`, and the app insists it is not set.
 *
 * Root cause: `config.module.ts` supplies `validate: validateEnv` to `ConfigModule.forRoot`.
 * `@nestjs/config` only ever copies the *validated* object back onto `process.env`
 * (`assignVariablesToProcess`, and even then only for keys not already present there) — and
 * `validateEnv` is a zod `object().safeParse()`, which silently **strips every key the
 * schema doesn't name**. Key material env var names are data (`encryption_keys.key_ref`),
 * not something `env.schema.ts` can enumerate in advance, so they are exactly the keys that
 * get stripped. `.env` files are parsed correctly by `@nestjs/config` — the value simply
 * never survives the trip through the schema.
 *
 * Fix chosen (option 1 of the three the task file lays out — smallest surface, `.env` keeps
 * working the way every operator already expects it to): this resolver reads its own,
 * independent view of the `.env` files, entirely inside this file. It does **not** touch
 * `config.module.ts` or `env.schema.ts` (option 2, `.passthrough()`, was rejected — loosening
 * what counts as valid configuration is a bigger, farther-reaching change than this one
 * defect calls for, and every *schema-known* variable already reaches `process.env` exactly
 * as before; nothing here changes their behaviour).
 *
 * `defaultKeyMaterialEnv()` returns a `Proxy` over the **live** `process.env` object, not a
 * snapshot copied at construction time: `resolve()` is called well after boot (T-016's
 * `KeyRegistryService.load()`, and again on every `rotate-keys` invocation), and a value
 * genuinely present in the real process environment must always be found — including one set
 * *after* this resolver was constructed (see this file's own spec, "defaults to the real
 * process environment"). The `.env`-parsed values are only ever consulted as a **fallback**
 * for a key `process.env` does not have at all; a real environment variable, even one set to
 * the empty string, is never shadowed by a same-named `.env` entry (TC-14: exporting the
 * variable for real must keep working, unconditionally).
 */
/**
 * Keyed by `root nodeEnv` rather than a single value, so that
 * `key-material.resolver.spec.ts` (this file's own colocated unit spec, covering exactly the
 * two functions below — everything else in this file is covered by
 * `test/crypto/key-material.resolver.spec.ts`, T-016's) can exercise `loadDotEnvFallback`
 * against isolated temp directories, repeatedly, in one process, without one call's cache
 * entry answering for another's different root. Production always calls with the same
 * (default) arguments, so this is a single cached entry there, exactly as before.
 */
const dotEnvFallbackCache = new Map<string, Record<string, string>>();

/** `back-end/`, from either `src/common/crypto/` (ts-node) or `dist/common/crypto/` (built) —
 * both are three directories below `back-end/`, so one calculation covers both entry points,
 * the same reasoning `migrate.ts`/`bootstrap-superadmin.ts` already document for themselves. */
export function backEndRoot(): string {
  return path.join(__dirname, '..', '..', '..');
}

/**
 * Parses (never mutates `process.env` with) `.env.local` / `.env.<nodeEnv>` / `.env`, merged
 * with the same first-file-wins precedence `migrate.ts`/`bootstrap-superadmin.ts` already use
 * for the real thing — reimplemented rather than imported, because both of those live outside
 * `src/common/crypto/**` (T-057's own file scope) and this needs no more than the merge logic.
 * Computed once per `(root, nodeEnv)` pair and cached: the files themselves cannot change
 * after boot, so re-reading them from disk on every `resolve()` call would be pure overhead.
 *
 * `root`/`nodeEnv` are parameters — defaulting to the real `backEndRoot()`/`NODE_ENV` in
 * every real caller — purely so this file's own unit spec can point them at a disposable temp
 * directory instead of `back-end/`'s real `.env*` files.
 */
export function loadDotEnvFallback(
  root: string = backEndRoot(),
  nodeEnv: string = process.env.NODE_ENV || 'development',
): Record<string, string> {
  const cacheKey = `${root} ${nodeEnv}`;
  const cached = dotEnvFallbackCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const merged: Record<string, string> = {};

  for (const file of ['.env.local', `.env.${nodeEnv}`, '.env']) {
    const fullPath = path.join(root, file);
    if (!existsSync(fullPath)) continue;
    let parsed: Record<string, string>;
    try {
      parsed = dotenv.parse(readFileSync(fullPath));
    } catch {
      // An unreadable file (e.g. a permissions error, or — as this file's own spec exercises
      // — a path that turned out to be a directory) is not this resolver's problem to raise:
      // the application's own boot sequence (ConfigModule) already parses the same files and
      // will surface a real problem there. This fallback only ever adds coverage; it never
      // removes any.
      continue;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in merged)) merged[key] = value;
    }
  }

  dotEnvFallbackCache.set(cacheKey, merged);
  return merged;
}

/**
 * The live `process.env`, transparently backed by the `.env` files above for any key
 * `process.env` does not itself have. See this section's header comment for why a `Proxy`
 * rather than a merged snapshot. `root`/`nodeEnv` exist for the same test-only reason
 * `loadDotEnvFallback`'s do.
 */
export function defaultKeyMaterialEnv(
  root: string = backEndRoot(),
  nodeEnv: string = process.env.NODE_ENV || 'development',
): NodeJS.ProcessEnv {
  const fallback = loadDotEnvFallback(root, nodeEnv);
  return new Proxy(process.env, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in target) return target[prop];
      if (typeof prop === 'string' && prop in fallback) return fallback[prop];
      return target[prop as keyof NodeJS.ProcessEnv];
    },
    has(target, prop) {
      return prop in target || (typeof prop === 'string' && prop in fallback);
    },
  }) as NodeJS.ProcessEnv;
}

/**
 * Reads key bytes from `process.env` — and, only when a name is entirely absent from it, from
 * whichever `.env` file would have supplied it at boot (T-057 D-3, above).
 *
 * **Encoding is explicit and unambiguous by design.** A bare value is standard base64; an
 * operator who reaches for `openssl rand -hex 32` writes `hex:<64 hex chars>`. Guessing
 * between the two is not possible in general — a 64-character hex string is *also* valid
 * base64 (decoding to 48 different bytes) — and a key registry that guesses wrong produces
 * a portal that encrypts happily and can never decrypt.
 */
export class EnvKeyMaterialResolver implements KeyMaterialResolver {
  readonly scheme = 'env' as const;

  constructor(private readonly env: NodeJS.ProcessEnv = defaultKeyMaterialEnv()) {}

  async resolve(ref: ParsedKeyRef, kid: string): Promise<Buffer> {
    const raw = this.env[ref.locator];
    if (raw === undefined || raw === '') {
      throw new KeyRegistryError(
        `Environment variable '${ref.locator}' (key_ref for kid=${kid}) is not set. ` +
          `Every key referenced by encryption_keys must be present at boot. Checked the real ` +
          `process environment and, as a fallback, .env.local/.env.${process.env.NODE_ENV || 'development'}/.env ` +
          `relative to back-end/ — key material can be supplied by any of those (T-057 D-3).`,
      );
    }
    return decodeKeyMaterial(raw, ref.locator, kid);
  }
}

/**
 * Placeholder for KMS-backed keys. It resolves nothing and says so loudly.
 *
 * This is not an oversight and must not be "fixed" by falling back to an environment
 * variable: a deployment that configured `kms:` did so because the key is not allowed to
 * exist as an environment variable, and silently substituting one would defeat the entire
 * reason that deployment chose KMS. Wiring a real client is a deployment concern (T-052).
 */
export class UnconfiguredKmsResolver implements KeyMaterialResolver {
  readonly scheme = 'kms' as const;

  async resolve(ref: ParsedKeyRef, kid: string): Promise<Buffer> {
    throw new KeyRegistryError(
      `encryption_keys row kid=${kid} points at KMS (${ref.locator}) but no KMS resolver is ` +
        `configured in this deployment. Register a KeyMaterialResolver for the 'kms' scheme ` +
        `(CryptoModule providers) — there is deliberately no environment-variable fallback.`,
    );
  }
}

/**
 * Decodes an env var's value into raw key bytes. Never includes the value (or any part of
 * it) in an error message.
 */
export function decodeKeyMaterial(raw: string, envName: string, kid: string): Buffer {
  const bad = (why: string): never => {
    throw new KeyRegistryError(
      `Environment variable '${envName}' (key_ref for kid=${kid}) ${why}. Expected raw key ` +
        `bytes as standard base64, or 'hex:<hex>' / 'base64:<base64>' to state the encoding ` +
        `explicitly.`,
    );
  };

  if (raw.startsWith('hex:')) {
    const body = raw.slice(4);
    if (hexByteLength(body) === null) return bad('is not valid hex after the "hex:" prefix');
    return Buffer.from(body, 'hex');
  }

  const body = raw.startsWith('base64:') ? raw.slice(7) : raw;
  if (base64ByteLength(body) === null) return bad('is not valid base64');
  const decoded = Buffer.from(body, 'base64');
  // Round-trip guard: the value must be the *canonical* encoding of the bytes it decodes to.
  //
  // `base64ByteLength` above has already checked the alphabet and rejected impossible
  // lengths, so a length comparison here can no longer fail — but a *content* comparison
  // still can, and catches something real. Base64 whose final character carries bits that
  // fall outside the decoded bytes ("QR" and "QQ" both decode to the single byte 0x41) is
  // silently accepted by every decoder, which means two different values of the same
  // environment variable produce the same key. That turns "has the key changed?" — asked
  // during every rotation and every incident — into a question that cannot be answered by
  // comparing the configured values. An operator hitting this has a typo in the key, and
  // failing the boot is the correct answer to a typo in a key.
  //
  // Compared in base64url without padding so that both accepted spellings (standard and
  // URL-safe, padded or not) normalise to one form before the comparison.
  if (decoded.toString('base64url') !== canonicalisableForm(body)) {
    return bad('is not canonical base64 — it has bits set beyond the bytes it decodes to');
  }
  return decoded;
}

/** `body` reduced to the unpadded base64url spelling, for comparison against a re-encoding. */
function canonicalisableForm(body: string): string {
  return body.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
