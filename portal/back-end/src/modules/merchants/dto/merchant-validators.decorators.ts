/**
 * T-036 — `class-validator` adapters for `merchants.validators.ts`. Same split
 * `tenant-validators.decorators.ts` makes.
 */
import {
  ValidationOptions,
  ValidatorConstraint,
  registerDecorator,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { isCommissionRate } from '../merchants.validators';

@ValidatorConstraint({ name: 'isCommissionRate', async: false })
export class IsCommissionRateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isCommissionRate(value);
  }

  defaultMessage(): string {
    return 'commissionRate must be a number between 0 and 100 with at most 2 decimal places';
  }
}

/** `@IsCommissionRate()`. Fails with detail code `IS_COMMISSION_RATE` (TC-17, TC-18). */
export function IsCommissionRate(options?: ValidationOptions) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsCommissionRateConstraint,
    });
  };
}
