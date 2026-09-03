/**
 * T-RAP-003 regression suite. Runs against the real Postgres 16 server documented in root
 * `CLAUDE.md` (same connection convention as `test/database/migrations.spec.ts`) — assumes the
 * schema is already migrated (as it is by the time `npm test` runs in the completion-report
 * verification sequence).
 *
 * Deliberately does **not** clean up the rows it inserts in an `afterAll`, matching
 * `promo-code-service/test/database/seed.spec.ts`'s own precedent: the whole point of this seed
 * (task file "Objective") is that the demo rows persist as real, usable local dev/testing data
 * after the suite runs.
 */
import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import { runSeeds } from '@/database/seeds';
import { seedFieldEncryptionConfig } from '@/database/seeds/001_seed_field_encryption_config';
import { seedServiceConfig } from '@/database/seeds/002_seed_service_config';
import { seedCampaignConfigSnapshot } from '@/database/seeds/003_seed_campaign_config_snapshot';
import {
  DEMO_CAMPAIGN_CODE,
  DEMO_FIELD_ENCRYPTION_CONFIG,
  DEMO_SERVICE_CONFIGS,
  DEMO_TENANT_ID,
} from '@/database/seeds/seed-data.constants';
import { CampaignConfigCacheService } from '@/modules/campaign-cache/campaign-config-cache.service';
import {
  ActivityExternalCodeMapRepository,
  CampaignConfigSnapshotRepository,
} from '@/modules/campaign-cache/campaign-config-snapshot.repository';
import type {
  BoundRuleProto,
  CampaignConfigClient,
} from '@/modules/campaign-cache/campaign-config.client';
import { RuleEvaluatorService } from '@/modules/processing/rule-evaluator.service';
import type { ActivityLogRow } from '@/database/models/activity-log.model';

// Transcribed straight from `CampaignConfigProto` (`campaign-config.client.ts`) — the shape
// T-RAP-010's real gRPC client actually decodes to (`@grpc/proto-loader` with `keepCase: false`),
// which this seed's `payload` must match field for field (TC-3), not a restatement of whatever
// this service's own seed happens to produce. If that client's decoded shape ever adds/removes/
// renames a field, this list (and the seed) must be updated to match it — that is the point of
// pinning it here rather than deriving it from the seed data itself. See T-RAP-045: this used to
// be transcribed from the `.proto`'s own snake_case spellings instead, which is wrong — the proto
// loader decodes to camelCase, and that mismatch is exactly what made the seeded campaign
// unmatchable (TC-3 in `test/modules/campaign-cache/*` below proves the round trip).
const CAMPAIGN_CONFIG_FIELDS = [
  'campaignId',
  'campaignCode',
  'tenantId',
  'countryId',
  'status',
  'startDate',
  'endDate',
  'budget',
  'maxParticipants',
  'merchants',
  'trackers',
  'rules',
  'rewards',
  'etag',
  'configHash',
  'notModified',
  'servedAt',
  'caps',
  'sectionsReturned',
  'sectionsOmitted',
].sort();

const MONEY_FIELDS = ['amount', 'currency'].sort();
const MERCHANT_FIELDS = ['merchantId', 'merchantCode', 'name', 'status', 'activities'].sort();
const ACTIVITY_FIELDS = ['activityId', 'activityCode', 'name', 'externalCodes'].sort();
const TRACKER_FIELDS = [
  'trackerId',
  'trackerCode',
  'name',
  'completionLogic',
  'completionThreshold',
  'status',
  'components',
].sort();
const TRACKER_COMPONENT_FIELDS = [
  'componentId',
  'componentCode',
  'name',
  'activityId',
  'sequenceOrder',
  'isMandatory',
  'status',
].sort();
const BOUND_RULE_FIELDS = [
  'ruleId',
  'ruleVersionId',
  'versionNo',
  'ruleCode',
  'expression',
  'parametersJson',
  'boundValuesJson',
  'trackerComponentId',
  'status',
].sort();
const BOUND_REWARD_FIELDS = [
  'rewardId',
  'rewardVersionId',
  'versionNo',
  'systemCode',
  'rewardType',
  'deliveryMode',
  'policiesJson',
  'unitType',
  'unitCode',
  'level',
  'refId',
  'status',
].sort();
const CAMPAIGN_CAP_FIELDS = [
  'capClass',
  'scopeLevel',
  'scopeRefId',
  'periodType',
  'periodValue',
  'windowStartTime',
  'windowEndTime',
  'periodTimezone',
  'unitType',
  'unitCode',
  'rewardType',
  'maxTotalAmount',
  'maxOccurrences',
  'maxCustomers',
  'onBreach',
  'warnAtPercent',
].sort();

