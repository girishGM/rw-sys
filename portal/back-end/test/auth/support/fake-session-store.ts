/**
 * T-011 unit-test support — an in-memory `SessionStore`.
 *
 * **What this double is for.** The session layer's security properties are decisions, not SQL:
 * which branch a replayed token takes, whether the whole family is revoked before the caller is
 * told "no", whether refresh re-reads the user row, whether a rejected reset token leaves the
 * link usable. Driving those from memory makes every branch the 100% coverage bar demands
 * reachable deterministically, including the two that a real database will not produce on demand
 * (a row consumed between the lock and the update, and an audit write that fails).
 *
 * **What it is not for.** It is no evidence that the SQL in `session.repository.ts` is correct —
 * it never sees that SQL. `session.repository.spec.ts` covers the statement shapes against a
 * stubbed Sequelize, and `auth.e2e-spec.ts` exercises the whole thing against the real Postgres
 * instance, including the `FOR UPDATE` locking this fake cannot model. All three are required;
 * none substitutes for another.
 *
 * Rows are stored mutably and handed out as copies, exactly as `FakeCredentialStore` does, so a
 * service that forgets to write a change back cannot appear to work because it mutated the
 * store's own object in place.
 */
import { randomUUID } from 'node:crypto';
import type { AuthTransaction, AuthUserRow } from '@/modules/auth/services/credential.repository';
import type {
  AuditEventInput,
  CreateRefreshTokenInput,
  CreateSessionInput,
  PasswordResetRow,
  RefreshTokenRow,
  SessionContextRow,
  SessionRow,
  SessionStore,
} from '@/modules/auth/services/session.repository';
import type { PortalRole } from '@/database/portal-models';

