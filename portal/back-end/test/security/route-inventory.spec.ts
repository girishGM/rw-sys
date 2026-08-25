/**
 * T-012 — TC-18, in two halves.
 *
 * This file proves the **detector works**, by pointing it at a controller that deliberately
 * breaks the rule. The e2e suite then points the same detector at the real `AppModule` and
 * asserts it finds nothing. A detector only ever run against clean code is a detector nobody
 * knows is wired up — this is the half that would catch it being silently broken.
 *
 * ---
 *
 * **T-051 appended the second half of this file** (everything below `--- T-051 ---`), and for the
 * same reason T-012 wrote the first: the audit's TC-1 detector — "every route is `@Public()` or
 * guarded, and the public list is exactly 03-API-CONTRACT.md §15's" — runs against the real
 * `AppModule` in `route-inventory.e2e-spec.ts`, where it finds (almost) nothing. A detector whose
 * only evidence is a green run against clean code is indistinguishable from a detector that
 * returns an empty array. So it is pointed at synthetic controllers here that break the rule in
 * each of the ways a real one could: no decorator at all, `@Public()` off the contract list,
 * `@Public()` inherited from the controller class, and a route guarded by layer 2 alone.
 */
import { Controller, Delete, Get, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { collectRoutes, findMutatingGetHandlers } from './support/route-inventory';
import { MUTATING_HANDLER_PREFIXES } from '@/common/security/security.constants';
import { Public } from '@/modules/auth/decorators/public.decorator';
import { RequirePermission, Roles } from '@/common/rbac';
import {
  API_PREFIX,
  CONTRACT_PUBLIC_ROUTES,
  classify,
  collectGuardedRoutes,
  isUnguarded,
  signatureOf,
} from './support/route-guard-inventory';

@Controller('good')
class WellBehavedController {
  @Get('items')
  listItems(): unknown {
    return { data: [] };
  }

  @Get(':id')
  findOne(): unknown {
    return { data: {} };
  }

  @Post('items')
  createItem(): unknown {
    return { data: {} };
  }
}

@Controller('bad')
class MutatingGetController {
  // The exact mistake TC-18 exists to catch: a state-changing handler behind a CSRF-exempt verb.
  @Get('revoke/:id')
  revokeSession(): unknown {
    return { data: {} };
  }

  @Get('list')
  listThings(): unknown {
    return { data: [] };
  }
}

async function inventoryOf(...controllers: unknown[]): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: controllers as never[],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('route inventory', () => {
  it('reads every route out of the DI container with its verb and handler name', async () => {
    const app = await inventoryOf(WellBehavedController);
    const routes = collectRoutes(app);

    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ handler: 'listItems', method: 'GET', path: '/good/items' }),
        expect.objectContaining({ handler: 'createItem', method: 'POST', path: '/good/items' }),
      ]),
    );

    await app.close();
  });

  it('finds nothing in a well-behaved controller', async () => {
    const app = await inventoryOf(WellBehavedController);
    expect(findMutatingGetHandlers(collectRoutes(app))).toEqual([]);
    await app.close();
  });

  it('catches a mutating @Get() handler', async () => {
    const app = await inventoryOf(MutatingGetController);
    const offenders = findMutatingGetHandlers(collectRoutes(app));

    expect(offenders).toHaveLength(1);
    expect(offenders[0].handler).toBe('revokeSession');

    await app.close();
  });

  it('does not flag the same verb on a POST', async () => {
    @Controller('fine')
    class RevokeByPostController {
      @Post('revoke')
      revokeSession(): unknown {
        return { data: {} };
      }
    }

    const app = await inventoryOf(RevokeByPostController);
    expect(findMutatingGetHandlers(collectRoutes(app))).toEqual([]);
    await app.close();
  });

  it('covers every prefix the constant lists', () => {
    const routes = MUTATING_HANDLER_PREFIXES.map((prefix) => ({
      controller: 'X',
      handler: `${prefix}Something`,
      method: 'GET',
      path: '/x',
    }));

    expect(findMutatingGetHandlers(routes)).toHaveLength(MUTATING_HANDLER_PREFIXES.length);
    expect(MUTATING_HANDLER_PREFIXES).toEqual([
      'create',
      'update',
      'delete',
      'submit',
      'approve',
      'reject',
      'revoke',
    ]);
  });
});

