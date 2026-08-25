/**
 * T-041 — `RewardVersionsService` unit tests. Mirrors `rule-versions.service.spec.ts` exactly
 * (06-VERSIONING.md: "Reward equivalents mirror these exactly") — see that file's own header
 * for the shared reasoning; this file only re-proves the reward-specific shape
 * (`connectorConfig` cloning, `diffFlatObjectKeys`) rather than repeating every case.
 */
import { UniqueConstraintError } from 'sequelize';
import { PermissionDeniedHttpException } from '@/common/rbac/rbac.exceptions';
import { RewardSystem, RewardVersion, RewardVersionCountryAssignment } from '@/database/models';
import { PortalUser } from '@/database/portal-models';
import { RewardVersionsService } from '@/modules/versions/reward-versions.service';
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
  rewardRow,
  rewardVersionCountryAssignmentRow,
  rewardVersionRow,
} from './support/versions-doubles';

function buildService() {
  const scoped = new FakeScopedRepository();
  const sequelize = new FakeSequelize();
  const audit = new FakeAuditService();
  scoped.setByPk(PortalUser, portalUserRow());
  const service = new RewardVersionsService(
    asSequelize(sequelize),
    asScopedRepository(scoped),
    asAuditService(audit),
  );
  return { service, scoped, sequelize, audit };
}

describe('RewardVersionsService — reads', () => {
  it('list() maps every version through toRewardVersionDto, newest first', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardRow());
    scoped.setListRows(RewardVersion, [
      rewardVersionRow({ id: 2, versionNo: 2, status: 'draft', supersedesVersionId: 1 }),
      rewardVersionRow({ id: 1, versionNo: 1, status: 'published' }),
    ]);

    const rows = await service.list(1);

    expect(rows).toHaveLength(2);
    expect(rows[0].versionNo).toBe(2);
    expect(rows[1].suggestedIsBreaking).toBeNull();
  });

  it('getById() returns the version with its suggestion computed from supersedesVersionId', async () => {
    const { service, scoped } = buildService();
    const v1 = rewardVersionRow({ id: 1, connectorConfig: { apiKey: 'x' } });
    const v2 = rewardVersionRow({ id: 2, supersedesVersionId: 1, connectorConfig: {} });
    scoped.setByPk(RewardVersion, v2);
    scoped.setFindOneResult(RewardVersion, v1);

    const dto = await service.getById(1, 2);
    expect(dto.suggestedIsBreaking).toBe(true);
  });

  it('diff() highlights connectorConfig key changes and a deliveryMode change', async () => {
    const { service, scoped } = buildService();
    const v2 = rewardVersionRow({
      id: 2,
      versionNo: 2,
      deliveryMode: 'realtime',
      connectorConfig: { apiKey: 'a' },
    });
    const v3 = rewardVersionRow({
      id: 3,
      versionNo: 3,
      deliveryMode: 'batch',
      connectorConfig: { endpoint: 'x' },
    });
    scoped.pushByPk(RewardVersion, v2);
    scoped.pushByPk(RewardVersion, v3);

    const diff = await service.diff(1, 2, 3);
    expect(diff.expressionChanged).toBe(true);
    expect(diff.parametersAdded).toEqual(['endpoint']);
    expect(diff.parametersRemoved).toEqual(['apiKey']);
    expect(diff.suggestedIsBreaking).toBe(true);
  });

  it('listCountryAssignments() maps reward assignment rows', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardVersion, rewardVersionRow({ id: 5 }));
    scoped.setListRows(RewardVersionCountryAssignment, [
      rewardVersionCountryAssignmentRow({ rewardVersionId: 5, countryId: 2 }),
    ]);

    const rows = await service.listCountryAssignments(1, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0].versionId).toBe(5);
  });
});

