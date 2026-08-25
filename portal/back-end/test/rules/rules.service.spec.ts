/**
 * T-031 — `RulesService` unit tests, against in-memory doubles (`support/rules-doubles.ts`).
 *
 * These prove the *decisions* `RulesService` makes — layer 2 (`assertRole`) firing before any
 * query, `tenant_id = NULL` being explicit rather than inferred, the exact `where` clauses
 * passed to `ScopedRepository` — not that Postgres answers correctly, which is
 * `scope-strategy.ts`/`ScopedRepository`'s own, already-proven job (T-013). The critical
 * cross-layer property (TC-3: a misconfigured permission table cannot override this file's
 * `assertRole`) is proven for real, over HTTP, in `rules.e2e-spec.ts` — a unit test cannot
 * prove a *guard* was bypassable, only that the service's own line is present and first.
 */
import { UniqueConstraintError } from 'sequelize';
import { PermissionDeniedHttpException } from '@/common/rbac/rbac.exceptions';
import {
  Country,
  RuleCategory,
  RuleCountryAssignment,
  RuleMaster,
  RuleSubCategory,
} from '@/database/models';
import { PortalUser } from '@/database/portal-models';
import { RulesService } from '@/modules/rules/rules.service';
import {
  RuleCodeExistsError,
  RuleHasCountryAssignmentsError,
  RuleInUseByCampaignError,
} from '@/modules/rules/rules.errors';
import {
  FakeAuditService,
  FakeScopedRepository,
  FakeSequelize,
  actor,
  asAuditService,
  asScopedRepository,
  asSequelize,
  countryRow,
  portalUserRow,
  ruleCategoryRow,
  ruleCountryAssignmentRow,
  ruleRow,
  ruleSubCategoryRow,
} from './support/rules-doubles';

function buildService() {
  const scoped = new FakeScopedRepository();
  const sequelize = new FakeSequelize();
  const audit = new FakeAuditService();
  // `resolveAdminUserId` reads the actor's own `portal_users` row on every `create`/
  // `assignToCountry` call; a bridge-less actor (`adminUserId: null`) is the default and
  // correct shape for every test that does not care about the bridge specifically.
  scoped.setByPk(PortalUser, portalUserRow());
  const service = new RulesService(
    asSequelize(sequelize),
    asScopedRepository(scoped),
    asAuditService(audit),
  );
  return { service, scoped, sequelize, audit };
}

describe('RulesService — reads', () => {
  it('list() forces tenantId: null and maps rows through toRuleDto', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(RuleMaster, [ruleRow({ id: 7 })]);
    scoped.setCount(RuleMaster, 1);

    const { rows, meta } = await service.list({});

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(7);
    expect(rows[0].categoryName).toBe('TRANSACTION');
    expect(meta).toEqual({ page: 1, pageSize: 20, total: 1 });

    const [call] = scoped.callsTo('listAll');
    expect((call.options as { where: Record<string, unknown> }).where).toMatchObject({
      tenantId: null,
    });
  });

  it('list() applies a status filter and caps pageSize at MAX_PAGE_SIZE', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(RuleMaster, []);
    scoped.setCount(RuleMaster, 0);

    await service.list({ status: 'inactive', pageSize: 500 });

    const [call] = scoped.callsTo('listAll');
    const options = call.options as { where: Record<string, unknown>; limit: number };
    expect(options.where).toMatchObject({ tenantId: null, status: 'inactive' });
    expect(options.limit).toBe(100);
  });

  it('list() honours an explicit sort field/direction', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(RuleMaster, []);
    scoped.setCount(RuleMaster, 0);

    await service.list({ sort: 'ruleCode:desc' });

    const [call] = scoped.callsTo('listAll');
    const options = call.options as { order: unknown };
    expect(options.order).toEqual([['ruleCode', 'DESC']]);
  });

  it('getById() 404s via ScopedRepository when the row is absent or out of scope', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, null);
    await expect(service.getById(999)).rejects.toThrow();
  });

  it('getById() returns the mapped DTO for an in-scope row', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 5, name: 'Found' }));
    const dto = await service.getById(5);
    expect(dto.name).toBe('Found');
  });

  it('getParameters() returns the parsed parameters object', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ parameters: { fields: [{ key: 'x' }] } }));
    const parameters = await service.getParameters(1);
    expect(parameters).toEqual({ fields: [{ key: 'x' }] });
  });

  it('listCountryAssignments() maps assignment rows with their country', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
    scoped.setListRows(RuleCountryAssignment, [
      ruleCountryAssignmentRow({
        ruleId: 1,
        countryId: 2,
        country: countryRow({ id: 2, code: 'SG', name: 'Singapore' }),
      }),
    ]);

    const rows = await service.listCountryAssignments(1);

    expect(rows).toHaveLength(1);
    expect(rows[0].countryCode).toBe('SG');
  });

  it('listCategories()/listSubCategories() route through ScopedRepository, never a raw model call', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(RuleCategory, [ruleCategoryRow()]);
    scoped.setListRows(RuleSubCategory, [ruleSubCategoryRow()]);

    const categories = await service.listCategories();
    const subCategories = await service.listSubCategories(13);

    expect(categories).toHaveLength(1);
    expect(subCategories).toHaveLength(1);
    expect(scoped.callsTo('listAll').map((call) => call.model)).toEqual(
      expect.arrayContaining(['RuleCategory', 'RuleSubCategory']),
    );
    const subCall = scoped.callsTo('listAll').find((call) => call.model === 'RuleSubCategory');
    expect((subCall?.options as { where: Record<string, unknown> }).where).toEqual({
      categoryId: 13,
    });
  });

  it('listSubCategories() with no categoryId lists every sub-category', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(RuleSubCategory, [ruleSubCategoryRow()]);

    await service.listSubCategories(undefined);

    const [call] = scoped.callsTo('listAll');
    expect((call.options as { where: Record<string, unknown> }).where).toEqual({});
  });
});