// --- T-051 ------------------------------------------------------------------------------------
//
// TC-1's detector, proven against controllers that break the rule. See this file's header.

@Controller('guarded')
class GuardedController {
  @Get('by-role')
  @Roles('super_admin')
  byRole(): unknown {
    return { data: [] };
  }

  @Get('by-role-and-permission')
  @Roles('super_admin', 'maker')
  @RequirePermission('campaign', 'view')
  byBoth(): unknown {
    return { data: [] };
  }

  /**
   * Layer 2 alone: no `@Roles`. `isRouteUnguarded` counts this as guarded (see
   * `route-authorisation.ts`), so the inventory must *not* flag it — but it is a distinct class
   * worth counting, because 02-SECURITY.md §11's checklist line says "no endpoint lacking
   * `@Roles`". Finding F-2 in the T-051 report is about exactly this population.
   */
  @Get('by-permission-only')
  @RequirePermission('campaign', 'view')
  byPermission(): unknown {
    return { data: [] };
  }
}

@Controller('leaky')
class UnguardedController {
  /** The mistake TC-1 exists to catch: shipped with no decorator of any kind. */
  @Get('oops')
  listSecrets(): unknown {
    return { data: [] };
  }

  @Delete('also-oops/:id')
  removeThing(): unknown {
    return { data: {} };
  }
}

@Controller('open')
@Public()
class ClassLevelPublicController {
  /** `@Public()` inherited from the class, exactly as `MfaController` does it. */
  @Post('one')
  one(): unknown {
    return { data: {} };
  }

  @Post('two')
  two(): unknown {
    return { data: {} };
  }
}

describe('T-051 TC-1: route-guard inventory', () => {
  it('reads @Public, @Roles and @RequirePermission off a built application', async () => {
    const app = await inventoryOf(GuardedController);
    const routes = collectGuardedRoutes(app);

    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          handler: 'byRole',
          isPublic: false,
          roles: ['super_admin'],
          permission: undefined,
        }),
        expect.objectContaining({
          handler: 'byBoth',
          roles: ['super_admin', 'maker'],
          permission: { entity: 'campaign', action: 'view' },
        }),
        expect.objectContaining({
          handler: 'byPermission',
          roles: undefined,
          permission: { entity: 'campaign', action: 'view' },
        }),
      ]),
    );

    await app.close();
  });

  it('resolves handler-then-class precedence, as the guards do', async () => {
    const app = await inventoryOf(ClassLevelPublicController);
    const routes = collectGuardedRoutes(app);

    // Neither handler carries `@Public()` itself; both must still read as public.
    expect(routes).toHaveLength(2);
    expect(routes.every((route) => route.isPublic)).toBe(true);

    await app.close();
  });

  it('finds no unguarded route in a well-decorated controller', async () => {
    const app = await inventoryOf(GuardedController);
    expect(classify(collectGuardedRoutes(app)).unguarded).toEqual([]);
    await app.close();
  });

  it('catches every route shipped without a decorator', async () => {
    const app = await inventoryOf(UnguardedController);
    const unguarded = classify(collectGuardedRoutes(app)).unguarded;

    expect(unguarded.map((route) => route.handler).sort()).toEqual(['listSecrets', 'removeThing']);

    await app.close();
  });

  it('does not mistake a public route for an unguarded one', async () => {
    const app = await inventoryOf(ClassLevelPublicController);
    const classified = classify(collectGuardedRoutes(app));

    expect(classified.unguarded).toEqual([]);
    expect(classified.publicRoutes).toHaveLength(2);

    await app.close();
  });

  it('separates layer-2-only routes from role-guarded ones', async () => {
    const app = await inventoryOf(GuardedController);
    const classified = classify(collectGuardedRoutes(app));

    expect(classified.roleGuarded.map((route) => route.handler).sort()).toEqual([
      'byBoth',
      'byRole',
    ]);
    expect(classified.permissionOnly.map((route) => route.handler)).toEqual(['byPermission']);

    await app.close();
  });

  it('classifies a mixed application into four disjoint, exhaustive groups', async () => {
    const app = await inventoryOf(
      GuardedController,
      UnguardedController,
      ClassLevelPublicController,
    );
    const routes = collectGuardedRoutes(app);
    const classified = classify(routes);

    // Disjoint and exhaustive: nothing is counted twice, nothing is missed. Without this, a bug
    // that dropped a route from every bucket would make `unguarded` empty and the suite green.
    expect(
      classified.publicRoutes.length +
        classified.roleGuarded.length +
        classified.permissionOnly.length +
        classified.unguarded.length,
    ).toBe(routes.length);

    // And pairwise disjoint — the sum above would also hold if one route appeared in two buckets
    // while another appeared in none.
    const buckets = [
      classified.publicRoutes,
      classified.roleGuarded,
      classified.permissionOnly,
      classified.unguarded,
    ];
    const seen = new Set(buckets.flat());
    expect(seen.size).toBe(routes.length);

    await app.close();
  });

  it('reports `isUnguarded` per route, independently of the classifier', async () => {
    const app = await inventoryOf(GuardedController, UnguardedController);
    const routes = collectGuardedRoutes(app);

    expect(
      routes
        .filter(isUnguarded)
        .map((route) => route.handler)
        .sort(),
    ).toEqual(['listSecrets', 'removeThing']);

    await app.close();
  });
});

