/**
 * T-RAP-003 — fixed, committed demo data for local dev/testing without a live portal connection
 * (task file "Objective"). Three concerns, one file, since they're small and share the same
 * "demo actor"/"demo tenant" conventions `promo-code-service/src/database/seeds/
 * seed-data.constants.ts` already established for this repo's other standalone services.
 *
 * `DEMO_TENANT_ID` is a plain `int` (01-DATABASE.md §0: "codes, not foreign keys" — `tenant_id`
 * matches `reward_config.tenants.id`'s own type), overridable via `DEMO_PORTAL_TENANT_ID` for an
 * environment where the portal's demo tenant isn't id `1`, same precedent
 * `promo-code-service`'s own `DEMO_PORTAL_TENANT_ID` set (there as a string; here as an int,
 * matching this service's own `tenant_id int` convention rather than that service's later
 * varchar correction — T-PC-052 doesn't apply here, this service never assumed uuid).
 */
export const DEMO_TENANT_ID = Number(process.env.DEMO_PORTAL_TENANT_ID) || 1;
export const DEMO_SEED_ACTOR = 'T-RAP-003-seed';

// ---------------------------------------------------------------------------------------------
// field_encryption_config — 01-DATABASE.md §10. Exactly one row, verbatim from the design doc.
// ---------------------------------------------------------------------------------------------

export const DEMO_FIELD_ENCRYPTION_CONFIG = {
  scope_level: 'global' as const,
  scope_ref: null,
  field_name: 'customerId',
  is_encrypted: true,
  added_by: DEMO_SEED_ACTOR,
};

// ---------------------------------------------------------------------------------------------
// service_config — 01-DATABASE.md §11. The four global keys the design doc names explicitly.
// ---------------------------------------------------------------------------------------------

export interface DemoServiceConfigSeed {
  config_key: string;
  config_value: string;
  scope_level: 'global';
  scope_ref: null;
  description: string;
}

export const DEMO_SERVICE_CONFIGS: readonly DemoServiceConfigSeed[] = [
  {
    config_key: 'reconciliation_poll_interval_seconds',
    config_value: '300',
    scope_level: 'global',
    scope_ref: null,
    description:
      'How often the reconciliation poller re-fetches campaign config (04-CACHE-INVALIDATION.md §3).',
  },
  {
    config_key: 'dedup_composite_fallback_enabled',
    config_value: 'true',
    scope_level: 'global',
    scope_ref: null,
    description:
      'Whether a missing eventId falls back to a derived composite dedup key (ARCHITECTURE.md §7).',
  },
  {
    config_key: 'reward_dispatch_max_retry_attempts',
    config_value: '8',
    scope_level: 'global',
    scope_ref: null,
    description:
      'Attempt cap before a reward_dispatch_retry row flips to exhausted (01-DATABASE.md §9).',
  },
  {
    config_key: 'advisory_lock_wait_timeout_ms',
    config_value: '5000',
    scope_level: 'global',
    scope_ref: null,
    description:
      'How long a transaction waits on the customer/campaign advisory lock before giving up (01-DATABASE.md §12).',
  },
] as const;

// ---------------------------------------------------------------------------------------------
// campaign_config_snapshot — 01-DATABASE.md §1. `payload` must match what T-RAP-010's real
// `CampaignConfigClient` actually produces/consumes: `@grpc/proto-loader` is loaded there with
// `keepCase: false` (`campaign-config.client.ts`), so every field on the decoded
// `CampaignConfigProto` (same file) is camelCase, NOT the snake_case names the `.proto` source
// itself spells them with. Every field name below is therefore transcribed from
// `CampaignConfigProto` (and its nested `*Proto` interfaces) in `campaign-config.client.ts`, not
// from the `.proto` file directly — matching the wire shape this service's own client actually
// hands to `CampaignConfigCacheService.buildFromLocalSnapshots`/`indexCampaign`.
//
// **T-RAP-045** (defect fix): this file originally transcribed the `.proto`'s own snake_case
// field spellings instead, which meant `buildFromLocalSnapshots` cast the seeded payload to
// `CampaignConfigProto` but every property read off it (`merchants[].activities[].activityId`,
// `trackers[].components[].componentCode`, etc.) was actually `undefined` — the demo campaign
// was stored but silently never became matchable in the in-memory activity index. See
// `realtime-activity-processing-service-plan/tasks/T-RAP-045-*.md` for the full evidence.
//
// **T-RAP-046** (defect fix): `DEMO_CAMPAIGN_CONFIG.rules[].status` originally used `'published'`
// on all four demo `BoundRule`s — that value belongs to `rule_versions.status`
// (`'draft'|'published'|'deprecated'|'retired'`, a *different* status field on a *different*
// table), not to the binding-status enum this `status` field actually represents
// (`reward_config.tracker_component_rules.status varchar(20) check (status in
// ('active','inactive'))`, confirmed live in `database/reward_config/reward_config_postgres.sql`
// and passed through verbatim by `portal/back-end/src/grpc/config-snapshot.builder.ts`).
// `RuleEvaluatorService.evaluate`/`resolveRequiredCount` (`rule-evaluator.service.ts`) both filter
// `ruleRefs` by `rule.status === 'active'`, so with `'published'` every demo rule was silently
// excluded — vacuously "passed" — and the demo campaign's tracker components never actually
// gated on their intended rules end-to-end. Fixed to `'active'`, matching the real enum. See
// `realtime-activity-processing-service-plan/tasks/T-RAP-046-*.md` for the full evidence.
//
// This is a demo fixture only (Scope "Out": no live gRPC/Kafka wiring) — Wave 1's cache-builder
// (T-RAP-010) parses this exact shape once the real client exists.
//
// Two trackers, not one, so `completionLogic = 'all'` and `completionLogic = 'n_of'` are BOTH
// exercisable by later tests (implementation note 3) — each with two components, so `all` means
// "both required" and `n_of` (threshold 1) means "either one suffices" are genuinely different
// outcomes over the same two-component shape, not just a label change.
// ---------------------------------------------------------------------------------------------

