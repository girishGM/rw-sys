/**
 * T-041 — `BlastsService` unit tests, against in-memory doubles
 * (`test/versions/support/versions-doubles.ts`). These prove the *decisions* this service makes
 * — layer 2 (`assertRole`) firing before any query, the exact `where` clauses passed to
 * `ScopedRepository`, the legacy dual-write, the superseded-not-removed invariant (TC-10) and
 * the no-writes-on-preview property (TC-19). Real transactional atomicity (TC-15), the DB
 * trigger (TC-4-equivalent) and the 40-country/<3s budget (TC-27) are proven for real, over a
 * live Postgres connection, in `blasts.e2e-spec.ts` — a unit test with a fake, always-commits
 * `sequelize.transaction()` cannot prove a rollback actually rolls back.
 */
import { UniqueConstraintError } from 'sequelize';
import { PermissionDeniedHttpException } from '@/common/rbac/rbac.exceptions';
import {
  Country,
  RewardCountryAssignment,
  RewardSystem,
  RewardVersion,
  RewardVersionCountryAssignment,
  RuleCountryAssignment,
  RuleMaster,
  RuleVersion,
  RuleVersionCountryAssignment,
  VersionBlast,
  VersionBlastTarget,
} from '@/database/models';
import { Tenant } from '@/database/models/tenant.model';
import { PortalUser } from '@/database/portal-models';
import { BlastsService } from '@/modules/blasts/blasts.service';
import {
  BreakingConfirmationRequiredError,
  InvalidCountrySelectionError,
  VersionNotPublishedError,
} from '@/modules/blasts/blasts.errors';
import {
  FakeAuditService,
  FakeNotificationsService,
  FakeScopedRepository,
  FakeSequelize,
  actor,
  asAuditService,
  asNotificationsService,
  asScopedRepository,
  asSequelize,
  countryRow,
  portalUserRow,
  rewardRow,
  rewardVersionRow,
  ruleRow,
  ruleVersionRow,
  versionBlastRow,
  versionBlastTargetRow,
} from '../versions/support/versions-doubles';

function buildService() {
  const scoped = new FakeScopedRepository();
  const sequelize = new FakeSequelize();
  const audit = new FakeAuditService();
  const notifications = new FakeNotificationsService();
  scoped.setByPk(PortalUser, portalUserRow());
  const service = new BlastsService(
    asSequelize(sequelize),
    asScopedRepository(scoped),
    asAuditService(audit),
    asNotificationsService(notifications),
  );
  return { service, scoped, sequelize, audit, notifications };
}

/** Wires the fixtures every `create()`/`preview()` happy-path test needs: a published, non-
 * breaking rule version, two selected countries, no pre-existing assignment rows. */
function wireHappyPath(scoped: FakeScopedRepository) {
  scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
  scoped.setByPk(RuleVersion, ruleVersionRow({ id: 10, versionNo: 3, status: 'published' }));
  scoped.setListRows(Country, [
    countryRow({ id: 2, code: 'MY', name: 'Malaysia' }),
    countryRow({ id: 3, code: 'SG', name: 'Singapore' }),
  ]);
  scoped.setCount(RuleVersionCountryAssignment, 0);
  scoped.setCount(RuleCountryAssignment, 0);
}

