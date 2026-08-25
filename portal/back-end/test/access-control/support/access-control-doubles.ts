/**
 * T-033 unit-test support — in-memory stand-ins for what `AccessControlService` depends on.
 * Same reasoning `test/rules/support/rules-doubles.ts` (T-031) and `test/me/support/me-doubles.ts`
 * (T-015) both give: the interesting behaviour here is a set of *decisions* — which row got
 * locked, whether the lock-out check ran before any write, whether the version bump landed inside
 * the same transaction — not "the real Postgres returned the right rows", which
 * `common/scope/scope-strategy.ts`/`ScopedRepository` are already exhaustively tested for.
 */
import type {
  CountOptions,
  CreateOptions,
  DestroyOptions,
  FindOptions,
  Model,
  ModelStatic,
  Transaction,
  UpdateOptions,
} from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { ScopeViolationError } from '@/common/scope/scope.exceptions';
import type { ScopedRepository } from '@/common/scope/scoped.repository';
import type { AuditService } from '@/common/audit/audit.service';
import type { AuditDraft } from '@/common/audit/audit-context';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import type { PermissionCacheService, PermissionMap } from '@/common/rbac/permission-cache.service';
import type { PermissionStore, PermissionGrant } from '@/common/rbac/permission.repository';
import type { PortalRole } from '@/database/portal-models';

export interface RecordedCall {
  readonly method: string;
  readonly model: string;
  readonly options: unknown;
  readonly values?: unknown;
}

/** A `ScopedRepository` that answers from memory — `findOneOrFail` throws
 * `ScopeViolationError` (the "missing" signal `lockAndCheckVersion` treats as version 0) unless a
 * result was primed with {@link FakeScopedRepository.setFindOneResult}. */
export class FakeScopedRepository {
  readonly calls: RecordedCall[] = [];

  private readonly listRows = new Map<string, unknown[]>();
  private readonly counts = new Map<string, number>();
  private readonly findOneResult = new Map<string, unknown>();
  private nextId = 1000;

  updateAffected = 1;

  setListRows(model: ModelStatic<Model>, rows: readonly unknown[]): this {
    this.listRows.set(model.name, [...rows]);
    return this;
  }

  setCount(model: ModelStatic<Model>, count: number): this {
    this.counts.set(model.name, count);
    return this;
  }

  /** Same as {@link setCount}, but discriminated by `options.where.role` — `listRoles()` counts
   * `PortalUser` once per role, and a single model-wide count cannot tell those calls apart. */
  setCountForRole(model: ModelStatic<Model>, role: string, count: number): this {
    this.counts.set(`${model.name}:${role}`, count);
    return this;
  }

  setFindOneResult(model: ModelStatic<Model>, row: unknown | null): this {
    if (row === null) this.findOneResult.delete(model.name);
    else this.findOneResult.set(model.name, row);
    return this;
  }

  async listAll<M extends Model>(model: ModelStatic<M>, options: FindOptions = {}): Promise<M[]> {
    this.record('listAll', model, options);
    return (this.listRows.get(model.name) ?? []) as M[];
  }

  async count(model: ModelStatic<Model>, options: CountOptions = {}): Promise<number> {
    this.record('count', model, options);
    const role = (options.where as { role?: string } | undefined)?.role;
    if (role !== undefined) {
      const byRole = this.counts.get(`${model.name}:${role}`);
      if (byRole !== undefined) return byRole;
    }
    return this.counts.get(model.name) ?? 0;
  }

  async findOneOrFail<M extends Model>(
    model: ModelStatic<M>,
    options: FindOptions = {},
  ): Promise<M> {
    this.record('findOneOrFail', model, options);
    const row = this.findOneResult.get(model.name);
    if (row === undefined || row === null) throw new ScopeViolationError();
    return row as M;
  }

