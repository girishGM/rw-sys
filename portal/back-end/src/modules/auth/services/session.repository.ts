/**
 * T-011 — the session layer's only door to the database.
 *
 * ### Why this file exists (and is an addition to T-011's declared "Files owned")
 *
 * Exactly the reasoning `credential.repository.ts` sets out for T-010, applied to the second
 * half of the auth module, and worth restating because the alternative is tempting:
 *
 *  1. **`SessionService` stays a decision-maker.** Rotation, reuse detection and revocation are
 *     *rules*; which SQL expresses them is not. Keeping them apart is what lets every branch of
 *     those rules — including the ones that are hard to provoke against a real database, like
 *     "the row vanished between the lock and the update" — be driven deterministically from a
 *     fake, which is what the 100% coverage bar on this module actually requires.
 *  2. **Raw SQL lives in one readable file** rather than being scattered across a service, a
 *     controller and three guards.
 *  3. **T-013's `no-raw-model-access` lint rule gets one narrow path to reason about.**
 *
 * ### Why this is not `ScopedRepository`
 *
 * `ScopedRepository` (T-013) injects the actor's country/tenant/merchant triple into every
 * WHERE clause from the request's `ScopeContext`, and throws when that context is absent.
 * Sessions are not scoped data and cannot be:
 *
 *  - `SessionValidGuard` runs *before* the interceptor that populates `ScopeContext` — the
 *    scope is derived from the very token this guard is validating, so requiring it here would
 *    be circular;
 *  - `POST /auth/refresh` and `POST /auth/reset-password` are `@Public()` and have no actor at
 *    all until their token has been checked;
 *  - a session row is keyed by an unguessable server-minted UUID and is filtered by `user_id`
 *    in every statement below that a caller can influence, which is the same protection scoping
 *    provides, expressed directly.
 *
 * So the access is raw, parameterised SQL through the shared `Sequelize` instance — the same
 * convention `credential.repository.ts`, `key-registry.service.ts` and every migration already
 * follow, and deliberately **not** `PortalSession.findOne()`, because T-013's lint rule bans
 * model statics outside `src/common/scope/` and `src/database/` and this file must pass it with
 * no `eslint-disable` (R2).
 *
 * ### One precise statement about interpolation, because "no concatenation" is too coarse
 *
 * **Every caller-supplied value below is a bound replacement.** Several of these statements
 * take a value straight from a cookie or a URL segment, and not one of them is ever spliced
 * into SQL text.
 *
 * The *only* interpolated values are the frozen status literals from `session.constants.ts`
 * (`'active'`, `'consumed'`, `'revoked'`) — module constants that no request can influence.
 * They are interpolated rather than bound on purpose: `ix_portal_sessions_user` and
 * `ix_portal_sessions_expiry` are **partial** indexes with a `WHERE status = 'active'`
 * predicate, and Postgres can only prove a query matches a partial index when the predicate
 * compares against a literal. Binding `:status` here would silently drop the session lookup —
 * a per-request query — onto a sequential scan. If a future edit ever needs a *variable* status
 * in one of these statements, bind it; do not extend this exception to it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import type { PortalRole } from '@/database/portal-models';
import { REFRESH_TOKEN_STATUS, SESSION_STATUS } from '../session.constants';
import type { AuthTransaction, AuthUserRow } from './credential.repository';

/** A `portal_sessions` row, as the "your sessions" screen and the guards need it. */
export interface SessionRow {
  readonly id: string;
  readonly userId: number;
  readonly status: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly issuedAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
}