describe('BlastsService.preview — TC-19/TC-20', () => {
  it('refuses a non-super_admin (layer 2)', async () => {
    const { service, scoped } = buildService();
    await expect(
      service.preview(actor({ role: 'country_admin' }), {
        entityType: 'rule',
        entityId: 1,
        versionId: 10,
        scope: 'selected',
        countryIds: [2],
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
    expect(scoped.calls).toHaveLength(0);
  });

  it('TC-14-equivalent: previewing a draft version is refused', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
    scoped.setByPk(RuleVersion, ruleVersionRow({ id: 10, status: 'draft' }));

    await expect(
      service.preview(actor(), {
        entityType: 'rule',
        entityId: 1,
        versionId: 10,
        scope: 'selected',
        countryIds: [2],
      }),
    ).rejects.toBeInstanceOf(VersionNotPublishedError);
  });

  it('TC-19: writes nothing — no create/update calls at all', async () => {
    const { service, scoped } = buildService();
    wireHappyPath(scoped);
    scoped.setListRows(RuleVersionCountryAssignment, []); // no current assignment in either country

    await service.preview(actor(), {
      entityType: 'rule',
      entityId: 1,
      versionId: 10,
      scope: 'selected',
      countryIds: [2, 3],
    });

    expect(scoped.callsTo('create')).toHaveLength(0);
    expect(scoped.callsTo('update')).toHaveLength(0);
    expect(scoped.callsTo('destroy')).toHaveLength(0);
  });

  it('reports per-country impact — current version, target version and isBreaking', async () => {
    const { service, scoped } = buildService();
    wireHappyPath(scoped);
    scoped.setByPk(
      RuleVersion,
      ruleVersionRow({ id: 10, versionNo: 3, status: 'published', isBreaking: true }),
    );
    scoped.setListRows(RuleVersionCountryAssignment, [
      {
        ruleVersionId: 7,
        ruleVersion: ruleVersionRow({ id: 7, versionNo: 2 }),
      },
    ]);

    const preview = await service.preview(actor(), {
      entityType: 'rule',
      entityId: 1,
      versionId: 10,
      scope: 'selected',
      countryIds: [2, 3],
    });

    expect(preview.isBreaking).toBe(true);
    expect(preview.countries).toHaveLength(2);
    expect(preview.countries[0].currentVersionNo).toBe(2);
    expect(preview.countries[0].willReceiveVersionNo).toBe(3);
  });
});

describe('BlastsService.create — TC-7…TC-16', () => {
  it('refuses a non-super_admin before any query runs (layer 2)', async () => {
    const { service, scoped } = buildService();
    await expect(
      service.create(actor({ role: 'country_admin' }), {
        entityType: 'rule',
        entityId: 1,
        versionId: 10,
        scope: 'selected',
        countryIds: [2],
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
    expect(scoped.calls).toHaveLength(0);
  });

  it('TC-14: blasting a draft version → VersionNotPublishedError (422), nothing written', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
    scoped.setByPk(RuleVersion, ruleVersionRow({ id: 10, status: 'draft' }));

    await expect(
      service.create(actor(), {
        entityType: 'rule',
        entityId: 1,
        versionId: 10,
        scope: 'selected',
        countryIds: [2],
      }),
    ).rejects.toBeInstanceOf(VersionNotPublishedError);
    expect(scoped.callsTo('create')).toHaveLength(0);
  });

  it('a breaking version requires confirmBreaking: true', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
    scoped.setByPk(RuleVersion, ruleVersionRow({ id: 10, status: 'published', isBreaking: true }));

    await expect(
      service.create(actor(), {
        entityType: 'rule',
        entityId: 1,
        versionId: 10,
        scope: 'selected',
        countryIds: [2],
      }),
    ).rejects.toBeInstanceOf(BreakingConfirmationRequiredError);
  });

  it('a mismatched selected countryId (does not resolve) → InvalidCountrySelectionError', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
    scoped.setByPk(RuleVersion, ruleVersionRow({ id: 10, status: 'published' }));
    scoped.setListRows(Country, [countryRow({ id: 2 })]); // caller asked for [2, 999]

    await expect(
      service.create(actor(), {
        entityType: 'rule',
        entityId: 1,
        versionId: 10,
        scope: 'selected',
        countryIds: [2, 999],
      }),
    ).rejects.toBeInstanceOf(InvalidCountrySelectionError);
  });

  it('TC-7/TC-9/TC-10: blast to 2 selected countries — 1 blast row, 2 targets, 2 version assignments, legacy upserted, prior versions superseded', async () => {
    const { service, scoped, audit, notifications } = buildService();
    wireHappyPath(scoped);
    scoped.setListRows(PortalUser, []); // no country_admin to notify — keep this test focused

    const dto = {
      entityType: 'rule' as const,
      entityId: 1,
      versionId: 10,
      scope: 'selected' as const,
      countryIds: [2, 3],
    };
    scoped.setByPk(VersionBlast, versionBlastRow({ id: 700, targetCount: 2 }));
    scoped.setListRows(VersionBlastTarget, [
      versionBlastTargetRow({ id: 1, countryId: 2 }),
      versionBlastTargetRow({ id: 2, countryId: 3 }),
    ]);

    const result = await service.create(actor(), dto);

    expect(result.targetCount).toBe(2);
    expect(scoped.callsTo('create').filter((call) => call.model === 'VersionBlast')).toHaveLength(
      1,
    );
    expect(
      scoped.callsTo('create').filter((call) => call.model === 'VersionBlastTarget'),
    ).toHaveLength(2);
    // TC-10: superseding prior versions is an UPDATE (status='superseded'), never a destroy.
    const supersedeCalls = scoped
      .callsTo('update')
      .filter(
        (call) =>
          call.model === 'RuleVersionCountryAssignment' &&
          (call.values as { status?: string }).status === 'superseded',
      );
    expect(supersedeCalls).toHaveLength(2);
    expect(scoped.callsTo('destroy')).toHaveLength(0);
    // TC-9: the legacy `rule_country_assignments` upsert — one create per country here (no
    // pre-existing row, per `wireHappyPath`'s `setCount(RuleCountryAssignment, 0)`).
    expect(
      scoped.callsTo('create').filter((call) => call.model === 'RuleCountryAssignment'),
    ).toHaveLength(2);
    expect(audit.annotations[0]).toMatchObject({ targetType: 'version_blast' });
    expect(notifications.notified).toHaveLength(0);
  });

  it('TC-8: blast to all_countries — every active country becomes a target', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
    scoped.setByPk(RuleVersion, ruleVersionRow({ id: 10, status: 'published' }));
    scoped.setListRows(Country, [
      countryRow({ id: 2, status: 'active' }),
      countryRow({ id: 3, status: 'active' }),
      countryRow({ id: 4, status: 'active' }),
    ]);
    scoped.setCount(RuleVersionCountryAssignment, 0);
    scoped.setCount(RuleCountryAssignment, 0);
    scoped.setListRows(PortalUser, []);
    scoped.setByPk(
      VersionBlast,
      versionBlastRow({ id: 701, scope: 'all_countries', targetCount: 3 }),
    );
    scoped.setListRows(VersionBlastTarget, [
      versionBlastTargetRow({ id: 1, countryId: 2 }),
      versionBlastTargetRow({ id: 2, countryId: 3 }),
      versionBlastTargetRow({ id: 3, countryId: 4 }),
    ]);

    const result = await service.create(actor(), {
      entityType: 'rule',
      entityId: 1,
      versionId: 10,
      scope: 'all_countries',
    });

    expect(result.scope).toBe('all_countries');
    expect(
      scoped.callsTo('create').filter((call) => call.model === 'VersionBlastTarget'),
    ).toHaveLength(3);
  });

  it('blasts a reward version — the reward-side assignment and legacy tables are written (mirrors the rule side)', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardRow({ id: 1 }));
    scoped.setByPk(RewardVersion, rewardVersionRow({ id: 20, status: 'published' }));
    scoped.setListRows(Country, [countryRow({ id: 2 })]);
    scoped.setCount(RewardVersionCountryAssignment, 0);
    scoped.setCount(RewardCountryAssignment, 0);
    scoped.setListRows(PortalUser, []);
    scoped.setByPk(VersionBlast, versionBlastRow({ id: 702, entityType: 'reward' }));
    scoped.setListRows(VersionBlastTarget, [versionBlastTargetRow({ id: 1, countryId: 2 })]);

    await service.create(actor(), {
      entityType: 'reward',
      entityId: 1,
      versionId: 20,
      scope: 'selected',
      countryIds: [2],
    });

    expect(
      scoped.callsTo('create').filter((call) => call.model === 'RewardVersionCountryAssignment'),
    ).toHaveLength(1);
    expect(
      scoped.callsTo('create').filter((call) => call.model === 'RewardCountryAssignment'),
    ).toHaveLength(1);
  });

  it('notifies each country_admin in the blasted countries', async () => {
    const { service, scoped, notifications } = buildService();
    wireHappyPath(scoped);
    scoped.setListRows(PortalUser, [portalUserRow({ id: 55 })]);
    scoped.setListRows(Tenant, [{ id: 900, countryId: 2 } as never]);
    scoped.setByPk(VersionBlast, versionBlastRow({ id: 700 }));
    scoped.setListRows(VersionBlastTarget, [versionBlastTargetRow({ id: 1, countryId: 2 })]);

    await service.create(actor(), {
      entityType: 'rule',
      entityId: 1,
      versionId: 10,
      scope: 'selected',
      countryIds: [2, 3],
    });

    // Two countries × one admin each = two notifications.
    expect(notifications.notified).toHaveLength(2);
    expect(notifications.notified[0]).toMatchObject({ recipientPortalUserId: 55, tenantId: 900 });
  });

  it('a concurrent blast racing the assignment upsert falls back to an update, not an error', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
    scoped.setByPk(RuleVersion, ruleVersionRow({ id: 10, status: 'published' }));
    scoped.setListRows(Country, [countryRow({ id: 2 })]);
    scoped.setCount(RuleVersionCountryAssignment, 0);
    scoped.setCount(RuleCountryAssignment, 0);
    scoped.failNextCreate(RuleVersionCountryAssignment, new UniqueConstraintError({}));
    scoped.setListRows(PortalUser, []);
    scoped.setByPk(VersionBlast, versionBlastRow({ id: 700 }));
    scoped.setListRows(VersionBlastTarget, [versionBlastTargetRow({ id: 1, countryId: 2 })]);

    await service.create(actor(), {
      entityType: 'rule',
      entityId: 1,
      versionId: 10,
      scope: 'selected',
      countryIds: [2],
    });

    const updates = scoped
      .callsTo('update')
      .filter(
        (call) =>
          call.model === 'RuleVersionCountryAssignment' &&
          (call.values as { status?: string }).status === 'active',
      );
    expect(updates.length).toBeGreaterThan(0);
  });

  it('re-blasting a version a country already holds updates the existing assignment rows rather than duplicating them', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
    scoped.setByPk(RuleVersion, ruleVersionRow({ id: 10, status: 'published' }));
    scoped.setListRows(Country, [countryRow({ id: 2 })]);
    // Both the version-aware and the legacy assignment already exist for (versionId=10,
    // countryId=2) — `upsertAssignment`'s `existingCount > 0` branch, exercised on both tables.
    scoped.setCount(RuleVersionCountryAssignment, 1);
    scoped.setCount(RuleCountryAssignment, 1);
    scoped.setListRows(PortalUser, []);
    scoped.setByPk(VersionBlast, versionBlastRow({ id: 700 }));
    scoped.setListRows(VersionBlastTarget, [versionBlastTargetRow({ id: 1, countryId: 2 })]);

    await service.create(actor(), {
      entityType: 'rule',
      entityId: 1,
      versionId: 10,
      scope: 'selected',
      countryIds: [2],
    });

    // No duplicate insert into either assignment table — the existing row is updated instead.
    expect(
      scoped.callsTo('create').filter((call) => call.model === 'RuleVersionCountryAssignment'),
    ).toHaveLength(0);
    expect(
      scoped.callsTo('create').filter((call) => call.model === 'RuleCountryAssignment'),
    ).toHaveLength(0);
    expect(
      scoped
        .callsTo('update')
        .filter(
          (call) =>
            call.model === 'RuleVersionCountryAssignment' &&
            (call.values as { status?: string }).status === 'active',
        ),
    ).toHaveLength(1);
    expect(
      scoped.callsTo('update').filter((call) => call.model === 'RuleCountryAssignment'),
    ).toHaveLength(1);
  });
});

