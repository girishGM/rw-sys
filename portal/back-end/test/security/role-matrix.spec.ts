/**
 * T-051 TC-2, the half that needs no server — **the matrix's expectation function**.
 *
 * ### Why this is split from the e2e half at all
 *
 * `role-matrix.e2e-spec.ts` calls all six roles against all ~173 routes and asserts the status
 * each one gets. For that to be an *assertion* rather than a recording, something has to say what
 * the status should be, and that something is {@link expectedOutcome}: given a route's `@Public()`
 * / `@Roles()` / `@RequirePermission()` metadata and the live `role_entity_permissions` grants for
 * a role, does the guard chain admit or refuse?
 *
 * If that function were only ever exercised through the e2e run, its branches would be covered
 * incidentally by whatever routes happen to exist, and a bug in it would move the *expectation*
 * to match the bug — the classic way a matrix test becomes a very expensive `toMatchSnapshot`.
 * So its branches are enumerated here directly, against hand-written routes, with no database and
 * no HTTP. The e2e half then supplies the observable half of AGENT-PROTOCOL §3's requirement: the
 * real server's real status code, judged against this prediction.
 *
 * ### The one case worth reading twice
 *
 * A route carrying **only** `@RequirePermission` has no role list, so `RolesGuard` passes it and
 * `PermissionsGuard` decides alone (`roles.guard.ts`: "A route carrying only `@RequirePermission`
 * is guarded by layer 2 alone"). **103** of the application's routes are in that shape — measured
 * from the running router by `layer-two-exposure.e2e-spec.ts`, which also corrects the "116" an
 * earlier revision of this comment and of finding F-2 both carried.
 *
 * ### What this model does NOT know, and why that matters more than the count
 *
 * `expectedOutcome` models exactly two inputs: route metadata and the permission table. It has no
 * knowledge of the **service layer** — `assertRole(actor, …)`, T-013 implementation note 7's third
 * enforcement layer, which consults no table, no cache and no metadata.
 *
 * So "admitted" here means *"the two guards pass"*, **not** *"the request reaches the handler's
 * effect"*. An earlier revision of this file used these tests as the evidence for finding F-2's
 * claim that a single wrong permission row grants a `merchant` `POST /countries`. That was invalid
 * reasoning: a model that does not model `assertRole` cannot produce evidence about `assertRole`,
 * and the assertion would have passed either way. Measured against the real server with a real
 * over-granted session and a real valid body, `POST /countries` returns **403 and creates no row**,
 * because `CountriesService.create` opens with `assertRole(actor, 'super_admin')`.
 *
 * The tests under "layer 2 alone" below are therefore scoped to what they can actually establish —
 * the guard chain's behaviour — and say so. The exposure question is answered by measurement, in
 * `layer-two-exposure.e2e-spec.ts`.
 */
import {
  ALL_ROLES,
  expectedOutcome,
  grantsFromRows,
  signatureOf,
  type GuardedRoute,
  type PermissionGrants,
} from './support/route-guard-inventory';
import type { PortalRole } from '@/database/portal-models';

/** Builds a route entry without the ceremony of a real controller. */
function route(overrides: Partial<GuardedRoute> = {}): GuardedRoute {
  return {
    controller: 'FixtureController',
    handler: 'handle',
    method: 'GET',
    path: '/fixture',
    signature: signatureOf('GET', '/fixture'),
    isPublic: false,
    roles: undefined,
    permission: undefined,
    ...overrides,
  };
}

function grants(entries: Record<string, readonly string[]>): PermissionGrants {
  return new Map(Object.entries(entries).map(([entity, actions]) => [entity, new Set(actions)]));
}

const NO_GRANTS: PermissionGrants = new Map();

