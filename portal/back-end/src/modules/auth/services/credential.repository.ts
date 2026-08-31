/**
 * T-010 — the credential layer's only door to the database.
 *
 * ### Why this file exists (and is an addition to T-010's declared "Files owned")
 *
 * `CredentialService` and `LockoutService` need to read `portal_users` /
 * `portal_user_credentials` and write `portal_login_attempts`. Putting that I/O behind one
 * named port buys three things that matter for this particular task:
 *
 *  1. **The services become pure decision-makers**, so TC-4's timing comparison measures
 *     Argon2 and nothing else, and every branch the 100% coverage bar demands can be driven
 *     from a fake without a database.
 *  2. **Raw SQL lives in exactly one file**, which a reviewer can read end to end, rather
 *     than being sprinkled through three services.
 *  3. **T-013's `no-raw-model-access` rule gets one narrow path to reason about**, instead
 *     of a blanket exemption for `src/modules/auth/**` that T-011 would then inherit.
 *
 * Recorded as a deviation in the T-010 completion report.
 *
 * ### Why this is not `ScopedRepository`, and is not model statics either
 *
 * `ScopedRepository` (T-013) injects the actor's country/tenant/merchant triple into the
 * WHERE clause, read from the request's `ScopeContext`, and throws when that context is
 * absent. **Authentication runs before any scope exists** — worse, the scope triple is
 * *derived from the very row this query fetches*, and the login lookup is deliberately
 * global (an email identifies one human across every tenant). So `ScopedRepository` is not
 * merely unnecessary here, it is structurally inapplicable, exactly as
 * `src/common/crypto/key-registry.service.ts` already documents for the key registry.
 *
 * The access is therefore raw, parameterised SQL through the shared `Sequelize` instance —
 * the convention `key-registry.service.ts`, `src/common/caps/legacy-budget-sync.ts` and
 * every migration already use. It is deliberately **not** `PortalUser.findOne()`: T-013's
 * lint rule bans model statics outside `src/common/scope/` and `src/database/`, and this
 * file must pass that rule with no `eslint-disable` (R2: "The lint rule that enforces this
 * must not be disabled"). Flagged for the reviewer in the completion report.
 *
 * **Every value reaching SQL below is a bound replacement.** There is no string
 * concatenation into a statement anywhere in this file, and there must never be: the one
 * caller of `findAuthenticationRecordByEmail` passes an unauthenticated stranger's raw input.
 */
import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import type { PortalRole } from '@/database/portal-models';
import {
  LOGIN_ATTEMPT_EMAIL_MAX_LENGTH,
  LOGIN_ATTEMPT_USER_AGENT_MAX_LENGTH,
  type LoginFailureCode,
} from '../auth.constants';

/** Sequelize's transaction handle, re-exported so the services never import Sequelize. */
export type AuthTransaction = Transaction;

/**
 * The subset of `portal_users` authentication needs. Note what is absent: `mfa_secret_enc`
 * is not selected at all (T-055 reads it on its own step-up path, through the field-crypto
 * service), and neither is anything else this task has no use for.
 */
export interface AuthUserRow {
  readonly id: number;
  readonly email: string;
  readonly displayName: string;
  readonly role: PortalRole;
  readonly status: string;
  readonly countryId: number | null;
  readonly tenantId: number | null;
  readonly merchantId: number | null;
  readonly mustChangePassword: boolean;
  readonly mfaEnabled: boolean;
}

/** The subset of `portal_user_credentials` this task reads. */
export interface CredentialRow {
  readonly id: number;
  readonly userId: number;
  readonly passwordHash: string;
  readonly passwordAlgo: string;
  readonly previousHashes: string[] | null;
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
  readonly passwordExpiresAt: Date | null;
}

/**
 * A user and their credential, fetched together in one round trip.
 *
 * One statement rather than two is a timing control, not a performance tweak: the
 * unknown-email path performs one query, so the known-email path must perform one too, or
 * the difference in database work becomes the enumeration signal that the constant-time
 * Argon2 comparison was put there to remove. `credential` is `null` for a user row whose
 * credential row is missing — a half-finished provisioning run, which authenticates as a
 * failure like any other but is logged distinctly for operators.
 */
export interface AuthenticationRecord {
  readonly user: AuthUserRow;
  readonly credential: CredentialRow | null;
}

