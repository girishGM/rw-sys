/**
 * T-055 — `MfaService`, against in-memory stores.
 *
 * Every rule this feature has lives here rather than in the controller, so this is where TC-1,
 * TC-2, TC-7, TC-11, TC-12, TC-16 and TC-17 are actually decided. `mfa.http.spec.ts` proves the
 * transport around it and `mfa.e2e-spec.ts` proves the SQL underneath it; neither substitutes for
 * this file.
 *
 * The crypto is **real** (T-016's `FieldCryptoService` over a real AES-256-GCM key held in a stub
 * registry), not a stub: "the seed is encrypted at rest" is one of the two things implementation
 * note 2 asks for, and a fake cipher would let a bug that stored plaintext pass every assertion.
 */
import { randomBytes } from 'node:crypto';
import { FieldCryptoService } from '@/common/crypto/field-crypto.service';
import type { KeyRegistryService, RegisteredKey } from '@/common/crypto/key-registry.service';
import { PermissionDeniedHttpException } from '@/common/rbac/rbac.exceptions';
import {
  InvalidCredentialsHttpException,
  NotFoundHttpException,
  SessionInvalidHttpException,
} from '@/modules/auth/auth.exceptions';
import {
  MfaAlreadyEnrolledHttpException,
  MfaEnrolmentRequiredHttpException,
} from '@/modules/auth/mfa.exceptions';
import { MFA_AUDIT_EVENT, RECOVERY_CODE_COUNT } from '@/modules/auth/mfa.constants';
import { AUTH_AUDIT_EVENT } from '@/modules/auth/session.constants';
import { MfaPendingTokenService } from '@/modules/auth/services/mfa-pending-token.service';
import {
  MfaService,
  generateRecoveryCodes,
  hashRecoveryCode,
} from '@/modules/auth/services/mfa.service';
import { SessionService } from '@/modules/auth/services/session.service';
import { TokenService } from '@/modules/auth/services/token.service';
import { decodeBase32, totpCodeAt } from '@/modules/auth/services/totp';
import { FakeMfaStore } from './support/fake-mfa-store';
import { FakeSessionStore } from './support/fake-session-store';
import { fakeConfigService, generateTestKeyPair } from './support/test-keys';

const NOW = new Date('2026-08-18T12:00:00.000Z');
const CONTEXT = { ipAddress: '198.51.100.9', userAgent: 'jest' };

interface Harness {
  readonly mfa: MfaService;
  readonly mfaStore: FakeMfaStore;
  readonly sessionStore: FakeSessionStore;
  readonly pendingTokens: MfaPendingTokenService;
  readonly crypto: FieldCryptoService;
}

/** A one-key registry: real AES-256-GCM, key material generated per test process (R4). */
function stubKeyRegistry(): KeyRegistryService {
  const key: RegisteredKey = {
    kid: 'k-test-mfa',
    purpose: 'field',
    algorithm: 'AES-256-GCM',
    status: 'active',
    material: randomBytes(32),
  };
  return {
    getActiveKey: () => key,
    getKeyForDecryption: () => key,
  } as unknown as KeyRegistryService;
}

function build(): Harness {
  const keys = generateTestKeyPair();
  const config = fakeConfigService({
    JWT_PRIVATE_KEY: keys.privateKey,
    JWT_PUBLIC_KEY: keys.publicKey,
  });

  const mfaStore = new FakeMfaStore();
  const sessionStore = new FakeSessionStore();
  const pendingTokens = new MfaPendingTokenService(config);
  const sessions = new SessionService(sessionStore, new TokenService(config));
  const crypto = new FieldCryptoService(stubKeyRegistry());

  return {
    mfa: new MfaService(pendingTokens, sessions, crypto, mfaStore, sessionStore),
    mfaStore,
    sessionStore,
    pendingTokens,
    crypto,
  };
}

