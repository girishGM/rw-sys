/**
 * T-010 — hashing, verification and the login decision (Implementation notes §1–2, §7,
 * 02-SECURITY.md §2).
 *
 * ### The property this whole file is shaped around
 *
 * *An unauthenticated caller must not be able to tell whether an email address has an
 * account.* Everything else here is ordinary; this is the part that is easy to get wrong and
 * hard to notice having got wrong, because a system with the oracle wide open behaves
 * identically to one without it in every functional test you would think to write.
 *
 * Three separate mechanisms enforce it, and all three are required:
 *
 *  1. **One Argon2 verification on every path.** `authenticate()` runs exactly one
 *     `argon2.verify` whatever it found — against the stored hash when there is one, against
 *     a module-level dummy hash when there is not. Skipping the hash for unknown addresses
 *     would make login latency a membership test: ~40 ms for a real account, ~1 ms for an
 *     invented one, readable over the network without any special access. TC-4 measures this.
 *  2. **One database round trip on every path.** The user and credential rows are fetched in
 *     a single LEFT JOIN, so "known address" does not perform strictly more queries than
 *     "unknown address" — see `credential.repository.ts`.
 *  3. **One error type, with no discriminator, for every cause.** Unknown address, wrong
 *     password, locked, inactive and no-credential-row all throw the *same*
 *     `InvalidCredentialsError` with the same frozen message. TC-18 and TC-20 pin this down;
 *     `auth.errors.ts` explains why the type has no `code` field and must never gain one.
 *
 * The `failure_code` that distinguishes those causes goes to `portal_login_attempts`, for
 * operators, and travels no further (Implementation notes §6).
 *
 * ### What this service does *not* do
 *
 * It mints nothing, sets no cookie and creates no session — T-011 owns all of that and calls
 * `authenticate()` as its first step. It also never decides that a user is authorised for
 * anything; `role` and the scope triple are returned as facts read from `portal_users` so
 * T-011 can mint them into the JWT, which is the only place downstream code is allowed to
 * read them from (R3).
 */
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import {
  ARGON2_OPTIONS,
  PASSWORD_ALGO,
  PASSWORD_HISTORY_SIZE,
  PASSWORD_MAX_LENGTH,
  type LoginFailureCode,
} from '../auth.constants';
import {
  CredentialNotFoundError,
  InvalidCredentialsError,
  PasswordPolicyError,
} from '../auth.errors';
import {
  CREDENTIAL_STORE,
  type AuthTransaction,
  type AuthUserRow,
  type AuthenticationRecord,
  type CredentialStore,
} from './credential.repository';
import { LockoutService, type AttemptRegistration } from './lockout.service';
import { PasswordPolicyService } from './password-policy.service';

/** The only `portal_users.status` that may authenticate (02-SECURITY.md §2, step 3). */
export const ACTIVE_USER_STATUS = 'active';

export interface AuthenticateInput {
  readonly email: string;
  readonly password: string;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  /** Overridable clock, so lockout behaviour is testable without waiting 15 real minutes. */
  readonly now?: Date;
}

export interface AuthenticationResult {
  readonly user: AuthUserRow;
  /**
   * True when the account is flagged for a forced change *or* its password has passed
   * `password_expires_at`. Both mean the same thing to T-011's
   * `PasswordChangeRequiredGuard` — the session is confined to `/auth/change-password` and
   * `/auth/logout` — so they are collapsed here rather than leaving the expiry column to be
   * rediscovered and half-implemented by a later caller.
   */
  readonly mustChangePassword: boolean;
  /**
   * True when the stored hash was produced with weaker parameters than `ARGON2_OPTIONS`.
   * The plaintext is only available during a successful login, so that is the one moment an
   * upgrade is possible; T-011 re-hashes opportunistically on this flag.
   */
  readonly rehashRequired: boolean;
}

export interface ChangePasswordInput {
  /** From a verified session or a validated single-use reset token — never from a body. */
  readonly userId: number;
  readonly newPassword: string;
  /**
   * When supplied, it is verified before anything changes. Self-service changes must pass
   * it; an admin-driven or reset-token-driven change legitimately has no current password to
   * offer, and the authority for those flows is checked by their own guards in T-011.
   */
  readonly currentPassword?: string;
  /** The account's email, for the policy's local-part rule. */
  readonly email?: string | null;
}

