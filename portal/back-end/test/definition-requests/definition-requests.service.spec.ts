/**
 * T-042 — `DefinitionRequestsService` unit tests, against in-memory doubles
 * (`support/definition-requests-doubles.ts`). These prove the *decisions* this service makes —
 * layer 2 (`assertRole`) firing before any query, the exact values passed to
 * `ScopedRepository.create` (never trusting a body-supplied scope), the state-machine
 * transitions, the rejection-comment/version-published business rules and the origin-request
 * traceability writes. Real tenancy scoping (TC-2/TC-15/TC-16/TC-17) is `ScopedRepository`'s and
 * `scope-strategy.ts`'s own, already exhaustively proven by T-013 — this suite proves this
 * service never works around it. The full request → review → approve → author → publish →
 * fulfil → blast chain (TC-18, verification steps 2-4) is proven for real, over a live Postgres
 * connection, in `definition-requests.e2e-spec.ts`.
 */
import { PermissionDeniedHttpException } from '@/common/rbac/rbac.exceptions';
import { ScopeViolationError } from '@/common/scope/scope.exceptions';
import { DefinitionRequest, RewardVersion, RuleVersion } from '@/database/models';
import { PortalUser } from '@/database/portal-models';
import { Tenant } from '@/database/models/tenant.model';
import { DefinitionRequestsService } from '@/modules/definition-requests/definition-requests.service';
import {
  DefinitionRequestInvalidTransitionError,
  DefinitionRequestVersionNotPublishedError,
  EntityIdNotAllowedError,
  EntityIdRequiredError,
  RejectionCommentRequiredError,
} from '@/modules/definition-requests/definition-requests.errors';
import {
  FakeAuditService,
  FakeNotificationsService,
  FakeScopedRepository,
  actor,
  asAuditService,
  asNotificationsService,
  asScopedRepository,
  definitionRequestRow,
  portalUserRow,
  rewardVersionRow,
  ruleVersionRow,
  tenantRow,
} from './support/definition-requests-doubles';

function buildService() {
  const scoped = new FakeScopedRepository();
  const audit = new FakeAuditService();
  const notifications = new FakeNotificationsService();
  scoped.setByPk(PortalUser, portalUserRow());
  const service = new DefinitionRequestsService(
    asScopedRepository(scoped),
    asAuditService(audit),
    asNotificationsService(notifications),
  );
  return { service, scoped, audit, notifications };
}

