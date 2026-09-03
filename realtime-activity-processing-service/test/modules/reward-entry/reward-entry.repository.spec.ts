/**
 * T-RAP-034. Covers `RewardEntryRepository`/`RewardEntryOutboxRepository` against the real local
 * Postgres 16 server (root `CLAUDE.md`), connected as the real least-privilege `rap_app` role —
 * same "persistence tests against the real DB, driven through the real handler end to end" split
 * `cap-enforcement.spec.ts` (T-RAP-033) already established for this file-scope owner's task chain.
 *
 * TC-1/TC-8 are driven through `RuleEvaluationRowHandler.handle()` exactly as production traffic
 * would (same rationale as every prior Wave 3 spec in this directory: proves the `reward_entry`/
 * `reward_entry_outbox` inserts really happen inside the same transaction T-RAP-031/033 opened, not
 * a separately-wired call). The repository-level methods dispatch tiers depend on
 * (`findById`/`markDispatched`/...) are covered directly against a hand-inserted row, faster and
 * more precise than routing every case back through the full pipeline.
 */
import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { CapEnforcementService } from '@/modules/budget/cap-enforcement.service';
import { BudgetConsumptionRepository } from '@/modules/budget/budget-consumption.repository';
import { CustomerLimitConsumptionRepository } from '@/modules/budget/customer-limit-consumption.repository';
import type { BudgetBreachCallbackClient } from '@/modules/budget/budget-breach-callback.client';
import { TrackerCompletionEvaluatorService } from '@/modules/processing/tracker-completion-evaluator.service';
import { TrackerStatusRepository } from '@/modules/processing/tracker-status.repository';
import { TrackerComponentProgressRepository } from '@/modules/processing/tracker-component-progress.repository';
import { RuleEvaluationRowHandler } from '@/modules/processing/rule-evaluation-row-handler.service';
import { RuleEvaluatorService } from '@/modules/processing/rule-evaluator.service';
import type { AdvisoryLockTimeoutResolver } from '@/modules/processing/processing.config';
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
import { RewardEntryRepository } from '@/modules/reward-entry/reward-entry.repository';
import {
  RewardEntryOutboxRepository,
  REWARD_ENTRY_CREATED_TOPIC,
} from '@/modules/reward-entry/reward-entry-outbox.repository';
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

const TENANT_ID = 970_000 + Math.floor(Math.random() * 29_999);

