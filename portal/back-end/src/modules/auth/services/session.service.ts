/**
 * T-011 — the session lifecycle: issuance, refresh rotation with reuse detection, per-request
 * validity, and revocation (02-SECURITY.md §1–3).
 *
 * ---
 *
 * ### The two controls that make a seven-day refresh token safe to hold
 *
 * Everything else in this file is bookkeeping around these two. Both are named in
 * 02-SECURITY.md §3 and both are called out in T-011's Definition of Done as things to verify
 * with your own eyes rather than trust the tests for.
 *
 * **1. Rotation with reuse detection.** A refresh token is single-use. Presenting one that has
 * already been consumed is not an error to be tidied away with a 401 — it is evidence that two
 * parties hold the same token, which means one of them stole it. The response is to revoke the
 * entire family (every token sharing `session_id`), revoke the session itself, and write
 * `refresh_reuse_detected` to `portal_audit_log`. The legitimate user is logged out; so is the
 * thief. That turns a stolen refresh token from a seven-day backdoor into a one-shot that trips
 * an alarm.
 *
 * The concurrency detail matters as much as the rule: the lookup takes `SELECT … FOR UPDATE`
 * on the token row inside a transaction, so two simultaneous replays cannot both read it as
 * `active`. Exactly one rotates; the other blocks, re-reads the row Postgres has just updated,
 * sees `consumed`, and trips the alarm (T-011 TC-15).
 *
 * **2. Refresh re-derives role and scope from `portal_users`.** It never re-signs the claims
 * the presented token carried (02-SECURITY.md §3, architect review AR-04). `rbacVersion` tracks
 * changes to the *permission tables*; it says nothing about whether this user's own row changed.
 * If refresh carried old claims forward, a demotion, a promotion or a move to another tenant
 * would be cosmetic for up to seven days. {@link SessionService.rotate} therefore reads the
 * user row fresh and mints from that, discarding what the old token said (TC-27/TC-28).
 *
 * ---
 *
 * ### Why the rejection paths return a value instead of throwing
 *
 * `runInTransaction` rolls back when its callback throws. The reuse-detection branch *writes*
 * — it revokes a family and a session — and then has to tell the caller "denied". Throwing from
 * inside the transaction would roll those revocations back, leaving the system with a detected
 * theft and no response to it: the single worst bug this module could have, and one that would
 * pass every test that only asserts on the 401.
 *
 * So the transaction always commits, returning a discriminated {@link RotationOutcome}, and the
 * HTTP failure is raised by the caller afterwards. The audit row is written **after** the commit
 * for the mirror-image reason: a failed INSERT inside a Postgres transaction aborts the whole
 * transaction, so an audit-log hiccup must not be able to undo a revocation either (T-014
 * implementation note 4 states the general form of this rule — an audit outage must not fail the
 * request).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PortalRole } from '@/database/portal-models';
import {
  AUTH_AUDIT_EVENT,
  REFRESH_TOKEN_STATUS,
  REFRESH_TOKEN_TTL_SECONDS,
  REVOCATION_REASON,
  SESSION_STATUS,
  SESSION_TOUCH_INTERVAL_MS,
  SESSION_TTL_SECONDS,
} from '../session.constants';
import { ACTIVE_USER_STATUS } from './credential.service';
import type { AuthTransaction, AuthUserRow } from './credential.repository';
import {
  SESSION_STORE,
  type AuditEventInput,
  type SessionContextRow,
  type SessionRow,
  type SessionStore,
} from './session.repository';
import { TokenService, type AccessTokenClaims } from './token.service';

/**
 * The one `tenants.status` / `merchants.status` value that leaves a session usable
 * (T-013 note 9 / AR-10). Both tables' CHECK constraints allow several non-active values;
 * `active` is the only one that is not a revocation.
 */
export const ACTIVE_PARENT_STATUS = 'active';

