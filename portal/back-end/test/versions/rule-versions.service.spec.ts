/**
 * T-041 — `RuleVersionsService` unit tests, against in-memory doubles
 * (`support/versions-doubles.ts`). Same reasoning as `test/rules/rules.service.spec.ts`: these
 * prove the *decisions* this service makes; the guard-bypass property (TC-3-equivalent: a
 * misconfigured permission table cannot override `assertRole`) is proven for real, over HTTP,
 * in `versions.e2e-spec.ts`.
 */
import { UniqueConstraintError } from 'sequelize';
import { PermissionDeniedHttpException } from '@/common/rbac/rbac.exceptions';
import { RuleMaster, RuleVersion, RuleVersionCountryAssignment } from '@/database/models';
import { PortalUser } from '@/database/portal-models';
import { RuleVersionsService } from '@/modules/versions/rule-versions.service';
import {
  VersionBreakingConfirmationRequiredError,
  VersionDraftAlreadyExistsError,
  VersionHasCampaignsError,
  VersionInvalidTransitionError,
} from '@/modules/versions/versions.errors';
import {
  FakeAuditService,
  FakeScopedRepository,
  FakeSequelize,
  actor,
  asAuditService,
  asScopedRepository,
  asSequelize,
  portalUserRow,
  ruleRow,
  ruleVersionCountryAssignmentRow,
  ruleVersionRow,
} from './support/versions-doubles';

function buildService() {
  const scoped = new FakeScopedRepository();
  const sequelize = new FakeSequelize();
  const audit = new FakeAuditService();
  scoped.setByPk(PortalUser, portalUserRow());
  const service = new RuleVersionsService(
    asSequelize(sequelize),
    asScopedRepository(scoped),
    asAuditService(audit),
  );
  return { service, scoped, sequelize, audit };
}

describe('RuleVersionsService — reads', () => {
  it('list() maps every version through toRuleVersionDto, newest first', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow());
    scoped.setListRows(RuleVersion, [
      ruleVersionRow({ id: 2, versionNo: 2, status: 'draft', supersedesVersionId: 1 }),
      ruleVersionRow({ id: 1, versionNo: 1, status: 'published' }),
    ]);

    const rows = await service.list(1);

    expect(rows).toHaveLength(2);
    expect(rows[0].versionNo).toBe(2);
    // v2 supersedes v1 with an identical `parameters` clone in this fixture → not breaking.
    expect(rows[0].suggestedIsBreaking).toBe(false);
    expect(rows[1].suggestedIsBreaking).toBeNull();
  });

  it('getById() 404s for an absent or out-of-scope version', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleVersion, null);
    await expect(service.getById(1, 999)).rejects.toThrow();
  });

  it('getById() returns the version with its suggestion computed from supersedesVersionId', async () => {
    const { service, scoped } = buildService();
    const v1 = ruleVersionRow({
      id: 1,
      versionNo: 1,
      parameters: { fields: [{ key: 'minSpend', type: 'number' }] },
    });
    const v2 = ruleVersionRow({
      id: 2,
      versionNo: 2,
      supersedesVersionId: 1,
      parameters: { fields: [] },
    });
    scoped.setByPk(RuleVersion, v2);
    scoped.setFindOneResult(RuleVersion, v1);

    const dto = await service.getById(1, 2);
    // A removed parameter (`minSpend`) → suggested true (TC-26).
    expect(dto.suggestedIsBreaking).toBe(true);
  });

  it('diff() highlights added/removed/type-changed parameters and expression changes (TC-25)', async () => {
    const { service, scoped } = buildService();
    const v2 = ruleVersionRow({
      id: 2,
      versionNo: 2,
      expression: 'a >= 1',
      parameters: { fields: [{ key: 'minSpend', type: 'number' }] },
    });
    const v3 = ruleVersionRow({
      id: 3,
      versionNo: 3,
      expression: 'a >= 2',
      parameters: { fields: [{ key: 'tier', type: 'select' }] },
    });
    scoped.pushByPk(RuleVersion, v2);
    scoped.pushByPk(RuleVersion, v3);

    const diff = await service.diff(1, 2, 3);

    expect(diff.expressionChanged).toBe(true);
    expect(diff.parametersAdded).toEqual(['tier']);
    expect(diff.parametersRemoved).toEqual(['minSpend']);
    expect(diff.suggestedIsBreaking).toBe(true);
  });

  it('listCountryAssignments() maps assignment rows with their country and version number', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleVersion, ruleVersionRow({ id: 5 }));
    scoped.setListRows(RuleVersionCountryAssignment, [
      ruleVersionCountryAssignmentRow({ ruleVersionId: 5, countryId: 2 }),
    ]);

    const rows = await service.listCountryAssignments(1, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0].versionId).toBe(5);
  });
});

