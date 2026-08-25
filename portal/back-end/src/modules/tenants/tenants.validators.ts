/**
 * T-034 — validation for the two shapes that are unique to this module: `schemaPrefix`
 * (implementation note 4) and the decimal-string money fields `tenant_budget_ceilings` carries
 * (11-BUDGETS-AND-LIMITS.md §8.2, `TenantBudgetCeiling`'s own header: *"money never crosses a
 * boundary as a float"*).
 *
 * Split into plain, framework-free functions here and `class-validator` adapters in
 * `tenant-validators.decorators.ts` — the same split `countries.validators.ts` makes, for the
 * same reason: directly unit-testable without booting a DTO.
 */
import {
  TENANT_BUDGET_CEILING_FRACTION_DIGITS,
  TENANT_BUDGET_CEILING_INTEGER_DIGITS,
} from './tenants.constants';

/**
 * Implementation note 4, verbatim: `^[a-z][a-z0-9_]{0,9}$`. A leading letter (never a digit —
 * this becomes a schema/identifier prefix downstream, and an identifier may not start with a
 * digit in Postgres), lowercase only (case-folding surprises are exactly what an identifier
 * prefix must not have), 1–10 characters total.
 */
const SCHEMA_PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,9}$/;

/** Whether `value` is a valid `tenants.schema_prefix` (implementation note 4). */
export function isTenantSchemaPrefix(value: unknown): boolean {
  return typeof value === 'string' && SCHEMA_PREFIX_PATTERN.test(value);
}

/**
 * A `decimal(18,4)`-shaped string: an optional sign is **not** accepted (money here is never
 * negative — `ck_tbc_positive`/`ck_campaign_caps_positive`-style checks reject `<= 0` downstream
 * regardless, but a bare digit grammar is also a cheaper first-line rejection of `-5`), up to
 * {@link TENANT_BUDGET_CEILING_INTEGER_DIGITS} integer digits, and an optional `.` followed by up
 * to {@link TENANT_BUDGET_CEILING_FRACTION_DIGITS} fractional digits.
 */
const DECIMAL_STRING_PATTERN = new RegExp(
  `^\\d{1,${TENANT_BUDGET_CEILING_INTEGER_DIGITS}}(\\.\\d{1,${TENANT_BUDGET_CEILING_FRACTION_DIGITS}})?$`,
);

/** Whether `value` is a well-formed, non-negative `decimal(18,4)` string. */
export function isDecimalString(value: unknown): boolean {
  return typeof value === 'string' && DECIMAL_STRING_PATTERN.test(value);
}

/** As {@link isDecimalString}, and additionally strictly greater than zero (`ck_tbc_positive`). */
export function isPositiveDecimalString(value: unknown): boolean {
  return isDecimalString(value) && decimalStringToBigInt(value as string) > 0n;
}

/**
 * `a <= b`, compared as exact fixed-point values rather than as floats — the reason
 * `TenantBudgetCeiling.maxCampaignBudget` is a string in the first place. Both arguments must
 * already be well-formed decimal strings (see {@link isDecimalString}); this function does not
 * re-validate their shape.
 */
export function decimalStringLessThanOrEqual(a: string, b: string): boolean {
  return decimalStringToBigInt(a) <= decimalStringToBigInt(b);
}

/**
 * Scales a decimal string up to {@link TENANT_BUDGET_CEILING_FRACTION_DIGITS} fractional digits
 * and returns it as an integer `BigInt`, so two amounts can be compared exactly regardless of how
 * many fractional digits each one happened to specify (`"5"` and `"5.0000"` must compare equal).
 */
function decimalStringToBigInt(value: string): bigint {
  const [integerPart, fractionPart = ''] = value.split('.');
  const paddedFraction = fractionPart.padEnd(TENANT_BUDGET_CEILING_FRACTION_DIGITS, '0');
  return BigInt(integerPart + paddedFraction);
}