/** A `super_admin` in both stores, with the ids kept in step (see `FakeSessionStore.seedUser`). */
function seedSuperAdmin(harness: Harness, overrides: Record<string, unknown> = {}): number {
  const user = harness.mfaStore.seedUser({
    role: 'super_admin',
    countryId: null,
    tenantId: null,
    merchantId: null,
    ...overrides,
  });
  harness.sessionStore.seedUser({
    id: user.id,
    email: user.email,
    role: user.role,
    countryId: null,
    tenantId: null,
    merchantId: null,
    mustChangePassword: user.mustChangePassword,
    mfaEnabled: user.mfaEnabled,
  });
  return user.id;
}

function pendingTokenFor(harness: Harness, userId: number, enrolled: boolean): string {
  return harness.pendingTokens.mint({ userId, enrolled }, NOW);
}

/** Reads the seed back out of the store the way a real authenticator app would hold it. */
function storedSecret(harness: Harness, userId: number): Buffer {
  const enc = harness.mfaStore.userFor(userId).secretEnc;
  if (enc === null) throw new Error('no secret stored');
  return decodeBase32(
    harness.crypto.decrypt(enc, {
      aad: FieldCryptoService.aadFor('reward_portal.portal_users', userId),
    }),
  );
}

/** Enrols a user end to end and returns the codes and the seed. */
async function enrol(harness: Harness, userId: number) {
  await harness.mfa.beginEnrolment(pendingTokenFor(harness, userId, false), CONTEXT, NOW);
  const secret = storedSecret(harness, userId);
  const result = await harness.mfa.verifyChallenge(
    { pendingToken: pendingTokenFor(harness, userId, false), code: totpCodeAt(secret, NOW) },
    CONTEXT,
    NOW,
  );
  return { secret, recoveryCodes: result.recoveryCodes ?? [] };
}

describe('beginEnrolment', () => {
  it('TC-1 (first half): writes an encrypted seed and returns it exactly once', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness);

    const offer = await harness.mfa.beginEnrolment(
      pendingTokenFor(harness, userId, false),
      CONTEXT,
      NOW,
    );

    const stored = harness.mfaStore.userFor(userId).secretEnc;
    expect(stored).not.toBeNull();
    // Encrypted at rest, in T-016's envelope — not the base32 the user was shown.
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain(offer.secret);
    expect(offer.otpauthUri).toContain(`secret=${offer.secret}`);
    expect(offer.digits).toBe(6);
    expect(offer.periodSeconds).toBe(30);
  });

  it('does NOT enable MFA — possession is not proved until a code is presented', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness);

    await harness.mfa.beginEnrolment(pendingTokenFor(harness, userId, false), CONTEXT, NOW);

    expect(harness.mfaStore.userFor(userId).mfaEnabled).toBe(false);
  });

  it('binds the ciphertext to the row, so it cannot be moved to another user', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness);
    const otherId = seedSuperAdmin(harness);

    await harness.mfa.beginEnrolment(pendingTokenFor(harness, userId, false), CONTEXT, NOW);
    const stolen = harness.mfaStore.userFor(userId).secretEnc as string;

    expect(() =>
      harness.crypto.decrypt(stolen, {
        aad: FieldCryptoService.aadFor('reward_portal.portal_users', otherId),
      }),
    ).toThrow();
  });

  it('TC-2: refuses to re-issue a seed once the account is enrolled', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness);
    await enrol(harness, userId);

    await expect(
      harness.mfa.beginEnrolment(pendingTokenFor(harness, userId, true), CONTEXT, NOW),
    ).rejects.toBeInstanceOf(MfaAlreadyEnrolledHttpException);
  });

  it('audits that an enrolment was started', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness);

    await harness.mfa.beginEnrolment(pendingTokenFor(harness, userId, false), CONTEXT, NOW);

    expect(harness.sessionStore.eventsOfType(MFA_AUDIT_EVENT.ENROLMENT_STARTED)).toHaveLength(1);
  });
});