/**
 * A hash of a value nobody knows, computed once per process, used only so that the
 * unknown-address path costs the same as the known-address path.
 *
 * **Why it is generated rather than hard-coded.** A checked-in digest would be a constant
 * that looks exactly like a leaked credential to every scanner and every reviewer (and would
 * trip `npm run scan:secrets`), and it would be identical across deployments. Generated from
 * `randomBytes(32)` at first use, it is a hash of a 256-bit value that is never stored,
 * never logged and never leaves this module — no password can match it, so no login can
 * succeed through this path even if the "unknown user" branch were ever mis-wired.
 *
 * **Why a memoised promise.** `argon2.hash` is async and Node's CommonJS output has no
 * top-level `await`, so it cannot be a plain `const`. Memoising the *promise* rather than
 * the value means concurrent first-callers share one computation instead of racing to do the
 * work several times over. `CredentialService.onModuleInit` warms it at boot so the very
 * first unknown-address login does not pay the one-off hashing cost and stand out from
 * every subsequent one — which would be the timing oracle, once.
 */
let dummyHashPromise: Promise<string> | null = null;

function dummyHash(): Promise<string> {
  dummyHashPromise ??= argon2.hash(randomBytes(32).toString('hex'), ARGON2_OPTIONS);
  return dummyHashPromise;
}

/** Test-only seam: forces the next `dummyHash()` call to recompute. Not used in production. */
export function resetDummyHashForTesting(): void {
  dummyHashPromise = null;
}

@Injectable()
export class CredentialService implements OnModuleInit {
  constructor(
    @Inject(CREDENTIAL_STORE) private readonly store: CredentialStore,
    private readonly policy: PasswordPolicyService,
    private readonly lockout: LockoutService,
  ) {}

  /** Warms the dummy hash at boot — see its comment for why that matters. */
  async onModuleInit(): Promise<void> {
    await dummyHash();
  }

  /** Argon2id at the `ARGON2_OPTIONS` work factor. The salt is random per call (TC-5). */
  async hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  /**
   * Constant-work password comparison.
   *
   * Passing `null` for `hash` is the unknown-account case: the verification still runs, in
   * full, against the dummy hash, and the answer is then forced to `false`. It is forced
   * rather than merely expected-to-be-false so that this method cannot return `true` for a
   * caller that has no stored hash, under any circumstances including a future refactor.
   *
   * Over-long inputs are truncated before hashing and then failed outright. Argon2's cost is
   * dominated by `memoryCost`, so this is not a meaningful CPU saving on its own — it is a
   * bound on work that an unauthenticated caller can request, on the one route that is
   * reachable before authentication (see `ARGON2_OPTIONS`, note 2). Truncating without
   * failing would be a genuine vulnerability: it would make every password sharing its first
   * 256 characters equivalent.
   */
  async verify(hash: string | null, password: string): Promise<boolean> {
    const overLength = password.length > PASSWORD_MAX_LENGTH;
    const candidate = overLength ? password.slice(0, PASSWORD_MAX_LENGTH) : password;
    const digest = hash ?? (await dummyHash());

    let matched: boolean;
    try {
      matched = await argon2.verify(digest, candidate);
    } catch {
      // A digest Argon2 cannot parse — a corrupt column, or a row written by some other
      // algorithm. Never a successful login, and never a 500 either: an exception escaping
      // here would answer "this account exists but its hash is broken", which is exactly the
      // kind of distinguishable response the rest of this file removes.
      matched = false;
    }

    return matched && hash !== null && !overLength;
  }

