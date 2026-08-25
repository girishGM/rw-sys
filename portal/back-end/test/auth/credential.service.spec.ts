/**
 * T-010 — `CredentialService`: hashing, the login decision, and the enumeration controls.
 *
 * TC-1…TC-5 and TC-13…TC-20 live here. **TC-4 and TC-18 are the two that matter most** — the
 * task file says so explicitly, and they are the two whose failure mode is invisible in
 * ordinary use: a system with a wide-open enumeration oracle logs people in and out exactly
 * like one without it.
 *
 * Everything runs against `FakeCredentialStore`, which is what makes TC-4 meaningful: with
 * the database out of the picture, the only thing left in the measured interval is Argon2,
 * so the test measures the control rather than the local network stack.
 */
import * as argon2 from 'argon2';
import {
  ARGON2_HASH_PREFIX,
  ARGON2_OPTIONS,
  PASSWORD_HISTORY_SIZE,
  PASSWORD_MAX_LENGTH,
} from '@/modules/auth/auth.constants';
import {
  CredentialNotFoundError,
  InvalidCredentialsError,
  PasswordPolicyError,
} from '@/modules/auth/auth.errors';
import {
  CredentialService,
  resetDummyHashForTesting,
} from '@/modules/auth/services/credential.service';
import { LockoutService } from '@/modules/auth/services/lockout.service';
import { PasswordPolicyService } from '@/modules/auth/services/password-policy.service';
import { FakeCredentialStore } from './support/fake-credential-store';
// T-086 — the load-robust statistic behind TC-4's timing control. See `timing-budget.ts`.
import { describeTrials, measureUntilClean, type TimingSamples } from './timing-budget';

const MINUTE = 60_000;
const NOW = new Date('2026-08-17T10:00:00.000Z');

const EMAIL = 'operator@example.com';
const PASSWORD = 'Quartz-Lantern-42';
const WRONG_PASSWORD = 'Quartz-Lantern-43';

/** Hashing is the expensive part; every suite below shares one hash of `PASSWORD`. */
let passwordHash: string;

function build() {
  const store = new FakeCredentialStore();
  const policy = new PasswordPolicyService();
  const lockout = new LockoutService(store);
  const service = new CredentialService(store, policy, lockout);
  return { store, policy, lockout, service };
}

/** A store holding one active user with a credential, ready to authenticate. */
function buildWithUser(
  userOverrides: Parameters<FakeCredentialStore['seedUser']>[0] = { email: EMAIL },
  credentialOverrides: Parameters<FakeCredentialStore['seedCredential']>[2] = {},
) {
  const context = build();
  const user = context.store.seedUser(userOverrides);
  const credential = context.store.seedCredential(user.id, passwordHash, credentialOverrides);
  return { ...context, user, credential };
}

beforeAll(async () => {
  passwordHash = await argon2.hash(PASSWORD, ARGON2_OPTIONS);
}, 60_000);