function keysOf(obj: object): string[] {
  return Object.keys(obj).sort();
}

interface CampaignConfigSnapshotRow {
  tenant_id: number;
  campaign_code: string;
  config_version: string;
  is_active: boolean;
  payload: Record<string, unknown>;
}

async function fetchSnapshot(sequelize: Sequelize): Promise<CampaignConfigSnapshotRow> {
  const rows = await sequelize.query<CampaignConfigSnapshotRow>(
    `SELECT tenant_id, campaign_code, config_version, is_active, payload
       FROM realtime_activity_processing.campaign_config_snapshot
      WHERE tenant_id = :tenant_id AND campaign_code = :campaign_code`,
    {
      type: QueryTypes.SELECT,
      replacements: { tenant_id: DEMO_TENANT_ID, campaign_code: DEMO_CAMPAIGN_CODE },
    },
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe('T-RAP-003 — seed demo data', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
    // Idempotent by construction — safe to run once up front so every `it()` below observes the
    // same, already-seeded state regardless of run order.
    await runSeeds(sequelize);
  });

  afterAll(async () => {
    await sequelize.close();
  });

  // TC-1
  it('TC-1: runs against an already-migrated DB with no errors', async () => {
    await expect(runSeeds(sequelize)).resolves.toBeUndefined();
  });

  // TC-2 — the actual, real-Postgres-enforced property (row counts unchanged after a second
  // run), not a mocked/stubbed "did I call INSERT" check (AGENT-PROTOCOL.md §3).
  describe('TC-2: running the seed a second time creates no duplicate rows', () => {
    it('field_encryption_config stays at exactly one row for (global, NULL, customerId)', async () => {
      const before = await sequelize.query(
        `SELECT id FROM realtime_activity_processing.field_encryption_config
          WHERE scope_level = 'global' AND scope_ref IS NULL AND field_name = 'customerId'`,
        { type: QueryTypes.SELECT },
      );
      await seedFieldEncryptionConfig(sequelize);
      const after = await sequelize.query(
        `SELECT id FROM realtime_activity_processing.field_encryption_config
          WHERE scope_level = 'global' AND scope_ref IS NULL AND field_name = 'customerId'`,
        { type: QueryTypes.SELECT },
      );
      expect(before).toHaveLength(1);
      expect(after).toHaveLength(1);
    });

    it('service_config stays at exactly one row per global key', async () => {
      const before = await sequelize.query<{ config_key: string }>(
        `SELECT config_key FROM realtime_activity_processing.service_config
          WHERE scope_level = 'global' AND scope_ref IS NULL`,
        { type: QueryTypes.SELECT },
      );
      await seedServiceConfig(sequelize);
      const after = await sequelize.query<{ config_key: string }>(
        `SELECT config_key FROM realtime_activity_processing.service_config
          WHERE scope_level = 'global' AND scope_ref IS NULL`,
        { type: QueryTypes.SELECT },
      );
      expect(before).toHaveLength(DEMO_SERVICE_CONFIGS.length);
      expect(after).toHaveLength(DEMO_SERVICE_CONFIGS.length);
    });

    it('campaign_config_snapshot stays at exactly one row for the demo campaign', async () => {
      const countRows = () =>
        sequelize.query(
          `SELECT id FROM realtime_activity_processing.campaign_config_snapshot
            WHERE tenant_id = :tenant_id AND campaign_code = :campaign_code`,
          {
            type: QueryTypes.SELECT,
            replacements: { tenant_id: DEMO_TENANT_ID, campaign_code: DEMO_CAMPAIGN_CODE },
          },
        );
      const before = await countRows();
      await seedCampaignConfigSnapshot(sequelize);
      const after = await countRows();
      expect(before).toHaveLength(1);
      expect(after).toHaveLength(1);
    });
  });

  // Adjacent behaviour: field_encryption_config's seeded row matches 01-DATABASE.md §10 exactly.
  it('adjacent behaviour: field_encryption_config seeds exactly the documented row', async () => {
    const rows = await sequelize.query<{
      scope_level: string;
      scope_ref: string | null;
      field_name: string;
      is_encrypted: boolean;
    }>(
      `SELECT scope_level, scope_ref, field_name, is_encrypted
         FROM realtime_activity_processing.field_encryption_config
        WHERE field_name = 'customerId'`,
      { type: QueryTypes.SELECT },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope_level: DEMO_FIELD_ENCRYPTION_CONFIG.scope_level,
      scope_ref: null,
      field_name: DEMO_FIELD_ENCRYPTION_CONFIG.field_name,
      is_encrypted: DEMO_FIELD_ENCRYPTION_CONFIG.is_encrypted,
    });
  });

  // Adjacent behaviour: all four documented service_config keys/values are present.
  it('adjacent behaviour: service_config seeds all four documented global keys', async () => {
    const rows = await sequelize.query<{ config_key: string; config_value: string }>(
      `SELECT config_key, config_value FROM realtime_activity_processing.service_config
        WHERE scope_level = 'global' AND scope_ref IS NULL
        ORDER BY config_key`,
      { type: QueryTypes.SELECT },
    );
    const asMap = Object.fromEntries(rows.map((r) => [r.config_key, r.config_value]));
    expect(asMap).toMatchObject({
      reconciliation_poll_interval_seconds: '300',
      dedup_composite_fallback_enabled: 'true',
      reward_dispatch_max_retry_attempts: '8',
      advisory_lock_wait_timeout_ms: '5000',
    });
  });

  // TC-3: validate the seeded payload against the CampaignConfig proto shape, field for field, at
  // every nesting level — top-level, Money, Merchant/Activity, Tracker/TrackerComponent,
  // BoundRule, BoundReward, CampaignCap.
  describe('TC-3: campaign_config_snapshot.payload matches the CampaignConfig proto shape', () => {
    it('top-level CampaignConfig fields match field-for-field', async () => {
      const { payload } = await fetchSnapshot(sequelize);
      expect(keysOf(payload)).toEqual(CAMPAIGN_CONFIG_FIELDS);
    });

    it('is_active/config_version columns are set correctly', async () => {
      const row = await fetchSnapshot(sequelize);
      expect(row.is_active).toBe(true);
      expect(row.config_version).toEqual(expect.any(String));
      expect(row.config_version.length).toBeGreaterThan(0);
    });

    it('Money (budget) fields match field-for-field', async () => {
      const { payload } = await fetchSnapshot(sequelize);
      expect(keysOf(payload.budget as object)).toEqual(MONEY_FIELDS);
    });

    it('Merchant and nested Activity fields match field-for-field', async () => {
      const { payload } = await fetchSnapshot(sequelize);
      const merchants = payload.merchants as Record<string, unknown>[];
      expect(merchants.length).toBeGreaterThanOrEqual(1);
      for (const merchant of merchants) {
        expect(keysOf(merchant)).toEqual(MERCHANT_FIELDS);
        const activities = merchant.activities as Record<string, unknown>[];
        expect(activities.length).toBeGreaterThanOrEqual(1);
        for (const activity of activities) {
          expect(keysOf(activity)).toEqual(ACTIVITY_FIELDS);
        }
      }
    });

    it('Tracker and nested TrackerComponent fields match field-for-field, with both completionLogic values present', async () => {
      const { payload } = await fetchSnapshot(sequelize);
      const trackers = payload.trackers as Record<string, unknown>[];
      expect(trackers.length).toBeGreaterThanOrEqual(2);

      const logics = new Set(trackers.map((t) => t.completionLogic));
      expect(logics).toEqual(new Set(['all', 'n_of']));

      for (const tracker of trackers) {
        expect(keysOf(tracker)).toEqual(TRACKER_FIELDS);
        const components = tracker.components as Record<string, unknown>[];
        expect(components).toHaveLength(2);
        for (const component of components) {
          expect(keysOf(component)).toEqual(TRACKER_COMPONENT_FIELDS);
        }
      }
    });

    it('BoundRule fields match field-for-field, at least one per component', async () => {
      const { payload } = await fetchSnapshot(sequelize);
      const rules = payload.rules as Record<string, unknown>[];
      const trackers = payload.trackers as { components: { componentId: number }[] }[];
      const componentIds = trackers.flatMap((t) => t.components.map((c) => c.componentId));

      for (const rule of rules) {
        expect(keysOf(rule)).toEqual(BOUND_RULE_FIELDS);
      }
      for (const componentId of componentIds) {
        expect(rules.some((r) => r.trackerComponentId === componentId)).toBe(true);
      }
    });

    it('BoundReward fields match field-for-field, with one component-level assignment', async () => {
      const { payload } = await fetchSnapshot(sequelize);
      const rewards = payload.rewards as Record<string, unknown>[];
      expect(rewards.length).toBeGreaterThanOrEqual(1);
      for (const reward of rewards) {
        expect(keysOf(reward)).toEqual(BOUND_REWARD_FIELDS);
      }
      expect(rewards.some((r) => r.level === 'component')).toBe(true);
    });

    it('CampaignCap fields match field-for-field, with at least one cap', async () => {
      const { payload } = await fetchSnapshot(sequelize);
      const caps = payload.caps as Record<string, unknown>[];
      expect(caps.length).toBeGreaterThanOrEqual(1);
      for (const cap of caps) {
        expect(keysOf(cap)).toEqual(CAMPAIGN_CAP_FIELDS);
      }
    });

    it('money fields are decimal-as-string, never a float, on budget/maxTotalAmount', async () => {
      const { payload } = await fetchSnapshot(sequelize);
      expect(typeof (payload.budget as { amount: unknown }).amount).toBe('string');
      const caps = payload.caps as { maxTotalAmount: unknown }[];
      for (const cap of caps) {
        expect(typeof cap.maxTotalAmount).toBe('string');
      }
    });
  });

  // T-RAP-045 regression: proves the seeded payload is not just field-shaped correctly (TC-3
  // above) but actually round-trips through the real cache builder and becomes matchable — the
  // symptom the defect report reproduced was a payload that satisfied a naive shape check yet
  // silently produced zero matched activity-index entries at cold start.
  describe('T-RAP-045 regression: seeded campaign_config_snapshot round-trips through buildFromLocalSnapshots', () => {
    it('the seeded demo campaign becomes indexed and matchable by activityCode for both trackers', async () => {
      // No live portal needed: `bootstrap()` builds the in-memory cache from local snapshot rows
      // first (`buildFromLocalSnapshots`, private) and only *attempts* a portal warm afterwards —
      // an unreachable client here isolates exactly the local-snapshot code path this defect broke.
      const unreachableClient = {
        listActiveCampaigns: () => Promise.reject(new Error('T-RAP-045 regression: no portal')),
        watchCampaignConfig: () => {
          throw new Error('not used by this test');
        },
      } as unknown as CampaignConfigClient;

      const snapshotRepo = new CampaignConfigSnapshotRepository(sequelize);
      const externalCodeRepo = new ActivityExternalCodeMapRepository(sequelize);
      const service = new CampaignConfigCacheService(
        unreachableClient,
        snapshotRepo,
        externalCodeRepo,
      );

      const savedTenantIdsEnv = process.env.PORTAL_CONFIG_TENANT_IDS;
      process.env.PORTAL_CONFIG_TENANT_IDS = String(DEMO_TENANT_ID);
      try {
        // Cold start with a local snapshot present but the portal unreachable: bootstrap resolves
        // (warns, doesn't throw — implementation note 1) and the seeded row must already be
        // indexed by this point, purely from `buildFromLocalSnapshots`.
        await expect(service.bootstrap()).resolves.toBeUndefined();

        // Unfixed (snake_case payload): every property read off the cast `CampaignConfigProto`
        // (merchants[].activities[].activityId, trackers[].components[].activityId/componentCode)
        // is `undefined`, so `indexComponentIfMatchable` never finds a matching activity and both
        // lookups below return `[]`. Fixed (camelCase payload): both trackers' components resolve
        // and both activityCodes become matchable.
        const purchaseMatches = service.lookupByActivityCode(DEMO_TENANT_ID, 'PURCHASE');
        const signupMatches = service.lookupByActivityCode(DEMO_TENANT_ID, 'SIGNUP');

        expect(purchaseMatches.length).toBeGreaterThanOrEqual(2); // COMP_PURCHASE + COMP_PURCHASE_NOF
        expect(signupMatches.length).toBeGreaterThanOrEqual(2); // COMP_SIGNUP + COMP_SIGNUP_NOF
        expect(purchaseMatches.map((m) => m.componentCode).sort()).toEqual(
          ['COMP_PURCHASE', 'COMP_PURCHASE_NOF'].sort(),
        );
        expect(signupMatches.map((m) => m.componentCode).sort()).toEqual(
          ['COMP_SIGNUP', 'COMP_SIGNUP_NOF'].sort(),
        );
        expect(
          purchaseMatches.every(
            (m) => m.tenantId === DEMO_TENANT_ID && m.campaignCode === DEMO_CAMPAIGN_CODE,
          ),
        ).toBe(true);
      } finally {
        if (savedTenantIdsEnv === undefined) {
          delete process.env.PORTAL_CONFIG_TENANT_IDS;
        } else {
          process.env.PORTAL_CONFIG_TENANT_IDS = savedTenantIdsEnv;
        }
      }
    });
  });

  // T-RAP-046 regression: `DEMO_CAMPAIGN_CONFIG.rules[].status` must carry the real
  // binding-status enum (`tracker_component_rules.status`: `'active'|'inactive'`) that
  // `RuleEvaluatorService.evaluate`/`resolveRequiredCount` actually filter on
  // (`rule.status === 'active'`) — not `rule_versions.status`'s own, different-table value
  // (`'draft'|'published'|'deprecated'|'retired'`) it was originally (and wrongly) seeded with.
  // A bare `status === 'active'` field assertion would be a change-detector (AGENT-PROTOCOL.md
  // §3): it would restate the fix's literal value without proving it matters. TC-3 below instead
  // drives the real `RuleEvaluatorService` end to end — with the unfixed `'published'` seed,
  // `ruleRefs.filter(rule => rule.status === 'active')` drops every seeded rule, so an activity
  // that should fail `RULE_MIN_PURCHASE` (activity_value below the bound minimum) is instead
  // vacuously reported as passed. This test fails on the unfixed seed and passes on the fixed
  // one — proven by temporarily reverting the seed's status back to `'published'` and re-running
  // it (see this task's completion report). See
  // `realtime-activity-processing-service-plan/tasks/T-RAP-046-*.md` for the full evidence.
  describe('T-RAP-046 regression: seeded BoundRule.status is the real binding-status enum, not rule_versions.status', () => {
    const ruleEvaluator = new RuleEvaluatorService();

    function fakeActivityRow(overrides: Partial<ActivityLogRow>): ActivityLogRow {
      return {
        id: '55555555-5555-4555-8555-555555555555',
        correlation_id: '66666666-6666-4666-8666-666666666666',
        dedup_key: 'T-RAP-046-dedup',
        tenant_id: DEMO_TENANT_ID,
        customer_id_encrypted: 'ciphertext',
        customer_id_hash: 'c'.repeat(64),
        customer_id_type: 'INTERNAL_ID',
        activity_performed_date: new Date(),
        transaction_type: null,
        activity_code: 'PURCHASE',
        activity_type: 'TRANSACTION',
        activity_category: 'RETAIL',
        activity_value: '0',
        activity_value_unit: 'USD',
        channel: 'WEB',
        activity_performed_env: 'PROD',
        activity_name: 'Online purchase',
        campaign_code: DEMO_CAMPAIGN_CODE,
        tracker_code: 'TRK_ALL',
        tracker_component_code: 'COMP_PURCHASE',
        merchant_code: 'DEMO_MERCHANT',
        source_transport: 'GRPC',
        activity_reached_date: new Date(),
        activity_processed_date: null,
        status: 'processing',
        error_code: null,
        comment: null,
        created_at: new Date(),
        updated_at: new Date(),
        ...overrides,
      };
    }

    async function fetchMinPurchaseRule(): Promise<BoundRuleProto> {
      const { payload } = await fetchSnapshot(sequelize);
      const rules = payload.rules as BoundRuleProto[];
      const rule = rules.find(
        (r) => r.ruleCode === 'RULE_MIN_PURCHASE' && r.trackerComponentId === 901,
      );
      expect(rule).toBeDefined();
      return rule as BoundRuleProto;
    }

    // TC-1/TC-2: the seeded value itself is the real binding-status enum, not the
    // rule_versions.status value it was conflated with.
    it('every seeded rule uses the real active/inactive binding-status enum', async () => {
      const { payload } = await fetchSnapshot(sequelize);
      const rules = payload.rules as BoundRuleProto[];
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(['active', 'inactive']).toContain(rule.status);
      }
    });

    // TC-3: proves the seeded status is not just field-valid but actually enforced end to end by
    // the real evaluator — fails on the unfixed 'published' seed (see header comment above).
    it('RULE_MIN_PURCHASE actually gates a failing activity end-to-end through RuleEvaluatorService', async () => {
      const minPurchaseRule = await fetchMinPurchaseRule();
      const failingRow = fakeActivityRow({ activity_value: '0' });
      const outcome = ruleEvaluator.evaluate(failingRow, [minPurchaseRule]);
      expect(outcome.passed).toBe(false);
      expect(outcome.failedRuleCode).toBe('RULE_MIN_PURCHASE');
    });

    // TC-4: adjacent behaviour — an activity that genuinely satisfies the same rule still passes.
    it('RULE_MIN_PURCHASE still passes for an activity that satisfies it', async () => {
      const minPurchaseRule = await fetchMinPurchaseRule();
      const passingRow = fakeActivityRow({ activity_value: '5' });
      const outcome = ruleEvaluator.evaluate(passingRow, [minPurchaseRule]);
      expect(outcome.passed).toBe(true);
      expect(outcome.failedRuleCode).toBeNull();
    });
  });
});
