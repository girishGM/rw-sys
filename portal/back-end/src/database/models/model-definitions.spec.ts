/**
 * T-003 unit specs for the `reward_config` model layer (`src/database/models/**`).
 *
 * These complement, not replace, `test/database/models.e2e-spec.ts` and
 * `test/database/schema-drift.e2e-spec.ts` — TC-1/TC-2/TC-3/TC-7/TC-8/TC-9/TC-11/TC-12 are
 * already proven against the *live* Postgres schema there and are not re-asserted here.
 * This file exercises the model layer's own definition-time and getter/setter code paths
 * in isolation (no DB connection — see `build-test-sequelize.ts`), which is what the T-003
 * review found had zero `test:cov` coverage: every `@Table`/`paranoid`/`@DefaultScope`
 * declaration, and every tolerant JSON-in-`text` getter/setter pair (implementation notes 3
 * and 4), including the malformed-input branch TC-8 only exercised for one column
 * (`rule_master.parameters`) at the e2e layer.
 */
import { buildTestSequelize } from './build-test-sequelize';
import { REWARD_CONFIG_MODELS } from './index';
import { Activity } from './activity.model';
import { ApprovalRequest } from './approval-request.model';
import { CampaignAuditTrail } from './campaign-audit-trail.model';
import { RewardPolicy } from './reward-policy.model';
import { RewardSystem } from './reward-system.model';
import { RoleDashboardWidget } from './role-dashboard-widget.model';
import { RoleEntityPermission } from './role-entity-permission.model';
import { RuleMaster } from './rule-master.model';
import { RuleVersion } from './rule-version.model';
import { RewardVersion } from './reward-version.model';
import { TenantCampaign } from './tenant-campaign.model';
import { Tenant } from './tenant.model';
import { Merchant } from './merchant.model';
import { MerchantStore } from './merchant-store.model';
import { TenantApiKey } from './tenant-api-key.model';

// Every `reward_config` table this task models that genuinely has a `deleted_at` column —
// see each model file's own doc comment for the live-schema confirmation. Not the
// task file's own (non-exhaustive) 5-table example list — see `merchant-store.model.ts`.
const PARANOID_MODEL_NAMES = new Set([
  'Merchant',
  'MerchantStore',
  'RewardSystem',
  'TenantCampaign',
  'Tenant',
]);

beforeAll(() => {
  // Registers every model on a never-connected Sequelize instance — see the helper's own
  // doc comment for why this is safe to do without a live database.
  buildTestSequelize();
});

describe('reward_config model definitions (T-003)', () => {
  it.each(REWARD_CONFIG_MODELS.map((model) => [model.name, model] as const))(
    '%s declares an explicit reward_config schema, underscored: true and a snake_case tableName',
    (_name, model) => {
      const options = (model as unknown as { options: Record<string, unknown> }).options;
      expect(options.schema).toBe('reward_config');
      expect(options.underscored).toBe(true);
      expect(typeof options.tableName).toBe('string');
      expect(options.tableName as string).toMatch(/^[a-z][a-z0-9_]*$/);
    },
  );

  it.each(REWARD_CONFIG_MODELS.map((model) => [model.name, model] as const))(
    '%s only sets paranoid: true when it is one of the confirmed deleted_at tables',
    (name, model) => {
      const options = (model as unknown as { options: Record<string, unknown> }).options;
      expect(Boolean(options.paranoid)).toBe(PARANOID_MODEL_NAMES.has(name));
    },
  );

  it('TenantApiKey.key_hash is excluded from the default scope (implementation note 5)', () => {
    const scope = (TenantApiKey as unknown as { _scope: { attributes?: { exclude?: string[] } } })
      ._scope;
    expect(scope.attributes?.exclude).toEqual(['keyHash']);
  });

  it('associations required for the covered cross-schema/cross-table reads are wired', () => {
    expect(Object.keys(RuleMaster.associations)).toEqual(
      expect.arrayContaining(['tenant', 'subCategory']),
    );
    expect(Object.keys(RewardVersion.associations)).toEqual(
      expect.arrayContaining(['reward', 'supersedesVersion']),
    );
    expect(Object.keys(RuleVersion.associations)).toEqual(
      expect.arrayContaining(['rule', 'supersedesVersion']),
    );
    expect(Object.keys(TenantCampaign.associations)).toEqual(expect.arrayContaining(['tenant']));
  });
});

/**
 * Shared TC-8-style assertions for every `text`-holding-JSON `Record<string, unknown>`
 * getter/setter pair (implementation note 3): a valid object round-trips, malformed raw
 * content never throws and falls back to `{}`, and a never-set column also falls back to
 * `{}` rather than `undefined`/`null`.
 */
