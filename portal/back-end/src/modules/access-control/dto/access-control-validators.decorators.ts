/**
 * T-033 — `class-validator` adapters for `access-control.validators.ts`, the same split
 * `rule-validators.decorators.ts` makes for `rules.validators.ts`.
 */
import {
  ValidationOptions,
  ValidatorConstraint,
  registerDecorator,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { isPermissionsMatrix, isWidgetConfig } from '../access-control.validators';

@ValidatorConstraint({ name: 'isPermissionsMatrix', async: false })
export class IsPermissionsMatrixConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isPermissionsMatrix(value);
  }

  defaultMessage(): string {
    return 'permissions must be a map of known entities to known actions (see GET /admin/access-control/entities)';
  }
}

/** `@IsPermissionsMatrix()`. Fails with detail code `IS_PERMISSIONS_MATRIX` (TC-23). */
export function IsPermissionsMatrix(options?: ValidationOptions) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsPermissionsMatrixConstraint,
    });
  };
}

@ValidatorConstraint({ name: 'isWidgetConfig', async: false })
export class IsWidgetConfigConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isWidgetConfig(value);
  }

  defaultMessage(): string {
    return 'config must be a plain object';
  }
}

/** `@IsWidgetConfig()`. Fails with detail code `IS_WIDGET_CONFIG`. */
export function IsWidgetConfig(options?: ValidationOptions) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsWidgetConfigConstraint,
    });
  };
}
