/**
 * T-010 — failed-attempt counting, lockout with back-off, and the `portal_login_attempts`
 * forensic trail (Implementation notes §5–6, 02-SECURITY.md §2).
 *
 * ### The one thing this service must never do
 *
 * Nothing here returns a value that tells the caller *why* a login failed, or whether an
 * account is locked. `CredentialService` decides; this service records and counts. The
 * `failure_code` written to `portal_login_attempts` is operator-only data — Implementation
 * notes §6 — and the mechanism that keeps it operator-only is that it is passed *in* to this
 * service and never handed back out.
 *
 * ### How the back-off actually works
 *
 * `failed_attempts` counts consecutive failures and is reset only by a successful login.
 * A lock is set at each exact multiple of `LOCKOUT_THRESHOLD` — 5, 10, 15, 20 — and the
 * duration comes from `LOCKOUT_BACKOFF_MINUTES` indexed by which multiple was reached:
 *
 * | `failed_attempts` | lock set? | duration |
 * |---|---|---|
 * | 1–4 | no | — |
 * | 5 | yes | 15 min |
 * | 6–9 | no (the 15-min lock has already expired by then) | — |
 * | 10 | yes | 30 min |
 * | 15 | yes | 60 min |
 * | 20 and every 5 after | yes | 120 min |
 *
 * Two deliberate consequences, both worth understanding before changing the rule:
 *
 *  1. **A lock is set at the multiple, not at "≥ threshold".** If every failure past 5
 *     re-locked, the counter would never advance past the first cycle and the back-off in
 *     Implementation notes §5 could never be reached — TC-17 is what pins this down.
 *  2. **Attempts made *while* locked do not increment the counter.** Otherwise an attacker
 *     who knows an address can hold that account locked indefinitely by failing once every
 *     few minutes, escalating the victim to the 120-minute tier and keeping them there. The
 *     attempt is still written to `portal_login_attempts` with `failure_code = 'locked'`, so
 *     the behaviour is fully visible to operators — it is not counted, not unseen.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  LOCKOUT_BACKOFF_MINUTES,
  LOCKOUT_THRESHOLD,
  type LoginFailureCode,
} from '../auth.constants';
import {
  CREDENTIAL_STORE,
  type AuthTransaction,
  type CredentialStore,
} from './credential.repository';

const MILLISECONDS_PER_MINUTE = 60_000;

/** The two columns lockout reasons about, so callers can pass a partial credential row. */
export interface LockableCredential {
  readonly id: number;
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
}

/** What the caller knows about an attempt at the point it is recorded. */
export interface AttemptRegistration {
  /** As submitted by the client — forensic data, stored unnormalised. */
  readonly email: string;
  readonly userId: number | null;
  /** `null` when the address matched no account, or the account has no credential row. */
  readonly credential: LockableCredential | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  /** Injected by the caller so one login decision uses one consistent clock. */
  readonly now: Date;
}

@Injectable()
export class LockoutService {
  constructor(@Inject(CREDENTIAL_STORE) private readonly store: CredentialStore) {}

  /**
   * Whether the account is locked *right now*.
   *
   * An absent credential row is not locked — there is nothing to lock. The comparison is
   * strictly greater-than, so the instant `locked_until` passes the account is usable again
   * (TC-16) without waiting for a sweep job.
   */
  isLocked(credential: Pick<LockableCredential, 'lockedUntil'> | null, now: Date): boolean {
    if (credential === null || credential.lockedUntil === null) return false;
    return credential.lockedUntil.getTime() > now.getTime();
  }

  /**
   * Minutes the lock triggered at `failedAttempts` should last. The final tier repeats
   * forever rather than growing without bound — an unbounded back-off is indistinguishable
   * from account deletion, and recovering from it needs an operator either way.
   */
  backoffMinutesFor(failedAttempts: number): number {
    const cycle = Math.floor(failedAttempts / LOCKOUT_THRESHOLD);
    const index = Math.min(Math.max(cycle - 1, 0), LOCKOUT_BACKOFF_MINUTES.length - 1);
    return LOCKOUT_BACKOFF_MINUTES[index];
  }

  /**
   * The new `locked_until` for a given consecutive-failure count, or `null` when this
   * failure does not trigger a lock. Pure — the caller supplies the clock.
   */
  lockUntilFor(failedAttempts: number, now: Date): Date | null {
    if (failedAttempts <= 0) return null;
    if (failedAttempts % LOCKOUT_THRESHOLD !== 0) return null;

    return new Date(
      now.getTime() + this.backoffMinutesFor(failedAttempts) * MILLISECONDS_PER_MINUTE,
    );
  }

  /**
   * Records a failed attempt and advances the counter.
   *
   * The `portal_login_attempts` row is written on **every** call, including for an address
   * that matches no account and including while the account is already locked — that table
   * is the only place a credential-stuffing run against non-existent addresses becomes
   * visible. The counter advances only when there is a credential row to advance and the
   * failure was not itself "already locked" (see this file's header).
   */
  async registerFailure(
    registration: AttemptRegistration,
    failureCode: LoginFailureCode,
    tx?: AuthTransaction,
  ): Promise<void> {
    await this.store.recordLoginAttempt(
      {
        email: registration.email,
        userId: registration.userId,
        success: false,
        failureCode,
        ipAddress: registration.ipAddress,
        userAgent: registration.userAgent,
      },
      tx,
    );

    const { credential } = registration;
    if (credential === null || failureCode === 'locked') return;

    const failedAttempts = credential.failedAttempts + 1;
    const triggeredLock = this.lockUntilFor(failedAttempts, registration.now);

    await this.store.updateLockState(
      credential.id,
      {
        failedAttempts,
        // Keep the existing timestamp when this failure did not trigger a new lock, rather
        // than nulling it: it is a historical fact, and `isLocked` already treats an expired
        // timestamp as unlocked.
        lockedUntil: triggeredLock ?? credential.lockedUntil,
      },
      tx,
    );
  }

  /**
   * Records a successful attempt and clears the counter.
   *
   * `tx` is what Implementation notes §5's "in the same transaction as the login" means:
   * T-011 opens one transaction for session creation and passes it here, so a login that
   * fails to mint a session does not leave the counter reset behind it.
   */
  async registerSuccess(registration: AttemptRegistration, tx?: AuthTransaction): Promise<void> {
    await this.store.recordLoginAttempt(
      {
        email: registration.email,
        userId: registration.userId,
        success: true,
        failureCode: null,
        ipAddress: registration.ipAddress,
        userAgent: registration.userAgent,
      },
      tx,
    );

    if (registration.credential === null) return;

    await this.clear(registration.credential.id, tx);
  }

  /**
   * Drops a lockout and its counter outright.
   *
   * Exists as its own operation, rather than being folded into "the password changed", so
   * that unlocking an account is always an explicit line at a call site a reviewer can see.
   * The password-reset flow (T-011) is the intended caller: a user who has proved control of
   * their mailbox should not stay locked out by the attacker who locked them.
   */
  async clear(credentialId: number, tx?: AuthTransaction): Promise<void> {
    await this.store.updateLockState(credentialId, { failedAttempts: 0, lockedUntil: null }, tx);
  }
}
