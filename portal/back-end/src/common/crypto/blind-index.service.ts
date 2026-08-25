/**
 * T-016 — blind indexes (07-DATA-PROTECTION.md §6, Implementation notes §5–6).
 *
 * A field encrypted with a random IV produces different ciphertext every time, so
 * `WHERE email = :x` can never match. The blind index is a second, deterministic column —
 * `HMAC-SHA256(normalise(value), blindIndexKey)` — that supports equality lookup and
 * nothing else. Login queries the index, then decrypts the real column.
 *
 * ### Three things that will bite whoever changes this file
 *
 * 1. **A normalisation change invalidates every stored index.** Not "degrades" —
 *    invalidates. Every existing row's index was computed with the old rule and will no
 *    longer match a value normalised with the new one, so logins start failing for the rows
 *    that were written before the change and there is no error anywhere. Every normaliser
 *    below therefore carries an explicit `version`, and changing one means bumping that
 *    version *and* rebuilding the column (`RotateKeysCommand` can do it — see its
 *    `blindIndex` target option).
 *
 * 2. **The key is separate from the field key, and is not part of the rotation overlap.**
 *    Field keys rotate with an overlap window because the `kid` travels inside the
 *    ciphertext. A blind index carries no kid — it is a bare hex digest — so there is
 *    nothing to look up and no overlap is possible. Rotating a `blind_index` key means
 *    recomputing every index from the decrypted source column in one pass, not running two
 *    keys side by side.
 *
 * 3. **Blind indexes leak equality, and equality is enough to break low-cardinality data.**
 *    Two rows with the same index provably hold the same value. Over a field with five
 *    possible values that is frequency analysis, not encryption. 07-DATA-PROTECTION.md §6
 *    restricts `blind_index = true` to `pii` and `secret` classifications, "checked in
 *    T-016" — that check is `assertBlindIndexAllowed()` below, which T-017's policy loader
 *    calls.
 */
import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { BlindIndexError } from './crypto.errors';
import { KeyRegistryService } from './key-registry.service';

/**
 * Hex characters in a blind index — the full 32-byte HMAC-SHA256 digest.
 *
 * T-016 Implementation notes §5 say "truncated to 32 bytes hex". HMAC-SHA256's output *is*
 * exactly 32 bytes, so the truncation is a no-op and the whole digest is emitted, as 64
 * lowercase hex characters. The alternative reading — 32 hex *characters*, i.e. 128 bits —
 * would discard half the digest to save 32 bytes per row, for no benefit anyone can name.
 * T-017's `*_bidx` columns should be `varchar(64)`; this constant is exported so that
 * migration does not have to re-derive the width.
 */
export const BLIND_INDEX_HEX_LENGTH = 64;

export type BlindIndexNormaliserName = 'exact' | 'email' | 'phone';

export interface BlindIndexNormaliser {
  /** Bump when the rule changes — and rebuild every column that used it. */
  readonly version: string;
  /** Human-readable rule, quoted verbatim in the T-044 column inventory. */
  readonly description: string;
  readonly normalise: (value: string) => string;
}

/**
 * The registry. Every entry is documented per field, per Implementation notes §5.
 *
 * `toLowerCase()` is used rather than `toLocaleLowerCase()` on purpose: the locale-aware
 * form maps `'I'` to `'ı'` under a Turkish locale, so the same email would index differently
 * depending on the server's `LANG`. TC-18 ("same input → same index, across processes")
 * would pass on one host and fail on another. Unicode normalisation runs first for the same
 * reason — `é` composed and `é` decomposed are different byte strings and must not produce
 * different indexes.
 */
export const BLIND_INDEX_NORMALISERS: Readonly<
  Record<BlindIndexNormaliserName, BlindIndexNormaliser>
> = Object.freeze({
  /**
   * Byte-for-byte, other than canonical Unicode composition. For values where case and
   * surrounding whitespace are meaningful (references, external ids).
   */
  exact: Object.freeze({
    version: 'exact.v1',
    description: 'Unicode NFC only. Case, whitespace and punctuation are all significant.',
    normalise: (value: string): string => value.normalize('NFC'),
  }),

  /**
   * Emails. Trim + lowercase, per Implementation notes §5. Deliberately does **not** strip
   * `+tags` or dots in the local part: those are Gmail conventions, not RFC 5321 rules, and
   * applying them would merge two addresses that other mail servers treat as distinct
   * people. NFKC (not NFC) because full-width characters in an address are a homoglyph
   * vector and should collapse to their ASCII forms before hashing.
   */
  email: Object.freeze({
    version: 'email.v1',
    description: 'Unicode NFKC, trim surrounding whitespace, lowercase (locale-independent).',
    normalise: (value: string): string => value.normalize('NFKC').trim().toLowerCase(),
  }),

  /**
   * Phone numbers. Keeps digits and a single leading `+`, so `+60 12-345 7788`,
   * `+60123457788` and `(+60)123457788` all index identically. Does **not** infer a country
   * code from a bare national number — `0123457788` and `+60123457788` index differently,
   * because guessing the country would be wrong for exactly the multi-country tenants this
   * portal exists to serve.
   */
  phone: Object.freeze({
    version: 'phone.v1',
    description:
      'Unicode NFKC, keep digits plus one leading "+". No country-code inference: a ' +
      'national-format number does not match its international form.',
    normalise: (value: string): string => {
      const normalised = value.normalize('NFKC').trim();
      // "Leading +" means "a + before any digit", not "character zero is a +". `startsWith`
      // would classify the documented `(+60)123457788` as a *national* number, giving it a
      // different index from `+60123457788` — the two forms are the same phone number, and a
      // login/lookup keyed on the index would simply never find one of them. A `+` that
      // appears after a digit (`60123457788+`) is not a country-code marker and is dropped
      // with the rest of the punctuation.
      const international = /^[^\d+]*\+/.test(normalised);
      const digits = normalised.replace(/\D/g, '');
      return international ? `+${digits}` : digits;
    },
  }),
});

