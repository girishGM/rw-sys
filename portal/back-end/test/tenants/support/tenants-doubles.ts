/**
 * T-034 unit-test support — in-memory stand-ins for what `TenantsService` depends on.
 *
 * Same reasoning as `test/countries/support/countries-doubles.ts` (T-030): the interesting
 * behaviour here is a set of *decisions* — which model, which `where`, which transaction,
 * whether `assertRole` fired before any query ran, which users got a session revocation call —
 * not "the real Postgres returned the right rows", which `common/scope/scope-strategy.ts` and
 * `ScopedRepository` are already exhaustively tested for (T-013, 100% branch coverage).
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
import type { CredentialService } from '@/modules/auth/services/credential.service';
import type {
  AuthTransaction,
  CredentialProvisioner,
} from '@/modules/auth/services/credential.repository';
import type { RequestContext, SessionService } from '@/modules/auth/services/session.service';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import type { Country } from '@/database/models/country.model';
import type { Tenant } from '@/database/models/tenant.model';
import type { TenantBudgetCeiling } from '@/database/models/tenant-budget-ceiling.model';
import type { TenantCurrency } from '@/database/models/tenant-currency.model';
import type { PortalUser } from '@/database/portal-models';

export interface RecordedCall {
  readonly method: string;
  readonly model: string;
  readonly options: unknown;
  readonly values?: unknown;
}

/**
 * A `ScopedRepository` that answers from memory.
 *
 * `update()` merges its `values` into the row `setByPk` is currently holding for that model —
 * this is what lets `TenantsService.update()`'s second `findByPkOrFail` (the "read back what was
 * just written" call) observe the change, without a second fixture to keep in sync by hand.
 */
export class FakeScopedRepository {
  readonly calls: RecordedCall[] = [];

  private readonly listRows = new Map<string, unknown[]>();
  private readonly counts = new Map<string, number>();
  private readonly byPk = new Map<string, unknown>();
  private readonly createError = new Map<string, Error>();
  private readonly updateError = new Map<string, Error>();
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

  /** `row: null` reproduces the real class's 404-on-absent-or-out-of-scope behaviour. */
  setByPk(model: ModelStatic<Model>, row: unknown): this {
    this.byPk.set(model.name, row);
    return this;
  }

  /** The next `create()` call for `model` throws `error` instead of returning a row. */
  failNextCreate(model: ModelStatic<Model>, error: Error): this {
    this.createError.set(model.name, error);
    return this;
  }

  /** The next `update()` call for `model` throws `error` instead of affecting rows. */
  failNextUpdate(model: ModelStatic<Model>, error: Error): this {
    this.updateError.set(model.name, error);
    return this;
  }

  async listAll<M extends Model>(model: ModelStatic<M>, options: FindOptions = {}): Promise<M[]> {
    this.record('listAll', model, options);
    const rows = (this.listRows.get(model.name) ?? []) as M[];
    const filtered = applyWhere(rows, (options as { where?: unknown }).where);
    const limit = (options as { limit?: number }).limit;
    return limit === undefined ? filtered : filtered.slice(0, limit);
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
    return row as M;
  }

