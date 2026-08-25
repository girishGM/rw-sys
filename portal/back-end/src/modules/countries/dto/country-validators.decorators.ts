/**
 * T-030 — `class-validator` adapters for `countries.validators.ts`.
 *
 * Split from the plain functions so those stay framework-free and directly unit-testable (the
 * same split `me-request.dto.ts`'s `isIanaTimeZone` / `IsIanaTimeZone` makes).
 */
import {
  ValidationOptions,
  ValidatorConstraint,
  registerDecorator,
  type ValidatorConstraintInterface,
} from 'class-validator';
import {
  isIanaTimeZone,
  isIso3166Alpha2CountryCode,
  isIso4217CurrencyCode,
} from '../countries.validators';

@ValidatorConstraint({ name: 'isIso3166Alpha2CountryCode', async: false })
export class IsIso3166Alpha2CountryCodeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isIso3166Alpha2CountryCode(value);
  }

  defaultMessage(): string {
    return 'code must be a valid ISO-3166-1 alpha-2 country code';
  }
}

/** `@IsCountryCode()`. Fails with detail code `IS_ISO3166_ALPHA2_COUNTRY_CODE`. */
export function IsCountryCode(options?: ValidationOptions) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsIso3166Alpha2CountryCodeConstraint,
    });
  };
}

@ValidatorConstraint({ name: 'isIso4217CurrencyCode', async: false })
export class IsIso4217CurrencyCodeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isIso4217CurrencyCode(value);
  }

  defaultMessage(): string {
    return 'currencyCode must be a valid ISO-4217 currency code';
  }
}

/** `@IsCurrencyCode()`. Fails with detail code `IS_ISO4217_CURRENCY_CODE`. */
export function IsCurrencyCode(options?: ValidationOptions) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsIso4217CurrencyCodeConstraint,
    });
  };
}

@ValidatorConstraint({ name: 'isIanaTimeZone', async: false })
export class IsIanaTimeZoneConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isIanaTimeZone(value);
  }

  defaultMessage(): string {
    return 'timezone must be a valid IANA time zone identifier';
  }
}

/** `@IsTimeZone()`. Fails with detail code `IS_IANA_TIME_ZONE`. */
export function IsTimeZone(options?: ValidationOptions) {
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