export interface DemoMoney {
  amount: string;
  currency: string;
}

export interface DemoActivity {
  activityId: number;
  activityCode: string;
  name: string;
  externalCodes: string[];
}

export interface DemoMerchant {
  merchantId: number;
  merchantCode: string;
  name: string;
  status: string;
  activities: DemoActivity[];
}

export interface DemoTrackerComponent {
  componentId: number;
  componentCode: string;
  name: string;
  activityId: number;
  sequenceOrder: number;
  isMandatory: boolean;
  status: string;
}

export interface DemoTracker {
  trackerId: number;
  trackerCode: string;
  name: string;
  completionLogic: 'all' | 'any' | 'n_of' | 'sequence';
  completionThreshold: number;
  status: string;
  components: DemoTrackerComponent[];
}

export interface DemoBoundRule {
  ruleId: number;
  ruleVersionId: number;
  versionNo: number;
  ruleCode: string;
  expression: string;
  parametersJson: string;
  boundValuesJson: string;
  trackerComponentId: number;
  status: string;
}

export interface DemoBoundReward {
  rewardId: number;
  rewardVersionId: number;
  versionNo: number;
  systemCode: string;
  rewardType: string;
  deliveryMode: string;
  policiesJson: string;
  unitType: string;
  unitCode: string;
  level: 'campaign' | 'tracker' | 'component';
  refId: number;
  status: string;
}

export interface DemoCampaignCap {
  capClass: string;
  scopeLevel: string;
  scopeRefId: number;
  periodType: string;
  periodValue: number;
  windowStartTime: string;
  windowEndTime: string;
  periodTimezone: string;
  unitType: string;
  unitCode: string;
  rewardType: string;
  maxTotalAmount: string;
  maxOccurrences: number;
  maxCustomers: number;
  onBreach: string;
  warnAtPercent: number;
}

export interface DemoCampaignConfig {
  campaignId: number;
  campaignCode: string;
  tenantId: number;
  countryId: number;
  status: string;
  startDate: string;
  endDate: string;
  budget: DemoMoney;
  maxParticipants: number;
  merchants: DemoMerchant[];
  trackers: DemoTracker[];
  rules: DemoBoundRule[];
  rewards: DemoBoundReward[];
  etag: string;
  configHash: string;
  notModified: boolean;
  servedAt: string;
  caps: DemoCampaignCap[];
  sectionsReturned: string[];
  sectionsOmitted: string[];
}

export const DEMO_CAMPAIGN_CODE = 'DEMO_CAMPAIGN';
export const DEMO_CONFIG_VERSION = 'demo-config-v1';

const DEMO_PURCHASE_ACTIVITY_ID = 701;
const DEMO_SIGNUP_ACTIVITY_ID = 702;

