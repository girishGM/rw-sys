/**
 * T-042 unit-test support — in-memory stand-ins for what `DefinitionRequestsService` depends on.
 * Same reasoning `test/versions/support/versions-doubles.ts` (T-041) and
 * `test/rules/support/rules-doubles.ts` (T-031) give: the interesting behaviour here is a set of
 * *decisions*, not "the real Postgres returned the right rows" — `ScopedRepository` and
 * `scope-strategy.ts` are already exhaustively tested by T-013. Own copy, not an import from
 * `test/versions/support/**` — that file's own header documents the "a service's own doubles
 * file is the unit" precedent, and this is a different task's module.
 */
import type {
  CountOptions,
  CreateOptions,
  FindOptions,
  Model,
  ModelStatic,
  UpdateOptions,
} from 'sequelize';
import { ScopeViolationError } from '@/common/scope/scope.exceptions';
import type { ScopedRepository } from '@/common/scope/scoped.repository';
import type { AuditService } from '@/common/audit/audit.service';
import type { AuditDraft } from '@/common/audit/audit-context';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import type {
  NotificationsService,
  NotifyInput,
} from '@/modules/notifications/notifications.service';
import type { DefinitionRequest } from '@/database/models/definition-request.model';
import type { RuleVersion } from '@/database/models/rule-version.model';
import type { RewardVersion } from '@/database/models/reward-version.model';
import type { Tenant } from '@/database/models/tenant.model';
import type { PortalUser } from '@/database/portal-models';

export interface RecordedCall {
  readonly method: string;
  readonly model: string;
  readonly options: unknown;
  readonly values?: unknown;
}

/** Same two-tier (base + one-time queue) shape `versions-doubles.ts`'s own header documents at
 * length — several methods in `DefinitionRequestsService` issue more than one `listAll`/`findByPk`
 * against the same model in a single call (e.g. `resolveRequesterPortalUserId`'s bridge lookup
 * then fallback). */
export class FakeScopedRepository {
  readonly calls: RecordedCall[] = [];

  private readonly listBase = new Map<string, unknown[]>();
  private readonly listQueues = new Map<string, unknown[][]>();
  private readonly countBase = new Map<string, number>();
  private readonly byPkBase = new Map<string, unknown>();
  private readonly byPkQueues = new Map<string, unknown[]>();
  private readonly createErrors = new Map<string, Error[]>();
  private nextId = 1000;

  updateAffected = 1;

  pushListRows(model: ModelStatic<Model>, rows: readonly unknown[]): this {
    const queue = this.listQueues.get(model.name) ?? [];
    queue.push([...rows]);
    this.listQueues.set(model.name, queue);
    return this;
  }

  setListRows(model: ModelStatic<Model>, rows: readonly unknown[]): this {
    this.listBase.set(model.name, [...rows]);
    return this;
  }

  setCount(model: ModelStatic<Model>, count: number): this {
    this.countBase.set(model.name, count);
    return this;
  }

  setByPk(model: ModelStatic<Model>, row: unknown): this {
    this.byPkBase.set(model.name, row);
    return this;
  }

  pushByPk(model: ModelStatic<Model>, row: unknown): this {
    const queue = this.byPkQueues.get(model.name) ?? [];
    queue.push(row);
    this.byPkQueues.set(model.name, queue);
    return this;
  }

  failNextCreate(model: ModelStatic<Model>, error: Error): this {
    const queue = this.createErrors.get(model.name) ?? [];
    queue.push(error);
    this.createErrors.set(model.name, queue);
    return this;
  }

  setUpdateAffected(count: number): this {
    this.updateAffected = count;
    return this;
  }

  async listAll<M extends Model>(model: ModelStatic<M>, options: FindOptions = {}): Promise<M[]> {
    this.record('listAll', model, options);
    const queue = this.listQueues.get(model.name);
    if (queue !== undefined && queue.length > 0) return queue.shift() as M[];
    return (this.listBase.get(model.name) ?? []) as M[];
  }

  async count(model: ModelStatic<Model>, options: CountOptions = {}): Promise<number> {
    this.record('count', model, options);
    return this.countBase.get(model.name) ?? 0;
  }

  async findByPkOrFail<M extends Model>(
    model: ModelStatic<M>,
    id: unknown,
    options: FindOptions = {},
  ): Promise<M> {
    this.record('findByPkOrFail', model, { id, ...options });
    const queue = this.byPkQueues.get(model.name);
    const row =
      queue !== undefined && queue.length > 0 ? queue.shift() : this.byPkBase.get(model.name);
    if (row === undefined || row === null) throw new ScopeViolationError();
    return { ...(row as object) } as M;
  }

  async findOneOrFail<M extends Model>(
    _model: ModelStatic<M>,
    _options: FindOptions = {},
  ): Promise<M> {
    throw new ScopeViolationError();
  }

  async create<M extends Model>(
    model: ModelStatic<M>,
    values: unknown,
    options: CreateOptions = {},
  ): Promise<M> {
    this.record('create', model, options, values);

    const queue = this.createErrors.get(model.name);
    if (queue !== undefined && queue.length > 0) {
      throw queue.shift() as Error;
    }

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

  async destroy(model: ModelStatic<Model>, options: { where?: unknown }): Promise<number> {
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

export class FakeNotificationsService {
  readonly notified: NotifyInput[] = [];

  async notify(input: NotifyInput): Promise<void> {
    this.notified.push(input);
  }
}

export function asNotificationsService(fake: FakeNotificationsService): NotificationsService {
  return fake as unknown as NotificationsService;
}

export function actor(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: 1,
    sessionId: '00000000-0000-4000-8000-000000000000',
    role: 'country_admin',
    countryId: 9,
    tenantId: null,
    merchantId: null,
    rbacVersion: 1,
    tokenId: '00000000-0000-4000-8000-000000000001',
    mustChangePassword: false,
    ...overrides,
  };
}

export function portalUserRow(overrides: Partial<PortalUser> = {}): PortalUser {
  return {
    id: 1,
    adminUserId: null,
    role: 'country_admin',
    status: 'active',
    ...overrides,
  } as unknown as PortalUser;
}

export function tenantRow(overrides: Partial<Tenant> = {}): Tenant {
  return { id: 900, countryId: 9, ...overrides } as unknown as Tenant;
}

export function definitionRequestRow(
  overrides: Partial<DefinitionRequest> = {},
): DefinitionRequest {
  return {
    id: 1,
    requestType: 'new_rule',
    entityId: null,
    requestedBy: 1,
    requestingCountryId: 9,
    requestingTenantId: null,
    title: 'Weekend multiplier',
    description: 'We need a 2x multiplier on weekends.',
    businessJustification: null,
    desiredBy: null,
    priority: 'normal',
    status: 'submitted',
    reviewedBy: null,
    reviewedAt: null,
    reviewComment: null,
    fulfilledVersionId: null,
    fulfilledAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as DefinitionRequest;
}

export function ruleVersionRow(overrides: Partial<RuleVersion> = {}): RuleVersion {
  return {
    id: 100,
    ruleId: 1,
    versionNo: 1,
    status: 'draft',
    isBreaking: false,
    originRequestId: null,
    ...overrides,
  } as unknown as RuleVersion;
}

export function rewardVersionRow(overrides: Partial<RewardVersion> = {}): RewardVersion {
  return {
    id: 200,
    rewardId: 1,
    versionNo: 1,
    status: 'draft',
    isBreaking: false,
    originRequestId: null,
    ...overrides,
  } as unknown as RewardVersion;
}