/** What the transport layer knows about the caller. Never trusted for authorisation. */
export interface RequestContext {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

/** Everything a successful login or refresh hands back to the controller. */
export interface IssuedSession {
  readonly sessionId: string;
  /** The RS256 access JWT, for the `__Host-rs_at` cookie. */
  readonly accessToken: string;
  /** The opaque refresh token, for the `__Host-rs_rt` cookie. Never persisted in this form. */
  readonly refreshToken: string;
  /** The JS-readable double-submit value, for the `rs_csrf` cookie. */
  readonly csrfToken: string;
  readonly claims: AccessTokenClaims;
  /**
   * `portal_users.must_change_password` as read while issuing this pair.
   *
   * Carried here rather than looked up again by the caller because it is **not** a JWT claim —
   * it is read live on every request (see `SessionValidGuard`) precisely so that clearing it
   * takes effect immediately. Returning it from the same read that produced the claims means the
   * refresh response cannot disagree with the session the refresh just created, and saves the
   * controller a second query it would otherwise have to make and then defensively null-check.
   */
  readonly mustChangePassword: boolean;
}

/**
 * The result of a rotation attempt. `rejected` deliberately carries no reason for the client —
 * `reason` exists so the server log and the audit row can be specific while the response is not.
 */
export type RotationOutcome =
  | { readonly status: 'rotated'; readonly session: IssuedSession }
  | { readonly status: 'rejected'; readonly reason: string };

/** Session as the "your sessions" screen sees it. No token material at any depth (TC-24). */
export interface SessionSummary {
  readonly id: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly issuedAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly current: boolean;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Creates a session and its first refresh token, and mints the access JWT.
   *
   * `tx` is what T-010's `LockoutService.registerSuccess` means by "in the same transaction as
   * the login": the caller opens one transaction covering the attempt row, the counter reset and
   * everything here, so a login that fails halfway does not leave a reset counter or an orphan
   * session behind it.
   */
  async start(
    user: AuthUserRow,
    context: RequestContext,
    now: Date,
    tx?: AuthTransaction,
  ): Promise<IssuedSession> {
    const session = await this.store.createSession(
      {
        userId: user.id,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        issuedAt: now,
        expiresAt: addSeconds(now, SESSION_TTL_SECONDS),
      },
      tx,
    );

    const issued = await this.issueTokenPair(session.id, user, null, now, tx);
    await this.store.recordLastLogin(user.id, now, tx);

    return issued;
  }