describe('RewardEntryRepository / RewardEntryOutboxRepository (real Postgres, rap_app role)', () => {
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

  function fakeBreachCallback(): BudgetBreachCallbackClient {
    return {
      reportBreach: jest.fn(() => Promise.resolve()),
    } as unknown as BudgetBreachCallbackClient;
  }

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
      campaignId: overrides.campaignId ?? 9300,
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
          trackerId: 8300,
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
    metrics: MetricsService = new MetricsService(),
  ): RuleEvaluationRowHandler {
    const capEnforcement = new CapEnforcementService(
      budgetRepository,
      customerLimitRepository,
      fakeBreachCallback(),
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
      correlationId: '66666666-6666-4666-8666-666666666666',
      dedupKey: `dedup-${Math.random().toString(36).slice(2)}`,
      tenantId: TENANT_ID,
      customerIdEncrypted: 'ciphertext-base64==',
      customerIdHash: 'f'.repeat(64),
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
      campaignCode: 'CAMPC',
      trackerCode: 'TRKC',
      trackerComponentCode: 'COMPC',
      merchantCode: null,
      sourceTransport: 'GRPC',
      ...overrides,
    };
  }

  // T-RAP-034 retry 2/3 (review-flagged). Two things this helper tried and rejected, in order,
  // are worth recording so a future reader doesn't re-walk the same path:
  //
  // 1. This helper used to loop the genuinely global `claimNextPendingRow()` scan
  //    (`05-PROCESSING-PIPELINE.md` §4 — intentionally table-wide, not tenant-scoped, for
  //    production correctness) and give back every non-matching foreign row — the same
  //    "give-back-a-foreign-tenant's-row" precedent every prior Wave 3 spec in this directory
  //    established (T-RAP-047/048's own filed concern). Applying T-RAP-047's own fix (bump
  //    `activity_reached_date` on give-back, `maxAttempts` 20 -> 300) removed the genuine
  //    livelock, but re-running the full unscoped `npm test` repeatedly against this real, shared
  //    Postgres instance (9-way Jest parallelism, 51 suites all inserting/claiming into the same
  //    `activity_logs` table concurrently) still measurably reproduced "Failed to claim the row
  //    this test just inserted" in 4 of 12 consecutive full runs even with that exact fix applied
  //    everywhere in this repo.
  // 2. Claiming our own row directly by `id` (`UPDATE ... WHERE id = :id AND status = 'pending'`,
  //    still `FOR UPDATE SKIP LOCKED`) removes the scan entirely, but a *second*, narrower race
  //    remained and was also reproduced against the real full suite: another suite's own
  //    genuinely-global `claimNextPendingRow()` call (`claim-worker.spec.ts`'s own concurrent-claim
  //    tests, or the live claim worker exercised end-to-end elsewhere) can grab *our* row the
  //    instant after it commits as `pending` and before this statement runs — and at least one
  //    such caller in this codebase (`claim-worker.spec.ts`'s own "many concurrent claim attempts
  //    against one pending row" case) does not check tenant ownership and give back what it
  //    doesn't recognize, so a stolen row can stay `processing` forever, not just transiently.
  //
  // The fix that is actually race-free: insert the row and claim it (flip it to `processing`) in
  // the *same* transaction, before it ever commits. Postgres never exposes an uncommitted row to
  // another session (true regardless of isolation level — this is not relying on `SERIALIZABLE`
  // or any special setting), so no concurrently-running suite's `claimNextPendingRow()` can ever
  // see this row in `pending` state at all — it goes straight from "does not exist yet" to
  // "processing" the instant it becomes visible. No scan, no give-back, no retry, no window.
  async function insertAndClaim(overrides: Partial<FanOutRowInput> = {}): Promise<ActivityLogRow> {
    const claimed = await sequelize.transaction(async (t) => {
      const [inserted] = await fanOutRepository.insertFanOutRows([pendingRowInput(overrides)], t);
      const rows = await sequelize.query<ActivityLogRow>(
        `UPDATE realtime_activity_processing.activity_logs
            SET status = 'processing', updated_at = now()
          WHERE id = :id
          RETURNING *`,
        { type: QueryTypes.SELECT, replacements: { id: inserted.id }, transaction: t },
      );
      return rows[0];
    });
    if (claimed === undefined) {
      throw new Error('Failed to claim the row this test just inserted');
    }
    return claimed;
  }

  async function loadActivityLog(id: string): Promise<ActivityLogRow> {
    const rows = await sequelize.query<ActivityLogRow>(
      'SELECT * FROM realtime_activity_processing.activity_logs WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    return rows[0];
  }

  // -----------------------------------------------------------------------------------------
  // TC-1 / TC-8 — driven end to end through RuleEvaluationRowHandler.
  // -----------------------------------------------------------------------------------------

  it('TC-1: cap checks pass -> reward_entry + reward_entry_outbox rows committed together', async () => {
    const reward = fakeReward({ rewardId: 9601, systemCode: 'RWD_TC1', refId: 9604 });
    const cap = fakeCap();
    const config = campaignConfig({
      campaignCode: 'CAMP_RE_TC1',
      trackerCode: 'TRK_RE_TC1',
      componentId: 9604,
      componentCode: 'COMP_RE_TC1',
      rewards: [reward],
      caps: [cap],
    });
    const metrics = new MetricsService();
    const handler = buildHandler(config, metrics);
    const row = await insertAndClaim({
      customerIdHash: `tc1-${Math.random().toString(36).slice(2)}`,
      campaignCode: 'CAMP_RE_TC1',
      trackerCode: 'TRK_RE_TC1',
      trackerComponentCode: 'COMP_RE_TC1',
    });

    await handler.handle(row);

    const activityLog = await loadActivityLog(row.id);
    expect(activityLog.status).toBe('processed');
    expect(activityLog.comment).toContain('reward entry(ies) created');
    // T-RAP-059: one reward_entry row actually inserted -> exactly one increment, labeled by this
    // reward's own category.
    expect(
      metrics.getCounterValue('rewards_created_total', {
        campaign_code: 'CAMP_RE_TC1',
        reward_category: 'cashback',
      }),
    ).toBe(1);

    const rewardEntryRows = await sequelize.query(
      `SELECT * FROM realtime_activity_processing.reward_entry
        WHERE tenant_id = :tenantId AND campaign_code = 'CAMP_RE_TC1'`,
      { type: QueryTypes.SELECT, replacements: { tenantId: TENANT_ID } },
    );
    expect(rewardEntryRows).toHaveLength(1);
    const rewardEntry = rewardEntryRows[0] as Record<string, unknown>;
    expect(rewardEntry.reward_code).toBe('RWD_TC1');
    expect(rewardEntry.reward_category).toBe('cashback');
    expect(rewardEntry.reward_value).toBe('10.0000');
    expect(rewardEntry.reward_value_unit).toBe('MYR');
    expect(rewardEntry.completion_cycle).toBe(1);
    expect(rewardEntry.dispatch_status).toBe('pending');
    // The exact same activity_logs fields the row shape is supposed to mirror 1:1.
    expect(rewardEntry.customer_id_encrypted).toBe(row.customer_id_encrypted);
    expect(rewardEntry.correlation_id).toBe(row.correlation_id);

    const outboxRows = await sequelize.query(
      `SELECT * FROM realtime_activity_processing.reward_entry_outbox
        WHERE reward_entry_id = :id`,
      { type: QueryTypes.SELECT, replacements: { id: rewardEntry.id } },
    );
    expect(outboxRows).toHaveLength(1);
    const outboxRow = outboxRows[0] as {
      topic: string;
      status: string;
      payload: Record<string, unknown>;
    };
    expect(outboxRow.topic).toBe(REWARD_ENTRY_CREATED_TOPIC);
    expect(outboxRow.status).toBe('PENDING');
    expect(outboxRow.payload.rewardCode).toBe('RWD_TC1');
    expect(outboxRow.payload.customerIdEncrypted).toBe(row.customer_id_encrypted);
    expect(outboxRow.payload).not.toHaveProperty('customerId');
    expect(outboxRow.payload).not.toHaveProperty('customerIdHash');
  });

  it(
    'TC-8: reward_entry row still exists exactly once after the domain transaction commits, ' +
      'before any dispatch attempt — dispatch simply resumes from PENDING on restart',
    async () => {
      const reward = fakeReward({ rewardId: 9701, systemCode: 'RWD_TC8', refId: 9704 });
      const cap = fakeCap();
      const config = campaignConfig({
        campaignCode: 'CAMP_RE_TC8',
        trackerCode: 'TRK_RE_TC8',
        componentId: 9704,
        componentCode: 'COMP_RE_TC8',
        rewards: [reward],
        caps: [cap],
      });
      const handler = buildHandler(config);
      const row = await insertAndClaim({
        customerIdHash: `tc8-${Math.random().toString(36).slice(2)}`,
        campaignCode: 'CAMP_RE_TC8',
        trackerCode: 'TRK_RE_TC8',
        trackerComponentCode: 'COMP_RE_TC8',
      });

      // "Simulated crash immediately after commit, before any dispatch attempt" — `handle()`
      // itself never invokes any dispatch tier (R3/§7: dispatch is a wholly separate, later
      // concern), so simply not calling `OutboxPublisherService.runOnce()` after this already
      // models exactly that: the domain transaction committed, nothing downstream has run yet.
      await handler.handle(row);

      const rewardEntryRows = await sequelize.query(
        `SELECT * FROM realtime_activity_processing.reward_entry
          WHERE tenant_id = :tenantId AND campaign_code = 'CAMP_RE_TC8'`,
        { type: QueryTypes.SELECT, replacements: { tenantId: TENANT_ID } },
      );
      expect(rewardEntryRows).toHaveLength(1);
      const rewardEntry = rewardEntryRows[0] as Record<string, unknown>;
      expect(rewardEntry.dispatch_status).toBe('pending');
      expect(rewardEntry.dispatch_attempts).toBe(0);

      const outboxRows = await sequelize.query(
        `SELECT status FROM realtime_activity_processing.reward_entry_outbox WHERE reward_entry_id = :id`,
        { type: QueryTypes.SELECT, replacements: { id: rewardEntry.id } },
      );
      expect(outboxRows).toEqual([{ status: 'PENDING' }]);
    },
  );

  it(
    'TC-2/TC-4 (T-RAP-050): two distinct bound rewards granted on the same completion each get ' +
      'their own reward_entry row now that uc_reward_entry_completion includes reward_code ' +
      '(T-RAP-049) — the schema-gap collision this test used to document no longer applies',
    async () => {
      const rewardA = fakeReward({
        rewardId: 9801,
        systemCode: 'RWD_TC_COLLIDE_A',
        refId: 9804,
        unitType: 'currency',
        unitCode: 'MYR',
      });
      const rewardB = fakeReward({
        rewardId: 9802,
        systemCode: 'RWD_TC_COLLIDE_B',
        refId: 9804,
        unitType: 'points',
        unitCode: 'PTS',
        policiesJson: JSON.stringify({ fixedAmount: '5' }),
      });
      const capA = fakeCap({ unitType: 'currency', unitCode: 'MYR' });
      const capB = fakeCap({ unitType: 'points', unitCode: 'PTS' });
      const config = campaignConfig({
        campaignCode: 'CAMP_RE_COLLIDE',
        trackerCode: 'TRK_RE_COLLIDE',
        componentId: 9804,
        componentCode: 'COMP_RE_COLLIDE',
        rewards: [rewardA, rewardB],
        caps: [capA, capB],
      });
      const handler = buildHandler(config);
      const row = await insertAndClaim({
        customerIdHash: `tc-collide-${Math.random().toString(36).slice(2)}`,
        campaignCode: 'CAMP_RE_COLLIDE',
        trackerCode: 'TRK_RE_COLLIDE',
        trackerComponentCode: 'COMP_RE_COLLIDE',
      });

      await handler.handle(row);

      // The transaction committed successfully.
      const activityLog = await loadActivityLog(row.id);
      expect(activityLog.status).toBe('processed');
      expect(activityLog.comment).toContain('2 reward entry(ies) created');

      const rewardEntryRows = await sequelize.query(
        `SELECT reward_code FROM realtime_activity_processing.reward_entry
          WHERE tenant_id = :tenantId AND campaign_code = 'CAMP_RE_COLLIDE'`,
        { type: QueryTypes.SELECT, replacements: { tenantId: TENANT_ID } },
      );
      // Both grants now insert as their own row — reward_code discriminates them in
      // uc_reward_entry_completion (01-DATABASE.md §7, T-RAP-049).
      expect(rewardEntryRows.map((r) => (r as { reward_code: string }).reward_code).sort()).toEqual(
        ['RWD_TC_COLLIDE_A', 'RWD_TC_COLLIDE_B'],
      );

      // Both caps were genuinely reserved, matching two committed reward_entry rows one-to-one —
      // exactly the consistency T-RAP-034's original defect report flagged as broken.
      const budgetRows = await sequelize.query(
        `SELECT consumed_count FROM realtime_activity_processing.budget_consumption
          WHERE tenant_id = :tenantId AND campaign_code = 'CAMP_RE_COLLIDE'`,
        { type: QueryTypes.SELECT, replacements: { tenantId: TENANT_ID } },
      );
      expect(budgetRows).toHaveLength(2);
    },
  );

  it(
    'TC-3/TC-4 (T-RAP-050 regression): a genuine duplicate — the identical reward_code re-inserted ' +
      'for the exact same completion tuple — is still a graceful no-op, not a thrown 42P10',
    async () => {
      const row = await insertAndClaim({
        customerIdHash: `tc-dupe-${Math.random().toString(36).slice(2)}`,
        campaignCode: 'CAMP_RE_DUPE',
        trackerCode: 'TRK_RE_DUPE',
        trackerComponentCode: 'COMP_RE_DUPE',
      });
      const input = {
        row,
        rewardCode: 'RWD_DUPE',
        rewardCategory: 'cashback',
        rewardValue: '1.00',
        rewardValueUnit: 'MYR',
        completionCycle: 1,
        rewardEntryDate: new Date(),
      };

      const firstTx = await sequelize.transaction();
      const first = await rewardEntryRepository.insertForGrantedAssignment(firstTx, input);
      await firstTx.commit();
      expect(first).not.toBeNull();

      // Same tenant/customer/campaign/tracker/component/cycle/reward_code tuple, second time —
      // this is the one case uc_reward_entry_completion still needs to guard against (this file's
      // own header). Without the T-RAP-050 fix the stale 6-column ON CONFLICT list throws 42P10
      // for every insert, including this one; with it, this returns null without throwing.
      const secondTx = await sequelize.transaction();
      const second = await rewardEntryRepository.insertForGrantedAssignment(secondTx, input);
      await secondTx.commit();
      expect(second).toBeNull();

      const rows = await sequelize.query(
        `SELECT id FROM realtime_activity_processing.reward_entry
          WHERE tenant_id = :tenantId AND campaign_code = 'CAMP_RE_DUPE'`,
        { type: QueryTypes.SELECT, replacements: { tenantId: TENANT_ID } },
      );
      expect(rows).toHaveLength(1);
    },
  );

  // -----------------------------------------------------------------------------------------
  // Direct repository-method coverage (hand-inserted rows, faster than routing through the
  // whole pipeline for every dispatch-status transition dispatch tiers depend on).
  // -----------------------------------------------------------------------------------------

  describe('direct repository methods', () => {
    it('findById returns the inserted row; markDispatched clears dispatch_status/attempts/error', async () => {
      const row = await insertAndClaim({
        customerIdHash: `direct-md-${Math.random().toString(36).slice(2)}`,
        campaignCode: 'CAMP_RE_DIRECT2',
        trackerCode: 'TRK_RE_DIRECT2',
        trackerComponentCode: 'COMP_RE_DIRECT2',
      });
      const transaction = await sequelize.transaction();
      const inserted = await rewardEntryRepository.insertForGrantedAssignment(transaction, {
        row,
        rewardCode: 'RWD_DIRECT2',
        rewardCategory: 'cashback',
        rewardValue: '2.00',
        rewardValueUnit: 'MYR',
        completionCycle: 1,
        rewardEntryDate: new Date(),
      });
      await transaction.commit();
      expect(inserted).not.toBeNull();

      const found = await rewardEntryRepository.findById(inserted!.id);
      expect(found?.reward_code).toBe('RWD_DIRECT2');
      expect(found?.dispatch_status).toBe('pending');

      await rewardEntryRepository.recordDispatchAttemptFailure(inserted!.id, 'boom-1');
      const afterFailure = await rewardEntryRepository.findById(inserted!.id);
      expect(afterFailure?.dispatch_attempts).toBe(1);
      expect(afterFailure?.last_dispatch_error).toBe('boom-1');
      expect(afterFailure?.dispatch_status).toBe('pending');

      await rewardEntryRepository.markDispatched(inserted!.id);
      const afterDispatch = await rewardEntryRepository.findById(inserted!.id);
      expect(afterDispatch?.dispatch_status).toBe('dispatched');
      expect(afterDispatch?.dispatch_attempts).toBe(2);
      expect(afterDispatch?.last_dispatch_error).toBeNull();
    });

    it('markDispatchFailed flips dispatch_status to failed and records the reason', async () => {
      const row = await insertAndClaim({
        customerIdHash: `direct-fail-${Math.random().toString(36).slice(2)}`,
        campaignCode: 'CAMP_RE_DIRECT3',
        trackerCode: 'TRK_RE_DIRECT3',
        trackerComponentCode: 'COMP_RE_DIRECT3',
      });
      const transaction = await sequelize.transaction();
      const inserted = await rewardEntryRepository.insertForGrantedAssignment(transaction, {
        row,
        rewardCode: 'RWD_DIRECT3',
        rewardCategory: 'cashback',
        rewardValue: '3.00',
        rewardValueUnit: 'MYR',
        completionCycle: 1,
        rewardEntryDate: new Date(),
      });
      await transaction.commit();

      await rewardEntryRepository.markDispatchFailed(inserted!.id, 'kafka+grpc both failed');
      const after = await rewardEntryRepository.findById(inserted!.id);
      expect(after?.dispatch_status).toBe('failed');
      expect(after?.last_dispatch_error).toBe('kafka+grpc both failed');
    });

    it('outbox: insertPending -> findPendingBatch -> incrementAttempts -> markPublished', async () => {
      const row = await insertAndClaim({
        customerIdHash: `direct-outbox-${Math.random().toString(36).slice(2)}`,
        campaignCode: 'CAMP_RE_DIRECT4',
        trackerCode: 'TRK_RE_DIRECT4',
        trackerComponentCode: 'COMP_RE_DIRECT4',
      });
      const transaction = await sequelize.transaction();
      const rewardEntry = await rewardEntryRepository.insertForGrantedAssignment(transaction, {
        row,
        rewardCode: 'RWD_DIRECT4',
        rewardCategory: 'cashback',
        rewardValue: '4.00',
        rewardValueUnit: 'MYR',
        completionCycle: 1,
        rewardEntryDate: new Date(),
      });
      const outboxRow = await rewardEntryOutboxRepository.insertPending(transaction, rewardEntry!);
      await transaction.commit();

      const batch = await rewardEntryOutboxRepository.findPendingBatch(50, {
        rowIds: [outboxRow.id],
      });
      expect(batch.map((r) => r.id)).toContain(outboxRow.id);
      expect(batch.find((r) => r.id === outboxRow.id)?.payload.rewardCode).toBe('RWD_DIRECT4');

      await rewardEntryOutboxRepository.incrementAttempts(outboxRow.id);
      const afterIncrement = await sequelize.query<{ attempts: number; status: string }>(
        `SELECT attempts, status FROM realtime_activity_processing.reward_entry_outbox WHERE id = :id`,
        { type: QueryTypes.SELECT, replacements: { id: outboxRow.id } },
      );
      expect(afterIncrement[0].attempts).toBe(1);
      expect(afterIncrement[0].status).toBe('PENDING');

      await rewardEntryOutboxRepository.markPublished(outboxRow.id);
      const afterPublish = await sequelize.query<{ attempts: number; status: string }>(
        `SELECT attempts, status FROM realtime_activity_processing.reward_entry_outbox WHERE id = :id`,
        { type: QueryTypes.SELECT, replacements: { id: outboxRow.id } },
      );
      expect(afterPublish[0].status).toBe('PUBLISHED');
      expect(afterPublish[0].attempts).toBe(2);

      const stillPending = await rewardEntryOutboxRepository.findPendingBatch(50, {
        rowIds: [outboxRow.id],
      });
      expect(stillPending).toHaveLength(0);
    });

    it('outbox: markFailed stops the row from being polled again', async () => {
      const row = await insertAndClaim({
        customerIdHash: `direct-outbox-fail-${Math.random().toString(36).slice(2)}`,
        campaignCode: 'CAMP_RE_DIRECT5',
        trackerCode: 'TRK_RE_DIRECT5',
        trackerComponentCode: 'COMP_RE_DIRECT5',
      });
      const transaction = await sequelize.transaction();
      const rewardEntry = await rewardEntryRepository.insertForGrantedAssignment(transaction, {
        row,
        rewardCode: 'RWD_DIRECT5',
        rewardCategory: 'cashback',
        rewardValue: '5.00',
        rewardValueUnit: 'MYR',
        completionCycle: 1,
        rewardEntryDate: new Date(),
      });
      const outboxRow = await rewardEntryOutboxRepository.insertPending(transaction, rewardEntry!);
      await transaction.commit();

      await rewardEntryOutboxRepository.markFailed(outboxRow.id);
      const batch = await rewardEntryOutboxRepository.findPendingBatch(50, {
        rowIds: [outboxRow.id],
      });
      expect(batch).toHaveLength(0);
      const persisted = await sequelize.query<{ status: string }>(
        `SELECT status FROM realtime_activity_processing.reward_entry_outbox WHERE id = :id`,
        { type: QueryTypes.SELECT, replacements: { id: outboxRow.id } },
      );
      expect(persisted[0].status).toBe('FAILED');
    });
  });
});