describe('the pending token is re-checked against the live row', () => {
  it('rejects a token for a user that no longer exists', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness);
    harness.mfaStore.deletedUserIds.add(userId);

    await expect(
      harness.mfa.beginEnrolment(pendingTokenFor(harness, userId, false), CONTEXT, NOW),
    ).rejects.toBeInstanceOf(SessionInvalidHttpException);
  });

  it.each([['inactive'], ['locked'], ['suspended'], ['pending_activation']])(
    'rejects a token for a %s account, however valid the token is',
    async (status) => {
      const harness = build();
      const userId = seedSuperAdmin(harness, { status });

      await expect(
        harness.mfa.beginEnrolment(pendingTokenFor(harness, userId, false), CONTEXT, NOW),
      ).rejects.toBeInstanceOf(SessionInvalidHttpException);
    },
  );

  it('rejects a token naming a non-super_admin, which the hook would never mint', async () => {
    const harness = build();
    const user = harness.mfaStore.seedUser({ role: 'maker', countryId: 1, tenantId: 7 });

    await expect(
      harness.mfa.beginEnrolment(pendingTokenFor(harness, user.id, false), CONTEXT, NOW),
    ).rejects.toBeInstanceOf(SessionInvalidHttpException);
  });

  it('TC-13: rejects an expired token', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness);
    const token = pendingTokenFor(harness, userId, false);
    const later = new Date(NOW.getTime() + 6 * 60 * 1000);

    await expect(harness.mfa.beginEnrolment(token, CONTEXT, later)).rejects.toBeInstanceOf(
      SessionInvalidHttpException,
    );
  });

  it('rejects an absent token exactly as it rejects a bad one', async () => {
    const harness = build();
    await expect(harness.mfa.beginEnrolment('', CONTEXT, NOW)).rejects.toBeInstanceOf(
      SessionInvalidHttpException,
    );
  });
});

