/**
 * T-017 — the vocabulary of the data-protection engine.
 *
 * Every union below is transcribed from the `CHECK` constraints in
 * `T017_001_data_protection_policies.ts`, which are themselves transcribed from
 * 07-DATA-PROTECTION.md §2. The database rejects anything outside them, so these are not
 * stylistic preferences: they are the constraint, expressed where an agent will read it.
 * `data-protection.constants.spec.ts` asserts each list is identical to the one the migration
 * writes, so the two cannot drift.
 *
 * This file imports nothing. It is depended on by the serialiser, the interceptor, the hooks and
 * the migrations, and a leaf with no imports is a leaf that cannot drag `ConfigModule` (and its
 * `process.exit(1)` on an incomplete environment) into a unit test — the same split
 * `@/common/crypto`'s and `@/common/audit`'s barrels document.
 */

/** `data_protection_policies.scope`. */
export const POLICY_SCOPES = ['column', 'dto_field'] as const;
export type PolicyScope = (typeof POLICY_SCOPES)[number];

/**
 * `data_protection_policies.classification`, **in ascending order of sensitivity**.
 *
 * The order is load-bearing, not cosmetic: {@link compareClassification} ranks by index, and a
 * table's effective classification is the *maximum* over its policy rows. Reordering this array
 * silently reclassifies data.
 */
export const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'pii', 'secret'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/** `data_protection_policies.at_rest`. */
export const AT_REST_ALGORITHMS = ['none', 'aes_256_gcm', 'hmac_sha256'] as const;
export type AtRest = (typeof AT_REST_ALGORITHMS)[number];

/** `data_protection_policies.in_transit`. */
export const IN_TRANSIT_MODES = ['tls_only', 'payload_encrypt'] as const;
export type InTransit = (typeof IN_TRANSIT_MODES)[number];

/** `data_protection_policies.log_treatment` — 07-DATA-PROTECTION.md §7. */
export const LOG_TREATMENTS = ['plain', 'mask', 'hash', 'omit'] as const;
export type LogTreatment = (typeof LOG_TREATMENTS)[number];

/** `data_protection_policies.ui_visibility` — 07-DATA-PROTECTION.md §8. */
export const UI_VISIBILITIES = ['plain', 'masked', 'reveal_on_demand', 'never'] as const;
export type UiVisibility = (typeof UI_VISIBILITIES)[number];

/** `data_protection_policies.mask_strategy` — 07-DATA-PROTECTION.md §7. */
export const MASK_STRATEGIES = ['email', 'phone', 'last4', 'first_last', 'full'] as const;
export type MaskStrategyName = (typeof MASK_STRATEGIES)[number];

/**
 * The classifications a blind index is permitted on — 07-DATA-PROTECTION.md §6, and the same
 * list `@/common/crypto`'s `BLIND_INDEX_ALLOWED_CLASSIFICATIONS` holds.
 *
 * Duplicated rather than imported for the reason `audit.constants.ts` gives about error codes:
 * this file is a zero-import leaf, and the *migration* needs the list too — a migration cannot
 * import a Nest-injectable module. `policy.service.spec.ts` asserts the two are identical.
 */
export const BLIND_INDEX_CLASSIFICATIONS: readonly Classification[] = ['pii', 'secret'];

/**
 * The value substituted for a field whose ciphertext will not decrypt (implementation note 3).
 *
 * > *"Decryption failure on read must **not** crash a list endpoint: log at `error`, return a
 * > sentinel (`"<undecryptable>"`), and continue. One bad row must not deny the whole page."*
 *
 * It is deliberately not an empty string and not `null`: both are values a column can legally
 * hold, so either would make a corrupted row indistinguishable from an absent one — and the
 * whole point of the sentinel is that a human notices it.
 */
export const UNDECRYPTABLE_SENTINEL = '<undecryptable>';

/** The mask character. One constant so every strategy and every test asserts the same glyph. */
export const MASK_CHAR = '•';

/** Fixed width of a `full` mask, so the output never discloses the input's length. */
export const FULL_MASK_LENGTH = 8;

/** `hash` log treatment renders `sha256:<first 12 hex>` — 07-DATA-PROTECTION.md §7. */
export const HASH_PREFIX = 'sha256:';
export const HASH_DIGEST_CHARS = 12;

/** The `portal_audit_log.event_type` this task writes when a field is unmasked (§8). */
export const PII_REVEALED_EVENT = 'pii_revealed';

/** The event written when a reveal is *refused*. TC-16 requires an audit row for the denial. */
export const PII_REVEAL_DENIED_EVENT = 'pii_reveal_denied';

/**
 * Ranks two classifications. Positive when `a` is more sensitive than `b`.
 *
 * An unknown string ranks as the **most** sensitive rather than the least — a classification
 * this build does not recognise is a row written by a newer deployment, and guessing "harmless"
 * about data somebody else thought worth classifying is the wrong direction to guess in.
 */
export function compareClassification(a: string, b: string): number {
  return rankClassification(a) - rankClassification(b);
}

/** @see compareClassification */
export function rankClassification(value: string): number {
  const index = (CLASSIFICATIONS as readonly string[]).indexOf(value);
  return index === -1 ? CLASSIFICATIONS.length : index;
}

/** The more sensitive of two classifications. */
export function maxClassification(a: Classification, b: Classification): Classification {
  return compareClassification(a, b) >= 0 ? a : b;
}

/**
 * Log treatments ordered from most disclosing to least, for "take the most restrictive of two
 * candidate policies" — which is what happens when a bare field name (`email`) matches more than
 * one policy row and the engine cannot tell which table the value came from.
 */
const LOG_TREATMENT_RESTRICTIVENESS: Readonly<Record<LogTreatment, number>> = {
  plain: 0,
  mask: 1,
  hash: 2,
  omit: 3,
};

/** The stricter of two log treatments. */
export function strictestLogTreatment(a: LogTreatment, b: LogTreatment): LogTreatment {
  return LOG_TREATMENT_RESTRICTIVENESS[a] >= LOG_TREATMENT_RESTRICTIVENESS[b] ? a : b;
}

/** UI visibilities ordered from most disclosing to least. See {@link strictestLogTreatment}. */
const UI_VISIBILITY_RESTRICTIVENESS: Readonly<Record<UiVisibility, number>> = {
  plain: 0,
  reveal_on_demand: 1,
  masked: 2,
  never: 3,
};

/** The stricter of two UI visibilities. */
export function strictestUiVisibility(a: UiVisibility, b: UiVisibility): UiVisibility {
  return UI_VISIBILITY_RESTRICTIVENESS[a] >= UI_VISIBILITY_RESTRICTIVENESS[b] ? a : b;
}