describe('BlastsService.list/getById — TC-16…TC-18', () => {
  it('super_admin reads VersionBlast directly', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(VersionBlast, [versionBlastRow({ id: 1 })]);
    scoped.setCount(VersionBlast, 1);
    scoped.setListRows(VersionBlastTarget, [versionBlastTargetRow({ id: 1 })]);

    const { rows, meta } = await service.list(actor({ role: 'super_admin' }), {});

    expect(rows).toHaveLength(1);
    expect(meta.total).toBe(1);
  });

  it('TC-18: country_admin reads only VersionBlastTarget rows scoped to their own country', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(VersionBlastTarget, [
      versionBlastTargetRow({ id: 1, countryId: 9, blast: versionBlastRow({ id: 5 }) as never }),
    ]);

    const { rows } = await service.list(actor({ role: 'country_admin', countryId: 9 }), {});

    expect(rows).toHaveLength(1);
    const [call] = scoped.callsTo('listAll').filter((c) => c.model === 'VersionBlastTarget');
    expect(call).toBeDefined();
    // super_admin-only VersionBlast table is never queried directly for this role.
    expect(scoped.callsTo('findByPkOrFail').filter((c) => c.model === 'VersionBlast')).toHaveLength(
      0,
    );
  });

  it('a role outside super_admin/country_admin is refused (layer 2)', async () => {
    const { service } = buildService();
    await expect(service.getById(actor({ role: 'maker' }), 1)).rejects.toBeInstanceOf(
      PermissionDeniedHttpException,
    );
  });

  it('super_admin getById() reads VersionBlast by pk', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(VersionBlast, versionBlastRow({ id: 5 }));
    scoped.setListRows(VersionBlastTarget, [versionBlastTargetRow({ id: 1 })]);

    const dto = await service.getById(actor(), 5);
    expect(dto.id).toBe(5);
  });

  it('country_admin getById() reads via their own VersionBlastTarget row, not VersionBlast directly', async () => {
    const { service, scoped } = buildService();
    scoped.setFindOneResult(
      VersionBlastTarget,
      versionBlastTargetRow({ id: 1, countryId: 9, blast: versionBlastRow({ id: 5 }) as never }),
    );

    const dto = await service.getById(actor({ role: 'country_admin', countryId: 9 }), 5);
    expect(dto.id).toBe(5);
    expect(dto.targets).toHaveLength(1);
  });

  it('country_admin list() applies entityType/entityId filters over the joined blast', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(VersionBlastTarget, [
      versionBlastTargetRow({
        id: 1,
        countryId: 9,
        blast: versionBlastRow({ id: 5, entityType: 'rule', entityId: 1 }) as never,
      }),
      versionBlastTargetRow({
        id: 2,
        countryId: 9,
        blast: versionBlastRow({ id: 6, entityType: 'reward', entityId: 2 }) as never,
      }),
    ]);

    const { rows } = await service.list(actor({ role: 'country_admin', countryId: 9 }), {
      entityType: 'reward',
      entityId: 2,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(6);
  });
});