describe('RuleVersionsService.createDraft — TC-1/TC-2', () => {
  it('refuses a non-super_admin before any query runs (layer 2)', async () => {
    const { service, scoped } = buildService();
    await expect(service.createDraft(actor({ role: 'maker' }), 1, {})).rejects.toBeInstanceOf(
      PermissionDeniedHttpException,
    );
    expect(scoped.calls).toHaveLength(0);
  });

  it('TC-1: clones the latest published version, sets supersedesVersionId, versionNo = latest+1', async () => {
    const { service, scoped, audit } = buildService();
    scoped.setByPk(RuleMaster, ruleRow());
    scoped.setCount(RuleVersion, 0); // no existing draft
    const v2 = ruleVersionRow({
      id: 2,
      versionNo: 2,
      status: 'published',
      expression: 'amount >= 50',
      parameters: { fields: [{ key: 'minSpend', type: 'number' }] },
    });
    scoped.pushListRows(RuleVersion, [v2]); // latestPublishedVersion()
    scoped.pushListRows(RuleVersion, [v2]); // nextVersionNo()

    const dto = await service.createDraft(actor(), 1, { changeSummary: 'weekend bump' });

    expect(dto.versionNo).toBe(3);
    expect(dto.supersedesVersionId).toBe(2);
    expect(dto.expression).toBe('amount >= 50');
    expect(dto.status).toBe('draft');
    expect(dto.isBreaking).toBe(false);
    expect(audit.annotations[0]).toMatchObject({ targetId: dto.id, targetType: 'rule_version' });

    const [call] = scoped.callsTo('create');
    expect((call.values as { supersedesVersionId: number }).supersedesVersionId).toBe(2);
  });

  it('bootstraps v1 from rule_master when no version exists yet', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ expression: 'x > 1', parameters: { fields: [] } }));
    scoped.setCount(RuleVersion, 0);
    scoped.pushListRows(RuleVersion, []); // latestPublishedVersion() — none yet
    scoped.pushListRows(RuleVersion, []); // nextVersionNo() — none yet

    const dto = await service.createDraft(actor(), 1, {});

    expect(dto.versionNo).toBe(1);
    expect(dto.supersedesVersionId).toBeNull();
    expect(dto.expression).toBe('x > 1');
    expect(dto.suggestedIsBreaking).toBeNull();
  });

  it('TC-2: a second concurrent draft is refused before the insert (app-level check)', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow());
    scoped.setCount(RuleVersion, 1); // a draft already exists

    await expect(service.createDraft(actor(), 1, {})).rejects.toBeInstanceOf(
      VersionDraftAlreadyExistsError,
    );
    expect(scoped.callsTo('create')).toHaveLength(0);
  });

  it('TC-2: uq_rv_one_draft backstops a race between the check and the insert', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow());
    scoped.setCount(RuleVersion, 0);
    scoped.pushListRows(RuleVersion, []);
    scoped.pushListRows(RuleVersion, []);
    scoped.failNextCreate(RuleVersion, new UniqueConstraintError({}));

    await expect(service.createDraft(actor(), 1, {})).rejects.toBeInstanceOf(
      VersionDraftAlreadyExistsError,
    );
  });
});

