/**
 * T-035 unit-test support — in-memory stand-ins for what `UsersService` depends on.
 *
 * Same reasoning as `test/tenants/support/tenants-doubles.ts` (T-034), which this file is a
 * deliberate, near-identical copy of (that file's own header cites the same precedent from
 * `test/countries/support/countries-doubles.ts`, T-030): the interesting behaviour here is a set
 * of *decisions* — which model, which `where`, which transaction, whether the creation matrix
 * fired before any query ran, which users got a session revocation call — not "the real Postgres
 * returned the right rows", which `common/scope/scope-strategy.ts` and `ScopedRepository` are
 * already exhaustively tested for (T-013, 100% branch coverage).
 *
 * Extended beyond the tenants copy in two ways this module's own service needs:
 *
 *  - `FakeCredentialService.changePassword()` — `UsersService.resetPassword()` reuses
 *    `CredentialService.changePassword()` rather than a bespoke hash-and-replace path (that
 *    method's own header explains why).
 *  - `FakeSequelize.query()` — `UsersService.insertCredential()` is raw, parameterised SQL, not
 *    `ScopedRepository`, because `PortalUserCredential`'s declared scope strategy denies every
 *    role (`users.service.ts`'s own header, "A real bug this task's implementation does not
 *    repeat").
 */
import type {
  CountOptions,
  CreateOptions,
  FindOptions,
  Model,
  ModelStatic,
  QueryOptions,
  Transaction,
  UpdateOptions,
} from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { ScopeViolationError } from '@/common/scope/scope.exceptions';
import type { ScopedRepository } from '@/common/scope/scoped.repository';
import type { AuditService, PortalAuditEventInput } from '@/common/audit/audit.service';
import type { AuditDraft } from '@/common/audit/audit-context';
import type {
  ChangePasswordInput,
  CredentialService,
} from '@/modules/auth/services/credential.service';
import type { RequestContext, SessionService } from '@/modules/auth/services/session.service';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import type { Country, Merchant, Tenant } from '@/database/models';
import type { PortalUser } from '@/database/portal-models';
import type {
  IssuedTemporaryPassword,
  TemporaryPasswordService,
} from '@/modules/users/services/temporary-password.service';

export interface RecordedCall {
  readonly method: string;
  readonly model: string;
  readonly options: unknown;
  readonly values?: unknown;
}

export interface RecordedQuery {
  readonly sql: string;
  readonly options: unknown;
}

/**
 * A `ScopedRepository` that answers from memory. Same shape and same `update()`-merges-into-
 * `byPk` behaviour `tenants-doubles.ts`'s own header documents.
 */
export class FakeScopedRepository {
  readonly calls: RecordedCall[] = [];

  private readonly listRows = new Map<string, unknown[]>();
  private readonly counts = new Map<string, number>();
  private readonly byPk = new Map<string, unknown>();
  private readonly createError = new Map<string, Error>();

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
    const rows = (this.listRows.get(model.name) ?? []) as M[];
    const limit = (options as { limit?: number }).limit;
    return limit === undefined ? rows : rows.slice(0, limit);
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
    const row = { id: 500, createdAt: now, updatedAt: now, ...(values as object) };

    // T-101: a caller that reloads via `findByPkOrFail` immediately after `create()` (the fix for
    // the ciphertext-leak defect — `create()`'s raw insert result never goes through the
    // `afterFind` hook that decrypts `email`) should see the same row by default, mirroring the
    // real `ScopedRepository`'s behaviour of returning what was just persisted. Left untouched
    // when a test has already called `setByPk` *before* invoking the service: that pre-seeded row
    // stands in for "the database already holds a value distinct from whatever the insert's own
    // return carried" — see `users.service.spec.ts`'s T-101 regression test, the one case that
    // needs the two to differ.
    if (!this.byPk.has(model.name)) this.byPk.set(model.name, row);

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

/** A `Sequelize` whose only interesting behaviour is `.transaction()`/`.query()` — runs `fn`
 * immediately, with no real commit/rollback, and records every raw `query()` call so
 * `insertCredential()`'s SQL can be asserted without a database. */
export class FakeSequelize {
  transactionCalls = 0;
  readonly queries: RecordedQuery[] = [];

  async transaction<T>(fn: (transaction: Transaction) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    return fn({} as Transaction);
  }

  async query(sql: string, options?: QueryOptions): Promise<unknown> {
    this.queries.push({ sql, options });
    return [];
  }
}

export function asSequelize(fake: FakeSequelize): Sequelize {
  return fake as unknown as Sequelize;
}

/** A `CredentialService` whose `hash()`/`changePassword()` are deterministic and traceable. */
export class FakeCredentialService {
  readonly hashed: string[] = [];
  readonly changePasswordCalls: ChangePasswordInput[] = [];
  changePasswordError: Error | null = null;

