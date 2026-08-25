/**
 * T-017 — the policy cache (implementation note 8), and TC-20/TC-21.
 *
 * The two behaviours that matter, and are easy to get backwards:
 *
 *  - **No snapshot ⇒ fail closed.** Before the first load, and after a load that threw with no
 *    prior snapshot, every lookup answers `FAIL_CLOSED_POLICY` through the `*Safe` accessors and
 *    *throws* through the plain ones. Never `null`, never plain (TC-21).
 *  - **A snapshot that exists is kept.** A later load failure, or a TTL expiry, does not discard
 *    it — dropping it would mask every field over a transient error, which is fail-closed in the
 *    letter and self-harm in the spirit.
 */
import { Logger } from '@nestjs/common';
import {
  PolicyCacheService,
  PolicyCacheUnavailableError,
} from '@/common/data-protection/policy-cache.service';
import {
  FAIL_CLOSED_POLICY,
  type DataProtectionPolicy,
} from '@/common/data-protection/policy.service';
import type { PolicyStore } from '@/common/data-protection/policy.repository';
import { config, FIXTURE_POLICIES, policy } from './support/policies';

/** A store whose answer — rows or a rejection — the test controls per call. */
class FakeStore implements PolicyStore {
  calls = 0;
  rows: DataProtectionPolicy[] = [...FIXTURE_POLICIES];
  failure: Error | null = null;
  /** Resolved externally, to test the in-flight collapse. */
  gate: (() => void) | null = null;

  async findAllPolicies(): Promise<DataProtectionPolicy[]> {
    this.calls += 1;
    if (this.gate !== null) {
      await new Promise<void>((resolve) => {
        this.gate = resolve;
      });
    }
    if (this.failure !== null) throw this.failure;
    return [...this.rows];
  }
}

function build(
  store: FakeStore,
  now: () => number = Date.now,
  ttlSeconds = 300,
): PolicyCacheService {
  return new PolicyCacheService(store, config({ cache: { ttlSeconds } }), now);
}