describe('RulesService.create — layers 2 and 3', () => {
  it('refuses a non-super_admin before any query runs (layer 2)', async () => {
    const { service, scoped } = buildService();
    await expect(
      service.create(actor({ role: 'maker' }), {
        ruleCode: 'X',
        name: 'x',
        subCategoryId: 1,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);

    expect(scoped.calls).toHaveLength(0);
  });

  it('writes tenant_id = NULL explicitly (layer 3), never inferred from the actor', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1000 }));

    await service.create(actor(), {
      ruleCode: 'MIN_SPEND_TIER',
      name: ' Padded ',
      subCategoryId: 13,
    });

    const [call] = scoped.callsTo('create');
    expect((call.values as { tenantId: unknown }).tenantId).toBeNull();
    expect((call.values as { name: string }).name).toBe('Padded');
    expect((call.values as { status: string }).status).toBe('active');
  });

  it('refuses a ruleCode already used by another global rule, checked before the insert (TC-18)', async () => {
    const { service, scoped } = buildService();
    scoped.setCount(RuleMaster, 1);

    await expect(
      service.create(actor(), { ruleCode: 'DUP', name: 'x', subCategoryId: 13 }),
    ).rejects.toBeInstanceOf(RuleCodeExistsError);
    expect(scoped.callsTo('create')).toHaveLength(0);
  });

  it('maps a unique-constraint violation to RuleCodeExistsError (TC-18)', async () => {
    const { service, scoped } = buildService();
    scoped.failNextCreate(RuleMaster, new UniqueConstraintError({}));

    await expect(
      service.create(actor(), { ruleCode: 'DUP', name: 'x', subCategoryId: 13 }),
    ).rejects.toBeInstanceOf(RuleCodeExistsError);
  });

  it('re-throws any other error from the insert untouched', async () => {
    const { service, scoped } = buildService();
    const boom = new Error('boom');
    scoped.failNextCreate(RuleMaster, boom);

    await expect(
      service.create(actor(), { ruleCode: 'X', name: 'x', subCategoryId: 13 }),
    ).rejects.toBe(boom);
  });

  it('annotates the audit draft with the new rule id', async () => {
    const { service, scoped, audit } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 42 }));

    await service.create(actor(), { ruleCode: 'X', name: 'x', subCategoryId: 13 });

    expect(audit.annotations[0]).toMatchObject({ targetId: 1000 });
  });

  // T-074 — reproduced live: creating a rule with no `parameters` wrote a bare `{}`, which
  // `packages/shared/src/rule.schema.ts#ruleParametersSchema` rejects (it requires a `fields`
  // key), breaking the Add-rule dialog and the whole rules list for every viewer despite the
  // 201/200 HTTP responses both genuinely succeeding. The fix writes the schema's own
  // canonical empty value instead of an arbitrary bare object.
  it('writes { fields: [] } — not a bare {} — for an omitted parameters (T-074)', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1000 }));

    await service.create(actor(), { ruleCode: 'NO_PARAMS', name: 'x', subCategoryId: 13 });

    const [call] = scoped.callsTo('create');
    expect((call.values as { parameters: unknown }).parameters).toEqual({ fields: [] });
  });
});

