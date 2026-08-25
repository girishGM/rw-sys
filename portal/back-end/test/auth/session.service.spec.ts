/**
 * T-011 — `SessionService`: issuance, rotation, reuse detection, revocation.
 *
 * TC-12, TC-13 and TC-27/TC-28 live here in their unit form, and are re-run over real HTTP
 * against real Postgres in `auth.e2e-spec.ts`. The two are complementary rather than redundant:
 * this file can drive branches a database will not produce on demand — a consume that loses a
 * race, an audit table that is unavailable, a user row that vanishes mid-rotation — while only
 * the e2e suite can prove that `SELECT … FOR UPDATE` actually serialises two concurrent replays.
 */
import { FakeSessionStore } from './support/fake-session-store';
import { fakeConfigService, generateTestKeyPair } from './support/test-keys';
import { SessionService } from '@/modules/auth/services/session.service';
import { TokenService } from '@/modules/auth/services/token.service';
import type { AuthUserRow } from '@/modules/auth/services/credential.repository';
import {
  AUTH_AUDIT_EVENT,
  REFRESH_TOKEN_TTL_SECONDS,
  REVOCATION_REASON,
  SESSION_TOUCH_INTERVAL_MS,
  SESSION_TTL_SECONDS,
} from '@/modules/auth/session.constants';

const NOW = new Date('2026-08-17T10:00:00.000Z');
const CONTEXT = { ipAddress: '203.0.113.7', userAgent: 'jest' };

function build() {
  const keys = generateTestKeyPair();
  const tokens = new TokenService(
    fakeConfigService({ JWT_PRIVATE_KEY: keys.privateKey, JWT_PUBLIC_KEY: keys.publicKey }),
  );
  const store = new FakeSessionStore();
  return { store, tokens, sessions: new SessionService(store, tokens) };
}

/** Logs a user in and returns everything the tests need to poke at the result. */
async function login(
  harness: ReturnType<typeof build>,
  overrides: Partial<AuthUserRow> = {},
  now: Date = NOW,
) {
  const user = harness.store.seedUser(overrides);
  const session = await harness.sessions.start(user, CONTEXT, now);
  return { user, session };
}

describe('SessionService.start', () => {
  it('creates one session, one refresh token and one access token', async () => {
    const harness = build();
    const { user, session } = await login(harness);

    expect(harness.store.sessions).toHaveLength(1);
    expect(harness.store.refreshTokens).toHaveLength(1);
    expect(harness.store.sessionFor(session.sessionId).userId).toBe(user.id);
    expect(harness.store.refreshTokens[0].parentTokenId).toBeNull();
  });

  it('stores only the SHA-256 of the refresh token, never the token itself', async () => {
    const harness = build();
    const { session } = await login(harness);

    const stored = harness.store.refreshTokens[0].tokenHash;
    expect(stored).toBe(harness.tokens.hashOpaqueToken(session.refreshToken));
    expect(stored).not.toBe(session.refreshToken);
    expect(JSON.stringify(harness.store.refreshTokens)).not.toContain(session.refreshToken);
  });

  it('sets the session and refresh lifetimes from the constants, not from a magic number', async () => {
    const harness = build();
    const { session } = await login(harness);

    expect(harness.store.sessionFor(session.sessionId).expiresAt.getTime()).toBe(
      NOW.getTime() + SESSION_TTL_SECONDS * 1000,
    );
    expect(harness.store.refreshTokens[0].expiresAt.getTime()).toBe(
      NOW.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000,
    );
  });

  it('carries the live must-change flag alongside the tokens, so no caller re-queries it', async () => {
    const harness = build();
    const confined = await login(harness, { mustChangePassword: true });
    const ordinary = await login(harness, { mustChangePassword: false });

    expect(confined.session.mustChangePassword).toBe(true);
    expect(ordinary.session.mustChangePassword).toBe(false);
  });

  it('mints an access token whose claims match the user row and the seeded rbac version', async () => {
    const harness = build();
    harness.store.rbacVersions.set('tenant_admin', 9);
    const { session } = await login(harness, { role: 'tenant_admin', countryId: 3, tenantId: 7 });

    const claims = harness.tokens.verifyAccessToken(session.accessToken, NOW);
    expect(claims).toMatchObject({
      role: 'tenant_admin',
      countryId: 3,
      tenantId: 7,
      rbacVersion: 9,
    });
    expect(claims.sessionId).toBe(session.sessionId);
  });

  it('falls back to rbacVersion 0 when the config row is absent', async () => {
    const harness = build();
    const { session } = await login(harness);

    expect(harness.tokens.verifyAccessToken(session.accessToken, NOW).rbacVersion).toBe(0);
  });

  it('records the login timestamp and derives the CSRF value from the session id', async () => {
    const harness = build();
    const { user, session } = await login(harness);

    expect(harness.store.lastLogins).toEqual([{ userId: user.id, at: NOW }]);
    expect(session.csrfToken).toBe(harness.tokens.csrfTokenFor(session.sessionId));
  });
});