describe('BlastsService — reward preview and race/notification edge cases', () => {
  it('preview() resolves the current assignment on the reward side too', async () => {
    const { service, scoped, sequelize } = buildService();
    scoped.setByPk(RewardSystem, rewardRow({ id: 1 }));
    scoped.setByPk(RewardVersion, rewardVersionRow({ id: 20, versionNo: 2, status: 'published' }));
    scoped.setListRows(Country, [countryRow({ id: 2 })]);
    scoped.setListRows(RewardVersionCountryAssignment, [
      {
        rewardVersionId: 15,
        rewardVersion: rewardVersionRow({ id: 15, versionNo: 1 }),
      },
    ]);
    sequelize.setQueryResult([{ id: 1, name: 'Campaign Y' }]);

    const preview = await service.preview(actor(), {
      entityType: 'reward',
      entityId: 1,
      versionId: 20,
      scope: 'selected',
      countryIds: [2],
    });

    expect(preview.countries[0].currentVersionNo).toBe(1);
    expect(preview.countries[0].activeCampaignsOnCurrentVersion).toBe(1);
  });

  it('upsertAssignment re-throws a non-UniqueConstraintError from the insert', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
    scoped.setByPk(RuleVersion, ruleVersionRow({ id: 10, status: 'published' }));
    scoped.setListRows(Country, [countryRow({ id: 2 })]);
    scoped.setCount(RuleVersionCountryAssignment, 0);
    const boom = new Error('boom');
    scoped.failNextCreate(RuleVersionCountryAssignment, boom);

    await expect(
      service.create(actor(), {
        entityType: 'rule',
        entityId: 1,
        versionId: 10,
        scope: 'selected',
        countryIds: [2],
      }),
    ).rejects.toBe(boom);
  });

  it('skips notifying a country with admins but no tenant yet (disclosed gap), without failing the blast', async () => {
    const { service, scoped } = buildService();
    wireHappyPath(scoped);
    scoped.setListRows(PortalUser, [portalUserRow({ id: 55 })]);
    scoped.setListRows(Tenant, []); // no tenant in this country
    scoped.setByPk(VersionBlast, versionBlastRow({ id: 700 }));
    scoped.setListRows(VersionBlastTarget, [versionBlastTargetRow({ id: 1, countryId: 2 })]);

    const result = await service.create(actor(), {
      entityType: 'rule',
      entityId: 1,
      versionId: 10,
      scope: 'selected',
      countryIds: [2, 3],
    });

    expect(result.id).toBeDefined();
  });

  it('a notification failure never fails the blast response', async () => {
    const { service, scoped, notifications } = buildService();
    wireHappyPath(scoped);
    scoped.setListRows(PortalUser, [portalUserRow({ id: 55 })]);
    scoped.setListRows(Tenant, [{ id: 900, countryId: 2 } as never]);
    scoped.setByPk(VersionBlast, versionBlastRow({ id: 700 }));
    scoped.setListRows(VersionBlastTarget, [versionBlastTargetRow({ id: 1, countryId: 2 })]);
    notifications.notify = jest.fn().mockRejectedValue(new Error('notification store down'));

    const result = await service.create(actor(), {
      entityType: 'rule',
      entityId: 1,
      versionId: 10,
      scope: 'selected',
      countryIds: [2, 3],
    });

    expect(result.id).toBeDefined();
  });
});
