/**
 * T-013 — `TenancyScopeInterceptor`, and specifically the property that the obvious
 * implementation gets wrong.
 *
 * The suite is built around one idea: **the handler must observe the scope**. Every assertion
 * below reads `ScopeContext` from inside a `CallHandler` that is subscribed to the way Nest
 * subscribes to it — after `intercept()` has returned — because that is the moment the naive
 * `ScopeContext.run(scope, () => next.handle())` form has already exited the store.
 *
 * `interceptWith` deliberately mimics Nest's own sequencing: call `intercept`, keep the returned
 * observable, and subscribe to it on a later turn of the event loop. A test that subscribed
 * synchronously inside `intercept` would pass against the broken implementation.
 */
import { Controller, Get } from '@nestjs/common';
import { Observable, firstValueFrom, of, throwError } from 'rxjs';
import type { CallHandler } from '@nestjs/common';
import { ScopeContext, TenancyScopeInterceptor, type RequestScope } from '@/common/scope';
import { actor, contextFor } from './support/execution-context';

@Controller('things')
class ThingsController {
  @Get()
  list(): unknown {
    return { data: [] };
  }
}

/** A `CallHandler` whose observable runs `body` at *subscription* time, as Nest's does. */
function handlerRunning<T>(body: () => T): CallHandler {
  return {
    handle: () =>
      new Observable<T>((subscriber) => {
        subscriber.next(body());
        subscriber.complete();
      }),
  };
}

/**
 * Runs the interceptor and subscribes on a later tick — the sequencing that distinguishes a
 * correct implementation from one that merely looks correct.
 */
async function interceptWith<T>(
  interceptor: TenancyScopeInterceptor,
  context: ReturnType<typeof contextFor>,
  next: CallHandler,
): Promise<T> {
  const observable = interceptor.intercept(context, next);
  await new Promise((resolve) => setImmediate(resolve));
  return firstValueFrom(observable) as Promise<T>;
}

describe('TenancyScopeInterceptor', () => {
  const interceptor = new TenancyScopeInterceptor();

  it('establishes the scope for the handler, from the verified JWT claims only', async () => {
    const context = contextFor(ThingsController, 'list', {
      authUser: actor({ userId: 11, role: 'maker', countryId: 3, tenantId: 7, merchantId: null }),
    });

    const observed = await interceptWith<RequestScope>(
      interceptor,
      context,
      handlerRunning(() => ScopeContext.require('handler')),
    );

    expect(observed).toEqual({
      userId: 11,
      role: 'maker',
      countryId: 3,
      tenantId: 7,
      merchantId: null,
    });
  });

  it('carries the merchant id for a merchant session', async () => {
    const context = contextFor(ThingsController, 'list', {
      authUser: actor({ role: 'merchant', merchantId: 42 }),
    });

    const observed = await interceptWith<RequestScope>(
      interceptor,
      context,
      handlerRunning(() => ScopeContext.require('handler')),
    );

    expect(observed.merchantId).toBe(42);
  });

  it('reads nothing from headers, query or body — only authUser', async () => {
    const context = contextFor(ThingsController, 'list', {
      authUser: actor({ tenantId: 7 }),
      request: {
        headers: { 'x-tenant-id': '999' },
        query: { tenantId: '999' },
        body: { tenantId: 999, role: 'super_admin' },
      } as never,
    });

    const observed = await interceptWith<RequestScope>(
      interceptor,
      context,
      handlerRunning(() => ScopeContext.require('handler')),
    );

    expect(observed.tenantId).toBe(7);
    expect(observed.role).toBe('maker');
  });

  it('establishes nothing on an anonymous (@Public) request', async () => {
    const context = contextFor(ThingsController, 'list');

    const active = await interceptWith<boolean>(
      interceptor,
      context,
      handlerRunning(() => ScopeContext.isActive()),
    );

    expect(active).toBe(false);
  });

  it('passes a non-HTTP context straight through without establishing a scope', async () => {
    const context = contextFor(ThingsController, 'list', {
      type: 'rpc',
      authUser: actor(),
    });

    const active = await interceptWith<boolean>(
      interceptor,
      context,
      handlerRunning(() => ScopeContext.isActive()),
    );

    expect(active).toBe(false);
  });

  it('propagates the handler’s value unchanged', async () => {
    const context = contextFor(ThingsController, 'list', { authUser: actor() });
    const value = await interceptWith(interceptor, context, { handle: () => of('payload') });

    expect(value).toBe('payload');
  });

  it('propagates the handler’s error unchanged', async () => {
    const context = contextFor(ThingsController, 'list', { authUser: actor() });
    const failing: CallHandler = { handle: () => throwError(() => new Error('boom')) };

    await expect(interceptWith(interceptor, context, failing)).rejects.toThrow('boom');
  });

  it('leaves no scope behind after the request completes', async () => {
    const context = contextFor(ThingsController, 'list', { authUser: actor() });
    await interceptWith(interceptor, context, { handle: () => of('done') });

    expect(ScopeContext.isActive()).toBe(false);
  });

  it('returns a subscription as teardown, so unsubscribing cancels the inner chain', () => {
    const context = contextFor(ThingsController, 'list', { authUser: actor() });
    let torndown = false;

    const next: CallHandler = {
      handle: () =>
        new Observable(() => () => {
          torndown = true;
        }),
    };

    const subscription = interceptor.intercept(context, next).subscribe();
    subscription.unsubscribe();

    expect(torndown).toBe(true);
  });

  describe('TC-21/TC-22 — concurrency', () => {
    it('keeps two simultaneous requests on their own scopes', async () => {
      const makeRequest = (tenantId: number): Promise<RequestScope> => {
        const context = contextFor(ThingsController, 'list', {
          authUser: actor({ userId: tenantId, tenantId }),
        });

        // The handler yields to the event loop *before* reading the scope, so the two requests
        // are guaranteed to interleave between `intercept()` and the read.
        const next: CallHandler = {
          handle: () =>
            new Observable<RequestScope>((subscriber) => {
              setTimeout(() => {
                subscriber.next(ScopeContext.require('handler'));
                subscriber.complete();
              }, tenantId % 3);
            }),
        };

        return firstValueFrom(interceptor.intercept(context, next) as Observable<RequestScope>);
      };

      const [a, b] = await Promise.all([makeRequest(7), makeRequest(9)]);
      expect(a.tenantId).toBe(7);
      expect(b.tenantId).toBe(9);
    });

    it('holds across 500 interleaved requests from mixed tenants', async () => {
      // TC-22, at the interceptor level. The database-backed version is in `rbac.e2e-spec.ts`;
      // this one isolates the AsyncLocalStorage question from everything else, so a failure here
      // has exactly one possible cause.
      const requests = Array.from({ length: 500 }, (_, index) => {
        const tenantId = (index % 17) + 1;
        const context = contextFor(ThingsController, 'list', {
          authUser: actor({ userId: index, tenantId }),
        });

        const next: CallHandler = {
          handle: () =>
            new Observable<number>((subscriber) => {
              setTimeout(() => {
                const scope = ScopeContext.require('handler');
                if (scope.tenantId !== tenantId || scope.userId !== index) {
                  subscriber.error(
                    new Error(
                      `scope leak: request ${index} (tenant ${tenantId}) saw ` +
                        `user ${scope.userId} / tenant ${scope.tenantId}`,
                    ),
                  );
                  return;
                }
                subscriber.next(index);
                subscriber.complete();
              }, index % 5);
            }),
        };

        return firstValueFrom(interceptor.intercept(context, next) as Observable<number>);
      });

      await expect(Promise.all(requests)).resolves.toHaveLength(500);
    });
  });
});
