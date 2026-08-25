/**
 * T-037 — exact decimal arithmetic for money, on strings, via `bigint`.
 *
 * ### Why this file exists at all
 *
 * Every monetary value in this system is a **string** end to end: `campaign_caps.max_total_amount`
 * is `decimal(18,4)` and Sequelize hands it back as a string precisely so nothing coerces it
 * (`campaign-cap.model.ts`: *"never coerce to a JS number; money crosses every boundary as a
 * string, never a float"*), and 11-BUDGETS-AND-LIMITS.md §5 fixes the same rule for the gRPC
 * contract: *"a budget that drifts by fractions of a cent across millions of transactions is a
 * reconciliation problem nobody wants to debug"*.
 *
 * But step 6 has to **compare** those strings — tracker budgets summed against the campaign
 * budget, a budget against a tenant ceiling, a daily limit multiplied by the campaign's length
 * (implementation notes 15 and 17). `Number(a) + Number(b)` would reintroduce binary floating
 * point at exactly the moment the design spent two documents avoiding it, and `0.1 + 0.2` is
 * enough to make a warning fire or not fire on a boundary.
 *
 * So: parse to a `bigint` of ten-thousandths (the column's own scale), compute exactly, format
 * back. No dependency, no rounding mode to get wrong, and the four functions below are the only
 * arithmetic anywhere in this module.
 *
 * ### Scale is fixed at 4, deliberately
 *
 * `decimal(18,4)` is the widest monetary column in play (`tenant_campaigns.budget_amount` is the
 * narrower `decimal(18,2)`, and every 2-place value is representable at 4 places without loss).
 * Fixing the scale means no operation ever has to decide what precision its result should carry,
 * which is where most decimal libraries' surprises live.
 */

/** Ten-thousandths — `decimal(18,4)`'s own scale. */
const SCALE = 4n;
const SCALE_FACTOR = 10_000n;

/** What {@link parse} accepts. Deliberately narrower than the database's own domain: no
 * exponent, no leading `+`, no thousands separators — none of which the wire contract's
 * `moneySchema` permits either, so anything else is a bug rather than an input. */
const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * A decimal string as an exact `bigint` of ten-thousandths, or `null` when it is not a decimal.
 *
 * Returns `null` rather than throwing: every caller here is computing a *warning*, and a
 * malformed amount that reached the database despite two schema layers should not take down a
 * maker's step-6 screen. The callers treat `null` as "cannot be compared" and skip the check,
 * which is the fail-safe direction — a missing warning, never a false one.
 */
export function parse(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const match = DECIMAL_PATTERN.exec(value.trim());
  if (match === null) return null;

  const [, sign, whole, fraction = ''] = match;
  // Pad or truncate the fraction to exactly SCALE digits. Truncation (rather than rounding) is
  // right here because the source is a `decimal(18,4)` column: more than four places cannot have
  // come from the database, so it can only be a hand-crafted request, and truncating toward zero
  // is the one behaviour that can never inflate a value past a ceiling it should have breached.
  const padded = (fraction + '0'.repeat(Number(SCALE))).slice(0, Number(SCALE));
  const magnitude = BigInt(whole) * SCALE_FACTOR + BigInt(padded);
  return sign === '-' ? -magnitude : magnitude;
}

/** The inverse of {@link parse} — a plain decimal string with exactly 4 places, trimmed of
 * trailing zeros down to a whole number where possible so the UI shows `500000` not
 * `500000.0000`. */
export function format(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / SCALE_FACTOR;
  const fraction = (magnitude % SCALE_FACTOR).toString().padStart(Number(SCALE), '0');
  const trimmed = fraction.replace(/0+$/, '');
  const body = trimmed === '' ? whole.toString() : `${whole.toString()}.${trimmed}`;
  return negative ? `-${body}` : body;
}

/** The exact sum of every parseable amount in `values`. Unparseable entries are skipped — see
 * {@link parse}. */
export function sum(values: readonly (string | null | undefined)[]): bigint {
  let total = 0n;
  for (const value of values) {
    total += parse(value) ?? 0n;
  }
  return total;
}

/** `value x multiplier`, where `multiplier` is a whole number (a day count, a grant count).
 * Exact, because a `bigint` times a `bigint` is exact. */
export function multiplyByInteger(value: bigint, multiplier: number): bigint {
  return value * BigInt(Math.trunc(multiplier));
}

/**
 * `value` as an integer percentage of `total`, rounded **half away from zero**, or `null` when
 * `total` is zero.
 *
 * Rounding matters here: this number decides whether a checker sees "94% of your tenant's
 * ceiling" (11-BUDGETS-AND-LIMITS.md §8.4) and whether the amber notice fires. Truncation would
 * report 99.6% as 99% — comfortably below a ceiling it has all but reached.
 */
export function percentOf(value: bigint, total: bigint): number | null {
  if (total === 0n) return null;
  const scaled = (value * 200n) / total;
  const rounded = scaled % 2n === 0n ? scaled / 2n : (scaled + (scaled < 0n ? -1n : 1n)) / 2n;
  return Number(rounded);
}

/** Whole days from `start` to `end`, minimum 1. Used by the "per-customer campaign limit is
 * unreachable" check (implementation note 15), which multiplies a daily limit by this. */
export function daysBetween(start: Date, end: Date): number {
  const millis = end.getTime() - start.getTime();
  if (!Number.isFinite(millis)) return 1;
  return Math.max(1, Math.ceil(millis / 86_400_000));
}
