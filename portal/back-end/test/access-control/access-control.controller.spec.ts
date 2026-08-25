/**
 * T-033 — `AccessControlController`: thin and metadata-driven, the same shape
 * `test/rules/rules.controller.spec.ts` establishes. Proves implementation note 1 literally —
 * "Every one is `@Roles('super_admin')` **and** `@RequirePermission('access_control', …)`" — and
 * that the controller delegates to the service without adding logic.
 */
import 'reflect-metadata';
import { PERMISSION_METADATA_KEY, ROLES_METADATA_KEY } from '@/common/rbac/rbac.constants';
import { AUDIT_METADATA } from '@/common/audit/decorators/audit.decorator';
import { AccessControlController } from '@/modules/access-control/access-control.controller';
import type { AccessControlService } from '@/modules/access-control/access-control.service';
import type { PreviewDto } from '@/modules/access-control/dto/preview.dto';
import { actor } from './support/access-control-doubles';

function permissionOf(handler: (...args: never[]) => unknown): { entity: string; action: string } {
  return Reflect.getMetadata(PERMISSION_METADATA_KEY, handler) as {
    entity: string;
    action: string;
  };
}

function auditOf(handler: (...args: never[]) => unknown): { event: string; targetType?: string } {
  return Reflect.getMetadata(AUDIT_METADATA, handler) as { event: string; targetType?: string };
}

const WRITE_HANDLERS = [
  AccessControlController.prototype.putNav,
  AccessControlController.prototype.reorderNav,
  AccessControlController.prototype.putPermissions,
  AccessControlController.prototype.putWidgets,
  AccessControlController.prototype.reorderWidgets,
];

const READ_HANDLERS = [
  AccessControlController.prototype.listRoles,
  AccessControlController.prototype.listEntities,
  AccessControlController.prototype.getNav,
  AccessControlController.prototype.getPermissions,
  AccessControlController.prototype.getWidgets,
  AccessControlController.prototype.preview,
];

describe('AccessControlController — authorisation metadata (R6, implementation note 1)', () => {
  it('is super_admin only at the class level', () => {
    const roles = Reflect.getMetadata(ROLES_METADATA_KEY, AccessControlController) as string[];
    expect(roles).toEqual(['super_admin']);
  });

  it('every read route requires access_control:view', () => {
    for (const handler of READ_HANDLERS) {
      expect(permissionOf(handler)).toEqual({ entity: 'access_control', action: 'view' });
    }
  });

  it('every write route requires access_control:update', () => {
    for (const handler of WRITE_HANDLERS) {
      expect(permissionOf(handler)).toEqual({ entity: 'access_control', action: 'update' });
    }
  });

  it('every write route is audited', () => {
    expect(auditOf(AccessControlController.prototype.putNav)).toMatchObject({
      event: 'nav_config_updated',
      targetType: 'role_nav_config',
    });
    expect(auditOf(AccessControlController.prototype.reorderNav)).toMatchObject({
      event: 'nav_config_reordered',
      targetType: 'role_nav_config',
    });
    expect(auditOf(AccessControlController.prototype.putPermissions)).toMatchObject({
      event: 'permissions_updated',
      targetType: 'role_entity_permission',
    });
    expect(auditOf(AccessControlController.prototype.putWidgets)).toMatchObject({
      event: 'widgets_updated',
      targetType: 'role_dashboard_widget',
    });
    expect(auditOf(AccessControlController.prototype.reorderWidgets)).toMatchObject({
      event: 'widgets_reordered',
      targetType: 'role_dashboard_widget',
    });
  });

  it('preview is not audited — nothing is ever persisted by it (TC-17)', () => {
    expect(auditOf(AccessControlController.prototype.preview)).toBeUndefined();
  });
});

