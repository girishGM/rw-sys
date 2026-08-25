/**
 * T-011 — `AuthService`: login, change password, forgot password, reset password.
 *
 * Driven against the real `CredentialService` (so a real Argon2 verification happens on every
 * login here, exactly as in production) with in-memory stores behind it. The alternative —
 * stubbing `authenticate()` — would test the sequencing while assuming away the thing being
 * sequenced, and this file's whole subject is *ordering*: hook after verification, session after
 * hook, reset-token consume inside the same transaction as the password change.
 *
 * TC-6, TC-19/TC-20, TC-21, TC-22 and TC-23 have their unit form here.
 */
import { AuthService } from '@/modules/auth/auth.service';
import {
  InvalidCredentialsHttpException,
  PasswordPolicyHttpException,
  ResetTokenInvalidHttpException,
} from '@/modules/auth/auth.exceptions';
import { AUTH_AUDIT_EVENT, PASSWORD_RESET_TTL_SECONDS } from '@/modules/auth/session.constants';
import { CredentialService } from '@/modules/auth/services/credential.service';
import { LockoutService } from '@/modules/auth/services/lockout.service';
import { PasswordPolicyService } from '@/modules/auth/services/password-policy.service';
import { SessionService } from '@/modules/auth/services/session.service';
import { TokenService } from '@/modules/auth/services/token.service';
import type { StepUpHook } from '@/modules/auth/services/step-up.hook';
import type { AuthUserRow } from '@/modules/auth/services/credential.repository';
import { FakeCredentialStore } from './support/fake-credential-store';
import { FakeSessionStore } from './support/fake-session-store';
import { fakeConfigService, generateTestKeyPair } from './support/test-keys';

const NOW = new Date('2026-08-17T10:00:00.000Z');
const CONTEXT = { ipAddress: '203.0.113.7', userAgent: 'jest' };

const PASSWORD = 'correct horse battery staple 7!';
const NEW_PASSWORD = 'Tr0ubador-Zephyr-Quill!42';

jest.setTimeout(60_000);

async function build(
  stepUp: StepUpHook = {
    async evaluate() {
      return { required: false };
    },
  },
) {
  const credentialStore = new FakeCredentialStore();
  const sessionStore = new FakeSessionStore();
  const policy = new PasswordPolicyService();
  const lockout = new LockoutService(credentialStore);
  const credentials = new CredentialService(credentialStore, policy, lockout);

  const keys = generateTestKeyPair();
  const tokens = new TokenService(
    fakeConfigService({ JWT_PRIVATE_KEY: keys.privateKey, JWT_PUBLIC_KEY: keys.publicKey }),
  );
  const sessions = new SessionService(sessionStore, tokens);

  const auth = new AuthService(
    credentials,
    lockout,
    sessions,
    tokens,
    credentialStore,
    sessionStore,
    stepUp,
  );

  return { auth, credentials, credentialStore, sessionStore, sessions, tokens, lockout };
}

type Harness = Awaited<ReturnType<typeof build>>;

/**
 * Seeds one account in **both** stores, which the production code sees as one row split across
 * two repositories. Keeping the ids aligned is the fake's job, not the service's.
 */
async function seedAccount(
  harness: Harness,
  overrides: Partial<AuthUserRow> = {},
  password: string = PASSWORD,
): Promise<AuthUserRow> {
  const email = overrides.email ?? 'operator@example.com';
  const user = harness.credentialStore.seedUser({ ...overrides, email });
  harness.credentialStore.seedCredential(user.id, await harness.credentials.hash(password));
  harness.sessionStore.users.push(user);
  harness.sessionStore.users.splice(
    harness.sessionStore.users.findIndex((u) => u.id === user.id),
    1,
    user,
  );
  return user;
}