describe('RewardVersionsService.createDraft — TC-1/TC-2 equivalents', () => {
  it('refuses a non-super_admin (layer 2)', async () => {
    const { service, scoped } = buildService();
    await expect(service.createDraft(actor({ role: 'checker' }), 1, {})).rejects.toBeInstanceOf(
      PermissionDeniedHttpException,
    );
    expect(scoped.calls).toHaveLength(0);
  });

  it('clones the latest published version’s connectorConfig/deliveryMode/retryConfig/unit', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardRow());
    scoped.setCount(RewardVersion, 0);
    const v1 = rewardVersionRow({
      id: 1,
      versionNo: 1,
      status: 'published',
      connectorConfig: { apiKey: 'abc' },
      unitType: 'points',
      unitCode: 'PTS',
    });
    scoped.pushListRows(RewardVersion, [v1]);
    scoped.pushListRows(RewardVersion, [v1]);

    const dto = await service.createDraft(actor(), 1, {});

    expect(dto.versionNo).toBe(2);
    expect(dto.supersedesVersionId).toBe(1);
    expect(dto.connectorConfig).toEqual({ apiKey: 'abc' });
    expect(dto.unitType).toBe('points');
  });

  it('bootstraps v1 from reward_systems when no version exists yet', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardRow({ connectorConfig: { seed: true } }));
    scoped.setCount(RewardVersion, 0);
    scoped.pushListRows(RewardVersion, []);
    scoped.pushListRows(RewardVersion, []);

    const dto = await service.createDraft(actor(), 1, {});
    expect(dto.versionNo).toBe(1);
    expect(dto.connectorConfig).toEqual({ seed: true });
    expect(dto.unitType).toBeNull();
  });

  it('refuses a second concurrent draft', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardRow());
    scoped.setCount(RewardVersion, 1);
    await expect(service.createDraft(actor(), 1, {})).rejects.toBeInstanceOf(
      VersionDraftAlreadyExistsError,
    );
  });

  it('uq_rewv_one_draft backstops a race', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardRow());
    scoped.setCount(RewardVersion, 0);
    scoped.pushListRows(RewardVersion, []);
    scoped.pushListRows(RewardVersion, []);
    scoped.failNextCreate(RewardVersion, new UniqueConstraintError({}));

    await expect(service.createDraft(actor(), 1, {})).rejects.toBeInstanceOf(
      VersionDraftAlreadyExistsError,
    );
  });
});

describe('RewardVersionsService.updateDraft', () => {
  it('draft-only: editing a published version → VersionInvalidTransitionError', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardVersion, rewardVersionRow({ id: 1, status: 'published' }));
    await expect(
      service.updateDraft(actor(), 1, 1, { deliveryMode: 'batch' }),
    ).rejects.toBeInstanceOf(VersionInvalidTransitionError);
  });

  it('requires confirmBreakingOverride when isBreaking disagrees with the suggestion', async () => {
    const { service, scoped } = buildService();
    const draft = rewardVersionRow({
      id: 2,
      status: 'draft',
      supersedesVersionId: 1,
      connectorConfig: {},
    });
    scoped.setByPk(RewardVersion, draft);
    scoped.setFindOneResult(
      RewardVersion,
      rewardVersionRow({ id: 1, connectorConfig: { apiKey: 'x' } }),
    );

    await expect(service.updateDraft(actor(), 1, 2, { isBreaking: false })).rejects.toBeInstanceOf(
      VersionBreakingConfirmationRequiredError,
    );
  });

  it('edits a draft — only supplied fields are written', async () => {
    const { service, scoped, audit } = buildService();
    scoped.pushByPk(
      RewardVersion,
      rewardVersionRow({ id: 1, status: 'draft', deliveryMode: 'realtime' }),
    );
    scoped.pushByPk(
      RewardVersion,
      rewardVersionRow({ id: 1, status: 'draft', deliveryMode: 'batch' }),
    );

    const dto = await service.updateDraft(actor(), 1, 1, { deliveryMode: 'batch' });

    expect(dto.deliveryMode).toBe('batch');
    const [call] = scoped.callsTo('update');
    expect(call.values).toEqual({ deliveryMode: 'batch' });
    expect(audit.diffFieldsCalls).toHaveLength(1);
  });

  it('accepts isBreaking when confirmBreakingOverride: true is supplied', async () => {
    const { service, scoped } = buildService();
    const draft = rewardVersionRow({
      id: 2,
      status: 'draft',
      supersedesVersionId: 1,
      connectorConfig: {},
    });
    scoped.pushByPk(RewardVersion, draft);
    scoped.setFindOneResult(
      RewardVersion,
      rewardVersionRow({ id: 1, connectorConfig: { apiKey: 'x' } }),
    );
    scoped.pushByPk(RewardVersion, { ...draft, isBreaking: false });

    await service.updateDraft(actor(), 1, 2, {
      isBreaking: false,
      confirmBreakingOverride: true,
    });

    const [call] = scoped.callsTo('update');
    expect((call.values as { isBreaking: boolean }).isBreaking).toBe(false);
  });
});