export interface LoginAttemptInput {
  /** As submitted, before normalisation — this is forensic data, not a lookup key. */
  readonly email: string;
  readonly userId: number | null;
  readonly success: boolean;
  readonly failureCode: LoginFailureCode | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface LockStateUpdate {
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
}

export interface PasswordUpdate {
  readonly passwordHash: string;
  readonly passwordAlgo: string;
  readonly previousHashes: readonly string[];
  /**
   * T-161. Clears `password_expires_at` alongside the hash — the caller is stating that this
   * write is a *genuine password change*, so any forced-change deadline the old password carried
   * is now satisfied.
   *
   * **Optional, and defaulting to "leave it alone", on purpose.** `replacePassword` has two
   * callers and only one of them is a password change:
   *
   *  - `CredentialService.changePassword` — a real change. Passes `true`.
   *  - `AuthService.rehashIfNeeded` — an opportunistic Argon2 work-factor upgrade that happens on
   *    an ordinary login, re-hashing *the same password the user just typed*. It is not a change,
   *    and clearing the deadline there would silently disarm the forced-change control for any
   *    account whose stored hash happened to be due an upgrade: a freshly-issued temporary
   *    password would lose its 72-hour expiry merely by being used to log in once.
   *
   * Making this an explicit flag rather than folding the `NULL` unconditionally into the UPDATE
   * follows the same reasoning {@link CredentialRepository.replacePassword} already gives for not
   * folding in a lockout clear: a security-relevant side effect belongs at the call site where a
   * reviewer can see it, not hidden inside a shared write that every future caller inherits.
   */
  readonly clearPasswordExpiry?: boolean;
}

/**
 * The port the credential services depend on. Declared as an interface so the services can
 * be unit-tested against an in-memory double, and so a future task can swap the storage
 * without touching a line of security logic.
 */
export interface CredentialStore {
  findAuthenticationRecordByEmail(email: string): Promise<AuthenticationRecord | null>;
  findCredentialByUserId(userId: number): Promise<CredentialRow | null>;
  recordLoginAttempt(input: LoginAttemptInput, tx?: AuthTransaction): Promise<void>;
  updateLockState(
    credentialId: number,
    update: LockStateUpdate,
    tx?: AuthTransaction,
  ): Promise<void>;
  replacePassword(
    credentialId: number,
    update: PasswordUpdate,
    tx?: AuthTransaction,
  ): Promise<void>;
  runInTransaction<T>(fn: (tx: AuthTransaction) => Promise<T>): Promise<T>;
}

/**
 * T-059's narrow port. `createCredential` is deliberately **not** on {@link CredentialStore}
 * above: that interface is implemented by `FakeCredentialStore`
 * (`test/auth/support/fake-credential-store.ts`, T-010's owned file, outside this task's file
 * scope — AGENT-PROTOCOL R9), and widening a shared interface's required members is exactly the
 * kind of "no existing behaviour touched" boundary the R9 note for this task promises not to
 * cross. `CredentialRepository` implements this port in addition to `CredentialStore` below;
 * `TenantsService` depends on this interface, not on the concrete class, resolved through the
 * same `CREDENTIAL_STORE` DI token `CredentialService` already uses — NestJS's `@Inject(token)`
 * is not statically checked against the provider's declared type, so annotating the injected
 * parameter with this narrower interface is valid and requires no change to `auth.module.ts`
 * (also outside this task's file scope).
 */
export interface CredentialProvisioner {
  createCredential(
    userId: number,
    passwordHash: string,
    passwordAlgo: string,
    tx?: AuthTransaction,
  ): Promise<void>;
}

/** DI token — the services depend on {@link CredentialStore}, never on the class below. */
export const CREDENTIAL_STORE = Symbol('CREDENTIAL_STORE');

/** Shape of the joined row as Postgres returns it (snake_case, untouched by Sequelize). */
interface RawAuthenticationRow {
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
  credential_id: number | null;
  password_hash: string | null;
  password_algo: string | null;
  previous_hashes: unknown;
  failed_attempts: number | null;
  locked_until: Date | null;
  password_expires_at: Date | null;
}

interface RawCredentialRow {
  id: number;
  user_id: number;
  password_hash: string;
  password_algo: string;
  previous_hashes: unknown;
  failed_attempts: number;
  locked_until: Date | null;
  password_expires_at: Date | null;
}

@Injectable()
export class CredentialRepository implements CredentialStore, CredentialProvisioner {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    /**
     * T-056. Applies the `portal_users.email` at-rest policy on this file's raw-SQL paths, which
     * Sequelize's model hooks never see. See `portal-user-email.crypto.ts` for why one shared
     * object rather than a `FieldCryptoService` call at each site.
     */
    private readonly emailCrypto: PortalUserEmailCrypto,
  ) {}

