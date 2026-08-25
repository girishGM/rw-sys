/**
 * T-010 — `LockoutService`: counter arithmetic, back-off tiers and the attempt trail.
 *
 * These are the cases that decide whether lockout is a real control or a speed bump, so they
 * are driven through the service's public surface with an in-memory store rather than by
 * asserting on internals. TC-13, TC-14, TC-16, TC-17 and TC-19 live here; TC-15 (a correct
 * password must not bypass a lock) lives in `credential.service.spec.ts`, because it is a
 * property of the login decision rather than of the counter.
 */
import { LOCKOUT_BACKOFF_MINUTES, LOCKOUT_THRESHOLD } from '@/modules/auth/auth.constants';
import {
  LockoutService,
  type AttemptRegistration,
  type LockableCredential,
} from '@/modules/auth/services/lockout.service';
import { FakeCredentialStore } from './support/fake-credential-store';

const MINUTE = 60_000;
const NOW = new Date('2026-08-17T10:00:00.000Z');

describe('LockoutService', () => {
  let store: FakeCredentialStore;
  let lockout: LockoutService;

  beforeEach(() => {
    store = new FakeCredentialStore();
    lockout = new LockoutService(store);
  });

  function registration(
    credential: LockableCredential | null,
    overrides: Partial<AttemptRegistration> = {},
  ): AttemptRegistration {
    return {
      email: 'user@example.com',
      userId: credential === null ? null : 1,
      credential,
      ipAddress: '203.0.113.7',
      userAgent: 'jest',
      now: NOW,
      ...overrides,
    };
  }

  function credential(overrides: Partial<LockableCredential> = {}): LockableCredential {
    return { id: 1, failedAttempts: 0, lockedUntil: null, ...overrides };
  }

  describe('isLocked', () => {
    it('is false when there is no credential row at all', () => {
      expect(lockout.isLocked(null, NOW)).toBe(false);
    });

    it('is false when locked_until was never set', () => {
      expect(lockout.isLocked({ lockedUntil: null }, NOW)).toBe(false);
    });

    it('is true while locked_until is in the future', () => {
      expect(lockout.isLocked({ lockedUntil: new Date(NOW.getTime() + MINUTE) }, NOW)).toBe(true);
    });

    it('is false once locked_until has passed (TC-16, no sweep job needed)', () => {
      expect(lockout.isLocked({ lockedUntil: new Date(NOW.getTime() - 1) }, NOW)).toBe(false);
    });

    it('is false at the exact instant locked_until is reached', () => {
      // Strictly-greater-than: the lock ends *at* the timestamp, it does not include it.
      expect(lockout.isLocked({ lockedUntil: new Date(NOW.getTime()) }, NOW)).toBe(false);
    });
  });

  describe('back-off tiers (Implementation notes §5)', () => {
    it.each([
      [5, 15],
      [10, 30],
      [15, 60],
      [20, 120],
      [25, 120],
      [100, 120],
    ])(
      'locks for the documented duration at %i consecutive failures (%i minutes)',
      (attempts, minutes) => {
        expect(lockout.backoffMinutesFor(attempts)).toBe(minutes);
      },
    );

    it('matches the documented tier table exactly', () => {
      expect(LOCKOUT_BACKOFF_MINUTES).toEqual([15, 30, 60, 120]);
    });

    it('clamps below the first tier rather than indexing out of range', () => {
      // Not reachable through lockUntilFor (which refuses non-multiples), but the method is
      // public and must not return undefined for a caller that asks directly.
      expect(lockout.backoffMinutesFor(0)).toBe(15);
      expect(lockout.backoffMinutesFor(3)).toBe(15);
    });
  });

  describe('lockUntilFor', () => {
    it('returns null below the threshold', () => {
      for (let attempts = 1; attempts < LOCKOUT_THRESHOLD; attempts += 1) {
        expect(lockout.lockUntilFor(attempts, NOW)).toBeNull();
      }
    });

    it('returns null for a zero or negative count', () => {
      expect(lockout.lockUntilFor(0, NOW)).toBeNull();
      expect(lockout.lockUntilFor(-1, NOW)).toBeNull();
    });

    it('locks at each exact multiple of the threshold and not between them (TC-17)', () => {
      // The "not between them" half is what makes the back-off reachable: if every failure
      // past 5 re-locked, the counter could never climb to the 30-minute tier.
      expect(lockout.lockUntilFor(5, NOW)).toEqual(new Date(NOW.getTime() + 15 * MINUTE));
      expect(lockout.lockUntilFor(6, NOW)).toBeNull();
      expect(lockout.lockUntilFor(9, NOW)).toBeNull();
      expect(lockout.lockUntilFor(10, NOW)).toEqual(new Date(NOW.getTime() + 30 * MINUTE));
    });
  });

  describe('registerFailure', () => {
    it('writes an attempt row with the failure code even when no account matched (TC-19)', async () => {
      await lockout.registerFailure(
        registration(null, { email: 'nobody@example.com', userId: null }),
        'unknown_user',
      );

      expect(store.attempts).toEqual([
        {
          email: 'nobody@example.com',
          userId: null,
          success: false,
          failureCode: 'unknown_user',
          ipAddress: '203.0.113.7',
          userAgent: 'jest',
          transactional: false,
        },
      ]);
      // Nothing to count against — and no crash trying.
      expect(store.lockWrites).toEqual([]);
    });

    it('increments the counter without locking below the threshold (TC-13)', async () => {
      await lockout.registerFailure(
        registration(credential({ failedAttempts: 3 })),
        'bad_password',
      );

      expect(store.lockWrites).toEqual([{ credentialId: 1, failedAttempts: 4, lockedUntil: null }]);
    });

    it('locks for 15 minutes on the 5th consecutive failure (TC-14)', async () => {
      await lockout.registerFailure(
        registration(credential({ failedAttempts: 4 })),
        'bad_password',
      );

      expect(store.lockWrites).toEqual([
        { credentialId: 1, failedAttempts: 5, lockedUntil: new Date(NOW.getTime() + 15 * MINUTE) },
      ]);
    });

    it('locks for 30 minutes on the 10th, applying the back-off (TC-17)', async () => {
      await lockout.registerFailure(
        registration(credential({ failedAttempts: 9 })),
        'bad_password',
      );

      expect(store.lockWrites).toEqual([
        { credentialId: 1, failedAttempts: 10, lockedUntil: new Date(NOW.getTime() + 30 * MINUTE) },
      ]);
    });

    it('preserves an existing lock timestamp when this failure does not trigger a new one', async () => {
      const existing = new Date(NOW.getTime() - 5 * MINUTE);
      await lockout.registerFailure(
        registration(credential({ failedAttempts: 6, lockedUntil: existing })),
        'bad_password',
      );

      expect(store.lockWrites).toEqual([
        { credentialId: 1, failedAttempts: 7, lockedUntil: existing },
      ]);
    });

    it('records an attempt made while locked but does not advance the counter', async () => {
      // Otherwise an attacker holds a known account locked indefinitely, escalating it up the
      // back-off tiers, purely by failing once every few minutes.
      const lockedUntil = new Date(NOW.getTime() + 10 * MINUTE);
      await lockout.registerFailure(
        registration(credential({ failedAttempts: 5, lockedUntil })),
        'locked',
      );

      expect(store.attempts).toHaveLength(1);
      expect(store.attempts[0].failureCode).toBe('locked');
      expect(store.lockWrites).toEqual([]);
    });

    it('passes the caller transaction through to both writes', async () => {
      await store.runInTransaction(async (tx) => {
        await lockout.registerFailure(
          registration(credential({ failedAttempts: 0 })),
          'bad_password',
          tx,
        );
      });

      expect(store.attempts[0].transactional).toBe(true);
    });
  });

  describe('registerSuccess', () => {
    it('writes a success row and resets both fields (TC-13)', async () => {
      const seeded = store.seedCredential(1, 'hash', { failedAttempts: 4 });

      await lockout.registerSuccess(
        registration({ id: seeded.id, failedAttempts: 4, lockedUntil: null }),
      );

      expect(store.attempts).toEqual([
        {
          email: 'user@example.com',
          userId: 1,
          success: true,
          failureCode: null,
          ipAddress: '203.0.113.7',
          userAgent: 'jest',
          transactional: false,
        },
      ]);
      expect(store.credentialFor(1).failedAttempts).toBe(0);
      expect(store.credentialFor(1).lockedUntil).toBeNull();
    });

    it('clears a stale lock timestamp as well as the counter (TC-16)', async () => {
      const seeded = store.seedCredential(1, 'hash', {
        failedAttempts: 5,
        lockedUntil: new Date(NOW.getTime() - MINUTE),
      });

      await lockout.registerSuccess(
        registration({ id: seeded.id, failedAttempts: 5, lockedUntil: seeded.lockedUntil }),
      );

      expect(store.credentialFor(1).lockedUntil).toBeNull();
    });

    it('records the attempt but writes no lock state when there is no credential row', async () => {
      await lockout.registerSuccess(registration(null));

      expect(store.attempts).toHaveLength(1);
      expect(store.lockWrites).toEqual([]);
    });

    it('joins the caller transaction, per Implementation notes §5', async () => {
      const seeded = store.seedCredential(1, 'hash', { failedAttempts: 2 });

      await store.runInTransaction(async (tx) => {
        await lockout.registerSuccess(
          registration({ id: seeded.id, failedAttempts: 2, lockedUntil: null }),
          tx,
        );
      });

      expect(store.attempts[0].transactional).toBe(true);
    });
  });

  describe('clear', () => {
    it('drops the lock and the counter outright', async () => {
      store.seedCredential(1, 'hash', {
        failedAttempts: 5,
        lockedUntil: new Date(NOW.getTime() + MINUTE),
      });

      await lockout.clear(1);

      expect(store.credentialFor(1).failedAttempts).toBe(0);
      expect(store.credentialFor(1).lockedUntil).toBeNull();
    });
  });
});
