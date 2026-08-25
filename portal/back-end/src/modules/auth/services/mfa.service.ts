/**
 * T-055 — the MFA use-cases: enrol, verify, recover, and the administrative reset.
 *
 * `MfaPendingTokenService` owns the challenge *credential*; `totp.ts` owns the *arithmetic*;
 * `SessionService` (T-011) owns the session *mechanism*. This file is the layer that sequences
 * them and decides what the caller is told. It holds no cookie logic and touches no
 * `Request`/`Response` — that is `mfa.controller.ts`'s job — so every rule below is testable
 * without a server.
 *
 * ---
 *
 * ### Four orderings in here are security decisions, not style
 *
 * **1. The live `portal_users` row is re-read on every call, and the pending token's `enrolled`
 * claim is never trusted.** The token is signed, so it cannot be *forged* — but it can be *stale*.
 * A `super_admin` whose MFA was reset by an administrator thirty seconds ago still holds a
 * perfectly valid pending token saying `enrolled: true`; acting on that claim would let them
 * complete a challenge against a seed that has just been revoked. Every method below therefore
 * starts from `MFA_STORE.findUserForMfa`.
 *
 * **2. Enrolment writes the seed but does *not* set `mfa_enabled`.** The flag flips only when a
 * correct code has been presented (TC-1). An enrolment that stopped at "secret written" and set
 * the flag would lock out any user who closed the tab before scanning — and, worse, would let
 * somebody who never proved possession of the device satisfy `MfaRequiredGuard` forever after.
 *
 * **3. Sessions are created only after the factor has been satisfied, never before.** There is no
 * code path in this file that mints a session next to a failure branch; each of the two that do
 * (`verifyChallenge`, `recover`) reaches `SessionService.start` only on its success path, after
 * every check has returned.
 *
 * **4. Every other session is revoked when the factor changes.** Completing an enrolment and
 * having MFA reset by an administrator both mean "this account's authentication requirements just
 * changed"; a session that predates the change was created under the old, weaker ones. Revoking
 * them is what stops an administrative reset from being a *no-op* for whoever is already inside
 * (note 6's whole point), and what stops a session issued before enrolment from being a permanent
 * MFA-free door afterwards.
 *
 * ### What never leaves this file
 *
 * The decrypted TOTP seed. `MfaRepository` returns ciphertext, this service decrypts it inside a
 * single synchronous block, verifies against it, and lets it go — it is never returned, never
 * logged, never placed on a DTO and never handed to another service. The one moment the raw seed
 * is visible to anybody is the enrolment response, exactly once, which is implementation note 2's
 * requirement.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomInt } from 'node:crypto';
import { FieldCryptoService } from '@/common/crypto/field-crypto.service';
import { PermissionDeniedHttpException } from '@/common/rbac/rbac.exceptions';
import type { PortalRole } from '@/database/portal-models';
import {
  InvalidCredentialsHttpException,
  NotFoundHttpException,
  SessionInvalidHttpException,
} from '../auth.exceptions';
import {
  MFA_AUDIT_EVENT,
  MFA_RESET_REVOCATION_REASON,
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_GROUPS,
  RECOVERY_CODE_GROUP_LENGTH,
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_ISSUER,
  TOTP_PERIOD_SECONDS,
} from '../mfa.constants';
import {
  MfaAlreadyEnrolledHttpException,
  MfaEnrolmentRequiredHttpException,
} from '../mfa.exceptions';
import { AUTH_AUDIT_EVENT } from '../session.constants';
import { ACTIVE_USER_STATUS } from './credential.service';
import type { AuthTransaction, AuthUserRow } from './credential.repository';
import { MFA_STORE, type MfaStore, type MfaUserRow } from './mfa.repository';
import { MfaPendingTokenService } from './mfa-pending-token.service';
import { SESSION_STORE, type AuditEventInput, type SessionStore } from './session.repository';
import { SessionService, type IssuedSession, type RequestContext } from './session.service';
import {
  buildOtpauthUri,
  decodeBase32,
  encodeBase32,
  generateTotpSecret,
  verifyTotpCode,
} from './totp';

/** The one-time enrolment payload. Every field here is shown to the user and then discarded. */
export interface EnrolmentOffer {
  /** The seed, base32, for manual entry. Shown **once** (implementation note 2). */
  readonly secret: string;
  /** The same seed as an `otpauth://` URI, which the SPA renders as a QR code. */
  readonly otpauthUri: string;
  readonly issuer: string;
  readonly account: string;
  readonly algorithm: string;
  readonly digits: number;
  readonly periodSeconds: number;
}