describe('RuleVersionsService.updateDraft — TC-3/TC-4', () => {
  it('refuses a non-super_admin (layer 2)', async () => {
    const { service } = buildService();
    await expect(
      service.updateDraft(actor({ role: 'country_admin' }), 1, 1, {}),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });

  it('TC-3: edits a draft — 200, only supplied fields written', async () => {
    const { service, scoped, audit } = buildService();
    scoped.pushByPk(RuleVersion, ruleVersionRow({ id: 1, status: 'draft', expression: 'a' }));
    scoped.pushByPk(RuleVersion, ruleVersionRow({ id: 1, status: 'draft', expression: 'b' }));

    const dto = await service.updateDraft(actor(), 1, 1, { expression: 'b' });

    expect(dto.expression).toBe('b');
    const [call] = scoped.callsTo('update');
    expect(call.values).toEqual({ expression: 'b' });
    expect(audit.diffFieldsCalls).toHaveLength(1);
  });

  it('TC-4: editing a published version → VersionInvalidTransitionError, no write attempted', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleVersion, ruleVersionRow({ id: 1, status: 'published' }));

    await expect(service.updateDraft(actor(), 1, 1, { expression: 'x' })).rejects.toBeInstanceOf(
      VersionInvalidTransitionError,
    );
    expect(scoped.callsTo('update')).toHaveLength(0);
  });

  it('requires confirmBreakingOverride when isBreaking disagrees with the system suggestion (note 9)', async () => {
    const { service, scoped } = buildService();
    const draft = ruleVersionRow({
      id: 2,
      status: 'draft',
      supersedesVersionId: 1,
      parameters: { fields: [] },
    });
    scoped.setByPk(RuleVersion, draft);
    scoped.setFindOneResult(
      RuleVersion,
      ruleVersionRow({ id: 1, parameters: { fields: [{ key: 'minSpend', type: 'number' }] } }),
    );

    // Removing `minSpend` suggests `true`; the caller claims `false` without confirming.
    await expect(service.updateDraft(actor(), 1, 2, { isBreaking: false })).rejects.toBeInstanceOf(
      VersionBreakingConfirmationRequiredError,
    );
  });

  it('accepts isBreaking when confirmBreakingOverride: true is supplied', async () => {
    const { service, scoped } = buildService();
    const draft = ruleVersionRow({
      id: 2,
      status: 'draft',
      supersedesVersionId: 1,
      parameters: { fields: [] },
    });
    scoped.pushByPk(RuleVersion, draft);
    scoped.setFindOneResult(
      RuleVersion,
      ruleVersionRow({ id: 1, parameters: { fields: [{ key: 'minSpend', type: 'number' }] } }),
    );
    scoped.pushByPk(RuleVersion, { ...draft, isBreaking: false });

    await service.updateDraft(actor(), 1, 2, {
      isBreaking: false,
      confirmBreakingOverride: true,
    });

    const [call] = scoped.callsTo('update');
    expect((call.values as { isBreaking: boolean }).isBreaking).toBe(false);
  });
});

describe('RuleVersionsService.publish — TC-5/TC-6', () => {
  it('refuses a non-super_admin (layer 2)', async () => {
    const { service } = buildService();
    await expect(service.publish(actor({ role: 'maker' }), 1, 1)).rejects.toBeInstanceOf(
      PermissionDeniedHttpException,
    );
  });

  it('TC-5: publishes a draft — published, immutable fields set, publishedBy set', async () => {
    const { service, scoped, audit } = buildService();
    scoped.pushByPk(RuleVersion, ruleVersionRow({ id: 1, status: 'draft' }));
    scoped.pushByPk(RuleVersion, ruleVersionRow({ id: 1, status: 'published', publishedBy: 1 }));

    const dto = await service.publish(actor(), 1, 1);

    expect(dto.status).toBe('published');
    const [call] = scoped.callsTo('update');
    expect((call.values as { status: string }).status).toBe('published');
    expect(audit.annotations[0]).toMatchObject({ targetId: 1 });
  });

  it('TC-6: publishing an already-published version → VersionInvalidTransitionError (409)', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleVersion, ruleVersionRow({ id: 1, status: 'published' }));

    await expect(service.publish(actor(), 1, 1)).rejects.toBeInstanceOf(
      VersionInvalidTransitionError,
    );
  });
});

