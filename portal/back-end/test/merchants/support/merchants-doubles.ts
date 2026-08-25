/**
 * T-036 unit-test support — in-memory stand-ins for what `MerchantsService` depends on.
 *
 * Same reasoning as `test/tenants/support/tenants-doubles.ts` (T-034): the interesting behaviour
 * here is a set of *decisions* — which model, which `where`, which transaction, whether
 * `assertRole` fired before any query ran, which users got a session revocation call — not "the
 * real Postgres returned the right rows", which `common/scope/scope-strategy.ts` and
 * `ScopedRepository` are already exhaustively tested for (T-013, 100% branch coverage).
 */
import {
  Op,
  type CountOptions,
  type CreateOptions,
  type FindOptions,
  type Model,
  type ModelStatic,
  type Transaction,
  type UpdateOptions,
} from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { ScopeViolationError } from '@/common/scope/scope.exceptions';
import type { ScopedRepository } from '@/common/scope/scoped.repository';
import type { AuditService } from '@/common/audit/audit.service';
import type { AuditDraft } from '@/common/audit/audit-context';
import type { RequestContext, SessionService } from '@/modules/auth/services/session.service';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import type { Merchant } from '@/database/models/merchant.model';
import type { MerchantStore } from '@/database/models/merchant-store.model';
import type { MerchantActivity } from '@/database/models/merchant-activity.model';
import type { Tenant } from '@/database/models/tenant.model';
import type { Country } from '@/database/models/country.model';
import type { PortalUser } from '@/database/portal-models';

export interface RecordedCall {
  readonly method: string;
  readonly model: string;
  readonly options: unknown;
  readonly values?: unknown;
}

/**
 * A `ScopedRepository` that answers from memory. Same shape `FakeScopedRepository` in
 * `test/tenants/support/tenants-doubles.ts` establishes, including its `applyWhere` limitation
 * (plain-object equality only — nothing this module builds needs `Op.and`/`Op.or` matched by the
 * fake; `count`'s `where` and `listAll`'s `where` are asserted on the recorded call directly
 * where a suite needs to check a search clause was built, not filtered by the fake).
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

  failNextCreate(model: ModelStatic<Model>, error: Error): this {
    this.createError.set(model.name, error);
    return this;
  }

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
 * A minimal `where` filter — `tenants-doubles.ts`'s own copy is equality-only; this module's
 * `findActiveCampaigns` additionally builds an `{ id: { [Op.in]: [...] } }` clause
 * (`TenantCampaign` scoped by the participation rows' campaign ids), so this copy understands
 * `Op.in` too. Anything else non-plain (an `Op.and`/`Op.or` symbol-keyed clause, for instance) is
 * left unfiltered — `Object.entries` never sees a symbol key, the same limitation
 * `tenants-doubles.ts` documents.
 */
function applyWhere<T>(rows: T[], where: unknown): T[] {
  if (where === null || typeof where !== 'object') return rows;
  const entries = Object.entries(where as Record<string, unknown>);
  if (entries.length === 0) return rows;
  return rows.filter((row) =>
    entries.every(([key, value]) => matchesClause((row as Record<string, unknown>)[key], value)),
  );
}

function matchesClause(actual: unknown, expected: unknown): boolean {
  if (
    expected !== null &&
    typeof expected === 'object' &&
    Object.getOwnPropertySymbols(expected).includes(Op.in)
  ) {
    const allowed = (expected as Record<symbol, unknown>)[Op.in];
    return Array.isArray(allowed) && allowed.includes(actual);
  }
  return actual === expected;
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

/** A verified-JWT actor. Defaults to `tenant_admin` — the only role this module's writes admit. */
export function actor(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: 1,
    sessionId: '00000000-0000-4000-8000-000000000000',
    role: 'tenant_admin',
    countryId: 1,
    tenantId: 10,
    merchantId: null,
    rbacVersion: 1,
    tokenId: '00000000-0000-4000-8000-000000000001',
    mustChangePassword: false,
    ...overrides,
  };
}

/** A `tenants` row, reduced to the columns `assertCountryMatchesTenant` reads. */
export function tenantRow(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 10,
    code: 'T001',
    name: 'A Tenant',
    countryId: 1,
    schemaPrefix: null,
    contactEmail: null,
    contactPhone: null,
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as Tenant;
}

/** A `countries` row, reduced to the columns `assertCountryMatchesTenant` reads. */
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

/** A `merchants` row shaped exactly as `toMerchantDto` expects to read it. */
export function merchantRow(overrides: Partial<Merchant> = {}): Merchant {
  return {
    id: 100,
    tenantId: 10,
    merchantCode: 'M001',
    name: 'Acme Store',
    description: null,
    contactEmail: null,
    contactPhone: null,
    website: null,
    countryCode: 'MY',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as Merchant;
}

/** A `merchant_stores` row shaped exactly as `toMerchantStoreDto` expects to read it. */
export function merchantStoreRow(overrides: Partial<MerchantStore> = {}): MerchantStore {
  return {
    id: 200,
    tenantId: 10,
    merchantId: 100,
    storeCode: 'S001',
    name: 'Main Store',
    address: null,
    city: null,
    state: null,
    postalCode: null,
    region: null,
    latitude: null,
    longitude: null,
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as MerchantStore;
}

/** A `merchant_activities` row shaped exactly as `toMerchantActivityDto` expects to read it. */
export function merchantActivityRow(overrides: Partial<MerchantActivity> = {}): MerchantActivity {
  return {
    id: 300,
    tenantId: 10,
    merchantId: 100,
    activityId: 50,
    storeId: null,
    commissionRate: null,
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as MerchantActivity;
}

/** A `portal_users` row, reduced to the columns `revokeSessionsForMerchant` reads back. */
export function portalUserRow(overrides: Partial<PortalUser> = {}): PortalUser {
  return {
    id: 500,
    email: 'merchant.user@example.invalid',
    displayName: 'A Merchant User',
    role: 'merchant',
    tenantId: 10,
    merchantId: 100,
    status: 'active',
    mustChangePassword: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as PortalUser;
}

export function requestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return { ipAddress: '127.0.0.1', userAgent: 'jest', ...overrides };
}
