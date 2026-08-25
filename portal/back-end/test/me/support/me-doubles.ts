/**
 * T-015 unit-test support — in-memory stand-ins for the four things `/me` depends on.
 *
 * The reasoning is `FakePermissionStore`'s (T-013): the interesting behaviour of this module is a
 * set of *decisions* — which rows it asks for, what it does with an orphaned nav row, what it
 * sends when the client already has the current revision, which fields it will and will not write
 * — and every branch of those has to be reachable on demand for the 100% bar. A real Postgres
 * cannot be asked to return a nav row whose parent is missing, and asking it to would mean
 * shipping such a row.
 *
 * {@link FakeScopedRepository} records the **exact options object** each call received, because
 * "the right rows came back" is not the property under test in a unit spec — "the query was
 * filtered on the actor's own role, `enabled = true`, ordered by `sort_order`" is. The real rows
 * are proven by `me.e2e-spec.ts` against the real schema.
 */
import type { FindOptions, Model, ModelStatic, UpdateOptions } from 'sequelize';
import type { ScopedRepository } from '@/common/scope/scoped.repository';
import { ScopeViolationError } from '@/common/scope/scope.exceptions';
import type { AuditService } from '@/common/audit/audit.service';
import type { AuditDraft } from '@/common/audit/audit-context';
import type { MessageService } from '@/common/messages/message.service';
import type { PermissionCacheService, PermissionMap } from '@/common/rbac/permission-cache.service';
import type { PermissionStore, PermissionGrant } from '@/common/rbac/permission.repository';
import { RoleDashboardWidget, RoleNavConfig } from '@/database/models';
import type { PortalRole, PortalUser } from '@/database/portal-models';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';

/** One recorded call to the repository double. */
export interface RecordedCall {
  readonly method: string;
  readonly model: string;
  readonly options: unknown;
  readonly values?: unknown;
}

/**
 * A `ScopedRepository` that answers from memory.
 *
 * Typed by casting through `unknown` in {@link asScopedRepository} rather than by `implements`:
 * the real class has private members (`scope`, `scoped`) that a double cannot and should not
 * reproduce, and the compile-time contract that matters here is the four methods `/me` calls.
 */
export class FakeScopedRepository {
  readonly calls: RecordedCall[] = [];

  /** Rows returned by `findAll`, keyed by model name. */
  readonly rows = new Map<string, unknown[]>();
  /** The row `findByPk` returns; `null` means "no such row, or out of scope". */
  self: PortalUser | null = null;
  /** What `update` reports as affected. */
  affected = 1;

  setRows(model: ModelStatic<Model>, rows: readonly unknown[]): this {
    this.rows.set(model.name, [...rows]);
    return this;
  }

  /**
   * The list read a service performs. Named `listAll`, not `findAll`, because that is the method
   * `ScopedRepository` exposes to `src/modules/**` — see its own comment on the interaction with
   * T-013's `no-raw-model-access` rule. Recording under the same name is what makes these specs
   * fail if a service ever reaches for the banned one.
   */
  async listAll<M extends Model>(model: ModelStatic<M>, options: FindOptions = {}): Promise<M[]> {
    this.calls.push({ method: 'listAll', model: model.name, options });
    return (this.rows.get(model.name) ?? []) as M[];
  }

  async findByPkOrFail<M extends Model>(
    model: ModelStatic<M>,
    id: unknown,
    options: FindOptions = {},
  ): Promise<M> {
    this.calls.push({ method: 'findByPkOrFail', model: model.name, options: { id, ...options } });
    // The real class throws `ScopeViolationError` — a 404 — when the row is absent or out of
    // scope. The double reproduces that, because "what happens when the caller's own row is gone"
    // is a branch the services under test are expected to handle.
    if (this.self === null) throw new ScopeViolationError();
    return this.self as unknown as M;
  }

  async update<M extends Model>(
    model: ModelStatic<M>,
    values: unknown,
    options: UpdateOptions,
  ): Promise<number> {
    this.calls.push({ method: 'update', model: model.name, options, values });
    return this.affected;
  }

  /** Every call to `method`, in order. */
  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }
}

export function asScopedRepository(fake: FakeScopedRepository): ScopedRepository {
  return fake as unknown as ScopedRepository;
}