/** What a satisfied challenge produces: a real session, exactly as a non-MFA login would. */
export interface MfaLoginResult {
  readonly session: IssuedSession;
  readonly role: PortalRole;
  readonly mustChangePassword: boolean;
  /**
   * The ten recovery codes, **only** on the call that completed an enrolment, and never again
   * (TC-1, TC-18). `undefined` on every ordinary login.
   */
  readonly recoveryCodes?: readonly string[];
  /** How many unused codes remain, on the recovery path (TC-11). */
  readonly recoveryCodesRemaining?: number;
}

/** The AAD every `mfa_secret_enc` ciphertext is bound to. See `field-crypto.service.ts`. */
const USERS_TABLE = 'reward_portal.portal_users';

@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly pendingTokens: MfaPendingTokenService,
    private readonly sessions: SessionService,
    private readonly crypto: FieldCryptoService,
    @Inject(MFA_STORE) private readonly mfa: MfaStore,
    @Inject(SESSION_STORE) private readonly sessionStore: SessionStore,
  ) {}

  /**
   * `POST /auth/mfa/enrol` — mints a seed and shows it once.
   *
   * The seed is written to `mfa_secret_enc` immediately (encrypted, T-016) rather than held in
   * memory until the confirming code arrives: the alternative needs server-side state keyed by
   * the pending token, which is exactly the state note 4 forbids this flow from having. The
   * account stays `mfa_enabled = false` until {@link verifyChallenge} confirms possession, so a
   * written-but-unconfirmed seed grants nothing.
   */
  async beginEnrolment(
    pendingToken: string,
    context: RequestContext,
    now: Date = new Date(),
  ): Promise<EnrolmentOffer> {
    const user = await this.resolveChallengeUser(pendingToken, now);

    // TC-2. The seed is shown once; a second look requires an administrative reset.
    if (user.mfaEnabled) throw new MfaAlreadyEnrolledHttpException();

    const secret = generateTotpSecret();
    const secretBase32 = encodeBase32(secret);

    await this.mfa.storeSecret(
      user.id,
      this.crypto.encrypt(secretBase32, { aad: FieldCryptoService.aadFor(USERS_TABLE, user.id) }),
    );

    await this.audit({
      eventType: MFA_AUDIT_EVENT.ENROLMENT_STARTED,
      actorId: user.id,
      actorRole: user.role,
      targetType: 'portal_user',
      targetId: String(user.id),
      countryId: user.countryId,
      tenantId: user.tenantId,
      ipAddress: context.ipAddress,
      detail: null,
    });

    return {
      secret: secretBase32,
      otpauthUri: buildOtpauthUri({
        issuer: TOTP_ISSUER,
        account: user.email,
        secretBase32,
      }),
      issuer: TOTP_ISSUER,
      account: user.email,
      algorithm: TOTP_ALGORITHM.toUpperCase(),
      digits: TOTP_DIGITS,
      periodSeconds: TOTP_PERIOD_SECONDS,
    };
  }

  /**
   * `POST /auth/mfa/verify` — the step-up itself, and the second half of enrolment.
   *
   * One endpoint serves both because they are the same act: *prove you hold the device*. The only
   * difference is what a success means — on an unenrolled account it completes the enrolment and
   * returns the ten recovery codes (TC-1); on an enrolled one it simply logs the user in (TC-6).
   * Splitting them would mean two routes with identical verification logic and one of them
   * reachable in the wrong state.
   */
  async verifyChallenge(
    input: { pendingToken: string; code: string },
    context: RequestContext,
    now: Date = new Date(),
  ): Promise<MfaLoginResult> {
    const user = await this.resolveChallengeUser(input.pendingToken, now);

    const secret = this.readSecret(user);
    if (secret === null || !verifyTotpCode(secret, input.code, now)) {
      await this.auditFailure(user, context, secret === null ? 'no_secret' : 'bad_code');
      // 02-SECURITY.md §2a: one generic 401 for every failure on this route.
      throw new InvalidCredentialsHttpException();
    }

    const completingEnrolment = !user.mfaEnabled;
    let recoveryCodes: readonly string[] | undefined;

    if (completingEnrolment) {
      const codes = generateRecoveryCodes();
      await this.sessionStore.runInTransaction(async (tx) => {
        await this.mfa.enableMfa(user.id, tx);
        // Any leftover codes from an abandoned earlier enrolment die with it — a code minted
        // against a seed that no longer exists must not open the account.
        await this.mfa.invalidateRecoveryCodes(user.id, now, tx);
        await this.mfa.insertRecoveryCodes(user.id, codes.hashes, tx);
      });
      recoveryCodes = codes.display;

      // See this file's header, ordering note 4. Before the new session is created, so the
      // session this call is about to mint is not itself revoked.
      await this.revokeSessionsAfterFactorChange(user, context);

      await this.audit({
        eventType: MFA_AUDIT_EVENT.ENROLLED,
        actorId: user.id,
        actorRole: user.role,
        targetType: 'portal_user',
        targetId: String(user.id),
        countryId: user.countryId,
        tenantId: user.tenantId,
        ipAddress: context.ipAddress,
        detail: { recoveryCodesIssued: codes.display.length },
      });
    }

    const session = await this.startSession(user, context, now);

    await this.audit({
      eventType: MFA_AUDIT_EVENT.VERIFIED,
      actorId: user.id,
      actorRole: user.role,
      targetType: 'portal_session',
      targetId: session.sessionId,
      countryId: user.countryId,
      tenantId: user.tenantId,
      ipAddress: context.ipAddress,
      detail: { method: 'totp', completedEnrolment: completingEnrolment },
    });

    return {
      session,
      role: user.role,
      mustChangePassword: session.mustChangePassword,
      recoveryCodes,
    };
  }

  /**
   * `POST /auth/mfa/recover` — one single-use recovery code, for a lost device.
   *
   * Only an **enrolled** account can recover: an unenrolled one has no factor to be locked out
   * of, and any code it might still hold belongs to an enrolment that has since been reset. That
   * check is what stops a stale recovery code from being an MFA bypass after an administrative
   * reset (which invalidates the codes as well, so this is the second of two layers).
   */
  async recover(
    input: { pendingToken: string; recoveryCode: string },
    context: RequestContext,
    now: Date = new Date(),
  ): Promise<MfaLoginResult> {
    const user = await this.resolveChallengeUser(input.pendingToken, now);
    if (!user.mfaEnabled) {
      await this.auditFailure(user, context, 'not_enrolled');
      throw new InvalidCredentialsHttpException();
    }

    const outcome = await this.mfa.consumeRecoveryCode(
      user.id,
      hashRecoveryCode(input.recoveryCode),
      now,
    );

    if (outcome !== 'consumed') {
      await this.audit({
        // TC-12: a *reuse* is an alarm, not merely a rejection — somebody other than the owner
        // may be reading the printed list. An unknown code is a wrong guess and is logged as one.
        eventType:
          outcome === 'already_used'
            ? MFA_AUDIT_EVENT.RECOVERY_REUSE
            : MFA_AUDIT_EVENT.VERIFY_FAILED,
        actorId: user.id,
        actorRole: user.role,
        targetType: 'portal_user',
        targetId: String(user.id),
        countryId: user.countryId,
        tenantId: user.tenantId,
        ipAddress: context.ipAddress,
        // The code itself never appears, not even hashed — a digest in the audit log is a
        // dictionary attack away from the code, and the log is readable by more people.
        detail: { method: 'recovery_code', outcome },
      });
      throw new InvalidCredentialsHttpException();
    }

    const session = await this.startSession(user, context, now);
    const remaining = await this.mfa.countUnusedRecoveryCodes(user.id);

    await this.audit({
      eventType: MFA_AUDIT_EVENT.RECOVERY_USED,
      actorId: user.id,
      actorRole: user.role,
      targetType: 'portal_session',
      targetId: session.sessionId,
      countryId: user.countryId,
      tenantId: user.tenantId,
      ipAddress: context.ipAddress,
      detail: { remainingRecoveryCodes: remaining },
    });

    return {
      session,
      role: user.role,
      mustChangePassword: session.mustChangePassword,
      recoveryCodesRemaining: remaining,
    };
  }

  /**
   * `POST /admin/access-control/super-admins/:id/mfa-reset` — implementation note 6.
   *
   * The high-consequence path: it removes a second factor from an account that can reconfigure
   * what every other role may do. Four conditions, all of them denials:
   *
   *  - **the actor's own MFA must be satisfied.** Re-read live, not taken from the session: "a
   *    session that itself skipped MFA must not be able to reset someone else's" (note 6). In
   *    this build a live `super_admin` session can only exist downstream of a satisfied
   *    challenge, so this is the second of two layers — and it is the one that would still hold
   *    if `MfaRequiredGuard` were ever removed from the chain;
   *  - **no self-reset.** Note 6 says "executed by another `super_admin`". An account that could
   *    clear its own factor could clear it *because* it had been compromised, which is precisely
   *    the situation the factor exists for;
   *  - **the target must exist and be a `super_admin`**, answered as 404 either way
   *    (02-SECURITY.md §5.1) — a 403 for "that user is not a super_admin" is a membership oracle;
   *  - **the target's sessions die.** Otherwise a reset is invisible to whoever is already logged
   *    in with the factor being revoked.
   */
  async resetByAdmin(
    actor: { userId: number; role: PortalRole },
    targetUserId: number,
    context: RequestContext,
    now: Date = new Date(),
  ): Promise<void> {
    const actorMfaEnabled = await this.mfa.isMfaEnabled(actor.userId);
    if (actorMfaEnabled !== true) {
      this.logger.warn(
        `Super admin ${actor.userId} attempted an MFA reset without a satisfied factor of their own`,
      );
      throw new MfaEnrolmentRequiredHttpException();
    }

    if (targetUserId === actor.userId) {
      // 403, not the 404 an unknown target gets: the caller plainly knows this account exists, so
      // there is nothing to conceal, and "you may not do this to yourself" is the honest answer.
      this.logger.warn(`Super admin ${actor.userId} attempted to reset their own MFA`);
      throw new PermissionDeniedHttpException();
    }

    const target = await this.mfa.findUserForMfa(targetUserId);
    if (target === null || target.role !== 'super_admin') throw new NotFoundHttpException();

    await this.sessionStore.runInTransaction(async (tx) => {
      await this.mfa.clearMfa(target.id, tx);
      await this.mfa.invalidateRecoveryCodes(target.id, now, tx);
    });

    await this.sessions.revokeAllForUser(
      target.id,
      MFA_RESET_REVOCATION_REASON,
      null,
      actor,
      context,
      MFA_AUDIT_EVENT.SESSIONS_REVOKED,
    );

    await this.audit({
      eventType: MFA_AUDIT_EVENT.RESET_BY_ADMIN,
      actorId: actor.userId,
      actorRole: actor.role,
      targetType: 'portal_user',
      targetId: String(target.id),
      countryId: target.countryId,
      tenantId: target.tenantId,
      ipAddress: context.ipAddress,
      // Both ids, as note 6 requires — `actorId` above and `targetUserId` here, so the row is
      // self-describing even if the target's user row is later deleted and `target_id` is all
      // that survives.
      detail: { actorUserId: actor.userId, targetUserId: target.id },
    });
  }

  /**
   * Resolves the account a pending token names, or refuses.
   *
   * Every refusal is the same `SessionInvalidHttpException`, for the reason that class documents:
   * the SPA's only correct reaction to any of them is "start again at the login screen", and a
   * finer taxonomy would tell a caller probing with forged tokens which check they had got past.
   * The specific cause is logged.
   */
  private async resolveChallengeUser(pendingToken: string, now: Date): Promise<MfaUserRow> {
    const claims = this.pendingTokens.verify(pendingToken, now);
    if (claims === null) {
      this.logger.debug('MFA pending token rejected (invalid, expired or forged)');
      throw new SessionInvalidHttpException();
    }

    const user = await this.mfa.findUserForMfa(claims.userId);
    if (user === null) {
      this.logger.warn(`MFA pending token names user ${claims.userId}, which no longer exists`);
      throw new SessionInvalidHttpException();
    }

    // A deactivated, locked or suspended account cannot complete a challenge, even holding a
    // token minted while it was still active — the status may have changed in those five minutes.
    if (user.status !== ACTIVE_USER_STATUS) {
      this.logger.warn(`MFA challenge refused: user ${user.id} is ${user.status}`);
      throw new SessionInvalidHttpException();
    }

    // Not producible by `TotpStepUpHook`, which mints a token only for `super_admin`. Checked
    // anyway: this flow enables `mfa_enabled` and creates sessions, and neither should be
    // reachable for a role whose MFA is out of scope (`BACKLOG.md` B-02).
    if (user.role !== 'super_admin') {
      this.logger.error(`MFA pending token names non-super_admin user ${user.id} — refusing`);
      throw new SessionInvalidHttpException();
    }

    return user;
  }

  /** Decrypts the stored seed, or `null` when there is none / it will not decrypt. */
  private readSecret(user: MfaUserRow): Buffer | null {
    if (user.secretEnc === null) return null;

    try {
      const base32 = this.crypto.decrypt(user.secretEnc, {
        aad: FieldCryptoService.aadFor(USERS_TABLE, user.id),
      });
      return decodeBase32(base32);
    } catch (error) {
      // A seed that will not decrypt is an operational fault (a rotated-away key, a corrupted
      // column, a row copied between environments), not a wrong code — but the caller is told
      // the same thing either way, because the difference is not theirs to know.
      this.logger.error(
        `mfa_secret_enc for user ${user.id} could not be read: ${(error as Error).name}`,
      );
      return null;
    }
  }

  /** Creates the session a satisfied challenge earns, from the row already read. */
  private async startSession(
    user: MfaUserRow,
    context: RequestContext,
    now: Date,
  ): Promise<IssuedSession> {
    const session = await this.sessionStore.runInTransaction(async (tx: AuthTransaction) =>
      this.sessions.start(toAuthUserRow(user), context, now, tx),
    );

    await this.audit({
      // The same event a password-only login writes, because the same thing happened: a session
      // was created. The `mfa_verified` / `mfa_recovery_used` row beside it says how.
      eventType: AUTH_AUDIT_EVENT.LOGIN_SUCCEEDED,
      actorId: user.id,
      actorRole: user.role,
      targetType: 'portal_session',
      targetId: session.sessionId,
      countryId: user.countryId,
      tenantId: user.tenantId,
      ipAddress: context.ipAddress,
      detail: null,
    });

    return session;
  }

  private async revokeSessionsAfterFactorChange(
    user: MfaUserRow,
    context: RequestContext,
  ): Promise<void> {
    await this.sessions.revokeAllForUser(
      user.id,
      MFA_RESET_REVOCATION_REASON,
      null,
      { userId: user.id, role: user.role },
      context,
      MFA_AUDIT_EVENT.SESSIONS_REVOKED,
    );
  }

  private async auditFailure(
    user: MfaUserRow,
    context: RequestContext,
    reason: string,
  ): Promise<void> {
    await this.audit({
      eventType: MFA_AUDIT_EVENT.VERIFY_FAILED,
      actorId: user.id,
      actorRole: user.role,
      targetType: 'portal_user',
      targetId: String(user.id),
      countryId: user.countryId,
      tenantId: user.tenantId,
      ipAddress: context.ipAddress,
      // A reason code, never the presented value.
      detail: { reason },
    });
  }

  /**
   * Appends to `portal_audit_log` without ever failing the caller (T-014 implementation note 4,
   * the same shape `SessionService.audit` and `AuthService.auditLoginSuccess` already use).
   */
  private async audit(event: AuditEventInput): Promise<void> {
    try {
      await this.sessionStore.writeAuditEvent(event);
    } catch (error) {
      this.logger.error(
        `Failed to write ${event.eventType} to portal_audit_log: ${(error as Error).message}`,
      );
    }
  }
}

