/**
 * T-011 — the auth use-cases: login, change password, forgot password, reset password.
 *
 * `SessionService` owns the session *mechanism* (issue, rotate, revoke); `CredentialService`
 * (T-010) owns the *login decision*. This file is the thin layer that sequences them, opens the
 * transactions that make a login atomic, and decides what the HTTP layer is told. It holds no
 * cookie logic and touches no `Request`/`Response` — that is `auth.controller.ts`'s job, so
 * every rule below is testable without a server.
 *
 * ### Three orderings in here are security decisions, not style
 *
 * **1. Password verification, then the step-up hook, then the session.** A hook that ran before
 * verification would confirm to an unauthenticated attacker that a given account has MFA
 * enabled; one that ran after session creation would have to tear a live session down again.
 * See `step-up.hook.ts`.
 *
 * **2. The reset token is consumed in the same transaction as the password change.** If the new
 * password fails the policy, the transaction rolls back and the reset link still works. Consuming
 * first and changing after would burn a single-use token on a typo — a self-inflicted denial of
 * service on the one flow a locked-out user has left.
 *
 * **3. `forgot-password` does its work after the response, not before it.** The endpoint returns
 * 204 without ever having looked the address up, so the response time cannot depend on whether
 * the account exists (T-011 TC-21). Doing the lookup first and *then* returning a constant body
 * would still leak through latency, which is the enumeration channel the whole design closes.
 *
 * **4. A *rejected* login commits its transaction; only a genuine fault rolls it back (T-082).**
 * `CredentialService.authenticate` records the failed attempt and advances
 * `failed_attempts`/`locked_until` using the transaction this file opens, and only then reports
 * the denial. If that denial travelled out of the transaction callback as an exception, the
 * managed transaction would roll back — discarding the very writes the lockout control is made
 * of. So {@link AuthService.login} returns a `denied` outcome from inside the callback and raises
 * {@link InvalidCredentialsHttpException} after the commit. This is the same rule, for the same
 * reason, as the reuse-detection branch in `session.service.ts` (see its header): a security
 * control that writes and then denies cannot deny by throwing.
 *
 * Note the asymmetry with ordering 2 above — there, rollback-on-refusal is the *desired*
 * behaviour, because a rejected password must not burn a single-use reset token. The difference
 * is what the write means: a consumed token is a cost to the legitimate user, a recorded failure
 * is a cost to the attacker. Only the deliberate `InvalidCredentialsError` is converted into a
 * committing outcome; every other error still rolls back, so a failed query or a crypto fault
 * cannot commit a half-written login.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PASSWORD_ALGO } from './auth.constants';
import { InvalidCredentialsError, PasswordPolicyError } from './auth.errors';
import {
  InvalidCredentialsHttpException,
  PasswordPolicyHttpException,
  ResetTokenInvalidHttpException,
} from './auth.exceptions';
import {
  AUTH_AUDIT_EVENT,
  PASSWORD_RESET_TTL_SECONDS,
  REVOCATION_REASON,
} from './session.constants';
import {
  CREDENTIAL_STORE,
  type AuthTransaction,
  type AuthUserRow,
  type CredentialStore,
} from './services/credential.repository';
import { CredentialService, type AuthenticationResult } from './services/credential.service';
import { LockoutService } from './services/lockout.service';
import { SESSION_STORE, type SessionStore } from './services/session.repository';
import {
  SessionService,
  type IssuedSession,
  type RequestContext,
} from './services/session.service';
import { STEP_UP_HOOK, type StepUpHook } from './services/step-up.hook';
import { TokenService } from './services/token.service';

export interface Credentials {
  readonly email: string;
  readonly password: string;
}

/**
 * The outcome of a successful password verification.
 *
 * `step_up_required` carries no session and no cookies by construction — there is nowhere in
 * this type to put them (02-SECURITY.md §2a). T-055 extends this union with its `MFA_PENDING`
 * token rather than adding an optional session field to this member.
 */
