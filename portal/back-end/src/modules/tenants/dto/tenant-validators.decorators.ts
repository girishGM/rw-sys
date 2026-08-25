/**
 * T-034 — `class-validator` adapters for `tenants.validators.ts`. Same split
 * `country-validators.decorators.ts` makes.
 */
import {
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  registerDecorator,
  type ValidatorConstraintInterface,
} from 'class-validator';
import {
  decimalStringLessThanOrEqual,
  isDecimalString,
  isPositiveDecimalString,
  isTenantSchemaPrefix,
} from '../tenants.validators';

@ValidatorConstraint({ name: 'isTenantSchemaPrefix', async: false })
export class IsTenantSchemaPrefixConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isTenantSchemaPrefix(value);
  }

  defaultMessage(): string {
    return 'schemaPrefix must start with a lowercase letter and contain only lowercase letters, digits or underscores (max 10 characters)';
  }
}

/** `@IsTenantSchemaPrefix()`. Fails with detail code `IS_TENANT_SCHEMA_PREFIX`. */
export function IsTenantSchemaPrefix(options?: ValidationOptions) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsTenantSchemaPrefixConstraint,
    });
  };
}

@ValidatorConstraint({ name: 'isPositiveDecimalString', async: false })
export class IsPositiveDecimalStringConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isPositiveDecimalString(value);
  }

  defaultMessage(): string {
    return 'must be a positive decimal amount with up to 4 fractional digits';
  }
}

/** `@IsPositiveDecimalString()`. Fails with detail code `IS_POSITIVE_DECIMAL_STRING`. */
export function IsPositiveDecimalString(options?: ValidationOptions) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsPositiveDecimalStringConstraint,
    });
  };
}

@ValidatorConstraint({ name: 'isDecimalString', async: false })
export class IsDecimalStringConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isDecimalString(value);
  }

  defaultMessage(): string {
    return 'must be a decimal amount with up to 4 fractional digits';
  }
}

/** `@IsDecimalString()`. Fails with detail code `IS_DECIMAL_STRING`. */
export function IsDecimalString(options?: ValidationOptions) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsDecimalStringConstraint,
    });
  };
}

@ValidatorConstraint({ name: 'warnAboveNotExceedingCeiling', async: false })
export class WarnAboveNotExceedingCeilingConstraint implements ValidatorConstraintInterface {
  /**
   * `ck_tbc_warn`, enforced client-of-the-database-side (400, not 422 — TC-27): "a warning
   * threshold above the hard stop can never fire" is a shape problem with the request, not a
   * business decision about an otherwise-valid one. `value` is `warnAboveAmount`; the ceiling it
   * is compared against lives on the same DTO instance, read from `args.object`.
   */
  validate(value: unknown, args?: ValidationArguments): boolean {
    if (value === undefined || value === null) return true;
    if (!isDecimalString(value)) return true; // a shape error on this field, not a cross-field one
    const ceiling = (args?.object as Record<string, unknown> | undefined)?.['maxCampaignBudget'];
    if (typeof ceiling !== 'string' || !isDecimalString(ceiling)) return true;
    return decimalStringLessThanOrEqual(value as string, ceiling);
  }

  defaultMessage(): string {
    return 'warnAboveAmount must not exceed maxCampaignBudget';
  }
}

/** `@WarnAboveNotExceedingCeiling()`. Fails with detail code `WARN_ABOVE_NOT_EXCEEDING_CEILING`. */
export function WarnAboveNotExceedingCeiling(options?: ValidationOptions) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: WarnAboveNotExceedingCeilingConstraint,
    });
  };
}
