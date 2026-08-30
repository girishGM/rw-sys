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
import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import { Op, UniqueConstraintError } from 'sequelize';
import { PermissionDeniedHttpException } from '@/common/rbac/rbac.exceptions';
import {
  Country,
  FieldApiLookupProvider,
  FieldContextProvider,
  RuleCategory,
  RuleCountryAssignment,
  RuleMaster,
  RuleResolver,
  RuleSubCategory,
  RuleVersion,
} from '@/database/models';
import { PortalUser } from '@/database/portal-models';
import { RulesService } from '@/modules/rules/rules.service';
import {
  RuleCodeExistsError,
  RuleHasCountryAssignmentsError,
  RuleInUseByCampaignError,
  UnknownFieldValueSourceProviderError,
} from '@/modules/rules/rules.errors';
import { ValidationFailedError } from '@/common/errors/app-error';
import {
  FakeAuditService,
  FakeScopedRepository,
  FakeSequelize,
  actor,
  asAuditService,
  asScopedRepository,
  asSequelize,
  countryRow,
  fieldApiLookupProviderRow,
  fieldContextProviderRow,
  portalUserRow,
  ruleCategoryRow,
  ruleCountryAssignmentRow,
  ruleResolverRow,
  ruleRow,
  ruleSubCategoryRow,
  ruleVersionRow,
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

  it('T-111 TC-2: list() applies subCategoryId as a direct, exact where clause', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(RuleMaster, []);
    scoped.setCount(RuleMaster, 0);

    await service.list({ subCategoryId: 7 });

    const [call] = scoped.callsTo('listAll').filter((c) => c.model === 'RuleMaster');
    const options = call.options as { where: Record<string, unknown> };
    expect(options.where).toMatchObject({ tenantId: null, subCategoryId: 7 });
  });

  it('T-111 TC-1: list() resolves categoryId to the sub-category ids under it', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(RuleMaster, []);
    scoped.setCount(RuleMaster, 0);
    scoped.setListRows(RuleSubCategory, [
      ruleSubCategoryRow({ id: 11 }),
      ruleSubCategoryRow({ id: 12 }),
    ]);

    await service.list({ categoryId: 5 });

    const subCategoryCall = scoped.callsTo('listAll').find((c) => c.model === 'RuleSubCategory');
    expect((subCategoryCall?.options as { where: Record<string, unknown> }).where).toEqual({
      categoryId: 5,
    });

    const ruleCall = scoped.callsTo('listAll').find((c) => c.model === 'RuleMaster');
    const options = ruleCall?.options as { where: Record<string, unknown> };
    expect(options.where['subCategoryId']).toEqual({ [Op.in]: [11, 12] });
  });

  it('T-111: list() with categoryId and no matching sub-categories yields Op.in: []', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(RuleMaster, []);
    scoped.setCount(RuleMaster, 0);
    scoped.setListRows(RuleSubCategory, []);

    await service.list({ categoryId: 999 });

    const ruleCall = scoped.callsTo('listAll').find((c) => c.model === 'RuleMaster');
    const options = ruleCall?.options as { where: Record<string, unknown> };
    expect(options.where['subCategoryId']).toEqual({ [Op.in]: [] });
  });

  it('T-111: an exact subCategoryId wins over categoryId when both are supplied', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(RuleMaster, []);
    scoped.setCount(RuleMaster, 0);

    await service.list({ categoryId: 5, subCategoryId: 7 });

    expect(scoped.callsTo('listAll').some((c) => c.model === 'RuleSubCategory')).toBe(false);
    const ruleCall = scoped.callsTo('listAll').find((c) => c.model === 'RuleMaster');
    const options = ruleCall?.options as { where: Record<string, unknown> };
    expect(options.where).toMatchObject({ subCategoryId: 7 });
  });

  it('T-111 TC-3: list() matches search case-insensitively against ruleCode/name', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(RuleMaster, []);
    scoped.setCount(RuleMaster, 0);

    await service.list({ search: 'SCAN' });

    const ruleCall = scoped.callsTo('listAll').find((c) => c.model === 'RuleMaster');
    const options = ruleCall?.options as { where: Record<string, unknown> };
    expect(options.where[Op.or as unknown as string]).toEqual([
      { ruleCode: { [Op.iLike]: '%SCAN%' } },
      { name: { [Op.iLike]: '%SCAN%' } },
    ]);
  });

  it('T-111: a blank search string is treated as absent', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(RuleMaster, []);
    scoped.setCount(RuleMaster, 0);

    await service.list({ search: '   ' });

    const ruleCall = scoped.callsTo('listAll').find((c) => c.model === 'RuleMaster');
    const options = ruleCall?.options as { where: Record<string, unknown> };
    expect(options.where[Op.or as unknown as string]).toBeUndefined();
  });

  it('T-111 TC-4: combines categoryId and search — both apply together (AND)', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(RuleMaster, []);
    scoped.setCount(RuleMaster, 0);
    scoped.setListRows(RuleSubCategory, [ruleSubCategoryRow({ id: 11 })]);

    await service.list({ categoryId: 5, search: 'SCAN' });

    const ruleCall = scoped.callsTo('listAll').find((c) => c.model === 'RuleMaster');
    const options = ruleCall?.options as { where: Record<string, unknown> };
    expect(options.where['subCategoryId']).toEqual({ [Op.in]: [11] });
    expect(options.where[Op.or as unknown as string]).toEqual([
      { ruleCode: { [Op.iLike]: '%SCAN%' } },
      { name: { [Op.iLike]: '%SCAN%' } },
    ]);
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

  it('getParameters() returns the parsed parameters object, role-annotated (T-114)', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ parameters: { fields: [{ key: 'x' }] } }));
    // No `RuleVersion` row configured — the default, unwired case: every field is
    // `compare_value` (T-114 TC-4).
    const parameters = await service.getParameters(1);
    expect(parameters).toEqual({ fields: [{ key: 'x', role: 'compare_value' }] });
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

