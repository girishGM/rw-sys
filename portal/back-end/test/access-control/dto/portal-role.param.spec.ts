import { PortalRoleParam } from '@/modules/access-control/dto/portal-role.param';
import { ValidationFailedError } from '@/common/errors/app-error';
import { ALL_PORTAL_ROLES } from '@/common/rbac/rbac.constants';

describe('PortalRoleParam', () => {
  const pipe = new PortalRoleParam();

  it.each(ALL_PORTAL_ROLES)('accepts %s', (role) => {
    expect(pipe.transform(role)).toBe(role);
  });

  it('rejects an unrecognised role with 400, not a bare string pass-through', () => {
    expect(() => pipe.transform('god_mode')).toThrow(ValidationFailedError);
  });

  it('rejects a role-shaped SQL/NoSQL injection attempt the same way', () => {
    expect(() => pipe.transform("super_admin' OR '1'='1")).toThrow(ValidationFailedError);
  });
});