describe('CredentialService', () => {
  describe('hashing (TC-1, TC-2, TC-3, TC-5)', () => {
    it('produces a hash with the exact OWASP baseline parameters (TC-1)', async () => {
      const { service } = build();
      const hash = await service.hash('Quartz-Lantern-42');

      expect(hash.startsWith(ARGON2_HASH_PREFIX)).toBe(true);
      expect(hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    });

    it('verifies a correct password (TC-2)', async () => {
      const { service } = build();
      expect(await service.verify(passwordHash, PASSWORD)).toBe(true);
    });

    it('rejects a wrong password (TC-3)', async () => {
      const { service } = build();
      expect(await service.verify(passwordHash, WRONG_PASSWORD)).toBe(false);
    });

    it('produces a different hash each time for the same password (TC-5, unique salt)', async () => {
      const { service } = build();
      const [first, second] = await Promise.all([service.hash(PASSWORD), service.hash(PASSWORD)]);

      expect(first).not.toEqual(second);
      // Both must still verify — different strings, same password.
      expect(await service.verify(first, PASSWORD)).toBe(true);
      expect(await service.verify(second, PASSWORD)).toBe(true);
    });

    it('returns false — never true — when there is no stored hash to compare against', async () => {
      const { service } = build();
      expect(await service.verify(null, PASSWORD)).toBe(false);
      expect(await service.verify(null, '')).toBe(false);
    });

    it('returns false for a digest Argon2 cannot parse, rather than throwing', async () => {
      // A corrupt column must not become a 500 — a distinguishable response is an oracle.
      const { service } = build();
      expect(await service.verify('not-an-argon2-digest', PASSWORD)).toBe(false);
    });

    it('fails an over-long password outright rather than matching on a truncated prefix', async () => {
      const { service } = build();
      const long = 'a'.repeat(PASSWORD_MAX_LENGTH + 1);
      const hashOfPrefix = await argon2.hash(long.slice(0, PASSWORD_MAX_LENGTH), ARGON2_OPTIONS);

      // The truncated form is exactly what gets hashed, so without the explicit failure this
      // would return true and make every password sharing its first 256 chars equivalent.
      expect(await service.verify(hashOfPrefix, long)).toBe(false);
    });
  });

  describe('needsRehash', () => {
    it('is false for a hash at the current baseline', async () => {
      const { service } = build();
      expect(service.needsRehash(passwordHash)).toBe(false);
    });

    it('is true for a hash produced with a weaker work factor', async () => {
      const { service } = build();
      const weak = await argon2.hash(PASSWORD, { ...ARGON2_OPTIONS, memoryCost: 8192 });
      expect(service.needsRehash(weak)).toBe(true);
    });

    it('is true for a digest it cannot parse', () => {
      const { service } = build();
      expect(service.needsRehash('not-an-argon2-digest')).toBe(true);
    });
  });

  describe('authenticate — success', () => {
    it('returns the user facts the session will be minted from', async () => {
      const { service, user } = buildWithUser({
        email: EMAIL,
        role: 'tenant_admin',
        tenantId: 7,
        countryId: 3,
      });

      const result = await service.authenticate({ email: EMAIL, password: PASSWORD, now: NOW });

      expect(result.user.id).toBe(user.id);
      expect(result.user.role).toBe('tenant_admin');
      expect(result.user.tenantId).toBe(7);
      expect(result.user.countryId).toBe(3);
      expect(result.mustChangePassword).toBe(false);
      expect(result.rehashRequired).toBe(false);
    });

    it('matches the email case-insensitively and ignores surrounding whitespace', async () => {
      const { service } = buildWithUser({ email: EMAIL });

      await expect(
        service.authenticate({ email: `  ${EMAIL.toUpperCase()}  `, password: PASSWORD, now: NOW }),
      ).resolves.toMatchObject({ mustChangePassword: false });
    });

    it('reports mustChangePassword when the account is flagged for it', async () => {
      const { service } = buildWithUser({ email: EMAIL, mustChangePassword: true });

      const result = await service.authenticate({ email: EMAIL, password: PASSWORD, now: NOW });
      expect(result.mustChangePassword).toBe(true);
    });

    it('reports mustChangePassword when the password has expired', async () => {
      const { service } = buildWithUser(
        { email: EMAIL },
        { passwordExpiresAt: new Date(NOW.getTime() - MINUTE) },
      );

      const result = await service.authenticate({ email: EMAIL, password: PASSWORD, now: NOW });
      expect(result.mustChangePassword).toBe(true);
    });

    it('does not report mustChangePassword for an expiry still in the future', async () => {
      const { service } = buildWithUser(
        { email: EMAIL },
        { passwordExpiresAt: new Date(NOW.getTime() + MINUTE) },
      );

      const result = await service.authenticate({ email: EMAIL, password: PASSWORD, now: NOW });
      expect(result.mustChangePassword).toBe(false);
    });

    it('flags a weakly-hashed password for opportunistic rehashing', async () => {
      const weak = await argon2.hash(PASSWORD, { ...ARGON2_OPTIONS, memoryCost: 8192 });
      const context = build();
      const user = context.store.seedUser({ email: EMAIL });
      context.store.seedCredential(user.id, weak);

      const result = await context.service.authenticate({
        email: EMAIL,
        password: PASSWORD,
        now: NOW,
      });
      expect(result.rehashRequired).toBe(true);
    });

    it('defaults the clock to the real one when no `now` is supplied', async () => {
      const { service } = buildWithUser();
      await expect(
        service.authenticate({ email: EMAIL, password: PASSWORD }),
      ).resolves.toMatchObject({ mustChangePassword: false });
    });
  });

  describe('authenticate — lockout (TC-13…TC-17)', () => {
    it('succeeds after 4 failures and resets the counter to 0 (TC-13)', async () => {
      const { service, store, user } = buildWithUser();

      for (let i = 0; i < 4; i += 1) {
        await expect(
          service.authenticate({ email: EMAIL, password: WRONG_PASSWORD, now: NOW }),
        ).rejects.toBeInstanceOf(InvalidCredentialsError);
      }
      expect(store.credentialFor(user.id).failedAttempts).toBe(4);
      expect(store.credentialFor(user.id).lockedUntil).toBeNull();

      await expect(
        service.authenticate({ email: EMAIL, password: PASSWORD, now: NOW }),
      ).resolves.toBeDefined();

      expect(store.credentialFor(user.id).failedAttempts).toBe(0);
    });

    it('locks for 15 minutes on the 5th failure (TC-14)', async () => {
      const { service, store, user } = buildWithUser();

      for (let i = 0; i < 5; i += 1) {
        await expect(
          service.authenticate({ email: EMAIL, password: WRONG_PASSWORD, now: NOW }),
        ).rejects.toBeInstanceOf(InvalidCredentialsError);
      }

      expect(store.credentialFor(user.id).failedAttempts).toBe(5);
      expect(store.credentialFor(user.id).lockedUntil).toEqual(
        new Date(NOW.getTime() + 15 * MINUTE),
      );
    });

    it('still fails a CORRECT password while locked (TC-15)', async () => {
      const { service, store, user } = buildWithUser(
        { email: EMAIL },
        { failedAttempts: 5, lockedUntil: new Date(NOW.getTime() + 10 * MINUTE) },
      );

      await expect(
        service.authenticate({ email: EMAIL, password: PASSWORD, now: NOW }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);

      // The lock is not shortened, extended, or cleared by a correct guess, and the correct
      // guess is not confirmed to the caller in any way.
      expect(store.credentialFor(user.id).lockedUntil).toEqual(
        new Date(NOW.getTime() + 10 * MINUTE),
      );
      expect(store.attempts.at(-1)?.failureCode).toBe('locked');
    });

    it('succeeds once locked_until has passed, resetting the counter (TC-16)', async () => {
      const { service, store, user } = buildWithUser(
        { email: EMAIL },
        { failedAttempts: 5, lockedUntil: new Date(NOW.getTime() - MINUTE) },
      );

      await expect(
        service.authenticate({ email: EMAIL, password: PASSWORD, now: NOW }),
      ).resolves.toBeDefined();

      expect(store.credentialFor(user.id).failedAttempts).toBe(0);
      expect(store.credentialFor(user.id).lockedUntil).toBeNull();
    });

    it('applies the 30-minute back-off on the second lockout cycle (TC-17)', async () => {
      // Start from an expired first lockout at 5 failures, then fail 5 more times.
      const { service, store, user } = buildWithUser(
        { email: EMAIL },
        { failedAttempts: 5, lockedUntil: new Date(NOW.getTime() - MINUTE) },
      );

      for (let i = 0; i < 5; i += 1) {
        await expect(
          service.authenticate({ email: EMAIL, password: WRONG_PASSWORD, now: NOW }),
        ).rejects.toBeInstanceOf(InvalidCredentialsError);
      }

      expect(store.credentialFor(user.id).failedAttempts).toBe(10);
      expect(store.credentialFor(user.id).lockedUntil).toEqual(
        new Date(NOW.getTime() + 30 * MINUTE),
      );
    });
  });

  describe('authenticate — the failure trail (TC-19)', () => {
    it.each([
      [
        'unknown_user',
        { seedUser: false, seedCredential: false, status: 'active', password: PASSWORD },
      ],
      [
        'no_credential',
        { seedUser: true, seedCredential: false, status: 'active', password: PASSWORD },
      ],
      [
        'bad_password',
        { seedUser: true, seedCredential: true, status: 'active', password: WRONG_PASSWORD },
      ],
      [
        'inactive',
        { seedUser: true, seedCredential: true, status: 'suspended', password: PASSWORD },
      ],
    ])('writes failure_code=%s to portal_login_attempts', async (expectedCode, scenario) => {
      const context = build();
      if (scenario.seedUser) {
        const user = context.store.seedUser({ email: EMAIL, status: scenario.status });
        if (scenario.seedCredential) context.store.seedCredential(user.id, passwordHash);
      }

      await expect(
        context.service.authenticate({ email: EMAIL, password: scenario.password, now: NOW }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);

      expect(context.store.attempts).toHaveLength(1);
      expect(context.store.attempts[0]).toMatchObject({
        email: EMAIL,
        success: false,
        failureCode: expectedCode,
      });
    });

    it('records the submitted email and client metadata for an unknown address', async () => {
      const { service, store } = build();

      await expect(
        service.authenticate({
          email: 'nobody@example.com',
          password: PASSWORD,
          ipAddress: '203.0.113.7',
          userAgent: 'Mozilla/5.0',
          now: NOW,
        }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);

      expect(store.attempts[0]).toMatchObject({
        email: 'nobody@example.com',
        userId: null,
        ipAddress: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
      });
    });

    it('defaults absent client metadata to null rather than undefined', async () => {
      const { service, store } = build();

      await expect(
        service.authenticate({ email: 'nobody@example.com', password: PASSWORD, now: NOW }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);

      expect(store.attempts[0].ipAddress).toBeNull();
      expect(store.attempts[0].userAgent).toBeNull();
    });

    it('writes a success row on a successful login', async () => {
      const { service, store, user } = buildWithUser();

      await service.authenticate({ email: EMAIL, password: PASSWORD, now: NOW });

      expect(store.attempts).toEqual([
        expect.objectContaining({ userId: user.id, success: true, failureCode: null }),
      ]);
    });

    it('threads a caller transaction into the attempt write', async () => {
      const { service, store } = buildWithUser();

      await store.runInTransaction(async (tx) => {
        await service.authenticate({ email: EMAIL, password: PASSWORD, now: NOW }, tx);
      });

      expect(store.attempts[0].transactional).toBe(true);
    });
  });

  describe('authenticate — no enumeration oracle (TC-18, TC-20)', () => {
    /** Produces the thrown error for each of the four causes TC-18 names. */
    async function errorsForEveryCause(): Promise<Error[]> {
      const errors: Error[] = [];

      const scenarios = [
        // Unknown user.
        async () => {
          const { service } = build();
          return service.authenticate({
            email: 'nobody@example.com',
            password: PASSWORD,
            now: NOW,
          });
        },
        // Wrong password.
        async () => {
          const { service } = buildWithUser();
          return service.authenticate({ email: EMAIL, password: WRONG_PASSWORD, now: NOW });
        },
        // Locked.
        async () => {
          const { service } = buildWithUser(
            { email: EMAIL },
            { failedAttempts: 5, lockedUntil: new Date(NOW.getTime() + MINUTE) },
          );
          return service.authenticate({ email: EMAIL, password: PASSWORD, now: NOW });
        },
        // Inactive.
        async () => {
          const { service } = buildWithUser({ email: EMAIL, status: 'suspended' });
          return service.authenticate({ email: EMAIL, password: PASSWORD, now: NOW });
        },
      ];

      for (const scenario of scenarios) {
        try {
          await scenario();
          throw new Error('expected authenticate() to reject');
        } catch (error) {
          errors.push(error as Error);
        }
      }

      return errors;
    }

    it('throws the identical error type and message for all four causes (TC-18)', async () => {
      const errors = await errorsForEveryCause();
      expect(errors).toHaveLength(4);

      for (const error of errors) {
        expect(error).toBeInstanceOf(InvalidCredentialsError);
        // Not a subclass — `instanceof` must not be able to separate the causes.
        expect(error.constructor).toBe(InvalidCredentialsError);
        expect(error.name).toBe('InvalidCredentialsError');
        expect(error.message).toBe('Invalid credentials');
      }

      // Every error carries exactly the same own properties as every other, so there is no
      // field a caller could branch on — including one a future change might add.
      const shapes = errors.map((error) => JSON.stringify(Object.keys(error).sort()));
      expect(new Set(shapes).size).toBe(1);
    });

    it('leaks nothing through JSON serialisation (TC-20)', async () => {
      const errors = await errorsForEveryCause();

      for (const error of errors) {
        const serialised = JSON.stringify(error);
        expect(serialised).not.toContain(passwordHash);
        expect(serialised).not.toContain('$argon2');
        expect(serialised).not.toContain(EMAIL);
        expect(serialised).not.toContain('example.com');
        for (const code of [
          'unknown_user',
          'no_credential',
          'inactive',
          'locked',
          'bad_password',
        ]) {
          expect(serialised).not.toContain(code);
        }
      }
    });

    it('leaks nothing through the error message or stack either (TC-20)', async () => {
      const errors = await errorsForEveryCause();

      for (const error of errors) {
        expect(`${error.message}`).toBe('Invalid credentials');
        expect(error.stack ?? '').not.toContain(passwordHash);
        expect(error.stack ?? '').not.toContain(EMAIL);
      }
    });

    /**
     * TC-4 — the timing control.
     *
     * The two paths must cost the same: an unknown address runs Argon2 against the
     * module-level dummy hash, a known address runs it against the stored hash, and both use
     * identical parameters. Measurements are **interleaved** rather than run as two
     * consecutive blocks, so CPU frequency drift, GC pauses and other agents' load during a
     * long run affect both samples equally instead of biasing whichever ran second — that is
     * what makes this test reproducible rather than merely passing once (Verification step 3
     * requires three consecutive clean runs).
     */
    it('shows no measurable timing difference between an unknown email and a wrong password (TC-4)', async () => {
      const { service, store } = build();
      const user = store.seedUser({ email: EMAIL });
      store.seedCredential(user.id, passwordHash);

      // Warm the dummy hash and the Argon2 native binding before measuring; the one-off cost
      // of computing the dummy would otherwise land entirely in the first unknown-email
      // sample and be the very signal this test exists to rule out.
      await service.onModuleInit();
      for (let i = 0; i < 5; i += 1) {
        await expect(
          service.authenticate({ email: EMAIL, password: WRONG_PASSWORD, now: NOW }),
        ).rejects.toBeInstanceOf(InvalidCredentialsError);
        await expect(
          service.authenticate({ email: 'warmup@example.com', password: WRONG_PASSWORD, now: NOW }),
        ).rejects.toBeInstanceOf(InvalidCredentialsError);
      }

      // T-086 — this used to compare the two arms' **means** against a fixed 10% bar. A mean is
      // the least robust estimator available for this: one GC pause or one core stolen by another
      // jest worker moves it by more than the effect being measured, and a single 100x outlier
      // moves it by 100x (asserted directly in `timing-budget.spec.ts`). Observed consequence:
      // this assertion failed a full-suite run at ratio 0.10420608530712973 — a 4% overshoot of
      // the bar, on unchanged code that passes every time this file is run alone.
      //
      // It now uses the same statistic as `auth.http.spec.ts`'s TC-21, for the same reasons; see
      // the long comment at the top of `timing-budget.ts`. The interleaving that was already
      // here is kept and extended to three groups, so that same-path jitter is measured rather
      // than assumed, and the whole measurement is retried before a leak is declared.
      const collect = async (): Promise<TimingSamples> => {
        const iterations = 70;
        const knownA: number[] = [];
        const knownB: number[] = [];
        const unknown: number[] = [];

        const time = async (email: string): Promise<number> => {
          const started = process.hrtime.bigint();
          await service
            .authenticate({ email, password: WRONG_PASSWORD, now: NOW })
            .catch(() => undefined);
          return Number(process.hrtime.bigint() - started);
        };

        for (let i = 0; i < iterations; i += 1) {
          knownA.push(await time(EMAIL));
          unknown.push(await time(`nobody-${i}@example.com`));
          knownB.push(await time(EMAIL));
        }
        return { knownA, knownB, unknown };
      };

      const outcome = await measureUntilClean(collect);

      // A leak is reported only when every independent trial agrees. The trial summary rides
      // along in the failure output so a regression shows how far off it was, not just "false".
      expect({ leaked: outcome.leaked, trials: describeTrials(outcome.trials) }).toEqual({
        leaked: false,
        trials: expect.any(String),
      });
    }, 300_000);
  });

  describe('changePassword', () => {
    const NEW_PASSWORD = 'Mulberry-Ridge-88';

    it('replaces the hash and pushes the old one onto the history', async () => {
      const { service, store, user } = buildWithUser();

      await service.changePassword({ userId: user.id, newPassword: NEW_PASSWORD, email: EMAIL });

      const stored = store.credentialFor(user.id);
      expect(stored.passwordHash).not.toEqual(passwordHash);
      expect(stored.passwordAlgo).toBe('argon2id');
      expect(stored.previousHashes).toEqual([passwordHash]);
      expect(await service.verify(stored.passwordHash, NEW_PASSWORD)).toBe(true);
    });

    it('trims the history to exactly 5 entries (Implementation notes §4)', async () => {
      const existing = ['h1', 'h2', 'h3', 'h4', 'h5'];
      const { service, store, user } = buildWithUser(
        { email: EMAIL },
        { previousHashes: existing },
      );

      await service.changePassword({ userId: user.id, newPassword: NEW_PASSWORD, email: EMAIL });

      const stored = store.credentialFor(user.id);
      expect(stored.previousHashes).toHaveLength(PASSWORD_HISTORY_SIZE);
      // Newest first; the oldest entry ('h5') falls off the end.
      expect(stored.previousHashes).toEqual([passwordHash, 'h1', 'h2', 'h3', 'h4']);
    });

    it('verifies the current password when one is supplied', async () => {
      const { service, user } = buildWithUser();

      await expect(
        service.changePassword({
          userId: user.id,
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
          email: EMAIL,
        }),
      ).resolves.toBeUndefined();
    });

    it('rejects a wrong current password with the undifferentiated error', async () => {
      const { service, store, user } = buildWithUser();

      await expect(
        service.changePassword({
          userId: user.id,
          currentPassword: WRONG_PASSWORD,
          newPassword: NEW_PASSWORD,
          email: EMAIL,
        }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);

      expect(store.passwordWrites).toEqual([]);
    });

    it('rejects a new password that breaks the policy, reporting why', async () => {
      const { service, store, user } = buildWithUser();

      await expect(
        service.changePassword({ userId: user.id, newPassword: 'Password123!', email: EMAIL }),
      ).rejects.toThrow(PasswordPolicyError);

      expect(store.passwordWrites).toEqual([]);
    });

    it('rejects reuse of the password currently in force (TC-11 via the service)', async () => {
      const { service, user } = buildWithUser();

      await expect(
        service.changePassword({ userId: user.id, newPassword: PASSWORD, email: EMAIL }),
      ).rejects.toThrow(PasswordPolicyError);
    });

    it('carries the violated rules on the error, for the change-password form', async () => {
      const { service, user } = buildWithUser();

      await expect(
        service.changePassword({ userId: user.id, newPassword: 'short', email: EMAIL }),
      ).rejects.toMatchObject({
        violations: expect.arrayContaining(['too_short', 'insufficient_character_classes']),
      });
    });

    it('applies the email rule using the address it was given', async () => {
      const { service, user } = buildWithUser();

      await expect(
        service.changePassword({
          userId: user.id,
          newPassword: `${EMAIL}-Aa1!`,
          email: EMAIL,
        }),
      ).rejects.toMatchObject({ violations: expect.arrayContaining(['contains_email']) });
    });

    it('works without an email in context (admin-driven reset)', async () => {
      const { service, store, user } = buildWithUser();

      await service.changePassword({ userId: user.id, newPassword: NEW_PASSWORD });

      expect(store.passwordWrites).toHaveLength(1);
    });

    it('throws CredentialNotFoundError for a user with no credential row', async () => {
      const { service } = build();

      await expect(
        service.changePassword({ userId: 999, newPassword: NEW_PASSWORD }),
      ).rejects.toBeInstanceOf(CredentialNotFoundError);
    });

    it('does not clear an existing lockout as a side effect', async () => {
      // Unlocking is an explicit decision made at the call site — see LockoutService.clear().
      const lockedUntil = new Date(NOW.getTime() + 10 * MINUTE);
      const { service, store, user } = buildWithUser(
        { email: EMAIL },
        { failedAttempts: 5, lockedUntil },
      );

      await service.changePassword({ userId: user.id, newPassword: NEW_PASSWORD, email: EMAIL });

      expect(store.credentialFor(user.id).failedAttempts).toBe(5);
      expect(store.credentialFor(user.id).lockedUntil).toEqual(lockedUntil);
    });

    it('threads a caller transaction into the password write', async () => {
      const { service, store, user } = buildWithUser();

      await store.runInTransaction(async (tx) => {
        await service.changePassword(
          { userId: user.id, newPassword: NEW_PASSWORD, email: EMAIL },
          tx,
        );
      });

      expect(store.passwordWrites).toHaveLength(1);
    });

    it('handles a credential row whose history column is null', async () => {
      const { service, store, user } = buildWithUser({ email: EMAIL }, { previousHashes: null });

      await service.changePassword({ userId: user.id, newPassword: NEW_PASSWORD, email: EMAIL });

      expect(store.credentialFor(user.id).previousHashes).toEqual([passwordHash]);
    });
  });

  describe('dummy hash lifecycle', () => {
    afterEach(() => {
      resetDummyHashForTesting();
    });

    it('computes the dummy hash once and reuses it', async () => {
      // Asserted by cost rather than by spying: `argon2`'s CommonJS exports are
      // non-configurable, so `jest.spyOn` cannot wrap them. Cost is the property that
      // actually matters anyway — the whole point of memoising is that the warm path is
      // free, and a full Argon2 hash at `memoryCost: 19456` is ~4 orders of magnitude
      // slower than returning a settled promise, so this comparison is not a close call.
      resetDummyHashForTesting();
      const { service } = build();

      const coldStart = process.hrtime.bigint();
      await service.onModuleInit();
      const cold = Number(process.hrtime.bigint() - coldStart);

      const warmStart = process.hrtime.bigint();
      await service.onModuleInit();
      const warm = Number(process.hrtime.bigint() - warmStart);

      expect(cold).toBeGreaterThan(1_000_000); // a real hash: >1 ms
      expect(warm * 10).toBeLessThan(cold); // the memoised promise: no rehash
    }, 30_000);

    it('still authenticates correctly when the dummy hash is computed lazily', async () => {
      resetDummyHashForTesting();
      const { service } = build();

      // No onModuleInit() — the unknown-user path must compute it on demand.
      await expect(
        service.authenticate({ email: 'nobody@example.com', password: PASSWORD, now: NOW }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    }, 30_000);
  });
});
