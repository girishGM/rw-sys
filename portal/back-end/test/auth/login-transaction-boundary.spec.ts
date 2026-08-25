/**
 * T-082 — the login transaction boundary: a *rejected* login must commit its failure writes.
 *
 * ### Why this file exists at all
 *
 * The account-lockout control in 02-SECURITY.md §2 was absent at runtime for the whole life of
 * the project, and every existing test was green throughout. `LockoutService.registerFailure`
 * wrote the `portal_login_attempts` row and advanced `failed_attempts`/`locked_until` correctly;
 * `AuthService.login` then threw `InvalidCredentialsHttpException` from *inside* the
 * `runInTransaction` callback, and the managed transaction rolled both writes back. Measured on
 * the live database before the fix: 7,031 attempt rows, **all** `success = true`, and not one
 * credential in the entire database had ever reached `failed_attempts > 0`.
 *
 * The reason no unit test caught it is written, in as many words, on `FakeSessionStore`:
 *
 * > Runs the callback with a stub handle. **Does not model rollback** — that is deliberate […]
 * > because both the correct and the incorrect implementation would look identical here.
 *
 * The second half of that sentence is exactly right, and is an argument for the opposite
 * conclusion. A fake that never rolls back cannot distinguish "commits, then denies" from
 * "denies, discarding the commit" — so it certifies both, which is how the defect shipped with
 * full coverage. AGENT-PROTOCOL §3 puts the test this file has to pass: *if the specified
 * behaviour were wrong, would this test still pass?* Under a non-rollback fake, no.
 *
 * So this suite supplies a transaction double with **real managed-transaction semantics** —
 * resolve commits, throw discards — and asserts the observable outcome on the other side of it.
 * The shared `FakeSessionStore` is left exactly as it is: other suites depend on its current
 * behaviour, and rollback fidelity is only needed here.
 *
 * The end-to-end proof against the real database lives in
 * `test/security/login-enumeration.e2e-spec.ts`; this file is the fast, deterministic guard that
 * runs on every change to `auth.service.ts`.
 */
import { AuthService } from '@/modules/auth/auth.service';
import { InvalidCredentialsHttpException } from '@/modules/auth/auth.exceptions';
import { CredentialService } from '@/modules/auth/services/credential.service';
import { LockoutService } from '@/modules/auth/services/lockout.service';
import { PasswordPolicyService } from '@/modules/auth/services/password-policy.service';
import { SessionService } from '@/modules/auth/services/session.service';
import { TokenService } from '@/modules/auth/services/token.service';
import type { AuthTransaction } from '@/modules/auth/services/credential.repository';
import type { StepUpHook } from '@/modules/auth/services/step-up.hook';
import { FakeCredentialStore } from './support/fake-credential-store';
import { FakeSessionStore } from './support/fake-session-store';
import { fakeConfigService, generateTestKeyPair } from './support/test-keys';

const NOW = new Date('2026-08-22T10:00:00.000Z');
const CONTEXT = { ipAddress: '203.0.113.7', userAgent: 'jest' };
const EMAIL = 'lockout-probe@example.com';
const PASSWORD = 'correct horse battery staple 7!';
const WRONG_PASSWORD = 'not the right password at all 9!';

/** 02-SECURITY.md §2: "5 consecutive failures → locked_until = now() + 15 min". */
const LOCKOUT_THRESHOLD = 5;

jest.setTimeout(120_000);

/**
 * The state a rollback would take back: the recorded attempts, and each credential's lock
 * columns. Captured as a plain snapshot rather than by proxying every write, because the point is
 * to model what Postgres does to *committed data*, not to trace the calls that got there.
 */
function snapshot(store: FakeCredentialStore) {
  return {
    attempts: store.attempts.map((attempt) => ({ ...attempt })),
    lockWrites: store.lockWrites.map((write) => ({ ...write })),
    lockState: store.credentials.map((credential) => ({
      id: credential.id,
      failedAttempts: credential.failedAttempts,
      lockedUntil: credential.lockedUntil,
    })),
  };
}

function restore(store: FakeCredentialStore, taken: ReturnType<typeof snapshot>): void {
  store.attempts.splice(0, store.attempts.length, ...taken.attempts);
  store.lockWrites.splice(0, store.lockWrites.length, ...taken.lockWrites);
  for (const previous of taken.lockState) {
    const credential = store.credentials.find((c) => c.id === previous.id);
    if (credential === undefined) continue;
    credential.failedAttempts = previous.failedAttempts;
    credential.lockedUntil = previous.lockedUntil;
  }
}