  /**
   * `POST /auth/refresh` — the whole of 02-SECURITY.md §3.
   *
   * Read the file header before changing anything here; the ordering of the branches and the
   * fact that the transaction commits on every path are both load-bearing.
   */
  async rotate(
    presentedToken: string,
    context: RequestContext,
    now: Date,
  ): Promise<RotationOutcome> {
    const tokenHash = this.tokens.hashOpaqueToken(presentedToken);

    const { outcome, audit } = await this.store.runInTransaction(async (tx) => {
      const token = await this.store.lockRefreshTokenByHash(tokenHash, tx);

      if (token === null) {
        // No row at all: a token from a previous deployment, a guess, or a token whose session
        // was hard-deleted. Nothing to revoke, but worth recording — a burst of these is a
        // scan, not a user.
        return this.rejection('unknown', {
          eventType: AUTH_AUDIT_EVENT.REFRESH_UNKNOWN,
          actorId: null,
          actorRole: null,
          targetType: null,
          targetId: null,
          countryId: null,
          tenantId: null,
          ipAddress: context.ipAddress,
          detail: null,
        });
      }

      if (token.status === REFRESH_TOKEN_STATUS.CONSUMED) {
        return this.detectReuse(token.sessionId, token.userId, token.id, context, tx);
      }

      if (token.status !== REFRESH_TOKEN_STATUS.ACTIVE) {
        // Already revoked — typically a member of a family killed by an earlier detection, or a
        // token belonging to a session the user logged out of. Not itself evidence of theft.
        return this.rejection(
          'revoked',
          this.refreshRejectedEvent(token.userId, context, 'revoked'),
        );
      }

      if (token.expiresAt.getTime() <= now.getTime()) {
        return this.rejection(
          'expired',
          this.refreshRejectedEvent(token.userId, context, 'expired'),
        );
      }

      const sessionContext = await this.store.findSessionContext(token.sessionId, tx);
      if (!this.isUsableSession(sessionContext, now)) {
        return this.rejection(
          'session_invalid',
          this.refreshRejectedEvent(token.userId, context, 'session_invalid'),
        );
      }

      const consumed = await this.store.markRefreshTokenConsumed(token.id, now, tx);
      if (!consumed) {
        // Unreachable while the `FOR UPDATE` lock above is in place — and that is exactly why it
        // is handled rather than asserted. If the lock is ever lost to a refactor, this branch is
        // what keeps the outcome fail-closed (treat it as a race that somebody else won, i.e. as
        // reuse) instead of quietly issuing a second live token for one consumed one.
        return this.detectReuse(token.sessionId, token.userId, token.id, context, tx);
      }

      // --- AR-04: claims come from the database, never from the presented token ---------------
      const user = await this.store.findUserById(token.userId);
      if (user === null || user.status !== ACTIVE_USER_STATUS) {
        return this.rejection(
          'user_inactive',
          this.refreshRejectedEvent(token.userId, context, 'user_inactive'),
        );
      }

      const session = await this.issueTokenPair(token.sessionId, user, token.id, now, tx);
      await this.store.touchSession(token.sessionId, now, tx);

      return {
        outcome: { status: 'rotated', session } as RotationOutcome,
        audit: {
          eventType: AUTH_AUDIT_EVENT.REFRESH_ROTATED,
          actorId: user.id,
          actorRole: user.role,
          targetType: 'portal_session',
          targetId: token.sessionId,
          countryId: user.countryId,
          tenantId: user.tenantId,
          ipAddress: context.ipAddress,
          detail: null,
        } satisfies AuditEventInput,
      };
    });

    await this.audit(audit);
    return outcome;
  }

  /**
   * The per-request check that makes revocation take effect in under a second rather than in up
   * to fifteen minutes (T-011 implementation note 6).
   *
   * Returns `null` for every reason a session might be unusable, without distinguishing them —
   * the guard's answer is the same 401 in all cases. Beyond the session's own status it also
   * rejects a deleted or non-`active` **user**, which is what makes "deactivate this account"
   * effective immediately even if the code doing the deactivating forgets to revoke sessions
   * explicitly (TC-17). Guards should not depend on another module's diligence.
   */
  async resolveActive(sessionId: string, now: Date): Promise<SessionContextRow | null> {
    const context = await this.store.findSessionContext(sessionId);
    if (!this.isUsableSession(context, now)) return null;

    // Non-null by construction: `isUsableSession` returns false for null.
    const usable = context as SessionContextRow;

    if (now.getTime() - usable.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
      await this.store.touchSession(sessionId, now);
    }

    return usable;
  }

  /** Ends one session and every refresh token in its family. Used by logout and by revoke. */
  async revoke(
    sessionId: string,
    reason: string,
    actor: { userId: number; role: PortalRole } | null,
    context: RequestContext,
    eventType: string,
  ): Promise<void> {
    await this.store.runInTransaction(async (tx) => {
      await this.store.revokeRefreshTokenFamily(sessionId, tx);
      await this.store.revokeSession(sessionId, reason, tx);
    });

    await this.audit({
      eventType,
      actorId: actor?.userId ?? null,
      actorRole: actor?.role ?? null,
      targetType: 'portal_session',
      targetId: sessionId,
      countryId: null,
      tenantId: null,
      ipAddress: context.ipAddress,
      detail: null,
    });
  }