describe('DefinitionRequestsService.create — TC-1…TC-5, TC-20', () => {
  it('TC-4: refuses a maker before any query runs (layer 2)', async () => {
    const { service, scoped } = buildService();
    await expect(
      service.create(actor({ role: 'maker' }), {
        requestType: 'new_rule',
        title: 'A new rule',
        description: 'Please build me a rule for weekends.',
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
    expect(scoped.calls).toHaveLength(0);
  });

  it('TC-5: refuses a merchant before any query runs (layer 2)', async () => {
    const { service, scoped } = buildService();
    await expect(
      service.create(actor({ role: 'merchant' }), {
        requestType: 'new_rule',
        title: 'A new rule',
        description: 'Please build me a rule for weekends.',
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
    expect(scoped.calls).toHaveLength(0);
  });

  it('update_rule with no entityId is rejected before any write', async () => {
    const { service, scoped } = buildService();
    await expect(
      service.create(actor({ role: 'country_admin' }), {
        requestType: 'update_rule',
        title: 'Change the rule',
        description: 'The threshold needs to change.',
      }),
    ).rejects.toBeInstanceOf(EntityIdRequiredError);
    expect(scoped.callsTo('create')).toHaveLength(0);
  });

  it('new_rule with an entityId is rejected before any write', async () => {
    const { service, scoped } = buildService();
    await expect(
      service.create(actor({ role: 'country_admin' }), {
        requestType: 'new_rule',
        entityId: 5,
        title: 'A new rule',
        description: 'Please build me a rule for weekends.',
      }),
    ).rejects.toBeInstanceOf(EntityIdNotAllowedError);
    expect(scoped.callsTo('create')).toHaveLength(0);
  });

  it('TC-1/TC-2: country_admin submits — 201, submitted, and requestingCountryId/requestingTenantId are never taken from the DTO (CreateDefinitionRequestDto has no such fields)', async () => {
    const { service, scoped, audit } = buildService();
    scoped.setByPk(DefinitionRequest, definitionRequestRow());

    const result = await service.create(actor({ role: 'country_admin', countryId: 9 }), {
      requestType: 'new_rule',
      title: 'Weekend multiplier',
      description: 'We need a 2x multiplier on weekends.',
    });

    expect(result.status).toBe('submitted');
    const [call] = scoped.callsTo('create').filter((c) => c.model === 'DefinitionRequest');
    expect(call).toBeDefined();
    const values = call.values as { requestingCountryId: unknown; requestingTenantId: unknown };
    // Never `9` (a client-crafted value) written here directly — the actual scope value is
    // forced by `ScopedRepository.create` regardless of what this service passes, so this
    // service passes `null` for both, deliberately (TC-2, this file's own header).
    expect(values.requestingCountryId).toBeNull();
    expect(values.requestingTenantId).toBeNull();
    expect(audit.annotations[0]).toMatchObject({ targetType: 'definition_request' });
  });

  it('TC-3: tenant_admin submits — 201, tenant scope set', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(
      DefinitionRequest,
      definitionRequestRow({ requestingCountryId: null, requestingTenantId: 900 }),
    );

    const result = await service.create(actor({ role: 'tenant_admin', tenantId: 900 }), {
      requestType: 'new_reward',
      title: 'A new reward',
      description: 'Please build a new cashback reward type.',
    });

    expect(result.status).toBe('submitted');
  });

  it('TC-20: on submit, every active super_admin is notified', async () => {
    const { service, scoped, notifications } = buildService();
    scoped.setByPk(DefinitionRequest, definitionRequestRow());
    scoped.setListRows(PortalUser, [
      portalUserRow({ id: 50, role: 'super_admin' }),
      portalUserRow({ id: 51, role: 'super_admin' }),
    ]);
    scoped.setListRows(Tenant, [tenantRow({ id: 900, countryId: 9 })]);

    await service.create(actor({ role: 'country_admin', countryId: 9 }), {
      requestType: 'new_rule',
      title: 'Weekend multiplier',
      description: 'We need a 2x multiplier on weekends.',
    });

    expect(notifications.notified).toHaveLength(2);
    expect(notifications.notified[0]).toMatchObject({ recipientPortalUserId: 50, tenantId: 900 });
  });

  it('a notification failure never fails the create response', async () => {
    const { service, scoped, notifications } = buildService();
    scoped.setByPk(DefinitionRequest, definitionRequestRow());
    scoped.setListRows(PortalUser, [portalUserRow({ id: 50, role: 'super_admin' })]);
    scoped.setListRows(Tenant, [tenantRow({ id: 900, countryId: 9 })]);
    notifications.notify = jest.fn().mockRejectedValue(new Error('notification store down'));

    const result = await service.create(actor({ role: 'country_admin', countryId: 9 }), {
      requestType: 'new_rule',
      title: 'Weekend multiplier',
      description: 'We need a 2x multiplier on weekends.',
    });

    expect(result.id).toBeDefined();
  });

  it('skips notifying super admins when no tenant exists yet to satisfy the FK (disclosed gap), without failing the create response', async () => {
    const { service, scoped, notifications } = buildService();
    scoped.setByPk(DefinitionRequest, definitionRequestRow());
    scoped.setListRows(PortalUser, [portalUserRow({ id: 50, role: 'super_admin' })]);
    // No Tenant rows at all — `resolveNotifyTenantId` cannot resolve any id.

    const result = await service.create(actor({ role: 'country_admin', countryId: 9 }), {
      requestType: 'new_rule',
      title: 'Weekend multiplier',
      description: 'We need a 2x multiplier on weekends.',
    });

    expect(result.id).toBeDefined();
    expect(notifications.notified).toHaveLength(0);
  });
});

describe('DefinitionRequestsService.update/withdraw — TC-6…TC-8', () => {
  it('TC-6: requester edits while submitted — 200', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(DefinitionRequest, definitionRequestRow({ status: 'submitted' }));

    const result = await service.update(actor(), 1, { title: 'Updated title' });
    expect(result).toBeDefined();
    expect(scoped.callsTo('update')).toHaveLength(1);
  });

  it('TC-7: requester edits while under_review — 409', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(DefinitionRequest, definitionRequestRow({ status: 'under_review' }));

    await expect(service.update(actor(), 1, { title: 'Updated title' })).rejects.toBeInstanceOf(
      DefinitionRequestInvalidTransitionError,
    );
    expect(scoped.callsTo('update')).toHaveLength(0);
  });

  it('a role outside country_admin/tenant_admin is refused before any query (layer 2)', async () => {
    const { service, scoped } = buildService();
    await expect(
      service.update(actor({ role: 'super_admin' }), 1, { title: 'x' }),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
    expect(scoped.calls).toHaveLength(0);
  });

  it('edits businessJustification alone', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(DefinitionRequest, definitionRequestRow({ status: 'submitted' }));

    const result = await service.update(actor(), 1, { businessJustification: 'Because reasons' });
    expect(result).toBeDefined();
    const [call] = scoped.callsTo('update');
    expect(call.values).toMatchObject({ businessJustification: 'Because reasons' });
  });

  it('a concurrent status change racing the update (affected 0) surfaces as a 409, not a silent no-op', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(DefinitionRequest, definitionRequestRow({ status: 'submitted' }));
    scoped.setUpdateAffected(0);

    await expect(service.update(actor(), 1, { title: 'x' })).rejects.toBeInstanceOf(
      DefinitionRequestInvalidTransitionError,
    );
  });

  it('TC-8: requester withdraws while submitted — 200', async () => {
    const { service, scoped } = buildService();
    scoped.pushByPk(DefinitionRequest, definitionRequestRow({ status: 'submitted' }));
    scoped.pushByPk(DefinitionRequest, definitionRequestRow({ status: 'withdrawn' }));

    const result = await service.withdraw(actor(), 1);
    expect(result.status).toBe('withdrawn');
  });

  it('withdrawing a non-submitted request is refused', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(DefinitionRequest, definitionRequestRow({ status: 'approved' }));
    scoped.setUpdateAffected(0);

    await expect(service.withdraw(actor(), 1)).rejects.toBeInstanceOf(
      DefinitionRequestInvalidTransitionError,
    );
  });
});

describe('DefinitionRequestsService.review — TC-9…TC-12', () => {
  it('TC-9: super_admin moves submitted → under_review — 200; requester notified', async () => {
    const { service, scoped, notifications } = buildService();
    scoped.pushByPk(DefinitionRequest, definitionRequestRow({ status: 'submitted' }));
    scoped.pushByPk(DefinitionRequest, definitionRequestRow({ status: 'under_review' }));
    scoped.setByPk(PortalUser, portalUserRow({ id: 1, adminUserId: null }));
    scoped.setListRows(Tenant, [tenantRow({ id: 900, countryId: 9 })]);

    const result = await service.review(actor({ role: 'super_admin' }), 1, {
      status: 'under_review',
    });

    expect(result.status).toBe('under_review');
    expect(notifications.notified).toHaveLength(1);
  });

  it('a role outside super_admin is refused before any query (layer 2)', async () => {
    const { service, scoped } = buildService();
    await expect(
      service.review(actor({ role: 'country_admin' }), 1, { status: 'under_review' }),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
    expect(scoped.calls).toHaveLength(0);
  });

  it('TC-10: reject without a comment — 400, nothing written', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(DefinitionRequest, definitionRequestRow({ status: 'under_review' }));

    await expect(
      service.review(actor({ role: 'super_admin' }), 1, { status: 'rejected' }),
    ).rejects.toBeInstanceOf(RejectionCommentRequiredError);
    expect(scoped.callsTo('update')).toHaveLength(0);
  });

  it('TC-11: reject with a comment — 200; requester notified with the reason', async () => {
    const { service, scoped, notifications } = buildService();
    scoped.pushByPk(DefinitionRequest, definitionRequestRow({ status: 'under_review' }));
    scoped.pushByPk(
      DefinitionRequest,
      definitionRequestRow({ status: 'rejected', reviewComment: 'Not enough detail' }),
    );
    scoped.setListRows(Tenant, [tenantRow({ id: 900, countryId: 9 })]);

    const result = await service.review(actor({ role: 'super_admin' }), 1, {
      status: 'rejected',
      reviewComment: 'Not enough detail',
    });

    expect(result.status).toBe('rejected');
    expect(notifications.notified[0].message).toContain('Not enough detail');
  });

  it('a concurrent status change racing the review update (affected 0) surfaces as a 409', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(DefinitionRequest, definitionRequestRow({ status: 'submitted' }));
    scoped.setUpdateAffected(0);

    await expect(
      service.review(actor({ role: 'super_admin' }), 1, { status: 'under_review' }),
    ).rejects.toBeInstanceOf(DefinitionRequestInvalidTransitionError);
  });

  it('a notification failure during review never fails the response', async () => {
    const { service, scoped, notifications } = buildService();
    scoped.pushByPk(DefinitionRequest, definitionRequestRow({ status: 'submitted' }));
    scoped.pushByPk(DefinitionRequest, definitionRequestRow({ status: 'under_review' }));
    scoped.setListRows(Tenant, [tenantRow({ id: 900, countryId: 9 })]);
    notifications.notify = jest.fn().mockRejectedValue(new Error('notification store down'));

    const result = await service.review(actor({ role: 'super_admin' }), 1, {
      status: 'under_review',
    });
    expect(result.status).toBe('under_review');
  });

  it('TC-12: an illegal transition (submitted → approved, skipping under_review) is refused', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(DefinitionRequest, definitionRequestRow({ status: 'submitted' }));

    await expect(
      service.review(actor({ role: 'super_admin' }), 1, { status: 'approved' }),
    ).rejects.toBeInstanceOf(DefinitionRequestInvalidTransitionError);
    expect(scoped.callsTo('update')).toHaveLength(0);
  });

  it('a terminal status (fulfilled) accepts no further review transition', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(DefinitionRequest, definitionRequestRow({ status: 'fulfilled' }));

    await expect(
      service.review(actor({ role: 'super_admin' }), 1, { status: 'approved' }),
    ).rejects.toBeInstanceOf(DefinitionRequestInvalidTransitionError);
  });
});