describe('RuleVersionsService.deprecate/retire — 06-VERSIONING.md §4.3 lifecycle', () => {
  it('deprecate requires published; refuses a draft', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleVersion, ruleVersionRow({ id: 1, status: 'draft' }));
    scoped.updateAffected = 0;

    await expect(service.deprecate(actor(), 1, 1)).rejects.toBeInstanceOf(
      VersionInvalidTransitionError,
    );
  });

  it('deprecate transitions published → deprecated', async () => {
    const { service, scoped } = buildService();
    scoped.pushByPk(RuleVersion, ruleVersionRow({ id: 1, status: 'published' }));
    scoped.pushByPk(RuleVersion, ruleVersionRow({ id: 1, status: 'deprecated' }));

    const dto = await service.deprecate(actor(), 1, 1);
    expect(dto.status).toBe('deprecated');
  });

  it('retire requires deprecated; refuses a published (not yet deprecated) version', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleVersion, ruleVersionRow({ id: 1, status: 'published' }));
    scoped.updateAffected = 0;

    await expect(service.retire(actor(), 1, 1)).rejects.toBeInstanceOf(
      VersionInvalidTransitionError,
    );
  });

  it('retire transitions deprecated → retired; the row still resolves afterwards (TC-24)', async () => {
    const { service, scoped } = buildService();
    scoped.pushByPk(RuleVersion, ruleVersionRow({ id: 1, status: 'deprecated' }));
    scoped.pushByPk(RuleVersion, ruleVersionRow({ id: 1, status: 'retired' }));

    const dto = await service.retire(actor(), 1, 1);
    expect(dto.status).toBe('retired');

    // TC-24: retiring never deletes the row — a subsequent read still resolves it.
    scoped.setByPk(RuleVersion, ruleVersionRow({ id: 1, status: 'retired' }));
    const read = await service.getById(1, 1);
    expect(read.status).toBe('retired');
  });
});

describe('RuleVersionsService.withdrawFromCountry — TC-21/TC-22', () => {
  it('refuses a non-super_admin (layer 2)', async () => {
    const { service } = buildService();
    await expect(
      service.withdrawFromCountry(actor({ role: 'country_admin' }), 1, 1, 2),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });

  it('TC-21: refuses when an active campaign is bound to this version in this country', async () => {
    const { service, scoped, sequelize } = buildService();
    scoped.setByPk(RuleVersion, ruleVersionRow({ id: 5 }));
    scoped.setFindOneResult(
      RuleVersionCountryAssignment,
      ruleVersionCountryAssignmentRow({ id: 900, ruleVersionId: 5, countryId: 2 }),
    );
    sequelize.setQueryResult([{ id: 71, name: 'Raya 2026' }]);

    const error: unknown = await service
      .withdrawFromCountry(actor(), 1, 5, 2)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VersionHasCampaignsError);
    expect((error as VersionHasCampaignsError).details).toEqual([
      { field: 'campaignId', code: 'CAMPAIGN_71' },
    ]);
    expect(scoped.callsTo('update')).toHaveLength(0);
  });

  it('TC-22: withdraws an unused version — the assignment row is marked withdrawn', async () => {
    const { service, scoped, sequelize, audit } = buildService();
    scoped.setByPk(RuleVersion, ruleVersionRow({ id: 5 }));
    scoped.setFindOneResult(
      RuleVersionCountryAssignment,
      ruleVersionCountryAssignmentRow({ id: 900, ruleVersionId: 5, countryId: 2 }),
    );
    sequelize.setQueryResult([]);

    await service.withdrawFromCountry(actor(), 1, 5, 2);

    const [call] = scoped.callsTo('update');
    expect((call.values as { status: string }).status).toBe('withdrawn');
    expect(audit.annotations[0]).toMatchObject({ targetId: 900 });
  });
});