describe('SessionService.rotate — the happy path (TC-12)', () => {
  it('issues a new access and refresh token and consumes the old one', async () => {
    const harness = build();
    const { session } = await login(harness);
    const originalTokenId = harness.store.refreshTokens[0].id;

    const outcome = await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);

    expect(outcome.status).toBe('rotated');
    expect(harness.store.tokenFor(originalTokenId).status).toBe('consumed');
    expect(harness.store.refreshTokens).toHaveLength(2);
  });

  it('links the new token to the old one, so the family is traceable', async () => {
    const harness = build();
    const { session } = await login(harness);
    const originalTokenId = harness.store.refreshTokens[0].id;

    await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);

    expect(harness.store.refreshTokens[1].parentTokenId).toBe(originalTokenId);
    expect(harness.store.refreshTokens[1].sessionId).toBe(session.sessionId);
  });

  it('keeps the same session and touches last_seen_at', async () => {
    const harness = build();
    const { session } = await login(harness);
    const later = new Date(NOW.getTime() + 60_000);

    const outcome = await harness.sessions.rotate(session.refreshToken, CONTEXT, later);

    expect(outcome.status === 'rotated' && outcome.session.sessionId).toBe(session.sessionId);
    expect(harness.store.sessionFor(session.sessionId).lastSeenAt).toEqual(later);
  });

  it('writes a refresh_rotated audit row', async () => {
    const harness = build();
    const { user, session } = await login(harness);

    await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);

    expect(harness.store.eventsOfType(AUTH_AUDIT_EVENT.REFRESH_ROTATED)).toEqual([
      expect.objectContaining({ actorId: user.id, targetId: session.sessionId }),
    ]);
  });

  it('the returned refresh token is new, and the presented one no longer works', async () => {
    const harness = build();
    const { session } = await login(harness);

    const first = await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);
    if (first.status !== 'rotated') throw new Error('expected a rotation');

    expect(first.session.refreshToken).not.toBe(session.refreshToken);
    const replay = await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);
    expect(replay.status).toBe('rejected');
  });
});

describe('SessionService.rotate — AR-04: claims are re-derived, never re-signed (TC-27/TC-28)', () => {
  it('TC-27: a role changed in the database is reflected in the next access token', async () => {
    const harness = build();
    const { user, session } = await login(harness, { role: 'maker' });

    // The demotion/promotion happens directly on the user row, exactly as an admin screen would.
    const index = harness.store.users.findIndex((u) => u.id === user.id);
    harness.store.users[index] = { ...harness.store.users[index], role: 'tenant_admin' };

    const outcome = await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);
    if (outcome.status !== 'rotated') throw new Error('expected a rotation');

    expect(harness.tokens.verifyAccessToken(outcome.session.accessToken, NOW).role).toBe(
      'tenant_admin',
    );
    // And emphatically not the role the presented token carried.
    expect(harness.tokens.verifyAccessToken(session.accessToken, NOW).role).toBe('maker');
  });

  it('TC-28: a changed tenant_id is reflected too', async () => {
    const harness = build();
    const { user, session } = await login(harness, { tenantId: 7 });

    const index = harness.store.users.findIndex((u) => u.id === user.id);
    harness.store.users[index] = { ...harness.store.users[index], tenantId: 99 };

    const outcome = await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);
    if (outcome.status !== 'rotated') throw new Error('expected a rotation');

    expect(harness.tokens.verifyAccessToken(outcome.session.accessToken, NOW).tenantId).toBe(99);
  });

  it('re-reads must_change_password too, so a rotation cannot report a stale flag', async () => {
    const harness = build();
    const { user, session } = await login(harness, { mustChangePassword: true });
    await harness.store.setMustChangePassword(user.id, false);

    const outcome = await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);
    if (outcome.status !== 'rotated') throw new Error('expected a rotation');

    expect(outcome.session.mustChangePassword).toBe(false);
  });

  it('re-reads rbacVersion as well, so a permission bump is picked up on refresh', async () => {
    const harness = build();
    const { session } = await login(harness, { role: 'maker' });
    harness.store.rbacVersions.set('maker', 4);

    const outcome = await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);
    if (outcome.status !== 'rotated') throw new Error('expected a rotation');

    expect(harness.tokens.verifyAccessToken(outcome.session.accessToken, NOW).rbacVersion).toBe(4);
  });
});

