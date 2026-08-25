/**
 * T-015 — the one request body `/me` accepts.
 *
 * ### What is deliberately absent, and why it is the whole point of this file
 *
 * 03-API-CONTRACT.md §3: *"`displayName`, `preferredLocale`, `preferredTimezone` **only** — role
 * and scope are not writable here."* T-015 implementation note 5 spells out the consequence:
 * *"Any attempt to set `role`, `tenantId`, `countryId`, `merchantId`, `status` is rejected by
 * `forbidNonWhitelisted`. Explicit test required — this is the obvious escalation path."*
 *
 * It really is the obvious one. Every authenticated account in the system can reach `PATCH /me`;
 * if a `role` field were honoured here, the entire authorisation model would be one JSON key away
 * from irrelevant for any user who has logged in once. So three independent controls stand in the
 * way, and TC-16/TC-17 assert the outcome of the stack rather than of any single layer:
 *
 *  1. **This DTO** declares three properties. The global `ValidationPipe` runs with
 *     `forbidNonWhitelisted: true`, so an undeclared key is a **400** (`UNEXPECTED_FIELD`), not a
 *     silently stripped field — a probe fails loudly instead of appearing to succeed.
 *  2. **The service** passes only these three names to the update, built as a fresh literal.
 *  3. **`ScopedRepository.update`** strips the scope columns from any values it is given and
 *     constrains the WHERE clause to the caller's own row (T-013). Even a DTO that had been
 *     mis-declared could not move a row between tenants.
 *
 * `role` and `status` are not scope columns and so are *not* covered by control 3 — which is
 * exactly why controls 1 and 2 are written the way they are, and why the DTO is a whitelist of
 * three names rather than a blacklist of dangerous ones. A blacklist would need updating every
 * time `portal_users` gains a column.
 *
 * ### Bounds match the columns
 *
 * `display_name varchar(100)`, `preferred_locale varchar(10)`, `preferred_timezone varchar(60)`
 * (01-DATABASE.md §2.1). A value that would be truncated or rejected by Postgres is rejected here
 * first, with a field-level code the SPA can render, rather than surfacing as a 500 from a
 * constraint violation.
 */
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidationOptions,
  ValidatorConstraint,
  registerDecorator,
  type ValidatorConstraintInterface,
} from 'class-validator';

/** `portal_users.display_name` is `varchar(100)`. */
const DISPLAY_NAME_MAX_LENGTH = 100;
/** `portal_users.preferred_locale` is `varchar(10)`. */
const LOCALE_MAX_LENGTH = 10;
/** `portal_users.preferred_timezone` is `varchar(60)`. */
const TIMEZONE_MAX_LENGTH = 60;

/**
 * A BCP-47-shaped language tag: `en`, `en-GB`, `sr-Latn-RS`.
 *
 * Character-class-restricted rather than merely length-bounded because this value is echoed back
 * in every bootstrap response and is used by the SPA to pick a locale bundle. Anything outside
 * `[A-Za-z0-9-]` has no legitimate reading as a locale and every illegitimate one.
 */
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * Whether `value` names a time zone this Node runtime's ICU data knows.
 *
 * `Intl.DateTimeFormat` throws `RangeError` for an unknown zone, which makes the check both exact
 * and free of a hand-maintained list that would go stale the next time the IANA database gains a
 * zone. Exported so it can be tested directly rather than through a DTO round trip.
 *
 * Storing an unvalidated string would not be a security hole, but it would be a durable one: the
 * value is read back by every date the SPA renders for that user, and a typo'd zone would throw
 * in the browser on a screen that has nothing to do with the profile form where it was entered.
 */
export function isIanaTimeZone(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    // The constructor is the validation; the formatter itself is discarded.
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The `class-validator` adapter for {@link isIanaTimeZone}. */
@ValidatorConstraint({ name: 'isIanaTimeZone', async: false })
export class IsIanaTimeZoneConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isIanaTimeZone(value);
  }

  /** Server-side only — `validationExceptionFactory` sends the constraint *name*, not this text. */
  defaultMessage(): string {
    return 'preferredTimezone must be a valid IANA time zone identifier';
  }
}

/** `@IsIanaTimeZone()`. Fails with detail code `IS_IANA_TIME_ZONE`. */
export function IsIanaTimeZone(options?: ValidationOptions) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsIanaTimeZoneConstraint,
    });
  };
}

/**
 * `PATCH /me`.
 *
 * Every field is optional: the SPA's profile form submits only what changed, and an empty body is
 * a legitimate no-op that returns the unchanged profile rather than a 400. What is *not* optional
 * is the set of names — see the file header.
 */
export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(DISPLAY_NAME_MAX_LENGTH)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(LOCALE_MAX_LENGTH)
  @Matches(LOCALE_PATTERN)
  preferredLocale?: string;

  @IsOptional()
  @IsString()
  @MaxLength(TIMEZONE_MAX_LENGTH)
  @IsIanaTimeZone()
  preferredTimezone?: string;
}

/**
 * The property names {@link UpdateMeDto} declares, as data.
 *
 * Exists so `test/me/me.dto.spec.ts` can assert that this list, the DTO's `class-validator`
 * metadata and `updateMeSchema` in `packages/shared` all name the same three fields. Three
 * declarations of one rule is two chances to drift; the test removes both.
 */
export const UPDATE_ME_FIELDS = Object.freeze([
  'displayName',
  'preferredLocale',
  'preferredTimezone',
] as const);

export type UpdateMeField = (typeof UPDATE_ME_FIELDS)[number];
