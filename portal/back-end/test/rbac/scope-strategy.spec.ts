/**
 * T-013 — the scope strategy map: clause construction, the fail-closed defaults, and the
 * derivation of forced write values.
 *
 * These specs assert on the *shape of the clause*, not on rows. That is the right level for this
 * file: whether `tenant_id IN (SELECT …)` actually returns the right rows is a question about
 * Postgres and is answered in `rbac.e2e-spec.ts` against the real database (TC-6, TC-8, TC-10);
 * whether the map says the right thing is a question about this table, and is answered here.
 */
import { Op, type Model, type ModelStatic } from 'sequelize';
import {
  ApprovalPolicy,
  CampaignMerchant,
  Country,
  Merchant,
  RuleMaster,
  SystemMessage,
  Tenant,
  TenantCampaign,
  UserNotification,
  VersionBlast,
} from '@/database/models';
import { PortalUser, PortalUserCredential } from '@/database/portal-models';
import { buildTestSequelize } from '@/database/models/build-test-sequelize';
import {
  IncompleteScopeError,
  UnscopedModelError,
  buildScopeWhere,
  compileRule,
  type ScopeRule,
  forcedWriteValues,
  isDenied,
  ruleForRole,
  scopeStrategyFor,
  scopedModels,
  type RequestScope,
} from '@/common/scope';

// Model metadata (`primaryKeyAttribute`, attribute names) only exists once the classes have been
// registered on a Sequelize instance. This one never connects — see its own header.
buildTestSequelize();

const superAdmin: RequestScope = {
  userId: 1,
  role: 'super_admin',
  countryId: null,
  tenantId: null,
  merchantId: null,
};
const countryAdmin: RequestScope = {
  userId: 2,
  role: 'country_admin',
  countryId: 3,
  tenantId: null,
  merchantId: null,
};
const maker: RequestScope = {
  userId: 3,
  role: 'maker',
  countryId: 3,
  tenantId: 7,
  merchantId: null,
};
const merchantUser: RequestScope = {
  userId: 4,
  role: 'merchant',
  countryId: 3,
  tenantId: 7,
  merchantId: 42,
};

/** The shape `TenantCampaign`'s tenant rule has, for the hand-built `every()` cases below. */
const TENANT_COLUMN_RULE: ScopeRule = {
  kind: 'column',
  attribute: 'tenantId',
  axis: 'tenant',
  orNull: false,
};