describe('DefinitionRequestsService.fulfil — TC-12…TC-14, TC-19', () => {
  it('TC-12: fulfilling a submitted (not approved) request is refused — 409', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(DefinitionRequest, definitionRequestRow({ status: 'submitted' }));

    await expect(
      service.fulfil(actor({ role: 'super_admin' }), 1, { versionId: 10 }),
    ).rejects.toBeInstanceOf(DefinitionRequestInvalidTransitionError);
    expect(scoped.callsTo('update')).toHaveLength(0);
  });

  it('a role outside super_admin is refused before any query (layer 2)', async () => {
    const { service, scoped } = buildService();
    await expect(
      service.fulfil(actor({ role: 'country_admin' }), 1, { versionId: 10 }),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
    expect(scoped.calls).toHaveLength(0);
  });

  it('a concurrent status change racing the fulfil update (affected 0) surfaces as a 409', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(
      DefinitionRequest,
      definitionRequestRow({ status: 'approved', requestType: 'new_rule' }),
    );
    scoped.setByPk(RuleVersion, ruleVersionRow({ id: 10, status: 'published' }));
    scoped.setUpdateAffected(0);

    await expect(
      service.fulfil(actor({ role: 'super_admin' }), 1, { versionId: 10 }),
    ).rejects.toBeInstanceOf(DefinitionRequestInvalidTransitionError);
  });

  it('TC-14: fulfilling with a draft rule version is refused — 422', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(
      DefinitionRequest,
      definitionRequestRow({ status: 'approved', requestType: 'new_rule' }),
    );
    scoped.setByPk(RuleVersion, ruleVersionRow({ id: 10, status: 'draft' }));

    await expect(
      service.fulfil(actor({ role: 'super_admin' }), 1, { versionId: 10 }),
    ).rejects.toBeInstanceOf(DefinitionRequestVersionNotPublishedError);
    expect(scoped.callsTo('update').filter((c) => c.model === 'DefinitionRequest')).toHaveLength(0);
  });

  it('TC-13/TC-19: fulfilling with a published rule version — 200, fulfilledVersionId set, and the version is stamped with origin_request_id', async () => {
    const { service, scoped } = buildService();
    scoped.pushByPk(
      DefinitionRequest,
      definitionRequestRow({ id: 1, status: 'approved', requestType: 'new_rule' }),
    );
    scoped.pushByPk(
      DefinitionRequest,
      definitionRequestRow({
        id: 1,
        status: 'fulfilled',
        requestType: 'new_rule',
        fulfilledVersionId: 10,
      }),
    );
    scoped.setByPk(RuleVersion, ruleVersionRow({ id: 10, status: 'published' }));

    const result = await service.fulfil(actor({ role: 'super_admin' }), 1, { versionId: 10 });

    expect(result.status).toBe('fulfilled');
    const versionUpdate = scoped.callsTo('update').find((c) => c.model === 'RuleVersion');
    expect(versionUpdate).toBeDefined();
    expect(versionUpdate?.values).toMatchObject({ originRequestId: 1 });
    const requestUpdate = scoped.callsTo('update').find((c) => c.model === 'DefinitionRequest');
    expect(requestUpdate?.values).toMatchObject({ status: 'fulfilled', fulfilledVersionId: 10 });
  });

  it('fulfilling a reward request resolves against RewardVersion, not RuleVersion', async () => {
    const { service, scoped } = buildService();
    scoped.pushByPk(
      DefinitionRequest,
      definitionRequestRow({
        id: 2,
        status: 'approved',
        requestType: 'update_reward',
        entityId: 7,
      }),
    );
    scoped.pushByPk(
      DefinitionRequest,
      definitionRequestRow({
        id: 2,
        status: 'fulfilled',
        requestType: 'update_reward',
        entityId: 7,
        fulfilledVersionId: 20,
      }),
    );
    scoped.setByPk(RewardVersion, rewardVersionRow({ id: 20, status: 'published' }));

    const result = await service.fulfil(actor({ role: 'super_admin' }), 2, { versionId: 20 });

    expect(result.status).toBe('fulfilled');
    expect(scoped.callsTo('findByPkOrFail').some((c) => c.model === 'RewardVersion')).toBe(true);
    expect(scoped.callsTo('findByPkOrFail').some((c) => c.model === 'RuleVersion')).toBe(false);
  });
});

