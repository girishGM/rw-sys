/**
 * T-RAP-033. Covers the budget/customer-limit enforcement engine, built on top of T-RAP-031/032's
 * own advisory-lock + rule-evaluation + progress/tracker-completion chain
 * (`05-PROCESSING-PIPELINE.md` §6).
 *
 * Two tiers, same split every prior Wave 3 spec in this directory already established:
 *  - Pure-logic tests (`matchCapsForAssignment`, `deriveCapKey`, `resolveFixedRewardValue`)
 *    against fakes — no real DB.
 *  - Persistence tests (TC-1..9) against the real local Postgres 16 server (root `CLAUDE.md`),
 *    connected as the real least-privilege `rap_app` role, driven end to end through
 *    `RuleEvaluationRowHandler.handle()` exactly as production traffic would — proving the
 *    `budget_consumption`/`customer_reward_limit_consumption` reservations really happen inside
 *    the same transaction T-RAP-031 opened, not a separately wired call.
 */
import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import {
  CapEnforcementService,
  deriveCapKey,
  matchCapsForAssignment,
  resolveFixedRewardValue,
} from '@/modules/budget/cap-enforcement.service';
import { BudgetConsumptionRepository } from '@/modules/budget/budget-consumption.repository';
import { CustomerLimitConsumptionRepository } from '@/modules/budget/customer-limit-consumption.repository';
import type { BudgetBreachCallbackClient } from '@/modules/budget/budget-breach-callback.client';
import { computePeriodBucket, LIFETIME_PERIOD_START } from '@/modules/budget/period-bucket.util';
import { TrackerCompletionEvaluatorService } from '@/modules/processing/tracker-completion-evaluator.service';
import { TrackerStatusRepository } from '@/modules/processing/tracker-status.repository';
import { TrackerComponentProgressRepository } from '@/modules/processing/tracker-component-progress.repository';
import { RuleEvaluationRowHandler } from '@/modules/processing/rule-evaluation-row-handler.service';
import { RuleEvaluatorService } from '@/modules/processing/rule-evaluator.service';
import type { AdvisoryLockTimeoutResolver } from '@/modules/processing/processing.config';
import { RewardEntryRepository } from '@/modules/reward-entry/reward-entry.repository';
import { RewardEntryOutboxRepository } from '@/modules/reward-entry/reward-entry-outbox.repository';
import {
  ActivityLogsRepository,
  type FanOutRowInput,
} from '@/modules/activity-mapping/activity-logs.repository';
import type { CampaignConfigCacheService } from '@/modules/campaign-cache/campaign-config-cache.service';
import type {
  BoundRewardProto,
  BoundRuleProto,
  CampaignCapProto,
  CampaignConfigProto,
  TrackerComponentProto,
} from '@/modules/campaign-cache/campaign-config.client';
import type { ActivityLogRow } from '@/database/models/activity-log.model';
import type { BudgetConsumptionRow } from '@/database/models/budget-consumption.model';
import { MetricsService } from '@/observability/metrics.service';
import { StructuredLoggerFactory } from '@/observability/structured-logger';
import type { LogRedactorService } from '@/modules/encryption/log-redactor.service';

/** Same hand-rolled fake `structured-logger.spec.ts` itself uses for this exact collaborator — a
 * real `StructuredLoggerFactory`/`StructuredLogger`, not a mock, over a no-op redactor. */
function fakeLoggerFactory(): StructuredLoggerFactory {
  return new StructuredLoggerFactory({
    redact: (_field: string, value: string) => value,
  } as unknown as LogRedactorService);
}

const TENANT_ID = 960_000 + Math.floor(Math.random() * 39_999);

// ---------------------------------------------------------------------------------------------
// Pure-logic tests — no real DB.
// ---------------------------------------------------------------------------------------------

function fakeReward(overrides: Partial<BoundRewardProto> = {}): BoundRewardProto {
  return {
    rewardId: 1,
    rewardVersionId: 1,
    versionNo: 1,
    systemCode: 'RWD1',
    rewardType: 'cashback',
    deliveryMode: 'wallet',
    policiesJson: JSON.stringify({ fixedAmount: '10.00' }),
    unitType: 'currency',
    unitCode: 'MYR',
    level: 'component',
    refId: 501,
    status: 'active',
    ...overrides,
  };
}

function fakeCap(overrides: Partial<CampaignCapProto> = {}): CampaignCapProto {
  return {
    capClass: 'budget',
    scopeLevel: 'campaign',
    scopeRefId: 0,
    periodType: 'lifetime',
    periodValue: 0,
    windowStartTime: '',
    windowEndTime: '',
    periodTimezone: '',
    unitType: 'currency',
    unitCode: 'MYR',
    rewardType: '',
    maxTotalAmount: '1000.00',
    maxOccurrences: 0,
    maxCustomers: 0,
    onBreach: 'reject',
    warnAtPercent: 0,
    ...overrides,
  };
}