describe('verifyChallenge', () => {
  it('TC-1 (second half): a correct code enables MFA and returns ten recovery codes', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness);

    const { recoveryCodes } = await enrol(harness, userId);

    expect(harness.mfaStore.userFor(userId).mfaEnabled).toBe(true);
    expect(recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(recoveryCodes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of recoveryCodes)
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
    // Stored as digests only — the portal cannot reproduce a code it has shown.
    const stored = harness.mfaStore.codesFor(userId);
    expect(stored).toHaveLength(RECOVERY_CODE_COUNT);
    for (const code of recoveryCodes) {
      expect(stored.some((row) => row.codeHash === hashRecoveryCode(code))).toBe(true);
      expect(stored.some((row) => row.codeHash === code)).toBe(false);
    }
  });

  it('TC-6: creates a session with all three tokens, exactly as a non-MFA login would', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness);
    const { secret } = await enrol(harness, userId);

    const result = await harness.mfa.verifyChallenge(
      { pendingToken: pendingTokenFor(harness, userId, true), code: totpCodeAt(secret, NOW) },
      CONTEXT,
      NOW,
    );

    expect(result.session.accessToken.length).toBeGreaterThan(0);
    expect(result.session.refreshToken.length).toBeGreaterThan(0);
    expect(result.session.csrfToken.length).toBeGreaterThan(0);
    expect(result.role).toBe('super_admin');
    // No recovery codes on an ordinary login — they are returned once, at enrolment (TC-18).
    expect(result.recoveryCodes).toBeUndefined();
    // Two live sessions: the one the enrolment earned and the one this login earned. An ordinary
    // login does not revoke the user's other sessions, and must not start doing so here.
    expect(harness.sessionStore.sessions.filter((s) => s.status === 'active')).toHaveLength(2);
    expect(harness.sessionStore.sessionFor(result.session.sessionId).status).toBe('active');
  });

  it('TC-7: a wrong code is a generic 401, and creates nothing', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness);
    await enrol(harness, userId);
    const before = harness.sessionStore.sessions.length;

    await expect(
      harness.mfa.verifyChallenge(
        { pendingToken: pendingTokenFor(harness, userId, true), code: '000000' },
        CONTEXT,
        NOW,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsHttpException);

    expect(harness.sessionStore.sessions).toHaveLength(before);
    expect(harness.sessionStore.eventsOfType(MFA_AUDIT_EVENT.VERIFY_FAILED)).toHaveLength(1);
  });

  it('TC-9/TC-10: accepts one step of skew and rejects three', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness);
    const { secret } = await enrol(harness, userId);
    const step = 30_000;

    await expect(
      harness.mfa.verifyChallenge(
        {
          pendingToken: pendingTokenFor(harness, userId, true),
          code: totpCodeAt(secret, new Date(NOW.getTime() - step)),
        },
        CONTEXT,
        NOW,
      ),
    ).resolves.toBeDefined();

    await expect(
      harness.mfa.verifyChallenge(
        {
          pendingToken: pendingTokenFor(harness, userId, true),
          code: totpCodeAt(secret, new Date(NOW.getTime() - 3 * step)),
        },
        CONTEXT,
        NOW,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsHttpException);
  });

  it('refuses when there is no stored seed at all', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness, { mfaEnabled: true });

    await expect(
      harness.mfa.verifyChallenge(
        { pendingToken: pendingTokenFor(harness, userId, true), code: '123456' },
        CONTEXT,
        NOW,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsHttpException);
  });

  it('refuses when the stored seed will not decrypt, rather than 500ing', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness, {
      mfaEnabled: true,
      secretEnc: 'v1.k-test-mfa.AAAA.BBBB.CCCC',
    });

    await expect(
      harness.mfa.verifyChallenge(
        { pendingToken: pendingTokenFor(harness, userId, true), code: '123456' },
        CONTEXT,
        NOW,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsHttpException);
  });

  it('revokes every earlier session when the factor is first enabled', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness);
    // A session that predates the second factor — created under weaker authentication.
    const stale = await harness.sessionStore.createSession({
      userId,
      ipAddress: null,
      userAgent: null,
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 86_400_000),
    });

    await enrol(harness, userId);

    expect(harness.sessionStore.sessionFor(stale.id).status).toBe('revoked');
    // The session the enrolment itself earned survives.
    expect(harness.sessionStore.sessions.filter((s) => s.status === 'active')).toHaveLength(1);
  });

  it('writes both an mfa_verified row and the ordinary login_succeeded row', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness);
    await enrol(harness, userId);

    expect(harness.sessionStore.eventsOfType(MFA_AUDIT_EVENT.ENROLLED)).toHaveLength(1);
    expect(harness.sessionStore.eventsOfType(MFA_AUDIT_EVENT.VERIFIED)).toHaveLength(1);
    expect(harness.sessionStore.eventsOfType(AUTH_AUDIT_EVENT.LOGIN_SUCCEEDED)).toHaveLength(1);
  });

  it('still logs the user in when the audit table is unavailable', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness);
    await enrol(harness, userId);
    const { secret } = { secret: storedSecret(harness, userId) };
    harness.sessionStore.auditWriteFails = true;

    await expect(
      harness.mfa.verifyChallenge(
        { pendingToken: pendingTokenFor(harness, userId, true), code: totpCodeAt(secret, NOW) },
        CONTEXT,
        NOW,
      ),
    ).resolves.toBeDefined();
  });
});