  /** T-126 — `findOneOrFail` used by `TenantCurrenciesService`, which addresses a row entirely
   * through `options.where` (no separate `id` argument). Shares the same `byPk` map
   * `findByPkOrFail` reads from: this fake's fidelity has always been "one row per model", not
   * real `where`-clause evaluation (`applyWhere` above is the one exception, for `listAll`). */
  async findOneOrFail<M extends Model>(
    model: ModelStatic<M>,
    options: FindOptions = {},
  ): Promise<M> {
    this.record('findOneOrFail', model, options);
    const row = this.byPk.get(model.name);
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

    const error = this.updateError.get(model.name);
    if (error !== undefined) {
      this.updateError.delete(model.name);
      throw error;
    }

    const current = this.byPk.get(model.name);
    if (current !== undefined && current !== null && typeof current === 'object') {
      Object.assign(current, values as object);
    }
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

/**
 * A minimal, equality-only `where` filter — real filtering is `ScopedRepository`'s/Sequelize's
 * to prove (already exhaustively tested elsewhere). This exists only so a fake `listAll()` call
 * with a plain `{ column: value, ... }` clause — the only shape `TenantsService` ever builds —
 * behaves the way the real database would for this suite's "does a row already exist" checks
 * (`upsertBudgetCeiling`'s existing-row lookup). Anything not a plain object (an `Op.and`
 * symbol-keyed clause, for instance) is left unfiltered; nothing in this module builds one.
 */
function applyWhere<T>(rows: T[], where: unknown): T[] {
  if (where === null || typeof where !== 'object') return rows;
  const entries = Object.entries(where as Record<string, unknown>);
  if (entries.length === 0) return rows;
  return rows.filter((row) =>
    entries.every(([key, value]) => (row as Record<string, unknown>)[key] === value),
  );
}

/** A `Sequelize` whose only interesting behaviour is `.transaction()` — runs `fn` immediately,
 * with no real commit/rollback, since the fake repository never actually persists anything. */
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

/** A `CredentialService` whose `hash()` is deterministic and traceable. */
export class FakeCredentialService {
  readonly hashed: string[] = [];

  async hash(password: string): Promise<string> {
    this.hashed.push(password);
    return `argon2id-hash-of:${password}`;
  }
}

export function asCredentialService(fake: FakeCredentialService): CredentialService {
  return fake as unknown as CredentialService;
}

export interface RecordedCredentialCreate {
  readonly userId: number;
  readonly passwordHash: string;
  readonly passwordAlgo: string;
  readonly transaction: AuthTransaction | undefined;
}

/**
 * T-059 — a `CredentialProvisioner` double. `PortalUserCredential` is `deny()` for every scoped
 * role in `scope-strategy.ts`, so `provisionTenantAdmin` must not (and no longer does) reach it
 * through `FakeScopedRepository` above; this is the in-memory stand-in for the real route,
 * `CredentialRepository.createCredential` (`credential.repository.ts`).
 */
export class FakeCredentialProvisioner implements CredentialProvisioner {
  readonly created: RecordedCredentialCreate[] = [];
  private error: Error | undefined;

  /** The next `createCredential` call throws `error` instead of recording anything. */
  failNext(error: Error): this {
    this.error = error;
    return this;
  }

  async createCredential(
    userId: number,
    passwordHash: string,
    passwordAlgo: string,
    tx?: AuthTransaction,
  ): Promise<void> {
    if (this.error !== undefined) {
      const error = this.error;
      this.error = undefined;
      throw error;
    }
    this.created.push({ userId, passwordHash, passwordAlgo, transaction: tx });
  }
}

export function asCredentialProvisioner(fake: FakeCredentialProvisioner): CredentialProvisioner {
  return fake as unknown as CredentialProvisioner;
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

export interface RecordedRevocation {
  readonly userId: number;
  readonly reason: string;
  readonly exceptSessionId: string | null;
  readonly actor: { userId: number; role: string };
  readonly context: RequestContext;
  readonly eventType: string;
}

/** A `SessionService` that records every `revokeAllForUser` call instead of touching a store. */
export class FakeSessionService {
  readonly revocations: RecordedRevocation[] = [];
  revokedCountPerCall = 1;

  async revokeAllForUser(
    userId: number,
    reason: string,
    exceptSessionId: string | null,
    actor: { userId: number; role: string },
    context: RequestContext,
    eventType: string,
  ): Promise<number> {
    this.revocations.push({ userId, reason, exceptSessionId, actor, context, eventType });
    return this.revokedCountPerCall;
  }
}

export function asSessionService(fake: FakeSessionService): SessionService {
  return fake as unknown as SessionService;
}

/** A verified-JWT actor. Defaults to `country_admin` — the only role this module's writes admit. */
export function actor(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: 1,
    sessionId: '00000000-0000-4000-8000-000000000000',
    role: 'country_admin',
    countryId: 1,
    tenantId: null,
    merchantId: null,
    rbacVersion: 1,
    tokenId: '00000000-0000-4000-8000-000000000001',
    mustChangePassword: false,
    ...overrides,
  };
}

/** A `tenants` row shaped exactly as `toTenantDto` expects to read it. */
export function tenantRow(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 10,
    code: 'T001',
    name: 'A Tenant',
    countryId: 1,
    schemaPrefix: null,
    contactEmail: null,
    contactPhone: null,
    status: 'pending_provisioning',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as Tenant;
}

/** A `portal_users` row, reduced to the columns `provisionTenantAdmin` reads back. */
export function portalUserRow(overrides: Partial<PortalUser> = {}): PortalUser {
  return {
    id: 500,
    email: 'tenant.admin@example.invalid',
    displayName: 'A Tenant Admin',
    role: 'tenant_admin',
    // `1` — matches the `tenantRow({ id: 1, ... })` every `tenants.service.spec.ts` session-
    // revocation test uses; override explicitly if a test ever needs a different tenant.
    tenantId: 1,
    status: 'active',
    mustChangePassword: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as PortalUser;
}

/** A `tenant_budget_ceilings` row shaped exactly as `toBudgetCeilingDto` expects to read it. */
export function budgetCeilingRow(
  overrides: Partial<TenantBudgetCeiling> = {},
): TenantBudgetCeiling {
  return {
    id: 900,
    tenantId: 10,
    unitType: 'currency',
    unitCode: 'MYR',
    maxCampaignBudget: '5000000.0000',
    warnAboveAmount: '4000000.0000',
    status: 'active',
    createdBy: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as TenantBudgetCeiling;
}

/** T-143 — a `countries` row, reduced to the columns `insertTenant`'s default-currency lookup
 * reads (`currencyCode`), same shape `test/merchants/support/merchants-doubles.ts#countryRow`
 * already establishes. */
export function countryRow(overrides: Partial<Country> = {}): Country {
  return {
    id: 1,
    code: 'MY',
    name: 'Malaysia',
    timezone: 'Asia/Kuala_Lumpur',
    currencyCode: 'MYR',
    dialingCode: '+60',
    isHq: false,
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as Country;
}

/** A `tenant_currencies` row shaped exactly as `toTenantCurrencyDto` expects to read it. */
export function tenantCurrencyRow(overrides: Partial<TenantCurrency> = {}): TenantCurrency {
  return {
    id: 700,
    tenantId: 10,
    currencyCode: 'MYR',
    isDefault: true,
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as TenantCurrency;
}

export function requestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return { ipAddress: '127.0.0.1', userAgent: 'jest', ...overrides };
}
