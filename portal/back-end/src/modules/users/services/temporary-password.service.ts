/**
 * T-046 — the general-purpose "generate, expire, rate-limit, audit" service the temporary-password
 * feature needs, generalising the copy `user-temporary-password.ts`'s own header already flagged
 * this task would replace (that file's raw `generateTemporaryPassword` is still the CSPRNG
 * primitive underneath — this service wraps it, it does not duplicate it).
 *
 * Three responsibilities, none of which `UsersService.create()`/`resetPassword()` had before this
 * task, and none of which belongs in the auth module (`back-end/src/modules/auth/**`, outside this
 * task's file scope, AGENT-PROTOCOL R9 — see {@link setCredentialExpiry}'s own comment for exactly
 * where that boundary bites):
 *
 *  1. **Rate limiting** (implementation note 7) — 20 generations per admin per hour, shared by
 *     `create()` and `resetPassword()` since both mint a credential. Uses the same
 *     {@link ThrottleStore} `RevealService` (T-017) already uses for its own per-user limit —
 *     `SecurityModule` (T-012) exports the token; this module imports that module for it,
 *     the same way `DataProtectionModule` already does, rather than reaching into
 *     `common/security/**` to build a second counter mechanism. **Fails closed**: an unavailable
 *     counter store means "cannot currently prove this admin is under budget", and for a control
 *     whose whole point is limiting how many credentials a possibly-compromised admin account can
 *     mint, admitting the request anyway would be exactly backwards (the same reasoning
 *     `reveal.service.ts#charge` gives for its own fail-closed choice).
 *  2. **Expiry** (implementation note 5) — `now() + 72h`, applied to the credential row two
 *     different ways because `create()` and `resetPassword()` reach `portal_user_credentials`
 *     two different ways: `create()` INSERTs it directly (`users.service.ts#insertCredential`
 *     already does, this task only adds the column); `resetPassword()` goes through
 *     `CredentialService.changePassword()` (T-010), whose `replacePassword()` UPDATE never touches
 *     `password_expires_at` at all — so {@link setCredentialExpiry} runs a second, explicit,
 *     parameterised UPDATE afterwards, in the same transaction. That is not a workaround; it is
 *     the same "raw, parameterised SQL against this one table" technique
 *     `users.service.ts#insertCredential`'s own header already establishes and justifies for
 *     exactly this table, for exactly this reason (`PortalUserCredential`'s scope strategy denies
 *     every role).
 *  3. **Audit** (implementation note 6) — one `temporary_password_issued` row per issuance, actor
 *     and target and time, never the value. Written in addition to, not instead of, the
 *     request-level `user_created`/`user_password_reset` events `@Audit()` already records on the
 *     two controller routes — see `users.constants.ts`'s own comment on
 *     {@link TEMPORARY_PASSWORD_ISSUED_AUDIT_EVENT} for the `reveal.controller.ts` precedent this
 *     mirrors.
 */
import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { AuditService } from '@/common/audit/audit.service';
import { THROTTLE_STORE, type ThrottleStore } from '@/common/security/throttle.store';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { generateTemporaryPassword } from '../user-temporary-password';
import {
  TEMPORARY_PASSWORD_ISSUED_AUDIT_EVENT,
  TEMPORARY_PASSWORD_LENGTH,
  TEMPORARY_PASSWORD_RATE_LIMIT_PER_HOUR,
  TEMPORARY_PASSWORD_RATE_LIMIT_WINDOW_MS,
  TEMPORARY_PASSWORD_TTL_MS,
} from '../users.constants';
import { TemporaryPasswordRateLimitedError } from '../users.errors';

export interface IssuedTemporaryPassword {
  readonly password: string;
  readonly expiresAt: Date;
}

