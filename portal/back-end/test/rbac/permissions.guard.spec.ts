/**
 * T-013 — `PermissionsGuard`: TC-4, TC-16 and TC-17.
 *
 * TC-16 (a version bump defeating the TTL) is asserted here end-to-end through the real
 * `PermissionCacheService` against a fake store, because the property is a collaboration between
 * the two: the guard asks, the cache decides whether to re-read, and the store reports the
 * version. Testing either alone would leave the interesting half stubbed out.
 */
import { Controller, Get, Post } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Public } from '@/modules/auth/decorators/public.decorator';
import {
  PermissionCacheService,
  PermissionDeniedHttpException,
  PermissionsGuard,
  RequirePermission,
  Roles,
} from '@/common/rbac';
import { actor, contextFor } from './support/execution-context';
import { FakePermissionStore } from './support/fake-permission-store';

@Controller('campaigns')
class CampaignsController {
  @Post()
  @Roles('maker')
  @RequirePermission('campaign', 'create')
  create(): unknown {
    return {};
  }

  /** TC-1's shape: a role gate and no permission requirement. */
  @Get()
  @Roles('maker', 'checker')
  list(): unknown {
    return {};
  }

  @Get('oops')
  unguarded(): unknown {
    return {};
  }

  @Get('public')
  @Public()
  open(): unknown {
    return {};
  }
}

describe('PermissionsGuard', () => {
  let store: FakePermissionStore;
  let cache: PermissionCacheService;
  let guard: PermissionsGuard;
  let errors: jest.SpyInstance;

  beforeEach(() => {
    store = new FakePermissionStore();
    store.grant('maker', 'campaign', 'view', 'create', 'update', 'submit');
    store.grant('checker', 'campaign', 'view', 'approve', 'reject', 'return');

    cache = new PermissionCacheService(store);
    guard = new PermissionsGuard(new Reflector(), cache);

    errors = jest
      .spyOn((guard as unknown as { logger: { error: () => void } }).logger, 'error')
      .mockImplementation(() => undefined);
    jest
      .spyOn((guard as unknown as { logger: { debug: () => void } }).logger, 'debug')
      .mockImplementation(() => undefined);
    jest
      .spyOn((cache as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('TC-4: admits a maker with campaign:create seeded', async () => {
    const context = contextFor(CampaignsController, 'create', {
      authUser: actor({ role: 'maker' }),
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('denies a role that holds the entity but not the action', async () => {
    const context = contextFor(CampaignsController, 'create', {
      authUser: actor({ role: 'checker' }),
    });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });

  it('denies a role with no grant on the entity at all', async () => {
    const context = contextFor(CampaignsController, 'create', {
      authUser: actor({ role: 'merchant' }),
    });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });

  it('the 403 body carries a code and nothing else', async () => {
    const context = contextFor(CampaignsController, 'create', {
      authUser: actor({ role: 'merchant' }),
    });

    const error = (await guard
      .canActivate(context)
      .then(() => undefined)
      .catch((e: PermissionDeniedHttpException) => e)) as PermissionDeniedHttpException;

    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toEqual({ error: { code: 'PERM_DENIED' } });
    expect(JSON.stringify(error.getResponse())).not.toContain('campaign');
  });

  it('passes a route with no @RequirePermission through (TC-1’s shape)', async () => {
    const context = contextFor(CampaignsController, 'list', { authUser: actor({ role: 'maker' }) });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(store.grantReads).toBe(0);
  });

  it('admits a @Public() route without consulting anything', async () => {
    const context = contextFor(CampaignsController, 'open');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(store.versionReads).toBe(0);
  });

  it('passes a non-HTTP context through', async () => {
    const context = contextFor(CampaignsController, 'create', { type: 'rpc' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('TC-18: denies an unguarded route independently of RolesGuard', async () => {
    // The duplication with `RolesGuard` is the point: removing either check must not open the
    // route (02-SECURITY §5, "a mistake in one must not become an exploit").
    const context = contextFor(CampaignsController, 'unguarded', { authUser: actor() });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(PermissionDeniedHttpException);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('no authorisation metadata'));
  });

  it('denies loudly when the chain is mis-ordered and there is no authUser', async () => {
    const context = contextFor(CampaignsController, 'create');

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(PermissionDeniedHttpException);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('no authenticated user'));
  });

  describe('TC-16 — a version bump defeats the cache', () => {
    it('serves a repeat check from cache while nothing has changed', async () => {
      const context = contextFor(CampaignsController, 'create', {
        authUser: actor({ role: 'maker' }),
      });

      await guard.canActivate(context);
      await guard.canActivate(context);

      expect(store.grantReads).toBe(1);
      // The version, by contrast, is read every time — that is what makes the bump below work.
      expect(store.versionReads).toBe(2);
    });

    it('denies within the TTL once the permission is removed and the version bumped', async () => {
      const context = contextFor(CampaignsController, 'create', {
        authUser: actor({ role: 'maker' }),
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);

      // Exactly what T-033's Access Control screen does: edit the row, bump the counter.
      store.revoke('maker', 'campaign');
      await store.bumpRbacVersion('maker');

      // No clock advance — the entry's 300 s TTL has not come close to expiring.
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        PermissionDeniedHttpException,
      );
    });

    it('a stale entry is not served even from another instance’s point of view', async () => {
      // Simulates two processes: `cache` holds the entry, and the version moves underneath it
      // without this process ever calling `bumpVersion` itself.
      const context = contextFor(CampaignsController, 'create', {
        authUser: actor({ role: 'maker' }),
      });

      await guard.canActivate(context);
      store.revoke('maker', 'campaign');
      store.versions.set('maker', 99);

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        PermissionDeniedHttpException,
      );
    });
  });

  describe('TC-17 — fail-closed', () => {
    it('denies when the permission store throws', async () => {
      store.failReads = true;
      const context = contextFor(CampaignsController, 'create', {
        authUser: actor({ role: 'maker' }),
      });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        PermissionDeniedHttpException,
      );
    });

    it('answers 403 rather than letting a 500 escape', async () => {
      store.failReads = true;
      const context = contextFor(CampaignsController, 'create', {
        authUser: actor({ role: 'maker' }),
      });

      const error = (await guard
        .canActivate(context)
        .then(() => undefined)
        .catch((e: PermissionDeniedHttpException) => e)) as PermissionDeniedHttpException;

      expect(error.getStatus()).toBe(403);
      // The outage must be visible to an operator and invisible to the caller.
      expect(JSON.stringify(error.getResponse())).not.toContain('unavailable');
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('fail-closed'));
    });

    it('denies when a previously cached answer exists but the store has since failed', async () => {
      const context = contextFor(CampaignsController, 'create', {
        authUser: actor({ role: 'maker' }),
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      store.failReads = true;

      // The tempting alternative — serve the last known good entry through an outage — would
      // make a revoked permission survive exactly when revocation matters most.
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        PermissionDeniedHttpException,
      );
    });
  });
});
