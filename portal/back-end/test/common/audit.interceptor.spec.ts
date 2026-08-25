/**
 * T-014 — `AuditInterceptor` and the `@Audit()` decorator.
 *
 * TC-6 is the headline: *"Handler throws after `@Audit` → **no** audit row written
 * (success-only)"*. The rest of the suite guards the two properties that make the row
 * trustworthy once it is written:
 *
 *  - **the actor and scope come from the verified JWT**, never from the draft a service filled
 *    in (AGENT-PROTOCOL R3) — a service may say *which campaign* changed, never *who* changed it;
 *  - **the draft is per-request**, established inside the observable's subscription, so two
 *    interleaved requests cannot annotate each other's rows. That failure mode is invisible to
 *    sequential tests, which is exactly why `tenancy-scope.interceptor.spec.ts` tests the same
 *    property for the scope context and why it is tested here rather than assumed.
 *
 * Like T-013's suite, contexts are built from **real decorated controller classes** so the
 * `Reflector` reads `@Audit()` metadata through the path Nest uses at runtime.
 */
import { Controller, Get, Logger, Patch, type CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, firstValueFrom, throwError } from 'rxjs';
import { AuditContext } from '@/common/audit/audit-context';
import { AuditInterceptor } from '@/common/audit/audit.interceptor';
import { AuditService } from '@/common/audit/audit.service';
import { AUDIT_METADATA, Audit, isDomainAudit } from '@/common/audit/decorators/audit.decorator';
import { FakeAuditStore, actor, contextFor } from './support/http-doubles';

@Controller('things')
class ThingsController {
  @Audit({ event: 'thing_updated', targetType: 'thing' })
  @Patch(':id')
  update(): unknown {
    return { data: { id: 8821 } };
  }

  @Audit({ store: 'campaign', event: 'updated', targetType: 'campaign' })
  @Patch('campaigns/:id')
  updateCampaign(): unknown {
    return { data: { id: 8821 } };
  }

  /** No `targetType`: the decorator's only required field is the event. */
  @Audit({ event: 'thing_touched' })
  @Patch('untyped/:id')
  updateUntyped(): unknown {
    return { data: {} };
  }

  @Get()
  list(): unknown {
    return { data: [] };
  }
}

/** A `CallHandler` whose observable runs `body` at *subscription* time, as Nest's does. */
function handlerRunning<T>(body: () => T | Promise<T>): CallHandler {
  return {
    handle: () =>
      new Observable<T>((subscriber) => {
        void (async () => {
          try {
            subscriber.next(await body());
            subscriber.complete();
          } catch (error) {
            subscriber.error(error);
          }
        })();
      }),
  };
}