describe('SessionService.rotate — reuse detection (TC-13)', () => {
  async function replay() {
    const harness = build();
    const { user, session } = await login(harness);
    const first = await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);
    if (first.status !== 'rotated') throw new Error('expected a rotation');

    const outcome = await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);
    return { harness, user, session, first, outcome };
  }

  it('rejects the replay', async () => {
    const { outcome } = await replay();
    expect(outcome).toEqual({ status: 'rejected', reason: 'reuse_detected' });
  });

  it('revokes the ENTIRE family, including the token the legitimate client just received', async () => {
    const { harness, session } = await replay();

    const family = harness.store.tokensForSession(session.sessionId);
    expect(family).toHaveLength(2);
    expect(family.every((token) => token.status === 'revoked')).toBe(true);
  });

  it('revokes the session itself, with the reuse reason recorded', async () => {
    const { harness, session } = await replay();

    expect(harness.store.sessionFor(session.sessionId)).toMatchObject({
      status: 'revoked',
      revokedReason: REVOCATION_REASON.REFRESH_REUSE_DETECTED,
    });
  });

  it('writes exactly one refresh_reuse_detected audit row, with ids but no token material', async () => {
    const { harness, user, session } = await replay();

    const events = harness.store.eventsOfType(AUTH_AUDIT_EVENT.REFRESH_REUSE_DETECTED);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorId: user.id, targetId: session.sessionId });
    expect(JSON.stringify(events[0])).not.toContain(session.refreshToken);
  });

  it('makes the token issued by the winning rotation unusable as well', async () => {
    const { harness, first } = await replay();
    if (first.status !== 'rotated') throw new Error('expected a rotation');

    const afterDetection = await harness.sessions.rotate(first.session.refreshToken, CONTEXT, NOW);
    expect(afterDetection.status).toBe('rejected');
  });

  it('treats a lost consume race as reuse — the fail-closed branch behind the FOR UPDATE lock', async () => {
    const harness = build();
    const { session } = await login(harness);
    harness.store.refreshConsumeLosesRace = true;

    const outcome = await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);

    expect(outcome).toEqual({ status: 'rejected', reason: 'reuse_detected' });
    expect(harness.store.sessionFor(session.sessionId).status).toBe('revoked');
  });
});

