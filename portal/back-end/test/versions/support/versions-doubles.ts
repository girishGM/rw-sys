/**
 * T-041 unit-test support — in-memory stand-ins for what `RuleVersionsService`,
 * `RewardVersionsService`, `AssignedVersionsService` and `BlastsService` depend on. Same
 * reasoning as `test/rules/support/rules-doubles.ts` (T-031): the interesting behaviour here is
 * a set of *decisions*, not "the real Postgres returned the right rows" — `ScopedRepository`
 * and `scope-strategy.ts` are already exhaustively tested by T-013.
 *
 * Shared by both `test/versions/**` and `test/blasts/**` — a single support file, not a
 * duplicate pair, because the row shapes (`RuleVersion`, `RuleVersionCountryAssignment`, …) are
 * identical fixtures either suite needs, and `rules-doubles.ts`/`rewards-doubles.ts` already
 * establish that a *service's own* doubles file is the unit, not a doubles file per test file.
 */
import type {
  CountOptions,
  CreateOptions,
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
import type {
  NotificationsService,
  NotifyInput,
} from '@/modules/notifications/notifications.service';
import type { RuleMaster } from '@/database/models/rule-master.model';
import type { RuleVersion } from '@/database/models/rule-version.model';
import type { RuleVersionCountryAssignment } from '@/database/models/rule-version-country-assignment.model';
import type { RewardSystem } from '@/database/models/reward-system.model';
import type { RewardVersion } from '@/database/models/reward-version.model';
import type { RewardVersionCountryAssignment } from '@/database/models/reward-version-country-assignment.model';
import type { Country } from '@/database/models/country.model';
import type { VersionBlast } from '@/database/models/version-blast.model';
import type { VersionBlastTarget } from '@/database/models/version-blast-target.model';
import type { PortalUser } from '@/database/portal-models';

export interface RecordedCall {
  readonly method: string;
  readonly model: string;
  readonly options: unknown;
  readonly values?: unknown;
}

/**
 * A `ScopedRepository` that answers from memory. `listAll` results are keyed per model **and**
 * consumed as a queue when more than one list is registered for the same model — several
 * methods in this task's services issue two different `listAll(RuleVersion, …)` calls in one
 * request (e.g. `latestPublishedVersion` then `nextVersionNo`), and a single fixed answer per
 * model would make the second call silently reuse the first's result.
 */
export class FakeScopedRepository {
  readonly calls: RecordedCall[] = [];

  /** `set*` writes the permanent fallback ("base"); `push*` enqueues one-time answers consumed
   * strictly FIFO, one per call, before the base is ever consulted again. This two-tier shape
   * (rather than a single queue that goes "sticky" on its last element) is what makes a test
   * with more than two sequential same-model reads in one call chain — `deprecate()` then
   * `retire()` sharing one `RuleVersion`/`RewardVersion` queue, say — behave the way the test
   * reads: every pushed answer is used exactly once, in order, full stop. */
  private readonly listBase = new Map<string, unknown[]>();
  private readonly listQueues = new Map<string, unknown[][]>();
  private readonly countBase = new Map<string, number>();
  private readonly countQueues = new Map<string, number[]>();
  private readonly byPkBase = new Map<string, unknown>();
  private readonly byPkQueues = new Map<string, unknown[]>();
  private readonly findOneBase = new Map<string, unknown>();
  private readonly findOneQueues = new Map<string, unknown[]>();
  private readonly createErrors = new Map<string, Error[]>();
  private nextId = 1000;

  updateAffected = 1;

  /** Pushes one more one-time answer onto this model's `listAll` queue — consumed before the
   * base set via {@link setListRows}, strictly FIFO. */
  pushListRows(model: ModelStatic<Model>, rows: readonly unknown[]): this {
    const queue = this.listQueues.get(model.name) ?? [];
    queue.push([...rows]);
    this.listQueues.set(model.name, queue);
    return this;
  }

  /** The permanent fallback every `listAll` call for this model returns once any pushed
   * one-time answers are exhausted (or when none were ever pushed). */
  setListRows(model: ModelStatic<Model>, rows: readonly unknown[]): this {
    this.listBase.set(model.name, [...rows]);
    return this;
  }

  pushCount(model: ModelStatic<Model>, count: number): this {
    const queue = this.countQueues.get(model.name) ?? [];
    queue.push(count);
    this.countQueues.set(model.name, queue);
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

  setFindOneResult(model: ModelStatic<Model>, row: unknown): this {
    this.findOneBase.set(model.name, row);
    return this;
  }

  pushFindOneResult(model: ModelStatic<Model>, row: unknown): this {
    const queue = this.findOneQueues.get(model.name) ?? [];
    queue.push(row);
    this.findOneQueues.set(model.name, queue);
    return this;
  }

  failNextCreate(model: ModelStatic<Model>, error: Error): this {
    const queue = this.createErrors.get(model.name) ?? [];
    queue.push(error);
    this.createErrors.set(model.name, queue);
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
    const queue = this.countQueues.get(model.name);
    if (queue !== undefined && queue.length > 0) return queue.shift() as number;
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
    model: ModelStatic<M>,
    options: FindOptions = {},
  ): Promise<M> {
    this.record('findOneOrFail', model, options);
    const queue = this.findOneQueues.get(model.name);
    const row =
      queue !== undefined && queue.length > 0 ? queue.shift() : this.findOneBase.get(model.name);
    if (row === undefined || row === null) throw new ScopeViolationError();
    return row as M;
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

/** A `Sequelize` whose only interesting behaviour is `.transaction()` (runs `fn` immediately with
 * a dummy transaction token) and `.query()` (a scripted, in-memory response) — no real commit/
 * rollback, no real connection. */
export class FakeSequelize {
  transactionCalls = 0;
  queryCalls: { statement: string; options: unknown }[] = [];
  private queryResults: unknown[][] = [[]];

  async transaction<T>(fn: (transaction: Transaction) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    return fn({} as Transaction);
  }

  setQueryResult(rows: unknown[]): this {
    this.queryResults = [rows];
    return this;
  }

  pushQueryResult(rows: unknown[]): this {
    this.queryResults.push(rows);
    return this;
  }

  async query(statement: string, options: unknown): Promise<unknown> {
    this.queryCalls.push({ statement, options });
    return this.queryResults.length > 1 ? this.queryResults.shift() : this.queryResults[0];
  }
}

export function asSequelize(fake: FakeSequelize): Sequelize {
  return fake as unknown as Sequelize;
}

export class FakeAuditService {
  readonly annotations: AuditDraft[] = [];
  readonly diffFieldsCalls: { before: Record<string, unknown>; after: Record<string, unknown> }[] =
    [];

  annotate(patch: AuditDraft): void {
    this.annotations.push(patch);
  }

  diffFields(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Record<string, { before: unknown; after: unknown }> {
    this.diffFieldsCalls.push({ before, after });
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

export function portalUserRow(overrides: Partial<PortalUser> = {}): PortalUser {
  return { id: 1, adminUserId: null, ...overrides } as unknown as PortalUser;
}

export function countryRow(overrides: Partial<Country> = {}): Country {
  return {
    id: 1,
    code: 'MY',
    name: 'Malaysia',
    status: 'active',
    ...overrides,
  } as unknown as Country;
}

export function ruleRow(overrides: Partial<RuleMaster> = {}): RuleMaster {
  return {
    id: 1,
    tenantId: null,
    subCategoryId: 13,
    ruleCode: 'MIN_SPEND_TIER',
    name: 'Minimum spend tier',
    expression: 'amount >= :minSpend',
    parameters: {
      fields: [{ key: 'minSpend', label: 'Min spend', type: 'number', required: true }],
    },
    createdBy: 1,
    status: 'active',
    ...overrides,
  } as unknown as RuleMaster;
}

export function ruleVersionRow(overrides: Partial<RuleVersion> = {}): RuleVersion {
  return {
    id: 100,
    ruleId: 1,
    versionNo: 1,
    expression: 'amount >= :minSpend',
    parameters: {
      fields: [{ key: 'minSpend', label: 'Min spend', type: 'number', required: true }],
    },
    changeSummary: null,
    isBreaking: false,
    status: 'draft',
    supersedesVersionId: null,
    originRequestId: null,
    createdBy: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    publishedBy: null,
    publishedAt: null,
    deprecatedAt: null,
    retiredAt: null,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    // T-109 — mirrors `rule-version.model.ts`'s own default: `NULL` reads as "not yet wired".
    resolverId: null,
    resolverConfig: null,
    evaluationContext: null,
    defaultOperators: null,
    ...overrides,
  } as unknown as RuleVersion;
}

export function ruleVersionCountryAssignmentRow(
  overrides: Partial<RuleVersionCountryAssignment> = {},
): RuleVersionCountryAssignment & { country: Country; ruleVersion: RuleVersion } {
  return {
    id: 900,
    ruleVersionId: 100,
    ruleId: 1,
    countryId: 1,
    blastId: null,
    status: 'active',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: null,
    assignedBy: 1,
    assignedAt: new Date('2026-01-01T00:00:00.000Z'),
    country: countryRow(),
    ruleVersion: ruleVersionRow(),
    ...overrides,
  } as unknown as RuleVersionCountryAssignment & { country: Country; ruleVersion: RuleVersion };
}

export function rewardRow(overrides: Partial<RewardSystem> = {}): RewardSystem {
  return {
    id: 1,
    tenantId: null,
    merchantId: null,
    systemCode: 'CASHBACK_BASIC',
    name: 'Basic cashback',
    description: null,
    rewardType: 'cashback',
    deliveryMode: 'realtime',
    connectorType: 'internal_api',
    connectorConfig: { endpoint: 'https://example.invalid' },
    maintenanceWindowEnabled: false,
    maintenanceSchedule: {},
    retryEnabled: true,
    retryConfig: { maxAttempts: 3 },
    status: 'active',
    ...overrides,
  } as unknown as RewardSystem;
}

export function rewardVersionRow(overrides: Partial<RewardVersion> = {}): RewardVersion {
  return {
    id: 200,
    rewardId: 1,
    versionNo: 1,
    connectorConfig: { endpoint: 'https://example.invalid' },
    deliveryMode: 'realtime',
    retryConfig: { maxAttempts: 3 },
    policiesSnapshot: null,
    unitType: 'currency',
    unitCode: 'USD',
    changeSummary: null,
    isBreaking: false,
    status: 'draft',
    supersedesVersionId: null,
    originRequestId: null,
    createdBy: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    publishedBy: null,
    publishedAt: null,
    deprecatedAt: null,
    retiredAt: null,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as RewardVersion;
}

export function rewardVersionCountryAssignmentRow(
  overrides: Partial<RewardVersionCountryAssignment> = {},
): RewardVersionCountryAssignment & { country: Country; rewardVersion: RewardVersion } {
  return {
    id: 950,
    rewardVersionId: 200,
    rewardId: 1,
    countryId: 1,
    blastId: null,
    status: 'active',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: null,
    assignedBy: 1,
    assignedAt: new Date('2026-01-01T00:00:00.000Z'),
    country: countryRow(),
    rewardVersion: rewardVersionRow(),
    ...overrides,
  } as unknown as RewardVersionCountryAssignment & {
    country: Country;
    rewardVersion: RewardVersion;
  };
}

export function versionBlastRow(overrides: Partial<VersionBlast> = {}): VersionBlast {
  return {
    id: 700,
    entityType: 'rule',
    entityId: 1,
    versionId: 100,
    versionNo: 1,
    scope: 'selected',
    targetCount: 1,
    note: null,
    originRequestId: null,
    blastedBy: 1,
    blastedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as VersionBlast;
}

export function versionBlastTargetRow(
  overrides: Partial<VersionBlastTarget> = {},
): VersionBlastTarget & { country: Country; blast: VersionBlast } {
  return {
    id: 800,
    blastId: 700,
    countryId: 1,
    status: 'delivered',
    failureReason: null,
    country: countryRow(),
    blast: versionBlastRow(),
    ...overrides,
  } as unknown as VersionBlastTarget & { country: Country; blast: VersionBlast };
}
