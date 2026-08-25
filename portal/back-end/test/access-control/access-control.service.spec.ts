/**
 * T-033 — `AccessControlService` unit tests. TC-1, TC-9, TC-11-14, TC-17-24 are decided here;
 * `access-control.e2e-spec.ts` proves the same guarantees against the real database and HTTP
 * stack.
 */
import { RoleDashboardWidget, RoleEntityPermission, RoleNavConfig } from '@/database/models';
import { RbacCacheConfig } from '@/database/models/rbac-cache-config.model';
import { PortalUser } from '@/database/portal-models';
import { RBAC_CONFIG_KEY, ALL_PORTAL_ROLES } from '@/common/rbac/rbac.constants';
import { ValidationFailedError } from '@/common/errors/app-error';
import { AccessControlService } from '@/modules/access-control/access-control.service';
import {
  ACCESS_CONTROL_ERROR_CODE,
  AccessControlVersionConflictError,
  CannotLockOutSuperAdminError,
  ProtectedPermissionError,
} from '@/modules/access-control/access-control.errors';
import type {
  NavConfigItemDto,
  PutNavConfigDto,
} from '@/modules/access-control/dto/nav-config.dto';
import type { PutPermissionsDto } from '@/modules/access-control/dto/permission-matrix.dto';
import type { PreviewDto } from '@/modules/access-control/dto/preview.dto';
import type { ReorderDto } from '@/modules/access-control/dto/reorder.dto';
import type {
  PutWidgetConfigDto,
  WidgetConfigItemDto,
} from '@/modules/access-control/dto/widget-config.dto';
import {
  FakeAuditService,
  FakePermissionCache,
  FakeScopedRepository,
  FakeSequelize,
  FakeVersionStore,
  actor,
  asAuditService,
  asPermissionCache,
  asScopedRepository,
  asSequelize,
} from './support/access-control-doubles';

function makeService() {
  const scoped = new FakeScopedRepository();
  const sequelize = new FakeSequelize();
  const permissions = new FakePermissionCache();
  const versionStore = new FakeVersionStore();
  const audit = new FakeAuditService();

  const service = new AccessControlService(
    asSequelize(sequelize),
    asScopedRepository(scoped),
    asPermissionCache(permissions),
    versionStore,
    asAuditService(audit),
  );

  return { service, scoped, sequelize, permissions, versionStore, audit };
}

function navRow(overrides: Partial<RoleNavConfig> = {}): RoleNavConfig {
  return {
    role: 'super_admin',
    navKey: 'access_control',
    label: 'Access Control',
    icon: null,
    path: '/admin/access-control',
    parentNavKey: null,
    sortOrder: 60,
    enabled: true,
    ...overrides,
  } as unknown as RoleNavConfig;
}

function navItem(overrides: Partial<NavConfigItemDto> = {}): NavConfigItemDto {
  return {
    navKey: 'access_control',
    label: 'Access Control',
    icon: null,
    path: '/admin/access-control',
    parentNavKey: null,
    sortOrder: 60,
    enabled: true,
    ...overrides,
  } as NavConfigItemDto;
}

function widgetRow(overrides: Partial<RoleDashboardWidget> = {}): RoleDashboardWidget {
  return {
    role: 'maker',
    widgetKey: 'kpi_my_drafts',
    label: 'My Drafts',
    widgetConfig: {},
    sortOrder: 10,
    enabled: true,
    ...overrides,
  } as unknown as RoleDashboardWidget;
}

function widgetItem(overrides: Partial<WidgetConfigItemDto> = {}): WidgetConfigItemDto {
  return {
    widgetKey: 'kpi_my_drafts',
    label: 'My Drafts',
    config: {},
    sortOrder: 10,
    enabled: true,
    ...overrides,
  } as WidgetConfigItemDto;
}

function permissionRow(entity: string, actions: readonly string[]): RoleEntityPermission {
  return { role: 'maker', entity, actions } as unknown as RoleEntityPermission;
}