describe('AuditInterceptor', () => {
  let store: FakeAuditStore;
  let audit: AuditService;
  let interceptor: AuditInterceptor;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    store = new FakeAuditStore();
    audit = new AuditService(store);
    interceptor = new AuditInterceptor(new Reflector(), audit);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('the decorator', () => {
    it('records what the interceptor reads, handler metadata included', () => {
      const options = new Reflector().get(AUDIT_METADATA, ThingsController.prototype.update);
      expect(options).toEqual({ event: 'thing_updated', targetType: 'thing' });
    });

    it('discriminates the two stores', () => {
      expect(isDomainAudit({ event: 'x', targetType: 'y' })).toBe(false);
      expect(isDomainAudit({ store: 'campaign', event: 'updated', targetType: 'campaign' })).toBe(
        true,
      );
    });
  });

  describe('an audited handler that succeeds', () => {
    it('writes one portal row, with the actor and scope from the JWT', async () => {
      const context = contextFor(ThingsController, 'update', {
        authUser: actor({ userId: 42, role: 'tenant_admin', countryId: 3, tenantId: 7 }),
        request: { method: 'PATCH', routePath: '/api/v1/things/:id', params: { id: '8821' } },
      });

      await firstValueFrom(
        interceptor.intercept(
          context,
          handlerRunning(() => ({ data: { id: 8821 } })),
        ),
      );

      expect(store.portalRows).toEqual([
        {
          eventType: 'thing_updated',
          actorId: 42,
          actorRole: 'tenant_admin',
          targetType: 'thing',
          targetId: '8821',
          countryId: 3,
          tenantId: 7,
          ipAddress: '10.0.0.4',
          detail: { method: 'PATCH', route: '/api/v1/things/:id' },
        },
      ]);
    });

    it('returns the handler’s value unchanged — auditing is invisible to the caller', async () => {
      const context = contextFor(ThingsController, 'update', { authUser: actor() });
      const body = await firstValueFrom(
        interceptor.intercept(
          context,
          handlerRunning(() => ({ data: { id: 1 } })),
        ),
      );

      expect(body).toEqual({ data: { id: 1 } });
    });

    it('writes the row before the response value is emitted', async () => {
      // `concatMap`, not `tap`: a client must never be told "done" before the record exists.
      const order: string[] = [];
      jest.spyOn(store, 'insertPortalEvent').mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('audit');
      });

      const context = contextFor(ThingsController, 'update', { authUser: actor() });
      await firstValueFrom(
        interceptor.intercept(
          context,
          handlerRunning(() => ({})),
        ),
      );
      order.push('response');

      expect(order).toEqual(['audit', 'response']);
    });

    it('lets a service contribute the target id and detail through annotate()', async () => {
      const context = contextFor(ThingsController, 'update', { authUser: actor() });

      await firstValueFrom(
        interceptor.intercept(
          context,
          handlerRunning(() => {
            audit.annotate({ targetId: 555, detail: { changed: ['name'] } });
            return {};
          }),
        ),
      );

      expect(store.portalRows[0].targetId).toBe('555');
      expect(store.portalRows[0].detail).toEqual({
        method: 'POST',
        route: '/api/v1/things/8821',
        changed: ['name'],
      });
    });

    it('never lets a draft override the actor — R3', async () => {
      const context = contextFor(ThingsController, 'update', {
        authUser: actor({ userId: 42, role: 'maker', tenantId: 7 }),
      });

      await firstValueFrom(
        interceptor.intercept(
          context,
          handlerRunning(() => {
            // A service trying to attribute the action to somebody else. `AuditDraft` has no
            // actor field at all, so this is the closest a caller can get — and it must not work.
            audit.annotate({ detail: { actorId: 1, actorRole: 'super_admin' } });
            return {};
          }),
        ),
      );

      expect(store.portalRows[0].actorId).toBe(42);
      expect(store.portalRows[0].actorRole).toBe('maker');
    });
  });

  describe('TC-6 — an audited handler that fails', () => {
    it('writes no row when the handler throws synchronously at subscription time', async () => {
      const context = contextFor(ThingsController, 'update', { authUser: actor() });

      await expect(
        firstValueFrom(
          interceptor.intercept(
            context,
            handlerRunning(() => {
              throw new Error('service blew up');
            }),
          ),
        ),
      ).rejects.toThrow('service blew up');

      expect(store.portalRows).toHaveLength(0);
      expect(store.domainRows).toHaveLength(0);
    });

    it('writes no row when the handler rejects asynchronously', async () => {
      const context = contextFor(ThingsController, 'update', { authUser: actor() });

      await expect(
        firstValueFrom(
          interceptor.intercept(
            context,
            handlerRunning(async () => {
              await Promise.resolve();
              throw new Error('constraint violation');
            }),
          ),
        ),
      ).rejects.toThrow('constraint violation');

      expect(store.portalRows).toHaveLength(0);
    });

    it('writes no row when the observable errors without ever emitting', async () => {
      const context = contextFor(ThingsController, 'update', { authUser: actor() });
      const next: CallHandler = { handle: () => throwError(() => new Error('guarded elsewhere')) };

      await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toThrow();
      expect(store.portalRows).toHaveLength(0);
    });

    it('still returns 200 when the audit write itself fails (TC-7, through the interceptor)', async () => {
      store.failWith = new Error('permission denied for table portal_audit_log');
      const context = contextFor(ThingsController, 'update', { authUser: actor() });

      const body = await firstValueFrom(
        interceptor.intercept(
          context,
          handlerRunning(() => ({ data: 'ok' })),
        ),
      );

      expect(body).toEqual({ data: 'ok' });
    });
  });

  describe('an audited handler with no authenticated actor', () => {
    it('writes the row with null actor and null scope rather than skipping it', async () => {
      // A `@Public()` route can be audited — `password_reset_requested` is one. The event is
      // still worth recording; what must not happen is an invented actor.
      const context = contextFor(ThingsController, 'update', {
        request: { params: {}, path: undefined as unknown as string, ip: '' },
      });

      await firstValueFrom(
        interceptor.intercept(
          context,
          handlerRunning(() => ({})),
        ),
      );

      expect(store.portalRows[0]).toMatchObject({
        actorId: null,
        actorRole: null,
        countryId: null,
        tenantId: null,
        targetId: null,
        ipAddress: null,
        detail: { route: '' },
      });
    });

    it('falls back to no target type when neither the draft nor the decorator names one', async () => {
      const context = contextFor(ThingsController, 'updateUntyped', { authUser: actor() });

      await firstValueFrom(
        interceptor.intercept(
          context,
          handlerRunning(() => ({})),
        ),
      );

      expect(store.portalRows[0].targetType).toBeNull();
    });

    it('ignores an :id too large to be a safe integer', async () => {
      const context = contextFor(ThingsController, 'updateCampaign', {
        authUser: actor({ tenantId: 7 }),
        request: { params: { id: '9'.repeat(25) } },
      });

      await firstValueFrom(
        interceptor.intercept(
          context,
          handlerRunning(() => ({})),
        ),
      );

      expect(store.domainRows).toHaveLength(0);
    });
  });

  describe('handlers that are not audited', () => {
    it('passes an undecorated handler straight through', async () => {
      const context = contextFor(ThingsController, 'list', { authUser: actor() });
      await firstValueFrom(
        interceptor.intercept(
          context,
          handlerRunning(() => ({ data: [] })),
        ),
      );

      expect(store.portalRows).toHaveLength(0);
    });

    it('passes a non-HTTP context straight through even when decorated', async () => {
      const context = contextFor(ThingsController, 'update', { type: 'rpc', authUser: actor() });
      await firstValueFrom(
        interceptor.intercept(
          context,
          handlerRunning(() => ({})),
        ),
      );

      expect(store.portalRows).toHaveLength(0);
    });
  });

  describe('the campaign_audit_trail path', () => {
    it('writes a domain row from the decorator plus the annotated diff', async () => {
      store.adminUserIdByPortalUser.set(42, 900);
      const context = contextFor(ThingsController, 'updateCampaign', {
        authUser: actor({ userId: 42, role: 'maker', tenantId: 7 }),
        request: { method: 'PATCH', routePath: '/api/v1/campaigns/:id', params: { id: '8821' } },
      });

      await firstValueFrom(
        interceptor.intercept(
          context,
          handlerRunning(() => {
            audit.annotate({
              fieldChanges: audit.diffFields({ name: 'A' }, { name: 'B' }),
              entityId: 8821,
            });
            return {};
          }),
        ),
      );

      expect(store.domainRows).toEqual([
        {
          tenantId: 7,
          campaignId: 8821,
          entityType: 'campaign',
          entityId: 8821,
          action: 'updated',
          fieldChanges: { name: { before: 'A', after: 'B' } },
          performedBy: 900,
          approvalRequestId: null,
          comment: null,
        },
      ]);
      expect(store.portalRows).toHaveLength(0); // never both stores — 01-DATABASE.md §2.5
    });

    it('takes the campaign id from :id when the service did not annotate one', async () => {
      store.adminUserIdByPortalUser.set(42, 900);
      const context = contextFor(ThingsController, 'updateCampaign', {
        authUser: actor({ userId: 42, tenantId: 7 }),
        request: { params: { id: '8821' }, routePath: '/api/v1/campaigns/:id' },
      });

      await firstValueFrom(
        interceptor.intercept(
          context,
          handlerRunning(() => ({})),
        ),
      );

      expect(store.domainRows[0].campaignId).toBe(8821);
    });

    it('lets an annotated action and entity type override the decorator’s', async () => {
      const context = contextFor(ThingsController, 'updateCampaign', {
        authUser: actor({ userId: 42, tenantId: 7 }),
        request: { params: { id: '8821' } },
      });

      await firstValueFrom(
        interceptor.intercept(
          context,
          handlerRunning(() => {
            audit.annotate({ action: 'rejected', entityType: 'campaign_approval', performedBy: 7 });
            return {};
          }),
        ),
      );

      expect(store.domainRows[0]).toMatchObject({
        action: 'rejected',
        entityType: 'campaign_approval',
        performedBy: 7,
      });
    });

    it('skips the row loudly when no campaign id can be established', async () => {
      const error = jest.spyOn(Logger.prototype, 'error');
      const context = contextFor(ThingsController, 'updateCampaign', {
        authUser: actor({ tenantId: 7 }),
        request: { params: {}, routePath: '/api/v1/campaigns' },
      });

      await firstValueFrom(
        interceptor.intercept(
          context,
          handlerRunning(() => ({})),
        ),
      );

      expect(store.domainRows).toHaveLength(0);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('AUDIT ROW SKIPPED (campaign_audit_trail)'),
      );
    });

    it('skips the row when the actor has no tenant and none was annotated', async () => {
      // A `super_admin` acting on a campaign: `tenantId` is null in the JWT, so the service must
      // annotate the tenant of the row it loaded. Guessing one would be a cross-tenant write.
      const context = contextFor(ThingsController, 'updateCampaign', {
        authUser: actor({ role: 'super_admin', tenantId: null }),
        request: { params: { id: '8821' } },
      });

      await firstValueFrom(
        interceptor.intercept(
          context,
          handlerRunning(() => ({})),
        ),
      );
      expect(store.domainRows).toHaveLength(0);
    });

    it('writes the row when the super_admin’s service annotates the tenant it loaded', async () => {
      const context = contextFor(ThingsController, 'updateCampaign', {
        authUser: actor({ userId: 42, role: 'super_admin', tenantId: null }),
        request: { params: { id: '8821' } },
      });

      await firstValueFrom(
        interceptor.intercept(
          context,
          handlerRunning(() => {
            audit.annotate({ tenantId: 12, performedBy: 900 });
            return {};
          }),
        ),
      );

      expect(store.domainRows[0]).toMatchObject({ tenantId: 12, campaignId: 8821 });
    });

    it('ignores a non-numeric :id rather than writing a wrong campaign id', async () => {
      const context = contextFor(ThingsController, 'updateCampaign', {
        authUser: actor({ tenantId: 7 }),
        request: { params: { id: 'not-a-number' } },
      });

      await firstValueFrom(
        interceptor.intercept(
          context,
          handlerRunning(() => ({})),
        ),
      );
      expect(store.domainRows).toHaveLength(0);
    });
  });

  describe('per-request isolation of the draft', () => {
    it('does not leak an annotation between two interleaved requests', async () => {
      const contextA = contextFor(ThingsController, 'update', {
        authUser: actor({ userId: 1 }),
        request: { params: { id: '1' } },
      });
      const contextB = contextFor(ThingsController, 'update', {
        authUser: actor({ userId: 2 }),
        request: { params: { id: '2' } },
      });

      const slow = handlerRunning(async () => {
        audit.annotate({ targetId: 'from-A' });
        await new Promise((resolve) => setTimeout(resolve, 10));
        // Annotating again *after* the other request has run and annotated its own draft: if the
        // store were shared, this would overwrite B's value or read B's.
        audit.annotate({ detail: { second: AuditContext.current()?.targetId } });
        return {};
      });
      const quick = handlerRunning(() => {
        audit.annotate({ targetId: 'from-B' });
        return {};
      });

      await Promise.all([
        firstValueFrom(interceptor.intercept(contextA, slow)),
        firstValueFrom(interceptor.intercept(contextB, quick)),
      ]);

      const targets = store.portalRows.map((row) => row.targetId).sort();
      expect(targets).toEqual(['from-A', 'from-B']);
      const fromA = store.portalRows.find((row) => row.targetId === 'from-A');
      expect(fromA?.detail).toMatchObject({ second: 'from-A' });
    });

    it('leaves no draft established once the request is finished', async () => {
      const context = contextFor(ThingsController, 'update', { authUser: actor() });
      await firstValueFrom(
        interceptor.intercept(
          context,
          handlerRunning(() => ({})),
        ),
      );

      expect(AuditContext.current()).toBeUndefined();
    });
  });
});