describe('T-051 TC-2: the matrix expectation function', () => {
  describe('@Public() routes', () => {
    it('is "public" for every role, regardless of any other metadata', () => {
      const published = route({ isPublic: true, roles: ['super_admin'] });

      for (const role of ALL_ROLES) {
        expect(expectedOutcome(published, role, NO_GRANTS)).toBe('public');
      }
    });

    it('is "public" even when a permission it does not hold is required', () => {
      const published = route({ isPublic: true, permission: { entity: 'rule', action: 'create' } });

      expect(expectedOutcome(published, 'merchant', NO_GRANTS)).toBe('public');
    });
  });

  describe('routes with no authorisation metadata at all', () => {
    it('denies every role — an endpoint shipped without a decorator must not default open', () => {
      for (const role of ALL_ROLES) {
        expect(expectedOutcome(route(), role, grants({ campaign: ['view'] }))).toBe('denied');
      }
    });
  });

  describe('layer 1 — @Roles', () => {
    it('admits a role that is in the list', () => {
      const guarded = route({ roles: ['super_admin', 'maker'] });

      expect(expectedOutcome(guarded, 'super_admin', NO_GRANTS)).toBe('admitted');
      expect(expectedOutcome(guarded, 'maker', NO_GRANTS)).toBe('admitted');
    });

    it('denies every role that is not', () => {
      const guarded = route({ roles: ['super_admin', 'maker'] });

      for (const role of ['country_admin', 'tenant_admin', 'checker', 'merchant'] as PortalRole[]) {
        expect(expectedOutcome(guarded, role, NO_GRANTS)).toBe('denied');
      }
    });

    it('denies on the role list before consulting the grants', () => {
      // A merchant holding `campaign:view` is still refused by a route that admits only makers.
      // The two layers are independent; layer 2 cannot rescue a layer-1 denial.
      const guarded = route({
        roles: ['maker'],
        permission: { entity: 'campaign', action: 'view' },
      });

      expect(expectedOutcome(guarded, 'merchant', grants({ campaign: ['view'] }))).toBe('denied');
    });

    it('admits an empty role list for nobody', () => {
      // `@Roles()` with no argument is a plausible typo; it must fail closed rather than read as
      // "no restriction".
      expect(expectedOutcome(route({ roles: [] }), 'super_admin', NO_GRANTS)).toBe('denied');
    });
  });

  describe('layer 2 — @RequirePermission', () => {
    it('admits when the role holds the entity and the action', () => {
      const guarded = route({
        roles: ALL_ROLES,
        permission: { entity: 'campaign', action: 'view' },
      });

      expect(expectedOutcome(guarded, 'maker', grants({ campaign: ['view', 'create'] }))).toBe(
        'admitted',
      );
    });

    it('denies when the entity is granted but the action is not', () => {
      const guarded = route({
        roles: ALL_ROLES,
        permission: { entity: 'campaign', action: 'approve' },
      });

      expect(expectedOutcome(guarded, 'maker', grants({ campaign: ['view', 'create'] }))).toBe(
        'denied',
      );
    });

    it('denies when the entity is absent entirely', () => {
      const guarded = route({
        roles: ALL_ROLES,
        permission: { entity: 'country', action: 'create' },
      });

      expect(expectedOutcome(guarded, 'merchant', grants({ campaign: ['view'] }))).toBe('denied');
    });

    it('denies when the role holds nothing at all', () => {
      const guarded = route({
        roles: ALL_ROLES,
        permission: { entity: 'campaign', action: 'view' },
      });

      expect(expectedOutcome(guarded, 'checker', NO_GRANTS)).toBe('denied');
    });
  });

  describe('layer 2 alone — the 103-route population behind finding F-2', () => {
    it('the GUARD CHAIN admits purely on the grant when the route carries no @Roles', () => {
      const guarded = route({ permission: { entity: 'country', action: 'create' } });

      // Nothing about the *role* is consulted by the two guards: `RolesGuard` returns true when
      // `roles === undefined`, so `PermissionsGuard` decides alone.
      //
      // Read this result narrowly. It says the guards pass. It does NOT say the request has any
      // effect: `CountriesService.create` then calls `assertRole(actor, 'super_admin')`, which
      // this model cannot see. Measured end to end, an over-granted merchant posting a *valid*
      // body to `POST /countries` gets 403 and creates nothing — see
      // `layer-two-exposure.e2e-spec.ts`. F-2's original claim rested on this assertion, which
      // could never have refuted it.
      expect(expectedOutcome(guarded, 'merchant', grants({ country: ['create'] }))).toBe(
        'admitted',
      );
    });

    it('denies purely on the grant when the route carries no @Roles', () => {
      const guarded = route({ permission: { entity: 'country', action: 'create' } });

      for (const role of ALL_ROLES) {
        expect(expectedOutcome(guarded, role, NO_GRANTS)).toBe('denied');
      }
    });

    it('is the point at which a @Roles list would have refused earlier in the chain', () => {
      // The same route, with a role list, refuses the merchant *at the guard* no matter what the
      // table says. This is a statement about **where** the refusal happens, not about whether a
      // refusal happens at all — on the real `POST /countries` the service layer refuses anyway.
      // Calling this "the single point of failure", as an earlier revision did, overstated it.
      const layerTwoOnly = route({ permission: { entity: 'country', action: 'create' } });
      const bothLayers = route({
        roles: ['super_admin'],
        permission: { entity: 'country', action: 'create' },
      });
      const misconfigured = grants({ country: ['create'] });

      expect(expectedOutcome(layerTwoOnly, 'merchant', misconfigured)).toBe('admitted');
      expect(expectedOutcome(bothLayers, 'merchant', misconfigured)).toBe('denied');
    });
  });

  describe('every cell of a small matrix is decided', () => {
    it('produces exactly one outcome per (route, role) pair', () => {
      const routes = [
        route({ isPublic: true, path: '/public' }),
        route({ roles: ['super_admin'], path: '/sa' }),
        route({ permission: { entity: 'campaign', action: 'view' }, path: '/perm' }),
        route({ path: '/naked' }),
      ];
      const held = grants({ campaign: ['view'] });

      const outcomes = routes.flatMap((entry) =>
        ALL_ROLES.map((role) => expectedOutcome(entry, role, held)),
      );

      expect(outcomes).toHaveLength(routes.length * ALL_ROLES.length);
      expect(outcomes.every((outcome) => ['public', 'admitted', 'denied'].includes(outcome))).toBe(
        true,
      );
      // The naked route contributes six denials; the public route six "public".
      expect(outcomes.filter((outcome) => outcome === 'public')).toHaveLength(6);
    });

    it('names all six roles of 00-ARCHITECTURE.md §2', () => {
      expect([...ALL_ROLES].sort()).toEqual([
        'checker',
        'country_admin',
        'maker',
        'merchant',
        'super_admin',
        'tenant_admin',
      ]);
    });
  });
});

