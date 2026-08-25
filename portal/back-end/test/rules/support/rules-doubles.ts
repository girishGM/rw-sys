/**
 * T-031 unit-test support — in-memory stand-ins for what `RulesService` depends on.
 *
 * Same reasoning as `test/countries/support/countries-doubles.ts` (T-030), itself following
 * `test/me/support/me-doubles.ts` (T-015): the interesting behaviour here is a set of
 * *decisions* (which model, which `where`, which transaction, whether `assertRole` fired
 * before any query ran at all) — not "the real Postgres returned the right rows", which
 * `common/scope/scope-strategy.ts` and `ScopedRepository` are already exhaustively tested for
 * (T-013's own 100% branch-coverage bar) and which this task does not need to re-prove.
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
import type { RuleMaster } from '@/database/models/rule-master.model';
import type { RuleCategory } from '@/database/models/rule-category.model';
import type { RuleSubCategory } from '@/database/models/rule-sub-category.model';
import type { RuleCountryAssignment } from '@/database/models/rule-country-assignment.model';
import type { Country } from '@/database/models/country.model';
import type { PortalUser } from '@/database/portal-models';

export interface RecordedCall {
  readonly method: string;
  readonly model: string;
  readonly options: unknown;
  readonly values?: unknown;
}

/**
 * A `ScopedRepository` that answers from memory. `findOneOrFail`/`findByPkOrFail` both read
 * from the same `byPk`/`listRows` fixtures, matching the shape the real class actually
 * guarantees (404 for absent-or-out-of-scope, indistinguishable).
 */
export class FakeScopedRepository {
  readonly calls: RecordedCall[] = [];

  private readonly listRows = new Map<string, unknown[]>();
  private readonly counts = new Map<string, number>();
  private readonly byPk = new Map<string, unknown>();
  private readonly findOneResult = new Map<string, unknown>();
  private readonly createError = new Map<string, Error>();
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

  setByPk(model: ModelStatic<Model>, row: unknown): this {
    this.byPk.set(model.name, row);
    return this;
  }

  /** Consumed by `findOne`/`findOneOrFail` — a queue of one, replaced per call in these tests. */
  setFindOneResult(model: ModelStatic<Model>, row: unknown): this {
    this.findOneResult.set(model.name, row);
    return this;
  }

  failNextCreate(model: ModelStatic<Model>, error: Error): this {
    this.createError.set(model.name, error);
    return this;
  }

  async listAll<M extends Model>(model: ModelStatic<M>, options: FindOptions = {}): Promise<M[]> {
    this.record('listAll', model, options);
    return (this.listRows.get(model.name) ?? []) as M[];
  }

  async count(model: ModelStatic<Model>, options: CountOptions = {}): Promise<number> {
    this.record('count', model, options);
    return this.counts.get(model.name) ?? 0;
  }

  async findByPkOrFail<M extends Model>(
    model: ModelStatic<M>,
    id: unknown,
    options: FindOptions = {},
  ): Promise<M> {
    this.record('findByPkOrFail', model, { id, ...options });
    const row = this.byPk.get(model.name);
    if (row === undefined || row === null) throw new ScopeViolationError();
    // A shallow copy, not the stored reference: a real `findByPkOrFail` is a fresh SQL read
    // each call, so a caller that keeps an earlier result (`RulesService.update`'s `before`)
    // must not see a later `update()` retroactively mutate it through shared object identity —
    // that would be a fake-only artifact, not real Sequelize/Postgres behaviour.
    return { ...(row as object) } as M;
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

    const error = this.createError.get(model.name);
    if (error !== undefined) {
      this.createError.delete(model.name);
      throw error;
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
    const current = this.byPk.get(model.name);
    if (current !== undefined && current !== null && typeof current === 'object') {
      Object.assign(current, values as object);
    }
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

/** A `Sequelize` whose only interesting behaviour is `.transaction()` (runs `fn` immediately) and
 * `.query()` (a scripted, in-memory response) — no real commit/rollback, no real connection. */
export class FakeSequelize {
  transactionCalls = 0;
  queryCalls: { statement: string; options: unknown }[] = [];
  private queryResult: unknown[] = [];

  async transaction<T>(fn: (transaction: Transaction) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    return fn({} as Transaction);
  }

  setQueryResult(rows: unknown[]): this {
    this.queryResult = rows;
    return this;
  }

  async query(statement: string, options: unknown): Promise<unknown> {
    this.queryCalls.push({ statement, options });
    return this.queryResult;
  }
}

export function asSequelize(fake: FakeSequelize): Sequelize {
  return fake as unknown as Sequelize;
}

/** An `AuditService` that records what a service annotated instead of writing a row. */
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

/** A verified-JWT actor. Defaults to `super_admin` — the only role this module's writes admit. */
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

export function ruleCategoryRow(overrides: Partial<RuleCategory> = {}): RuleCategory {
  return {
    id: 13,
    tenantId: 1,
    categoryCode: 'TRANSACTION',
    name: 'TRANSACTION',
    status: 'active',
    ...overrides,
  } as unknown as RuleCategory;
}

export function ruleSubCategoryRow(overrides: Partial<RuleSubCategory> = {}): RuleSubCategory {
  return {
    id: 13,
    categoryId: 13,
    subCategoryCode: 'GENERAL',
    name: 'General',
    status: 'active',
    category: ruleCategoryRow(),
    ...overrides,
  } as unknown as RuleSubCategory;
}

/** A `rule_master` row shaped exactly as `toRuleDto` expects to read it — `subCategory.category`
 * eagerly present, matching `WITH_CATEGORY`'s eager load in every read path. */
export function ruleRow(overrides: Partial<RuleMaster> = {}): RuleMaster {
  return {
    id: 1,
    tenantId: null,
    subCategoryId: 13,
    ruleCode: 'MIN_SPEND_TIER',
    name: 'Minimum spend tier',
    expression: 'amount >= :minSpend',
    parameters: { fields: [] },
    createdBy: 1,
    status: 'active',
    subCategory: ruleSubCategoryRow(),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as RuleMaster;
}

/** A `portal_users` row, reduced to the column `resolveAdminUserId` reads back. */
export function portalUserRow(overrides: Partial<PortalUser> = {}): PortalUser {
  return {
    id: 1,
    adminUserId: null,
    ...overrides,
  } as unknown as PortalUser;
}

export function countryRow(overrides: Partial<Country> = {}): Country {
  return {
    id: 1,
    code: 'MY',
    name: 'Malaysia',
    ...overrides,
  } as unknown as Country;
}

export function ruleCountryAssignmentRow(
  overrides: Partial<RuleCountryAssignment> = {},
): RuleCountryAssignment & { country: Country } {
  return {
    id: 500,
    ruleId: 1,
    countryId: 1,
    assignedAt: new Date('2026-01-01T00:00:00.000Z'),
    assignedBy: 1,
    country: countryRow(),
    ...overrides,
  } as unknown as RuleCountryAssignment & { country: Country };
}