interface StoredSession {
  id: string;
  userId: number;
  status: string;
  ipAddress: string | null;
  userAgent: string | null;
  issuedAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

interface StoredRefreshToken {
  id: string;
  sessionId: string;
  userId: number;
  tokenHash: string;
  parentTokenId: string | null;
  status: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface StoredPasswordReset {
  id: string;
  userId: number;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export class FakeSessionStore implements SessionStore {
  readonly sessions: StoredSession[] = [];
  readonly refreshTokens: StoredRefreshToken[] = [];
  readonly passwordResets: StoredPasswordReset[] = [];
  readonly users: AuthUserRow[] = [];
  readonly auditEvents: AuditEventInput[] = [];
  readonly lastLogins: { userId: number; at: Date }[] = [];

  /** `rbac_version:<role>` values. Absent role ⇒ the repository's `0` fallback. */
  readonly rbacVersions = new Map<string, number>();

  /**
   * Users treated as soft-deleted: `findSessionContext` reports `user_deleted`, and
   * `findUserById` returns nothing, mirroring the real repository's `deleted_at IS NULL`
   * predicate. Deleting from {@link users} outright would model a *hard* delete, which the
   * schema does not do and which would exercise a different branch.
   */
  readonly deletedUserIds = new Set<number>();

  /**
   * `tenants.status` / `merchants.status` by id — the two `LEFT JOIN`s T-013 (AR-10) added to
   * `findSessionContext`.
   *
   * Modelled as maps keyed by id, and read only when the user actually carries that foreign key,
   * so the fake reproduces the property that matters: a user with a `NULL` `tenant_id` (every
   * `super_admin`) yields `null`, not a lookup failure. An absent entry for an id the user *does*
   * reference also yields `null`, which mirrors the LEFT JOIN finding no row — a state the
   * `ON DELETE RESTRICT` foreign keys make unreachable in the real schema, but which the guard
   * must not crash on.
   */
  readonly tenantStatuses = new Map<number, string>();
  readonly merchantStatuses = new Map<number, string>();

  /** Set to make {@link writeAuditEvent} throw, for the "audit outage" branch. */
  auditWriteFails = false;

  /** Set to make {@link markRefreshTokenConsumed} report a lost race, for the fail-closed branch. */
  refreshConsumeLosesRace = false;

  /** Set to make {@link markPasswordResetConsumed} report a lost race, for the same reason. */
  resetConsumeLosesRace = false;

  private nextUserId = 1;

  /**
   * An explicit `id` is honoured, and the sequence is advanced past it.
   *
   * That matters because the production code sees `portal_users` through *two* repositories —
   * this one and `CredentialStore` — which in a test are two independent fakes. If their id
   * sequences drift, a test can accidentally give two different accounts the same id, and every
   * ownership assertion in the suite (TC-24, TC-25) silently starts passing for the wrong reason.
   */
  seedUser(overrides: Partial<AuthUserRow> = {}): AuthUserRow {
    const id = overrides.id ?? this.nextUserId;
    if (id >= this.nextUserId) this.nextUserId = id + 1;

    const user: AuthUserRow = {
      id,
      email: `user${this.nextUserId}@example.com`,
      displayName: 'Seeded User',
      role: 'maker',
      status: 'active',
      countryId: 1,
      tenantId: 7,
      merchantId: null,
      mustChangePassword: false,
      mfaEnabled: false,
      ...overrides,
    };
    this.users.push(user);
    return user;
  }

  /** Reads the live session row — assert against this, never against a returned copy. */
  sessionFor(id: string): StoredSession {
    const session = this.sessions.find((s) => s.id === id);
    if (session === undefined) throw new Error(`FakeSessionStore has no session ${id}`);
    return session;
  }

  tokenFor(id: string): StoredRefreshToken {
    const token = this.refreshTokens.find((t) => t.id === id);
    if (token === undefined) throw new Error(`FakeSessionStore has no refresh token ${id}`);
    return token;
  }

  tokensForSession(sessionId: string): StoredRefreshToken[] {
    return this.refreshTokens.filter((t) => t.sessionId === sessionId);
  }

  eventsOfType(eventType: string): AuditEventInput[] {
    return this.auditEvents.filter((event) => event.eventType === eventType);
  }

  async createSession(input: CreateSessionInput, _tx?: AuthTransaction): Promise<SessionRow> {
    const session: StoredSession = {
      id: randomUUID(),
      userId: input.userId,
      status: 'active',
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      issuedAt: input.issuedAt,
      lastSeenAt: input.issuedAt,
      expiresAt: input.expiresAt,
      revokedAt: null,
      revokedReason: null,
    };
    this.sessions.push(session);
    return { ...session };
  }

  async insertRefreshToken(input: CreateRefreshTokenInput, _tx?: AuthTransaction): Promise<string> {
    const token: StoredRefreshToken = {
      id: randomUUID(),
      sessionId: input.sessionId,
      userId: input.userId,
      tokenHash: input.tokenHash,
      parentTokenId: input.parentTokenId,
      status: 'active',
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      consumedAt: null,
    };
    this.refreshTokens.push(token);
    return token.id;
  }

  async lockRefreshTokenByHash(
    tokenHash: string,
    _tx: AuthTransaction,
  ): Promise<RefreshTokenRow | null> {
    const token = this.refreshTokens.find((t) => t.tokenHash === tokenHash);
    if (token === undefined) return null;

    // Field by field rather than a rest-spread, so `token_hash` is absent from the returned
    // shape for the same reason it is absent from the real repository's SELECT list: it is not
    // omitted by accident of destructuring, it is never put there in the first place.
    return {
      id: token.id,
      sessionId: token.sessionId,
      userId: token.userId,
      status: token.status,
      issuedAt: token.issuedAt,
      expiresAt: token.expiresAt,
      consumedAt: token.consumedAt,
    };
  }

  async markRefreshTokenConsumed(id: string, at: Date, _tx: AuthTransaction): Promise<boolean> {
    if (this.refreshConsumeLosesRace) return false;
    const token = this.refreshTokens.find((t) => t.id === id && t.status === 'active');
    if (token === undefined) return false;
    token.status = 'consumed';
    token.consumedAt = at;
    return true;
  }

  async revokeRefreshTokenFamily(sessionId: string, _tx?: AuthTransaction): Promise<number> {
    let revoked = 0;
    for (const token of this.refreshTokens) {
      if (token.sessionId !== sessionId || token.status === 'revoked') continue;
      token.status = 'revoked';
      revoked += 1;
    }
    return revoked;
  }

  async revokeRefreshTokensForUser(
    userId: number,
    exceptSessionId: string | null,
    _tx?: AuthTransaction,
  ): Promise<number> {
    let revoked = 0;
    for (const token of this.refreshTokens) {
      if (token.userId !== userId || token.status === 'revoked') continue;
      if (exceptSessionId !== null && token.sessionId === exceptSessionId) continue;
      token.status = 'revoked';
      revoked += 1;
    }
    return revoked;
  }

  async revokeSession(sessionId: string, reason: string, _tx?: AuthTransaction): Promise<number> {
    const session = this.sessions.find((s) => s.id === sessionId && s.status === 'active');
    if (session === undefined) return 0;
    session.status = 'revoked';
    session.revokedAt = new Date();
    session.revokedReason = reason;
    return 1;
  }

  async revokeSessionsForUser(
    userId: number,
    reason: string,
    exceptSessionId: string | null,
    _tx?: AuthTransaction,
  ): Promise<number> {
    let revoked = 0;
    for (const session of this.sessions) {
      if (session.userId !== userId || session.status !== 'active') continue;
      if (exceptSessionId !== null && session.id === exceptSessionId) continue;
      session.status = 'revoked';
      session.revokedAt = new Date();
      session.revokedReason = reason;
      revoked += 1;
    }
    return revoked;
  }

  async findSessionContext(
    sessionId: string,
    _tx?: AuthTransaction,
  ): Promise<SessionContextRow | null> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (session === undefined) return null;

    const user = this.users.find((u) => u.id === session.userId);
    if (user === undefined) return null;

    return {
      sessionId: session.id,
      sessionStatus: session.status,
      sessionExpiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
      userId: user.id,
      userStatus: user.status,
      userDeleted: this.deletedUserIds.has(user.id),
      mustChangePassword: user.mustChangePassword,
      role: user.role,
      tenantStatus:
        user.tenantId === null ? null : (this.tenantStatuses.get(user.tenantId) ?? null),
      merchantStatus:
        user.merchantId === null ? null : (this.merchantStatuses.get(user.merchantId) ?? null),
    };
  }

  async touchSession(sessionId: string, at: Date, _tx?: AuthTransaction): Promise<void> {
    const session = this.sessions.find((s) => s.id === sessionId && s.status === 'active');
    if (session === undefined) return;
    session.lastSeenAt = at;
  }

  async listSessionsForUser(userId: number, now: Date): Promise<SessionRow[]> {
    return this.sessions
      .filter(
        (s) =>
          s.userId === userId && s.status === 'active' && s.expiresAt.getTime() > now.getTime(),
      )
      .map((s) => ({ ...s }));
  }

  async findSessionForUser(sessionId: string, userId: number): Promise<SessionRow | null> {
    const session = this.sessions.find((s) => s.id === sessionId && s.userId === userId);
    return session === undefined ? null : { ...session };
  }

  async findUserById(userId: number): Promise<AuthUserRow | null> {
    if (this.deletedUserIds.has(userId)) return null;
    const user = this.users.find((u) => u.id === userId);
    return user === undefined ? null : { ...user };
  }

  async findActiveUserIdByEmail(email: string): Promise<number | null> {
    const normalised = email.trim().toLowerCase();
    const user = this.users.find(
      (u) => u.email.trim().toLowerCase() === normalised && u.status === 'active',
    );
    return user === undefined ? null : user.id;
  }

  async recordLastLogin(userId: number, at: Date, _tx?: AuthTransaction): Promise<void> {
    this.lastLogins.push({ userId, at });
  }

  async setMustChangePassword(
    userId: number,
    value: boolean,
    _tx?: AuthTransaction,
  ): Promise<void> {
    const index = this.users.findIndex((u) => u.id === userId);
    if (index === -1) return;
    this.users[index] = { ...this.users[index], mustChangePassword: value };
  }

  async createPasswordReset(
    userId: number,
    tokenHash: string,
    expiresAt: Date,
    _tx?: AuthTransaction,
  ): Promise<string> {
    const reset: StoredPasswordReset = {
      id: randomUUID(),
      userId,
      tokenHash,
      expiresAt,
      consumedAt: null,
    };
    this.passwordResets.push(reset);
    return reset.id;
  }

  async lockPasswordResetByHash(
    tokenHash: string,
    _tx: AuthTransaction,
  ): Promise<PasswordResetRow | null> {
    const reset = this.passwordResets.find((r) => r.tokenHash === tokenHash);
    if (reset === undefined) return null;

    // Same discipline as `lockRefreshTokenByHash`: the digest never leaves this store.
    return {
      id: reset.id,
      userId: reset.userId,
      expiresAt: reset.expiresAt,
      consumedAt: reset.consumedAt,
    };
  }

  async markPasswordResetConsumed(id: string, at: Date, _tx: AuthTransaction): Promise<boolean> {
    if (this.resetConsumeLosesRace) return false;
    const reset = this.passwordResets.find((r) => r.id === id && r.consumedAt === null);
    if (reset === undefined) return false;
    reset.consumedAt = at;
    return true;
  }

  async readRbacVersion(role: PortalRole): Promise<number> {
    return this.rbacVersions.get(role) ?? 0;
  }

  async writeAuditEvent(event: AuditEventInput, _tx?: AuthTransaction): Promise<void> {
    if (this.auditWriteFails) throw new Error('portal_audit_log is unavailable');
    this.auditEvents.push(event);
  }

  /**
   * Runs the callback with a stub handle. **Does not model rollback** — that is deliberate: a
   * fake that silently undid writes would make the "the transaction must commit before the
   * rejection is raised" argument in `session.service.ts` untestable, because both the correct
   * and the incorrect implementation would look identical here. Rollback semantics are proven
   * against the real database in `auth.e2e-spec.ts`.
   */
  async runInTransaction<T>(fn: (tx: AuthTransaction) => Promise<T>): Promise<T> {
    return fn({ id: 'fake-tx' } as unknown as AuthTransaction);
  }
}