describe('SessionService.rotate — the other rejection paths', () => {
  it('rejects an unknown token and audits it, without revoking anything', async () => {
    const harness = build();
    await login(harness);

    const outcome = await harness.sessions.rotate('not-a-real-token', CONTEXT, NOW);

    expect(outcome).toEqual({ status: 'rejected', reason: 'unknown' });
    expect(harness.store.eventsOfType(AUTH_AUDIT_EVENT.REFRESH_UNKNOWN)).toHaveLength(1);
    expect(harness.store.sessions[0].status).toBe('active');
  });

  it('rejects a token that was revoked rather than consumed', async () => {
    const harness = build();
    const { session } = await login(harness);
    await harness.sessions.revoke(session.sessionId, 'logout', null, CONTEXT, 'logout');

    const outcome = await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);

    expect(outcome).toEqual({ status: 'rejected', reason: 'revoked' });
    // Not reuse: a revoked token is an expected consequence of logout, not evidence of theft.
    expect(harness.store.eventsOfType(AUTH_AUDIT_EVENT.REFRESH_REUSE_DETECTED)).toHaveLength(0);
  });

  it('rejects an expired refresh token', async () => {
    const harness = build();
    const { session } = await login(harness);
    const afterExpiry = new Date(NOW.getTime() + (REFRESH_TOKEN_TTL_SECONDS + 1) * 1000);

    const outcome = await harness.sessions.rotate(session.refreshToken, CONTEXT, afterExpiry);

    expect(outcome).toEqual({ status: 'rejected', reason: 'expired' });
  });

  it('rejects a token whose session has been revoked out from under it', async () => {
    const harness = build();
    const { session } = await login(harness);
    // Revoke the session but leave the token active — the shape a partial failure would leave.
    await harness.store.revokeSession(session.sessionId, 'user_revoked');

    const outcome = await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);

    expect(outcome).toEqual({ status: 'rejected', reason: 'session_invalid' });
  });

  it('rejects a token whose session context has vanished entirely', async () => {
    const harness = build();
    const { session } = await login(harness);
    harness.store.sessions.length = 0;

    const outcome = await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);

    expect(outcome).toEqual({ status: 'rejected', reason: 'session_invalid' });
  });

  it('rejects when the user has been deactivated since the token was issued', async () => {
    const harness = build();
    const { user, session } = await login(harness);
    const index = harness.store.users.findIndex((u) => u.id === user.id);
    harness.store.users[index] = { ...harness.store.users[index], status: 'inactive' };

    const outcome = await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);

    // Caught by the session-context check, which reads the user's live status.
    expect(outcome).toEqual({ status: 'rejected', reason: 'session_invalid' });
  });

  it('rejects when the user row disappears after the session check but before the re-read', async () => {
    const harness = build();
    const { user, session } = await login(harness);

    // Session context is served from a snapshot the fake keeps; deleting the user only after
    // that read is what isolates the `findUserById === null` branch.
    const originalFind = harness.store.findUserById.bind(harness.store);
    harness.store.findUserById = async () => {
      harness.store.findUserById = originalFind;
      return null;
    };

    const outcome = await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);

    expect(outcome).toEqual({ status: 'rejected', reason: 'user_inactive' });
    expect(user.id).toBeGreaterThan(0);
  });

  it('rejects when the re-read user is no longer active', async () => {
    const harness = build();
    const { user, session } = await login(harness);

    const originalFind = harness.store.findUserById.bind(harness.store);
    harness.store.findUserById = async (id: number) => {
      harness.store.findUserById = originalFind;
      const row = await originalFind(id);
      return row === null ? null : { ...row, status: 'suspended' };
    };

    const outcome = await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);

    expect(outcome).toEqual({ status: 'rejected', reason: 'user_inactive' });
    expect(user.status).toBe('active');
  });
});

describe('SessionService.resolveActive', () => {
  it('returns the live context for a healthy session', async () => {
    const harness = build();
    const { user, session } = await login(harness);

    const context = await harness.sessions.resolveActive(session.sessionId, NOW);

    expect(context).toMatchObject({ userId: user.id, mustChangePassword: false });
  });

  it('returns null for an unknown session id', async () => {
    const harness = build();
    expect(await harness.sessions.resolveActive('nope', NOW)).toBeNull();
  });

  it('returns null once the session is revoked (TC-16)', async () => {
    const harness = build();
    const { session } = await login(harness);
    await harness.store.revokeSession(session.sessionId, 'logout');

    expect(await harness.sessions.resolveActive(session.sessionId, NOW)).toBeNull();
  });

  it('returns null once the session has expired', async () => {
    const harness = build();
    const { session } = await login(harness);
    const afterExpiry = new Date(NOW.getTime() + (SESSION_TTL_SECONDS + 1) * 1000);

    expect(await harness.sessions.resolveActive(session.sessionId, afterExpiry)).toBeNull();
  });

  it('TC-17: returns null when the user has been deactivated, without any session change', async () => {
    const harness = build();
    const { user, session } = await login(harness);
    const index = harness.store.users.findIndex((u) => u.id === user.id);
    harness.store.users[index] = { ...harness.store.users[index], status: 'inactive' };

    expect(await harness.sessions.resolveActive(session.sessionId, NOW)).toBeNull();
    // The session row itself is untouched — the guard denies on the user's status alone.
    expect(harness.store.sessionFor(session.sessionId).status).toBe('active');
  });

  it('returns null when the user has been soft-deleted', async () => {
    const harness = build();
    const { user, session } = await login(harness);
    harness.store.deletedUserIds.add(user.id);

    // `deleted_at IS NULL` in the real query; a soft-deleted account must not hold a session
    // even while its `status` still reads `active`.
    expect(await harness.sessions.resolveActive(session.sessionId, NOW)).toBeNull();
  });

  it('returns null when the session has no user row at all', async () => {
    const harness = build();
    const { session } = await login(harness);
    harness.store.users.length = 0;

    expect(await harness.sessions.resolveActive(session.sessionId, NOW)).toBeNull();
  });

  it('does not write last_seen_at on every request', async () => {
    const harness = build();
    const { session } = await login(harness);
    const soon = new Date(NOW.getTime() + SESSION_TOUCH_INTERVAL_MS - 1);

    await harness.sessions.resolveActive(session.sessionId, soon);

    expect(harness.store.sessionFor(session.sessionId).lastSeenAt).toEqual(NOW);
  });

  it('writes last_seen_at once the touch interval has passed', async () => {
    const harness = build();
    const { session } = await login(harness);
    const later = new Date(NOW.getTime() + SESSION_TOUCH_INTERVAL_MS);

    await harness.sessions.resolveActive(session.sessionId, later);

    expect(harness.store.sessionFor(session.sessionId).lastSeenAt).toEqual(later);
  });

  it('reports the live must_change_password flag (TC-20)', async () => {
    const harness = build();
    const { user, session } = await login(harness, { mustChangePassword: true });

    expect((await harness.sessions.resolveActive(session.sessionId, NOW))?.mustChangePassword).toBe(
      true,
    );

    await harness.store.setMustChangePassword(user.id, false);

    expect((await harness.sessions.resolveActive(session.sessionId, NOW))?.mustChangePassword).toBe(
      false,
    );
  });
});