describe('RulesService.update — layers 2 and 3', () => {
  it('refuses a non-super_admin (layer 2)', async () => {
    const { service } = buildService();
    await expect(
      service.update(actor({ role: 'country_admin' }), 1, { name: 'x' }),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });

  it('only writes the fields the caller supplied, never ruleCode, and audits a field diff (TC-19)', async () => {
    const { service, scoped, audit } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1, name: 'Before' }));

    await service.update(actor(), 1, { name: 'After' });

    const [call] = scoped.callsTo('update');
    expect(call.values).toEqual({ name: 'After' });
    expect(audit.diffFieldsCalls).toHaveLength(1);
    expect(audit.annotations[0]?.targetId).toBe(1);
  });

  it('writes every supplied field — subCategoryId, expression, parameters and status alike', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));

    await service.update(actor(), 1, {
      subCategoryId: 99,
      expression: 'x > 1',
      parameters: { fields: [] },
      status: 'inactive',
    });

    const [call] = scoped.callsTo('update');
    expect(call.values).toEqual({
      subCategoryId: 99,
      expression: 'x > 1',
      parameters: { fields: [] },
      status: 'inactive',
    });
  });

  it('skips the UPDATE entirely when nothing changed', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));

    await service.update(actor(), 1, {});

    expect(scoped.callsTo('update')).toHaveLength(0);
  });
});

describe('RulesService.remove — layers 2 and 3, TC-20', () => {
  it('refuses a non-super_admin (layer 2)', async () => {
    const { service } = buildService();
    await expect(service.remove(actor({ role: 'maker' }), 1)).rejects.toBeInstanceOf(
      PermissionDeniedHttpException,
    );
  });

  it('refuses when the rule still holds a country assignment, listing the country ids', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
    scoped.setListRows(RuleCountryAssignment, [
      ruleCountryAssignmentRow({ countryId: 2 }),
      ruleCountryAssignmentRow({ countryId: 3 }),
    ]);

    const error: unknown = await service.remove(actor(), 1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuleHasCountryAssignmentsError);
    expect((error as RuleHasCountryAssignmentsError).details).toEqual([
      { field: 'countryId', code: 'COUNTRY_2' },
      { field: 'countryId', code: 'COUNTRY_3' },
    ]);
    expect(scoped.callsTo('destroy')).toHaveLength(0);
  });

  it('destroys the row when no assignment remains', async () => {
    const { service, scoped, audit } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
    scoped.setListRows(RuleCountryAssignment, []);

    await service.remove(actor(), 1);

    expect(scoped.callsTo('destroy')).toHaveLength(1);
    expect(audit.annotations[0]?.targetId).toBe(1);
  });
});

