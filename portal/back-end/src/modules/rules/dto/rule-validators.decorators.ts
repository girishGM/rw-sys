/**
 * T-031 — `class-validator` adapters for `rules.validators.ts`, the same split
 * `country-validators.decorators.ts` makes for `countries.validators.ts`.
 */
import {
  ValidationOptions,
  ValidatorConstraint,
  registerDecorator,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { isRuleCode, isRuleParameters } from '../rules.validators';

@ValidatorConstraint({ name: 'isRuleCode', async: false })
export class IsRuleCodeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isRuleCode(value);
  }

  defaultMessage(): string {
    return 'ruleCode must be upper-snake-case, starting with a letter';
  }
}

/** `@IsRuleCode()`. Fails with detail code `IS_RULE_CODE`. */
export function IsRuleCode(options?: ValidationOptions) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsRuleCodeConstraint,
    });
  };
}

@ValidatorConstraint({ name: 'isRuleParameters', async: false })
export class IsRuleParametersConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isRuleParameters(value);
  }

  defaultMessage(): string {
    return 'parameters must match the rule parameter meta-schema';
  }
}

/**
 * `@IsRuleParameters()`. Fails with detail code `IS_RULE_PARAMETERS` (TC-14: "400 with a
 * specific message" — `validation.exception-factory.ts` mechanically derives that code from
 * this constraint's name).
 */
export function IsRuleParameters(options?: ValidationOptions) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsRuleParametersConstraint,
    });
  };
}
