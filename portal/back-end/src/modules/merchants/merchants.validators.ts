/**
 * T-036 — validation for the one shape unique to this module: `commission_rate`
 * (implementation note 5). Framework-free here, `class-validator` adapters in
 * `dto/merchant-validators.decorators.ts` — the same split `tenants.validators.ts` makes, for
 * the same reason: directly unit-testable without booting a DTO.
 */
import {
  COMMISSION_RATE_MAX,
  COMMISSION_RATE_MAX_FRACTION_DIGITS,
  COMMISSION_RATE_MIN,
} from './merchants.constants';

/**
 * Whether `value` is a valid `merchant_activities.commission_rate`: a finite number, `0–100`
 * inclusive, with at most {@link COMMISSION_RATE_MAX_FRACTION_DIGITS} fractional digits.
 *
 * The fractional-digit count is read off `value.toString()` rather than computed arithmetically
 * (e.g. via `value * 100`): for any two-decimal input in this 0–100 range, JavaScript's
 * shortest-round-trip `Number#toString` reproduces the original decimal text exactly (there is
 * no float artefact to guard against at this magnitude), whereas `value * 100` can itself
 * introduce one (`12.34 * 100 === 1233.9999999999998` is not the case here, but the class of bug
 * is real and this sidesteps it rather than adding an epsilon).
 */
export function isCommissionRate(value: unknown): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (value < COMMISSION_RATE_MIN || value > COMMISSION_RATE_MAX) return false;

  const text = value.toString();
  const dot = text.indexOf('.');
  if (dot === -1) return true;
  return text.length - dot - 1 <= COMMISSION_RATE_MAX_FRACTION_DIGITS;
}

/** `commission_rate decimal(5,2)` is read back from Postgres as a string (Sequelize's `DECIMAL`
 * type never coerces to `number` — the same "never coerce" the model's own header states). This
 * is the one write-side conversion: `12.34` (validated by {@link isCommissionRate}) → `"12.34"`,
 * always exactly two fractional digits, so a whole-number input like `50` is stored as `50.00`
 * rather than `50`, matching what a `decimal(5,2)` column would echo back regardless. */
export function commissionRateToColumnString(value: number): string {
  return value.toFixed(COMMISSION_RATE_MAX_FRACTION_DIGITS);
}
