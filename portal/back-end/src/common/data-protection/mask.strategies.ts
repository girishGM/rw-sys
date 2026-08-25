/**
 * T-017 — the five mask strategies of 07-DATA-PROTECTION.md §7, and the `hash` treatment.
 *
 * | Strategy | `john.doe@example.com` → | `+60123457788` → |
 * |---|---|---|
 * | `email` | `j••••@example.com` | — |
 * | `phone` | — | `••••••7788` |
 * | `last4` | `••••••••••.com` | `••••7788` |
 * | `first_last` | `j••••••••••••••m` | `+•••••••••88` |
 * | `full` | `••••••••` | `••••••••` |
 *
 * ### The property every strategy here has to hold
 *
 * **A mask must not become plaintext for a short input.** `first_last` on `"ab"` would, applied
 * naively, emit `"ab"` — the whole value, with the mask reduced to decoration. Every strategy
 * below therefore falls back to {@link maskFull} when the input is too short to retain any
 * character safely, and `mask.strategies.spec.ts` asserts that boundary for each one. This is
 * the class of bug that makes a masking layer worse than useless: it looks like it is working
 * everywhere except on the values short enough for the leak to matter.
 *
 * ### Why the outputs are fixed-width where they can be
 *
 * `full` is always eight glyphs regardless of input length, because a mask whose width tracks
 * the input discloses the input's length — enough, over a column of them, to distinguish a
 * 4-digit PIN from a 16-digit card number. The other strategies deliberately preserve structure
 * (the domain, the last four digits) because §7's stated purpose for them is *"PII you need to
 * recognise in a trace"*; that disclosure is the point of choosing them, and choosing them for a
 * secret rather than for recognisable PII is the misconfiguration, not this code.
 *
 * Every function is pure, total and synchronous: these run inside a log serialiser, where a
 * throw would turn a logging call into a 500 (`redact.ts` makes the same argument).
 */
import { createHash } from 'node:crypto';
import {
  FULL_MASK_LENGTH,
  HASH_DIGEST_CHARS,
  HASH_PREFIX,
  MASK_CHAR,
  MASK_STRATEGIES,
  type MaskStrategyName,
} from './data-protection.constants';

/** `••••••••` — fixed width, so the input's length is not disclosed. */
export function maskFull(): string {
  return MASK_CHAR.repeat(FULL_MASK_LENGTH);
}

/**
 * `john.doe@example.com` → `j••••@example.com`.
 *
 * The domain survives (that is what makes an address recognisable in a trace) and the local part
 * collapses to its first character plus a fixed four glyphs — fixed, again, so the local part's
 * length is not disclosed.
 *
 * A value with no `@`, or with an empty local part or domain, is **not** an address; it falls
 * back to {@link maskFull} rather than being passed through. A field configured `email` that
 * receives something else is a misconfiguration, and the safe reading of a misconfiguration is
 * "I do not know what this is", not "it is probably fine".
 */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return maskFull();
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return `${local[0]}${MASK_CHAR.repeat(4)}@${domain}`;
}

/**
 * `+60123457788` → `••••••7788`.
 *
 * Only the last four digits survive. Non-digits (spaces, dashes, brackets, the leading `+`) are
 * dropped rather than preserved: keeping the formatting would leak the country code, and
 * `+60••••7788` identifies the country of every masked number in a log.
 */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return maskFull();
  return `${MASK_CHAR.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/**
 * Keeps the last four **characters** — `john.doe@example.com` → `••••••••••••••••.com`.
 *
 * Distinct from {@link maskPhone}, which keeps the last four *digits* after discarding
 * punctuation. §7's table shows both on the same row for a reason: `last4` is the general form
 * and `phone` is the number-aware one.
 */
export function maskLast4(value: string): string {
  if (value.length <= 4) return maskFull();
  return `${MASK_CHAR.repeat(value.length - 4)}${value.slice(-4)}`;
}

/**
 * Keeps the first and last character — `john.doe@example.com` → `j••••••••••••••••••m`.
 *
 * Requires at least three characters, so that the mask always covers at least one of them; at
 * two, "first and last" is the entire value.
 */
export function maskFirstLast(value: string): string {
  if (value.length < 3) return maskFull();
  return `${value[0]}${MASK_CHAR.repeat(value.length - 2)}${value[value.length - 1]}`;
}

/**
 * `sha256:a3f9c1…` — the `hash` log treatment (§7): *"correlate across lines without
 * disclosing"*.
 *
 * Twelve hex characters (48 bits). Enough that two lines about the same value collide only by
 * astronomical accident; short enough that it is visibly a correlation token rather than
 * something to be pasted into a lookup. **It is not a security boundary**: SHA-256 over a
 * low-cardinality value (a role name, a status) is brute-forced instantly, exactly like the
 * blind-index frequency-analysis problem in 07-DATA-PROTECTION.md §6. Use `hash` for
 * high-entropy identifiers; use `omit` for secrets.
 */
export function hashForLog(value: string): string {
  return (
    HASH_PREFIX +
    createHash('sha256').update(value, 'utf8').digest('hex').slice(0, HASH_DIGEST_CHARS)
  );
}

const STRATEGIES: Readonly<Record<MaskStrategyName, (value: string) => string>> = Object.freeze({
  email: maskEmail,
  phone: maskPhone,
  last4: maskLast4,
  first_last: maskFirstLast,
  full: maskFull,
});

/** Whether `name` is one of the five §7 strategies. */
export function isMaskStrategy(name: unknown): name is MaskStrategyName {
  return typeof name === 'string' && (MASK_STRATEGIES as readonly string[]).includes(name);
}

/**
 * Applies a strategy to any value.
 *
 * Three deliberate behaviours, each of which is a decision rather than an implementation detail:
 *
 *  - **`null`/`undefined` pass through unchanged.** Masking an absent value to `••••••••` would
 *    invent the appearance of data, and a UI cannot then tell "hidden from you" from "not set".
 *  - **A non-string is masked as `full`, never stringified first.** `String({secret: 1})` is
 *    `"[object Object]"`, but `String(12345678901234)` is the number itself — so a numeric card
 *    or account field configured `last4` would otherwise be masked correctly while a
 *    `first_last` on a short number leaked it. Objects and numbers get the fixed mask; the
 *    structure-preserving strategies apply to strings only.
 *  - **An unknown strategy name masks as `full`.** The database's `ck_dpp_mask_strategy` and the
 *    loader both reject unknown names, so reaching this is a bug — and the fail-closed response
 *    to a bug in a masking path is to mask more, not less.
 */
export function applyMask(value: unknown, strategy: MaskStrategyName | null | undefined): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return maskFull();
  if (!isMaskStrategy(strategy)) return maskFull();
  return STRATEGIES[strategy](value);
}
