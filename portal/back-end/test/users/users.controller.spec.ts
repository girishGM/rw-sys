/**
 * T-035 — `UsersController`: thin, and metadata-driven. Same shape `tenants.controller.spec.ts`
 * establishes: 403/404 behaviour is `RolesGuard`'s/`PermissionsGuard`'s and `UsersService`'s
 * respectively (both already exhaustively tested elsewhere); this suite proves the controller
 * declares the right `role_entity_permissions` grant per route (R6) and delegates without adding
 * logic of its own.
 */
import 'reflect-metadata';
import type { Request } from 'express';
import { PERMISSION_METADATA_KEY, ROLES_METADATA_KEY } from '@/common/rbac/rbac.constants';
import { AUDIT_METADATA } from '@/common/audit/decorators/audit.decorator';
import { UsersController } from '@/modules/users/users.controller';
import type { UsersService } from '@/modules/users/users.service';
import type { PortalRole } from '@/database/portal-models';
import { actor, portalUserRow } from './support/users-doubles';

function permissionOf(handler: (...args: never[]) => unknown): { entity: string; action: string } {
  return Reflect.getMetadata(PERMISSION_METADATA_KEY, handler) as {
    entity: string;
    action: string;
  };
}

function rolesOf(handler: (...args: never[]) => unknown): readonly PortalRole[] | undefined {
  return Reflect.getMetadata(ROLES_METADATA_KEY, handler) as readonly PortalRole[] | undefined;
}

function fakeRequest(overrides: Partial<Request> = {}): Request {
  return { ip: '203.0.113.5', headers: { 'user-agent': 'jest-agent' }, ...overrides } as Request;
}

describe('UsersController — authorisation metadata (R6)', () => {
  it('GET routes require user:view', () => {
    expect(permissionOf(UsersController.prototype.list)).toEqual({
      entity: 'user',
      action: 'view',
    });
    expect(permissionOf(UsersController.prototype.findOne)).toEqual({
      entity: 'user',
      action: 'view',
    });
  });

  it('POST / requires user:create — maker/checker/merchant hold nothing for this entity (T004_001 seed, TC-9/TC-10)', () => {
    expect(permissionOf(UsersController.prototype.create)).toEqual({
      entity: 'user',
      action: 'create',
    });
  });

  it('PATCH /:id, POST /:id/deactivate and POST /:id/reset-password require user:update', () => {
    expect(permissionOf(UsersController.prototype.update)).toEqual({
      entity: 'user',
      action: 'update',
    });
    expect(permissionOf(UsersController.prototype.deactivate)).toEqual({
      entity: 'user',
      action: 'update',
    });
    expect(permissionOf(UsersController.prototype.resetPassword)).toEqual({
      entity: 'user',
      action: 'update',
    });
  });

  it('audits user_created, user_updated, user_deactivated and user_password_reset', () => {
    const events: Record<string, { event: string; targetType?: string }> = {
      create: Reflect.getMetadata(AUDIT_METADATA, UsersController.prototype.create),
      update: Reflect.getMetadata(AUDIT_METADATA, UsersController.prototype.update),
      deactivate: Reflect.getMetadata(AUDIT_METADATA, UsersController.prototype.deactivate),
      resetPassword: Reflect.getMetadata(AUDIT_METADATA, UsersController.prototype.resetPassword),
    };

    expect(events.create).toMatchObject({ event: 'user_created', targetType: 'user' });
    expect(events.update).toMatchObject({ event: 'user_updated', targetType: 'user' });
    expect(events.deactivate).toMatchObject({ event: 'user_deactivated', targetType: 'user' });
    expect(events.resetPassword).toMatchObject({
      event: 'user_password_reset',
      targetType: 'user',
    });
  });

  // --- T-128: GET/PATCH /users/me/preferences --------------------------------------------------

  it('TC-4: GET/PATCH /users/me/preferences carry @Roles(...ALL_PORTAL_ROLES) and no @RequirePermission — self-service, every role, no admin gate', () => {
    const allRoles: readonly PortalRole[] = [
      'super_admin',
      'country_admin',
      'tenant_admin',
      'maker',
      'checker',
      'merchant',
    ];

    expect(rolesOf(UsersController.prototype.getMyPreferences)).toEqual(allRoles);
    expect(rolesOf(UsersController.prototype.updateMyPreferences)).toEqual(allRoles);
    expect(permissionOf(UsersController.prototype.getMyPreferences)).toBeUndefined();
    expect(permissionOf(UsersController.prototype.updateMyPreferences)).toBeUndefined();
  });

  it('audits user_preferences_updated', () => {
    expect(
      Reflect.getMetadata(AUDIT_METADATA, UsersController.prototype.updateMyPreferences),
    ).toMatchObject({ event: 'user_preferences_updated', targetType: 'portal_user' });
  });
});