  /** Whether a stored digest was produced with weaker parameters than the current baseline. */
  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, ARGON2_OPTIONS);
    } catch {
      // Unparseable digests cannot be assessed, so treat them as due for replacement.
      return true;
    }
  }

  /**
   * The login decision. Throws {@link InvalidCredentialsError} — and nothing else — for
   * every possible failure.
   *
   * `tx` is Implementation notes §5's "in the same transaction as the login": T-011 opens
   * one transaction covering session creation and passes it here, so the attempt row and the
   * counter reset commit with the session or not at all. Called without one, each write is
   * its own transaction, which is correct but not atomic with anything downstream.
   */
  async authenticate(
    input: AuthenticateInput,
    tx?: AuthTransaction,
  ): Promise<AuthenticationResult> {
    const now = input.now ?? new Date();
    const record = await this.store.findAuthenticationRecordByEmail(input.email);

    // Step 1 — always exactly one Argon2 verification, whatever the lookup found. This line
    // must stay above the classification below: moving it inside a branch is precisely the
    // enumeration bug this service exists to prevent.
    const passwordMatches = await this.verify(
      record?.credential?.passwordHash ?? null,
      input.password,
    );

    const registration: AttemptRegistration = {
      email: input.email,
      userId: record?.user.id ?? null,
      credential: record?.credential ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      now,
    };

    // Step 2 — classify. The code chosen here reaches `portal_login_attempts` and stops
    // there; the caller gets one undifferentiated error either way.
    const failureCode = this.classifyFailure(record, passwordMatches, now);

    if (failureCode !== null) {
      await this.lockout.registerFailure(registration, failureCode, tx);
      throw new InvalidCredentialsError();
    }

    await this.lockout.registerSuccess(registration, tx);

    // Non-null by construction: `classifyFailure` returns 'unknown_user'/'no_credential'
    // unless both are present, so reaching here means both are.
    const { user, credential } = record as AuthenticationRecord & {
      credential: NonNullable<AuthenticationRecord['credential']>;
    };

    return {
      user,
      mustChangePassword:
        user.mustChangePassword ||
        (credential.passwordExpiresAt !== null &&
          credential.passwordExpiresAt.getTime() <= now.getTime()),
      rehashRequired: this.needsRehash(credential.passwordHash),
    };
  }

  /**
   * Replaces a password, enforcing the full policy and maintaining the history window
   * (Implementation notes §3–4).
   *
   * Unlike `authenticate`, this method reports *why* it refused — see the asymmetry note in
   * `password-policy.service.ts`. It does not clear a lockout; `LockoutService.clear()` is a
   * separate, explicit call for the flows entitled to make it.
   */
  async changePassword(input: ChangePasswordInput, tx?: AuthTransaction): Promise<void> {
    const credential = await this.store.findCredentialByUserId(input.userId);
    if (credential === null) throw new CredentialNotFoundError(input.userId);

    if (input.currentPassword !== undefined) {
      const currentMatches = await this.verify(credential.passwordHash, input.currentPassword);
      // The same undifferentiated error the login path uses: this branch is reachable by
      // anyone holding a session, and "your current password is wrong" is the only thing it
      // could usefully say anyway.
      if (!currentMatches) throw new InvalidCredentialsError();
    }

    const violations = await this.policy.validate(input.newPassword, {
      email: input.email ?? null,
      currentHash: credential.passwordHash,
      previousHashes: credential.previousHashes,
    });
    if (violations.length > 0) throw new PasswordPolicyError(violations);

    const passwordHash = await this.hash(input.newPassword);

    // The outgoing hash goes to the front of the history and the window is trimmed to
    // PASSWORD_HISTORY_SIZE, so the oldest entry falls off (TC-12: the 6th-oldest password
    // becomes available again, which is what "the last 5" means).
    const previousHashes = [credential.passwordHash, ...(credential.previousHashes ?? [])].slice(
      0,
      PASSWORD_HISTORY_SIZE,
    );

    await this.store.replacePassword(
      credential.id,
      { passwordHash, passwordAlgo: PASSWORD_ALGO, previousHashes },
      tx,
    );
  }

  /**
   * The failure ordering, which is deliberate:
   *
   *  - **`locked` is checked before the password.** A correct password must not unlock an
   *    account or shorten its lock (TC-15). Checking it after would let an attacker who
   *    guesses correctly during a lockout learn that they guessed correctly, which is the
   *    whole thing lockout is defending.
   *  - **`bad_password` is checked before `inactive`.** Both produce the identical error, so
   *    this only changes the operator-facing code — and a brute-force run against a disabled
   *    account should read as `bad_password` in `portal_login_attempts`, not be flattened
   *    into `inactive` and lose the signal that someone is guessing.
   */
  private classifyFailure(
    record: AuthenticationRecord | null,
    passwordMatches: boolean,
    now: Date,
  ): LoginFailureCode | null {
    if (record === null) return 'unknown_user';
    if (record.credential === null) return 'no_credential';
    if (this.lockout.isLocked(record.credential, now)) return 'locked';
    if (!passwordMatches) return 'bad_password';
    if (record.user.status !== ACTIVE_USER_STATUS) return 'inactive';

    return null;
  }
}