describe('DefinitionRequestsService.list/getById — TC-15…TC-17, TC-21', () => {
  it('TC-15: an out-of-scope id surfaces as ScopeViolationError (→ 404), never a differently-shaped error', async () => {
    const { service } = buildService();
    await expect(service.getById(999)).rejects.toBeInstanceOf(ScopeViolationError);
  });

  it('getById() returns the mapped DTO for an in-scope id', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(DefinitionRequest, definitionRequestRow({ id: 5, title: 'In scope' }));

    const dto = await service.getById(5);
    expect(dto.title).toBe('In scope');
  });

  it("TC-16/TC-17: list() adds no manual scope filter — visibility is entirely ScopedRepository/scope-strategy.ts's", async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(DefinitionRequest, [definitionRequestRow()]);
    scoped.setCount(DefinitionRequest, 1);

    const { rows, meta } = await service.list({});

    expect(rows).toHaveLength(1);
    expect(meta.total).toBe(1);
    const [call] = scoped.callsTo('listAll');
    expect(call.options).toMatchObject({ where: {} });
  });

  it('TC-21: filters by status and priority, and caps pageSize at 100', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(DefinitionRequest, []);

    await service.list({ status: 'submitted', priority: 'high', page: 1, pageSize: 500 });

    const [call] = scoped.callsTo('listAll');
    expect(call.options).toMatchObject({
      where: { status: 'submitted', priority: 'high' },
      limit: 100,
    });
  });
});