export type LoginResult =
  | {
      readonly status: 'authenticated';
      readonly session: IssuedSession;
      readonly user: AuthUserRow;
      readonly mustChangePassword: boolean;
    }
  | {
      readonly status: 'step_up_required';
      readonly user: AuthUserRow;
      readonly mustChangePassword: boolean;
      /**
       * **T-055.** The `MFA_PENDING` credential the hook minted, or `undefined` when the hook had
       * none to offer. Carried here rather than as an optional session field, exactly as the
       * comment above this union anticipated.
       *
       * It is a *transport* value: this service neither reads nor interprets it. The controller
       * puts it in the `__Host-rs_mfa` cookie and it never appears in a response body — see
       * `mfa.constants.ts` for why the body would be the wrong place.
       */
      readonly mfaPendingToken?: string;
    };

/**
 * What the login transaction hands back to {@link AuthService.login} (T-082).
 *
 * `denied` is deliberately **not** a member of {@link LoginResult}: it never reaches the
 * controller, because `login` turns it into {@link InvalidCredentialsHttpException} as soon as
 * the transaction has committed. Keeping it out of the public union means no caller can
 * accidentally treat a rejected login as a successful one, and no new branch appears in the
 * controller that could tell the four failure causes apart (02-SECURITY.md §2).
 */
type LoginTransactionOutcome = LoginResult | { readonly status: 'denied' };