describe('matchCapsForAssignment (pure, no DB)', () => {
  it('a campaign-scope cap covers every reward regardless of its own level', () => {
    const reward = fakeReward({ level: 'component', refId: 501 });
    const cap = fakeCap({ scopeLevel: 'campaign' });
    expect(matchCapsForAssignment(reward, 701, [cap])).toEqual([cap]);
  });

  it('a tracker-scope cap covers a component-level reward within that tracker', () => {
    const reward = fakeReward({ level: 'component', refId: 501 });
    const cap = fakeCap({ scopeLevel: 'tracker', scopeRefId: 701 });
    expect(matchCapsForAssignment(reward, 701, [cap])).toEqual([cap]);
  });

  it('a tracker-scope cap does NOT cover a component-level reward in a different tracker', () => {
    const reward = fakeReward({ level: 'component', refId: 501 });
    const cap = fakeCap({ scopeLevel: 'tracker', scopeRefId: 999 });
    expect(matchCapsForAssignment(reward, 701, [cap])).toEqual([]);
  });

  it('a component-scope cap only covers the exact same component', () => {
    const matching = fakeCap({ scopeLevel: 'component', scopeRefId: 501 });
    const notMatching = fakeCap({ scopeLevel: 'component', scopeRefId: 502 });
    const reward = fakeReward({ level: 'component', refId: 501 });
    expect(matchCapsForAssignment(reward, 701, [matching, notMatching])).toEqual([matching]);
  });

  it('a unit mismatch never matches, regardless of scope', () => {
    const reward = fakeReward({ unitType: 'points', unitCode: 'PTS' });
    const cap = fakeCap({ unitType: 'currency', unitCode: 'MYR', scopeLevel: 'campaign' });
    expect(matchCapsForAssignment(reward, 701, [cap])).toEqual([]);
  });

  it('an empty reward_type on the cap means "all reward types"; a set one narrows', () => {
    const reward = fakeReward({ rewardType: 'cashback' });
    const openCap = fakeCap({ rewardType: '' });
    const narrowMatchingCap = fakeCap({ rewardType: 'cashback' });
    const narrowMismatchCap = fakeCap({ rewardType: 'voucher' });
    expect(matchCapsForAssignment(reward, 701, [openCap])).toEqual([openCap]);
    expect(matchCapsForAssignment(reward, 701, [narrowMatchingCap])).toEqual([narrowMatchingCap]);
    expect(matchCapsForAssignment(reward, 701, [narrowMismatchCap])).toEqual([]);
  });
});

describe('deriveCapKey (pure, no DB)', () => {
  it('is deterministic: the same cap always derives the same key', () => {
    const cap = fakeCap();
    expect(deriveCapKey(cap)).toEqual(deriveCapKey({ ...cap }));
  });

  it('two caps differing only in scope_ref_id derive different keys (never collapsed)', () => {
    const a = deriveCapKey(fakeCap({ scopeLevel: 'tracker', scopeRefId: 1 }));
    const b = deriveCapKey(fakeCap({ scopeLevel: 'tracker', scopeRefId: 2 }));
    expect(a.rewardPolicyCode).not.toBe(b.rewardPolicyCode);
  });

  it('cap_type mirrors cap_class, fitting the varchar(30) column', () => {
    const budget = deriveCapKey(fakeCap({ capClass: 'budget' }));
    const limit = deriveCapKey(fakeCap({ capClass: 'limit' }));
    expect(budget.capType).toBe('budget');
    expect(limit.capType).toBe('limit');
    expect(budget.rewardPolicyCode.length).toBeLessThanOrEqual(80);
    expect(budget.capType.length).toBeLessThanOrEqual(30);
  });
});