  /**
   * Looks a user up by email, case-insensitively, together with their credential row.
   *
   * ### T-056 changed the predicate, and deliberately changed nothing else
   *
   * This was `WHERE lower(u.email) = :email`. Since `portal_users.email` is AES-256-GCM at rest,
   * that predicate can no longer match anything: every encryption uses a random IV, so the same
   * address produces different ciphertext on every write and `lower(ciphertext)` is a different
   * string each time. The lookup is now on `email_bidx`, the deterministic blind index, which
   * `uq_portal_users_email_live` also moved onto in the same migration — so this comparison still
   * hits a unique index, exactly as the previous comment required, and for the same reason: an
   * unindexed scan on the login path is both slow and a timing signal that grows with table size.
   *
   * **The single-query shape is preserved, because it is a security control, not an optimisation.**
   * The comment on {@link AuthenticationRecord} states it: the unknown-email path performs one
   * query, so the known-email path must perform one too. The blind index is computed in this
   * process before the statement is issued — identical work for a hit and a miss — so a caller
   * still cannot distinguish "no such account" from "wrong password" by timing the database.
   * This is specifically *not* implemented as "fetch candidates, then decrypt and compare", which
   * would be both a second round trip and a comparison whose cost depends on how many rows matched.
   *
   * `u.deleted_at IS NULL` is not optional: `portal_users` is `paranoid`, and a soft-deleted
   * account must not be able to authenticate. Raw SQL gets none of Sequelize's automatic
   * paranoid filtering, so this predicate *is* the deactivation control.
   */
  async findAuthenticationRecordByEmail(email: string): Promise<AuthenticationRecord | null> {
    const rows = await this.sequelize.query<RawAuthenticationRow>(
      `
      SELECT u.id, u.email, u.display_name, u.role, u.status,
             u.country_id, u.tenant_id, u.merchant_id,
             u.must_change_password, u.mfa_enabled,
             c.id AS credential_id, c.password_hash, c.password_algo, c.previous_hashes,
             c.failed_attempts, c.locked_until, c.password_expires_at
        FROM reward_portal.portal_users u
        LEFT JOIN reward_portal.portal_user_credentials c ON c.user_id = u.id
       WHERE u.email_bidx = :bidx
         AND u.deleted_at IS NULL
       LIMIT 1
      `,
      {
        type: QueryTypes.SELECT,
        // `blindIndexFor` applies T-016's registered `email` normaliser (NFKC, trim, lowercase),
        // which is the same rule the stored index was computed with — this file's own
        // `normaliseEmail()` helper was removed with this change rather than left to drift out of
        // step with it, since two independent copies of "how an address is normalised" is exactly
        // how a login silently stops matching.
        replacements: { bidx: this.emailCrypto.blindIndexFor(email) },
      },
    );

    const row = rows[0];
    if (row === undefined) return null;

    return {
      user: {
        id: row.id,
        // Raw SQL gets no `afterFind` hook, so this is still an envelope. Decrypting here keeps
        // `AuthUserRow.email` meaning "the address", as every caller downstream assumes.
        email: this.emailCrypto.decryptForRow(row.id, row.email),
        displayName: row.display_name,
        role: row.role,
        status: row.status,
        countryId: row.country_id,
        tenantId: row.tenant_id,
        merchantId: row.merchant_id,
        mustChangePassword: row.must_change_password,
        mfaEnabled: row.mfa_enabled,
      },
      // `credential_id` is the LEFT JOIN's presence flag. Testing `password_hash` instead
      // would conflate "no credential row" with "a credential row holding NULL" — the column
      // is NOT NULL, so that cannot happen, but keying on the primary key says what is meant.
      credential:
        row.credential_id === null
          ? null
          : {
              id: row.credential_id,
              userId: row.id,
              passwordHash: row.password_hash ?? '',
              passwordAlgo: row.password_algo ?? '',
              previousHashes: parsePreviousHashes(row.previous_hashes),
              failedAttempts: row.failed_attempts ?? 0,
              lockedUntil: row.locked_until,
              passwordExpiresAt: row.password_expires_at,
            },
    };
  }

  /** The change-password path, where the user id comes from a verified session. */
  async findCredentialByUserId(userId: number): Promise<CredentialRow | null> {
    const rows = await this.sequelize.query<RawCredentialRow>(
      `
      SELECT id, user_id, password_hash, password_algo, previous_hashes,
             failed_attempts, locked_until, password_expires_at
        FROM reward_portal.portal_user_credentials
       WHERE user_id = :userId
       LIMIT 1
      `,
      { type: QueryTypes.SELECT, replacements: { userId } },
    );

    const row = rows[0];
    if (row === undefined) return null;

    return {
      id: row.id,
      userId: row.user_id,
      passwordHash: row.password_hash,
      passwordAlgo: row.password_algo,
      previousHashes: parsePreviousHashes(row.previous_hashes),
      failedAttempts: row.failed_attempts,
      lockedUntil: row.locked_until,
      passwordExpiresAt: row.password_expires_at,
    };
  }

