/**
 * T-014 — `AuditService`: TC-2 (a `login_failure` row with no password), TC-3
 * (`permission_denied` with the attempted target), TC-4's `field_changes` rule, and TC-7 (an
 * audit insert forced to fail must not fail the request).
 *
 * Two properties get the most attention here because everything else depends on them:
 *
 *  1. **No method can reject.** Implementation note 4. Each one is called with a store that
 *     throws, and the assertion is that the promise resolves *and* that the event survives in
 *     the error log — a gap in the table is acceptable, a silently lost event is not.
 *  2. **The failure path never reads a request body.** TC-2 is usually written as "assert the
 *     password is not in `detail`", which passes just as well against an implementation that
 *     reads the body and redacts it — until one key is missing from the redaction list. The
 *     stronger assertion is made here instead: a request whose body is *entirely* secrets
 *     produces a detail object built only from method, route, status, code and trace id.
 */
import { Logger } from '@nestjs/common';
import { AuditContext } from '@/common/audit/audit-context';
import { PORTAL_AUDIT_EVENT } from '@/common/audit/audit.constants';
import { AuditService } from '@/common/audit/audit.service';
import { REDACTED } from '@/common/logging/redact';
import { FakeAuditStore, actor, requestDouble } from './support/http-doubles';

describe('AuditService', () => {
  let store: FakeAuditStore;
  let service: AuditService;
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    store = new FakeAuditStore();
    service = new AuditService(store);
  });

  afterEach(() => jest.restoreAllMocks());

  // --- portal_audit_log ---------------------------------------------------------------------

  describe('recordPortalEvent', () => {
    it('writes the actor, role, scope and IP as given', async () => {
      await service.recordPortalEvent({
        eventType: 'nav_config_updated',
        actorId: 42,
        actorRole: 'super_admin',
        targetType: 'role_nav_config',
        targetId: 9,
        countryId: 3,
        tenantId: 7,
        ipAddress: '10.0.0.4',
        detail: { changed: ['enabled'] },
      });

      expect(store.portalRows).toEqual([
        {
          eventType: 'nav_config_updated',
          actorId: 42,
          actorRole: 'super_admin',
          targetType: 'role_nav_config',
          targetId: '9',
          countryId: 3,
          tenantId: 7,
          ipAddress: '10.0.0.4',
          detail: { changed: ['enabled'] },
        },
      ]);
    });

    it('defaults every optional column to null rather than undefined', async () => {
      // `undefined` in a Sequelize `replacements` map is a runtime error, not a NULL. Every
      // caller omitting an optional field must produce a NULL column, not a failed insert.
      await service.recordPortalEvent({ eventType: 'login_failure' });

      expect(store.portalRows[0]).toEqual({
        eventType: 'login_failure',
        actorId: null,
        actorRole: null,
        targetType: null,
        targetId: null,
        countryId: null,
        tenantId: null,
        ipAddress: null,
        detail: null,
      });
    });

    it('redacts the detail object', async () => {
      await service.recordPortalEvent({
        eventType: 'password_changed',
        detail: { email: 'ops@example.com', newPassword: 'hunter2', nested: { token: 'abc' } },
      });

      expect(store.portalRows[0].detail).toEqual({
        email: 'ops@example.com',
        newPassword: REDACTED,
        nested: { token: REDACTED },
      });
    });

    it('truncates to the varchar(60) column widths instead of failing the insert', async () => {
      await service.recordPortalEvent({
        eventType: 'e'.repeat(80),
        targetType: 't'.repeat(80),
        targetId: 'i'.repeat(80),
      });

      const row = store.portalRows[0];
      expect(row.eventType).toHaveLength(60);
      expect(row.targetType).toHaveLength(60);
      expect(row.targetId).toHaveLength(60);
    });

    describe('TC-7 — an insert that fails', () => {
      it('resolves rather than rejecting', async () => {
        store.failWith = new Error('permission denied for table portal_audit_log');

        await expect(
          service.recordPortalEvent({ eventType: 'login_failure' }),
        ).resolves.toBeUndefined();
      });

      it('logs the whole event at error, redacted, so nothing is lost silently', async () => {
        store.failWith = new Error('permission denied for table portal_audit_log');

        await service.recordPortalEvent({
          eventType: 'password_changed',
          actorId: 42,
          detail: { password: 'hunter2' },
        });

        const [message] = errorLog.mock.calls[0] as [string];
        expect(message).toContain('AUDIT WRITE FAILED (portal_audit_log)');
        expect(message).toContain('password_changed');
        expect(message).toContain('permission denied for table portal_audit_log');
        expect(message).toContain(REDACTED);
        expect(message).not.toContain('hunter2');
      });
    });
  });

  // --- the failure path (TC-2, TC-3) --------------------------------------------------------

  describe('recordRequestFailure', () => {
    it('TC-3 — records permission_denied with the attempted route and the actor', async () => {
      const request = requestDouble({
        method: 'POST',
        routePath: '/api/v1/campaigns/:id/submit',
        authUser: actor({ userId: 42, role: 'merchant', countryId: 3, tenantId: 7 }),
      });

      await service.recordRequestFailure({
        request,
        status: 403,
        code: 'PERM_DENIED',
        traceId: 'trace-abc-123',
      });

      expect(store.portalRows).toEqual([
        {
          eventType: PORTAL_AUDIT_EVENT.PERMISSION_DENIED,
          actorId: 42,
          actorRole: 'merchant',
          targetType: 'route',
          targetId: '/api/v1/campaigns/:id/submit',
          countryId: 3,
          tenantId: 7,
          ipAddress: '10.0.0.4',
          detail: {
            method: 'POST',
            route: '/api/v1/campaigns/:id/submit',
            status: 403,
            code: 'PERM_DENIED',
            traceId: 'trace-abc-123',
          },
        },
      ]);
    });

    it('TC-2 — records login_failure for an anonymous request with no password anywhere in it', async () => {
      const request = requestDouble({
        method: 'POST',
        routePath: '/api/v1/auth/login',
        // A body full of nothing but secrets. If any code path read it, this test fails.
        body: { email: 'victim@example.com', password: 'hunter2-correct-horse' },
      });

      await service.recordRequestFailure({
        request,
        status: 401,
        code: 'AUTH_INVALID_CREDENTIALS',
        traceId: 'trace-xyz',
      });

      const row = store.portalRows[0];
      expect(row.eventType).toBe(PORTAL_AUDIT_EVENT.LOGIN_FAILURE);
      expect(row.actorId).toBeNull();
      expect(row.actorRole).toBeNull();
      expect(JSON.stringify(row.detail)).not.toContain('hunter2');
      expect(JSON.stringify(row.detail)).not.toContain('victim@example.com');
      expect(row.detail).toEqual({
        method: 'POST',
        route: '/api/v1/auth/login',
        status: 401,
        code: 'AUTH_INVALID_CREDENTIALS',
        traceId: 'trace-xyz',
      });
    });

    it('records csrf_rejected for both CSRF codes', async () => {
      const request = requestDouble({ routePath: '/api/v1/campaigns' });

      await service.recordRequestFailure({
        request,
        status: 403,
        code: 'CSRF_TOKEN_MISSING',
        traceId: 't1',
      });
      await service.recordRequestFailure({
        request,
        status: 403,
        code: 'CSRF_TOKEN_INVALID',
        traceId: 't2',
      });

      expect(store.portalRows.map((row) => row.eventType)).toEqual([
        PORTAL_AUDIT_EVENT.CSRF_REJECTED,
        PORTAL_AUDIT_EVENT.CSRF_REJECTED,
      ]);
    });

    it.each([
      ['NOT_FOUND', 404],
      ['VALIDATION_FAILED', 400],
      ['INTERNAL_ERROR', 500],
      ['RATE_LIMITED', 429],
    ])('writes no row for %s — not every failure is a security event', async (code, status) => {
      await service.recordRequestFailure({
        request: requestDouble(),
        status,
        code,
        traceId: 't',
      });

      expect(store.portalRows).toHaveLength(0);
    });

    it('records an empty route rather than failing when the request has neither route nor path', async () => {
      // Defensive: every real Express request has a `path`. A row with an empty target is still
      // a row saying "this actor was denied at this moment", which is the part that matters.
      const request = requestDouble({ path: undefined as unknown as string });

      await service.recordRequestFailure({
        request,
        status: 403,
        code: 'PERM_DENIED',
        traceId: 't',
      });

      expect(store.portalRows[0].targetId).toBe('');
      expect(store.portalRows[0].eventType).toBe(PORTAL_AUDIT_EVENT.PERMISSION_DENIED);
    });

    it('falls back to the concrete path when Express matched no route, and tolerates no IP', async () => {
      const request = requestDouble({ path: '/api/v1/unmatched', ip: undefined });

      await service.recordRequestFailure({
        request,
        status: 403,
        code: 'PERM_DENIED',
        traceId: 't',
      });

      expect(store.portalRows[0].targetId).toBe('/api/v1/unmatched');
      expect(store.portalRows[0].ipAddress).toBeNull();
    });
  });

  // --- campaign_audit_trail -----------------------------------------------------------------

  describe('recordDomainEvent', () => {
    it('writes the row, resolving performed_by from portal_users.admin_user_id', async () => {
      store.adminUserIdByPortalUser.set(42, 900);

      await service.recordDomainEvent({
        tenantId: 7,
        campaignId: 8821,
        entityType: 'campaign',
        action: 'updated',
        entityId: 8821,
        fieldChanges: { name: { before: 'A', after: 'B' } },
        actorPortalUserId: 42,
      });

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
    });

    it('prefers an explicitly supplied performedBy and does not query for it', async () => {
      const lookup = jest.spyOn(store, 'findAdminUserId');

      await service.recordDomainEvent({
        tenantId: 7,
        campaignId: 8821,
        entityType: 'campaign',
        action: 'approved',
        performedBy: 901,
        actorPortalUserId: 42,
        approvalRequestId: 5,
        comment: 'Looks good',
      });

      expect(lookup).not.toHaveBeenCalled();
      expect(store.domainRows[0].performedBy).toBe(901);
      expect(store.domainRows[0].approvalRequestId).toBe(5);
      expect(store.domainRows[0].comment).toBe('Looks good');
    });

    it('truncates a comment to the varchar(500) column width', async () => {
      await service.recordDomainEvent({
        tenantId: 7,
        campaignId: 1,
        entityType: 'campaign',
        action: 'rejected',
        performedBy: 901,
        comment: 'x'.repeat(600),
      });

      expect(store.domainRows[0].comment).toHaveLength(500);
    });

    it('skips the row — loudly — when the actor has no admin_users link', async () => {
      // fk_cat_performed_by would reject the insert. Attempting it anyway would produce the same
      // gap plus a database error; writing the portal user id instead would attribute the change
      // to an unrelated admin_users row, which is worse than a gap.
      await service.recordDomainEvent({
        tenantId: 7,
        campaignId: 8821,
        entityType: 'campaign',
        action: 'updated',
        actorPortalUserId: 42,
      });

      expect(store.domainRows).toHaveLength(0);
      const [message] = errorLog.mock.calls[0] as [string];
      expect(message).toContain('AUDIT WRITE FAILED (campaign_audit_trail)');
      expect(message).toContain('No reward_config.admin_users link for portal user 42');
    });

    it('skips the row when neither performedBy nor an actor was supplied at all', async () => {
      // A background job or a service that forgot both. There is nothing to attribute the change
      // to, and a domain audit row with a guessed actor is worse than none.
      await service.recordDomainEvent({
        tenantId: 7,
        campaignId: 8821,
        entityType: 'campaign',
        action: 'created',
      });

      expect(store.domainRows).toHaveLength(0);
      expect(errorLog).toHaveBeenCalled();
    });

    it('binds a null field_changes rather than the string "null"', async () => {
      await service.recordDomainEvent({
        tenantId: 7,
        campaignId: 1,
        entityType: 'tracker',
        action: 'created',
        performedBy: 901,
      });

      expect(store.domainRows[0].fieldChanges).toBeNull();
    });

    it('does not reject when the insert itself fails', async () => {
      store.adminUserIdByPortalUser.set(42, 900);
      store.failWith = new Error('deadlock detected');

      await expect(
        service.recordDomainEvent({
          tenantId: 7,
          campaignId: 8821,
          entityType: 'campaign',
          action: 'updated',
          actorPortalUserId: 42,
        }),
      ).resolves.toBeUndefined();
    });

    it('redacts field_changes on its way in, as a second line of defence after diffFields', async () => {
      await service.recordDomainEvent({
        tenantId: 7,
        campaignId: 1,
        entityType: 'campaign',
        action: 'updated',
        performedBy: 901,
        fieldChanges: { apiToken: { before: 'a', after: 'b' } },
      });

      expect(store.domainRows[0].fieldChanges).toEqual({ apiToken: REDACTED });
    });
  });

  // --- diffFields (implementation note 3, TC-4) ---------------------------------------------

  describe('diffFields', () => {
    it('keeps only the fields that changed', () => {
      const before = { name: 'Summer', status: 'draft', budgetAmount: 1000, region: 'EU' };
      const after = { name: 'Summer Sale', status: 'draft', budgetAmount: 2000, region: 'EU' };

      expect(service.diffFields(before, after)).toEqual({
        name: { before: 'Summer', after: 'Summer Sale' },
        budgetAmount: { before: 1000, after: 2000 },
      });
    });

    it('reports an added and a removed field, with null on the missing side', () => {
      expect(service.diffFields({ removed: 'x' }, { added: 'y' })).toEqual({
        removed: { before: 'x', after: null },
        added: { before: null, after: 'y' },
      });
    });

    it('drops redaction-listed fields entirely rather than masking them', () => {
      const changes = service.diffFields(
        { passwordHash: 'old', mfaSecret: 'old', name: 'A' },
        { passwordHash: 'new', mfaSecret: 'new', name: 'B' },
      );

      expect(Object.keys(changes)).toEqual(['name']);
    });

    it('compares structurally, so an equal object or date is not reported as changed', () => {
      const before = { metadata: { a: 1 }, startDate: new Date('2026-01-01') };
      const after = { metadata: { a: 1 }, startDate: new Date('2026-01-01') };

      expect(service.diffFields(before, after)).toEqual({});
    });

    it('reports a nested change without expanding the whole entity', () => {
      const changes = service.diffFields({ metadata: { a: 1 } }, { metadata: { a: 2 } });
      expect(changes).toEqual({ metadata: { before: { a: 1 }, after: { a: 2 } } });
    });

    it('treats an uncomparable value as changed rather than throwing', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;

      expect(() => service.diffFields({ v: cyclic }, { v: cyclic })).not.toThrow();
      expect(Object.keys(service.diffFields({ v: cyclic }, { v: cyclic }))).toEqual(['v']);
    });
  });

  // --- annotate ------------------------------------------------------------------------------

  describe('annotate', () => {
    it('merges into the current draft', () => {
      const draft = {};
      AuditContext.run(draft, () => service.annotate({ targetId: 8821, campaignId: 8821 }));

      expect(draft).toEqual({ targetId: 8821, campaignId: 8821 });
    });

    it('is a no-op outside an audited handler, logged at debug', () => {
      const debug = jest.spyOn(Logger.prototype, 'debug');

      expect(() => service.annotate({ targetId: 1 })).not.toThrow();
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('outside an audited handler'));
    });
  });
});