describe('resolveFixedRewardValue (pure, no DB)', () => {
  it('resolves policies_json.fixedAmount', () => {
    expect(resolveFixedRewardValue(fakeReward({ policiesJson: '{"fixedAmount":"25.50"}' }))).toBe(
      '25.50',
    );
  });

  it('falls back to policies_json.amount when fixedAmount is absent', () => {
    expect(resolveFixedRewardValue(fakeReward({ policiesJson: '{"amount":"5"}' }))).toBe('5');
  });

  it('throws on unparseable JSON', () => {
    expect(() => resolveFixedRewardValue(fakeReward({ policiesJson: '{not json' }))).toThrow();
  });

  it('throws when neither fixedAmount nor amount is present', () => {
    expect(() => resolveFixedRewardValue(fakeReward({ policiesJson: '{"rate": 0.1}' }))).toThrow(
      /resolvable/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Real Postgres, rap_app role — TC-1..9, driven end to end through RuleEvaluationRowHandler.
// ---------------------------------------------------------------------------------------------

describe('Budget/cap enforcement (real Postgres, rap_app role)', () => {
  let sequelize: Sequelize;
  let fanOutRepository: ActivityLogsRepository;
  let progressRepository: TrackerComponentProgressRepository;
  let trackerStatusRepository: TrackerStatusRepository;
  let budgetRepository: BudgetConsumptionRepository;
  let customerLimitRepository: CustomerLimitConsumptionRepository;
  let rewardEntryRepository: RewardEntryRepository;
  let rewardEntryOutboxRepository: RewardEntryOutboxRepository;
  let ruleEvaluator: RuleEvaluatorService;
  const resolver: AdvisoryLockTimeoutResolver = { getAdvisoryLockWaitTimeoutMs: () => 5000 };

  beforeAll(async () => {
    sequelize = new Sequelize({
      dialect: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_NAME,
      username: process.env.DB_APP_USERNAME,
      password: process.env.DB_APP_PASSWORD,
      logging: false,
      pool: { max: 10 },
    });
    await sequelize.authenticate();
    fanOutRepository = new ActivityLogsRepository(sequelize);
    progressRepository = new TrackerComponentProgressRepository(sequelize);
    trackerStatusRepository = new TrackerStatusRepository(
      sequelize,
      new TrackerCompletionEvaluatorService(),
    );
    budgetRepository = new BudgetConsumptionRepository(sequelize);
    customerLimitRepository = new CustomerLimitConsumptionRepository(sequelize);
    rewardEntryRepository = new RewardEntryRepository(sequelize);
    rewardEntryOutboxRepository = new RewardEntryOutboxRepository(sequelize);
    ruleEvaluator = new RuleEvaluatorService();
  });

  afterAll(async () => {
    // T-RAP-034: `reward_entry_outbox` FKs into `reward_entry`, so it must be cleared first.
    await sequelize.query(
      `DELETE FROM realtime_activity_processing.reward_entry_outbox
        WHERE reward_entry_id IN (
          SELECT id FROM realtime_activity_processing.reward_entry WHERE tenant_id = :tenantId
        )`,
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    for (const table of [
      'reward_entry',
      'budget_consumption',
      'customer_reward_limit_consumption',
      'customer_tracker_status',
      'customer_tracker_component_progress',
      'activity_logs',
    ]) {
      await sequelize.query(
        `DELETE FROM realtime_activity_processing.${table} WHERE tenant_id = :tenantId`,
        { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
      );
    }
    await sequelize.close();
  });

  function fakeBreachCallback(
    impl: (report: unknown) => Promise<void> = () => Promise.resolve(),
  ): BudgetBreachCallbackClient & { reportBreach: jest.Mock } {
    return { reportBreach: jest.fn(impl) } as unknown as BudgetBreachCallbackClient & {
      reportBreach: jest.Mock;
    };
  }

  function rule(overrides: Partial<BoundRuleProto> = {}): BoundRuleProto {
    return {
      ruleId: 1,
      ruleVersionId: 1,
      versionNo: 1,
      ruleCode: 'RULE_MIN_VALUE',
      expression: 'activity.activity_value >= 1',
      parametersJson: '{}',
      boundValuesJson: '{}',
      trackerComponentId: 901,
      status: 'active',
      ...overrides,
    };
  }

  function trackerComponentProto(
    componentId: number,
    componentCode: string,
  ): TrackerComponentProto {
    return {
      componentId,
      componentCode,
      name: componentCode,
      activityId: 701,
      sequenceOrder: 1,
      isMandatory: true,
      status: 'active',
    };
  }

  function campaignConfig(overrides: {
    campaignCode: string;
    campaignId?: number;
    trackerCode: string;
    componentId: number;
    componentCode: string;
    rewards: BoundRewardProto[];
    caps: CampaignCapProto[];
  }): CampaignConfigProto {
    return {
      campaignId: overrides.campaignId ?? 9200,
      campaignCode: overrides.campaignCode,
      tenantId: TENANT_ID,
      countryId: 1,
      status: 'active',
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-12-31T00:00:00.000Z',
      budget: { amount: '10000.00', currency: 'MYR' },
      maxParticipants: 1000,
      merchants: [],
      trackers: [
        {
          trackerId: 8200,
          trackerCode: overrides.trackerCode,
          name: overrides.trackerCode,
          completionLogic: 'any',
          completionThreshold: 0,
          status: 'active',
          components: [trackerComponentProto(overrides.componentId, overrides.componentCode)],
        },
      ],
      rules: [
        rule({
          ruleId: overrides.componentId,
          ruleCode: `RULE_${overrides.componentId}`,
          trackerComponentId: overrides.componentId,
        }),
      ],
      rewards: overrides.rewards,
      etag: 'etag-1',
      configHash: 'hash-1',
      notModified: false,
      servedAt: '2026-01-01T00:00:00.000Z',
      caps: overrides.caps,
      sectionsReturned: ['BASIC', 'MERCHANTS', 'TRACKERS', 'RULES', 'REWARDS', 'CAPS'],
      sectionsOmitted: [],
    } as CampaignConfigProto;
  }

  function fakeCacheFor(config: CampaignConfigProto): CampaignConfigCacheService {
    return {
      lookupByActivityCode: () => [],
      lookupByTransactionType: () => [],
      resolveExternalCode: () => undefined,
      getCampaignConfig: () => ({
        tenantId: config.tenantId,
        campaignId: config.campaignId,
        campaignCode: config.campaignCode,
        status: config.status,
        isActive: true,
        etag: config.etag,
        configHash: config.configHash,
        raw: config,
      }),
    } as unknown as CampaignConfigCacheService;
  }

  function buildHandler(
    config: CampaignConfigProto,
    breachCallback: BudgetBreachCallbackClient = fakeBreachCallback(),
    metrics: MetricsService = new MetricsService(),
  ): RuleEvaluationRowHandler {
    const capEnforcement = new CapEnforcementService(
      budgetRepository,
      customerLimitRepository,
      breachCallback,
      fakeLoggerFactory(),
    );
    return new RuleEvaluationRowHandler(
      sequelize,
      fakeCacheFor(config),
      ruleEvaluator,
      progressRepository,
      trackerStatusRepository,
      resolver,
      capEnforcement,
      rewardEntryRepository,
      rewardEntryOutboxRepository,
      metrics,
      fakeLoggerFactory(),
    );
  }

  function pendingRowInput(overrides: Partial<FanOutRowInput> = {}): FanOutRowInput {
    return {
      correlationId: '55555555-5555-4555-8555-555555555555',
      dedupKey: `dedup-${Math.random().toString(36).slice(2)}`,
      tenantId: TENANT_ID,
      customerIdEncrypted: 'ciphertext-base64==',
      customerIdHash: 'e'.repeat(64),
      customerIdType: 'INTERNAL_ID',
      activityPerformedDate: new Date(),
      transactionType: null,
      activityCode: 'PURCHASE',
      activityType: 'TRANSACTION',
      activityCategory: 'RETAIL',
      activityValue: '10.0000',
      activityValueUnit: 'MYR',
      channel: 'WEB',
      activityPerformedEnv: 'PROD',
      activityName: 'Online purchase',
      campaignCode: 'CAMPB',
      trackerCode: 'TRKB',
      trackerComponentCode: 'COMPB',
      merchantCode: null,
      sourceTransport: 'GRPC',
      ...overrides,
    };
  }

  /**
   * T-RAP-048 retry 2/3: claims the exact row this call just inserted, by the primary key
   * `insertFanOutRows()` already returns — not `claimRepository.claimNextPendingRow()`'s
   * genuinely global "oldest pending row" scan this helper used through retry 1.
   *
   * Retry 1 kept that global scan and mitigated cross-suite contention with a give-back loop
   * (release any claimed row that doesn't belong to `TENANT_ID`, bumping `activity_reached_date`
   * so a released row can't re-win the very next scan). Independent re-verification proved that
   * mitigation incomplete for two separate reasons, reproduced for real in this very file (TC-8):
   *   1. A fixed attempt budget (300) is still exhaustible under genuine full-parallel `npm test`
   *      contention — it was only ever a question of how much contention, not whether.
   *   2. The give-back loop's match condition (`next.tenant_id === TENANT_ID`) accepts *any*
   *      pending row belonging to this file's tenant, not specifically the row this call just
   *      inserted. If an *earlier* `insertAndClaim()` call sharing this file's single `TENANT_ID`
   *      ever exhausted its own attempt budget under load, its freshly-inserted row was left
   *      stranded `pending` — and a *later* call in this same file could then claim that stranded
   *      row instead of its own: exactly what independent review observed for real (TC-6's
   *      `insertAndClaim()` exhausting its budget under full-suite contention left TC-6's own row
   *      stranded, and TC-8 — sharing this file's `TENANT_ID` — then claimed it instead of its
   *      own, tripping a wrong-tracker/component error) — see the regression test below, which
   *      reproduces this deterministically.
   *
   * Claiming by the exact `id` this call's own insert produced removes both failure modes at
   * once, with no retry budget or timing dependency of any kind: there is nothing to scan and
   * nothing to give back, so neither another suite's row nor an earlier test's stranded row can
   * ever be returned here — this statement can only ever touch the one row this call itself just
   * inserted.
   */
  async function insertAndClaim(overrides: Partial<FanOutRowInput> = {}): Promise<ActivityLogRow> {
    const [inserted] = await sequelize.transaction((t) =>
      fanOutRepository.insertFanOutRows([pendingRowInput(overrides)], t),
    );
    if (!inserted) {
      throw new Error(
        'Failed to insert the row this test needs to claim (unexpected dedup conflict)',
      );
    }
    const claimed = await sequelize.query<ActivityLogRow>(
      `UPDATE realtime_activity_processing.activity_logs
          SET status = 'processing', updated_at = now()
        WHERE id = :id AND status = 'pending'
        RETURNING *`,
      { type: QueryTypes.SELECT, replacements: { id: inserted.id } },
    );
    if (claimed.length === 0) {
      throw new Error('Failed to claim the row this test just inserted');
    }
    return claimed[0];
  }

  // T-RAP-048 retry 1 regression, kept as an adjacent-behaviour guard (TC-4): a foreign-tenant row
  // must never affect `insertAndClaim()`. This was a real livelock risk when `insertAndClaim()`
  // scanned the global claim queue (retry 1's give-back loop); with retry 2's by-id claim, this
  // property now holds trivially by construction (`insertAndClaim()` never looks at any row but
  // the one it just inserted), so this test now mostly documents that the property still holds —
  // left in place rather than deleted so a future regression back to a scanning strategy would
  // still be caught here.
  it('T-RAP-048 regression: insertAndClaim finds its own row despite an unclaimed foreign-tenant row ahead of it in the queue', async () => {
    const noiseTenantId = TENANT_ID + 111_111;
    try {
      await sequelize.transaction((t) =>
        fanOutRepository.insertFanOutRows(
          [pendingRowInput({ tenantId: noiseTenantId, trackerComponentCode: 'NOISE-T048' })],
          t,
        ),
      );

      const row = await insertAndClaim({ trackerComponentCode: 'COMP-T048-TARGET' });

      expect(row.tracker_component_code).toBe('COMP-T048-TARGET');
    } finally {
      await sequelize.query(
        'DELETE FROM realtime_activity_processing.activity_logs WHERE tenant_id = :tenantId',
        { type: QueryTypes.RAW, replacements: { tenantId: noiseTenantId } },
      );
    }
  });

  // T-RAP-048 retry 2/3 regression — the failure independent review actually reproduced under
  // real full-suite load (this file's own TC-8): `insertAndClaim()` must claim the exact row it
  // just inserted, never a *different* pending row that merely happens to share this file's own
  // `TENANT_ID`. Retry 1's give-back loop matched on `tenant_id` alone, so if an earlier call in
  // this same file ever exhausted its own attempt budget under contention, its freshly-inserted
  // row was left stranded `pending` — and a later call sharing the same `TENANT_ID` could then
  // claim that stranded row instead of its own, tripping a wrong-tracker/component error even
  // though nothing about the later call's own row or fixtures was wrong.
  //
  // Deterministic, no real cross-suite contention required: seeds a same-tenant "stranded" row
  // directly — simulating exactly what a starved earlier `insertAndClaim()` call would leave
  // behind — *before* calling `insertAndClaim()` for a distinct target row. Manually verified
  // against the retry-1 helper (global scan + tenant-only match): with a same-tenant, older,
  // still-`pending` row sitting in the queue, `claimNextPendingRow()`'s own
  // `ORDER BY activity_reached_date` returns that older stranded row first, retry 1's match
  // condition (`next.tenant_id === TENANT_ID`) accepts it immediately, and `insertAndClaim()`
  // returns the *stranded* row — so this test's first assertion below failed
  // (`row.tracker_component_code` was `'STRANDED-T048-2'`, not `'COMP-T048-TARGET-2'`) every time
  // reverted to retry 1. Fixed (claim by this call's own known id): always returns the row this
  // call itself inserted, regardless of what else is sitting `pending` in the queue, and the
  // stranded row is left untouched.
  it("T-RAP-048 retry 2/3 regression: insertAndClaim never claims a different pending row that only shares this file's TENANT_ID", async () => {
    await sequelize.transaction((t) =>
      fanOutRepository.insertFanOutRows(
        [pendingRowInput({ trackerComponentCode: 'STRANDED-T048-2' })],
        t,
      ),
    );

    const row = await insertAndClaim({ trackerComponentCode: 'COMP-T048-TARGET-2' });

    expect(row.tracker_component_code).toBe('COMP-T048-TARGET-2');

    const strandedRows = await sequelize.query<ActivityLogRow>(
      `SELECT * FROM realtime_activity_processing.activity_logs
        WHERE tenant_id = :tenantId AND tracker_component_code = 'STRANDED-T048-2'`,
      { type: QueryTypes.SELECT, replacements: { tenantId: TENANT_ID } },
    );
    expect(strandedRows).toHaveLength(1);
    expect(strandedRows[0].status).toBe('pending');
  });

  async function loadActivityLog(id: string): Promise<ActivityLogRow> {
    const rows = await sequelize.query<ActivityLogRow>(
      'SELECT * FROM realtime_activity_processing.activity_logs WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    return rows[0];
  }

  async function loadBudgetRow(
    cap: CampaignCapProto,
    campaignCode: string,
  ): Promise<BudgetConsumptionRow | null> {
    const capKey = deriveCapKey(cap);
    const { periodStart } = computePeriodBucket(cap, new Date());
    const rows = await sequelize.query<BudgetConsumptionRow>(
      `SELECT * FROM realtime_activity_processing.budget_consumption
        WHERE tenant_id = :tenantId AND campaign_code = :campaignCode
          AND reward_policy_code = :rewardPolicyCode AND cap_type = :capType
          AND period_start = :periodStart`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId: TENANT_ID,
          campaignCode,
          rewardPolicyCode: capKey.rewardPolicyCode,
          capType: capKey.capType,
          periodStart: cap.periodType === 'lifetime' ? LIFETIME_PERIOD_START : periodStart,
        },
      },
    );
    return rows[0] ?? null;
  }

  // TC-1: plenty of headroom.
  it('TC-1: a cap with plenty of headroom reserves successfully, both consumption rows incremented', async () => {
    const customerIdHash = `tc1-${Math.random().toString(36).slice(2)}`;
    const reward = fakeReward({
      rewardId: 9301,
      systemCode: 'RWD_TC1',
      refId: 9301,
      level: 'component',
    });
    const cap = fakeCap({ maxTotalAmount: '1000.00', maxOccurrences: 100 });
    const config = campaignConfig({
      campaignCode: 'CAMP_TC1',
      trackerCode: 'TRK_TC1',
      componentId: 9301,
      componentCode: 'COMP_TC1',
      rewards: [reward],
      caps: [cap],
    });
    const metrics = new MetricsService();
    const handler = buildHandler(config, fakeBreachCallback(), metrics);

    const row = await insertAndClaim({
      customerIdHash,
      campaignCode: 'CAMP_TC1',
      trackerCode: 'TRK_TC1',
      trackerComponentCode: 'COMP_TC1',
    });
    await handler.handle(row);

    const activityLog = await loadActivityLog(row.id);
    expect(activityLog.status).toBe('processed');

    const budgetRow = await loadBudgetRow(cap, 'CAMP_TC1');
    expect(budgetRow).not.toBeNull();
    expect(budgetRow?.consumed_amount).toBe('10.0000');
    expect(budgetRow?.consumed_count).toBe(1);

    // T-RAP-059: a granted (non-breached) assignment reports rewards_created_total, never
    // budget_breach_total.
    expect(
      metrics.getCounterValue('rewards_created_total', {
        campaign_code: 'CAMP_TC1',
        reward_category: 'cashback',
      }),
    ).toBe(1);
    expect(metrics.getCounterValue('budget_breach_total', { campaign_code: 'CAMP_TC1' })).toBe(0);
  });

  // TC-2: already at max_occurrences.
  it('TC-2: a cap already at max_occurrences breaches — activity_logs.status = error, comment names the cap', async () => {
    const customerIdHash = `tc2-${Math.random().toString(36).slice(2)}`;
    const reward = fakeReward({
      rewardId: 9302,
      systemCode: 'RWD_TC2',
      refId: 9302,
      level: 'component',
    });
    const cap = fakeCap({ maxTotalAmount: '', maxOccurrences: 1 });
    const config = campaignConfig({
      campaignCode: 'CAMP_TC2',
      trackerCode: 'TRK_TC2',
      componentId: 9302,
      componentCode: 'COMP_TC2',
      rewards: [reward],
      caps: [cap],
    });

    // Pre-seed the cap at its ceiling via the real repository (same code path production uses).
    const { periodStart, periodEnd } = computePeriodBucket(cap, new Date());
    const capKey = deriveCapKey(cap);
    await sequelize.transaction(async (t) => {
      const seedRow = await budgetRepository.lockOrCreate(t, {
        tenantId: TENANT_ID,
        campaignCode: 'CAMP_TC2',
        rewardPolicyCode: capKey.rewardPolicyCode,
        capType: capKey.capType,
        periodStart,
        periodEnd,
      });
      await budgetRepository.increment(t, seedRow.id, '0', 1);
    });

    const metrics = new MetricsService();
    const handler = buildHandler(config, fakeBreachCallback(), metrics);
    const row = await insertAndClaim({
      customerIdHash,
      campaignCode: 'CAMP_TC2',
      trackerCode: 'TRK_TC2',
      trackerComponentCode: 'COMP_TC2',
    });
    await handler.handle(row);

    const activityLog = await loadActivityLog(row.id);
    expect(activityLog.status).toBe('error');
    expect(activityLog.comment).toContain('cap breach');
    expect(activityLog.comment).toContain('count');

    const budgetRow = await loadBudgetRow(cap, 'CAMP_TC2');
    expect(budgetRow?.consumed_count).toBe(1); // unchanged — denial never increments.

    // T-RAP-059: budget_breach_total{campaign_code,cap_type} — cap_type is `deriveCapKey(cap)
    // .capType` (this cap's own `cap_class`, "budget"), read by the caller rather than
    // re-derived — and rewards_created_total must NOT have incremented for a denied assignment.
    expect(
      metrics.getCounterValue('budget_breach_total', {
        campaign_code: 'CAMP_TC2',
        cap_type: deriveCapKey(cap).capType,
      }),
    ).toBe(1);
    expect(
      metrics.getCounterValue('rewards_created_total', {
        campaign_code: 'CAMP_TC2',
        reward_category: 'cashback',
      }),
    ).toBe(0);
  });

  // TC-3: already at max_total_amount (amount variant).
  it('TC-3: a cap already at max_total_amount breaches — same as TC-2, amount variant', async () => {
    const customerIdHash = `tc3-${Math.random().toString(36).slice(2)}`;
    const reward = fakeReward({
      rewardId: 9303,
      systemCode: 'RWD_TC3',
      refId: 9303,
      level: 'component',
      policiesJson: JSON.stringify({ fixedAmount: '10.00' }),
    });
    const cap = fakeCap({ maxTotalAmount: '5.00', maxOccurrences: 0 });
    const config = campaignConfig({
      campaignCode: 'CAMP_TC3',
      trackerCode: 'TRK_TC3',
      componentId: 9303,
      componentCode: 'COMP_TC3',
      rewards: [reward],
      caps: [cap],
    });
    const handler = buildHandler(config);

    const row = await insertAndClaim({
      customerIdHash,
      campaignCode: 'CAMP_TC3',
      trackerCode: 'TRK_TC3',
      trackerComponentCode: 'COMP_TC3',
    });
    await handler.handle(row);

    const activityLog = await loadActivityLog(row.id);
    expect(activityLog.status).toBe('error');
    expect(activityLog.comment).toContain('amount');

    const budgetRow = await loadBudgetRow(cap, 'CAMP_TC3');
    expect(budgetRow?.consumed_amount).toBe('0.0000');
  });

  // TC-4: two assignments on the same completion, one breaches, one has headroom.
  it('TC-4: one assignment breaches, a sibling assignment with headroom still reserves', async () => {
    const customerIdHash = `tc4-${Math.random().toString(36).slice(2)}`;
    const breachedReward = fakeReward({
      rewardId: 9401,
      systemCode: 'RWD_TC4_BREACH',
      refId: 9404,
      level: 'component',
      unitType: 'currency',
      unitCode: 'MYR',
    });
    const headroomReward = fakeReward({
      rewardId: 9402,
      systemCode: 'RWD_TC4_OK',
      refId: 9404,
      level: 'component',
      unitType: 'points',
      unitCode: 'PTS',
      policiesJson: JSON.stringify({ fixedAmount: '5' }),
    });
    const breachedCap = fakeCap({ unitType: 'currency', unitCode: 'MYR', maxOccurrences: 1 });
    const headroomCap = fakeCap({ unitType: 'points', unitCode: 'PTS', maxTotalAmount: '1000' });
    const config = campaignConfig({
      campaignCode: 'CAMP_TC4',
      trackerCode: 'TRK_TC4',
      componentId: 9404,
      componentCode: 'COMP_TC4',
      rewards: [breachedReward, headroomReward],
      caps: [breachedCap, headroomCap],
    });

    // Pre-seed the MYR cap at its ceiling.
    const { periodStart, periodEnd } = computePeriodBucket(breachedCap, new Date());
    const capKey = deriveCapKey(breachedCap);
    await sequelize.transaction(async (t) => {
      const seedRow = await budgetRepository.lockOrCreate(t, {
        tenantId: TENANT_ID,
        campaignCode: 'CAMP_TC4',
        rewardPolicyCode: capKey.rewardPolicyCode,
        capType: capKey.capType,
        periodStart,
        periodEnd,
      });
      await budgetRepository.increment(t, seedRow.id, '0', 1);
    });

    const handler = buildHandler(config);
    const row = await insertAndClaim({
      customerIdHash,
      campaignCode: 'CAMP_TC4',
      trackerCode: 'TRK_TC4',
      trackerComponentCode: 'COMP_TC4',
    });
    await handler.handle(row);

    const activityLog = await loadActivityLog(row.id);
    // At least one assignment denied -> row status is 'error', even though the other succeeded.
    expect(activityLog.status).toBe('error');
    expect(activityLog.comment).toContain('RWD_TC4_BREACH');

    const headroomRow = await loadBudgetRow(headroomCap, 'CAMP_TC4');
    expect(headroomRow?.consumed_count).toBe(1);
    expect(headroomRow?.consumed_amount).toBe('5.0000');

    // T-RAP-034: the sibling assignment's headroom actually resulted in a real `reward_entry`
    // row, not just a comment string — the observable property `05-PROCESSING-PIPELINE.md` §6
    // point 2's "a sibling assignment with headroom still reserves normally" is really about.
    const rewardEntryRows = await sequelize.query(
      `SELECT reward_code FROM realtime_activity_processing.reward_entry
        WHERE tenant_id = :tenantId AND campaign_code = 'CAMP_TC4'`,
      { type: QueryTypes.SELECT, replacements: { tenantId: TENANT_ID } },
    );
    expect(rewardEntryRows).toEqual([{ reward_code: 'RWD_TC4_OK' }]);
  });

  // TC-5: THE load-bearing concurrency proof — two different customers, same pooled campaign
  // budget, exactly enough headroom for one. Real Postgres, two genuinely concurrent
  // transactions (Promise.all over the same pooled Sequelize instance, same pattern
  // `rule-evaluation.spec.ts`'s own TC-4/verification-step-2 already established).
  it('TC-5: two customers concurrently claiming the same pooled budget — exactly one succeeds', async () => {
    const customerA = `tc5-a-${Math.random().toString(36).slice(2)}`;
    const customerB = `tc5-b-${Math.random().toString(36).slice(2)}`;
    const reward = fakeReward({
      rewardId: 9501,
      systemCode: 'RWD_TC5',
      refId: 9505,
      level: 'component',
    });
    const cap = fakeCap({ maxTotalAmount: '', maxOccurrences: 1 }); // room for exactly one grant
    const config = campaignConfig({
      campaignCode: 'CAMP_TC5',
      trackerCode: 'TRK_TC5',
      componentId: 9505,
      componentCode: 'COMP_TC5',
      rewards: [reward],
      caps: [cap],
    });
    const handler = buildHandler(config);

    const rowA = await insertAndClaim({
      customerIdHash: customerA,
      campaignCode: 'CAMP_TC5',
      trackerCode: 'TRK_TC5',
      trackerComponentCode: 'COMP_TC5',
    });
    const rowB = await insertAndClaim({
      customerIdHash: customerB,
      campaignCode: 'CAMP_TC5',
      trackerCode: 'TRK_TC5',
      trackerComponentCode: 'COMP_TC5',
    });

    // Genuinely concurrent: two different customers take out two different advisory-lock keys
    // (`05-PROCESSING-PIPELINE.md` §3) and proceed in parallel until they contend on the SAME
    // budget_consumption row's `SELECT ... FOR UPDATE` (R2's row-lock layer, the one under test).
    await Promise.all([handler.handle(rowA), handler.handle(rowB)]);

    const [logA, logB] = await Promise.all([loadActivityLog(rowA.id), loadActivityLog(rowB.id)]);
    const statuses = [logA.status, logB.status].sort();
    expect(statuses).toEqual(['error', 'processed']);

    const budgetRow = await loadBudgetRow(cap, 'CAMP_TC5');
    expect(budgetRow?.consumed_count).toBe(1); // never 2 — the actual overspend this task prevents.
  });

  // TC-6: on_breach = 'pause_campaign' — breach handled as TC-2/3, plus the callback fires.
  it('TC-6: on_breach = pause_campaign additionally calls the budget-breach callback', async () => {
    const customerIdHash = `tc6-${Math.random().toString(36).slice(2)}`;
    const reward = fakeReward({
      rewardId: 9601,
      systemCode: 'RWD_TC6',
      refId: 9606,
      level: 'component',
    });
    const cap = fakeCap({ maxOccurrences: 1, onBreach: 'pause_campaign' });
    const config = campaignConfig({
      campaignCode: 'CAMP_TC6',
      campaignId: 9606,
      trackerCode: 'TRK_TC6',
      componentId: 9606,
      componentCode: 'COMP_TC6',
      rewards: [reward],
      caps: [cap],
    });

    const { periodStart, periodEnd } = computePeriodBucket(cap, new Date());
    const capKey = deriveCapKey(cap);
    await sequelize.transaction(async (t) => {
      const seedRow = await budgetRepository.lockOrCreate(t, {
        tenantId: TENANT_ID,
        campaignCode: 'CAMP_TC6',
        rewardPolicyCode: capKey.rewardPolicyCode,
        capType: capKey.capType,
        periodStart,
        periodEnd,
      });
      await budgetRepository.increment(t, seedRow.id, '0', 1);
    });

    const breachCallback = fakeBreachCallback();
    const handler = buildHandler(config, breachCallback);
    const row = await insertAndClaim({
      customerIdHash,
      campaignCode: 'CAMP_TC6',
      trackerCode: 'TRK_TC6',
      trackerComponentCode: 'COMP_TC6',
    });
    await handler.handle(row);

    const activityLog = await loadActivityLog(row.id);
    expect(activityLog.status).toBe('error');
    expect(breachCallback.reportBreach).toHaveBeenCalledTimes(1);
    const [reportArg] = breachCallback.reportBreach.mock.calls[0];
    expect(reportArg.campaignId).toBe(9606);
    expect(reportArg.campaignCode).toBe('CAMP_TC6');
    expect(reportArg.cap).toEqual(cap);
    expect(typeof reportArg.observedTotal).toBe('string');
  });

  // TC-7 — `reward_entry_date` is "now(), computed once, passed through"
  // (`05-PROCESSING-PIPELINE.md` §6 point 2), not the activity's own historical
  // `activity_performed_date` — so this exercises `CapEnforcementService.enforceForCompletion`
  // directly (real Postgres, real repositories, the exact production code path) with two explicit
  // `rewardEntryDate`s either side of a daily rollover, rather than through the row handler (which
  // always resolves `rewardEntryDate` to the real wall-clock `now()`). The pure bucketing math
  // itself is `period-bucket.spec.ts`'s own TC-7.
  it("TC-7: a daily cap's consumption never leaks across a period rollover", async () => {
    const reward = fakeReward({
      rewardId: 9701,
      systemCode: 'RWD_TC7',
      refId: 9707,
      level: 'component',
    });
    const cap = fakeCap({
      periodType: 'daily',
      periodTimezone: 'UTC',
      maxOccurrences: 0,
      maxTotalAmount: '1000',
    });
    const capEnforcement = new CapEnforcementService(
      budgetRepository,
      customerLimitRepository,
      fakeBreachCallback(),
      fakeLoggerFactory(),
    );

    async function enforceOn(rewardEntryDate: Date, customerIdHash: string): Promise<void> {
      await sequelize.transaction((t) =>
        capEnforcement.enforceForCompletion(t, {
          correlationId: 'corr-tc7',
          tenantId: TENANT_ID,
          campaignId: 9707,
          campaignCode: 'CAMP_TC7',
          customerIdHash,
          trackerId: 8200,
          rewardEntryDate,
          assignments: [reward],
          caps: [cap],
        }),
      );
    }

    await enforceOn(
      new Date('2026-05-01T10:00:00.000Z'),
      `tc7-day1-${Math.random().toString(36).slice(2)}`,
    );
    await enforceOn(
      new Date('2026-05-02T10:00:00.000Z'),
      `tc7-day2-${Math.random().toString(36).slice(2)}`,
    );

    const rows = await sequelize.query<BudgetConsumptionRow>(
      `SELECT * FROM realtime_activity_processing.budget_consumption
        WHERE tenant_id = :tenantId AND campaign_code = 'CAMP_TC7'
        ORDER BY period_start ASC`,
      { type: QueryTypes.SELECT, replacements: { tenantId: TENANT_ID } },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].consumed_count).toBe(1);
    expect(rows[1].consumed_count).toBe(1);
    expect(rows[0].period_start.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(rows[1].period_start.toISOString()).toBe('2026-05-02T00:00:00.000Z');
  });

  // TC-8: on_breach = 'alert_only' — breach handled as TC-2/3, no portal call.
  it('TC-8: on_breach = alert_only breaches with no reward and no callback', async () => {
    const customerIdHash = `tc8-${Math.random().toString(36).slice(2)}`;
    const reward = fakeReward({
      rewardId: 9801,
      systemCode: 'RWD_TC8',
      refId: 9808,
      level: 'component',
    });
    const cap = fakeCap({ maxOccurrences: 1, onBreach: 'alert_only' });
    const config = campaignConfig({
      campaignCode: 'CAMP_TC8',
      trackerCode: 'TRK_TC8',
      componentId: 9808,
      componentCode: 'COMP_TC8',
      rewards: [reward],
      caps: [cap],
    });

    const { periodStart, periodEnd } = computePeriodBucket(cap, new Date());
    const capKey = deriveCapKey(cap);
    await sequelize.transaction(async (t) => {
      const seedRow = await budgetRepository.lockOrCreate(t, {
        tenantId: TENANT_ID,
        campaignCode: 'CAMP_TC8',
        rewardPolicyCode: capKey.rewardPolicyCode,
        capType: capKey.capType,
        periodStart,
        periodEnd,
      });
      await budgetRepository.increment(t, seedRow.id, '0', 1);
    });

    const breachCallback = fakeBreachCallback();
    const handler = buildHandler(config, breachCallback);
    const row = await insertAndClaim({
      customerIdHash,
      campaignCode: 'CAMP_TC8',
      trackerCode: 'TRK_TC8',
      trackerComponentCode: 'COMP_TC8',
    });
    await handler.handle(row);

    const activityLog = await loadActivityLog(row.id);
    expect(activityLog.status).toBe('error');
    expect(breachCallback.reportBreach).not.toHaveBeenCalled();
  });

  // TC-9: the budget-breach callback fails (portal unreachable) — local outcome unaffected.
  it('TC-9: a failing budget-breach callback never affects the local cap denial/activity_logs outcome', async () => {
    const customerIdHash = `tc9-${Math.random().toString(36).slice(2)}`;
    const reward = fakeReward({
      rewardId: 9901,
      systemCode: 'RWD_TC9',
      refId: 9909,
      level: 'component',
    });
    const cap = fakeCap({ maxOccurrences: 1, onBreach: 'pause_campaign' });
    const config = campaignConfig({
      campaignCode: 'CAMP_TC9',
      trackerCode: 'TRK_TC9',
      componentId: 9909,
      componentCode: 'COMP_TC9',
      rewards: [reward],
      caps: [cap],
    });

    const { periodStart, periodEnd } = computePeriodBucket(cap, new Date());
    const capKey = deriveCapKey(cap);
    await sequelize.transaction(async (t) => {
      const seedRow = await budgetRepository.lockOrCreate(t, {
        tenantId: TENANT_ID,
        campaignCode: 'CAMP_TC9',
        rewardPolicyCode: capKey.rewardPolicyCode,
        capType: capKey.capType,
        periodStart,
        periodEnd,
      });
      await budgetRepository.increment(t, seedRow.id, '0', 1);
    });

    const breachCallback = fakeBreachCallback(() =>
      Promise.reject(new Error('portal unreachable (simulated)')),
    );
    const handler = buildHandler(config, breachCallback);
    const row = await insertAndClaim({
      customerIdHash,
      campaignCode: 'CAMP_TC9',
      trackerCode: 'TRK_TC9',
      trackerComponentCode: 'COMP_TC9',
    });

    // Must not throw/reject even though the callback itself does.
    await expect(handler.handle(row)).resolves.toBeUndefined();

    const activityLog = await loadActivityLog(row.id);
    expect(activityLog.status).toBe('error');
    expect(activityLog.comment).toContain('cap breach');
    expect(breachCallback.reportBreach).toHaveBeenCalledTimes(1);
  });
});