describe('RewardVersionsService.publish/deprecate/retire lifecycle', () => {
  it('publish requires draft', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardVersion, rewardVersionRow({ id: 1, status: 'published' }));
    await expect(service.publish(actor(), 1, 1)).rejects.toBeInstanceOf(
      VersionInvalidTransitionError,
    );
  });

  it('publish transitions draft → published', async () => {
    const { service, scoped } = buildService();
    scoped.pushByPk(RewardVersion, rewardVersionRow({ id: 1, status: 'draft' }));
    scoped.pushByPk(RewardVersion, rewardVersionRow({ id: 1, status: 'published' }));
    const dto = await service.publish(actor(), 1, 1);
    expect(dto.status).toBe('published');
  });

  it('deprecate then retire follow the fixed lifecycle order', async () => {
    const { service, scoped } = buildService();
    scoped.pushByPk(RewardVersion, rewardVersionRow({ id: 1, status: 'published' }));
    scoped.pushByPk(RewardVersion, rewardVersionRow({ id: 1, status: 'deprecated' }));
    const deprecated = await service.deprecate(actor(), 1, 1);
    expect(deprecated.status).toBe('deprecated');

    scoped.pushByPk(RewardVersion, rewardVersionRow({ id: 1, status: 'deprecated' }));
    scoped.pushByPk(RewardVersion, rewardVersionRow({ id: 1, status: 'retired' }));
    const retired = await service.retire(actor(), 1, 1);
    expect(retired.status).toBe('retired');
  });
});

describe('RewardVersionsService.withdrawFromCountry', () => {
  it('refuses a non-super_admin (layer 2)', async () => {
    const { service } = buildService();
    await expect(
      service.withdrawFromCountry(actor({ role: 'tenant_admin' }), 1, 1, 2),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });

  it('refuses when a campaign is bound (422-equivalent)', async () => {
    const { service, scoped, sequelize } = buildService();
    scoped.setByPk(RewardVersion, rewardVersionRow({ id: 5 }));
    scoped.setFindOneResult(
      RewardVersionCountryAssignment,
      rewardVersionCountryAssignmentRow({ id: 950, rewardVersionId: 5, countryId: 2 }),
    );
    sequelize.setQueryResult([{ id: 12, name: 'Campaign X' }]);

    await expect(service.withdrawFromCountry(actor(), 1, 5, 2)).rejects.toBeInstanceOf(
      VersionHasCampaignsError,
    );
  });

  it('withdraws an unused version', async () => {
    const { service, scoped, sequelize } = buildService();
    scoped.setByPk(RewardVersion, rewardVersionRow({ id: 5 }));
    scoped.setFindOneResult(
      RewardVersionCountryAssignment,
      rewardVersionCountryAssignmentRow({ id: 950, rewardVersionId: 5, countryId: 2 }),
    );
    sequelize.setQueryResult([]);

    await service.withdrawFromCountry(actor(), 1, 5, 2);
    const [call] = scoped.callsTo('update');
    expect((call.values as { status: string }).status).toBe('withdrawn');
  });
});