describe('recover', () => {
  it('TC-11: a valid code logs the user in and marks that row used', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness);
    const { recoveryCodes } = await enrol(harness, userId);

    const result = await harness.mfa.recover(
      { pendingToken: pendingTokenFor(harness, userId, true), recoveryCode: recoveryCodes[0] },
      CONTEXT,
      NOW,
    );

    expect(result.session.accessToken.length).toBeGreaterThan(0);
    expect(result.recoveryCodesRemaining).toBe(RECOVERY_CODE_COUNT - 1);

    const used = harness.mfaStore
      .codesFor(userId)
      .filter((code) => code.codeHash === hashRecoveryCode(recoveryCodes[0]));
    expect(used[0].usedAt).toEqual(NOW);
    expect(harness.sessionStore.eventsOfType(MFA_AUDIT_EVENT.RECOVERY_USED)).toHaveLength(1);
  });

  it('accepts a code typed without its separators and in lower case', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness);
    const { recoveryCodes } = await enrol(harness, userId);

    await expect(
      harness.mfa.recover(
        {
          pendingToken: pendingTokenFor(harness, userId, true),
          recoveryCode: recoveryCodes[0].replace(/-/g, '').toLowerCase(),
        },
        CONTEXT,
        NOW,
      ),
    ).resolves.toBeDefined();
  });

  it('TC-12: a reused code is rejected AND audited as a reuse, not as a wrong guess', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness);
    const { recoveryCodes } = await enrol(harness, userId);
    await harness.mfa.recover(
      { pendingToken: pendingTokenFor(harness, userId, true), recoveryCode: recoveryCodes[0] },
      CONTEXT,
      NOW,
    );

    await expect(
      harness.mfa.recover(
        { pendingToken: pendingTokenFor(harness, userId, true), recoveryCode: recoveryCodes[0] },
        CONTEXT,
        NOW,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsHttpException);

    const reuse = harness.sessionStore.eventsOfType(MFA_AUDIT_EVENT.RECOVERY_REUSE);
    expect(reuse).toHaveLength(1);
    expect(reuse[0].targetId).toBe(String(userId));
    // The presented code never reaches the audit row, in any form.
    expect(JSON.stringify(reuse[0].detail)).not.toContain(recoveryCodes[0]);
  });

  it('rejects a code that never existed, and logs it as an ordinary failure', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness);
    await enrol(harness, userId);

    await expect(
      harness.mfa.recover(
        { pendingToken: pendingTokenFor(harness, userId, true), recoveryCode: 'ZZZZ-ZZZZ-ZZZZ' },
        CONTEXT,
        NOW,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsHttpException);

    expect(harness.sessionStore.eventsOfType(MFA_AUDIT_EVENT.RECOVERY_REUSE)).toHaveLength(0);
    expect(harness.sessionStore.eventsOfType(MFA_AUDIT_EVENT.VERIFY_FAILED)).toHaveLength(1);
  });

  it('refuses recovery on an account that is not enrolled', async () => {
    const harness = build();
    const userId = seedSuperAdmin(harness);
    // Codes exist but the factor does not — the state an administrative reset leaves behind if
    // only the flag were cleared. Recovery must not be a way back in.
    await harness.mfaStore.insertRecoveryCodes(userId, [hashRecoveryCode('AAAA-BBBB-CCCC')]);

    await expect(
      harness.mfa.recover(
        { pendingToken: pendingTokenFor(harness, userId, false), recoveryCode: 'AAAA-BBBB-CCCC' },
        CONTEXT,
        NOW,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsHttpException);
  });
});