/**
 * Builds the service with a session store whose `runInTransaction` behaves like
 * `sequelize.transaction()`: the callback resolving commits, the callback throwing rolls back.
 *
 * `rollbacks` counts discarded transactions so a test can assert on the boundary itself rather
 * than only on its consequences.
 */
async function build() {
  const credentialStore = new FakeCredentialStore();
  const sessionStore = new FakeSessionStore();
  const rollbacks: { count: number } = { count: 0 };

  sessionStore.runInTransaction = async function runInTransaction<T>(
    fn: (tx: AuthTransaction) => Promise<T>,
  ): Promise<T> {
    const taken = snapshot(credentialStore);
    try {
      return await fn({ id: 'rollback-modelling-tx' } as unknown as AuthTransaction);
    } catch (error) {
      // What Postgres does on an aborted transaction, and what the pre-T-082 code triggered on
      // every single failed login.
      restore(credentialStore, taken);
      rollbacks.count += 1;
      throw error;
    }
  };

  const policy = new PasswordPolicyService();
  const lockout = new LockoutService(credentialStore);
  const credentials = new CredentialService(credentialStore, policy, lockout);
  const keys = generateTestKeyPair();
  const tokens = new TokenService(
    fakeConfigService({ JWT_PRIVATE_KEY: keys.privateKey, JWT_PUBLIC_KEY: keys.publicKey }),
  );
  const stepUp: StepUpHook = {
    async evaluate() {
      return { required: false };
    },
  };

  const auth = new AuthService(
    credentials,
    lockout,
    new SessionService(sessionStore, tokens),
    tokens,
    credentialStore,
    sessionStore,
    stepUp,
  );

  const user = credentialStore.seedUser({ email: EMAIL });
  credentialStore.seedCredential(user.id, await credentials.hash(PASSWORD));
  sessionStore.users.push(user);

  return { auth, credentialStore, sessionStore, rollbacks, user };
}

type Harness = Awaited<ReturnType<typeof build>>;

/** One failed login, asserting only that it was refused. */
async function failLogin(harness: Harness, password = WRONG_PASSWORD, at: Date = NOW) {
  await expect(harness.auth.login({ email: EMAIL, password }, CONTEXT, at)).rejects.toBeInstanceOf(
    InvalidCredentialsHttpException,
  );
}

function credentialOf(harness: Harness) {
  const credential = harness.credentialStore.credentials.find((c) => c.userId === harness.user.id);
  if (credential === undefined) throw new Error('fixture lost its credential row');
  return credential;
}