/** The result of the password check, before it is allowed to affect the transaction. */
type AuthenticationOutcome =
  | { readonly status: 'verified'; readonly result: AuthenticationResult }
  | { readonly status: 'denied' };

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /** In-flight background work, so tests can await it deterministically. See `whenIdle`. */
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly credentials: CredentialService,
    private readonly lockout: LockoutService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    @Inject(CREDENTIAL_STORE) private readonly credentialStore: CredentialStore,
    @Inject(SESSION_STORE) private readonly sessionStore: SessionStore,
    @Inject(STEP_UP_HOOK) private readonly stepUp: StepUpHook,
  ) {}

  /**
   * `POST /auth/login`.
   *
   * Throws {@link InvalidCredentialsHttpException} — and only that — for every failure, because
   * `CredentialService.authenticate` throws one undifferentiated error for unknown address,
   * wrong password, locked, inactive and no-credential-row alike (T-011 TC-6). This method adds
   * no branch that could reintroduce a distinction.
   */
  async login(
    credentials: Credentials,
    context: RequestContext,
    now: Date = new Date(),
  ): Promise<LoginResult> {
    const result = await this.sessionStore.runInTransaction<LoginTransactionOutcome>(async (tx) => {
      const attempt = await this.authenticateOrDeny(credentials, context, now, tx);

      // Return, never throw — see ordering note 4 in this file's header. By this point
      // `CredentialService.authenticate` has already written the `portal_login_attempts` row and
      // advanced `failed_attempts`/`locked_until` through `tx`; throwing here would roll both
      // back and the account would never lock (T-082).
      if (attempt.status === 'denied') return { status: 'denied' };

      const authenticated = attempt.result;
      const { user } = authenticated;

      // `mustChangePassword` from T-010 folds in `password_expires_at`, which is *not* the
      // `portal_users` column `SessionValidGuard` reads on every request. Persisting the derived
      // value here is what stops an expired-but-not-flagged password from being enforced at
      // login and then quietly ignored on the very next request.
      if (authenticated.mustChangePassword && !user.mustChangePassword) {
        await this.sessionStore.setMustChangePassword(user.id, true, tx);
      }

      const stepUp = await this.stepUp.evaluate(user);
      if (stepUp.required) {
        // No session, no refresh token, no cookie — 02-SECURITY.md §2a, step 7.
        return {
          status: 'step_up_required',
          user,
          mustChangePassword: authenticated.mustChangePassword,
          mfaPendingToken: stepUp.pendingToken,
        } satisfies LoginResult;
      }

      const session = await this.sessions.start(user, context, now, tx);
      return {
        status: 'authenticated',
        session,
        user,
        mustChangePassword: authenticated.mustChangePassword,
      } satisfies LoginResult;
    });

    // Raised only now, with the failure writes safely committed. Same exception, same status and
    // same body as the pre-T-082 throw-from-inside-the-transaction, so the byte-identical
    // response contract for unknown / wrong-password / inactive / locked is untouched.
    if (result.status === 'denied') throw new InvalidCredentialsHttpException();

    if (result.status === 'authenticated') {
      await this.auditLoginSuccess(result.user, result.session.sessionId, context);
    }

    // Opportunistic Argon2 upgrade, deliberately **after** the transaction has committed: the
    // plaintext is only available during a successful login, so this is the one moment an
    // upgrade is possible, but a failure here must not roll the login back. See `rehashPassword`.
    await this.rehashIfNeeded(credentials, result.user.id);

    return result;
  }

  /**
   * `POST /auth/change-password` — a self-service change by an authenticated user.
   *
   * Revokes the user's **other** sessions on success. The current session survives so the user
   * is not logged out of the tab they just used; every other one dies, because "I am changing my
   * password" most often means "I think someone else has it". Not spelled out in the task file;
   * flagged in the completion report.
   */
  async changePassword(
    userId: number,
    currentSessionId: string,
    input: { currentPassword: string; newPassword: string },
    context: RequestContext,
  ): Promise<void> {
    const user = await this.sessionStore.findUserById(userId);
    if (user === null) throw new InvalidCredentialsHttpException();

    await this.sessionStore.runInTransaction(async (tx) => {
      await this.replacePassword(
        {
          userId,
          email: user.email,
          newPassword: input.newPassword,
          currentPassword: input.currentPassword,
        },
        tx,
      );
      await this.sessionStore.setMustChangePassword(userId, false, tx);
    });

    await this.sessions.revokeAllForUser(
      userId,
      REVOCATION_REASON.PASSWORD_CHANGED,
      currentSessionId,
      { userId, role: user.role },
      context,
      AUTH_AUDIT_EVENT.PASSWORD_CHANGED,
    );
  }

  /**
   * `POST /auth/forgot-password` — always 204, in constant time, whether or not the address
   * exists (T-011 TC-21).
   *
   * Returns immediately and does the lookup, the token creation and (once a delivery channel
   * exists) the send on a detached promise. That is not an optimisation: it is what makes the
   * response time independent of the answer. An implementation that awaited the lookup would
   * take measurably longer for real accounts, which is the enumeration oracle in a different
   * costume.
   *
   * **There is no delivery channel in v1.** T-046 ("One-time password reveal — no email in v1")
   * is the deliberate decision that the portal ships without a mailer; an administrator hands a
   * new password over through that flow instead. The reset token is still minted and stored, so
   * this endpoint is complete and testable, and adding a mailer later is a change to
   * {@link deliverPasswordReset} alone.
   */
  forgotPassword(email: string, context: RequestContext, now: Date = new Date()): void {
    this.schedule(async () => {
      const userId = await this.sessionStore.findActiveUserIdByEmail(email);
      if (userId === null) return;

      const rawToken = await this.issuePasswordReset(userId, now);
      await this.deliverPasswordReset(userId, rawToken);
      await this.sessionStore.writeAuditEvent({
        eventType: AUTH_AUDIT_EVENT.PASSWORD_RESET_REQUESTED,
        actorId: userId,
        actorRole: null,
        targetType: 'portal_user',
        targetId: String(userId),
        countryId: null,
        tenantId: null,
        ipAddress: context.ipAddress,
        detail: null,
      });
    });
  }

  /**
   * Mints and stores a single-use reset token, returning the raw value.
   *
   * Public because it is the seam a real delivery channel — or T-046's administrator-driven
   * reveal — plugs into, and because `auth.e2e-spec.ts` needs a raw token to exercise TC-22 and
   * TC-23 with. Only the SHA-256 digest reaches the database.
   */
  async issuePasswordReset(userId: number, now: Date = new Date()): Promise<string> {
    const token = this.tokens.generateOpaqueToken();
    await this.sessionStore.createPasswordReset(
      userId,
      token.hash,
      new Date(now.getTime() + PASSWORD_RESET_TTL_SECONDS * 1000),
    );
    return token.raw;
  }

  /**
   * `POST /auth/reset-password` — single-use, expiring, and atomic with the password change.
   *
   * Answers one code for unknown, already-consumed and expired tokens alike
   * ({@link ResetTokenInvalidHttpException}): telling the holder of a stolen link that it has
   * already been used tells them the victim has noticed.
   */
  async resetPassword(
    input: { token: string; newPassword: string },
    context: RequestContext,
    now: Date = new Date(),
  ): Promise<void> {
    const tokenHash = this.tokens.hashOpaqueToken(input.token);

    const userId = await this.sessionStore.runInTransaction(async (tx) => {
      const reset = await this.sessionStore.lockPasswordResetByHash(tokenHash, tx);

      if (reset === null) throw new ResetTokenInvalidHttpException();
      if (reset.consumedAt !== null) throw new ResetTokenInvalidHttpException();
      if (reset.expiresAt.getTime() <= now.getTime()) throw new ResetTokenInvalidHttpException();

      const consumed = await this.sessionStore.markPasswordResetConsumed(reset.id, now, tx);
      // Unreachable while the `FOR UPDATE` lock holds; the fail-closed branch if it ever does not.
      if (!consumed) throw new ResetTokenInvalidHttpException();

      const user = await this.sessionStore.findUserById(reset.userId);
      if (user === null) throw new ResetTokenInvalidHttpException();

      // Inside the transaction on purpose: a policy failure here rolls the consume back, so the
      // link survives a rejected password. See this file's header, ordering note 2.
      await this.replacePassword(
        { userId: user.id, email: user.email, newPassword: input.newPassword },
        tx,
      );
      await this.sessionStore.setMustChangePassword(user.id, false, tx);

      // A user who has proved control of their mailbox must not remain locked out by whoever
      // locked them (`LockoutService.clear`'s own doc comment names this flow as its caller).
      const credential = await this.credentialStore.findCredentialByUserId(user.id);
      if (credential !== null) await this.lockout.clear(credential.id, tx);

      return user.id;
    });

    // Every session, with no exception: the person resetting the password is not necessarily
    // holding any of them, and if the account was compromised, all of them are the attacker's.
    await this.sessions.revokeAllForUser(
      userId,
      REVOCATION_REASON.PASSWORD_RESET,
      null,
      null,
      context,
      AUTH_AUDIT_EVENT.PASSWORD_RESET_COMPLETED,
    );
  }

  /**
   * Resolves once every detached background task has settled.
   *
   * A test seam, in the same spirit as T-010's `resetDummyHashForTesting`: `forgotPassword`'s
   * whole correctness argument rests on *not* awaiting its work, so a test has to be able to
   * wait for it some other way. Never called by production code.
   */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  /**
   * Runs the password check and reports the verdict **as a value**.
   *
   * Before T-082 this method translated `InvalidCredentialsError` straight into
   * {@link InvalidCredentialsHttpException} and threw it — from inside the login transaction,
   * which silently rolled back the failed-attempt row and the lockout counter that
   * `CredentialService.authenticate` had just written through the same `tx`. The mapping to HTTP
   * still happens in exactly one place; it just happens in {@link AuthService.login}, after the
   * commit. See ordering note 4 in this file's header.
   *
   * The distinction between the two branches below is the whole point: `InvalidCredentialsError`
   * is a *decision* the credential service reached and recorded, so its writes must survive.
   * Anything else is a *fault* — the writes are not known to be complete or consistent, so the
   * transaction must still roll back, and the error propagates unchanged to the exception filter.
   */
  private async authenticateOrDeny(
    credentials: Credentials,
    context: RequestContext,
    now: Date,
    tx: AuthTransaction,
  ): Promise<AuthenticationOutcome> {
    try {
      const result = await this.credentials.authenticate(
        {
          email: credentials.email,
          password: credentials.password,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          now,
        },
        tx,
      );
      return { status: 'verified', result };
    } catch (error) {
      if (error instanceof InvalidCredentialsError) return { status: 'denied' };
      throw error;
    }
  }

  /** Shared by the self-service change and the reset flow; translates policy violations. */
  private async replacePassword(
    input: {
      userId: number;
      email: string;
      newPassword: string;
      currentPassword?: string;
    },
    tx: AuthTransaction,
  ): Promise<void> {
    try {
      await this.credentials.changePassword(
        {
          userId: input.userId,
          email: input.email,
          newPassword: input.newPassword,
          currentPassword: input.currentPassword,
        },
        tx,
      );
    } catch (error) {
      if (error instanceof PasswordPolicyError) {
        throw new PasswordPolicyHttpException(error.violations);
      }
      if (error instanceof InvalidCredentialsError) {
        throw new InvalidCredentialsHttpException();
      }
      throw error;
    }
  }

  /**
   * Re-hashes at the current Argon2 work factor when the stored digest was made with weaker
   * parameters.
   *
   * Best-effort by design, and swallowing its own errors: a login must not fail because an
   * optimisation did. It writes only `password_hash`/`password_algo` and preserves the existing
   * history, so a rehash is invisible to the reuse check — the *same* password re-hashed must not
   * consume a slot in "your last five passwords".
   */
  private async rehashIfNeeded(credentials: Credentials, userId: number): Promise<void> {
    try {
      const credential = await this.credentialStore.findCredentialByUserId(userId);
      if (credential === null) return;
      if (!this.credentials.needsRehash(credential.passwordHash)) return;

      await this.credentialStore.replacePassword(credential.id, {
        passwordHash: await this.credentials.hash(credentials.password),
        passwordAlgo: PASSWORD_ALGO,
        previousHashes: credential.previousHashes ?? [],
      });
      this.logger.log(`Upgraded stored password hash for user ${userId}`);
    } catch (error) {
      this.logger.error(`Opportunistic rehash failed for user ${userId}: ${asMessage(error)}`);
    }
  }

  private async auditLoginSuccess(
    user: AuthUserRow,
    sessionId: string,
    context: RequestContext,
  ): Promise<void> {
    try {
      await this.sessionStore.writeAuditEvent({
        eventType: AUTH_AUDIT_EVENT.LOGIN_SUCCEEDED,
        actorId: user.id,
        actorRole: user.role,
        targetType: 'portal_session',
        targetId: sessionId,
        countryId: user.countryId,
        tenantId: user.tenantId,
        ipAddress: context.ipAddress,
        detail: null,
      });
    } catch (error) {
      // T-014 implementation note 4: an audit outage must not fail the request.
      this.logger.error(`Failed to audit login for user ${user.id}: ${asMessage(error)}`);
    }
  }

  /**
   * Hands a freshly-minted reset token to a delivery channel.
   *
   * There is none in v1 (see `forgotPassword`), so this logs that a reset was issued — **and
   * deliberately does not log the token**, which is a live credential for the next hour. A
   * "temporary" debug line printing it would put an account-takeover primitive into every log
   * aggregator the portal ever ships to.
   */
  private async deliverPasswordReset(userId: number, rawToken: string): Promise<void> {
    void rawToken;
    this.logger.log(
      `Password reset issued for user ${userId}; no delivery channel is configured (T-046).`,
    );
  }

  /** Runs detached work, recording it so {@link whenIdle} can wait and errors cannot escape. */
  private schedule(work: () => Promise<void>): void {
    const task = work()
      .catch((error: unknown) => {
        this.logger.error(`Background auth task failed: ${asMessage(error)}`);
      })
      .finally(() => {
        this.pending.delete(task);
      });
    this.pending.add(task);
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