  /**
   * Ends every session for a user, optionally sparing one.
   *
   * Sparing the current session is what lets a password change invalidate an attacker's parallel
   * sessions without logging the user out of the tab they are typing in; passing `null` is what
   * `logout-all` and a completed password reset do.
   */
  async revokeAllForUser(
    userId: number,
    reason: string,
    exceptSessionId: string | null,
    actor: { userId: number; role: PortalRole } | null,
    context: RequestContext,
    eventType: string,
  ): Promise<number> {
    const sessions = await this.store.runInTransaction(async (tx) => {
      const revoked = await this.store.revokeSessionsForUser(userId, reason, exceptSessionId, tx);
      await this.store.revokeRefreshTokensForUser(userId, exceptSessionId, tx);
      return revoked;
    });

    await this.audit({
      eventType,
      actorId: actor?.userId ?? null,
      actorRole: actor?.role ?? null,
      targetType: 'portal_user',
      targetId: String(userId),
      countryId: null,
      tenantId: null,
      ipAddress: context.ipAddress,
      detail: { revokedSessions: sessions },
    });

    return sessions;
  }

  /** The caller's own live sessions, shaped for the API. Never includes a token or a hash. */
  async listForUser(
    userId: number,
    currentSessionId: string,
    now: Date,
  ): Promise<SessionSummary[]> {
    const sessions = await this.store.listSessionsForUser(userId, now);
    return sessions.map((session) => this.toSummary(session, currentSessionId));
  }

  /** One of the caller's own sessions, or `null` — the caller answers 404 either way (TC-25). */
  async findOwnedSession(sessionId: string, userId: number): Promise<SessionRow | null> {
    return this.store.findSessionForUser(sessionId, userId);
  }

  /**
   * Appends an authentication event to `portal_audit_log`, never failing the caller.
   *
   * An audit outage that takes the portal down is a worse outcome than a gap in the log
   * (T-014 implementation note 4). It is logged at `error` so the gap is at least visible in the
   * process log, which is the one place left when the audit table is unavailable.
   */
  private async audit(event: AuditEventInput): Promise<void> {
    try {
      await this.store.writeAuditEvent(event);
    } catch (error) {
      this.logger.error(
        `Failed to write ${event.eventType} to portal_audit_log: ${(error as Error).message}`,
      );
    }
  }

  /**
   * The replay branch. Revokes the whole family and the session, then reports the rejection.
   *
   * Note what is *not* here: any attempt to work out whether the presenter is the thief or the
   * victim. That is not knowable from one request, and guessing it wrong in the victim's favour
   * would leave the thief holding a live session. Both are logged out; the user re-authenticates.
   */
  private async detectReuse(
    sessionId: string,
    userId: number,
    tokenId: string,
    context: RequestContext,
    tx: AuthTransaction,
  ): Promise<{ outcome: RotationOutcome; audit: AuditEventInput }> {
    const revokedTokens = await this.store.revokeRefreshTokenFamily(sessionId, tx);
    await this.store.revokeSession(sessionId, REVOCATION_REASON.REFRESH_REUSE_DETECTED, tx);

    this.logger.warn(
      `Refresh token reuse detected for session ${sessionId}; family revoked (${revokedTokens} tokens)`,
    );

    return {
      outcome: { status: 'rejected', reason: 'reuse_detected' },
      audit: {
        eventType: AUTH_AUDIT_EVENT.REFRESH_REUSE_DETECTED,
        actorId: userId,
        actorRole: null,
        targetType: 'portal_session',
        targetId: sessionId,
        countryId: null,
        tenantId: null,
        ipAddress: context.ipAddress,
        // Ids and counts only — never the presented token, not even its hash (TC-26).
        detail: { replayedTokenId: tokenId, revokedTokens },
      },
    };
  }

