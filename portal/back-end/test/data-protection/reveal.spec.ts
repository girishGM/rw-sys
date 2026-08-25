/**
 * T-017 — the reveal path. TC-15 … TC-18, plus the negative-authorisation cases R6 demands.
 *
 * The four properties under test, in the order they matter:
 *
 *  1. A role not in `reveal_roles` gets **403**, and the denial is audited (TC-16).
 *  2. The 31st reveal in an hour gets **429** (TC-17).
 *  3. The audit row carries actor, field and record — and **not the value** (TC-18).
 *  4. The record read is scoped, so a cross-tenant id is a **404**, not a disclosure.
 */
import { Logger } from '@nestjs/common';
import { PermissionDeniedHttpException } from '@/common/rbac/rbac.exceptions';
import { RateLimitedHttpException } from '@/common/security/security.exceptions';
import { ScopeViolationError } from '@/common/scope/scope.exceptions';
import type { ThrottleCounter, ThrottleStore } from '@/common/security/throttle.store';
import {
  PII_REVEAL_DENIED_EVENT,
  PII_REVEALED_EVENT,
} from '@/common/data-protection/data-protection.constants';
import { PolicyCacheService } from '@/common/data-protection/policy-cache.service';
import { RevealService, REVEAL_WINDOW_MS } from '@/common/data-protection/reveal.service';
import {
  POLICY_KEY_PATTERN,
  RECORD_ID_PATTERN,
  RevealController,
} from '@/common/data-protection/reveal.controller';
import type { PolicyStore } from '@/common/data-protection/policy.repository';
import type { DataProtectionPolicy } from '@/common/data-protection/policy.service';
import type { PortalAuditEventInput } from '@/common/audit/audit.service';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import type { PortalRole } from '@/database/portal-models';
import { buildTestSequelize } from '@/database/models/build-test-sequelize';
import { config, policy } from './support/policies';

const MERCHANT_EMAIL = 'reward_config.merchants.contact_email';

const ROWS: DataProtectionPolicy[] = [
  policy({
    policyKey: MERCHANT_EMAIL,
    classification: 'pii',
    logTreatment: 'mask',
    maskStrategy: 'email',
    uiVisibility: 'reveal_on_demand',
    revealRoles: ['super_admin', 'tenant_admin'],
  }),
  policy({
    policyKey: 'reward_config.merchants.legal_name',
    classification: 'internal',
    uiVisibility: 'plain',
  }),
  policy({
    policyKey: 'reward_config.merchants.disabled_field',
    classification: 'pii',
    uiVisibility: 'reveal_on_demand',
    revealRoles: ['super_admin'],
    enabled: false,
  }),
  policy({
    policyKey: 'dto.CreateUserResponse.temporaryPassword',
    scope: 'dto_field',
    classification: 'secret',
    uiVisibility: 'reveal_on_demand',
    revealRoles: ['super_admin'],
  }),
  policy({
    policyKey: 'reward_config.no_such_table.some_col',
    classification: 'pii',
    uiVisibility: 'reveal_on_demand',
    revealRoles: ['super_admin'],
  }),
  policy({
    policyKey: 'reward_config.merchants.no_such_column',
    classification: 'pii',
    uiVisibility: 'reveal_on_demand',
    revealRoles: ['super_admin'],
  }),
];

class Store implements PolicyStore {
  findAllPolicies(): Promise<DataProtectionPolicy[]> {
    return Promise.resolve([...ROWS]);
  }
}

/** Records what was audited, so TC-18 can assert on the *absence* of the value. */
class FakeAudit {
  readonly events: PortalAuditEventInput[] = [];
  recordPortalEvent(event: PortalAuditEventInput): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

/** A counter that just increments, and can be made to fail. */
class FakeThrottle implements ThrottleStore {
  readonly kind = 'memory' as const;
  counts = new Map<string, number>();
  failure: Error | null = null;

  consume(key: string): Promise<ThrottleCounter> {
    if (this.failure !== null) return Promise.reject(this.failure);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return Promise.resolve({ count, resetAt: NOW + REVEAL_WINDOW_MS });
  }
}

/** A `ScopedRepository` stand-in: returns a row, or 404s exactly as the real one does. */
class FakeScoped {
  row: Record<string, unknown> | null = { id: 7, contactEmail: 'john@example.com' };
  readonly calls: { model: string; id: unknown; options: unknown }[] = [];