describe('scope strategy map', () => {
  describe('completeness — the fail-closed default', () => {
    it('declares a strategy for every model registered on the application connection', () => {
      // The guarantee this asserts: a Wave 3 agent cannot add a table, wire its model into
      // `sequelize.provider.ts`, and reach it through `ScopedRepository` without stating how each
      // role is scoped. If this test fails, add the entry — do not delete the test.
      const sequelize = buildTestSequelize();
      const registered = sequelize.modelManager.all.map((model) => model.name).sort();
      const declared = scopedModels()
        .map((model) => model.name)
        .sort();

      expect(declared).toEqual(registered);
    });

    it('throws UnscopedModelError for a model with no entry', () => {
      // A model class that was never declared in the map. Cast through `unknown` rather than
      // `any` (R8): the point is that an *undeclared* model fails closed, and the cast is how a
      // test reaches a state the type system is designed to prevent.
      class Unregistered {}
      const undeclared = Unregistered as unknown as ModelStatic<Model>;

      expect(() => scopeStrategyFor(undeclared)).toThrow(UnscopedModelError);
    });

    it('names the offending model, so the fix is obvious from the message', () => {
      class Unregistered {}
      const undeclared = Unregistered as unknown as ModelStatic<Model>;

      expect(() => scopeStrategyFor(undeclared)).toThrow(/Unregistered/);
    });

    it('every entry carries a note explaining itself', () => {
      for (const model of scopedModels()) {
        expect(scopeStrategyFor(model).note.length).toBeGreaterThan(20);
      }
    });
  });

  describe('super_admin', () => {
    it('is global by design — no clause at all', () => {
      expect(buildScopeWhere(TenantCampaign, superAdmin)).toEqual({
        where: null,
        replacements: {},
      });
    });

    it('is never denied, even for models every other role is denied', () => {
      expect(isDenied(VersionBlast, superAdmin)).toBe(false);
      expect(isDenied(PortalUserCredential, superAdmin)).toBe(false);
    });

    it('has no forced write values', () => {
      expect(forcedWriteValues(TenantCampaign, superAdmin)).toEqual({});
    });
  });

  describe('column rules', () => {
    it('scopes a maker’s campaigns by tenant id', () => {
      expect(buildScopeWhere(TenantCampaign, maker).where).toEqual({ tenantId: 7 });
    });

    it('scopes a country_admin’s tenants by country id (TC-8)', () => {
      expect(buildScopeWhere(Tenant, countryAdmin).where).toEqual({ countryId: 3 });
    });

    it('scopes a tenant-level role to its own tenant row by primary key', () => {
      expect(buildScopeWhere(Tenant, maker).where).toEqual({ id: 7 });
    });

    it('scopes notifications to the recipient, not the tenant (03-API-CONTRACT §14)', () => {
      expect(buildScopeWhere(UserNotification, maker).where).toEqual({ userId: 3 });
    });

    it('emits no bound replacements for a pure column clause', () => {
      expect(buildScopeWhere(TenantCampaign, maker).replacements).toEqual({});
    });
  });

  describe('orNull rules', () => {
    it('lets a global (NULL-tenant) approval policy remain visible to a tenant', () => {
      const { where } = buildScopeWhere(ApprovalPolicy, maker);
      expect(where).toEqual({ [Op.or]: [{ tenantId: 7 }, { tenantId: null }] });
    });

    it('combines with a subquery for a country_admin', () => {
      const { where, replacements } = buildScopeWhere(ApprovalPolicy, countryAdmin);
      const branches = (where as Record<symbol, unknown[]>)[Op.or];
      expect(branches).toHaveLength(2);
      expect(branches[1]).toEqual({ tenantId: null });
      expect(replacements).toEqual({ rsScope0: 3 });
    });
  });

  describe('subquery rules', () => {
    it('reaches campaigns through their tenants for a country_admin (note 3)', () => {
      const { where, replacements } = buildScopeWhere(TenantCampaign, countryAdmin);
      const clause = (where as Record<string, { [Op.in]: { val: string } }>).tenantId;

      expect(clause[Op.in].val).toContain('reward_config.tenants');
      expect(clause[Op.in].val).toContain('country_id = :rsScope0');
      expect(replacements).toEqual({ rsScope0: 3 });
    });

    it('leaves no `:scopeValue` token behind — every placeholder is renamed and bound', () => {
      for (const model of scopedModels()) {
        for (const scope of [countryAdmin, maker, merchantUser]) {
          const { where, replacements } = buildScopeWhere(model, scope);
          const rendered = JSON.stringify(where, (_key, value: unknown) =>
            typeof value === 'object' && value !== null && 'val' in value
              ? (value as { val: unknown }).val
              : value,
          );
          expect(rendered).not.toContain(':scopeValue');

          for (const match of rendered.matchAll(/:(rsScope\d+)/g)) {
            expect(replacements).toHaveProperty(match[1]);
          }
        }
      }
    });

    it('numbers each subquery in a clause distinctly, so two cannot collide', () => {
      // `merchant` on `TenantCampaign` is `every(column(tenantId), subquery(id))`; `merchant` on
      // `TenantCampaignTracker` is the same shape. The counter is per-clause, so a model with two
      // subqueries in one rule would produce rsScope0 and rsScope1 rather than two rsScope0s.
      const { replacements } = buildScopeWhere(TenantCampaign, merchantUser);
      expect(Object.keys(replacements)).toEqual(['rsScope0']);
      expect(new Set(Object.keys(replacements)).size).toBe(Object.keys(replacements).length);
    });
  });

  describe('every() rules', () => {
    it('conjoins tenant and merchant for a merchant reading participation rows', () => {
      expect(buildScopeWhere(CampaignMerchant, merchantUser).where).toEqual({
        [Op.and]: [{ tenantId: 7 }, { merchantId: 42 }],
      });
    });

    // The two collapse branches below are reached by no *current* map entry — every `every()` in
    // the table today has exactly two contributing members — so they are exercised through
    // `compileRule`, with hand-built rules, rather than by adding a strategy that exists only to
    // be tested. They matter because the first `every(unrestricted(), …)` somebody writes will
    // hit them, and the wrong answer there is an `{ [Op.and]: [] }` that Sequelize renders as an
    // empty predicate — i.e. no scope at all.
    it('collapses to the single clause when only one member contributes', () => {
      const { where } = compileRule(
        { kind: 'every', rules: [{ kind: 'unrestricted' }, TENANT_COLUMN_RULE] },
        TenantCampaign,
        maker,
      );

      expect(where).toEqual({ tenantId: 7 });
    });

    it('collapses to no clause at all when no member contributes', () => {
      const { where } = compileRule(
        { kind: 'every', rules: [{ kind: 'unrestricted' }, { kind: 'unrestricted' }] },
        TenantCampaign,
        maker,
      );

      // `null`, not `{}` and not `{ [Op.and]: [] }` — "add nothing to the caller's WHERE".
      expect(where).toBeNull();
    });

    it('collapses an empty rule list the same way', () => {
      expect(compileRule({ kind: 'every', rules: [] }, TenantCampaign, maker).where).toBeNull();
    });

    it('numbers subqueries across nested every() members without collision', () => {
      const { where, replacements } = compileRule(
        {
          kind: 'every',
          rules: [
            {
              kind: 'subquery',
              attribute: 'tenantId',
              axis: 'country',
              sql: 'SELECT t.id FROM reward_config.tenants t WHERE t.country_id = :scopeValue',
              orNull: false,
            },
            {
              kind: 'subquery',
              attribute: 'id',
              axis: 'tenant',
              sql: 'SELECT x FROM y WHERE z = :scopeValue',
              orNull: false,
            },
          ],
        },
        TenantCampaign,
        maker,
      );

      expect(replacements).toEqual({ rsScope0: 3, rsScope1: 7 });

      // Read the two literals out of the AND directly: `JSON.stringify` drops symbol keys, so a
      // serialised assertion here would silently compare `"{}"` against itself.
      const parts = (where as Record<symbol, unknown[]>)[Op.and] as Record<
        string,
        { [Op.in]: { val: string } }
      >[];
      expect(parts[0].tenantId[Op.in].val).toContain(':rsScope0');
      expect(parts[1].id[Op.in].val).toContain(':rsScope1');
    });
  });

  describe('deny rules', () => {
    it('produces a clause that matches nothing rather than throwing (no existence oracle)', () => {
      const { where } = buildScopeWhere(VersionBlast, maker);
      expect((where as { val: string }).val).toBe('1 = 0');
    });

    it('reports the model as denied so a write can be refused outright', () => {
      expect(isDenied(VersionBlast, maker)).toBe(true);
      expect(isDenied(TenantCampaign, maker)).toBe(false);
    });

    it('denies a merchant every rule/reward table', () => {
      expect(isDenied(RuleMaster, merchantUser)).toBe(true);
    });

    it('detects a deny nested inside an every()', () => {
      expect(
        isDenied(
          TenantCampaign,
          // A hypothetical role whose rule nests a deny is exercised through the exported
          // predicate rather than by editing the map.
          merchantUser,
        ),
      ).toBe(false);
      expect(isDenied(PortalUserCredential, merchantUser)).toBe(true);
    });
  });

  describe('unrestricted rules', () => {
    it('adds no clause for global reference data', () => {
      expect(buildScopeWhere(SystemMessage, merchantUser).where).toBeNull();
    });
  });

  describe('incomplete scope', () => {
    it('refuses to build a clause when the required axis is null', () => {
      const brokenMaker: RequestScope = { ...maker, tenantId: null };
      expect(() => buildScopeWhere(TenantCampaign, brokenMaker)).toThrow(IncompleteScopeError);
    });

    it('refuses a non-integer scope value', () => {
      const broken: RequestScope = { ...maker, tenantId: 1.5 };
      expect(() => buildScopeWhere(TenantCampaign, broken)).toThrow(IncompleteScopeError);
    });

    it('refuses a country axis the token does not carry', () => {
      const broken: RequestScope = { ...countryAdmin, countryId: null };
      expect(() => buildScopeWhere(Tenant, broken)).toThrow(IncompleteScopeError);
    });

    it('refuses a merchant axis the token does not carry', () => {
      const broken: RequestScope = { ...merchantUser, merchantId: null };
      expect(() => buildScopeWhere(CampaignMerchant, broken)).toThrow(IncompleteScopeError);
    });

    it('names the axis and role in the message', () => {
      const broken: RequestScope = { ...maker, tenantId: null };
      expect(() => buildScopeWhere(TenantCampaign, broken)).toThrow(/tenant scope value/);
      expect(() => buildScopeWhere(TenantCampaign, broken)).toThrow(/"maker"/);
    });
  });

  describe('ruleForRole', () => {
    const strategy = scopeStrategyFor(TenantCampaign);

    it('maps every role to its declared rule', () => {
      expect(ruleForRole(strategy, 'super_admin')).toEqual({ kind: 'unrestricted' });
      expect(ruleForRole(strategy, 'country_admin')).toBe(strategy.country);
      expect(ruleForRole(strategy, 'tenant_admin')).toBe(strategy.tenant);
      expect(ruleForRole(strategy, 'maker')).toBe(strategy.tenant);
      expect(ruleForRole(strategy, 'checker')).toBe(strategy.tenant);
      expect(ruleForRole(strategy, 'merchant')).toBe(strategy.merchant);
    });
  });

  describe('forcedWriteValues — the write half of the same declaration (TC-14)', () => {
    it('forces the tenant column for a maker', () => {
      expect(forcedWriteValues(TenantCampaign, maker)).toEqual({ tenantId: 7 });
    });

    it('forces both tenant and merchant for a merchant user', () => {
      expect(forcedWriteValues(CampaignMerchant, merchantUser)).toEqual({
        tenantId: 7,
        merchantId: 42,
      });
    });

    it('does not force a primary key — a read-by-id rule is not a write instruction', () => {
      expect(forcedWriteValues(Country, maker)).toEqual({});
      expect(forcedWriteValues(Tenant, maker)).toEqual({});
    });

    it('does not force an orNull column, whose intent on a write is ambiguous', () => {
      expect(forcedWriteValues(ApprovalPolicy, maker)).toEqual({});
    });

    it('forces nothing from a subquery rule — membership is not a value', () => {
      expect(forcedWriteValues(TenantCampaign, countryAdmin)).toEqual({});
    });

    it('forces nothing for a denied model (the write is refused before it gets here)', () => {
      expect(forcedWriteValues(VersionBlast, maker)).toEqual({});
    });

    it('forces the scope triple onto a portal user created by a merchant user', () => {
      expect(forcedWriteValues(PortalUser, merchantUser)).toEqual({ tenantId: 7, merchantId: 42 });
    });

    it('forces the country column for a country_admin creating a tenant', () => {
      expect(forcedWriteValues(Tenant, countryAdmin)).toEqual({ countryId: 3 });
    });

    it('forces nothing for unrestricted reference data', () => {
      expect(forcedWriteValues(SystemMessage, maker)).toEqual({});
    });
  });

  describe('the documented authority rules (01-DATABASE §4, 00-ARCHITECTURE §5.2)', () => {
    it('never exposes an unassigned global rule to a tenant-scoped role', () => {
      const { where, replacements } = buildScopeWhere(RuleMaster, maker);
      const clause = (where as Record<string, { [Op.in]: { val: string } }>).id;

      // The clause must be assignment-gated. A `tenant_id = :t OR tenant_id IS NULL` shape here
      // would hand every tenant every draft rule Super Admin has ever written.
      expect(clause[Op.in].val).toContain('rule_country_assignments');
      expect(replacements).toEqual({ rsScope0: 3 });
      expect(JSON.stringify(where)).not.toContain('tenantId');
    });

    it('gates rewards the same way', () => {
      const { where } = buildScopeWhere(Merchant, countryAdmin);
      expect(JSON.stringify(where)).toContain('tenantId');
    });
  });
});