describe('UsersController — delegation', () => {
  function controllerWith(service: Partial<UsersService>): UsersController {
    return new UsersController(service as UsersService);
  }

  it('list() wraps the service result in {data, meta}', async () => {
    const list = jest.fn().mockResolvedValue({
      rows: [portalUserRow()],
      meta: { page: 1, pageSize: 20, total: 1 },
    });
    const controller = controllerWith({ list });

    const response = await controller.list({});

    expect(list).toHaveBeenCalledWith({});
    expect(response.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
    expect(response.data).toHaveLength(1);
  });

  it('findOne() delegates the numeric id and wraps in {data}', async () => {
    const getById = jest.fn().mockResolvedValue(portalUserRow({ id: 9 }));
    const controller = controllerWith({ getById });

    const response = await controller.findOne(9);

    expect(getById).toHaveBeenCalledWith(9);
    expect(response.data).toMatchObject({ id: 9 });
  });

  it('getMyPreferences() passes only the actor through and wraps in {data} — TC-6: no id parameter exists on this route to spoof', async () => {
    const getPreferences = jest.fn().mockResolvedValue({ uiTheme: 'light-blue' });
    const controller = controllerWith({ getPreferences });
    const who = actor();

    const response = await controller.getMyPreferences(who);

    expect(getPreferences).toHaveBeenCalledWith(who);
    expect(getPreferences).toHaveBeenCalledTimes(1);
    expect(response.data).toEqual({ uiTheme: 'light-blue' });
  });

  it('updateMyPreferences() passes the actor and the requested theme through, untouched', async () => {
    const updatePreferences = jest.fn().mockResolvedValue({ uiTheme: 'yellow-black' });
    const controller = controllerWith({ updatePreferences });
    const who = actor();

    const response = await controller.updateMyPreferences(who, { uiTheme: 'yellow-black' });

    expect(updatePreferences).toHaveBeenCalledWith(who, 'yellow-black');
    expect(response.data).toEqual({ uiTheme: 'yellow-black' });
  });

  it('create() passes the actor and the dto through, untouched', async () => {
    const create = jest.fn().mockResolvedValue({ ...portalUserRow(), temporaryPassword: 'x' });
    const controller = controllerWith({ create });
    const who = actor();
    const dto = { role: 'maker' } as Parameters<UsersService['create']>[1];

    await controller.create(who, dto);

    expect(create).toHaveBeenCalledWith(who, dto);
  });

  it('update() passes the actor, id and dto through (T-088: the actor is now required for the role-management floor)', async () => {
    const update = jest.fn().mockResolvedValue(portalUserRow({ id: 1 }));
    const controller = controllerWith({ update });
    const who = actor();
    const dto = { displayName: 'New' } as Parameters<UsersService['update']>[2];

    await controller.update(who, 1, dto);

    expect(update).toHaveBeenCalledWith(who, 1, dto);
  });

  it('deactivate() passes the actor, id and a request-derived context through', async () => {
    const deactivate = jest.fn().mockResolvedValue(portalUserRow({ id: 1, status: 'inactive' }));
    const controller = controllerWith({ deactivate });
    const who = actor();

    await controller.deactivate(who, 1, fakeRequest());

    expect(deactivate).toHaveBeenCalledWith(who, 1, {
      ipAddress: '203.0.113.5',
      userAgent: 'jest-agent',
    });
  });

  it('deactivate() falls back to null ip/user-agent when the request carries neither', async () => {
    const deactivate = jest.fn().mockResolvedValue(portalUserRow({ id: 1, status: 'inactive' }));
    const controller = controllerWith({ deactivate });
    const who = actor();

    await controller.deactivate(who, 1, fakeRequest({ ip: undefined, headers: {} }));

    expect(deactivate).toHaveBeenCalledWith(who, 1, { ipAddress: null, userAgent: null });
  });

  it('resetPassword() passes the actor, id and a request-derived context through', async () => {
    const resetPassword = jest
      .fn()
      .mockResolvedValue({ ...portalUserRow({ id: 1 }), temporaryPassword: 'x' });
    const controller = controllerWith({ resetPassword });
    const who = actor();

    await controller.resetPassword(who, 1, fakeRequest());

    expect(resetPassword).toHaveBeenCalledWith(who, 1, {
      ipAddress: '203.0.113.5',
      userAgent: 'jest-agent',
    });
  });
});