describe('T-051 TC-2: reading role_entity_permissions', () => {
  it('parses the JSON-in-varchar shape the column actually holds', () => {
    const parsed = grantsFromRows(
      [
        { role: 'maker', entity: 'campaign', actions: '["view","create","update","submit"]' },
        { role: 'maker', entity: 'rule', actions: '["view"]' },
      ],
      'maker',
    );

    expect(parsed.get('campaign')).toEqual(new Set(['view', 'create', 'update', 'submit']));
    expect(parsed.get('rule')).toEqual(new Set(['view']));
  });

  it('accepts an already-parsed array, so a driver change cannot silently empty the matrix', () => {
    const parsed = grantsFromRows(
      [{ role: 'checker', entity: 'approval', actions: ['view', 'approve'] }],
      'checker',
    );

    expect(parsed.get('approval')).toEqual(new Set(['view', 'approve']));
  });

  it('ignores rows belonging to another role', () => {
    const parsed = grantsFromRows(
      [
        { role: 'super_admin', entity: 'country', actions: '["create"]' },
        { role: 'merchant', entity: 'campaign', actions: '["view"]' },
      ],
      'merchant',
    );

    expect(parsed.has('country')).toBe(false);
    expect(parsed.get('campaign')).toEqual(new Set(['view']));
  });

  it('skips a malformed row rather than granting it', () => {
    // Fail closed: an unreadable `actions` value must not become "all actions".
    const parsed = grantsFromRows(
      [
        { role: 'maker', entity: 'campaign', actions: '"not-an-array"' },
        { role: 'maker', entity: 'rule', actions: null },
      ],
      'maker',
    );

    expect(parsed.size).toBe(0);
  });

  it('returns an empty map for a role with no rows', () => {
    expect(grantsFromRows([], 'merchant').size).toBe(0);
  });
});