/** A `portal_refresh_tokens` row. The `token_hash` column is never selected — see below. */
export interface RefreshTokenRow {
  readonly id: string;
  readonly sessionId: string;
  readonly userId: number;
  readonly status: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

/**
 * Everything `SessionValidGuard` needs, in **one** query per request.
 *
 * The user half is joined rather than assumed from the token because that is what makes
 * "deactivate a user" take effect on their next request (TC-17) instead of at the end of the
 * access token's 15 minutes. `mustChangePassword` is read live for the same reason: it is not a
 * JWT claim, so clearing it takes effect immediately (TC-20) rather than at the next refresh.
 */
export interface SessionContextRow {
  readonly sessionId: string;
  readonly sessionStatus: string;
  readonly sessionExpiresAt: Date;
  readonly lastSeenAt: Date;
  readonly userId: number;
  readonly userStatus: string;
  readonly userDeleted: boolean;
  readonly mustChangePassword: boolean;
  readonly role: PortalRole;
  /**
   * `tenants.status` for the session owner's tenant, or `null` when the user has no tenant
   * (`super_admin`, `country_admin`) — T-013 implementation note 9, architect review AR-10.
   *
   * `null` means "no parent to check", **not** "check passed": the two are distinguished by the
   * `null` itself, and `SessionService.isUsableSession` treats any non-`active` non-`null` value
   * as a revocation. A missing tenant row would also produce `null` here, but cannot occur —
   * `portal_users.tenant_id` is `ON DELETE RESTRICT` against `tenants` (01-DATABASE.md §2.1).
   */
  readonly tenantStatus: string | null;
  /** `merchants.status` for the session owner's merchant, or `null`. Same semantics. */
  readonly merchantStatus: string | null;
}

export interface PasswordResetRow {
  readonly id: string;
  readonly userId: number;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface CreateSessionInput {
  readonly userId: number;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface CreateRefreshTokenInput {
  readonly sessionId: string;
  readonly userId: number;
  readonly tokenHash: string;
  readonly parentTokenId: string | null;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/** One `portal_audit_log` row. `detail` must already be redacted by the caller. */
export interface AuditEventInput {
  readonly eventType: string;
  readonly actorId: number | null;
  readonly actorRole: string | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly countryId: number | null;
  readonly tenantId: number | null;
  readonly ipAddress: string | null;
  readonly detail: Record<string, unknown> | null;
}

/**
 * The port the session layer depends on. Declared as an interface so `SessionService` and the
 * guards can be unit-tested against an in-memory double, and so the storage could be replaced
 * without touching a line of the rules above it.
 */
export interface SessionStore {
  createSession(input: CreateSessionInput, tx?: AuthTransaction): Promise<SessionRow>;
  insertRefreshToken(input: CreateRefreshTokenInput, tx?: AuthTransaction): Promise<string>;
  /** Locks the row for the duration of `tx`; see `SessionService.rotateRefreshToken`. */
  lockRefreshTokenByHash(tokenHash: string, tx: AuthTransaction): Promise<RefreshTokenRow | null>;
  markRefreshTokenConsumed(id: string, at: Date, tx: AuthTransaction): Promise<boolean>;
  revokeRefreshTokenFamily(sessionId: string, tx?: AuthTransaction): Promise<number>;
  revokeRefreshTokensForUser(
    userId: number,
    exceptSessionId: string | null,
    tx?: AuthTransaction,
  ): Promise<number>;
  revokeSession(sessionId: string, reason: string, tx?: AuthTransaction): Promise<number>;
  revokeSessionsForUser(
    userId: number,
    reason: string,
    exceptSessionId: string | null,
    tx?: AuthTransaction,
  ): Promise<number>;
  findSessionContext(sessionId: string, tx?: AuthTransaction): Promise<SessionContextRow | null>;
  touchSession(sessionId: string, at: Date, tx?: AuthTransaction): Promise<void>;
  listSessionsForUser(userId: number, now: Date): Promise<SessionRow[]>;
  findSessionForUser(sessionId: string, userId: number): Promise<SessionRow | null>;
  findUserById(userId: number): Promise<AuthUserRow | null>;
  findActiveUserIdByEmail(email: string): Promise<number | null>;
  recordLastLogin(userId: number, at: Date, tx?: AuthTransaction): Promise<void>;
  setMustChangePassword(userId: number, value: boolean, tx?: AuthTransaction): Promise<void>;
  createPasswordReset(
    userId: number,
    tokenHash: string,
    expiresAt: Date,
    tx?: AuthTransaction,
  ): Promise<string>;
  lockPasswordResetByHash(tokenHash: string, tx: AuthTransaction): Promise<PasswordResetRow | null>;
  markPasswordResetConsumed(id: string, at: Date, tx: AuthTransaction): Promise<boolean>;
  readRbacVersion(role: PortalRole): Promise<number>;
  writeAuditEvent(event: AuditEventInput, tx?: AuthTransaction): Promise<void>;
  runInTransaction<T>(fn: (tx: AuthTransaction) => Promise<T>): Promise<T>;
}

/** DI token — every consumer depends on {@link SessionStore}, never on the class below. */
export const SESSION_STORE = Symbol('SESSION_STORE');

interface RawSessionRow {
  id: string;
  user_id: number;
  status: string;
  ip_address: string | null;
  user_agent: string | null;
  issued_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
}

interface RawRefreshTokenRow {
  id: string;
  session_id: string;
  user_id: number;
  status: string;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

interface RawSessionContextRow {
  session_id: string;
  session_status: string;
  session_expires_at: Date;
  last_seen_at: Date;
  user_id: number;
  user_status: string;
  user_deleted: boolean;
  must_change_password: boolean;
  role: PortalRole;
  tenant_status: string | null;
  merchant_status: string | null;
}

interface RawUserRow {
  id: number;
  email: string;
  display_name: string;
  role: PortalRole;
  status: string;
  country_id: number | null;
  tenant_id: number | null;
  merchant_id: number | null;
  must_change_password: boolean;
  mfa_enabled: boolean;
}

interface RawPasswordResetRow {
  id: string;
  user_id: number;
  expires_at: Date;
  consumed_at: Date | null;
}

@Injectable()
export class SessionRepository implements SessionStore {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    /** T-056 — see `credential.repository.ts`'s constructor for why this is here. */
    private readonly emailCrypto: PortalUserEmailCrypto,
  ) {}

  async createSession(input: CreateSessionInput, tx?: AuthTransaction): Promise<SessionRow> {
    // `id` is left to `gen_random_uuid()`: the session identifier is minted by the database,
    // never proposed by the client and never derived from anything the client controls
    // (02-SECURITY.md §2, "the session id is minted server-side").
    const rows = await this.sequelize.query<RawSessionRow>(
      `
      INSERT INTO reward_portal.portal_sessions
             (user_id, status, ip_address, user_agent, issued_at, last_seen_at, expires_at)
      VALUES (:userId, '${SESSION_STATUS.ACTIVE}', CAST(:ipAddress AS inet), :userAgent,
              :issuedAt, :issuedAt, :expiresAt)
      RETURNING id, user_id, status, ip_address, user_agent,
                issued_at, last_seen_at, expires_at, revoked_at, revoked_reason
      `,
      {
        type: QueryTypes.SELECT,
        transaction: tx,
        replacements: {
          userId: input.userId,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          issuedAt: input.issuedAt,
          expiresAt: input.expiresAt,
        },
      },
    );

    return toSessionRow(rows[0]);
  }

  async insertRefreshToken(input: CreateRefreshTokenInput, tx?: AuthTransaction): Promise<string> {
    const rows = await this.sequelize.query<{ id: string }>(
      `
      INSERT INTO reward_portal.portal_refresh_tokens
             (session_id, user_id, token_hash, parent_token_id, status, issued_at, expires_at)
      VALUES (:sessionId, :userId, :tokenHash, :parentTokenId,
              '${REFRESH_TOKEN_STATUS.ACTIVE}', :issuedAt, :expiresAt)
      RETURNING id
      `,
      {
        type: QueryTypes.SELECT,
        transaction: tx,
        replacements: {
          sessionId: input.sessionId,
          userId: input.userId,
          tokenHash: input.tokenHash,
          parentTokenId: input.parentTokenId,
          issuedAt: input.issuedAt,
          expiresAt: input.expiresAt,
        },
      },
    );

    return rows[0].id;
  }

  /**
   * Looks a refresh token up **and locks its row** for the rest of the transaction.
   *
   * `FOR UPDATE` is the whole of T-011 implementation note 5's concurrency requirement. Two
   * simultaneous replays of the same token both reach this statement; Postgres lets exactly one
   * through and blocks the other until the first commits, at which point — in READ COMMITTED,
   * `FOR UPDATE` re-evaluates the predicate against the *new* row version — the loser reads the
   * row as `consumed` and takes the reuse-detection branch. Without the lock both would read
   * `active` and both would succeed, which is precisely the theft scenario reuse detection
   * exists to catch (TC-15).
   *
   * `token_hash` is not selected. Nothing above this layer has any use for it, and a value that
   * is never returned cannot be accidentally serialised into a response (TC-26).
   */
  async lockRefreshTokenByHash(
    tokenHash: string,
    tx: AuthTransaction,
  ): Promise<RefreshTokenRow | null> {
    const rows = await this.sequelize.query<RawRefreshTokenRow>(
      `
      SELECT id, session_id, user_id, status, issued_at, expires_at, consumed_at
        FROM reward_portal.portal_refresh_tokens
       WHERE token_hash = :tokenHash
       FOR UPDATE
      `,
      { type: QueryTypes.SELECT, transaction: tx, replacements: { tokenHash } },
    );

    const row = rows[0];
    return row === undefined ? null : toRefreshTokenRow(row);
  }

  /**
   * Consumes a token, returning whether this call is the one that did it.
   *
   * The `status = 'active'` predicate makes the statement idempotent-safe: even if the
   * `FOR UPDATE` lock above were ever removed, a second caller would update zero rows and get
   * `false` rather than silently re-consuming. Defence in depth for the single most important
   * write in this module.
   */
  async markRefreshTokenConsumed(id: string, at: Date, tx: AuthTransaction): Promise<boolean> {
    const [, affected] = await this.sequelize.query(
      `
      UPDATE reward_portal.portal_refresh_tokens
         SET status = '${REFRESH_TOKEN_STATUS.CONSUMED}', consumed_at = :at
       WHERE id = :id AND status = '${REFRESH_TOKEN_STATUS.ACTIVE}'
      `,
      { type: QueryTypes.UPDATE, transaction: tx, replacements: { id, at } },
    );

    return affected > 0;
  }

  /**
   * Revokes every token in a session's family — the "revoke the ENTIRE session family" step of
   * 02-SECURITY.md §3. Already-revoked rows are excluded so the returned count is the number
   * this call actually killed, which is what the audit detail records.
   */
  async revokeRefreshTokenFamily(sessionId: string, tx?: AuthTransaction): Promise<number> {
    const [, affected] = await this.sequelize.query(
      `
      UPDATE reward_portal.portal_refresh_tokens
         SET status = '${REFRESH_TOKEN_STATUS.REVOKED}'
       WHERE session_id = :sessionId
         AND status <> '${REFRESH_TOKEN_STATUS.REVOKED}'
      `,
      { type: QueryTypes.UPDATE, transaction: tx, replacements: { sessionId } },
    );

    return affected;
  }

  /**
   * The `logout-all` / password-change counterpart to {@link revokeRefreshTokenFamily}: kills
   * every one of a user's refresh tokens in a single statement, optionally sparing one session's.
   *
   * One UPDATE rather than a loop over that user's sessions, because a loop would have to read
   * the session list first — and the natural place to read it is *after* the sessions have
   * already been marked revoked in the same transaction, at which point an "active sessions"
   * query returns nothing and the tokens quietly survive. Expressing it as a set operation on
   * `user_id` removes the ordering hazard entirely.
   */
  async revokeRefreshTokensForUser(
    userId: number,
    exceptSessionId: string | null,
    tx?: AuthTransaction,
  ): Promise<number> {
    const [, affected] = await this.sequelize.query(
      `
      UPDATE reward_portal.portal_refresh_tokens
         SET status = '${REFRESH_TOKEN_STATUS.REVOKED}'
       WHERE user_id = :userId
         AND status <> '${REFRESH_TOKEN_STATUS.REVOKED}'
         AND (CAST(:exceptSessionId AS uuid) IS NULL
              OR session_id <> CAST(:exceptSessionId AS uuid))
      `,
      { type: QueryTypes.UPDATE, transaction: tx, replacements: { userId, exceptSessionId } },
    );

    return affected;
  }

  async revokeSession(sessionId: string, reason: string, tx?: AuthTransaction): Promise<number> {
    const [, affected] = await this.sequelize.query(
      `
      UPDATE reward_portal.portal_sessions
         SET status = '${SESSION_STATUS.REVOKED}', revoked_at = now(), revoked_reason = :reason
       WHERE id = :sessionId AND status = '${SESSION_STATUS.ACTIVE}'
      `,
      { type: QueryTypes.UPDATE, transaction: tx, replacements: { sessionId, reason } },
    );

    return affected;
  }

  /**
   * Revokes every active session for a user, optionally sparing one.
   *
   * `exceptSessionId` is what makes "change your password" able to kill every *other* session
   * without logging the user out of the browser they are typing into. Passing `null` revokes
   * all of them, which is what `logout-all` and a completed password reset do.
   */
  async revokeSessionsForUser(
    userId: number,
    reason: string,
    exceptSessionId: string | null,
    tx?: AuthTransaction,
  ): Promise<number> {
    const [, affected] = await this.sequelize.query(
      `
      UPDATE reward_portal.portal_sessions
         SET status = '${SESSION_STATUS.REVOKED}', revoked_at = now(), revoked_reason = :reason
       WHERE user_id = :userId
         AND status = '${SESSION_STATUS.ACTIVE}'
         AND (CAST(:exceptSessionId AS uuid) IS NULL
              OR id <> CAST(:exceptSessionId AS uuid))
      `,
      {
        type: QueryTypes.UPDATE,
        transaction: tx,
        replacements: { userId, reason, exceptSessionId },
      },
    );

    return affected;
  }

  /**
   * The per-request session check, joined to the user row (see {@link SessionContextRow}).
   *
   * `expires_at` is returned rather than filtered on here so the guard applies its own clock —
   * the same clock it uses for the token's `exp` — instead of leaving "is it expired" split
   * between the database's `now()` and the process's `Date`.
   *
   * ### The two `LEFT JOIN`s — T-013 implementation note 9, architect review AR-10
   *
   * 00-ARCHITECTURE.md §5.3: `portal_users`' foreign keys to `tenants`/`merchants` are
   * `ON DELETE RESTRICT`, which protects against a hard delete orphaning a user — but tenant
   * suspension and merchant deactivation are **status changes**, so `RESTRICT` never fires and
   * gives no protection at all. T-034/T-036 bulk-revoke every session scoped to a suspended
   * tenant in the same transaction as the status change; these two joins are the backstop for
   * the window before that completes, and for the case where it fails partway.
   *
   * They are `LEFT` joins because most users have no parent to check: `super_admin` and
   * `country_admin` carry a `NULL` `tenant_id`, and only a `merchant` user carries a
   * `merchant_id` (00-ARCHITECTURE.md §5.1). An inner join would return no row for those users
   * and log every Super Admin out — the failure mode that makes this worth spelling out.
   *
   * Cost is one indexed lookup each on a primary key, on a query that was already being run per
   * request. §5.3 anticipates exactly this: *"`SessionValidGuard` already reads `portal_sessions`
   * per request — so this is one additional join, not a new hot path."*
   */
  async findSessionContext(
    sessionId: string,
    tx?: AuthTransaction,
  ): Promise<SessionContextRow | null> {
    const rows = await this.sequelize.query<RawSessionContextRow>(
      `
      SELECT s.id                    AS session_id,
             s.status                AS session_status,
             s.expires_at            AS session_expires_at,
             s.last_seen_at          AS last_seen_at,
             u.id                    AS user_id,
             u.status                AS user_status,
             (u.deleted_at IS NOT NULL) AS user_deleted,
             u.must_change_password  AS must_change_password,
             u.role                  AS role,
             t.status                AS tenant_status,
             m.status                AS merchant_status
        FROM reward_portal.portal_sessions s
        JOIN reward_portal.portal_users u ON u.id = s.user_id
        LEFT JOIN reward_config.tenants   t ON t.id = u.tenant_id
        LEFT JOIN reward_config.merchants m ON m.id = u.merchant_id
       WHERE s.id = :sessionId
       LIMIT 1
      `,
      { type: QueryTypes.SELECT, transaction: tx, replacements: { sessionId } },
    );

    const row = rows[0];
    if (row === undefined) return null;

    return {
      sessionId: row.session_id,
      sessionStatus: row.session_status,
      sessionExpiresAt: row.session_expires_at,
      lastSeenAt: row.last_seen_at,
      userId: row.user_id,
      userStatus: row.user_status,
      userDeleted: row.user_deleted,
      mustChangePassword: row.must_change_password,
      role: row.role,
      tenantStatus: row.tenant_status,
      merchantStatus: row.merchant_status,
    };
  }

  async touchSession(sessionId: string, at: Date, tx?: AuthTransaction): Promise<void> {
    await this.sequelize.query(
      `
      UPDATE reward_portal.portal_sessions
         SET last_seen_at = :at
       WHERE id = :sessionId AND status = '${SESSION_STATUS.ACTIVE}'
      `,
      { type: QueryTypes.UPDATE, transaction: tx, replacements: { sessionId, at } },
    );
  }

  /**
   * The caller's own sessions (TC-24). Filtered by `user_id` in the WHERE clause, never
   * fetched-then-filtered, and never returning a token hash of any kind.
   */
  async listSessionsForUser(userId: number, now: Date): Promise<SessionRow[]> {
    const rows = await this.sequelize.query<RawSessionRow>(
      `
      SELECT id, user_id, status, ip_address, user_agent,
             issued_at, last_seen_at, expires_at, revoked_at, revoked_reason
        FROM reward_portal.portal_sessions
       WHERE user_id = :userId
         AND status = '${SESSION_STATUS.ACTIVE}'
         AND expires_at > :now
       ORDER BY last_seen_at DESC
      `,
      { type: QueryTypes.SELECT, replacements: { userId, now } },
    );

    return rows.map(toSessionRow);
  }

  /**
   * One session, but only if it belongs to this user. The ownership test is a WHERE-clause
   * predicate, so another user's session id is not "found and rejected" — it is not found, and
   * the caller answers 404 (02-SECURITY.md §5.1, TC-25).
   */
  async findSessionForUser(sessionId: string, userId: number): Promise<SessionRow | null> {
    const rows = await this.sequelize.query<RawSessionRow>(
      `
      SELECT id, user_id, status, ip_address, user_agent,
             issued_at, last_seen_at, expires_at, revoked_at, revoked_reason
        FROM reward_portal.portal_sessions
       WHERE id = :sessionId AND user_id = :userId
       LIMIT 1
      `,
      { type: QueryTypes.SELECT, replacements: { sessionId, userId } },
    );

    const row = rows[0];
    return row === undefined ? null : toSessionRow(row);
  }

  /**
   * The **fresh** user row, read on every refresh (02-SECURITY.md §3, AR-04, TC-27/TC-28).
   *
   * This is the query that makes a demotion, a promotion or a re-scoping take effect within one
   * refresh interval rather than within the refresh token's full seven days. `deleted_at IS
   * NULL` is not optional: raw SQL gets none of Sequelize's paranoid filtering, so this
   * predicate *is* the soft-delete control.
   */
  async findUserById(userId: number): Promise<AuthUserRow | null> {
    const rows = await this.sequelize.query<RawUserRow>(
      `
      SELECT id, email, display_name, role, status,
             country_id, tenant_id, merchant_id, must_change_password, mfa_enabled
        FROM reward_portal.portal_users
       WHERE id = :userId AND deleted_at IS NULL
       LIMIT 1
      `,
      { type: QueryTypes.SELECT, replacements: { userId } },
    );

    const row = rows[0];
    if (row === undefined) return null;

    return {
      id: row.id,
      // T-056: `portal_users.email` is ciphertext at rest and this is raw SQL, which gets none of
      // Sequelize's `afterFind` decryption. Without this the refreshed session — and every claim
      // derived from it — would carry a `v1.…` envelope where the address belongs.
      email: this.emailCrypto.decryptForRow(row.id, row.email),
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      countryId: row.country_id,
      tenantId: row.tenant_id,
      merchantId: row.merchant_id,
      mustChangePassword: row.must_change_password,
      mfaEnabled: row.mfa_enabled,
    };
  }

  /**
   * The forgot-password lookup. Returns an id or `null` and **nothing else** — the caller must
   * not be able to learn anything about the account beyond "there was one", and the endpoint
   * answers 204 either way (TC-21).
   *
   * T-056 moved this from `lower(email)` to `email_bidx` for the same reason
   * `credential.repository.ts` did: the column is ciphertext with a random IV, so `lower(email)`
   * matches nothing at all now. Left unchanged, this method would have returned `null` for every
   * address in the database — and because the endpoint deliberately answers 204 either way, the
   * breakage would have been completely invisible from the outside.
   */
  async findActiveUserIdByEmail(email: string): Promise<number | null> {
    const rows = await this.sequelize.query<{ id: number }>(
      `
      SELECT id
        FROM reward_portal.portal_users
       WHERE email_bidx = :bidx
         AND deleted_at IS NULL
         AND status = 'active'
       LIMIT 1
      `,
      { type: QueryTypes.SELECT, replacements: { bidx: this.emailCrypto.blindIndexFor(email) } },
    );

    const row = rows[0];
    return row === undefined ? null : row.id;
  }

  async recordLastLogin(userId: number, at: Date, tx?: AuthTransaction): Promise<void> {
    await this.sequelize.query(
      `UPDATE reward_portal.portal_users SET last_login_at = :at, updated_at = now() WHERE id = :userId`,
      { type: QueryTypes.UPDATE, transaction: tx, replacements: { userId, at } },
    );
  }

  async setMustChangePassword(userId: number, value: boolean, tx?: AuthTransaction): Promise<void> {
    await this.sequelize.query(
      `
      UPDATE reward_portal.portal_users
         SET must_change_password = :value, updated_at = now()
       WHERE id = :userId
      `,
      { type: QueryTypes.UPDATE, transaction: tx, replacements: { userId, value } },
    );
  }

  async createPasswordReset(
    userId: number,
    tokenHash: string,
    expiresAt: Date,
    tx?: AuthTransaction,
  ): Promise<string> {
    const rows = await this.sequelize.query<{ id: string }>(
      `
      INSERT INTO reward_portal.portal_password_resets (user_id, token_hash, expires_at)
      VALUES (:userId, :tokenHash, :expiresAt)
      RETURNING id
      `,
      {
        type: QueryTypes.SELECT,
        transaction: tx,
        replacements: { userId, tokenHash, expiresAt },
      },
    );

    return rows[0].id;
  }

  /** Same `FOR UPDATE` discipline as the refresh path — a reset token is single-use (TC-22). */
  async lockPasswordResetByHash(
    tokenHash: string,
    tx: AuthTransaction,
  ): Promise<PasswordResetRow | null> {
    const rows = await this.sequelize.query<RawPasswordResetRow>(
      `
      SELECT id, user_id, expires_at, consumed_at
        FROM reward_portal.portal_password_resets
       WHERE token_hash = :tokenHash
       FOR UPDATE
      `,
      { type: QueryTypes.SELECT, transaction: tx, replacements: { tokenHash } },
    );

    const row = rows[0];
    if (row === undefined) return null;

    return {
      id: row.id,
      userId: row.user_id,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
    };
  }

  async markPasswordResetConsumed(id: string, at: Date, tx: AuthTransaction): Promise<boolean> {
    const [, affected] = await this.sequelize.query(
      `
      UPDATE reward_portal.portal_password_resets
         SET consumed_at = :at
       WHERE id = :id AND consumed_at IS NULL
      `,
      { type: QueryTypes.UPDATE, transaction: tx, replacements: { id, at } },
    );

    return affected > 0;
  }

  /**
   * `rbac_cache_config.rbac_version:<role>`, stamped into the access token so T-013's
   * permission cache can tell a token minted before a permission change from one minted after.
   *
   * A missing or unparseable row yields `0`. That is the safe direction: `0` matches no seeded
   * version (T004_005 seeds every role at `1`), so a cache keyed on `role + rbacVersion` treats
   * such a token as belonging to an unknown generation and re-reads rather than serving a
   * possibly-stale entry. Failing the whole login because a cache-tuning row is absent would be
   * the wrong trade — this value tunes a cache; it does not grant anything.
   */
  async readRbacVersion(role: PortalRole): Promise<number> {
    const rows = await this.sequelize.query<{ config_value: string }>(
      `
      SELECT config_value
        FROM reward_config.rbac_cache_config
       WHERE config_key = :key
       LIMIT 1
      `,
      { type: QueryTypes.SELECT, replacements: { key: `rbac_version:${role}` } },
    );

    const row = rows[0];
    if (row === undefined) return 0;

    const parsed = Number.parseInt(row.config_value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Appends one row to `portal_audit_log`.
   *
   * The table is append-only at the privilege level — `reward_app` holds `SELECT, INSERT` and
   * has `UPDATE`/`DELETE` explicitly revoked (T002_008) — so this is the only operation this
   * repository offers against it, by construction rather than by convention.
   *
   * `detail` is stringified rather than passed as an object for the reason
   * `credential.repository.ts` documents about arrays: Sequelize expands some JS values inside
   * a replacement in ways that are valid SQL and the wrong value. An explicit `CAST(... AS
   * jsonb)` of a string is unambiguous.
   */
  async writeAuditEvent(event: AuditEventInput, tx?: AuthTransaction): Promise<void> {
    await this.sequelize.query(
      `
      INSERT INTO reward_portal.portal_audit_log
             (event_type, actor_id, actor_role, target_type, target_id,
              country_id, tenant_id, ip_address, detail, occurred_at)
      VALUES (:eventType, :actorId, :actorRole, :targetType, :targetId,
              :countryId, :tenantId, CAST(:ipAddress AS inet), CAST(:detail AS jsonb), now())
      `,
      {
        type: QueryTypes.INSERT,
        transaction: tx,
        replacements: {
          eventType: event.eventType,
          actorId: event.actorId,
          actorRole: event.actorRole,
          targetType: event.targetType,
          targetId: event.targetId,
          countryId: event.countryId,
          tenantId: event.tenantId,
          ipAddress: event.ipAddress,
          detail: event.detail === null ? null : JSON.stringify(event.detail),
        },
      },
    );
  }

  async runInTransaction<T>(fn: (tx: AuthTransaction) => Promise<T>): Promise<T> {
    return this.sequelize.transaction(async (tx) => fn(tx));
  }
}

// --- helpers -----------------------------------------------------------------------------

function toSessionRow(row: RawSessionRow): SessionRow {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    issuedAt: row.issued_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}

function toRefreshTokenRow(row: RawRefreshTokenRow): RefreshTokenRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    status: row.status,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}