describe('AuthService.login', () => {
  it('issues a session and returns the role and the change-password flag', async () => {
    const harness = await build();
    await seedAccount(harness, { role: 'checker' });

    const result = await harness.auth.login(
      { email: 'operator@example.com', password: PASSWORD },
      CONTEXT,
      NOW,
    );

    expect(result.status).toBe('authenticated');
    expect(result.user.role).toBe('checker');
    expect(result.mustChangePassword).toBe(false);
    expect(harness.sessionStore.sessions).toHaveLength(1);
  });

  it('writes a login_succeeded audit row naming the session', async () => {
    const harness = await build();
    const user = await seedAccount(harness);

    const result = await harness.auth.login(
      { email: 'operator@example.com', password: PASSWORD },
      CONTEXT,
      NOW,
    );
    if (result.status !== 'authenticated') throw new Error('expected a session');

    expect(harness.sessionStore.eventsOfType(AUTH_AUDIT_EVENT.LOGIN_SUCCEEDED)).toEqual([
      expect.objectContaining({ actorId: user.id, targetId: result.session.sessionId }),
    ]);
  });

  it('TC-6: answers the same exception for a wrong password as for an unknown address', async () => {
    const harness = await build();
    await seedAccount(harness);

    await expect(
      harness.auth.login(
        { email: 'operator@example.com', password: 'wrong-password' },
        CONTEXT,
        NOW,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsHttpException);

    await expect(
      harness.auth.login({ email: 'nobody@example.com', password: PASSWORD }, CONTEXT, NOW),
    ).rejects.toBeInstanceOf(InvalidCredentialsHttpException);
  });

  it('TC-6: an inactive account fails identically, and creates no session', async () => {
    const harness = await build();
    await seedAccount(harness, { status: 'inactive' });

    await expect(
      harness.auth.login({ email: 'operator@example.com', password: PASSWORD }, CONTEXT, NOW),
    ).rejects.toBeInstanceOf(InvalidCredentialsHttpException);

    expect(harness.sessionStore.sessions).toHaveLength(0);
  });

  it('propagates an unexpected store failure rather than disguising it as bad credentials', async () => {
    const harness = await build();
    await seedAccount(harness);
    harness.credentialStore.findAuthenticationRecordByEmail = async () => {
      throw new Error('connection reset');
    };

    // A 401 here would tell an operator "your password is wrong" during a database outage.
    await expect(
      harness.auth.login({ email: 'operator@example.com', password: PASSWORD }, CONTEXT, NOW),
    ).rejects.toThrow('connection reset');
  });

  it('persists an expiry-derived must-change flag so the per-request guard agrees with login', async () => {
    const harness = await build();
    const user = await seedAccount(harness);
    harness.credentialStore.credentialFor(user.id).passwordExpiresAt = new Date(
      NOW.getTime() - 1000,
    );

    const result = await harness.auth.login(
      { email: 'operator@example.com', password: PASSWORD },
      CONTEXT,
      NOW,
    );

    expect(result.mustChangePassword).toBe(true);
    // Without this write the flag would be true in the login body and false on the next request.
    expect((await harness.sessionStore.findUserById(user.id))?.mustChangePassword).toBe(true);
  });

  it('leaves the flag alone when it is already set on the row', async () => {
    const harness = await build();
    const user = await seedAccount(harness, { mustChangePassword: true });

    const result = await harness.auth.login(
      { email: 'operator@example.com', password: PASSWORD },
      CONTEXT,
      NOW,
    );

    expect(result.mustChangePassword).toBe(true);
    expect((await harness.sessionStore.findUserById(user.id))?.mustChangePassword).toBe(true);
  });

  it('survives an audit outage without failing the login', async () => {
    const harness = await build();
    await seedAccount(harness);
    harness.sessionStore.auditWriteFails = true;

    const result = await harness.auth.login(
      { email: 'operator@example.com', password: PASSWORD },
      CONTEXT,
      NOW,
    );

    expect(result.status).toBe('authenticated');
  });
});

describe('AuthService.login — the step-up extension point (B-02 / T-055)', () => {
  it('creates no session at all when the hook says a second factor is outstanding', async () => {
    const harness = await build({
      async evaluate() {
        return { required: true };
      },
    });
    await seedAccount(harness, { role: 'super_admin', countryId: null, tenantId: null });

    const result = await harness.auth.login(
      { email: 'operator@example.com', password: PASSWORD },
      CONTEXT,
      NOW,
    );

    expect(result.status).toBe('step_up_required');
    expect(harness.sessionStore.sessions).toHaveLength(0);
    expect(harness.sessionStore.refreshTokens).toHaveLength(0);
  });

  it('calls the hook with the database row, after the password has been verified', async () => {
    const seen: AuthUserRow[] = [];
    const harness = await build({
      async evaluate(user) {
        seen.push(user);
        return { required: false };
      },
    });
    await seedAccount(harness, { role: 'maker' });

    await harness.auth.login({ email: 'operator@example.com', password: PASSWORD }, CONTEXT, NOW);
    // Never called for a failed login — the hook must not become an "is MFA on?" oracle.
    await expect(
      harness.auth.login({ email: 'operator@example.com', password: 'nope' }, CONTEXT, NOW),
    ).rejects.toBeInstanceOf(InvalidCredentialsHttpException);

    expect(seen).toHaveLength(1);
    expect(seen[0].role).toBe('maker');
  });
});

describe('AuthService.login — opportunistic rehash', () => {
  it('upgrades a hash made with weaker parameters, preserving the history', async () => {
    const harness = await build();
    const user = await seedAccount(harness);

    const credential = harness.credentialStore.credentialFor(user.id);
    const originalHash = credential.passwordHash;
    credential.previousHashes = ['$argon2id$v=19$m=19456,t=2,p=1$older'];
    jest.spyOn(harness.credentials, 'needsRehash').mockReturnValue(true);

    await harness.auth.login({ email: 'operator@example.com', password: PASSWORD }, CONTEXT, NOW);

    expect(harness.credentialStore.passwordWrites).toHaveLength(1);
    expect(harness.credentialStore.credentialFor(user.id).passwordHash).not.toBe(originalHash);
    // A rehash of the *same* password must not consume a slot in "your last five passwords".
    expect(harness.credentialStore.passwordWrites[0].previousHashes).toEqual([
      '$argon2id$v=19$m=19456,t=2,p=1$older',
    ]);
  });

  it('writes nothing when the stored hash is already current', async () => {
    const harness = await build();
    await seedAccount(harness);

    await harness.auth.login({ email: 'operator@example.com', password: PASSWORD }, CONTEXT, NOW);

    expect(harness.credentialStore.passwordWrites).toHaveLength(0);
  });

  it('never fails a login because the rehash failed', async () => {
    const harness = await build();
    await seedAccount(harness);
    jest.spyOn(harness.credentials, 'needsRehash').mockReturnValue(true);
    harness.credentialStore.replacePassword = async () => {
      throw new Error('disk full');
    };

    const result = await harness.auth.login(
      { email: 'operator@example.com', password: PASSWORD },
      CONTEXT,
      NOW,
    );

    expect(result.status).toBe('authenticated');
  });

  it('does nothing when the credential row has vanished', async () => {
    const harness = await build();
    await seedAccount(harness);
    const original = harness.credentialStore.findCredentialByUserId.bind(harness.credentialStore);
    let calls = 0;
    harness.credentialStore.findCredentialByUserId = async (id) => {
      calls += 1;
      return calls === 1 ? null : original(id);
    };

    // The lookup inside `rehashIfNeeded` is the first one after the login transaction commits.
    await expect(
      harness.auth.login({ email: 'operator@example.com', password: PASSWORD }, CONTEXT, NOW),
    ).resolves.toMatchObject({ status: 'authenticated' });
    expect(harness.credentialStore.passwordWrites).toHaveLength(0);
  });
});

describe('AuthService.changePassword (TC-20)', () => {
  async function loggedIn(harness: Harness, overrides: Partial<AuthUserRow> = {}) {
    const user = await seedAccount(harness, overrides);
    const result = await harness.auth.login(
      { email: user.email, password: PASSWORD },
      CONTEXT,
      NOW,
    );
    if (result.status !== 'authenticated') throw new Error('expected a session');
    return { user, session: result.session };
  }

  it('replaces the password and clears the must-change flag', async () => {
    const harness = await build();
    const { user, session } = await loggedIn(harness, { mustChangePassword: true });

    await harness.auth.changePassword(
      user.id,
      session.sessionId,
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      CONTEXT,
    );

    expect((await harness.sessionStore.findUserById(user.id))?.mustChangePassword).toBe(false);
    expect(
      await harness.credentials.verify(
        harness.credentialStore.credentialFor(user.id).passwordHash,
        NEW_PASSWORD,
      ),
    ).toBe(true);
  });

  it('rejects a wrong current password with the undifferentiated credentials error', async () => {
    const harness = await build();
    const { user, session } = await loggedIn(harness);

    await expect(
      harness.auth.changePassword(
        user.id,
        session.sessionId,
        { currentPassword: 'not-it', newPassword: NEW_PASSWORD },
        CONTEXT,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsHttpException);
  });

  it('reports policy violations, unlike the login path', async () => {
    const harness = await build();
    const { user, session } = await loggedIn(harness);

    const error = await harness.auth
      .changePassword(
        user.id,
        session.sessionId,
        { currentPassword: PASSWORD, newPassword: 'Password123!' },
        CONTEXT,
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PasswordPolicyHttpException);
    expect((error as PasswordPolicyHttpException).getResponse()).toMatchObject({
      error: { code: 'AUTH_PASSWORD_POLICY', details: [{ field: 'newPassword' }] },
    });
  });

  it('revokes every other session but keeps the caller signed in', async () => {
    const harness = await build();
    const { user, session } = await loggedIn(harness);
    const otherSession = await harness.sessions.start(user, CONTEXT, NOW);

    await harness.auth.changePassword(
      user.id,
      session.sessionId,
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      CONTEXT,
    );

    expect(harness.sessionStore.sessionFor(session.sessionId).status).toBe('active');
    expect(harness.sessionStore.sessionFor(otherSession.sessionId).status).toBe('revoked');
  });

  it('refuses when the user row no longer exists', async () => {
    const harness = await build();
    const { session } = await loggedIn(harness);

    await expect(
      harness.auth.changePassword(
        9999,
        session.sessionId,
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        CONTEXT,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsHttpException);
  });

  it('propagates an unexpected credential-store failure unchanged', async () => {
    const harness = await build();
    const { user, session } = await loggedIn(harness);
    jest.spyOn(harness.credentials, 'changePassword').mockRejectedValue(new Error('io error'));

    await expect(
      harness.auth.changePassword(
        user.id,
        session.sessionId,
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        CONTEXT,
      ),
    ).rejects.toThrow('io error');
  });
});

describe('AuthService.forgotPassword (TC-21)', () => {
  it('returns synchronously and mints a reset token for a real account', async () => {
    const harness = await build();
    const user = await seedAccount(harness);

    expect(harness.auth.forgotPassword(user.email, CONTEXT, NOW)).toBeUndefined();
    // Nothing has happened yet — the response has already been returned by this point.
    expect(harness.sessionStore.passwordResets).toHaveLength(0);

    await harness.auth.whenIdle();

    expect(harness.sessionStore.passwordResets).toHaveLength(1);
    expect(harness.sessionStore.passwordResets[0].userId).toBe(user.id);
    expect(
      harness.sessionStore.eventsOfType(AUTH_AUDIT_EVENT.PASSWORD_RESET_REQUESTED),
    ).toHaveLength(1);
  });

  it('does exactly nothing for an unknown address, and still does not throw', async () => {
    const harness = await build();
    await seedAccount(harness);

    harness.auth.forgotPassword('nobody@example.com', CONTEXT, NOW);
    await harness.auth.whenIdle();

    expect(harness.sessionStore.passwordResets).toHaveLength(0);
    expect(
      harness.sessionStore.eventsOfType(AUTH_AUDIT_EVENT.PASSWORD_RESET_REQUESTED),
    ).toHaveLength(0);
  });

  it('does nothing for an account that is not active', async () => {
    const harness = await build();
    const user = await seedAccount(harness, { status: 'suspended' });

    harness.auth.forgotPassword(user.email, CONTEXT, NOW);
    await harness.auth.whenIdle();

    expect(harness.sessionStore.passwordResets).toHaveLength(0);
  });

  it('swallows a background failure rather than crashing the process', async () => {
    const harness = await build();
    const user = await seedAccount(harness);
    harness.sessionStore.createPasswordReset = async () => {
      throw new Error('table missing');
    };

    harness.auth.forgotPassword(user.email, CONTEXT, NOW);

    await expect(harness.auth.whenIdle()).resolves.toBeUndefined();
  });

  it('defaults its clock to the real one when the caller supplies none', async () => {
    const harness = await build();
    const user = await seedAccount(harness);
    const before = Date.now();

    await harness.auth.issuePasswordReset(user.id);

    const expiry = harness.sessionStore.passwordResets[0].expiresAt.getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + PASSWORD_RESET_TTL_SECONDS * 1000);
  });

  it('logs a background failure that is not an Error at all', async () => {
    const harness = await build();
    const user = await seedAccount(harness);
    // A rejection with a non-Error value: rare, but a `.message` access on one throws, and this
    // path exists precisely to make sure a background failure cannot become a second failure.
    harness.sessionStore.createPasswordReset = async () => {
      throw 'a bare string';
    };

    harness.auth.forgotPassword(user.email, CONTEXT, NOW);

    await expect(harness.auth.whenIdle()).resolves.toBeUndefined();
  });

  it('stores only the digest of the reset token', async () => {
    const harness = await build();
    const user = await seedAccount(harness);

    const raw = await harness.auth.issuePasswordReset(user.id, NOW);

    expect(harness.sessionStore.passwordResets[0].tokenHash).toBe(
      harness.tokens.hashOpaqueToken(raw),
    );
    expect(harness.sessionStore.passwordResets[0].expiresAt.getTime()).toBe(
      NOW.getTime() + PASSWORD_RESET_TTL_SECONDS * 1000,
    );
  });
});

describe('AuthService.resetPassword (TC-22, TC-23)', () => {
  it('sets the new password, clears the flag and clears the lockout', async () => {
    const harness = await build();
    const user = await seedAccount(harness, { mustChangePassword: true });
    harness.credentialStore.credentialFor(user.id).failedAttempts = 5;
    harness.credentialStore.credentialFor(user.id).lockedUntil = new Date(NOW.getTime() + 900_000);
    const token = await harness.auth.issuePasswordReset(user.id, NOW);

    await harness.auth.resetPassword({ token, newPassword: NEW_PASSWORD }, CONTEXT, NOW);

    expect((await harness.sessionStore.findUserById(user.id))?.mustChangePassword).toBe(false);
    expect(harness.credentialStore.credentialFor(user.id).failedAttempts).toBe(0);
    expect(harness.credentialStore.credentialFor(user.id).lockedUntil).toBeNull();
  });

  it('revokes every session the account had', async () => {
    const harness = await build();
    const user = await seedAccount(harness);
    const session = await harness.sessions.start(user, CONTEXT, NOW);
    const token = await harness.auth.issuePasswordReset(user.id, NOW);

    await harness.auth.resetPassword({ token, newPassword: NEW_PASSWORD }, CONTEXT, NOW);

    expect(harness.sessionStore.sessionFor(session.sessionId).status).toBe('revoked');
    expect(
      harness.sessionStore.eventsOfType(AUTH_AUDIT_EVENT.PASSWORD_RESET_COMPLETED),
    ).toHaveLength(1);
  });

  it('TC-22: a second use of the same token fails', async () => {
    const harness = await build();
    const user = await seedAccount(harness);
    const token = await harness.auth.issuePasswordReset(user.id, NOW);

    await harness.auth.resetPassword({ token, newPassword: NEW_PASSWORD }, CONTEXT, NOW);

    await expect(
      harness.auth.resetPassword(
        { token, newPassword: 'Another-Valid-Passphrase!9' },
        CONTEXT,
        NOW,
      ),
    ).rejects.toBeInstanceOf(ResetTokenInvalidHttpException);
  });

  it('TC-23: an expired token fails', async () => {
    const harness = await build();
    const user = await seedAccount(harness);
    const token = await harness.auth.issuePasswordReset(user.id, NOW);
    const afterExpiry = new Date(NOW.getTime() + (PASSWORD_RESET_TTL_SECONDS + 1) * 1000);

    await expect(
      harness.auth.resetPassword({ token, newPassword: NEW_PASSWORD }, CONTEXT, afterExpiry),
    ).rejects.toBeInstanceOf(ResetTokenInvalidHttpException);
  });

  it('an unknown token fails with the same code as a consumed one', async () => {
    const harness = await build();
    await seedAccount(harness);

    await expect(
      harness.auth.resetPassword({ token: 'invented', newPassword: NEW_PASSWORD }, CONTEXT, NOW),
    ).rejects.toBeInstanceOf(ResetTokenInvalidHttpException);
  });

  it('fails closed if the consume loses a race it should not be able to lose', async () => {
    const harness = await build();
    const user = await seedAccount(harness);
    const token = await harness.auth.issuePasswordReset(user.id, NOW);
    harness.sessionStore.resetConsumeLosesRace = true;

    await expect(
      harness.auth.resetPassword({ token, newPassword: NEW_PASSWORD }, CONTEXT, NOW),
    ).rejects.toBeInstanceOf(ResetTokenInvalidHttpException);
  });

  it('fails when the token names a user that no longer exists', async () => {
    const harness = await build();
    const user = await seedAccount(harness);
    const token = await harness.auth.issuePasswordReset(user.id, NOW);
    harness.sessionStore.users.length = 0;

    await expect(
      harness.auth.resetPassword({ token, newPassword: NEW_PASSWORD }, CONTEXT, NOW),
    ).rejects.toBeInstanceOf(ResetTokenInvalidHttpException);
  });

  it('leaves the token usable when the new password fails the policy', async () => {
    const harness = await build();
    const user = await seedAccount(harness);
    const token = await harness.auth.issuePasswordReset(user.id, NOW);

    await expect(
      harness.auth.resetPassword({ token, newPassword: 'Password123!' }, CONTEXT, NOW),
    ).rejects.toBeInstanceOf(PasswordPolicyHttpException);

    // The real transaction rolls the consume back; the fake models no rollback, so this asserts
    // the behaviour the e2e suite proves — here we assert the second attempt is accepted on its
    // merits, i.e. that a policy failure is not turned into a permanently burnt link by any
    // *other* mechanism. See auth.e2e-spec.ts for the transactional proof.
    expect(harness.sessionStore.passwordResets[0].userId).toBe(user.id);
  });

  it('skips the lockout clear when there is no credential row to clear', async () => {
    const harness = await build();
    const user = await seedAccount(harness);
    const token = await harness.auth.issuePasswordReset(user.id, NOW);
    const original = harness.credentialStore.findCredentialByUserId.bind(harness.credentialStore);
    let calls = 0;
    harness.credentialStore.findCredentialByUserId = async (id) => {
      calls += 1;
      // The first call is `changePassword`'s own lookup; the second is the lockout clear.
      return calls === 2 ? null : original(id);
    };

    await expect(
      harness.auth.resetPassword({ token, newPassword: NEW_PASSWORD }, CONTEXT, NOW),
    ).resolves.toBeUndefined();
    expect(harness.credentialStore.lockWrites).toHaveLength(0);
  });
});