  /**
   * Appends to `portal_login_attempts`. Every field that has a column width is truncated
   * here rather than trusted: `email` and `user_agent` are attacker-controlled, and a value
   * one byte over the column width would raise a database error *only for that request* —
   * turning an oversized User-Agent into a way to tell a 500 from a 401, which is a
   * user-enumeration oracle by another route.
   */
  async recordLoginAttempt(input: LoginAttemptInput, tx?: AuthTransaction): Promise<void> {
    await this.sequelize.query(
      `
      INSERT INTO reward_portal.portal_login_attempts
             (email, user_id, success, failure_code, ip_address, user_agent, attempted_at)
      VALUES (:email, :userId, :success, :failureCode, CAST(:ipAddress AS inet), :userAgent, now())
      `,
      {
        type: QueryTypes.INSERT,
        transaction: tx,
        replacements: {
          email: truncate(input.email, LOGIN_ATTEMPT_EMAIL_MAX_LENGTH),
          userId: input.userId,
          success: input.success,
          failureCode: input.failureCode,
          ipAddress: sanitiseIpAddress(input.ipAddress),
          userAgent: truncate(input.userAgent, LOGIN_ATTEMPT_USER_AGENT_MAX_LENGTH),
        },
      },
    );
  }

  async updateLockState(
    credentialId: number,
    update: LockStateUpdate,
    tx?: AuthTransaction,
  ): Promise<void> {
    await this.sequelize.query(
      `
      UPDATE reward_portal.portal_user_credentials
         SET failed_attempts = :failedAttempts,
             locked_until    = :lockedUntil,
             updated_at      = now()
       WHERE id = :credentialId
      `,
      {
        type: QueryTypes.UPDATE,
        transaction: tx,
        replacements: {
          credentialId,
          failedAttempts: update.failedAttempts,
          lockedUntil: update.lockedUntil,
        },
      },
    );
  }

  /**
   * Replaces the password and its history in one statement.
   *
   * Deliberately does **not** touch `failed_attempts` or `locked_until`. Clearing a lockout
   * is a security decision that belongs at the call site, where it is visible in review —
   * `LockoutService.clear()` exists for the reset flow to call explicitly. Folding it in here
   * would make every future caller of "change the password" silently also mean "unlock the
   * account", which is the kind of implicit behaviour a lockout bypass hides in.
   *
   * `password_expires_at` is cleared only when the caller asks for it — see
   * {@link PasswordUpdate.clearPasswordExpiry}, which applies exactly the same reasoning.
   */
  async replacePassword(
    credentialId: number,
    update: PasswordUpdate,
    tx?: AuthTransaction,
  ): Promise<void> {
    await this.sequelize.query(
      `
      UPDATE reward_portal.portal_user_credentials
         SET password_hash       = :passwordHash,
             password_algo       = :passwordAlgo,
             previous_hashes     = CAST(:previousHashes AS jsonb),
             password_expires_at = CASE WHEN CAST(:clearPasswordExpiry AS boolean)
                                        THEN NULL ELSE password_expires_at END,
             password_updated_at = now(),
             updated_at          = now()
       WHERE id = :credentialId
      `,
      {
        type: QueryTypes.UPDATE,
        transaction: tx,
        replacements: {
          credentialId,
          passwordHash: update.passwordHash,
          passwordAlgo: update.passwordAlgo,
          // `?? false` rather than passing `undefined` through: Sequelize renders an undefined
          // replacement as NULL, and `CASE WHEN CAST(NULL AS boolean)` falls to the ELSE branch.
          // That happens to be the right outcome, but by accident — an explicit boolean keeps the
          // statement's meaning independent of how the driver treats a missing value.
          clearPasswordExpiry: update.clearPasswordExpiry ?? false,
          // Stringified rather than passed as an array: Sequelize expands a JS array in a
          // replacement into a comma-separated SQL list, which is valid syntax and the wrong
          // value — `CAST` would then fail at runtime rather than at review time.
          previousHashes: JSON.stringify(update.previousHashes),
        },
      },
    );
  }

