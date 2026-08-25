/**
 * T-046 — `TemporaryPasswordService`: rate limiting, 72-hour expiry and the
 * `temporary_password_issued` disclosure audit row. The generator itself
 * (`generateTemporaryPassword`'s alphabet/CSPRNG/uniqueness properties, T-046 TC-4/TC-5) is
 * already exhaustively covered by `user-temporary-password.spec.ts` (T-035) — this file proves the
 * three things this task adds *around* that primitive, per its own "Files owned" and DoD.
 *
 * `ThrottleStore` is the real `MemoryThrottleStore` (`common/security/throttle.store.ts`), not a
 * fake: it is pure, in-process and dependency-free, and this is exactly the class T-012 built for
 * a test to exercise the real fixed-window behaviour against, the same way
 * `reveal.service.spec.ts` (T-017) uses it for its own identical per-user rate limit.
 */
import { QueryTypes } from 'sequelize';
import { MemoryThrottleStore, type ThrottleStore } from '@/common/security/throttle.store';
import { PasswordPolicyService } from '@/modules/auth/services/password-policy.service';
import {
  TemporaryPasswordService,
  temporaryPasswordThrottleKey,
} from '@/modules/users/services/temporary-password.service';
import { generateTemporaryPassword } from '@/modules/users/user-temporary-password';
import { TemporaryPasswordRateLimitedError } from '@/modules/users/users.errors';
import {
  TEMPORARY_PASSWORD_ISSUED_AUDIT_EVENT,
  TEMPORARY_PASSWORD_LENGTH,
  TEMPORARY_PASSWORD_RATE_LIMIT_PER_HOUR,
  TEMPORARY_PASSWORD_TTL_MS,
} from '@/modules/users/users.constants';
import {
  FakeAuditService,
  FakeSequelize,
  actor,
  asAuditService,
  asSequelize,
} from './support/users-doubles';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function newService(
  sequelize: FakeSequelize,
  throttle: ThrottleStore,
  audit: FakeAuditService,
): TemporaryPasswordService {
  return new TemporaryPasswordService(asSequelize(sequelize), throttle, asAuditService(audit));
}

