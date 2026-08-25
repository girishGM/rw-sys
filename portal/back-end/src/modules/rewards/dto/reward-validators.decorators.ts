/**
 * T-032 — `class-validator` adapters for `rewards.validators.ts`, the same split
 * `rule-validators.decorators.ts` makes for `rules.validators.ts`.
 */
import {
  ValidationOptions,
  ValidatorConstraint,
  registerDecorator,
  type ValidatorConstraintInterface,
} from 'class-validator';
import {
  isRewardConnectorConfig,
  isRewardPolicyCode,
  isRewardSystemCode,
} from '../rewards.validators';

@ValidatorConstraint({ name: 'isRewardSystemCode', async: false })
export class IsRewardSystemCodeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isRewardSystemCode(value);
  }

  defaultMessage(): string {
    return 'systemCode must be upper-snake-case, starting with a letter';
  }
}

/** `@IsRewardSystemCode()`. Fails with detail code `IS_REWARD_SYSTEM_CODE`. */
export function IsRewardSystemCode(options?: ValidationOptions) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsRewardSystemCodeConstraint,
    });
  };
}

@ValidatorConstraint({ name: 'isRewardPolicyCode', async: false })
export class IsRewardPolicyCodeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isRewardPolicyCode(value);
  }

  defaultMessage(): string {
    return 'policyCode must be upper-snake-case, starting with a letter';
  }
}

/** `@IsRewardPolicyCode()`. Fails with detail code `IS_REWARD_POLICY_CODE`. */
export function IsRewardPolicyCode(options?: ValidationOptions) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsRewardPolicyCodeConstraint,
    });
  };
}

@ValidatorConstraint({ name: 'isRewardConnectorConfig', async: false })
export class IsRewardConnectorConfigConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isRewardConnectorConfig(value);
  }

  defaultMessage(): string {
    return 'connectorConfig must be a flat object of at most 30 string/number/boolean values';
  }
}

/**
 * `@IsRewardConnectorConfig()`. Fails with detail code `IS_REWARD_CONNECTOR_CONFIG` (TC-15's own
 * pattern for a domain-specific 400 — a specific message via the same `class-validator` →
 * `validationExceptionFactory` pipeline every other DTO field uses).
 */
export function IsRewardConnectorConfig(options?: ValidationOptions) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsRewardConnectorConfigConstraint,
    });
  };
}
