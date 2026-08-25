/**
 * T-033 — the response bodies `/admin/access-control` returns. Built by hand from the
 * `RoleNavConfig`/`RoleDashboardWidget` model instances the service loads, never by spreading a
 * Sequelize row — the same construction rule `rule-response.dto.ts`/`country-response.dto.ts`
 * record, for the same reason. Mirrored field-for-field by
 * `packages/shared/src/access-control.schema.ts`.
 */
import type { RoleDashboardWidget } from '@/database/models/role-dashboard-widget.model';
import type { RoleNavConfig } from '@/database/models/role-nav-config.model';
import type { PortalRole } from '@/database/portal-models';
import type {
  BootstrapNavItemDto,
  BootstrapWidgetDto,
} from '@/modules/me/dto/bootstrap-response.dto';
import { ENTITY_ACTION_CATALOGUE, isProtectedPermission } from '../access-control.constants';

/** 03-API-CONTRACT.md §1 — `{ "data": … }`. Declared locally per the precedent every other
 * Wave 3 feature's own copy documents: this envelope is an API-wide convention no task owns a
 * shared home for. */
export interface DataEnvelope<T> {
  readonly data: T;
}

export function envelope<T>(data: T): DataEnvelope<T> {
  return { data };
}

export interface RoleSummaryDto {
  readonly role: PortalRole;
  readonly userCount: number;
}

export interface NavConfigItemResponse {
  readonly navKey: string;
  readonly label: string;
  readonly icon: string | null;
  readonly path: string;
  readonly parentNavKey: string | null;
  readonly sortOrder: number;
  readonly enabled: boolean;
}

export function toNavConfigItemResponse(row: RoleNavConfig): NavConfigItemResponse {
  return {
    navKey: row.navKey,
    label: row.label,
    icon: row.icon,
    path: row.path,
    parentNavKey: row.parentNavKey,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
  };
}

export interface NavConfigResponse {
  readonly role: PortalRole;
  readonly version: number;
  readonly items: readonly NavConfigItemResponse[];
}

export interface WidgetConfigItemResponse {
  readonly widgetKey: string;
  readonly label: string;
  readonly config: Record<string, unknown>;
  readonly sortOrder: number;
  readonly enabled: boolean;
}

export function toWidgetConfigItemResponse(row: RoleDashboardWidget): WidgetConfigItemResponse {
  return {
    widgetKey: row.widgetKey,
    label: row.label,
    config: row.widgetConfig,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
  };
}

export interface WidgetConfigResponse {
  readonly role: PortalRole;
  readonly version: number;
  readonly items: readonly WidgetConfigItemResponse[];
}

export interface PermissionsResponse {
  readonly role: PortalRole;
  readonly version: number;
  readonly permissions: Readonly<Record<string, readonly string[]>>;
}

export interface EntityCatalogueEntry {
  readonly entity: string;
  readonly actions: readonly string[];
  /** The subset of `actions` that {@link isProtectedPermission} locks to `super_admin` — the UI
   * renders these cells disabled, with an explanatory tooltip, for every other role (implementation
   * note 3). */
  readonly protectedActions: readonly string[];
}

export function buildEntityCatalogue(): readonly EntityCatalogueEntry[] {
  return Object.entries(ENTITY_ACTION_CATALOGUE)
    .map(([entity, actions]) => ({
      entity,
      actions,
      protectedActions: actions.filter((action) => isProtectedPermission(entity, action)),
    }))
    .sort((left, right) => left.entity.localeCompare(right.entity));
}

/** `POST /admin/access-control/preview`'s response — the same three shapes
 * `GET /me/bootstrap` returns, minus `user`/`scope`/`messages` (implementation note 6: "what the
 * role would see", not a full impersonated session). */
export interface PreviewResponse {
  readonly role: PortalRole;
  readonly nav: readonly BootstrapNavItemDto[];
  readonly permissions: Readonly<Record<string, readonly string[]>>;
  readonly widgets: readonly BootstrapWidgetDto[];
}
