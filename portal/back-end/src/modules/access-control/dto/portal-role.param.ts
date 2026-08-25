/**
 * T-033 — validates the `:role` path segment every route in this module takes, against the
 * fixed six-role catalogue (`@Roles()`'s own list, `ALL_PORTAL_ROLES`) rather than trusting it as
 * a bare string. An unrecognised role is a malformed request (400), the same treatment
 * `@IsIn(ALL_PORTAL_ROLES)` gives `PreviewDto.role` — a path parameter is not exempt from the rule
 * just because it did not arrive through a DTO.
 */
import { Injectable, type PipeTransform } from '@nestjs/common';
import { ALL_PORTAL_ROLES } from '@/common/rbac/rbac.constants';
import type { PortalRole } from '@/database/portal-models';
import { ValidationFailedError } from '@/common/errors/app-error';

@Injectable()
export class PortalRoleParam implements PipeTransform<string, PortalRole> {
  transform(value: string): PortalRole {
    if ((ALL_PORTAL_ROLES as readonly string[]).includes(value)) {
      return value as PortalRole;
    }
    throw new ValidationFailedError([{ field: 'role', code: 'INVALID_ROLE' }], {
      logContext: { value },
    });
  }
}