describe('resetByAdmin', () => {
  async function twoSuperAdmins() {
    const harness = build();
    const actorId = seedSuperAdmin(harness);
    const targetId = seedSuperAdmin(harness);
    await enrol(harness, actorId);
    await enrol(harness, targetId);
    return { harness, actorId, targetId };
  }

  it('TC-17: clears the target factor, its codes and its sessions, and audits both ids', async () => {
    const { harness, actorId, targetId } = await twoSuperAdmins();

    await harness.mfa.resetByAdmin(
      { userId: actorId, role: 'super_admin' },
      targetId,
      CONTEXT,
      NOW,
    );

    const target = harness.mfaStore.userFor(targetId);
    expect(target.mfaEnabled).toBe(false);
    expect(target.secretEnc).toBeNull();
    expect(harness.mfaStore.codesFor(targetId).every((code) => code.usedAt !== null)).toBe(true);
    expect(
      harness.sessionStore.sessions
        .filter((session) => session.userId === targetId)
        .every((session) => session.status === 'revoked'),
    ).toBe(true);

    const audit = harness.sessionStore.eventsOfType(MFA_AUDIT_EVENT.RESET_BY_ADMIN);
    expect(audit).toHaveLength(1);
    expect(audit[0].actorId).toBe(actorId);
    expect(audit[0].targetId).toBe(String(targetId));
    expect(audit[0].detail).toEqual({ actorUserId: actorId, targetUserId: targetId });

    // The actor's own session is untouched — this is not a self-inflicted logout.
    expect(
      harness.sessionStore.sessions.filter(
        (session) => session.userId === actorId && session.status === 'active',
      ),
    ).toHaveLength(1);
  });

  it('TC-16: refuses when the acting super_admin has no satisfied factor of their own', async () => {
    const harness = build();
    const actorId = seedSuperAdmin(harness); // never enrolled
    const targetId = seedSuperAdmin(harness);
    await enrol(harness, targetId);

    await expect(
      harness.mfa.resetByAdmin({ userId: actorId, role: 'super_admin' }, targetId, CONTEXT, NOW),
    ).rejects.toBeInstanceOf(MfaEnrolmentRequiredHttpException);

    expect(harness.mfaStore.userFor(targetId).mfaEnabled).toBe(true);
  });

  it('refuses when the acting user has vanished under a live session', async () => {
    const { harness, actorId, targetId } = await twoSuperAdmins();
    harness.mfaStore.deletedUserIds.add(actorId);

    await expect(
      harness.mfa.resetByAdmin({ userId: actorId, role: 'super_admin' }, targetId, CONTEXT, NOW),
    ).rejects.toBeInstanceOf(MfaEnrolmentRequiredHttpException);
  });

  it('refuses a self-reset — note 6 says "another super_admin"', async () => {
    const { harness, actorId } = await twoSuperAdmins();

    await expect(
      harness.mfa.resetByAdmin({ userId: actorId, role: 'super_admin' }, actorId, CONTEXT, NOW),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);

    expect(harness.mfaStore.userFor(actorId).mfaEnabled).toBe(true);
  });

  it('answers 404 for an unknown target and for a target that is not a super_admin', async () => {
    const { harness, actorId } = await twoSuperAdmins();
    const maker = harness.mfaStore.seedUser({ role: 'maker', countryId: 1, tenantId: 7 });

    await expect(
      harness.mfa.resetByAdmin({ userId: actorId, role: 'super_admin' }, 999_999, CONTEXT, NOW),
    ).rejects.toBeInstanceOf(NotFoundHttpException);

    await expect(
      harness.mfa.resetByAdmin({ userId: actorId, role: 'super_admin' }, maker.id, CONTEXT, NOW),
    ).rejects.toBeInstanceOf(NotFoundHttpException);
  });

  it('leaves the target unable to recover with an old code afterwards', async () => {
    const harness = build();
    const actorId = seedSuperAdmin(harness);
    const targetId = seedSuperAdmin(harness);
    await enrol(harness, actorId);
    const { recoveryCodes } = await enrol(harness, targetId);

    await harness.mfa.resetByAdmin(
      { userId: actorId, role: 'super_admin' },
      targetId,
      CONTEXT,
      NOW,
    );

    await expect(
      harness.mfa.recover(
        { pendingToken: pendingTokenFor(harness, targetId, true), recoveryCode: recoveryCodes[1] },
        CONTEXT,
        NOW,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsHttpException);
  });
});

describe('generateRecoveryCodes', () => {
  it('produces ten distinct codes with matching digests', () => {
    const { display, hashes } = generateRecoveryCodes();

    expect(display).toHaveLength(RECOVERY_CODE_COUNT);
    expect(hashes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(display).size).toBe(RECOVERY_CODE_COUNT);
    display.forEach((code, index) => expect(hashes[index]).toBe(hashRecoveryCode(code)));
  });

  it('draws only from an alphabet with no ambiguous characters', () => {
    for (let round = 0; round < 20; round += 1) {
      for (const code of generateRecoveryCodes().display) {
        expect(code).not.toMatch(/[ILOU]/);
        expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      }
    }
  });

  it('hashes to a 64-character hex digest that fits code_hash varchar(128)', () => {
    expect(hashRecoveryCode('ABCD-EFGH-JKMN')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalises separators and case, so the printed and typed forms agree', () => {
    expect(hashRecoveryCode('abcd efgh jkmn')).toBe(hashRecoveryCode('ABCD-EFGH-JKMN'));
    expect(hashRecoveryCode('ABCDEFGHJKMN')).toBe(hashRecoveryCode('ABCD-EFGH-JKMN'));
  });
});