describe('AccessControlService', () => {
  describe('listRoles — TC-1', () => {
    it('returns all six roles with a user count each', async () => {
      const { service, scoped } = makeService();
      for (const role of ALL_PORTAL_ROLES)
        scoped.setCountForRole(PortalUser, role, role === 'maker' ? 3 : 0);

      const roles = await service.listRoles();

      expect(roles).toHaveLength(6);
      expect(roles.map((r) => r.role)).toEqual([...ALL_PORTAL_ROLES]);
      expect(roles.find((r) => r.role === 'maker')?.userCount).toBe(3);
    });
  });

  describe('listEntities', () => {
    it('marks rule/reward create/update/delete as protected, everything else not', () => {
      const { service } = makeService();
      const entities = service.listEntities();

      const rule = entities.find((e) => e.entity === 'rule');
      expect([...(rule?.protectedActions ?? [])].sort()).toEqual(['create', 'delete', 'update']);

      const country = entities.find((e) => e.entity === 'country');
      expect(country?.protectedActions).toEqual([]);
    });
  });

  describe('getNav / getPermissions / getWidgets', () => {
    it('getNav returns items plus the live rbac_version, not a cached one', async () => {
      const { service, scoped, versionStore } = makeService();
      scoped.setListRows(RoleNavConfig, [navRow()]);
      versionStore.setVersion('super_admin', 7);

      const result = await service.getNav('super_admin');

      expect(result.version).toBe(7);
      expect(result.items).toHaveLength(1);
      expect(versionStore.versionReads).toBe(1);
    });

    it('getPermissions returns the matrix flattened to entity -> actions, plus the live version', async () => {
      const { service, scoped, versionStore } = makeService();
      scoped.setListRows(RoleEntityPermission, [permissionRow('campaign', ['view', 'create'])]);
      versionStore.setVersion('maker', 3);

      const result = await service.getPermissions('maker');

      expect(result.version).toBe(3);
      expect(result.permissions).toEqual({ campaign: ['view', 'create'] });
    });

    it('getWidgets returns items plus the live version', async () => {
      const { service, scoped, versionStore } = makeService();
      scoped.setListRows(RoleDashboardWidget, [widgetRow()]);
      versionStore.setVersion('maker', 2);

      const result = await service.getWidgets('maker');

      expect(result.version).toBe(2);
      expect(result.items).toHaveLength(1);
    });
  });

  describe('putNav — lock-out prevention (TC-11, verification step 4)', () => {
    it('rejects removing the access_control nav entry from super_admin, before any write', async () => {
      const { service, scoped, sequelize } = makeService();
      const dto: PutNavConfigDto = {
        expectedVersion: 1,
        items: [navItem({ navKey: 'dashboard' })],
      };

      await expect(service.putNav(actor(), 'super_admin', dto)).rejects.toMatchObject({
        code: ACCESS_CONTROL_ERROR_CODE.CANNOT_LOCK_OUT_SUPER_ADMIN,
        status: 422,
      });
      expect(sequelize.transactionCalls).toBe(0);
      expect(scoped.calls).toHaveLength(0);
    });

    it('rejects disabling the access_control nav entry for super_admin (TC-12)', async () => {
      const { service, sequelize } = makeService();
      const dto: PutNavConfigDto = {
        expectedVersion: 1,
        items: [navItem({ enabled: false })],
      };

      await expect(service.putNav(actor(), 'super_admin', dto)).rejects.toBeInstanceOf(
        CannotLockOutSuperAdminError,
      );
      expect(sequelize.transactionCalls).toBe(0);
    });

    it('does not apply the rule to any other role', async () => {
      const { service, scoped, versionStore } = makeService();
      versionStore.setVersion('maker', 1);
      scoped.setFindOneResult(RbacCacheConfig, rbacRow('maker', 1));
      scoped.setListRows(RoleNavConfig, []);

      const dto: PutNavConfigDto = {
        expectedVersion: 1,
        items: [navItem({ navKey: 'dashboard' })],
      };
      const result = await service.putNav(actor(), 'maker', dto);

      expect(result.role).toBe('maker');
    });

    it('rejects duplicate navKey entries with a 400 before touching the database', async () => {
      const { service, scoped } = makeService();
      const dto: PutNavConfigDto = {
        expectedVersion: 1,
        items: [navItem({ navKey: 'dashboard' }), navItem({ navKey: 'dashboard' })],
      };

      await expect(service.putNav(actor(), 'maker', dto)).rejects.toBeInstanceOf(
        ValidationFailedError,
      );
      expect(scoped.calls).toHaveLength(0);
    });
  });

  describe('putNav — version conflict and diff-apply (TC-19, TC-22)', () => {
    it('rejects a stale expectedVersion with 409 and performs no write (TC-22)', async () => {
      const { service, scoped, sequelize } = makeService();
      scoped.setFindOneResult(RbacCacheConfig, rbacRow('super_admin', 5));
      const dto: PutNavConfigDto = { expectedVersion: 1, items: [navItem()] };

      await expect(service.putNav(actor(), 'super_admin', dto)).rejects.toBeInstanceOf(
        AccessControlVersionConflictError,
      );
      expect(sequelize.transactionCalls).toBe(1);
      expect(scoped.callsTo('update')).toHaveLength(0);
      expect(scoped.callsTo('create')).toHaveLength(0);
      expect(scoped.callsTo('destroy')).toHaveLength(0);
    });

    it('inserts, updates and deletes in one transaction, then bumps the version and audits the diff', async () => {
      const { service, scoped, permissions, audit } = makeService();
      scoped.setFindOneResult(RbacCacheConfig, rbacRow('super_admin', 3));
      scoped.setListRows(RoleNavConfig, [
        navRow({ navKey: 'access_control' }),
        navRow({ navKey: 'stale_item', label: 'Stale' }),
      ]);

      const dto: PutNavConfigDto = {
        expectedVersion: 3,
        items: [
          navItem({ navKey: 'access_control' }),
          navItem({ navKey: 'new_item', label: 'New' }),
        ],
      };

      const result = await service.putNav(actor(), 'super_admin', dto);

      expect(result.version).toBe(4);
      const deletes = scoped.callsTo('destroy');
      expect(deletes).toHaveLength(1);
      expect((deletes[0].options as { where: { navKey: string[] } }).where.navKey).toEqual([
        'stale_item',
      ]);
      expect(scoped.callsTo('update').some((c) => c.model === 'RoleNavConfig')).toBe(true);
      expect(scoped.callsTo('create').some((c) => c.model === 'RoleNavConfig')).toBe(true);
      // The version bump itself.
      expect(
        scoped
          .callsTo('update')
          .some(
            (c) =>
              c.model === 'RbacCacheConfig' &&
              (c.values as { configValue: string }).configValue === '4',
          ),
      ).toBe(true);
      expect(permissions.invalidated).toContain('super_admin');
      expect(audit.annotations).toHaveLength(1);
      expect(audit.annotations[0].targetType).toBe('role_nav_config');
      expect((audit.annotations[0].detail as { diff: Record<string, unknown> }).diff).toBeDefined();
    });

    it('creates the version row at 1 when the role has never been versioned', async () => {
      const { service, scoped } = makeService();
      // No `setFindOneResult` — the role has no `rbac_cache_config` row yet.
      scoped.setListRows(RoleNavConfig, []);
      const dto: PutNavConfigDto = {
        expectedVersion: 0,
        items: [navItem({ navKey: 'dashboard' })],
      };

      const result = await service.putNav(actor(), 'maker', dto);

      expect(result.version).toBe(1);
      expect(
        scoped
          .callsTo('create')
          .some(
            (c) =>
              c.model === 'RbacCacheConfig' &&
              (c.values as { configValue: string }).configValue === '1',
          ),
      ).toBe(true);
    });
  });

  describe('reorderNav — implementation note 7', () => {
    it('updates sortOrder per key and bumps the version once', async () => {
      const { service, scoped } = makeService();
      scoped.setFindOneResult(RbacCacheConfig, rbacRow('checker', 2));
      scoped.setListRows(RoleNavConfig, [navRow({ role: 'checker' })]);

      const dto: ReorderDto = { expectedVersion: 2, order: [{ key: 'dashboard', sortOrder: 5 }] };
      const result = await service.reorderNav('checker', dto);

      expect(result.version).toBe(3);
      expect(scoped.callsTo('update').some((c) => c.model === 'RoleNavConfig')).toBe(true);
    });

    it('rejects reordering an unknown key with 400 and does not bump the version', async () => {
      const { service, scoped } = makeService();
      scoped.setFindOneResult(RbacCacheConfig, rbacRow('checker', 2));
      scoped.updateAffected = 0;

      const dto: ReorderDto = { expectedVersion: 2, order: [{ key: 'ghost', sortOrder: 5 }] };

      await expect(service.reorderNav('checker', dto)).rejects.toBeInstanceOf(
        ValidationFailedError,
      );
      expect(scoped.callsTo('update').some((c) => c.model === 'RbacCacheConfig')).toBe(false);
    });
  });

  describe('putPermissions — lock-out prevention (TC-11 bullet 3)', () => {
    it('rejects removing access_control view/update from super_admin', async () => {
      const { service, sequelize } = makeService();
      const dto: PutPermissionsDto = {
        expectedVersion: 1,
        permissions: { access_control: ['view'], user: ['create'] },
      };

      const error = await service.putPermissions(actor(), 'super_admin', dto).catch((e) => e);
      expect(error).toBeInstanceOf(CannotLockOutSuperAdminError);
      expect(sequelize.transactionCalls).toBe(0);
    });

    it('rejects removing user:create from super_admin', async () => {
      const { service } = makeService();
      const dto: PutPermissionsDto = {
        expectedVersion: 1,
        permissions: { access_control: ['view', 'update'], user: ['view'] },
      };

      await expect(service.putPermissions(actor(), 'super_admin', dto)).rejects.toMatchObject({
        code: ACCESS_CONTROL_ERROR_CODE.CANNOT_LOCK_OUT_SUPER_ADMIN,
      });
    });

    it('accepts a super_admin matrix that keeps every guarded cell', async () => {
      const { service, scoped } = makeService();
      scoped.setFindOneResult(RbacCacheConfig, rbacRow('super_admin', 1));
      scoped.setListRows(RoleEntityPermission, []);
      const dto: PutPermissionsDto = {
        expectedVersion: 1,
        permissions: { access_control: ['view', 'update', 'create', 'delete'], user: ['create'] },
      };

      const result = await service.putPermissions(actor(), 'super_admin', dto);
      expect(result.version).toBe(2);
    });
  });

  describe('putPermissions — protected permission (TC-13, TC-14)', () => {
    it.each([
      ['maker', 'rule', 'create'],
      ['country_admin', 'reward', 'update'],
      ['checker', 'reward', 'delete'],
    ])('rejects granting %s %s:%s, before any write', async (role, entity, action) => {
      const { service, sequelize } = makeService();
      const dto: PutPermissionsDto = { expectedVersion: 1, permissions: { [entity]: [action] } };

      const error = await service.putPermissions(actor(), role as never, dto).catch((e) => e);
      expect(error).toBeInstanceOf(ProtectedPermissionError);
      expect(error.code).toBe(ACCESS_CONTROL_ERROR_CODE.PROTECTED_PERMISSION);
      expect(sequelize.transactionCalls).toBe(0);
    });

    it('still allows super_admin to hold every protected cell', async () => {
      const { service, scoped } = makeService();
      scoped.setFindOneResult(RbacCacheConfig, rbacRow('super_admin', 1));
      scoped.setListRows(RoleEntityPermission, []);
      const dto: PutPermissionsDto = {
        expectedVersion: 1,
        permissions: {
          access_control: ['view', 'update'],
          user: ['create'],
          rule: ['view', 'create', 'update', 'delete'],
          reward: ['view', 'create', 'update', 'delete'],
        },
      };

      const result = await service.putPermissions(actor(), 'super_admin', dto);
      expect(result.permissions['rule']).toEqual(['view', 'create', 'update', 'delete']);
    });

    it('leaves a non-protected grant for another role untouched (TC-9)', async () => {
      const { service, scoped } = makeService();
      scoped.setFindOneResult(RbacCacheConfig, rbacRow('merchant', 1));
      scoped.setListRows(RoleEntityPermission, []);
      const dto: PutPermissionsDto = { expectedVersion: 1, permissions: { campaign: ['view'] } };

      const result = await service.putPermissions(actor(), 'merchant', dto);
      expect(result.permissions['campaign']).toEqual(['view']);
    });
  });

  describe('putPermissions — diff and full replace (TC-24)', () => {
    it('accepts an empty permission map — a role may legitimately have none', async () => {
      const { service, scoped } = makeService();
      scoped.setFindOneResult(RbacCacheConfig, rbacRow('merchant', 1));
      scoped.setListRows(RoleEntityPermission, [permissionRow('campaign', ['view'])]);
      const dto: PutPermissionsDto = { expectedVersion: 1, permissions: {} };

      const result = await service.putPermissions(actor(), 'merchant', dto);

      expect(result.permissions).toEqual({});
      const deletes = scoped.callsTo('destroy');
      expect(deletes).toHaveLength(1);
    });

    it('updates an existing entity in place rather than deleting and recreating it', async () => {
      const { service, scoped } = makeService();
      scoped.setFindOneResult(RbacCacheConfig, rbacRow('merchant', 1));
      scoped.setListRows(RoleEntityPermission, [permissionRow('campaign', ['view'])]);
      const dto: PutPermissionsDto = {
        expectedVersion: 1,
        permissions: { campaign: ['view', 'create'] },
      };

      const result = await service.putPermissions(actor(), 'merchant', dto);

      expect(result.permissions['campaign']).toEqual(['view', 'create']);
      expect(scoped.callsTo('update').some((c) => c.model === 'RoleEntityPermission')).toBe(true);
      expect(scoped.callsTo('create').some((c) => c.model === 'RoleEntityPermission')).toBe(false);
      expect(scoped.callsTo('destroy')).toHaveLength(0);
    });
  });

  describe('putWidgets', () => {
    it('rejects duplicate widgetKey entries with 400', async () => {
      const { service, scoped } = makeService();
      const dto: PutWidgetConfigDto = {
        expectedVersion: 1,
        items: [widgetItem(), widgetItem()],
      };

      await expect(service.putWidgets(actor(), 'maker', dto)).rejects.toBeInstanceOf(
        ValidationFailedError,
      );
      expect(scoped.calls).toHaveLength(0);
    });

    it('has no lock-out rule of its own — disabling every widget for super_admin is allowed', async () => {
      const { service, scoped } = makeService();
      scoped.setFindOneResult(RbacCacheConfig, rbacRow('super_admin', 1));
      scoped.setListRows(RoleDashboardWidget, []);
      const dto: PutWidgetConfigDto = { expectedVersion: 1, items: [] };

      const result = await service.putWidgets(actor(), 'super_admin', dto);
      expect(result.items).toEqual([]);
    });

    it('inserts, updates and deletes widgets in one transaction, then bumps the version', async () => {
      const { service, scoped, permissions, audit } = makeService();
      scoped.setFindOneResult(RbacCacheConfig, rbacRow('maker', 2));
      scoped.setListRows(RoleDashboardWidget, [
        widgetRow({ widgetKey: 'kpi_my_drafts' }),
        widgetRow({ widgetKey: 'stale_widget', label: 'Stale' }),
      ]);

      const dto: PutWidgetConfigDto = {
        expectedVersion: 2,
        items: [
          widgetItem({ widgetKey: 'kpi_my_drafts', label: 'My Drafts (updated)' }),
          widgetItem({ widgetKey: 'new_widget', label: 'New' }),
        ],
      };

      const result = await service.putWidgets(actor(), 'maker', dto);

      expect(result.version).toBe(3);
      const deletes = scoped.callsTo('destroy');
      expect(deletes).toHaveLength(1);
      expect((deletes[0].options as { where: { widgetKey: string[] } }).where.widgetKey).toEqual([
        'stale_widget',
      ]);
      expect(scoped.callsTo('update').some((c) => c.model === 'RoleDashboardWidget')).toBe(true);
      expect(scoped.callsTo('create').some((c) => c.model === 'RoleDashboardWidget')).toBe(true);
      expect(permissions.invalidated).toContain('maker');
      expect(audit.annotations[0].targetType).toBe('role_dashboard_widget');
    });
  });

  describe('reorderWidgets', () => {
    it('updates sortOrder and bumps the version', async () => {
      const { service, scoped } = makeService();
      scoped.setFindOneResult(RbacCacheConfig, rbacRow('maker', 4));
      scoped.setListRows(RoleDashboardWidget, [widgetRow()]);
      const dto: ReorderDto = {
        expectedVersion: 4,
        order: [{ key: 'kpi_my_drafts', sortOrder: 99 }],
      };

      const result = await service.reorderWidgets('maker', dto);
      expect(result.version).toBe(5);
    });
  });

  describe('preview — TC-17, verification step 7', () => {
    it('computes the effective nav/permissions/widgets from a draft, writing nothing', async () => {
      const { service, scoped } = makeService();
      const dto: PreviewDto = {
        role: 'merchant',
        nav: [navItem({ navKey: 'dashboard', parentNavKey: null })],
        permissions: { campaign: ['view'] },
        widgets: [widgetItem({ widgetKey: 'kpi_active_campaigns', label: 'Active' })],
      };

      const result = await service.preview(dto);

      expect(result.role).toBe('merchant');
      expect(result.nav).toEqual([expect.objectContaining({ key: 'dashboard', children: [] })]);
      expect(result.permissions).toEqual({ campaign: ['view'] });
      expect(result.widgets).toEqual([
        { key: 'kpi_active_campaigns', label: 'Active', config: {} },
      ]);
      // Nothing persisted: no write-shaped call happened at all.
      expect(scoped.callsTo('create')).toHaveLength(0);
      expect(scoped.callsTo('update')).toHaveLength(0);
      expect(scoped.callsTo('destroy')).toHaveLength(0);
    });

    it('falls back to the committed rows for whichever section the draft omits', async () => {
      const { service, scoped, permissions } = makeService();
      scoped.setListRows(RoleNavConfig, [navRow({ role: 'checker', navKey: 'approvals' })]);
      scoped.setListRows(RoleDashboardWidget, [
        widgetRow({ role: 'checker', widgetKey: 'kpi_pending_my_review' }),
      ]);
      permissions.grant('approval', 'view');

      const result = await service.preview({ role: 'checker' });

      expect(result.nav[0].key).toBe('approvals');
      expect(result.widgets[0].key).toBe('kpi_pending_my_review');
      expect(result.permissions).toEqual({ approval: ['view'] });
    });

    it('excludes disabled draft rows, same as the real bootstrap builder', async () => {
      const { service } = makeService();
      const result = await service.preview({
        role: 'maker',
        nav: [navItem({ navKey: 'dashboard', enabled: false })],
        widgets: [widgetItem({ enabled: false })],
      });

      expect(result.nav).toEqual([]);
      expect(result.widgets).toEqual([]);
    });

    it('breaks a tied sortOrder by key, same tie-break the real bootstrap builder uses', async () => {
      const { service } = makeService();
      const result = await service.preview({
        role: 'maker',
        nav: [
          navItem({ navKey: 'zzz_last', label: 'Z', sortOrder: 10, parentNavKey: null }),
          navItem({ navKey: 'aaa_first', label: 'A', sortOrder: 10, parentNavKey: null }),
        ],
        widgets: [
          widgetItem({ widgetKey: 'zzz_widget', label: 'Z' }),
          widgetItem({ widgetKey: 'aaa_widget', label: 'A' }),
        ],
      });

      expect(result.nav.map((item) => item.key)).toEqual(['aaa_first', 'zzz_last']);
      expect(result.widgets.map((item) => item.key)).toEqual(['aaa_widget', 'zzz_widget']);
    });
  });
});

function rbacRow(role: string, version: number) {
  return { configKey: RBAC_CONFIG_KEY.versionFor(role), configValue: String(version) };
}