@Injectable()
export class TemporaryPasswordService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    @Inject(THROTTLE_STORE) private readonly throttle: ThrottleStore,
    private readonly audit: AuditService,
  ) {}

  /**
   * Generates one temporary password, after charging the actor's rate-limit budget (TC-16: the
   * 21st call in a rolling hour throws before anything is generated). `now` is overridable so the
   * window can be tested without a real hour of wall-clock time, the same seam
   * `CredentialService.authenticate` uses.
   */
  async generate(
    actor: AuthenticatedUser,
    now: Date = new Date(),
  ): Promise<IssuedTemporaryPassword> {
    await this.enforceRateLimit(actor.userId, now);

    return {
      password: generateTemporaryPassword(TEMPORARY_PASSWORD_LENGTH),
      expiresAt: new Date(now.getTime() + TEMPORARY_PASSWORD_TTL_MS),
    };
  }

  /**
   * The disclosure row (implementation note 6). Called once per issuance, after the credential
   * write has succeeded — never for a generation the rate limit refused, and never carrying the
   * password itself.
   */
  async recordIssued(actor: AuthenticatedUser, targetUserId: number): Promise<void> {
    await this.audit.recordPortalEvent({
      eventType: TEMPORARY_PASSWORD_ISSUED_AUDIT_EVENT,
      actorId: actor.userId,
      actorRole: actor.role,
      targetType: 'user',
      targetId: targetUserId,
      countryId: actor.countryId,
      tenantId: actor.tenantId,
    });
  }

  /**
   * `resetPassword()`'s own half of implementation note 5 — see this file's own header for why
   * `CredentialService.changePassword()` cannot set this column itself. Raw, parameterised SQL
   * against `portal_user_credentials`, the one door that table's `deny()` scope strategy actually
   * sanctions (`users.service.ts#insertCredential`'s own comment).
   *
   * ### What "expired" actually does at login — ruled, 2026-08-19, not silently redesigned
   *
   * T-046's own task file originally described a *hard* rejection here ("login after 72 hours
   * without changing → **Rejected**, credential expired"). Verified by reading
   * `CredentialService.authenticate()` and `PasswordChangeRequiredGuard`
   * (`back-end/src/modules/auth/**`, T-010/T-011, outside this task's file scope, AGENT-PROTOCOL
   * R9): what `password_expires_at` *already, deliberately* does once it is set is different —
   * `authenticate()` folds an elapsed `password_expires_at` into `mustChangePassword`, so the
   * login **succeeds** and the resulting session is confined by `PasswordChangeRequiredGuard` to
   * exactly `/auth/change-password` and `/auth/logout` — not rejected outright with a 401. That
   * guard's own header explicitly anticipates this feature by name, and 02-SECURITY.md §2's own
   * login-flow prose describes exactly this confinement for `must_change_password` and no
   * hard-reject path for an expired password at all.
   *
   * **Ruling (T-046 retry, 2026-08-19, AGENT-PROTOCOL §3 — design doc over task prose):** this is
   * the correct, intended shape of the control, not a gap to route around from inside this
   * service. The task file's TC-12/TC-13/verification step 7 have been corrected to describe it
   * (see the task file's own "Resolution note, 2026-08-19"), and `BACKLOG.md` records the ruling
   * plus a narrower, genuinely-scoped follow-up (B-20) for whoever next owns
   * `back-end/src/modules/auth/**` — a real hard-reject needs a new `classifyFailure()` branch
   * *and* an update to `back-end/test/auth/credential.service.spec.ts`'s existing
   * `"reports mustChangePassword when the password has expired"` case, both outside this file's
   * scope, so it is not something this service can or should implement by itself. This service
   * still sets `password_expires_at` correctly and on every issuance, which remains the
   * load-bearing half of the control: the account cannot do anything with an expired temporary
   * password except change it.
   */
  async setCredentialExpiry(
    userId: number,
    expiresAt: Date,
    transaction: Transaction,
  ): Promise<void> {
    await this.sequelize.query(
      `
      UPDATE reward_portal.portal_user_credentials
         SET password_expires_at = :expiresAt,
             updated_at          = now()
       WHERE user_id = :userId
      `,
      {
        type: QueryTypes.UPDATE,
        transaction,
        replacements: { userId, expiresAt },
      },
    );
  }

  private async enforceRateLimit(actorId: number, now: Date): Promise<void> {
    let counter: { count: number };
    try {
      counter = await this.throttle.consume(
        temporaryPasswordThrottleKey(actorId),
        TEMPORARY_PASSWORD_RATE_LIMIT_WINDOW_MS,
        now.getTime(),
      );
    } catch (error) {
      throw new TemporaryPasswordRateLimitedError({
        logMessage:
          `Temporary-password rate-limit counter unavailable for admin ${String(actorId)}: ` +
          `${(error as Error).message}. Refusing to generate (fail-closed) — implementation note ` +
          '7 exists precisely so an unmetered admin cannot mint credentials unnoticed.',
        cause: error,
      });
    }

    if (counter.count > TEMPORARY_PASSWORD_RATE_LIMIT_PER_HOUR) {
      throw new TemporaryPasswordRateLimitedError();
    }
  }
}

/** Exported for the test double / assertion in `temporary-password.spec.ts`. */
export function temporaryPasswordThrottleKey(actorId: number): string {
  return `temp-password:admin:${String(actorId)}`;
}
