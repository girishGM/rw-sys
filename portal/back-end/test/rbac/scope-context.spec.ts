/**
 * T-013 — `ScopeContext`: the store itself, and the isolation guarantees the rest of the module
 * assumes.
 *
 * TC-13 lives here (a scoped call with no context throws) and half of TC-21 (two concurrent
 * flows do not see each other's scope). The other half — that the *interceptor* enters the store
 * at the right moment — is in `tenancy-scope.interceptor.spec.ts`, because that is where the
 * mistake is actually made.
 */
import { MissingScopeContextError, ScopeContext, type RequestScope } from '@/common/scope';

const tenantA: RequestScope = {
  userId: 10,
  role: 'maker',
  countryId: 1,
  tenantId: 7,
  merchantId: null,
};

const tenantB: RequestScope = {
  userId: 20,
  role: 'maker',
  countryId: 1,
  tenantId: 9,
  merchantId: null,
};

describe('ScopeContext', () => {
  describe('outside a request', () => {
    it('reports no active scope', () => {
      expect(ScopeContext.isActive()).toBe(false);
      expect(ScopeContext.current()).toBeUndefined();
    });

    it('TC-13: require() throws rather than returning a permissive default', () => {
      expect(() => ScopeContext.require('findAll(TenantCampaign)')).toThrow(
        MissingScopeContextError,
      );
    });

    it('names the operation in the error so the log identifies the call site', () => {
      expect(() => ScopeContext.require('findAll(TenantCampaign)')).toThrow(
        /findAll\(TenantCampaign\)/,
      );
    });

    it('is not an HttpException — a wiring bug must surface as a 500, not a 403/404', () => {
      // If this ever becomes an HttpException, a missing interceptor starts looking like an
      // ordinary authorisation outcome and stops being investigated.
      let caught: unknown;
      try {
        ScopeContext.require('x');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { getStatus?: unknown }).getStatus).toBeUndefined();
    });
  });

  describe('inside run()', () => {
    it('exposes the scope to synchronous code', () => {
      ScopeContext.run(tenantA, () => {
        expect(ScopeContext.isActive()).toBe(true);
        expect(ScopeContext.require('op')).toEqual(tenantA);
      });
    });

    it('returns the callback’s value', () => {
      expect(ScopeContext.run(tenantA, () => 'result')).toBe('result');
    });

    it('propagates through awaits, timers and promise chains', async () => {
      await ScopeContext.run(tenantA, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(ScopeContext.require('op').tenantId).toBe(7);

        await Promise.resolve().then(() => {
          expect(ScopeContext.require('op').tenantId).toBe(7);
        });
      });
    });

    it('does not leak after the callback resolves', async () => {
      await ScopeContext.run(tenantA, async () => Promise.resolve());
      expect(ScopeContext.isActive()).toBe(false);
    });

    it('freezes the scope, so nothing downstream can widen it mid-request', () => {
      ScopeContext.run(tenantA, () => {
        const scope = ScopeContext.require('op') as { tenantId: number | null };
        expect(() => {
          scope.tenantId = 999;
        }).toThrow(TypeError);
        expect(ScopeContext.require('op').tenantId).toBe(7);
      });
    });

    it('copies on entry, so mutating the caller’s object afterwards changes nothing', () => {
      const mutable = { ...tenantA };
      ScopeContext.run(mutable, () => {
        mutable.tenantId = 999;
        expect(ScopeContext.require('op').tenantId).toBe(7);
      });
    });

    it('nests, innermost wins, and the outer scope is restored', () => {
      ScopeContext.run(tenantA, () => {
        ScopeContext.run(tenantB, () => {
          expect(ScopeContext.require('op').tenantId).toBe(9);
        });
        expect(ScopeContext.require('op').tenantId).toBe(7);
      });
    });
  });

  describe('TC-21 — concurrent flows', () => {
    it('keeps two interleaved async flows on their own scopes', async () => {
      const observed: number[] = [];

      const flow = async (scope: RequestScope, delays: number[]): Promise<void> =>
        ScopeContext.run(scope, async () => {
          for (const delay of delays) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            observed.push(ScopeContext.require('op').tenantId as number);
          }
        });

      // Deliberately uneven delays so the two flows interleave rather than run to completion in
      // turn — an even schedule can pass with a completely broken store.
      await Promise.all([flow(tenantA, [3, 1, 4, 1]), flow(tenantB, [1, 4, 1, 3])]);

      expect(observed).toHaveLength(8);
      expect(observed.filter((t) => t === 7)).toHaveLength(4);
      expect(observed.filter((t) => t === 9)).toHaveLength(4);
    });

    it('holds for 200 concurrent flows, each asserting its own tenant throughout', async () => {
      const flows = Array.from({ length: 200 }, (_, index) => {
        const scope: RequestScope = { ...tenantA, userId: index, tenantId: index };
        return ScopeContext.run(scope, async () => {
          for (let step = 0; step < 5; step += 1) {
            await new Promise((resolve) => setImmediate(resolve));
            if (ScopeContext.require('op').tenantId !== index) {
              throw new Error(`scope leaked: expected ${index}`);
            }
          }
          return index;
        });
      });

      await expect(Promise.all(flows)).resolves.toHaveLength(200);
    });
  });
});