  /**
   * T-059. Inserts the *first* credential row for a user that does not have one yet —
   * `provisionTenantAdmin` (`tenants.service.ts`) is the only caller today. `PortalUserCredential`
   * is `deny()` in `scope-strategy.ts` for every role (password hashes are reached only through
   * this file's own parameterised SQL, never a scoped query), so this is the port a caller that
   * needs to create one must go through — same reasoning `findAuthenticationRecordByEmail`'s own
   * header gives for why this whole file is raw SQL rather than a Sequelize model.
   *
   * Column list matches `bootstrap-superadmin.ts`'s own first-credential insert exactly
   * (`password_algo`, `password_updated_at`, `failed_attempts: 0`), so the two paths that create a
   * user's very first credential cannot drift apart. `tx` is required to be threadable through:
   * `provisionTenantAdmin` creates the `portal_users` row and this credential row in one
   * transaction, so a partial failure rolls both back rather than leaving a user who can never log
   * in and whose email is now permanently unique-constrained against re-provisioning (TC-4/TC-5).
   */
  async createCredential(
    userId: number,
    passwordHash: string,
    passwordAlgo: string,
    tx?: AuthTransaction,
  ): Promise<void> {
    await this.sequelize.query(
      `
      INSERT INTO reward_portal.portal_user_credentials
             (user_id, password_hash, password_algo, password_updated_at, failed_attempts,
              created_at, updated_at)
      VALUES (:userId, :passwordHash, :passwordAlgo, now(), 0, now(), now())
      `,
      {
        type: QueryTypes.INSERT,
        transaction: tx,
        replacements: { userId, passwordHash, passwordAlgo },
      },
    );
  }

  async runInTransaction<T>(fn: (tx: AuthTransaction) => Promise<T>): Promise<T> {
    return this.sequelize.transaction(async (tx) => fn(tx));
  }
}

// --- helpers -----------------------------------------------------------------------------

/**
 * `normaliseEmail()` used to live here, applying `trim().toLowerCase()` to match the
 * `lower(email)` half of `uq_portal_users_email_live`.
 *
 * T-056 removed it. The lookup is now on `email_bidx`, and the normalisation that produces that
 * index is owned by T-016's `BLIND_INDEX_NORMALISERS.email` — which performs a strictly stronger
 * rule (Unicode NFKC first, then trim and locale-independent lowercase) and documents at length
 * why. Keeping a second, weaker copy of the rule in this file would have been the classic
 * blind-index failure: the two drift, the index computed on write stops equalling the one computed
 * on read, and every affected user simply cannot log in, with no error anywhere.
 */

function truncate(value: string | null, maxLength: number): string | null {
  if (value === null) return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/**
 * `portal_login_attempts.ip_address` is `inet`; Postgres rejects anything that is not a
 * valid address, and that rejection would abort the very INSERT that records the failure.
 *
 * The address normally comes from the transport layer, but T-012 will make it configurable
 * from `X-Forwarded-For` behind a trusted proxy — which is attacker-controlled input. A
 * value that does not parse is stored as NULL rather than being allowed to fail the write:
 * losing one forensic field is strictly better than losing the whole attempt record, and
 * "this login attempt was never logged" is the outcome an attacker would be aiming for.
 */
function sanitiseIpAddress(value: string | null): string | null {
  if (value === null) return null;

  const candidate = value.trim();
  if (candidate.length === 0) return null;

  // IPv4 dotted quad, or anything hex-and-colons shaped for IPv6 (including the
  // `::ffff:127.0.0.1` mapped form Node hands back on a dual-stack listener).
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6 = /^[0-9a-fA-F:]+(\.\d{1,3}){0,3}$/;

  if (ipv4.test(candidate)) {
    const octetsInRange = candidate.split('.').every((octet) => Number(octet) <= 255);
    return octetsInRange ? candidate : null;
  }

  return ipv6.test(candidate) && candidate.includes(':') ? candidate : null;
}

/**
 * `previous_hashes` is genuine `jsonb`, so `pg` hands back a parsed value — but this column
 * predates the model and can also be read through paths that hand back the raw string, so
 * both are accepted. Anything that is not an array of strings degrades to `null` rather than
 * throwing: a corrupt history column must not be able to block a password change, and the
 * reuse check treats a missing history as "nothing to compare against", which the policy's
 * other rules still backstop.
 */
function parsePreviousHashes(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;

  const parsed = typeof value === 'string' ? tryParseJson(value) : value;
  if (!Array.isArray(parsed)) return null;

  const hashes = parsed.filter((entry): entry is string => typeof entry === 'string');
  return hashes.length > 0 ? hashes : null;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
