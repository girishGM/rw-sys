/**
 * T-035 — `UsersController`: thin, and metadata-driven. Same shape `tenants.controller.spec.ts`
 * establishes: 403/404 behaviour is `RolesGuard`'s/`PermissionsGuard`'s and `UsersService`'s
 * respectively (both already exhaustively tested elsewhere); this suite proves the controller
 * declares the right `role_entity_permissions` grant per route (R6) and delegates without adding
 * logic of its own.
 */
import 'reflect-metadata';
import type { Request } from 'express';
import { PERMISSION_METADATA_KEY } from '@/common/rbac/rbac.constants';
import { AUDIT_METADATA } from '@/common/audit/decorators/audit.decorator';
import { UsersController } from '@/modules/users/users.controller';
import type { UsersService } from '@/modules/users/users.service';
import { actor, portalUserRow } from './support/users-doubles';

function permissionOf(handler: (...args: never[]) => unknown): { entity: string; action: string } {
  return Reflect.getMetadata(PERMISSION_METADATA_KEY, handler) as {
    entity: string;
    action: string;
  };
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
