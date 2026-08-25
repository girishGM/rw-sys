/**
 * T-035 — the domain error classes and their HTTP status/code mapping (03-API-CONTRACT.md §1).
 */
import {
  CannotDeactivateSelfError,
  RoleChangeNotPermittedError,
  RoleCreationNotPermittedError,
  USER_ERROR_CODE,
  UserEmailExistsError,
  targetScopeIdRequiredError,
} from '@/modules/users/users.errors';

describe('users.errors', () => {
  it('RoleCreationNotPermittedError is 403 ROLE_CREATION_NOT_PERMITTED', () => {
    const error = new RoleCreationNotPermittedError();
    expect(error.status).toBe(403);
    expect(error.code).toBe(USER_ERROR_CODE.ROLE_CREATION_NOT_PERMITTED);
  });

  it('RoleChangeNotPermittedError is 403 ROLE_CHANGE_NOT_PERMITTED', () => {
    const error = new RoleChangeNotPermittedError();
    expect(error.status).toBe(403);
    expect(error.code).toBe(USER_ERROR_CODE.ROLE_CHANGE_NOT_PERMITTED);
  });

  it('UserEmailExistsError is 409 USER_EMAIL_EXISTS', () => {
    const error = new UserEmailExistsError();
    expect(error.status).toBe(409);
    expect(error.code).toBe(USER_ERROR_CODE.USER_EMAIL_EXISTS);
  });

  it('CannotDeactivateSelfError is 422 CANNOT_DEACTIVATE_SELF (TC-23)', () => {
    const error = new CannotDeactivateSelfError();
    expect(error.status).toBe(422);
    expect(error.code).toBe(USER_ERROR_CODE.CANNOT_DEACTIVATE_SELF);
  });

  it('targetScopeIdRequiredError is a 400 carrying the missing field (TC-14)', () => {
    const error = targetScopeIdRequiredError('merchantId');
    expect(error.status).toBe(400);
    expect(error.details).toEqual([{ field: 'merchantId', code: 'REQUIRED' }]);
  });

  it('every code is UPPER_SNAKE_CASE — the shape ErrorNormalizationFilter requires to serialise it', () => {
    for (const code of Object.values(USER_ERROR_CODE)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]{1,59}$/);
    }
  });

  it('carries no internal detail in its own `message` beyond what AppError already logs server-side', () => {
    const error = new UserEmailExistsError();
    expect(error.message).not.toMatch(/uq_portal_users_email_live/);
  });
});