describe('TemporaryPasswordService', () => {
  let sequelize: FakeSequelize;
  let throttle: MemoryThrottleStore;
  let audit: FakeAuditService;
  let service: TemporaryPasswordService;

  beforeEach(() => {
    sequelize = new FakeSequelize();
    throttle = new MemoryThrottleStore();
    audit = new FakeAuditService();
    service = newService(sequelize, throttle, audit);
  });

  // --- generate() — the password and its expiry ------------------------------------------------

  describe('generate', () => {
    it('T-046 TC-4: a 24-character, unambiguous-alphabet password', async () => {
      const issued = await service.generate(actor({ userId: 1 }), NOW);
      expect(issued.password).toHaveLength(TEMPORARY_PASSWORD_LENGTH);
      expect(issued.password).not.toMatch(/[O0lI1]/);
    });

    it('T-046 implementation note 5: expiresAt is exactly now + 72 hours', async () => {
      const issued = await service.generate(actor({ userId: 1 }), NOW);
      expect(issued.expiresAt.getTime()).toBe(NOW.getTime() + TEMPORARY_PASSWORD_TTL_MS);
    });

    it('two calls in the same window produce two different passwords', async () => {
      const first = await service.generate(actor({ userId: 1 }), NOW);
      const second = await service.generate(actor({ userId: 1 }), NOW);
      expect(first.password).not.toBe(second.password);
    });

    it('defaults now to the real wall clock when the caller supplies none', async () => {
      const before = Date.now();
      const issued = await service.generate(actor({ userId: 1 }));
      const after = Date.now();

      expect(issued.expiresAt.getTime()).toBeGreaterThanOrEqual(before + TEMPORARY_PASSWORD_TTL_MS);
      expect(issued.expiresAt.getTime()).toBeLessThanOrEqual(after + TEMPORARY_PASSWORD_TTL_MS);
    });
  });

  // --- T-046 TC-5: generated passwords pass the real T-010 policy, not a re-implementation -------

  describe('generated passwords vs. the real PasswordPolicyService (T-010)', () => {
    it('200 freshly generated passwords all pass validate() with zero violations', async () => {
      // `PasswordPolicyService` holds no state and touches no database (its own header) — the
      // real class, not a stand-in, so this proves the two rules actually agree rather than
      // asserting one against a hand-maintained copy of the other's constants.
      const policy = new PasswordPolicyService();

      for (let i = 0; i < 200; i += 1) {
        const password = generateTemporaryPassword();
        const violations = await policy.validate(password);
        expect(violations).toEqual([]);
      }
    });
  });

  // --- rate limiting — implementation note 7, TC-16 ---------------------------------------------

  describe('generate — rate limiting', () => {
    it('T-046 TC-16: the 21st generation in an hour is refused with a 429', async () => {
      const who = actor({ userId: 42 });

      for (let i = 0; i < TEMPORARY_PASSWORD_RATE_LIMIT_PER_HOUR; i += 1) {
        await expect(service.generate(who, NOW)).resolves.toBeDefined();
      }

      const thrown: unknown = await service.generate(who, NOW).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(TemporaryPasswordRateLimitedError);
      expect((thrown as TemporaryPasswordRateLimitedError).status).toBe(429);
    });

    it('the budget resets once the one-hour window has elapsed', async () => {
      const who = actor({ userId: 42 });
      for (let i = 0; i < TEMPORARY_PASSWORD_RATE_LIMIT_PER_HOUR; i += 1) {
        await service.generate(who, NOW);
      }

      const later = new Date(NOW.getTime() + 60 * 60 * 1000 + 1);
      await expect(service.generate(who, later)).resolves.toBeDefined();
    });

    it('two different admins draw from two independent budgets', async () => {
      const first = actor({ userId: 1 });
      const second = actor({ userId: 2 });

      for (let i = 0; i < TEMPORARY_PASSWORD_RATE_LIMIT_PER_HOUR; i += 1) {
        await service.generate(first, NOW);
      }

      await expect(service.generate(second, NOW)).resolves.toBeDefined();
    });

    it('keys the counter by temporaryPasswordThrottleKey(actorId)', async () => {
      const store: ThrottleStore = {
        kind: 'memory',
        consume: jest.fn().mockResolvedValue({ count: 1, resetAt: NOW.getTime() + 1 }),
      };
      const spied = newService(sequelize, store, audit);

      await spied.generate(actor({ userId: 7 }), NOW);

      expect(store.consume).toHaveBeenCalledWith(
        temporaryPasswordThrottleKey(7),
        expect.any(Number),
        NOW.getTime(),
      );
    });

    it('fails closed when the throttle store is unavailable — implementation note 7', async () => {
      const unavailable: ThrottleStore = {
        kind: 'unavailable',
        consume: () => Promise.reject(new Error('store down')),
      };
      const closed = newService(sequelize, unavailable, audit);

      const thrown: unknown = await closed
        .generate(actor({ userId: 1 }), NOW)
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(TemporaryPasswordRateLimitedError);
      expect((thrown as TemporaryPasswordRateLimitedError).status).toBe(429);
    });
  });

  // --- recordIssued() — implementation note 6, TC-6/TC-7/TC-8 ------------------------------------

  describe('recordIssued', () => {
    it('T-046 TC-8: writes temporary_password_issued with actor, target and time — never the value', async () => {
      const who = actor({ userId: 1, role: 'tenant_admin', countryId: 1, tenantId: 10 });
      await service.recordIssued(who, 7);

      expect(audit.portalEvents).toHaveLength(1);
      const event = audit.portalEvents[0];
      expect(event).toMatchObject({
        eventType: TEMPORARY_PASSWORD_ISSUED_AUDIT_EVENT,
        actorId: 1,
        actorRole: 'tenant_admin',
        targetType: 'user',
        targetId: 7,
        countryId: 1,
        tenantId: 10,
      });
    });

    it('T-046 TC-6/TC-7: no field on the recorded event carries a password-shaped value', async () => {
      await service.recordIssued(actor({ userId: 1 }), 7);

      // `recordIssued`'s own signature (`actor`, `targetUserId`) structurally has no parameter a
      // plaintext password could travel through — this pins that down at the call-recorded shape,
      // not just the type. `eventType` legitimately contains the word "password" as part of its
      // *name* (`temporary_password_issued`); what must never appear is a `detail`/`value` payload
      // key for an actual secret to hide inside, which is what the exact-keys assertion checks.
      expect(audit.portalEvents[0]).not.toHaveProperty('detail');
      expect(Object.keys(audit.portalEvents[0]).sort()).toEqual(
        [
          'actorId',
          'actorRole',
          'countryId',
          'eventType',
          'targetId',
          'targetType',
          'tenantId',
        ].sort(),
      );
    });
  });

  // --- setCredentialExpiry() — implementation note 5, the reset half -----------------------------

  describe('setCredentialExpiry', () => {
    it("updates portal_user_credentials.password_expires_at via raw, parameterised SQL (the table's own scope strategy denies ScopedRepository)", async () => {
      const expiresAt = new Date('2026-01-04T00:00:00.000Z');
      await service.setCredentialExpiry(7, expiresAt, {} as never);

      expect(sequelize.queries).toHaveLength(1);
      expect(sequelize.queries[0].sql).toMatch(/portal_user_credentials/);
      expect(sequelize.queries[0].sql).toMatch(/password_expires_at/);
      expect((sequelize.queries[0].options as { type: QueryTypes }).type).toBe(QueryTypes.UPDATE);
      expect(sequelize.queries[0].options).toMatchObject({
        replacements: { userId: 7, expiresAt },
      });
    });
  });
});