describe('RulesService.assignToCountry — layers 2 and 3, TC-10/TC-11', () => {
  it('refuses a non-super_admin (layer 2)', async () => {
    const { service } = buildService();
    await expect(
      service.assignToCountry(actor({ role: 'country_admin' }), 1, { countryId: 1 }),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });

  it('writes assignedBy from the actor’s admin_users bridge, never the body/never the raw portal user id (implementation note 6, R3)', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
    scoped.setByPk(Country, countryRow({ id: 2 }));
    // The bridge `resolveAdminUserId` reads — see that method's own comment for why this,
    // and not `actor.userId`, is what a real `fk_rca_admin` accepts.
    scoped.setByPk(PortalUser, portalUserRow({ id: 77, adminUserId: 501 }));
    scoped.setCount(RuleCountryAssignment, 0);
    scoped.setFindOneResult(
      RuleCountryAssignment,
      ruleCountryAssignmentRow({ id: 900, ruleId: 1, countryId: 2 }),
    );

    await service.assignToCountry(actor({ userId: 77 }), 1, { countryId: 2 });

    const [call] = scoped.callsTo('create');
    expect((call.values as { assignedBy: number }).assignedBy).toBe(501);
  });

  it('falls back to assignedBy: null when the actor has no admin_users bridge', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
    scoped.setByPk(Country, countryRow({ id: 2 }));
    scoped.setByPk(PortalUser, portalUserRow({ id: 77, adminUserId: null }));
    scoped.setCount(RuleCountryAssignment, 0);
    scoped.setFindOneResult(
      RuleCountryAssignment,
      ruleCountryAssignmentRow({ id: 900, ruleId: 1, countryId: 2 }),
    );

    await service.assignToCountry(actor({ userId: 77 }), 1, { countryId: 2 });

    const [call] = scoped.callsTo('create');
    expect((call.values as { assignedBy: number | null }).assignedBy).toBeNull();
  });

  it('is idempotent — an existing assignment is returned rather than duplicated (TC-11)', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
    scoped.setByPk(Country, countryRow({ id: 2 }));
    scoped.setCount(RuleCountryAssignment, 1);
    scoped.setFindOneResult(
      RuleCountryAssignment,
      ruleCountryAssignmentRow({ id: 900, ruleId: 1, countryId: 2 }),
    );

    const result = await service.assignToCountry(actor(), 1, { countryId: 2 });

    expect(result.id).toBe(900);
    expect(scoped.callsTo('create')).toHaveLength(0);
  });

  it('a concurrent insert (uq_rule_country_assignments) is treated as a successful assign, not a 409', async () => {
    const { service, scoped, audit } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
    scoped.setByPk(Country, countryRow({ id: 2 }));
    scoped.setCount(RuleCountryAssignment, 0);
    scoped.setFindOneResult(
      RuleCountryAssignment,
      ruleCountryAssignmentRow({ id: 901, ruleId: 1, countryId: 2 }),
    );
    scoped.failNextCreate(RuleCountryAssignment, new UniqueConstraintError({}));

    const result = await service.assignToCountry(actor(), 1, { countryId: 2 });

    expect(result.id).toBe(901);
    expect(audit.annotations[0]?.targetId).toBe(901);
  });

  it('re-throws any other error from the assignment insert untouched', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
    scoped.setByPk(Country, countryRow({ id: 2 }));
    scoped.setCount(RuleCountryAssignment, 0);
    const boom = new Error('boom');
    scoped.failNextCreate(RuleCountryAssignment, boom);

    await expect(service.assignToCountry(actor(), 1, { countryId: 2 })).rejects.toBe(boom);
  });
});

describe('RulesService.unassignFromCountry — layers 2 and 3, TC-12/TC-13', () => {
  it('refuses a non-super_admin (layer 2)', async () => {
    const { service } = buildService();
    await expect(
      service.unassignFromCountry(actor({ role: 'checker' }), 1, 2),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });

  it('refuses when an active campaign is bound to the rule in that country (TC-12)', async () => {
    const { service, scoped, sequelize } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
    scoped.setFindOneResult(
      RuleCountryAssignment,
      ruleCountryAssignmentRow({ id: 900, ruleId: 1, countryId: 2 }),
    );
    sequelize.setQueryResult([{ id: 55, name: 'Raya 2026' }]);

    const error: unknown = await service
      .unassignFromCountry(actor(), 1, 2)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuleInUseByCampaignError);
    expect((error as RuleInUseByCampaignError).details).toEqual([
      { field: 'campaignId', code: 'CAMPAIGN_55' },
    ]);
    expect(scoped.callsTo('destroy')).toHaveLength(0);
  });

  it('destroys the assignment when no campaign is bound (TC-13)', async () => {
    const { service, scoped, sequelize, audit } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
    scoped.setFindOneResult(
      RuleCountryAssignment,
      ruleCountryAssignmentRow({ id: 900, ruleId: 1, countryId: 2 }),
    );
    sequelize.setQueryResult([]);

    await service.unassignFromCountry(actor(), 1, 2);

    expect(scoped.callsTo('destroy')).toHaveLength(1);
    expect(audit.annotations[0]?.targetId).toBe(900);
  });
});