  findByPkOrFail(model: { name: string }, id: unknown, options: unknown): Promise<unknown> {
    this.calls.push({ model: model.name, id, options });
    if (this.row === null) return Promise.reject(new ScopeViolationError());
    const values = this.row;
    return Promise.resolve({ getDataValue: (key: string) => values[key] });
  }
}

const NOW = 1_700_000_000_000;

const actor = (role: string): AuthenticatedUser => ({
  userId: 11,
  sessionId: 's',
  role: role as PortalRole,
  countryId: 1,
  tenantId: 2,
  merchantId: null,
  rbacVersion: 1,
  tokenId: 't',
  mustChangePassword: false,
});

interface Harness {
  service: RevealService;
  audit: FakeAudit;
  throttle: FakeThrottle;
  scoped: FakeScoped;
}

async function harness(over: Parameters<typeof config>[0] = {}): Promise<Harness> {
  const cache = new PolicyCacheService(new Store(), config(over));
  await cache.onModuleInit();
  const audit = new FakeAudit();
  const throttle = new FakeThrottle();
  const scoped = new FakeScoped();
  const service = new RevealService(
    cache,
    scoped as never,
    audit as never,
    throttle,
    config(over),
    () => NOW,
  );
  return { service, audit, throttle, scoped };
}

beforeAll(() => {
  // `RevealService` maps a policy's table to a model via `scopedModels()`, and
  // `Model.getTableName()` throws until the class has been registered on a Sequelize instance.
  // T-003's never-connected builder does exactly that registration — the same one production
  // boots through — without opening a socket.
  buildTestSequelize();
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

// TC-15 — an allowed role gets the plaintext, and an audit row is written.
describe('an allowed role (TC-15)', () => {
  it('returns the single plaintext value', async () => {
    const h = await harness();
    await expect(h.service.reveal(actor('tenant_admin'), MERCHANT_EMAIL, '7')).resolves.toEqual({
      policyKey: MERCHANT_EMAIL,
      recordId: '7',
      value: 'john@example.com',
    });
  });

  // TC-18 — the audit row carries who, what field and which record. Never the value.
  it('writes a pii_revealed row with actor, field and record — and not the value (TC-18)', async () => {
    const h = await harness();
    await h.service.reveal(actor('super_admin'), MERCHANT_EMAIL, '7');

    expect(h.audit.events).toHaveLength(1);
    const [event] = h.audit.events;
    expect(event.eventType).toBe(PII_REVEALED_EVENT);
    expect(event.actorId).toBe(11);
    expect(event.actorRole).toBe('super_admin');
    expect(event.targetType).toBe('reward_config.merchants');
    expect(event.targetId).toBe('7');
    expect(event.detail).toEqual({
      policyKey: MERCHANT_EMAIL,
      column: 'contact_email',
      recordId: '7',
    });
    expect(JSON.stringify(h.audit.events)).not.toContain('john@example.com');
  });

  it('reads only the primary key and the one column', async () => {
    const h = await harness();
    await h.service.reveal(actor('super_admin'), MERCHANT_EMAIL, '7');
    expect(h.scoped.calls[0].options).toEqual({ attributes: ['id', 'contactEmail'] });
  });

  it('charges the caller once, keyed by the verified user id', async () => {
    const h = await harness();
    await h.service.reveal(actor('super_admin'), MERCHANT_EMAIL, '7');
    expect([...h.throttle.counts.keys()]).toEqual(['reveal:user:11']);
  });
});

// TC-16 — a role not listed gets 403, and the denial is recorded.
describe('a non-allowed role (TC-16)', () => {
  it.each(['maker', 'checker', 'merchant', 'country_admin'])('403 for %s', async (role) => {
    const h = await harness();
    await expect(h.service.reveal(actor(role), MERCHANT_EMAIL, '7')).rejects.toBeInstanceOf(
      PermissionDeniedHttpException,
    );
    expect(h.audit.events[0].eventType).toBe(PII_REVEAL_DENIED_EVENT);
    expect(h.audit.events[0].detail).toMatchObject({ reason: 'role_not_permitted' });
  });

  it('does not read the record, and does not consume the caller"s quota', async () => {
    const h = await harness();
    await expect(h.service.reveal(actor('maker'), MERCHANT_EMAIL, '7')).rejects.toThrow();
    expect(h.scoped.calls).toHaveLength(0);
    expect(h.throttle.counts.size).toBe(0);
  });

  it('refuses a reveal_on_demand row whose reveal_roles is null', async () => {
    // `ck_dpp_reveal_roles` makes this unstorable, and `validatePolicy` rejects it at load — so
    // this is the belt-and-braces branch, asserted because "unreachable" is a claim that decays.
    const h = await harness();
    const cache = h.service as unknown as { policies: { policyFor: (k: string) => unknown } };
    jest
      .spyOn(cache.policies, 'policyFor')
      .mockReturnValue({ ...ROWS[0], revealRoles: null } as never);
    await expect(
      h.service.reveal(actor('super_admin'), MERCHANT_EMAIL, '7'),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });

  it('answers the same 403 for an unknown policy key, so the table cannot be enumerated', async () => {
    const h = await harness();
    await expect(h.service.reveal(actor('super_admin'), 'a.b.c', '7')).rejects.toBeInstanceOf(
      PermissionDeniedHttpException,
    );
    expect(h.audit.events[0].detail).toMatchObject({ reason: 'no_policy' });
  });

  it('refuses a field that is not reveal_on_demand', async () => {
    const h = await harness();
    await expect(
      h.service.reveal(actor('super_admin'), 'reward_config.merchants.legal_name', '7'),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });

  it('refuses a disabled policy row', async () => {
    const h = await harness();
    await expect(
      h.service.reveal(actor('super_admin'), 'reward_config.merchants.disabled_field', '7'),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });

  it('refuses a dto_field policy — there is no record to read it from', async () => {
    const h = await harness();
    await expect(
      h.service.reveal(actor('super_admin'), 'dto.CreateUserResponse.temporaryPassword', '7'),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });

  it('refuses when reveal, or the whole engine, is switched off', async () => {
    for (const over of [{ reveal: { enabled: false } }, { enabled: false }]) {
      const h = await harness(over);
      await expect(
        h.service.reveal(actor('super_admin'), MERCHANT_EMAIL, '7'),
      ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
      // Nothing is audited: the endpoint is off, so this is not a probe worth recording.
      expect(h.audit.events).toHaveLength(0);
    }
  });

  it('refuses a policy naming a table or column this build does not model', async () => {
    const h = await harness();
    await expect(
      h.service.reveal(actor('super_admin'), 'reward_config.no_such_table.some_col', '7'),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
    await expect(
      h.service.reveal(actor('super_admin'), 'reward_config.merchants.no_such_column', '7'),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });
});

describe('tenancy scope', () => {
  it('answers 404 for a record outside the caller"s scope, not 403 (R6, 02-SECURITY §5.1)', async () => {
    const h = await harness();
    h.scoped.row = null;
    await expect(
      h.service.reveal(actor('tenant_admin'), MERCHANT_EMAIL, '7'),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    // Nothing was disclosed and nothing was recorded as a disclosure.
    expect(h.audit.events).toHaveLength(0);
  });

  it('uses a real clock when none is injected', async () => {
    const cache = new PolicyCacheService(new Store(), config());
    await cache.onModuleInit();
    const throttle = new FakeThrottle();
    const service = new RevealService(
      cache,
      new FakeScoped() as never,
      new FakeAudit() as never,
      throttle,
      config(),
    );
    await expect(service.reveal(actor('super_admin'), MERCHANT_EMAIL, '7')).resolves.toBeDefined();
  });

  it('reads through the scoped repository, never the model directly (R2)', async () => {
    const h = await harness();
    await h.service.reveal(actor('super_admin'), MERCHANT_EMAIL, '7');
    expect(h.scoped.calls[0].model).toBe('Merchant');
    expect(h.scoped.calls[0].id).toBe('7');
  });
});

// TC-17 — the 31st reveal in an hour.
describe('rate limiting (TC-17)', () => {
  it('allows 30 and refuses the 31st with 429', async () => {
    const h = await harness();
    for (let i = 0; i < 30; i += 1) {
      await expect(
        h.service.reveal(actor('super_admin'), MERCHANT_EMAIL, '7'),
      ).resolves.toBeDefined();
    }
    await expect(
      h.service.reveal(actor('super_admin'), MERCHANT_EMAIL, '7'),
    ).rejects.toBeInstanceOf(RateLimitedHttpException);
  });

  it('honours a configured limit other than 30', async () => {
    const h = await harness({ reveal: { rateLimitPerHour: 2 } });
    await h.service.reveal(actor('super_admin'), MERCHANT_EMAIL, '7');
    await h.service.reveal(actor('super_admin'), MERCHANT_EMAIL, '7');
    await expect(
      h.service.reveal(actor('super_admin'), MERCHANT_EMAIL, '7'),
    ).rejects.toBeInstanceOf(RateLimitedHttpException);
  });

  it('carries Retry-After and nothing else — no quota, no counter (TC-15 of T-012)', async () => {
    const h = await harness({ reveal: { rateLimitPerHour: 1 } });
    await h.service.reveal(actor('super_admin'), MERCHANT_EMAIL, '7');
    try {
      await h.service.reveal(actor('super_admin'), MERCHANT_EMAIL, '7');
      throw new Error('should have thrown');
    } catch (error) {
      const thrown = error as RateLimitedHttpException;
      expect(thrown.retryAfterSeconds).toBe(3600);
      expect(JSON.stringify(thrown.getResponse())).toBe('{"error":{"code":"RATE_LIMITED"}}');
    }
  });

  it('FAILS CLOSED when the counter store is unreachable — unlike the general API limit', async () => {
    const h = await harness();
    h.throttle.failure = new Error('redis down');
    await expect(
      h.service.reveal(actor('super_admin'), MERCHANT_EMAIL, '7'),
    ).rejects.toBeInstanceOf(RateLimitedHttpException);
    expect(h.scoped.calls).toHaveLength(0);
  });

  it('does not disclose before charging — the record is read only after the limit passes', async () => {
    const h = await harness({ reveal: { rateLimitPerHour: 1 } });
    await h.service.reveal(actor('super_admin'), MERCHANT_EMAIL, '7');
    await expect(h.service.reveal(actor('super_admin'), MERCHANT_EMAIL, '7')).rejects.toThrow();
    expect(h.scoped.calls).toHaveLength(1);
  });
});

describe('the controller', () => {
  it('rejects a malformed policy key or record id with the same 403', async () => {
    const h = await harness();
    const controller = new RevealController(h.service);
    for (const [key, id] of [
      ['not-a-key', '7'],
      ['a.b', '7'],
      ['a.b.c.d', '7'],
      ['a.b.c', '0'],
      ['a.b.c', '-1'],
      ['a.b.c', "7' OR 1=1"],
      ['a.b.c', 'abc'],
      ["a.b.c'; DROP TABLE x; --", '7'],
    ]) {
      await expect(controller.revealField(actor('super_admin'), key, id)).rejects.toBeInstanceOf(
        PermissionDeniedHttpException,
      );
    }
  });

  it('accepts an integer and a UUID record id', () => {
    expect(RECORD_ID_PATTERN.test('7')).toBe(true);
    expect(RECORD_ID_PATTERN.test('9007199254740991')).toBe(true);
    expect(RECORD_ID_PATTERN.test('e5f6a7b8-1111-2222-3333-444455556666')).toBe(true);
    expect(RECORD_ID_PATTERN.test('e5f6a7b8-1111-2222-3333-44445555666')).toBe(false);
  });

  it('accepts exactly three identifier segments', () => {
    expect(POLICY_KEY_PATTERN.test('reward_config.merchants.contact_email')).toBe(true);
    expect(POLICY_KEY_PATTERN.test('dto.CreateUserResponse.temporaryPassword')).toBe(true);
    expect(POLICY_KEY_PATTERN.test('a.b')).toBe(false);
    expect(POLICY_KEY_PATTERN.test('a.b.c.d')).toBe(false);
    expect(POLICY_KEY_PATTERN.test('1a.b.c')).toBe(false);
    expect(POLICY_KEY_PATTERN.test('a.b.c%')).toBe(false);
  });

  it('wraps the result in the §1 data envelope', async () => {
    const h = await harness();
    const controller = new RevealController(h.service);
    await expect(
      controller.revealField(actor('super_admin'), MERCHANT_EMAIL, '7'),
    ).resolves.toEqual({
      data: { policyKey: MERCHANT_EMAIL, recordId: '7', value: 'john@example.com' },
    });
  });
});
