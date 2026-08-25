/**
 * T-013 — `PermissionCacheService` on its own: caching, invalidation, TTL and the exact-match
 * discipline on action names.
 */
import { PermissionCacheService } from '@/common/rbac';
import { FakePermissionStore } from './support/fake-permission-store';

describe('PermissionCacheService', () => {
  let store: FakePermissionStore;
  let cache: PermissionCacheService;

  beforeEach(() => {
    store = new FakePermissionStore();
    cache = new PermissionCacheService(store);
    jest
      .spyOn((cache as unknown as { logger: { warn: () => void; log: () => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    jest
      .spyOn((cache as unknown as { logger: { log: () => void } }).logger, 'log')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('reading the matrix', () => {
    it('returns entity → actions as sets', async () => {
      store.grant('maker', 'campaign', 'view', 'create');

      const permissions = await cache.permissionsFor('maker');
      expect([...(permissions.get('campaign') ?? [])].sort()).toEqual(['create', 'view']);
    });

    it('returns an empty map for a role with no rows', async () => {
      expect((await cache.permissionsFor('merchant')).size).toBe(0);
    });

    it('unions duplicate rows for one entity rather than letting row order decide', async () => {
      store.grant('maker', 'campaign', 'view');
      store.grantExtraRow('maker', 'campaign', 'create');

      const permissions = await cache.permissionsFor('maker');
      expect([...(permissions.get('campaign') ?? [])].sort()).toEqual(['create', 'view']);
    });
  });

  describe('isGranted', () => {
    beforeEach(() => {
      store.grant('super_admin', 'rule', 'view', 'create', 'update', 'delete');
    });

    it('is true for a granted action', async () => {
      await expect(cache.isGranted('super_admin', 'rule', 'create')).resolves.toBe(true);
    });

    it('is false for an ungranted action on a granted entity', async () => {
      await expect(cache.isGranted('super_admin', 'rule', 'approve')).resolves.toBe(false);
    });

    it('is false for an unknown entity', async () => {
      await expect(cache.isGranted('super_admin', 'nonsense', 'view')).resolves.toBe(false);
    });

    it('matches exactly — "view" does not satisfy a grant of "review"', async () => {
      store.grant('maker', 'audit', 'review');

      await expect(cache.isGranted('maker', 'audit', 'view')).resolves.toBe(false);
      await expect(cache.isGranted('maker', 'audit', 'review')).resolves.toBe(true);
    });

    it('is not prefix-matched either — "create" does not satisfy "createDraft"', async () => {
      store.grant('maker', 'campaign', 'createDraft');
      await expect(cache.isGranted('maker', 'campaign', 'create')).resolves.toBe(false);
    });
  });

  describe('caching', () => {
    beforeEach(() => store.grant('maker', 'campaign', 'view'));

    it('reads the matrix once for repeated checks', async () => {
      await cache.permissionsFor('maker');
      await cache.permissionsFor('maker');
      await cache.permissionsFor('maker');

      expect(store.grantReads).toBe(1);
    });

    it('reads the version on every check — that is the invalidation mechanism', async () => {
      await cache.permissionsFor('maker');
      await cache.permissionsFor('maker');

      expect(store.versionReads).toBe(2);
    });

    it('caches per role, not globally', async () => {
      store.grant('checker', 'campaign', 'approve');

      await cache.permissionsFor('maker');
      await cache.permissionsFor('checker');

      expect(store.grantReads).toBe(2);
      expect(cache.size).toBe(2);
    });

    it('re-reads once the entry’s TTL has passed', async () => {
      const start = new Date('2026-08-18T00:00:00Z');
      await cache.permissionsFor('maker', start);

      const withinTtl = new Date(start.getTime() + 299_000);
      await cache.permissionsFor('maker', withinTtl);
      expect(store.grantReads).toBe(1);

      const afterTtl = new Date(start.getTime() + 301_000);
      await cache.permissionsFor('maker', afterTtl);
      expect(store.grantReads).toBe(2);
    });

    it('honours a configured TTL from rbac_cache_config', async () => {
      store.ttlSeconds = 10;
      const start = new Date('2026-08-18T00:00:00Z');

      await cache.permissionsFor('maker', start);
      await cache.permissionsFor('maker', new Date(start.getTime() + 11_000));

      expect(store.grantReads).toBe(2);
    });

    it('falls back to the 300 s default when the TTL row is missing, and warns', async () => {
      store.ttlSeconds = null;
      const warn = jest.spyOn(
        (cache as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      );

      const start = new Date('2026-08-18T00:00:00Z');
      await cache.permissionsFor('maker', start);
      await cache.permissionsFor('maker', new Date(start.getTime() + 299_000));

      expect(store.grantReads).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('300s default'));
    });

    it('reads the TTL once and reuses it', async () => {
      const readTtl = jest.spyOn(store, 'readTtlSeconds');

      await cache.permissionsFor('maker', new Date(0));
      await cache.permissionsFor('checker', new Date(0));

      expect(readTtl).toHaveBeenCalledTimes(1);
    });
  });

  describe('bumpVersion', () => {
    beforeEach(() => store.grant('maker', 'campaign', 'view'));

    it('increments the stored counter and returns the new value', async () => {
      await expect(cache.bumpVersion('maker')).resolves.toBe(2);
      await expect(cache.bumpVersion('maker')).resolves.toBe(3);
    });

    it('drops the local entry immediately, not only via the version key', async () => {
      await cache.permissionsFor('maker');
      expect(cache.size).toBe(1);

      await cache.bumpVersion('maker');
      expect(cache.size).toBe(0);
    });

    it('makes the next check see the edited matrix', async () => {
      await expect(cache.isGranted('maker', 'campaign', 'view')).resolves.toBe(true);

      store.revoke('maker', 'campaign');
      await cache.bumpVersion('maker');

      await expect(cache.isGranted('maker', 'campaign', 'view')).resolves.toBe(false);
    });
  });

  describe('invalidate', () => {
    beforeEach(() => {
      store.grant('maker', 'campaign', 'view');
      store.grant('checker', 'campaign', 'approve');
    });

    it('drops one role', async () => {
      await cache.permissionsFor('maker');
      await cache.permissionsFor('checker');

      cache.invalidate('maker');
      expect(cache.size).toBe(1);
    });

    it('drops everything, including the cached TTL, when called with no role', async () => {
      await cache.permissionsFor('maker');
      await cache.permissionsFor('checker');
      const readTtl = jest.spyOn(store, 'readTtlSeconds');

      cache.invalidate();
      expect(cache.size).toBe(0);

      await cache.permissionsFor('maker');
      expect(readTtl).toHaveBeenCalledTimes(1);
    });
  });

  describe('fail-closed (TC-17)', () => {
    it('propagates a store failure rather than substituting a value', async () => {
      store.failReads = true;
      await expect(cache.permissionsFor('maker')).rejects.toThrow(/unavailable/);
    });

    it('propagates from isGranted too, so the guard denies', async () => {
      store.failReads = true;
      await expect(cache.isGranted('maker', 'campaign', 'view')).rejects.toThrow(/unavailable/);
    });

    it('does not cache a failure as an empty grant', async () => {
      store.grant('maker', 'campaign', 'view');
      store.failReads = true;
      await expect(cache.permissionsFor('maker')).rejects.toThrow();

      store.failReads = false;
      await expect(cache.isGranted('maker', 'campaign', 'view')).resolves.toBe(true);
    });
  });
});