beforeAll(() => {
  // The cache logs at `error` on a load failure by design; silence it so a deliberate failure
  // does not look like a broken test run.
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe('before the first load', () => {
  it('throws from every plain accessor', () => {
    const cache = build(new FakeStore());
    expect(cache.isLoaded).toBe(false);
    expect(cache.policyCount).toBe(-1);
    expect(() => cache.current()).toThrow(PolicyCacheUnavailableError);
    expect(() => cache.resolveColumn('a.b', 'c')).toThrow(PolicyCacheUnavailableError);
    expect(() => cache.resolveDtoField('X', 'y')).toThrow(PolicyCacheUnavailableError);
    expect(() => cache.resolveFieldName('email')).toThrow(PolicyCacheUnavailableError);
    expect(() => cache.policyFor('a.b.c')).toThrow(PolicyCacheUnavailableError);
    expect(() => cache.columnPoliciesFor('a.b')).toThrow(PolicyCacheUnavailableError);
    expect(() => cache.protectedTables()).toThrow(PolicyCacheUnavailableError);
  });

  // TC-21 — the safe accessors deny rather than opening up.
  it('answers FAIL_CLOSED_POLICY from every safe accessor (TC-21)', () => {
    const cache = build(new FakeStore());
    expect(cache.resolveColumnSafe('a.b', 'c')).toEqual(FAIL_CLOSED_POLICY);
    expect(cache.resolveDtoFieldSafe('X', 'y')).toEqual(FAIL_CLOSED_POLICY);
    expect(cache.resolveFieldNameSafe('email')).toEqual(FAIL_CLOSED_POLICY);
  });

  it('says why, in a message that tells the caller what to do', () => {
    const cache = build(new FakeStore());
    expect(() => cache.current()).toThrow(/not loaded yet/);
    expect(() => cache.current()).toThrow(/fail closed/);
  });

  it('still explains itself when the reason has somehow been cleared', () => {
    const cache = build(new FakeStore());
    // Defensive branch: `lastFailure` is nulled on a successful load, so a null here with no
    // snapshot is a state the class should not be able to reach — and must still describe.
    (cache as unknown as { lastFailure: string | null }).lastFailure = null;
    expect(() => cache.current()).toThrow(/unknown/);
  });
});

describe('after a successful load', () => {
  it('serves the snapshot', async () => {
    const cache = build(new FakeStore());
    await cache.onModuleInit();
    expect(cache.isLoaded).toBe(true);
    expect(cache.policyCount).toBe(FIXTURE_POLICIES.length);
    expect(cache.resolveColumn('reward_portal.portal_users', 'email').logTreatment).toBe('mask');
    expect(cache.resolveDtoField('LoginRequest', 'password').logTreatment).toBe('omit');
    expect(cache.resolveFieldName('contactEmail')?.maskStrategy).toBe('email');
    expect(cache.policyFor('dto.LoginRequest.password')?.scope).toBe('dto_field');
    expect(cache.columnPoliciesFor('reward_config.merchants')).toHaveLength(1);
    expect(cache.protectedTables()).toContain('reward_portal.portal_users');
  });

  it('distinguishes "no policy matches" (null) from "cannot answer" (fail-closed)', async () => {
    const cache = build(new FakeStore());
    await cache.onModuleInit();
    // The distinction TC-21 is entirely about: an unclassified field is not a broken cache.
    expect(cache.resolveFieldNameSafe('campaignName')).toBeNull();
    expect(cache.resolveFieldNameSafe('password')).not.toBeNull();
  });
});

describe('load failures', () => {
  it('leaves the engine fail-closed when there was never a snapshot', async () => {
    const store = new FakeStore();
    store.failure = new Error('connection refused');
    const cache = build(store);
    await cache.onModuleInit();
    expect(cache.isLoaded).toBe(false);
    expect(cache.resolveColumnSafe('a.b', 'c')).toEqual(FAIL_CLOSED_POLICY);
    expect(() => cache.current()).toThrow(/connection refused/);
  });

  it('keeps the previous snapshot when a later load fails', async () => {
    const store = new FakeStore();
    const cache = build(store);
    await cache.onModuleInit();

    store.failure = new Error('gone');
    await cache.refresh();

    expect(cache.isLoaded).toBe(true);
    expect(cache.resolveColumn('reward_portal.portal_users', 'email').logTreatment).toBe('mask');
  });

  it('refuses a snapshot containing an invalid row rather than half-loading it', async () => {
    const store = new FakeStore();
    store.rows = [policy({ policyKey: 'a.b.c', logTreatment: 'mask' })];
    const cache = build(store);
    await cache.onModuleInit();
    expect(cache.isLoaded).toBe(false);
    expect(() => cache.current()).toThrow(/ck_dpp_mask_strategy/);
  });

  it('never rejects, whatever the store does', async () => {
    const store = new FakeStore();
    store.failure = new Error('boom');
    const cache = build(store);
    await expect(cache.refresh()).resolves.toBeUndefined();
    await expect(cache.invalidate()).resolves.toBeUndefined();
  });
});

describe('TTL and invalidation', () => {
  it('does not refresh before the TTL expires', async () => {
    let now = 1_000_000;
    const store = new FakeStore();
    const cache = build(store, () => now, 300);
    await cache.onModuleInit();
    expect(store.calls).toBe(1);

    now += 299_000;
    cache.current();
    expect(store.calls).toBe(1);
  });

  it('refreshes in the background once stale, and still serves the stale snapshot meanwhile', async () => {
    let now = 1_000_000;
    const store = new FakeStore();
    const cache = build(store, () => now, 300);
    await cache.onModuleInit();

    store.rows = [policy({ policyKey: 'x.y.z', classification: 'internal' })];
    now += 300_000;

    // The stale snapshot answers this call — a TTL boundary must not blank the response.
    expect(cache.current().size).toBe(FIXTURE_POLICIES.length);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.calls).toBe(2);
    expect(cache.current().size).toBe(1);
  });

  it('never expires when the TTL is zero', async () => {
    let now = 1_000_000;
    const store = new FakeStore();
    const cache = build(store, () => now, 0);
    await cache.onModuleInit();
    now += 10_000_000;
    cache.current();
    expect(store.calls).toBe(1);
  });

  // TC-20 — a policy change is visible without a restart.
  it('picks a changed policy up on invalidate, with no restart (TC-20)', async () => {
    const store = new FakeStore();
    const cache = build(store);
    await cache.onModuleInit();
    expect(cache.resolveColumn('reward_portal.portal_users', 'email').logTreatment).toBe('mask');

    store.rows = FIXTURE_POLICIES.map((row) =>
      row.policyKey === 'reward_portal.portal_users.email'
        ? { ...row, logTreatment: 'plain' as const, maskStrategy: null }
        : row,
    );
    await cache.invalidate();

    expect(cache.resolveColumn('reward_portal.portal_users', 'email').logTreatment).toBe('plain');
  });

  it('collapses concurrent refreshes onto one query', async () => {
    const store = new FakeStore();
    store.gate = () => undefined;
    const cache = build(store);

    const first = cache.refresh();
    const second = cache.refresh();
    expect(store.calls).toBe(1);

    store.gate?.();
    store.gate = null;
    await Promise.all([first, second]);
    expect(store.calls).toBe(1);
  });
});
