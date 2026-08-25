/**
 * T-030 — reference-data validation for `code` (ISO-3166-1 alpha-2), `timezone` (IANA) and
 * `currencyCode` (ISO-4217).
 *
 * `timezone` and `currencyCode` use `Intl.supportedValuesOf`, the same choice
 * `back-end/src/modules/me/dto/me-request.dto.ts`'s `isIanaTimeZone` already made for time
 * zones and documents at length: *"free of a hand-maintained list that would go stale the next
 * time the [registry] gains an entry"*. `isIanaTimeZone` itself is not imported from here —
 * `modules/me` is another task's file scope, and duplicating three lines of ICU lookup is
 * cheaper than a cross-module coupling for it (the same trade-off `common/audit/
 * audit.constants.ts` documents for its own duplicated error-code literals).
 *
 * `code` is **not** validated this way, despite an earlier draft of this file assuming it could
 * be: `Intl.supportedValuesOf('region')` reads as though it should exist (CLDR does track
 * region/territory codes, and several other ECMA-402 methods accept a `region` subtag), but
 * `'region'` is not one of the six keys the `supportedValuesOf` specification actually defines
 * (`'calendar' | 'collation' | 'currency' | 'numberingSystem' | 'timeZone' | 'unit'` — exactly
 * what this project's configured TypeScript `lib` already declares, correctly). Calling it with
 * `'region'` throws `RangeError: Invalid key` at **runtime**, on every supported Node version —
 * this was caught by `countries.validators.spec.ts` failing to import at all, not by a narrower
 * assertion, which is the sign of a wrong assumption rather than a missing edge case. `code` is
 * therefore validated against the list below: the officially assigned ISO-3166-1 alpha-2
 * elements (the same 249-code set `iso-3166-1`/`i18n-iso-countries` and similar npm packages
 * ship), transcribed once and reviewable in one place — the same "declared, not inferred" choice
 * `scope-strategy.ts` makes for the scope map, for the same reason: a silently wrong assumption
 * about what a runtime API returns is worse than a list that needs an occasional update when
 * ISO assigns a new code (this happens on the order of once every few years, not per release).
 */

/** Every code `Intl.supportedValuesOf('currency')` reports — ISO-4217. */
const ISO_4217_CURRENCY_CODES: ReadonlySet<string> = new Set(
  Intl.supportedValuesOf('currency').map((code) => code.toUpperCase()),
);

/**
 * ISO-3166-1 alpha-2 — every officially assigned element, upper-case, space-separated (a plain
 * array literal here reads as ~250 short lines or a `prettier`-hostile wall of commas either
 * way; a single reviewable string is the more legible "declared, not inferred" choice
 * `scope-strategy.ts`'s header argues for). Includes the "exceptional reservations" (`GB`, ...)
 * and current dependent-territory codes (`HK`, `TW`, `PR`, ...); excludes codes ISO has
 * withdrawn or never assigned (`UK`, the common but *not* ISO-standard alias for `GB`, is
 * deliberately absent).
 */
const ISO_3166_ALPHA2_CODE_LIST =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ ' +
  'BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ ' +
  'DE DJ DK DM DO DZ ' +
  'EC EE EG EH ER ES ET ' +
  'FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY ' +
  'HK HM HN HR HT HU ' +
  'ID IE IL IM IN IO IQ IR IS IT ' +
  'JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ ' +
  'LA LB LC LI LK LR LS LT LU LV LY ' +
  'MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ ' +
  'NA NC NE NF NG NI NL NO NP NR NU NZ ' +
  'OM ' +
  'PA PE PF PG PH PK PL PM PN PR PS PT PW PY ' +
  'QA ' +
  'RE RO RS RU RW ' +
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ ' +
  'TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ ' +
  'UA UG UM US UY UZ ' +
  'VA VC VE VG VI VN VU ' +
  'WF WS ' +
  'YE YT ' +
  'ZA ZM ZW';

const ISO_3166_ALPHA2_CODES: ReadonlySet<string> = new Set(ISO_3166_ALPHA2_CODE_LIST.split(' '));

/** Whether `value` is a 2-letter ISO-3166-1 country code, case-insensitively. */
export function isIso3166Alpha2CountryCode(value: unknown): boolean {
  if (typeof value !== 'string' || value.length !== 2) return false;
  return ISO_3166_ALPHA2_CODES.has(value.toUpperCase());
}

/** Whether `value` is a 3-letter ISO-4217 currency code, case-insensitively. */
export function isIso4217CurrencyCode(value: unknown): boolean {
  if (typeof value !== 'string' || value.length !== 3) return false;
  return ISO_4217_CURRENCY_CODES.has(value.toUpperCase());
}

/**
 * Whether `value` names a time zone this Node runtime's ICU data knows.
 *
 * Deliberately the same technique as `modules/me/dto/me-request.dto.ts`'s `isIanaTimeZone` (see
 * this file's own header for why it is a local copy rather than an import): `Intl.DateTimeFormat`
 * throws `RangeError` for an unknown zone, which is both exact and free of a hand-maintained list.
 */
export function isIanaTimeZone(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