/**
 * Which normaliser each known blind-indexed field uses. T-017 owns the policy table and its
 * `*_bidx` columns; this map is the T-016 half of that contract, so the two cannot drift
 * apart silently. Adding a field here without also adding its policy row does nothing; the
 * reverse fails closed, because `normaliserForField()` throws on an unknown key.
 */
export const BLIND_INDEX_FIELD_NORMALISERS: Readonly<Record<string, BlindIndexNormaliserName>> =
  Object.freeze({
    // The login lookup key — 07-DATA-PROTECTION.md §6.
    'reward_portal.portal_users.email': 'email',
  });

/** Classifications for which a blind index is permitted — 07-DATA-PROTECTION.md §6. */
export const BLIND_INDEX_ALLOWED_CLASSIFICATIONS: readonly string[] = ['pii', 'secret'];

/**
 * The §6 rule, implemented here so T-017's policy loader (and T-017's TC-23) can call it:
 * a blind index over low-cardinality data is broken by counting, so it is restricted to the
 * high-cardinality classifications. Throws rather than returning false — this is called
 * while loading configuration, where fail-closed means refusing the configuration.
 */
export function assertBlindIndexAllowed(policyKey: string, classification: string): void {
  if (!BLIND_INDEX_ALLOWED_CLASSIFICATIONS.includes(classification)) {
    throw new BlindIndexError(
      `Policy '${policyKey}' sets blind_index=true on a '${classification}' field. A blind ` +
        `index is only permitted on ${BLIND_INDEX_ALLOWED_CLASSIFICATIONS.join(' or ')} ` +
        `fields: it leaks equality, and over low-cardinality data equality is enough to ` +
        `recover the values by frequency analysis (07-DATA-PROTECTION.md §6).`,
    );
  }
}

/** Resolves a field's normaliser, failing closed on anything not explicitly registered. */
export function normaliserForField(policyKey: string): BlindIndexNormaliserName {
  const name = BLIND_INDEX_FIELD_NORMALISERS[policyKey];
  if (name === undefined) {
    throw new BlindIndexError(
      `No blind-index normalisation rule registered for '${policyKey}'. Add it to ` +
        `BLIND_INDEX_FIELD_NORMALISERS (blind-index.service.ts) — defaulting to a rule ` +
        `would silently pick one, and the wrong rule produces an index that never matches.`,
    );
  }
  return name;
}

@Injectable()
export class BlindIndexService {
  constructor(private readonly keys: KeyRegistryService) {}

  compute(value: string, normaliser: BlindIndexNormaliserName): string;
  compute(value: string | null | undefined, normaliser: BlindIndexNormaliserName): string | null;
  /**
   * `HMAC-SHA256(normalise(value), blindIndexKey)` as lowercase hex.
   *
   * `null`/`undefined` in returns `null` out, mirroring `FieldCryptoService.encrypt`, so a
   * NULL source column produces a NULL index rather than the index of the empty string —
   * which every NULL row would share, turning the index into a public "this row has no
   * value" flag.
   */
  compute(value: string | null | undefined, normaliser: BlindIndexNormaliserName): string | null {
    const rule = BLIND_INDEX_NORMALISERS[normaliser];
    if (rule === undefined) {
      throw new BlindIndexError(
        `Unknown blind-index normaliser '${normaliser}'. Known: ` +
          `${Object.keys(BLIND_INDEX_NORMALISERS).join(', ')}.`,
      );
    }
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') {
      throw new BlindIndexError('compute() accepts a string, null or undefined.');
    }

    const key = this.keys.getActiveKey('blind_index');
    return createHmac('sha256', key.material).update(rule.normalise(value), 'utf8').digest('hex');
  }

  /** `compute()` with the normaliser looked up from the field registry. */
  computeForField(policyKey: string, value: string): string;
  computeForField(policyKey: string, value: string | null | undefined): string | null;
  computeForField(policyKey: string, value: string | null | undefined): string | null {
    return this.compute(value, normaliserForField(policyKey));
  }

  /**
   * The exact string that gets hashed. Exposed for tests and for the T-044 inventory —
   * *not* for storing anywhere. It is the plaintext, lightly cleaned; treat it as plaintext.
   */
  normalisedFor(value: string, normaliser: BlindIndexNormaliserName): string {
    const rule = BLIND_INDEX_NORMALISERS[normaliser];
    if (rule === undefined) {
      throw new BlindIndexError(`Unknown blind-index normaliser '${normaliser}'.`);
    }
    return rule.normalise(value);
  }
}