// --- recovery codes ---------------------------------------------------------------------------

/**
 * Ten codes, each `xxxx-xxxx-xxxx` from {@link RECOVERY_CODE_ALPHABET}, with their digests.
 *
 * `randomInt` rather than `Math.random` (a CSPRNG, and one that is *uniform* — `randomBytes[i] %
 * 32` would be biased for a non-power-of-two alphabet; ours is 32, so it would not, but writing
 * the biased form and relying on the alphabet's length to save it is how the bias arrives the day
 * somebody drops a character).
 */
export function generateRecoveryCodes(): {
  display: readonly string[];
  hashes: readonly string[];
} {
  const display: string[] = [];
  const hashes: string[] = [];

  for (let index = 0; index < RECOVERY_CODE_COUNT; index += 1) {
    const groups: string[] = [];
    for (let group = 0; group < RECOVERY_CODE_GROUPS; group += 1) {
      let chunk = '';
      for (let character = 0; character < RECOVERY_CODE_GROUP_LENGTH; character += 1) {
        chunk += RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)];
      }
      groups.push(chunk);
    }

    const code = groups.join('-');
    display.push(code);
    hashes.push(hashRecoveryCode(code));
  }

  return { display, hashes };
}

/**
 * SHA-256 of the **normalised** code, hex — 64 characters, inside `code_hash varchar(128)`.
 *
 * Normalisation (uppercase, separators and whitespace removed) is what lets a user type
 * `abcd efgh jkmn` for a code printed as `ABCD-EFGH-JKMN`. It happens on both sides — at
 * generation and at presentation — so the two can never disagree.
 *
 * **Why SHA-256 and not Argon2**, when `password_hash` is Argon2id: a recovery code is 60 bits of
 * uniform CSPRNG output, not a human-chosen password. There is no dictionary to attack and no
 * user-chosen entropy to compensate for, so the slow hash buys nothing an attacker would notice
 * while costing a memory-hard KDF run on a login path. 01-DATABASE.md §2.5a specifies SHA-256 for
 * this column, and this is the reasoning behind it.
 */
export function hashRecoveryCode(raw: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(raw), 'utf8').digest('hex');
}

function normaliseRecoveryCode(raw: string): string {
  return raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

/**
 * Projects the MFA read onto the shape `SessionService.start` consumes.
 *
 * Field by field rather than a spread, so `secretEnc` cannot travel along by accident into a
 * structure that other code passes around freely.
 */
function toAuthUserRow(user: MfaUserRow): AuthUserRow {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    countryId: user.countryId,
    tenantId: user.tenantId,
    merchantId: user.merchantId,
    mustChangePassword: user.mustChangePassword,
    mfaEnabled: user.mfaEnabled,
  };
}
