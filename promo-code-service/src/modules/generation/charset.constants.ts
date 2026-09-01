import type { CharacterSet } from './code-generator.types';

/**
 * T-PC-020 implementation note 4 — exact, minimal charset definitions. `01-DATABASE.md` §1's
 * `character_set` CHECK constraint only allows `NUMERIC`/`ALPHA`/`ALPHANUMERIC`; do not add
 * lowercase or symbols here — a promo code a customer might read aloud or type on a
 * numeric-first mobile keyboard should not require case-sensitivity.
 */
export const NUMERIC_CHARS = '0123456789';
export const ALPHA_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const ALPHANUMERIC_CHARS = `${NUMERIC_CHARS}${ALPHA_CHARS}`;

export const CHARSET_BY_NAME: Readonly<Record<CharacterSet, string>> = Object.freeze({
  NUMERIC: NUMERIC_CHARS,
  ALPHA: ALPHA_CHARS,
  ALPHANUMERIC: ALPHANUMERIC_CHARS,
});

/**
 * T-PC-020 implementation note 3 — the fixed, documented set of visually confusable
 * characters removed from the sampling pool *before* sampling when a config's
 * `exclude_ambiguous_chars` flag is `true`. Never sample-then-reject: that would bias the
 * distribution toward easier-to-hit-by-elimination characters and complicate reasoning about
 * the true collision space. This is the one place T-PC-041's security review and any future
 * "why can't my code contain the letter O" support question should point to.
 */
export const AMBIGUOUS_CHARS: ReadonlySet<string> = new Set(['0', 'O', '1', 'I', 'l']);