/**
 * T-114 — `13-REWARD-MASTER-VALUE-SOURCES.md` §2: a parameter field's response-only `role` is
 * computed from the rule's latest version's wired resolver, never client-supplied. These prove
 * the *decision* (`resolveInputFieldKeysByRule`'s own reads and how it's consumed) the same way
 * every other describe block in this file does — the write-schema `.strict()` rejection (T-114
 * TC-6) is a `packages/shared/src/rule.schema.spec.ts` concern, not this service's.
 */
describe('RulesService — T-114 parameter-field role', () => {
  it('TC-1/TC-2: a field named in the wired resolver’s resolverInputFieldKeys is resolver_input, every other field is compare_value', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(
      RuleMaster,
      ruleRow({
        id: 1,
        parameters: {
          fields: [
            { key: 'targetComponentCode', label: 'Sibling', type: 'string', required: true },
            {
              key: 'value',
              label: 'Expected Status',
              type: 'select',
              required: true,
              options: ['A'],
            },
          ],
        },
      }),
    );
    scoped.setListRows(RuleVersion, [ruleVersionRow({ ruleId: 1, versionNo: 1, resolverId: 1 })]);
    scoped.setListRows(RuleResolver, [
      ruleResolverRow({ id: 1, resolverInputFieldKeys: ['targetComponentCode'] }),
    ]);

    const dto = await service.getById(1);

    const fields = (dto.parameters as { fields: Array<{ key: string; role: string }> }).fields;
    expect(fields.find((f) => f.key === 'targetComponentCode')?.role).toBe('resolver_input');
    expect(fields.find((f) => f.key === 'value')?.role).toBe('compare_value');
  });

  it('TC-3: a rule wired to a resolver with no resolverInputFieldKeys — every field is compare_value', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(
      RuleMaster,
      ruleRow({
        id: 1,
        parameters: { fields: [{ key: 'value', label: 'v', type: 'string', required: true }] },
      }),
    );
    scoped.setListRows(RuleVersion, [ruleVersionRow({ ruleId: 1, versionNo: 1, resolverId: 2 })]);
    scoped.setListRows(RuleResolver, [
      ruleResolverRow({ id: 2, resolverCode: 'JSONPATH_PAYLOAD', resolverInputFieldKeys: [] }),
    ]);

    const dto = await service.getById(1);

    const fields = (dto.parameters as { fields: Array<{ key: string; role: string }> }).fields;
    expect(fields[0]?.role).toBe('compare_value');
  });

  it('TC-4: a rule with no version at all, or a version with resolverId: null, is unwired — every field is compare_value, no error', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(
      RuleMaster,
      ruleRow({
        id: 1,
        parameters: { fields: [{ key: 'value', label: 'v', type: 'string', required: true }] },
      }),
    );
    // No `RuleVersion` rows configured at all — the "rule has no version" case.

    const dto = await service.getById(1);
    const fields = (dto.parameters as { fields: Array<{ key: string; role: string }> }).fields;
    expect(fields[0]?.role).toBe('compare_value');

    // The version exists but is explicitly not wired to a resolver.
    scoped.setListRows(RuleVersion, [
      ruleVersionRow({ ruleId: 1, versionNo: 1, resolverId: null }),
    ]);
    const dtoUnwired = await service.getById(1);
    const fieldsUnwired = (
      dtoUnwired.parameters as { fields: Array<{ key: string; role: string }> }
    ).fields;
    expect(fieldsUnwired[0]?.role).toBe('compare_value');
  });

  it('uses the latest version (highest versionNo), not just any version, to pick the resolver', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(
      RuleMaster,
      ruleRow({
        id: 1,
        parameters: {
          fields: [{ key: 'targetComponentCode', label: 'x', type: 'string', required: true }],
        },
      }),
    );
    // v1 wired to a no-input resolver, v2 (the latest) wired to TRACKER_STATE_LOOKUP — the
    // resolver v2 is wired to must be the one that decides role, not v1's. `FakeScopedRepository`
    // (unlike the real `ScopedRepository`/Postgres) does not apply `order`, so these are supplied
    // already in the `versionNo DESC` shape the real `ORDER BY` clause guarantees — the
    // production code trusts that order rather than re-sorting, exactly as `list()`'s own
    // `SORT_COLUMN`-driven queries do throughout this file.
    scoped.setListRows(RuleVersion, [
      ruleVersionRow({ id: 11, ruleId: 1, versionNo: 2, resolverId: 1 }),
      ruleVersionRow({ id: 10, ruleId: 1, versionNo: 1, resolverId: 2 }),
    ]);
    scoped.setListRows(RuleResolver, [
      ruleResolverRow({ id: 1, resolverInputFieldKeys: ['targetComponentCode'] }),
      ruleResolverRow({ id: 2, resolverCode: 'JSONPATH_PAYLOAD', resolverInputFieldKeys: [] }),
    ]);

    const dto = await service.getById(1);
    const fields = (dto.parameters as { fields: Array<{ key: string; role: string }> }).fields;
    expect(fields[0]?.role).toBe('resolver_input');
  });

  it('list() annotates every row’s role too, not just getById()', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(RuleMaster, [
      ruleRow({
        id: 1,
        parameters: {
          fields: [{ key: 'targetComponentCode', label: 'x', type: 'string', required: true }],
        },
      }),
    ]);
    scoped.setCount(RuleMaster, 1);
    scoped.setListRows(RuleVersion, [ruleVersionRow({ ruleId: 1, versionNo: 1, resolverId: 1 })]);
    scoped.setListRows(RuleResolver, [
      ruleResolverRow({ id: 1, resolverInputFieldKeys: ['targetComponentCode'] }),
    ]);

    const { rows } = await service.list({});

    const fields = (rows[0].parameters as { fields: Array<{ key: string; role: string }> }).fields;
    expect(fields[0]?.role).toBe('resolver_input');
  });

  it('a freshly created rule (no version row yet) reports every field as compare_value', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(
      RuleMaster,
      ruleRow({
        id: 1000,
        parameters: { fields: [{ key: 'value', label: 'v', type: 'string', required: true }] },
      }),
    );

    const dto = await service.create(actor(), { ruleCode: 'X', name: 'x', subCategoryId: 13 });

    const fields = (dto.parameters as { fields: Array<{ key: string; role: string }> }).fields;
    expect(fields[0]?.role).toBe('compare_value');
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

/**
 * T-122 — `13-REWARD-MASTER-VALUE-SOURCES.md` §3: a parameter field's `valueSource` must name a
 * provider that exists in the matching registry.
 *
 * The *shape* of a `valueSource` is `rule.schema.ts`'s job and is proven there; what only the
 * service can decide is **existence**, which is a live registry read. TC-5's "a `planned` provider
 * is still accepted" is proven for real against the seeded registries in
 * `rule-value-source.e2e-spec.ts` — these doubles ignore a `where` clause, so a status filter
 * wrongly added to the query could not be caught here by outcome alone; the assertion on the
 * recorded query below is the unit-level half of that, and the e2e is the half that would actually
 * fail if the filter were added.
 */
describe('RulesService — T-122 value-source provider validation', () => {
  const CONTEXT_FIELD = {
    key: 'targetComponentCode',
    label: 'Target component',
    type: 'select',
    required: true,
    valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: 'SIBLING_COMPONENTS' },
  };
  const API_FIELD = {
    key: 'productId',
    label: 'Product',
    type: 'select',
    required: true,
    valueSource: { kind: 'API_LOOKUP', apiProvider: 'PRODUCT_CATALOG' },
  };

  function createDto(fields: unknown[]) {
    return {
      ruleCode: 'RULE_VS',
      name: 'Value sourced',
      subCategoryId: 13,
      parameters: { fields },
    };
  }

  it('TC-2: accepts a CONTEXT_LOOKUP field whose provider exists', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1000 }));
    scoped.setListRows(FieldContextProvider, [fieldContextProviderRow()]);

    await expect(service.create(actor(), createDto([CONTEXT_FIELD]))).resolves.toBeDefined();
    expect(scoped.callsTo('create')).toHaveLength(1);
  });

  it('TC-4: rejects an unknown context provider with a 400 — and writes nothing', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1000 }));
    // No rows registered for the model → the code is unknown, as far as the registry is concerned.

    const error = await service
      .create(
        actor(),
        createDto([
          {
            ...CONTEXT_FIELD,
            valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: 'NO_SUCH_PROVIDER' },
          },
        ]),
      )
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnknownFieldValueSourceProviderError);
    expect((error as UnknownFieldValueSourceProviderError).status).toBe(400);
    expect((error as UnknownFieldValueSourceProviderError).details).toEqual([
      { field: 'parameters.targetComponentCode', code: 'PROVIDER_NO_SUCH_PROVIDER' },
    ]);
    expect(scoped.callsTo('create')).toHaveLength(0);
  });

  it('TC-4: rejects an unknown api provider too', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1000 }));

    await expect(service.create(actor(), createDto([API_FIELD]))).rejects.toBeInstanceOf(
      UnknownFieldValueSourceProviderError,
    );
    expect(scoped.callsTo('create')).toHaveLength(0);
  });

  it('TC-5: accepts a provider whose status is planned — authoring is not blocked on it', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1000 }));
    scoped.setListRows(FieldApiLookupProvider, [fieldApiLookupProviderRow({ status: 'planned' })]);

    await expect(service.create(actor(), createDto([API_FIELD]))).resolves.toBeDefined();
  });

  it('TC-5: the registry lookup filters on providerCode only — never on status', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1000 }));
    scoped.setListRows(FieldApiLookupProvider, [fieldApiLookupProviderRow()]);

    await service.create(actor(), createDto([API_FIELD]));

    const [lookup] = scoped
      .callsTo('listAll')
      .filter((call) => call.model === FieldApiLookupProvider.name);
    expect((lookup.options as { where: Record<string, unknown> }).where).toEqual({
      providerCode: ['PRODUCT_CATALOG'],
    });
  });

  it('validates before the duplicate-ruleCode check — a bad provider costs no extra query', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1000 }));

    await expect(service.create(actor(), createDto([CONTEXT_FIELD]))).rejects.toBeInstanceOf(
      UnknownFieldValueSourceProviderError,
    );
    expect(scoped.callsTo('count')).toHaveLength(0);
  });

  it('reads each registry at most once, however many fields reference it', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1000 }));
    scoped.setListRows(FieldContextProvider, [fieldContextProviderRow()]);

    await service.create(
      actor(),
      createDto([
        CONTEXT_FIELD,
        { ...CONTEXT_FIELD, key: 'otherComponentCode' },
        { ...CONTEXT_FIELD, key: 'thirdComponentCode' },
      ]),
    );

    expect(
      scoped.callsTo('listAll').filter((call) => call.model === FieldContextProvider.name),
    ).toHaveLength(1);
  });

  it('queries only the registry a field actually references', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1000 }));
    scoped.setListRows(FieldContextProvider, [fieldContextProviderRow()]);

    await service.create(actor(), createDto([CONTEXT_FIELD]));

    expect(
      scoped.callsTo('listAll').filter((call) => call.model === FieldApiLookupProvider.name),
    ).toHaveLength(0);
  });

  it('TC-1: a plain select field with options triggers no registry read at all', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1000 }));

    await service.create(
      actor(),
      createDto([
        { key: 'tier', label: 'Tier', type: 'select', required: true, options: ['gold'] },
      ]),
    );

    const registryReads = scoped
      .callsTo('listAll')
      .filter(
        (call) =>
          call.model === FieldContextProvider.name || call.model === FieldApiLookupProvider.name,
      );
    expect(registryReads).toHaveLength(0);
    expect(scoped.callsTo('create')).toHaveLength(1);
  });

  it('omitted parameters need no registry read (create)', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1000 }));

    await service.create(actor(), { ruleCode: 'RULE_VS', name: 'x', subCategoryId: 13 });

    expect(
      scoped.callsTo('listAll').filter((call) => call.model === FieldContextProvider.name),
    ).toHaveLength(0);
  });

  it('rejects parameters that never passed the shared meta-schema (defence in depth)', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RuleMaster, ruleRow({ id: 1000 }));

    // What an in-process caller bypassing the ValidationPipe could otherwise smuggle past the
    // provider check: a `fields` array the meta-schema would have rejected outright.
    await expect(
      service.create(actor(), createDto([{ key: 'x', type: 'select', required: true }])),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    expect(scoped.callsTo('create')).toHaveLength(0);
  });

  describe('update is gated identically', () => {
    it('TC-4: PATCH with an unknown provider is refused and nothing is written', async () => {
      const { service, scoped } = buildService();
      scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));

      await expect(
        service.update(actor(), 1, { parameters: { fields: [CONTEXT_FIELD] } }),
      ).rejects.toBeInstanceOf(UnknownFieldValueSourceProviderError);
      expect(scoped.callsTo('update')).toHaveLength(0);
    });

    it('TC-2: PATCH with a known provider proceeds to the update', async () => {
      const { service, scoped } = buildService();
      scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));
      scoped.setListRows(FieldContextProvider, [fieldContextProviderRow()]);

      await service.update(actor(), 1, { parameters: { fields: [CONTEXT_FIELD] } });

      expect(scoped.callsTo('update')).toHaveLength(1);
    });

    it('refuses a non-super_admin before the registry is read at all (layer 2 stays first)', async () => {
      const { service, scoped } = buildService();

      await expect(
        service.update(actor({ role: 'maker' }), 1, { parameters: { fields: [CONTEXT_FIELD] } }),
      ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
      expect(scoped.calls).toHaveLength(0);
    });

    it('a PATCH that does not touch parameters reads no registry', async () => {
      const { service, scoped } = buildService();
      scoped.setByPk(RuleMaster, ruleRow({ id: 1 }));

      await service.update(actor(), 1, { name: 'Renamed' });

      expect(
        scoped.callsTo('listAll').filter((call) => call.model === FieldContextProvider.name),
      ).toHaveLength(0);
    });
  });

  // T-134 regression — filed after a `prettier/prettier` formatting drift in this exact file
  // (the TC-1 fixture a few hundred lines up) reached `npm run lint -- --max-warnings=0` and
  // broke a completely unrelated, front-end-only task (T-120) that happened to trip the
  // workspace-wide lint gate first. By the time T-134 picked this up the formatting had already
  // been corrected by other in-flight work on this file (T-114/T-122 territory) — the defect no
  // longer reproduced. This test is the regression guard T-134's own task file requires: it lints
  // this file *on disk*, through the project's real `.eslintrc.cjs` (the same config `npm run
  // lint` uses), and asserts zero `prettier/prettier` messages, so a future formatting drift here
  // fails `npm test` too, not only the separate `npm run lint` gate.
  //
  // Proven to fail on the unfixed code: reverting the TC-1 fixture at line ~897 to the single-line
  // form reported in T-134's evidence (`{ key: 'tier', label: 'Tier', type: 'select', required:
  // true, options: ['gold'] }` on one line) makes this test fail with exactly one
  // `prettier/prettier` message pointing at that line; restoring the wrapped form makes it pass
  // again.
  describe('T-134 — stays prettier-clean on disk', () => {
    it('lints with zero prettier/prettier messages', async () => {
      const backEndRoot = resolve(__dirname, '..', '..');
      const eslint = new ESLint({ cwd: backEndRoot });

      const [result] = await eslint.lintFiles(['test/rules/rules.service.spec.ts']);
      const prettierMessages = result.messages.filter(
        (message) => message.ruleId === 'prettier/prettier',
      );

      expect(prettierMessages).toEqual([]);
    });
  });
});