  async create<M extends Model>(
    model: ModelStatic<M>,
    values: unknown,
    options: CreateOptions = {},
  ): Promise<M> {
    this.record('create', model, options, values);
    const now = new Date('2026-01-01T00:00:00.000Z');
    const row = { id: this.nextId, createdAt: now, updatedAt: now, ...(values as object) };
    this.nextId += 1;
    return row as unknown as M;
  }

  async update(
    model: ModelStatic<Model>,
    values: unknown,
    options: UpdateOptions,
  ): Promise<number> {
    this.record('update', model, options, values);
    return this.updateAffected;
  }

  async destroy(model: ModelStatic<Model>, options: DestroyOptions): Promise<number> {
    this.record('destroy', model, options);
    return this.updateAffected;
  }

  private record(
    method: string,
    model: ModelStatic<Model>,
    options: unknown,
    values?: unknown,
  ): void {
    this.calls.push({ method, model: model.name, options, values });
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }
}

export function asScopedRepository(fake: FakeScopedRepository): ScopedRepository {
  return fake as unknown as ScopedRepository;
}

/** A `Sequelize` whose only interesting behaviour is `.transaction()` — runs `fn` immediately
 * against a stub transaction object, no real commit/rollback. `transactionCalls`/`rolledBack` let
 * a test assert a thrown lock-out/version error prevented the transaction body from committing
 * (there is nothing to roll back in this fake — the assertion is "the write calls after the throw
 * never happened", which `FakeScopedRepository.calls` already answers). */
export class FakeSequelize {
  transactionCalls = 0;

  async transaction<T>(fn: (transaction: Transaction) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    return fn({} as Transaction);
  }
}

export function asSequelize(fake: FakeSequelize): Sequelize {
  return fake as unknown as Sequelize;
}

/** An `AuditService` that records what a service annotated instead of writing a row. */
export class FakeAuditService {
  readonly annotations: AuditDraft[] = [];

  annotate(patch: AuditDraft): void {
    this.annotations.push(patch);
  }

  diffFields(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Record<string, { before: unknown; after: unknown }> {
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) {
        changes[key] = { before: before[key] ?? null, after: after[key] ?? null };
      }
    }
    return changes;
  }
}

export function asAuditService(fake: FakeAuditService): AuditService {
  return fake as unknown as AuditService;
}

/** A `PermissionCacheService` double — `invalidate` records the roles it was called with;
 * `permissionsFor` returns a fixed matrix (used only by `preview()`'s no-draft branch). */
export class FakePermissionCache {
  invalidated: (PortalRole | undefined)[] = [];
  matrix: PermissionMap = new Map<string, ReadonlySet<string>>();

  grant(entity: string, ...actions: string[]): this {
    const next = new Map(this.matrix);
    next.set(entity, new Set(actions));
    this.matrix = next;
    return this;
  }

  async permissionsFor(_role: PortalRole): Promise<PermissionMap> {
    return this.matrix;
  }

  invalidate(role?: PortalRole): void {
    this.invalidated.push(role);
  }
}

export function asPermissionCache(fake: FakePermissionCache): PermissionCacheService {
  return fake as unknown as PermissionCacheService;
}

/** A `PermissionStore` whose only interesting method here is the live `rbac_version` read used by
 * every `GET` route. */
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

/** A verified-JWT actor. Defaults to `super_admin` — the only role this module's routes admit. */
export function actor(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: 1,
    sessionId: '00000000-0000-4000-8000-000000000000',
    role: 'super_admin',
    countryId: null,
    tenantId: null,
    merchantId: null,
    rbacVersion: 1,
    tokenId: '00000000-0000-4000-8000-000000000001',
    mustChangePassword: false,
    ...overrides,
  };
}

/** `rbac_cache_config` row shape — `configValue` is always a decimal-string. */
export function rbacCacheConfigRow(
  configKey: string,
  version: number,
): { configKey: string; configValue: string } {
  return { configKey, configValue: String(version) };
}
