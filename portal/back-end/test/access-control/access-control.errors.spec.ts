import {
  ACCESS_CONTROL_ERROR_CODE,
  AccessControlVersionConflictError,
  CannotLockOutSuperAdminError,
  ProtectedPermissionError,
} from '@/modules/access-control/access-control.errors';

describe('CannotLockOutSuperAdminError', () => {
  it('is a 422 carrying the reason codes as details', () => {
    const error = new CannotLockOutSuperAdminError(['ACCESS_CONTROL_VIEW_REQUIRED']);
    expect(error.status).toBe(422);
    expect(error.code).toBe(ACCESS_CONTROL_ERROR_CODE.CANNOT_LOCK_OUT_SUPER_ADMIN);
    expect(error.details).toEqual([{ field: 'role', code: 'ACCESS_CONTROL_VIEW_REQUIRED' }]);
  });
});

describe('ProtectedPermissionError', () => {
  it('is a 422 naming each blocked cell', () => {
    const error = new ProtectedPermissionError([{ entity: 'rule', action: 'create' }]);
    expect(error.status).toBe(422);
    expect(error.code).toBe(ACCESS_CONTROL_ERROR_CODE.PROTECTED_PERMISSION);
    expect(error.details).toEqual([{ field: 'permissions', code: 'RULE_CREATE' }]);
  });
});

describe('AccessControlVersionConflictError', () => {
  it('is a 409', () => {
    const error = new AccessControlVersionConflictError(1, 3);
    expect(error.status).toBe(409);
    expect(error.code).toBe(ACCESS_CONTROL_ERROR_CODE.ACCESS_CONTROL_VERSION_CONFLICT);
  });
});