export const DEMO_CAMPAIGN_CONFIG: DemoCampaignConfig = {
  campaignId: 9001,
  campaignCode: DEMO_CAMPAIGN_CODE,
  tenantId: DEMO_TENANT_ID,
  countryId: 1,
  status: 'active',
  startDate: '2026-01-01T00:00:00.000Z',
  endDate: '2026-12-31T00:00:00.000Z',
  budget: { amount: '10000.00', currency: 'USD' },
  maxParticipants: 1000,
  merchants: [
    {
      merchantId: 501,
      merchantCode: 'DEMO_MERCHANT',
      name: 'Demo Merchant',
      status: 'active',
      activities: [
        {
          activityId: DEMO_PURCHASE_ACTIVITY_ID,
          activityCode: 'PURCHASE',
          name: 'Purchase',
          externalCodes: ['TXN_PURCHASE'],
        },
        {
          activityId: DEMO_SIGNUP_ACTIVITY_ID,
          activityCode: 'SIGNUP',
          name: 'Signup',
          externalCodes: [],
        },
      ],
    },
  ],
  trackers: [
    {
      trackerId: 801,
      trackerCode: 'TRK_ALL',
      name: 'Complete All Steps',
      completionLogic: 'all',
      completionThreshold: 2,
      status: 'active',
      components: [
        {
          componentId: 901,
          componentCode: 'COMP_PURCHASE',
          name: 'Make a purchase',
          activityId: DEMO_PURCHASE_ACTIVITY_ID,
          sequenceOrder: 1,
          isMandatory: true,
          status: 'active',
        },
        {
          componentId: 902,
          componentCode: 'COMP_SIGNUP',
          name: 'Sign up',
          activityId: DEMO_SIGNUP_ACTIVITY_ID,
          sequenceOrder: 2,
          isMandatory: true,
          status: 'active',
        },
      ],
    },
    {
      trackerId: 802,
      trackerCode: 'TRK_NOF',
      name: 'Complete Any One Step',
      completionLogic: 'n_of',
      completionThreshold: 1,
      status: 'active',
      components: [
        {
          componentId: 903,
          componentCode: 'COMP_PURCHASE_NOF',
          name: 'Make a purchase (either)',
          activityId: DEMO_PURCHASE_ACTIVITY_ID,
          sequenceOrder: 1,
          isMandatory: false,
          status: 'active',
        },
        {
          componentId: 904,
          componentCode: 'COMP_SIGNUP_NOF',
          name: 'Sign up (either)',
          activityId: DEMO_SIGNUP_ACTIVITY_ID,
          sequenceOrder: 2,
          isMandatory: false,
          status: 'active',
        },
      ],
    },
  ],
  rules: [
    {
      ruleId: 1101,
      ruleVersionId: 1,
      versionNo: 1,
      ruleCode: 'RULE_MIN_PURCHASE',
      expression: 'activity.activity_value >= 1',
      parametersJson: '{"min_value":{"type":"number"}}',
      boundValuesJson: '{"min_value":1}',
      trackerComponentId: 901,
      status: 'active',
    },
    {
      ruleId: 1102,
      ruleVersionId: 1,
      versionNo: 1,
      ruleCode: 'RULE_SIGNUP_COMPLETE',
      expression: 'activity.activity_type == "SIGNUP"',
      parametersJson: '{}',
      boundValuesJson: '{}',
      trackerComponentId: 902,
      status: 'active',
    },
    {
      ruleId: 1103,
      ruleVersionId: 1,
      versionNo: 1,
      ruleCode: 'RULE_MIN_PURCHASE',
      expression: 'activity.activity_value >= 1',
      parametersJson: '{"min_value":{"type":"number"}}',
      boundValuesJson: '{"min_value":1}',
      trackerComponentId: 903,
      status: 'active',
    },
    {
      ruleId: 1104,
      ruleVersionId: 1,
      versionNo: 1,
      ruleCode: 'RULE_SIGNUP_COMPLETE',
      expression: 'activity.activity_type == "SIGNUP"',
      parametersJson: '{}',
      boundValuesJson: '{}',
      trackerComponentId: 904,
      status: 'active',
    },
  ],
  rewards: [
    {
      rewardId: 1201,
      rewardVersionId: 1,
      versionNo: 1,
      systemCode: 'CASHBACK_5',
      rewardType: 'cashback',
      deliveryMode: 'async',
      policiesJson: '{}',
      unitType: 'currency',
      unitCode: 'USD',
      level: 'component',
      refId: 901,
      status: 'published',
    },
  ],
  etag: 'demo-etag-v1',
  configHash: 'demo-hash-v1',
  notModified: false,
  servedAt: '2026-01-01T00:00:00.000Z',
  caps: [
    {
      capClass: 'budget',
      scopeLevel: 'campaign',
      scopeRefId: 9001,
      periodType: 'monthly',
      periodValue: 1,
      windowStartTime: '',
      windowEndTime: '',
      periodTimezone: 'UTC',
      unitType: 'currency',
      unitCode: 'USD',
      rewardType: '',
      maxTotalAmount: '1000.00',
      maxOccurrences: 100,
      maxCustomers: 500,
      onBreach: 'reject',
      warnAtPercent: 80,
    },
  ],
  sectionsReturned: ['BASIC', 'MERCHANTS', 'TRACKERS', 'RULES', 'REWARDS', 'CAPS'],
  sectionsOmitted: [],
};