  async hash(password: string): Promise<string> {
    this.hashed.push(password);
    return `argon2id-hash-of:${password}`;
  }

  async changePassword(input: ChangePasswordInput): Promise<void> {
    this.changePasswordCalls.push(input);
    if (this.changePasswordError !== null) throw this.changePasswordError;
  }
}

export function asCredentialService(fake: FakeCredentialService): CredentialService {
  return fake as unknown as CredentialService;
}

/** An `AuditService` that records what a service annotated, or a `portal_audit_log` row
 * requested, instead of writing either. T-046 extends this beyond `annotate()` (T-035): the
 * `temporary_password_issued` row `TemporaryPasswordService.recordIssued()` writes goes through
 * `recordPortalEvent`, never `annotate()` — see that service's own header for why the two are
 * deliberately separate calls, mirroring `reveal.service.ts`'s request-row/disclosure-row split. */
export class FakeAuditService {
  readonly annotations: AuditDraft[] = [];
  readonly portalEvents: PortalAuditEventInput[] = [];

  annotate(patch: AuditDraft): void {
    this.annotations.push(patch);
  }

  async recordPortalEvent(event: PortalAuditEventInput): Promise<void> {
    this.portalEvents.push(event);
  }
}

export function asAuditService(fake: FakeAuditService): AuditService {
  return fake as unknown as AuditService;
}

/** A `TemporaryPasswordService` (T-046) whose `generate()`/`recordIssued()`/`setCredentialExpiry()`
 * are deterministic and traceable — the same "in-memory stand-in for a decision, not a database"
 * shape every other fake in this file follows. `UsersService`'s own unit tests use this one;
 * `TemporaryPasswordService`'s own behaviour (rate limiting, the real expiry math, the real audit
 * event shape) is exercised directly, against the real class, in `temporary-password.spec.ts`. */
export class FakeTemporaryPasswordService {
  nextPassword = 'Xy9!kLmnpQ2*Zvwr4Tabcd7A';
  nextExpiresAt = new Date('2026-01-04T00:00:00.000Z');
  generateError: Error | null = null;

  readonly generateCalls: AuthenticatedUser[] = [];
  readonly issued: Array<{ actor: AuthenticatedUser; targetUserId: number }> = [];
  readonly expirySets: Array<{ userId: number; expiresAt: Date }> = [];

  async generate(actor: AuthenticatedUser): Promise<IssuedTemporaryPassword> {
    this.generateCalls.push(actor);
    if (this.generateError !== null) throw this.generateError;
    return { password: this.nextPassword, expiresAt: this.nextExpiresAt };
  }

  async recordIssued(actor: AuthenticatedUser, targetUserId: number): Promise<void> {
    this.issued.push({ actor, targetUserId });
  }

  async setCredentialExpiry(userId: number, expiresAt: Date): Promise<void> {
    this.expirySets.push({ userId, expiresAt });
  }
}

export function asTemporaryPasswordService(
  fake: FakeTemporaryPasswordService,
): TemporaryPasswordService {
  return fake as unknown as TemporaryPasswordService;
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

/** A verified-JWT actor. Defaults to `tenant_admin` — this module's most common creating role. */
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

/** A `portal_users` row shaped exactly as `toUserDto` expects to read it. */
export function portalUserRow(overrides: Partial<PortalUser> = {}): PortalUser {
  return {
    id: 500,
    email: 'new.user@example.invalid',
    displayName: 'A New User',
    role: 'maker',
    countryId: 1,
    tenantId: 10,
    merchantId: null,
    status: 'active',
    mustChangePassword: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as PortalUser;
}

/** A `countries` row, reduced to what `deriveTargetScope`'s existence check reads. */
export function countryRow(overrides: Partial<Country> = {}): Country {
  return { id: 1, code: 'MY', name: 'Malaysia', ...overrides } as unknown as Country;
}

/** A `tenants` row, reduced to what `deriveTargetScope`'s scope check reads. */
export function tenantRow(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 10,
    code: 'T001',
    name: 'A Tenant',
    countryId: 1,
    ...overrides,
  } as unknown as Tenant;
}

/** A `merchants` row, reduced to what `deriveTargetScope`'s scope check reads. */
export function merchantRow(overrides: Partial<Merchant> = {}): Merchant {
  return {
    id: 20,
    tenantId: 10,
    merchantCode: 'M001',
    name: 'A Merchant',
    ...overrides,
  } as unknown as Merchant;
}

export function requestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return { ipAddress: '127.0.0.1', userAgent: 'jest', ...overrides };
}
