/**
 * T-030 unit-test support — in-memory stand-ins for what `CountriesService` depends on.
 *
 * Same reasoning as `test/me/support/me-doubles.ts` (T-015): the interesting behaviour here is a
 * set of *decisions* (which model, which `where`, which transaction, whether `assertRole` fired
 * before any query ran at all) — not "the real Postgres returned the right rows", which
 * `common/scope/scope-strategy.ts` and `ScopedRepository` are already exhaustively tested for
 * (100% branch coverage, T-013's own bar) and which this task does not need to re-prove.
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
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import type { Country } from '@/database/models/country.model';
import type { Tenant } from '@/database/models/tenant.model';
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
 * this is what lets `CountriesService.update()`'s second `findByPkOrFail` (the "read back what
 * was just written" call) observe the change, without a second fixture to keep in sync by hand.
 */
export class FakeScopedRepository {
  readonly calls: RecordedCall[] = [];

  private readonly listRows = new Map<string, unknown[]>();
  private readonly counts = new Map<string, number>();
  private readonly byPk = new Map<string, unknown>();
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

/** A `countries` row shaped exactly as `toCountryDto` expects to read it. */
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

/** A `tenants` row shaped exactly as `toCountryTenantSummaryDto` expects to read it. */
export function tenantRow(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 10,
    code: 'T001',
    name: 'A Tenant',
    countryId: 1,
    status: 'active',
    ...overrides,
  } as unknown as Tenant;
}

/** A `portal_users` row, reduced to the columns `provisionCountryAdmin` reads back. */
export function portalUserRow(overrides: Partial<PortalUser> = {}): PortalUser {
  return {
    id: 500,
    email: 'country.admin@example.invalid',
    displayName: 'A Country Admin',
    role: 'country_admin',
    countryId: 1,
    status: 'active',
    mustChangePassword: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as PortalUser;
}
