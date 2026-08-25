/**
 * T-033 — `/admin/access-control`: the screen the customer asked for explicitly — "create the
 * Admin page for Super Admin only, from where Super Admin can give and block the access for all
 * roles on the system". `role_nav_configs`, `role_entity_permissions` and
 * `role_dashboard_widgets` (all `reward_config`, 01-DATABASE.md §5.1-§5.3) are the tables this
 * service edits; `rbac_cache_config.rbac_version:<role>` (§5's "Every write bumps…") is the
 * version counter it bumps inside the very same transaction as the edit.
 *
 * ### Why every write here is a lock-and-diff, inside one transaction
 *
 * Four things happen together or not at all, because a partial version of any of them is worse
 * than the write never having happened (TC-19: "Write fails mid-transaction → no partial change
 * and no version bump"):
 *
 *  1. the row-level lock on `rbac_cache_config.rbac_version:<role>` (`SELECT … FOR UPDATE`),
 *     which is also how {@link AccessControlVersionConflictError} (TC-22) is detected — two
 *     concurrent `PUT`s cannot both win the same row lock, so the second one to acquire it
 *     re-reads a version that no longer matches its caller's `expectedVersion`;
 *  2. the lock-out / protected-permission checks, evaluated against the **proposed final state**
 *     (implementation note 2/3 — "structurally impossible", not merely validated up front and
 *     then hoped for);
 *  3. the diff-apply (insert/update/delete) against `role_nav_configs`/
 *     `role_entity_permissions`/`role_dashboard_widgets`;
 *  4. the version bump itself.
 *
 * `this.permissions.invalidate(role)` after commit is the same local-cache drop
 * `PermissionCacheService.bumpVersion` performs — defensive, not load-bearing, since
 * `PermissionCacheService` always re-reads `rbac_version:<role>` live on every check (that file's
 * own header) rather than trusting a cached copy of it.
 *
 * ### Why this file never calls `permission.repository.ts`'s writer
 *
 * `PermissionRepository.bumpRbacVersion` (T-013) is not transaction-aware — it commits its own
 * `UPDATE` immediately, which is exactly wrong for requirement 1 above. Extending it to accept a
 * transaction would mean editing a file under `back-end/src/common/rbac/**`, outside this task's
 * file scope (AGENT-PROTOCOL R9). Instead this service reads/writes `RbacCacheConfig` directly
 * through `ScopedRepository` (R2 — no raw model access; `RbacCacheConfig` is registered
 * `unrestricted()` in `scope-strategy.ts`, so this is an ordinary scoped call, not a bypass) using
 * the same `RBAC_CONFIG_KEY.versionFor(role)` key `permission.repository.ts` exports and reads —
 * the two are reading and writing the same row by the same key, just one of them under a lock this
 * task specifically needs and the other does not.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { ScopeViolationError } from '@/common/scope/scope.exceptions';
import { PermissionCacheService } from '@/common/rbac/permission-cache.service';
import { PERMISSION_STORE, type PermissionStore } from '@/common/rbac/permission.repository';
import { RBAC_CONFIG_KEY, ALL_PORTAL_ROLES } from '@/common/rbac/rbac.constants';
import { AuditService } from '@/common/audit/audit.service';
import { RoleDashboardWidget, RoleNavConfig, RoleEntityPermission } from '@/database/models';
import { RbacCacheConfig } from '@/database/models/rbac-cache-config.model';
import { PortalUser, type PortalRole } from '@/database/portal-models';
import {
  buildNavTree,
  toPermissionsDto,
  toWidgetConfig,
  type NavSource,
} from '@/modules/me/bootstrap.service';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { ValidationFailedError } from '@/common/errors/app-error';
import {
  ACCESS_CONTROL_ENTITY,
  ACCESS_CONTROL_NAV_KEY,
  LOCKOUT_PROTECTED_USER_CREATE,
  PROTECTED_PERMISSIONS,
  REQUIRED_SUPER_ADMIN_ACCESS_CONTROL_ACTIONS,
  SUPER_ADMIN_ROLE,
} from './access-control.constants';
import {
  AccessControlVersionConflictError,
  CannotLockOutSuperAdminError,
  ProtectedPermissionError,
} from './access-control.errors';
import type { NavConfigItemDto, PutNavConfigDto } from './dto/nav-config.dto';
import type { PutPermissionsDto } from './dto/permission-matrix.dto';
import type { PreviewDto } from './dto/preview.dto';
import type { ReorderDto } from './dto/reorder.dto';
import type { PutWidgetConfigDto, WidgetConfigItemDto } from './dto/widget-config.dto';
import {
  buildEntityCatalogue,
  toNavConfigItemResponse,
  toWidgetConfigItemResponse,
  type EntityCatalogueEntry,
  type NavConfigResponse,
  type PermissionsResponse,
  type PreviewResponse,
  type RoleSummaryDto,
  type WidgetConfigResponse,
} from './dto/access-control-response.dto';

const NAV_ORDER: [[string, 'ASC'], [string, 'ASC']] = [
  ['sortOrder', 'ASC'],
  ['navKey', 'ASC'],
];
const WIDGET_ORDER: [[string, 'ASC'], [string, 'ASC']] = [
  ['sortOrder', 'ASC'],
  ['widgetKey', 'ASC'],
];

@Injectable()
export class AccessControlService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly scoped: ScopedRepository,
    private readonly permissions: PermissionCacheService,
    @Inject(PERMISSION_STORE) private readonly permissionStore: PermissionStore,
    private readonly audit: AuditService,
  ) {}

  // --- roles / entities (no version, read-only) ------------------------------------------------

  /** `GET /admin/access-control/roles` — TC-1. */
  async listRoles(): Promise<readonly RoleSummaryDto[]> {
    const counts = await Promise.all(
      ALL_PORTAL_ROLES.map((role) => this.scoped.count(PortalUser, { where: { role } })),
    );
    return ALL_PORTAL_ROLES.map((role, index) => ({ role, userCount: counts[index] }));
  }

  /** `GET /admin/access-control/entities` — the catalogue every `PUT /permissions/:role`
   * validates against, and the cell-level lock the UI renders disabled with a tooltip. */
  listEntities(): readonly EntityCatalogueEntry[] {
    return buildEntityCatalogue();
  }

  // --- nav ----------------------------------------------------------------------------------

  /** `GET /admin/access-control/nav/:role`. */
  async getNav(role: PortalRole): Promise<NavConfigResponse> {
    const [rows, version] = await Promise.all([
      this.scoped.listAll(RoleNavConfig, { where: { role }, order: NAV_ORDER }),
      this.permissionStore.readRbacVersion(role),
    ]);
    return { role, version, items: rows.map(toNavConfigItemResponse) };
  }

  /** `PUT /admin/access-control/nav/:role` — full replace (implementation note 5). */
  async putNav(
    _actor: AuthenticatedUser,
    role: PortalRole,
    dto: PutNavConfigDto,
  ): Promise<NavConfigResponse> {
    assertUniqueKeys(
      dto.items.map((item) => item.navKey),
      'navKey',
    );

    if (role === SUPER_ADMIN_ROLE) {
      const entry = dto.items.find((item) => item.navKey === ACCESS_CONTROL_NAV_KEY);
      if (entry === undefined || !entry.enabled) {
        throw new CannotLockOutSuperAdminError(['ACCESS_CONTROL_NAV_REQUIRED']);
      }
    }

    return this.sequelize.transaction(async (transaction) => {
      const { current, exists } = await this.lockAndCheckVersion(
        role,
        dto.expectedVersion,
        transaction,
      );

      const existing = await this.scoped.listAll(RoleNavConfig, { where: { role }, transaction });
      const before = navSnapshotFromRows(existing);
      const after = navSnapshotFromItems(dto.items);

      await this.applyNavDiff(role, existing, dto.items, transaction);
      await this.bumpVersionLocked(role, transaction, exists, current);
      this.annotateWrite('role_nav_config', role, before, after);

      const rows = await this.scoped.listAll(RoleNavConfig, {
        where: { role },
        order: NAV_ORDER,
        transaction,
      });
      this.permissions.invalidate(role);
      return { role, version: current + 1, items: rows.map(toNavConfigItemResponse) };
    });
  }

  /** `PATCH /admin/access-control/nav/:role/reorder` — bulk `sort_order` only
   * (implementation note 7). Cannot disable or remove a row, so it cannot trip the lock-out rule
   * by construction. */
  async reorderNav(role: PortalRole, dto: ReorderDto): Promise<NavConfigResponse> {
    return this.sequelize.transaction(async (transaction) => {
      const { current, exists } = await this.lockAndCheckVersion(
        role,
        dto.expectedVersion,
        transaction,
      );

      for (const entry of dto.order) {
        const affected = await this.scoped.update(
          RoleNavConfig,
          { sortOrder: entry.sortOrder },
          { where: { role, navKey: entry.key }, transaction },
        );
        if (affected === 0) throw unknownReorderKey(entry.key);
      }

      await this.bumpVersionLocked(role, transaction, exists, current);
      this.audit.annotate({
        targetId: role,
        targetType: 'role_nav_config',
        detail: { event: 'nav_reordered', order: dto.order },
      });

      const rows = await this.scoped.listAll(RoleNavConfig, {
        where: { role },
        order: NAV_ORDER,
        transaction,
      });
      this.permissions.invalidate(role);
      return { role, version: current + 1, items: rows.map(toNavConfigItemResponse) };
    });
  }

  // --- permissions ----------------------------------------------------------------------------

  /** `GET /admin/access-control/permissions/:role`. */
  async getPermissions(role: PortalRole): Promise<PermissionsResponse> {
    const [rows, version] = await Promise.all([
      this.scoped.listAll(RoleEntityPermission, { where: { role } }),
      this.permissionStore.readRbacVersion(role),
    ]);
    const permissions: Record<string, readonly string[]> = {};
    for (const row of rows) permissions[row.entity] = row.actions;
    return { role, version, permissions };
  }

  /** `PUT /admin/access-control/permissions/:role` — full replace (implementation note 5).
   * Enforces the lock-out rule (bullets 1 and 3) and the protected-permission rule
   * (implementation note 3) against the **proposed** matrix. */
  async putPermissions(
    _actor: AuthenticatedUser,
    role: PortalRole,
    dto: PutPermissionsDto,
  ): Promise<PermissionsResponse> {
    if (role === SUPER_ADMIN_ROLE) {
      const reasons: string[] = [];
      const accessControlActions = dto.permissions[ACCESS_CONTROL_ENTITY] ?? [];
      for (const required of REQUIRED_SUPER_ADMIN_ACCESS_CONTROL_ACTIONS) {
        if (!accessControlActions.includes(required)) {
          reasons.push(`ACCESS_CONTROL_${required.toUpperCase()}_REQUIRED`);
        }
      }
      const userActions = dto.permissions[LOCKOUT_PROTECTED_USER_CREATE.entity] ?? [];
      if (!userActions.includes(LOCKOUT_PROTECTED_USER_CREATE.action)) {
        reasons.push('USER_CREATE_REQUIRED');
      }
      if (reasons.length > 0) throw new CannotLockOutSuperAdminError(reasons);
    } else {
      const violations = PROTECTED_PERMISSIONS.filter((cell) =>
        (dto.permissions[cell.entity] ?? []).includes(cell.action),
      );
      if (violations.length > 0) throw new ProtectedPermissionError(violations);
    }

    return this.sequelize.transaction(async (transaction) => {
      const { current, exists } = await this.lockAndCheckVersion(
        role,
        dto.expectedVersion,
        transaction,
      );

      const existing = await this.scoped.listAll(RoleEntityPermission, {
        where: { role },
        transaction,
      });
      const before = permissionsSnapshot(existing.map((row) => [row.entity, row.actions] as const));
      const after = permissionsSnapshot(Object.entries(dto.permissions));

      await this.applyPermissionsDiff(role, existing, dto.permissions, transaction);
      await this.bumpVersionLocked(role, transaction, exists, current);
      this.annotateWrite('role_entity_permission', role, before, after);

      this.permissions.invalidate(role);
      return { role, version: current + 1, permissions: dto.permissions };
    });
  }

  // --- widgets --------------------------------------------------------------------------------

  /** `GET /admin/access-control/widgets/:role`. */
  async getWidgets(role: PortalRole): Promise<WidgetConfigResponse> {
    const [rows, version] = await Promise.all([
      this.scoped.listAll(RoleDashboardWidget, { where: { role }, order: WIDGET_ORDER }),
      this.permissionStore.readRbacVersion(role),
    ]);
    return { role, version, items: rows.map(toWidgetConfigItemResponse) };
  }

  /** `PUT /admin/access-control/widgets/:role` — full replace. No lock-out rule applies to
   * dashboard widgets (implementation note 2 names only the nav entry and two permission cells). */
  async putWidgets(
    _actor: AuthenticatedUser,
    role: PortalRole,
    dto: PutWidgetConfigDto,
  ): Promise<WidgetConfigResponse> {
    assertUniqueKeys(
      dto.items.map((item) => item.widgetKey),
      'widgetKey',
    );

    return this.sequelize.transaction(async (transaction) => {
      const { current, exists } = await this.lockAndCheckVersion(
        role,
        dto.expectedVersion,
        transaction,
      );

      const existing = await this.scoped.listAll(RoleDashboardWidget, {
        where: { role },
        transaction,
      });
      const before = widgetSnapshotFromRows(existing);
      const after = widgetSnapshotFromItems(dto.items);

      await this.applyWidgetDiff(role, existing, dto.items, transaction);
      await this.bumpVersionLocked(role, transaction, exists, current);
      this.annotateWrite('role_dashboard_widget', role, before, after);

      const rows = await this.scoped.listAll(RoleDashboardWidget, {
        where: { role },
        order: WIDGET_ORDER,
        transaction,
      });
      this.permissions.invalidate(role);
      return { role, version: current + 1, items: rows.map(toWidgetConfigItemResponse) };
    });
  }

  /** `PATCH /admin/access-control/widgets/:role/reorder`. */
  async reorderWidgets(role: PortalRole, dto: ReorderDto): Promise<WidgetConfigResponse> {
    return this.sequelize.transaction(async (transaction) => {
      const { current, exists } = await this.lockAndCheckVersion(
        role,
        dto.expectedVersion,
        transaction,
      );

      for (const entry of dto.order) {
        const affected = await this.scoped.update(
          RoleDashboardWidget,
          { sortOrder: entry.sortOrder },
          { where: { role, widgetKey: entry.key }, transaction },
        );
        if (affected === 0) throw unknownReorderKey(entry.key);
      }

      await this.bumpVersionLocked(role, transaction, exists, current);
      this.audit.annotate({
        targetId: role,
        targetType: 'role_dashboard_widget',
        detail: { event: 'widgets_reordered', order: dto.order },
      });

      const rows = await this.scoped.listAll(RoleDashboardWidget, {
        where: { role },
        order: WIDGET_ORDER,
        transaction,
      });
      this.permissions.invalidate(role);
      return { role, version: current + 1, items: rows.map(toWidgetConfigItemResponse) };
    });
  }

  // --- preview --------------------------------------------------------------------------------

  /** `POST /admin/access-control/preview` — implementation note 6. Read-only; nothing is ever
   * written by this method (TC-17, verification step 7). */
  async preview(dto: PreviewDto): Promise<PreviewResponse> {
    const [navSources, permissionsMap, widgets] = await Promise.all([
      this.previewNavSources(dto),
      this.previewPermissions(dto),
      this.previewWidgets(dto),
    ]);

    return {
      role: dto.role,
      nav: buildNavTree(navSources),
      permissions: toPermissionsDto(permissionsMap),
      widgets,
    };
  }

  private async previewNavSources(dto: PreviewDto): Promise<NavSource[]> {
    if (dto.nav !== undefined) {
      return dto.nav
        .filter((item) => item.enabled)
        .sort(
          (left, right) =>
            left.sortOrder - right.sortOrder || left.navKey.localeCompare(right.navKey),
        )
        .map((item) => ({
          key: item.navKey,
          label: item.label,
          icon: item.icon ?? null,
          path: item.path,
          parentKey: item.parentNavKey ?? null,
        }));
    }
    const rows = await this.scoped.listAll(RoleNavConfig, {
      where: { role: dto.role, enabled: true },
      order: NAV_ORDER,
    });
    return rows.map((row) => ({
      key: row.navKey,
      label: row.label,
      icon: row.icon,
      path: row.path,
      parentKey: row.parentNavKey,
    }));
  }

  private async previewPermissions(
    dto: PreviewDto,
  ): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
    if (dto.permissions !== undefined) {
      const map = new Map<string, ReadonlySet<string>>();
      for (const [entity, actions] of Object.entries(dto.permissions))
        map.set(entity, new Set(actions));
      return map;
    }
    return this.permissions.permissionsFor(dto.role);
  }

  private async previewWidgets(
    dto: PreviewDto,
  ): Promise<readonly { key: string; label: string; config: Record<string, unknown> }[]> {
    if (dto.widgets !== undefined) {
      return dto.widgets
        .filter((item) => item.enabled)
        .sort(
          (left, right) =>
            left.sortOrder - right.sortOrder || left.widgetKey.localeCompare(right.widgetKey),
        )
        .map((item) => ({
          key: item.widgetKey,
          label: item.label,
          config: toWidgetConfig(item.config ?? {}),
        }));
    }
    const rows = await this.scoped.listAll(RoleDashboardWidget, {
      where: { role: dto.role, enabled: true },
      order: WIDGET_ORDER,
    });
    return rows.map((row) => ({ key: row.widgetKey, label: row.label, config: row.widgetConfig }));
  }

  // --- shared write machinery -------------------------------------------------------------------

  /** Locks `rbac_cache_config.rbac_version:<role>` (`SELECT … FOR UPDATE`) and compares it to the
   * caller's `expectedVersion` — TC-22. Held for the rest of the caller's transaction, so a second
   * concurrent writer blocks here until the first commits or rolls back, and then reads the
   * post-commit value rather than racing it. */
  private async lockAndCheckVersion(
    role: PortalRole,
    expectedVersion: number,
    transaction: Transaction,
  ): Promise<{ current: number; exists: boolean }> {
    const key = RBAC_CONFIG_KEY.versionFor(role);
    // `findOneOrFail`, not `findOne` — R2's `no-raw-model-access` lint rule bans the property name
    // `findOne` on any receiver, `this.scoped` included (`scoped.repository.ts`'s own header: only
    // `listAll`/`findByPkOrFail`/`findOneOrFail` are the names Sequelize's own `Model` API does not
    // have, which is what makes them the lintable-safe way to reach this class from
    // `src/modules/**`). A missing row is a legitimate state here — this role has never been
    // versioned — not a scope violation, so it is caught and treated as version `0` rather than
    // left to surface as a 404.
    let row: RbacCacheConfig | null;
    try {
      row = await this.scoped.findOneOrFail(RbacCacheConfig, {
        where: { configKey: key },
        transaction,
        lock: Transaction.LOCK.UPDATE,
      });
    } catch (error) {
      if (!(error instanceof ScopeViolationError)) throw error;
      row = null;
    }

    const current = row === null ? 0 : parseVersion(row.configValue);
    if (current !== expectedVersion) {
      throw new AccessControlVersionConflictError(expectedVersion, current);
    }
    return { current, exists: row !== null };
  }

  /** Increments the already-locked version row (or creates it at `1` if this role has never had
   * one) — the same key `permission.repository.ts#bumpRbacVersion` writes, just under the lock
   * this transaction already holds. */
  private async bumpVersionLocked(
    role: PortalRole,
    transaction: Transaction,
    exists: boolean,
    current: number,
  ): Promise<number> {
    const key = RBAC_CONFIG_KEY.versionFor(role);
    const next = current + 1;
    if (exists) {
      await this.scoped.update(
        RbacCacheConfig,
        { configValue: String(next) },
        { where: { configKey: key }, transaction },
      );
    } else {
      await this.scoped.create(
        RbacCacheConfig,
        { configKey: key, configValue: String(next) } as never,
        { transaction },
      );
    }
    return next;
  }

  /** One `portal_audit_log` row per write, carrying the before/after diff (implementation note 5:
   * "write one audit entry containing the diff"). */
  private annotateWrite(
    targetType: string,
    role: PortalRole,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): void {
    this.audit.annotate({
      targetId: role,
      targetType,
      detail: { diff: this.audit.diffFields(before, after) },
    });
  }

  private async applyNavDiff(
    role: PortalRole,
    existing: readonly RoleNavConfig[],
    incoming: readonly NavConfigItemDto[],
    transaction: Transaction,
  ): Promise<void> {
    const existingKeys = new Set(existing.map((row) => row.navKey));
    const incomingKeys = new Set(incoming.map((item) => item.navKey));

    const toDelete = [...existingKeys].filter((key) => !incomingKeys.has(key));
    if (toDelete.length > 0) {
      await this.scoped.destroy(RoleNavConfig, { where: { role, navKey: toDelete }, transaction });
    }

    for (const item of incoming) {
      const values = {
        label: item.label,
        icon: item.icon ?? null,
        path: item.path,
        parentNavKey: item.parentNavKey ?? null,
        sortOrder: item.sortOrder,
        enabled: item.enabled,
      };
      if (existingKeys.has(item.navKey)) {
        await this.scoped.update(RoleNavConfig, values, {
          where: { role, navKey: item.navKey },
          transaction,
        });
      } else {
        await this.scoped.create(RoleNavConfig, { role, navKey: item.navKey, ...values } as never, {
          transaction,
        });
      }
    }
  }

  private async applyWidgetDiff(
    role: PortalRole,
    existing: readonly RoleDashboardWidget[],
    incoming: readonly WidgetConfigItemDto[],
    transaction: Transaction,
  ): Promise<void> {
    const existingKeys = new Set(existing.map((row) => row.widgetKey));
    const incomingKeys = new Set(incoming.map((item) => item.widgetKey));

    const toDelete = [...existingKeys].filter((key) => !incomingKeys.has(key));
    if (toDelete.length > 0) {
      await this.scoped.destroy(RoleDashboardWidget, {
        where: { role, widgetKey: toDelete },
        transaction,
      });
    }

    for (const item of incoming) {
      const values = {
        label: item.label,
        widgetConfig: item.config ?? {},
        sortOrder: item.sortOrder,
        enabled: item.enabled,
      };
      if (existingKeys.has(item.widgetKey)) {
        await this.scoped.update(RoleDashboardWidget, values, {
          where: { role, widgetKey: item.widgetKey },
          transaction,
        });
      } else {
        await this.scoped.create(
          RoleDashboardWidget,
          { role, widgetKey: item.widgetKey, ...values } as never,
          { transaction },
        );
      }
    }
  }

  private async applyPermissionsDiff(
    role: PortalRole,
    existing: readonly RoleEntityPermission[],
    incoming: Readonly<Record<string, readonly string[]>>,
    transaction: Transaction,
  ): Promise<void> {
    const existingEntities = new Set(existing.map((row) => row.entity));
    const incomingEntities = new Set(Object.keys(incoming));

    const toDelete = [...existingEntities].filter((entity) => !incomingEntities.has(entity));
    if (toDelete.length > 0) {
      await this.scoped.destroy(RoleEntityPermission, {
        where: { role, entity: toDelete },
        transaction,
      });
    }

    for (const [entity, actions] of Object.entries(incoming)) {
      if (existingEntities.has(entity)) {
        await this.scoped.update(
          RoleEntityPermission,
          { actions: [...actions] },
          { where: { role, entity }, transaction },
        );
      } else {
        await this.scoped.create(
          RoleEntityPermission,
          { role, entity, actions: [...actions] } as never,
          { transaction },
        );
      }
    }
  }
}