// T-003: every model here extends Sequelize's single-generic `Model<Self>`, which makes
// `.build()`'s typings demand the full instance shape (same friction `models.e2e-spec.ts`/
// `campaign-cap.model.ts` already document for `.create()`); this shared test helper
// deliberately operates on the model class untyped to build partial, field-by-field
// fixtures across ~13 different models.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
function expectTolerantJsonObjectColumn(label: string, model: any, field: string) {
  describe(`${label}.${field} (tolerant JSON-in-text getter/setter)`, () => {
    it('round-trips a valid object through the setter and getter', () => {
      const instance = model.build({ [field]: { a: 1, b: 'two' } });
      expect(instance[field]).toEqual({ a: 1, b: 'two' });
      // The underlying raw column really is a JSON string, not the object itself — this is
      // what makes the column work against a live `text` column (01-DATABASE.md §6 note 3).
      expect(typeof instance.getDataValue(field)).toBe('string');
    });

    it('tolerates malformed raw content and returns {} rather than throwing (TC-8)', () => {
      const instance = model.build();
      instance.setDataValue(field, '{not-valid-json');
      expect(() => instance[field]).not.toThrow();
      expect(instance[field]).toEqual({});
    });

    it('returns {} for a column that was never set', () => {
      const instance = model.build();
      expect(instance[field]).toEqual({});
    });

    it('setting null/undefined stores SQL NULL, not the strings "null"/"undefined"', () => {
      const instance = model.build();
      instance[field] = null;
      expect(instance.getDataValue(field)).toBeNull();
    });
  });
}

expectTolerantJsonObjectColumn('Activity', Activity, 'metadata');
expectTolerantJsonObjectColumn('ApprovalRequest', ApprovalRequest, 'payload');
expectTolerantJsonObjectColumn('CampaignAuditTrail', CampaignAuditTrail, 'fieldChanges');
expectTolerantJsonObjectColumn('RewardPolicy', RewardPolicy, 'config');
expectTolerantJsonObjectColumn('RewardSystem', RewardSystem, 'connectorConfig');
expectTolerantJsonObjectColumn('RewardSystem', RewardSystem, 'maintenanceSchedule');
expectTolerantJsonObjectColumn('RewardSystem', RewardSystem, 'retryConfig');
expectTolerantJsonObjectColumn('RoleDashboardWidget', RoleDashboardWidget, 'widgetConfig');
expectTolerantJsonObjectColumn('RuleMaster', RuleMaster, 'parameters');
expectTolerantJsonObjectColumn('RuleVersion', RuleVersion, 'parameters');
expectTolerantJsonObjectColumn('RewardVersion', RewardVersion, 'connectorConfig');
expectTolerantJsonObjectColumn('RewardVersion', RewardVersion, 'retryConfig');
expectTolerantJsonObjectColumn('TenantCampaign', TenantCampaign, 'metadata');

describe('RoleEntityPermission.actions (JSON array in a varchar(500), implementation note 4)', () => {
  it('round-trips a string[] through the setter and getter', () => {
    // T-003: same single-generic `.build()` typing friction as
    // `expectTolerantJsonObjectColumn` above.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
    const instance = (RoleEntityPermission as any).build({ actions: ['create', 'read'] });
    expect(instance.actions).toEqual(['create', 'read']);
    expect(typeof instance.getDataValue('actions')).toBe('string');
  });

  it('tolerates malformed raw content and returns [] rather than throwing', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- T-003: see above.
    const instance = (RoleEntityPermission as any).build();
    instance.setDataValue('actions', 'not-json[');
    expect(() => instance.actions).not.toThrow();
    expect(instance.actions).toEqual([]);
  });

  it('returns [] for a column that was never set', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- T-003: see above.
    const instance = (RoleEntityPermission as any).build();
    expect(instance.actions).toEqual([]);
  });
});

describe('paranoid soft-delete columns (definition-level; TC-7 proves the runtime behaviour at e2e)', () => {
  it('Tenant/Merchant/MerchantStore/RewardSystem/TenantCampaign declare a deletedAt attribute', () => {
    for (const model of [Tenant, Merchant, MerchantStore, RewardSystem, TenantCampaign]) {
      expect(Object.keys(model.rawAttributes)).toContain('deletedAt');
    }
  });

  it('RuleMaster (not paranoid) declares no deletedAt attribute', () => {
    expect(Object.keys(RuleMaster.rawAttributes)).not.toContain('deletedAt');
  });
});