describe('T-082: a rejected login commits the writes the lockout control is made of', () => {
  it('keeps the failed-attempt row after the 401 (was rolled back)', async () => {
    const harness = await build();

    await failLogin(harness);

    const failures = harness.credentialStore.attempts.filter((attempt) => !attempt.success);
    expect(failures).toHaveLength(1);
    // The write really was inside the transaction — otherwise this test would pass for the
    // uninteresting reason that nothing transactional happened at all.
    expect(failures[0].transactional).toBe(true);
    expect(failures[0].failureCode).toBe('bad_password');
    expect(harness.rollbacks.count).toBe(0);
  });

  it('advances failed_attempts on every failure', async () => {
    const harness = await build();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await failLogin(harness);
      expect(credentialOf(harness).failedAttempts).toBe(attempt);
    }
  });

  it('locks the account on the fifth consecutive failure, and the lock is in the future', async () => {
    const harness = await build();

    for (let attempt = 1; attempt < LOCKOUT_THRESHOLD; attempt += 1) {
      await failLogin(harness);
      expect(credentialOf(harness).lockedUntil).toBeNull();
    }

    await failLogin(harness);

    const credential = credentialOf(harness);
    expect(credential.failedAttempts).toBe(LOCKOUT_THRESHOLD);
    expect(credential.lockedUntil).not.toBeNull();
    expect((credential.lockedUntil as Date).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('refuses the CORRECT password while locked — the property §2 actually promises', async () => {
    const harness = await build();

    for (let attempt = 0; attempt < LOCKOUT_THRESHOLD; attempt += 1) await failLogin(harness);

    // The observable outcome. Before T-082 this returned a session: the account never locked, so
    // per-account guessing was bounded only by the rate limiter.
    await failLogin(harness, PASSWORD);

    // The attempt made *while* locked is itself recorded, and distinguishably so — during an
    // incident, "kept trying after the lock engaged" is the difference between a forgetful user
    // and someone working a list.
    const failures = harness.credentialStore.attempts.filter((attempt) => !attempt.success);
    expect(failures).toHaveLength(LOCKOUT_THRESHOLD + 1);
    expect(failures[failures.length - 1].failureCode).toBe('locked');

    // A locked attempt must not extend the lock: `registerFailure` returns early for 'locked',
    // so an attacker cannot hold an account locked forever by continuing to poke it.
    expect(credentialOf(harness).failedAttempts).toBe(LOCKOUT_THRESHOLD);
  });

  it('lets the correct password back in once the lock has expired', async () => {
    const harness = await build();

    for (let attempt = 0; attempt < LOCKOUT_THRESHOLD; attempt += 1) await failLogin(harness);

    const lockedUntil = credentialOf(harness).lockedUntil as Date;
    const afterExpiry = new Date(lockedUntil.getTime() + 1000);

    // Lockout is temporary by design; a fix that locked permanently would be a denial-of-service
    // an attacker could trigger against any address they know.
    const result = await harness.auth.login(
      { email: EMAIL, password: PASSWORD },
      CONTEXT,
      afterExpiry,
    );
    expect(result.status).toBe('authenticated');
  });

  it('resets the counter after a successful login', async () => {
    const harness = await build();

    await failLogin(harness);
    await failLogin(harness);
    expect(credentialOf(harness).failedAttempts).toBe(2);

    await harness.auth.login({ email: EMAIL, password: PASSWORD }, CONTEXT, NOW);

    // "5 *consecutive* failures" — a success in between must clear the run.
    expect(credentialOf(harness).failedAttempts).toBe(0);
  });

  it('records the failure for an unknown address too', async () => {
    const harness = await build();

    await expect(
      harness.auth.login(
        { email: 'nobody@example.invalid', password: WRONG_PASSWORD },
        CONTEXT,
        NOW,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsHttpException);

    // LockoutService's own comment names this as the only place a credential-stuffing run
    // against non-existent addresses becomes visible. There is no credential row to count
    // against, so the attempt row is the entire signal.
    const failures = harness.credentialStore.attempts.filter((attempt) => !attempt.success);
    expect(failures).toHaveLength(1);
    expect(failures[0].failureCode).toBe('unknown_user');
    expect(harness.rollbacks.count).toBe(0);
  });
});

describe('T-082: a genuine fault still rolls the transaction back', () => {
  it('discards the failure writes and propagates the original error', async () => {
    const harness = await build();
    const boom = new Error('connection reset by peer');

    // A fault *after* the failure was recorded: the writes exist but the transaction is not known
    // to be consistent, so it must abort. This is the branch that separates "deny" from "fault",
    // and getting it wrong in the other direction — committing everything unconditionally — is
    // how a half-written login would reach the database.
    jest.spyOn(harness.sessionStore, 'setMustChangePassword').mockRejectedValueOnce(boom);
    const credential = credentialOf(harness);
    credential.passwordExpiresAt = new Date(NOW.getTime() - 1000);

    await expect(
      harness.auth.login({ email: EMAIL, password: PASSWORD }, CONTEXT, NOW),
    ).rejects.toBe(boom);

    expect(harness.rollbacks.count).toBe(1);
    expect(harness.credentialStore.attempts).toHaveLength(0);
    expect(credentialOf(harness).failedAttempts).toBe(0);
  });

  it('does not convert an unexpected error into a 401', async () => {
    const harness = await build();
    const boom = new Error('argon2 backend unavailable');
    jest.spyOn(harness.sessionStore, 'setMustChangePassword').mockRejectedValueOnce(boom);
    credentialOf(harness).passwordExpiresAt = new Date(NOW.getTime() - 1000);

    // A fault must not be laundered into "wrong password": that would tell an attacker the
    // service is degraded and tell an operator nothing at all.
    await expect(
      harness.auth.login({ email: EMAIL, password: PASSWORD }, CONTEXT, NOW),
    ).rejects.not.toBeInstanceOf(InvalidCredentialsHttpException);
  });
});