// --- module-private helpers ------------------------------------------------------------------

function parseVersion(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function assertUniqueKeys(keys: readonly string[], field: string): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) {
      throw new ValidationFailedError([{ field, code: 'DUPLICATE_KEY' }], { logContext: { key } });
    }
    seen.add(key);
  }
}

function unknownReorderKey(key: string): ValidationFailedError {
  return new ValidationFailedError([{ field: 'order', code: 'UNKNOWN_KEY' }], {
    logContext: { key },
  });
}

function navSnapshotFromRows(rows: readonly RoleNavConfig[]): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const row of rows) {
    snapshot[row.navKey] = {
      label: row.label,
      icon: row.icon,
      path: row.path,
      parentNavKey: row.parentNavKey,
      sortOrder: row.sortOrder,
      enabled: row.enabled,
    };
  }
  return snapshot;
}

function navSnapshotFromItems(items: readonly NavConfigItemDto[]): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const item of items) {
    snapshot[item.navKey] = {
      label: item.label,
      icon: item.icon ?? null,
      path: item.path,
      parentNavKey: item.parentNavKey ?? null,
      sortOrder: item.sortOrder,
      enabled: item.enabled,
    };
  }
  return snapshot;
}

function widgetSnapshotFromRows(rows: readonly RoleDashboardWidget[]): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const row of rows) {
    snapshot[row.widgetKey] = {
      label: row.label,
      config: row.widgetConfig,
      sortOrder: row.sortOrder,
      enabled: row.enabled,
    };
  }
  return snapshot;
}

function widgetSnapshotFromItems(items: readonly WidgetConfigItemDto[]): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const item of items) {
    snapshot[item.widgetKey] = {
      label: item.label,
      config: item.config ?? {},
      sortOrder: item.sortOrder,
      enabled: item.enabled,
    };
  }
  return snapshot;
}

function permissionsSnapshot(
  entries: Iterable<readonly [string, readonly string[]]>,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const [entity, actions] of entries) snapshot[entity] = [...actions].sort();
  return snapshot;
}