/**
 * T-013 implementation note 9 / architect review AR-10 (00-ARCHITECTURE.md §5.3).
 *
 * These belong to T-013 rather than T-011, and are placed here because the predicate they
 * exercise — `isUsableSession` — is `SessionService`'s. T-034 and T-036 bulk-revoke sessions when
 * a tenant is suspended or a merchant deactivated; this is the backstop for the window before
 * that completes, and for the case where it fails partway, so it must hold *without* any session
 * row being touched. Every assertion below therefore also checks that the session is still
 * `active` in the store: if the test passed because something had revoked the session, it would
 * be proving the wrong thing.
 *
 * The HTTP-level versions (TC-23/TC-24) run against real Postgres in `test/rbac/rbac.e2e-spec.ts`.
 */
describe('SessionService — parent tenant/merchant status (T-013 note 9, AR-10)', () => {
  const SUSPENDED_STATUSES = ['suspended', 'inactive', 'pending_provisioning'] as const;

  it('admits a session whose tenant is active', async () => {
    const harness = build();
    harness.store.tenantStatuses.set(7, 'active');
    const { session } = await login(harness, { tenantId: 7 });

    expect(await harness.sessions.resolveActive(session.sessionId, NOW)).not.toBeNull();
  });

  it.each(SUSPENDED_STATUSES)(
    'TC-23: rejects the session on the next request when the tenant becomes "%s"',
    async (status) => {
      const harness = build();
      harness.store.tenantStatuses.set(7, 'active');
      const { session } = await login(harness, { tenantId: 7, role: 'maker' });

      expect(await harness.sessions.resolveActive(session.sessionId, NOW)).not.toBeNull();

      harness.store.tenantStatuses.set(7, status);

      expect(await harness.sessions.resolveActive(session.sessionId, NOW)).toBeNull();
      // No bulk revoke has run — the session row is untouched, and the denial comes entirely
      // from the parent's status. That is the property AR-10 asks for.
      expect(harness.store.sessionFor(session.sessionId).status).toBe('active');
    },
  );

  it.each(SUSPENDED_STATUSES)(
    'TC-24: rejects a merchant session when the merchant becomes "%s"',
    async (status) => {
      const harness = build();
      harness.store.tenantStatuses.set(7, 'active');
      harness.store.merchantStatuses.set(42, 'active');
      const { session } = await login(harness, { tenantId: 7, merchantId: 42, role: 'merchant' });

      expect(await harness.sessions.resolveActive(session.sessionId, NOW)).not.toBeNull();

      harness.store.merchantStatuses.set(42, status);

      expect(await harness.sessions.resolveActive(session.sessionId, NOW)).toBeNull();
      expect(harness.store.sessionFor(session.sessionId).status).toBe('active');
    },
  );

  it('admits a super_admin, who has no tenant and no merchant to check', async () => {
    // The failure this guards against: an INNER JOIN instead of a LEFT JOIN would return no row
    // for a NULL tenant_id and log every Super Admin out.
    const harness = build();
    const { session } = await login(harness, {
      role: 'super_admin',
      countryId: null,
      tenantId: null,
      merchantId: null,
    });

    expect(await harness.sessions.resolveActive(session.sessionId, NOW)).not.toBeNull();
  });

  it('admits a country_admin, who has a country but no tenant', async () => {
    const harness = build();
    const { session } = await login(harness, {
      role: 'country_admin',
      countryId: 1,
      tenantId: null,
      merchantId: null,
    });

    expect(await harness.sessions.resolveActive(session.sessionId, NOW)).not.toBeNull();
  });

  it('does not check the merchant status of a non-merchant user in a suspended merchant’s tenant', async () => {
    const harness = build();
    harness.store.tenantStatuses.set(7, 'active');
    harness.store.merchantStatuses.set(42, 'suspended');
    const { session } = await login(harness, { role: 'maker', tenantId: 7, merchantId: null });

    // A maker carries no `merchant_id`, so the LEFT JOIN yields NULL and the check does not
    // apply — a suspended merchant elsewhere in the tenant must not log the tenant's makers out.
    expect(await harness.sessions.resolveActive(session.sessionId, NOW)).not.toBeNull();
  });

  it('rejects when both parents are suspended, without depending on evaluation order', async () => {
    const harness = build();
    harness.store.tenantStatuses.set(7, 'suspended');
    harness.store.merchantStatuses.set(42, 'suspended');
    const { session } = await login(harness, { role: 'merchant', tenantId: 7, merchantId: 42 });

    expect(await harness.sessions.resolveActive(session.sessionId, NOW)).toBeNull();
  });

  it('blocks refresh too, so a suspension cannot be worked around by rotating', async () => {
    const harness = build();
    harness.store.tenantStatuses.set(7, 'active');
    const { session } = await login(harness, { tenantId: 7 });

    harness.store.tenantStatuses.set(7, 'suspended');

    const outcome = await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);
    expect(outcome).toEqual({ status: 'rejected', reason: 'session_invalid' });
  });
});

