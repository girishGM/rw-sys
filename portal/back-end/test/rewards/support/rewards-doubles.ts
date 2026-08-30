/**
 * T-032 unit-test support — in-memory stand-ins for what `RewardsService` depends on. The
 * reward equivalent of `test/rules/support/rules-doubles.ts` (T-031) — see that file's header
 * for the full reasoning: the interesting behaviour here is a set of *decisions*, not "the real
 * Postgres returned the right rows" (already exhaustively proven by T-013).
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
import type { RewardSystem } from '@/database/models/reward-system.model';
import type { RewardPolicy } from '@/database/models/reward-policy.model';
import type { RewardCountryAssignment } from '@/database/models/reward-country-assignment.model';
import type { RewardCategory } from '@/database/models/reward-category.model';
import type { RewardSubCategory } from '@/database/models/reward-sub-category.model';
import type { Country } from '@/database/models/country.model';
import type { PortalUser } from '@/database/portal-models';
import type { RewardConnectorConfigCrypto } from '@/modules/rewards/reward-connector-config.crypto';

export interface RecordedCall {
  readonly method: string;
  readonly model: string;
  readonly options: unknown;
  readonly values?: unknown;
}

/** A `ScopedRepository` that answers from memory — see `rules-doubles.ts`'s copy for the full
 * behavioural contract this mirrors. */
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

/**
 * A `RewardConnectorConfigCrypto` that never touches real AES-GCM — deterministic markers only,
 * so `RewardsService`'s tests prove *that* it calls the right method with the right arguments at
 * the right point (provisional-then-rebind on create, single-shot on update), not that AES-GCM
 * round-trips (`reward-connector-config.crypto.spec.ts`'s own job, against the real
 * `FieldCryptoService`).
 */
export class FakeRewardConnectorConfigCrypto {
  readonly encryptForNewRowCalls: Record<string, unknown>[] = [];
  readonly encryptForRowCalls: { id: number; config: Record<string, unknown> }[] = [];
  readonly rebindToRowCalls: { id: number; stored: Record<string, unknown> }[] = [];
  readonly decryptForRowCalls: { id: number; stored: Record<string, unknown> }[] = [];
  decryptResult: Record<string, unknown> | null = null;

  encryptForNewRow(config: Record<string, unknown>): Record<string, unknown> {
    this.encryptForNewRowCalls.push(config);
    return { __enc: `provisional:${JSON.stringify(config)}` };
  }

  encryptForRow(id: number, config: Record<string, unknown>): Record<string, unknown> {
    this.encryptForRowCalls.push({ id, config });
    return { __enc: `bound:${id}:${JSON.stringify(config)}` };
  }

  rebindToRow(id: number, stored: Record<string, unknown>): Record<string, unknown> {
    this.rebindToRowCalls.push({ id, stored });
    return { __enc: `bound:${id}:rebound` };
  }

  decryptForRow(id: number, stored: Record<string, unknown>): Record<string, unknown> | null {
    this.decryptForRowCalls.push({ id, stored });
    return this.decryptResult;
  }
}

export function asRewardConnectorConfigCrypto(
  fake: FakeRewardConnectorConfigCrypto,
): RewardConnectorConfigCrypto {
  return fake as unknown as RewardConnectorConfigCrypto;
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

/** A `reward_systems` row shaped exactly as `toRewardDto`/`toRewardListItemDto` expect to read
 * it. `connectorConfig` defaults to `{}` — `parseJsonColumn`'s own fallback for a `NULL` column
 * (`reward-system.model.ts`), i.e. "no envelope, no connector config set". `category`/
 * `subCategory` (T-118) default to the eagerly-loaded `UNCATEGORIZED` category and no
 * sub-category — the shape every real read path loads it in (`WITH_CATEGORY`,
 * `rewards.service.ts`). */
export function rewardSystemRow(overrides: Partial<RewardSystem> = {}): RewardSystem {
  return {
    id: 1,
    tenantId: null,
    merchantId: null,
    systemCode: 'CASHBACK_STANDARD',
    name: 'Standard cashback',
    description: null,
    rewardType: 'monetary',
    deliveryMode: 'realtime',
    connectorType: 'internal_api',
    connectorConfig: {},
    maintenanceWindowEnabled: false,
    maintenanceSchedule: {},
    retryEnabled: true,
    retryConfig: {},
    categoryId: 1,
    subCategoryId: null,
    category: rewardCategoryRow(),
    subCategory: null,
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as RewardSystem;
}

export function rewardPolicyRow(overrides: Partial<RewardPolicy> = {}): RewardPolicy {
  return {
    id: 10,
    rewardSystemId: 1,
    policyCode: 'STANDARD',
    name: 'Standard policy',
    description: null,
    config: {},
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as RewardPolicy;
}

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

/** T-116 — a `reward_categories` row shaped exactly as `toRewardCategoryDto` expects to read
 * it. */
export function rewardCategoryRow(overrides: Partial<RewardCategory> = {}): RewardCategory {
  return {
    id: 1,
    tenantId: 1,
    categoryCode: 'UNCATEGORIZED',
    name: 'Uncategorized',
    description: null,
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as RewardCategory;
}

/** T-116 — a `reward_sub_categories` row shaped exactly as `toRewardSubCategoryDto` expects to
 * read it. */
export function rewardSubCategoryRow(
  overrides: Partial<RewardSubCategory> = {},
): RewardSubCategory {
  return {
    id: 1,
    categoryId: 1,
    subCategoryCode: 'GENERAL',
    name: 'General',
    description: null,
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as RewardSubCategory;
}

export function rewardCountryAssignmentRow(
  overrides: Partial<RewardCountryAssignment> = {},
): RewardCountryAssignment & { country: Country } {
  return {
    id: 500,
    rewardId: 1,
    countryId: 1,
    assignedAt: new Date('2026-01-01T00:00:00.000Z'),
    assignedBy: 1,
    country: countryRow(),
    ...overrides,
  } as unknown as RewardCountryAssignment & { country: Country };
}