describe('AccessControlController — delegation', () => {
  function controllerWith(service: Partial<AccessControlService>): AccessControlController {
    return new AccessControlController(service as AccessControlService);
  }

  it('listRoles() wraps the service result in { data }', async () => {
    const listRoles = jest.fn().mockResolvedValue([{ role: 'maker', userCount: 2 }]);
    const controller = controllerWith({ listRoles });
    await expect(controller.listRoles()).resolves.toEqual({
      data: [{ role: 'maker', userCount: 2 }],
    });
  });

  it('listEntities() delegates synchronously', () => {
    const listEntities = jest
      .fn()
      .mockReturnValue([{ entity: 'rule', actions: [], protectedActions: [] }]);
    const controller = controllerWith({ listEntities });
    expect(controller.listEntities()).toEqual({
      data: [{ entity: 'rule', actions: [], protectedActions: [] }],
    });
  });

  it('getNav() delegates the role', async () => {
    const getNav = jest.fn().mockResolvedValue({ role: 'maker', version: 1, items: [] });
    const controller = controllerWith({ getNav });
    await controller.getNav('maker');
    expect(getNav).toHaveBeenCalledWith('maker');
  });

  it('putNav() passes the actor, role and dto through, untouched', async () => {
    const putNav = jest.fn().mockResolvedValue({ role: 'maker', version: 2, items: [] });
    const controller = controllerWith({ putNav });
    const dto = { expectedVersion: 1, items: [] };
    const who = actor();
    await controller.putNav(who, 'maker', dto);
    expect(putNav).toHaveBeenCalledWith(who, 'maker', dto);
  });

  it('reorderNav() passes the role and dto through', async () => {
    const reorderNav = jest.fn().mockResolvedValue({ role: 'maker', version: 2, items: [] });
    const controller = controllerWith({ reorderNav });
    const dto = { expectedVersion: 1, order: [] };
    await controller.reorderNav('maker', dto);
    expect(reorderNav).toHaveBeenCalledWith('maker', dto);
  });

  it('getPermissions() delegates the role', async () => {
    const getPermissions = jest
      .fn()
      .mockResolvedValue({ role: 'maker', version: 1, permissions: {} });
    const controller = controllerWith({ getPermissions });
    await controller.getPermissions('maker');
    expect(getPermissions).toHaveBeenCalledWith('maker');
  });

  it('putPermissions() passes the actor, role and dto through', async () => {
    const putPermissions = jest
      .fn()
      .mockResolvedValue({ role: 'maker', version: 2, permissions: {} });
    const controller = controllerWith({ putPermissions });
    const dto = { expectedVersion: 1, permissions: {} };
    const who = actor();
    await controller.putPermissions(who, 'maker', dto);
    expect(putPermissions).toHaveBeenCalledWith(who, 'maker', dto);
  });

  it('getWidgets() delegates the role', async () => {
    const getWidgets = jest.fn().mockResolvedValue({ role: 'maker', version: 1, items: [] });
    const controller = controllerWith({ getWidgets });
    await controller.getWidgets('maker');
    expect(getWidgets).toHaveBeenCalledWith('maker');
  });

  it('putWidgets() passes the actor, role and dto through', async () => {
    const putWidgets = jest.fn().mockResolvedValue({ role: 'maker', version: 2, items: [] });
    const controller = controllerWith({ putWidgets });
    const dto = { expectedVersion: 1, items: [] };
    const who = actor();
    await controller.putWidgets(who, 'maker', dto);
    expect(putWidgets).toHaveBeenCalledWith(who, 'maker', dto);
  });

  it('reorderWidgets() passes the role and dto through', async () => {
    const reorderWidgets = jest.fn().mockResolvedValue({ role: 'maker', version: 2, items: [] });
    const controller = controllerWith({ reorderWidgets });
    const dto = { expectedVersion: 1, order: [] };
    await controller.reorderWidgets('maker', dto);
    expect(reorderWidgets).toHaveBeenCalledWith('maker', dto);
  });

  it('preview() delegates the dto and returns { data }', async () => {
    const preview = jest
      .fn()
      .mockResolvedValue({ role: 'merchant', nav: [], permissions: {}, widgets: [] });
    const controller = controllerWith({ preview });
    const dto = { role: 'merchant' } as PreviewDto;
    await expect(controller.preview(dto)).resolves.toEqual({
      data: { role: 'merchant', nav: [], permissions: {}, widgets: [] },
    });
    expect(preview).toHaveBeenCalledWith(dto);
  });
});