  /** Mints the access JWT, the next refresh token and the CSRF value for one session. */
  private async issueTokenPair(
    sessionId: string,
    user: AuthUserRow,
    parentTokenId: string | null,
    now: Date,
    tx?: AuthTransaction,
  ): Promise<IssuedSession> {
    const refreshToken = this.tokens.generateOpaqueToken();
    await this.store.insertRefreshToken(
      {
        sessionId,
        userId: user.id,
        // Only the digest is stored. The raw value below leaves in a cookie and is never
        // written down anywhere, so a database dump yields no usable session.
        tokenHash: refreshToken.hash,
        parentTokenId,
        issuedAt: now,
        expiresAt: addSeconds(now, REFRESH_TOKEN_TTL_SECONDS),
      },
      tx,
    );

    const rbacVersion = await this.store.readRbacVersion(user.role);
    const access = this.tokens.signAccessToken(
      {
        userId: user.id,
        sessionId,
        role: user.role,
        countryId: user.countryId,
        tenantId: user.tenantId,
        merchantId: user.merchantId,
        rbacVersion,
      },
      now,
    );

    return {
      sessionId,
      accessToken: access.token,
      refreshToken: refreshToken.raw,
      csrfToken: this.tokens.csrfTokenFor(sessionId),
      claims: access.claims,
      mustChangePassword: user.mustChangePassword,
    };
  }

  /**
   * Every reason a session might not be usable, in one predicate — used by both the per-request
   * guard path and the refresh path, so a suspension cannot be worked around by refreshing.
   *
   * The last two checks are T-013 implementation note 9 (architect review AR-10,
   * 00-ARCHITECTURE.md §5.3): **a suspended tenant or a deactivated merchant revokes its users'
   * sessions immediately**, on the next request, whether or not T-034/T-036's bulk revoke has
   * run. `null` means the user has no such parent (a `super_admin` has no tenant; only a
   * `merchant` user has a merchant) and is therefore not a failure — see
   * `SessionContextRow.tenantStatus` for why the distinction is safe to draw from `null`.
   *
   * Comparing against `!== 'active'` rather than listing the blocked statuses is deliberate:
   * `ck_tenants_status` allows `pending_provisioning`, `active`, `inactive` and `suspended`
   * today, and a status added tomorrow should confine the session until somebody decides
   * otherwise, not admit it by default.
   */
  private isUsableSession(context: SessionContextRow | null, now: Date): boolean {
    if (context === null) return false;
    if (context.sessionStatus !== SESSION_STATUS.ACTIVE) return false;
    if (context.sessionExpiresAt.getTime() <= now.getTime()) return false;
    if (context.userDeleted) return false;
    if (context.userStatus !== ACTIVE_USER_STATUS) return false;
    if (context.tenantStatus !== null && context.tenantStatus !== ACTIVE_PARENT_STATUS) {
      this.logger.warn(
        `Session ${context.sessionId} rejected: parent tenant status is "${context.tenantStatus}"`,
      );
      return false;
    }
    if (context.merchantStatus !== null && context.merchantStatus !== ACTIVE_PARENT_STATUS) {
      this.logger.warn(
        `Session ${context.sessionId} rejected: parent merchant status is "${context.merchantStatus}"`,
      );
      return false;
    }
    return true;
  }

  private rejection(
    reason: string,
    audit: AuditEventInput,
  ): { outcome: RotationOutcome; audit: AuditEventInput } {
    return { outcome: { status: 'rejected', reason }, audit };
  }

  private refreshRejectedEvent(
    userId: number,
    context: RequestContext,
    reason: string,
  ): AuditEventInput {
    return {
      eventType: AUTH_AUDIT_EVENT.REFRESH_REJECTED,
      actorId: userId,
      actorRole: null,
      targetType: null,
      targetId: null,
      countryId: null,
      tenantId: null,
      ipAddress: context.ipAddress,
      detail: { reason },
    };
  }

  private toSummary(session: SessionRow, currentSessionId: string): SessionSummary {
    return {
      id: session.id,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      issuedAt: session.issuedAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      current: session.id === currentSessionId,
    };
  }
}

function addSeconds(from: Date, seconds: number): Date {
  return new Date(from.getTime() + seconds * 1000);
}