describe('T-051 TC-1: route signatures compare against 03-API-CONTRACT.md §15', () => {
  it('renders a signature in the form the contract writes', () => {
    expect(signatureOf('POST', '/auth/login')).toBe('POST /api/v1/auth/login');
  });

  it('drops the trailing slash Nest produces for a controller-root route', () => {
    // `@Controller('health') @Get()` yields `/health/`; §15 writes `GET /api/v1/health`. Without
    // this, the single most important public route would look like a divergence on every run.
    expect(signatureOf('GET', '/health/')).toBe('GET /api/v1/health');
    expect(signatureOf('GET', '/health/ready')).toBe('GET /api/v1/health/ready');
  });

  it('leaves a root path alone', () => {
    expect(signatureOf('GET', '/')).toBe(`GET ${API_PREFIX}/`);
  });

  it('holds §15 as data, so a public route added to the code cannot silently join it', async () => {
    const app = await inventoryOf(ClassLevelPublicController);
    const publicSignatures = classify(collectGuardedRoutes(app)).publicRoutes.map(
      (route) => route.signature,
    );

    // The synthetic controller's routes are public and are *not* in §15 — which is exactly the
    // shape of a real regression, and the comparison must notice it.
    expect(publicSignatures).toEqual(['POST /api/v1/open/one', 'POST /api/v1/open/two']);
    expect(
      publicSignatures.filter((signature) => !CONTRACT_PUBLIC_ROUTES.includes(signature)),
    ).toHaveLength(2);

    await app.close();
  });

  it('states §15 exactly as the contract does', () => {
    // Six entries, four `/auth` and two health. Written out so a silent edit to the constant is
    // visible in a diff that a reviewer reads as "the contract changed".
    expect(CONTRACT_PUBLIC_ROUTES).toHaveLength(6);
    expect(CONTRACT_PUBLIC_ROUTES.filter((entry) => entry.includes('/auth/'))).toHaveLength(4);
    expect(CONTRACT_PUBLIC_ROUTES.filter((entry) => entry.includes('/health'))).toHaveLength(2);
  });
});