/** A `PermissionCacheService` that returns a fixed matrix and counts reads. */
export class FakePermissionCache {
  reads = 0;
  matrix: PermissionMap = new Map<string, ReadonlySet<string>>();

  grant(entity: string, ...actions: string[]): this {
    const next = new Map(this.matrix);
    next.set(entity, new Set(actions));
    this.matrix = next;
    return this;
  }

  async permissionsFor(_role: PortalRole): Promise<PermissionMap> {
    this.reads += 1;
    return this.matrix;
  }
}

export function asPermissionCache(fake: FakePermissionCache): PermissionCacheService {
  return fake as unknown as PermissionCacheService;
}

/** A `PermissionStore` whose only interesting method here is the live `rbac_version` read. */
export class FakeVersionStore implements PermissionStore {
  versionReads = 0;
  versions = new Map<PortalRole, number>();

  setVersion(role: PortalRole, version: number): this {
    this.versions.set(role, version);
    return this;
  }

  async findGrantsForRole(): Promise<readonly PermissionGrant[]> {
    return [];
  }

  async readRbacVersion(role: PortalRole): Promise<number> {
    this.versionReads += 1;
    return this.versions.get(role) ?? 1;
  }

  async readTtlSeconds(): Promise<number | null> {
    return 300;
  }

  async bumpRbacVersion(role: PortalRole): Promise<number> {
    const next = (this.versions.get(role) ?? 1) + 1;
    this.versions.set(role, next);
    return next;
  }
}

/** A `MessageService` that returns a fixed catalogue. */
export class FakeMessageService {
  catalogue: Record<string, string> = { NOT_FOUND: 'Not found.' };

  getAll(): Record<string, string> {
    return { ...this.catalogue };
  }
}

export function asMessageService(fake: FakeMessageService): MessageService {
  return fake as unknown as MessageService;
}

/** An `AuditService` that records what a service annotated instead of writing a row. */
export class FakeAuditService {
  readonly annotations: AuditDraft[] = [];

  annotate(patch: AuditDraft): void {
    this.annotations.push(patch);
  }
}

export function asAuditService(fake: FakeAuditService): AuditService {
  return fake as unknown as AuditService;
}

/** A verified-JWT actor. Defaults to a `maker` in country 3 / tenant 7. */
export function actor(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: 12,
    sessionId: '00000000-0000-4000-8000-000000000000',
    role: 'maker',
    countryId: 3,
    tenantId: 7,
    merchantId: null,
    rbacVersion: 1,
    tokenId: '00000000-0000-4000-8000-000000000001',
    mustChangePassword: false,
    ...overrides,
  };
}

/** The `portal_users` fields `/me` reads. Cast, because a real model instance needs a connection. */
export function userRow(overrides: Partial<PortalUser> = {}): PortalUser {
  return {
    id: 12,
    email: 'maker@example.invalid',
    displayName: 'A Maker',
    preferredLocale: 'en',
    preferredTimezone: 'Asia/Kolkata',
    status: 'active',
    mustChangePassword: false,
    lastLoginAt: new Date('2026-08-17T09:00:00.000Z'),
    updatedAt: new Date('2026-08-17T10:00:00.000Z'),
    ...overrides,
  } as unknown as PortalUser;
}

/** A `role_nav_configs` row, reduced to the columns the tree builder reads. */
export function navRow(
  navKey: string,
  overrides: Partial<{
    label: string;
    icon: string | null;
    path: string;
    parentNavKey: string | null;
  }> = {},
): RoleNavConfig {
  return {
    navKey,
    label: overrides.label ?? navKey,
    icon: overrides.icon ?? null,
    path: overrides.path ?? `/${navKey}`,
    parentNavKey: overrides.parentNavKey ?? null,
  } as unknown as RoleNavConfig;
}

/** A `role_dashboard_widgets` row. `widgetConfig` is post-getter, i.e. already parsed. */
export function widgetRow(
  widgetKey: string,
  overrides: Partial<{ label: string; widgetConfig: unknown }> = {},
): RoleDashboardWidget {
  return {
    widgetKey,
    label: overrides.label ?? widgetKey,
    widgetConfig: 'widgetConfig' in overrides ? overrides.widgetConfig : { type: 'kpi' },
  } as unknown as RoleDashboardWidget;
}

/** Re-exported so specs name the models the same way the service does. */
export { RoleDashboardWidget, RoleNavConfig };