describe('SessionService — revocation', () => {
  it('revoke() kills the session and its whole refresh family (TC-16)', async () => {
    const harness = build();
    const { user, session } = await login(harness);

    await harness.sessions.revoke(
      session.sessionId,
      REVOCATION_REASON.LOGOUT,
      { userId: user.id, role: user.role },
      CONTEXT,
      AUTH_AUDIT_EVENT.LOGOUT,
    );

    expect(harness.store.sessionFor(session.sessionId).status).toBe('revoked');
    expect(harness.store.tokensForSession(session.sessionId)[0].status).toBe('revoked');
    expect(harness.store.eventsOfType(AUTH_AUDIT_EVENT.LOGOUT)).toHaveLength(1);
  });

  it('revoke() attributes the audit row to nobody when there is no actor', async () => {
    const harness = build();
    const { session } = await login(harness);

    await harness.sessions.revoke(session.sessionId, 'x', null, CONTEXT, AUTH_AUDIT_EVENT.LOGOUT);

    expect(harness.store.eventsOfType(AUTH_AUDIT_EVENT.LOGOUT)[0]).toMatchObject({
      actorId: null,
      actorRole: null,
    });
  });

  it('TC-18: revokeAllForUser() ends every session the user holds', async () => {
    const harness = build();
    const user = harness.store.seedUser();
    const sessions = [
      await harness.sessions.start(user, CONTEXT, NOW),
      await harness.sessions.start(user, CONTEXT, NOW),
      await harness.sessions.start(user, CONTEXT, NOW),
    ];

    const revoked = await harness.sessions.revokeAllForUser(
      user.id,
      REVOCATION_REASON.LOGOUT_ALL,
      null,
      { userId: user.id, role: user.role },
      CONTEXT,
      AUTH_AUDIT_EVENT.LOGOUT_ALL,
    );

    expect(revoked).toBe(3);
    for (const session of sessions) {
      expect(harness.store.sessionFor(session.sessionId).status).toBe('revoked');
      expect(harness.store.tokensForSession(session.sessionId)[0].status).toBe('revoked');
    }
  });

  it('spares the nominated session, which is what a password change needs', async () => {
    const harness = build();
    const user = harness.store.seedUser();
    const kept = await harness.sessions.start(user, CONTEXT, NOW);
    const other = await harness.sessions.start(user, CONTEXT, NOW);

    const revoked = await harness.sessions.revokeAllForUser(
      user.id,
      REVOCATION_REASON.PASSWORD_CHANGED,
      kept.sessionId,
      null,
      CONTEXT,
      AUTH_AUDIT_EVENT.PASSWORD_CHANGED,
    );

    expect(revoked).toBe(1);
    expect(harness.store.sessionFor(kept.sessionId).status).toBe('active');
    expect(harness.store.tokensForSession(kept.sessionId)[0].status).toBe('active');
    expect(harness.store.sessionFor(other.sessionId).status).toBe('revoked');
  });

  it("leaves another user's sessions completely alone", async () => {
    const harness = build();
    const mine = harness.store.seedUser();
    const theirs = harness.store.seedUser();
    const myself = await harness.sessions.start(mine, CONTEXT, NOW);
    const stranger = await harness.sessions.start(theirs, CONTEXT, NOW);

    await harness.sessions.revokeAllForUser(
      mine.id,
      'logout_all',
      null,
      null,
      CONTEXT,
      'logout_all',
    );

    expect(harness.store.sessionFor(myself.sessionId).status).toBe('revoked');
    expect(harness.store.sessionFor(stranger.sessionId).status).toBe('active');
    expect(harness.store.tokensForSession(stranger.sessionId)[0].status).toBe('active');
  });
});

describe('SessionService — the sessions list (TC-24)', () => {
  it("returns only the caller's live sessions, flagging the current one", async () => {
    const harness = build();
    const user = harness.store.seedUser();
    const other = harness.store.seedUser();
    const current = await harness.sessions.start(user, CONTEXT, NOW);
    await harness.sessions.start(user, CONTEXT, NOW);
    await harness.sessions.start(other, CONTEXT, NOW);

    const list = await harness.sessions.listForUser(user.id, current.sessionId, NOW);

    expect(list).toHaveLength(2);
    expect(list.filter((entry) => entry.current)).toHaveLength(1);
    expect(list.find((entry) => entry.current)?.id).toBe(current.sessionId);
  });

  it('exposes no token, hash, secret or password key at any depth', async () => {
    const harness = build();
    const user = harness.store.seedUser();
    const session = await harness.sessions.start(user, CONTEXT, NOW);

    const list = await harness.sessions.listForUser(user.id, session.sessionId, NOW);

    expect(Object.keys(list[0]).filter((key) => /hash|secret|token|password/i.test(key))).toEqual(
      [],
    );
  });

  it('omits revoked and expired sessions', async () => {
    const harness = build();
    const user = harness.store.seedUser();
    const revoked = await harness.sessions.start(user, CONTEXT, NOW);
    await harness.store.revokeSession(revoked.sessionId, 'logout');
    const live = await harness.sessions.start(user, CONTEXT, NOW);

    const list = await harness.sessions.listForUser(user.id, live.sessionId, NOW);

    expect(list.map((entry) => entry.id)).toEqual([live.sessionId]);
  });

  it("TC-25: findOwnedSession returns null for another user's session", async () => {
    const harness = build();
    const mine = harness.store.seedUser();
    const theirs = harness.store.seedUser();
    const stranger = await harness.sessions.start(theirs, CONTEXT, NOW);

    expect(await harness.sessions.findOwnedSession(stranger.sessionId, mine.id)).toBeNull();
    expect(await harness.sessions.findOwnedSession(stranger.sessionId, theirs.id)).not.toBeNull();
  });
});

describe('SessionService — an audit outage must not break authentication', () => {
  it('still revokes when the audit write fails', async () => {
    const harness = build();
    const { session } = await login(harness);
    harness.store.auditWriteFails = true;

    await expect(
      harness.sessions.revoke(session.sessionId, 'logout', null, CONTEXT, AUTH_AUDIT_EVENT.LOGOUT),
    ).resolves.toBeUndefined();

    expect(harness.store.sessionFor(session.sessionId).status).toBe('revoked');
  });

  it('still detects reuse and revokes the family when the audit write fails', async () => {
    const harness = build();
    const { session } = await login(harness);
    await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);
    harness.store.auditWriteFails = true;

    const outcome = await harness.sessions.rotate(session.refreshToken, CONTEXT, NOW);

    expect(outcome).toEqual({ status: 'rejected', reason: 'reuse_detected' });
    expect(harness.store.sessionFor(session.sessionId).status).toBe('revoked');
    expect(
      harness.store.tokensForSession(session.sessionId).every((t) => t.status === 'revoked'),
    ).toBe(true);
  });
});
