/**
 * T-INT-060. Covers `RuleEvaluationRowHandler.resolveSiblingTarget` (that file's own header) —
 * one real-world activity fanning out to several sibling `tracker_components` under the *same*
 * tracker, all bound to the identical `activityId` (the "buy N times to complete a streak" shape
 * confirmed live, 2026-09-12, against `SUMMER_CASHBACK_SPRINT`/`TRK-3-AW8CK0`) must advance exactly
 * one slot per real activity, not all of them at once.
 *
 * Same "real Postgres, `rap_app` role, real `RuleEvaluationRowHandler`" discipline every other
 * file in this directory already uses (`tracker-completion.spec.ts`, `rule-evaluation.spec.ts`) —
 * `pg_advisory_xact_lock`'s own serialization guarantee, and the read-after-write consistency this
 * task's own guard depends on, are exactly the kind of thing a mock cannot prove.
 *
 * `insertAndClaim()` below inserts and claims its own row in a single transaction
 * (`reward-kind-stamping.spec.ts`'s own T-INT-044 race-free shape) — no window during which a
 * foreign, concurrently-running claim worker could see this row `pending`, so no cross-process
 * reader lease is needed in this file either.
 *
 * TC-1/TC-2/TC-4/TC-5/TC-6 below use `rewards: []` (no `BoundReward` bound at all), so
 * `CapEnforcementService`/`RewardEntryRepository`/`RewardEntryOutboxRepository` are never actually
 * invoked — stubbed, same as `tracker-completion.spec.ts`'s own `buildHandler`. TC-3 is the one
 * case that needs a real reward granted (to prove "exactly once, not once per sibling"), so it
 * builds a handler with the real `CapEnforcementService`/repositories instead, same shape
 * `reward-kind-stamping.spec.ts` already established.
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
import { RewardEntryRepository } from '@/modules/reward-entry/reward-entry.repository';
import { RewardEntryOutboxRepository } from '@/modules/reward-entry/reward-entry-outbox.repository';
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

const TENANT_ID = 990_000 + Math.floor(Math.random() * 9_999);

describe('RuleEvaluationRowHandler — sibling tracker-component exclusivity (real Postgres, rap_app role) — T-INT-060', () => {
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

  /** Deliberately trivial and always-passing (task's own scope note 5: "a local test fixture with
   * a real, bound operator/value ... deliberately trivial so it always passes") — proves the
   * exclusivity guard itself independent of `BACKLOG.md` RS-05. */
  function trivialPassingRule(componentId: number, trackerComponentId: number): BoundRuleProto {
    return {
      ruleId: componentId,
      ruleVersionId: 1,
      versionNo: 1,
      ruleCode: `RULE_${componentId}`,
      expression: 'activity.activity_value >= 0',
      parametersJson: '{}',
      boundValuesJson: '{}',
      trackerComponentId,
      status: 'active',
    };
  }

  /** TC-6: the real, live, currently-unbound shape (`BACKLOG.md` RS-05) — a `:operator`/`:value`/
   * `:currency` template with nothing on the wire to resolve any of the three, exactly
   * `RULE_ACTIVITY_VALUE_001`'s real live expression. */
  function unboundOperatorRule(componentId: number, trackerComponentId: number): BoundRuleProto {
    return {
      ruleId: componentId,
      ruleVersionId: 1,
      versionNo: 1,
      ruleCode: `RULE_ACTIVITY_VALUE_${componentId}`,
      expression: 'transaction.amount :operator :value (transaction.currency == :currency)',
      parametersJson: '{}',
      boundValuesJson: '{}',
      trackerComponentId,
      status: 'active',
    };
  }

  interface ComponentSpec {
    id: number;
    code: string;
    activityId: number;
    sequenceOrder: number;
  }

  function trackerComponentProto(spec: ComponentSpec): TrackerComponentProto {
    return {
      componentId: spec.id,
      componentCode: spec.code,
      name: spec.code,
      activityId: spec.activityId,
      sequenceOrder: spec.sequenceOrder,
      isMandatory: true,
      status: 'active',
    };
  }

  function campaignConfig(overrides: {
    campaignCode: string;
    campaignId?: number;
    trackerCode: string;
    completionLogic: string;
    completionThreshold: number;
    components: ComponentSpec[];
    ruleBuilder?: (spec: ComponentSpec) => BoundRuleProto;
    rewards?: BoundRewardProto[];
    caps?: CampaignCapProto[];
  }): CampaignConfigProto {
    const components = overrides.components.map(trackerComponentProto);
    const ruleBuilder =
      overrides.ruleBuilder ?? ((spec: ComponentSpec) => trivialPassingRule(spec.id, spec.id));
    const rules = overrides.components.map(ruleBuilder);
    return {
      campaignId: overrides.campaignId ?? 9900,
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
          trackerId: 8900,
          trackerCode: overrides.trackerCode,
          name: overrides.trackerCode,
          completionLogic: overrides.completionLogic,
          completionThreshold: overrides.completionThreshold,
          status: 'active',
          components,
        },
      ],
      rules,
      rewards: overrides.rewards ?? [],
      etag: 'etag-1',
      configHash: 'hash-1',
      notModified: false,
      servedAt: '2026-01-01T00:00:00.000Z',
      caps: overrides.caps ?? [],
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

  /** TC-1/TC-2/TC-4/TC-5/TC-6: no rewards bound at all, so cap-enforcement/reward-entry are never
   * reached — stubbed, same convention `tracker-completion.spec.ts`'s own `buildHandler` uses. */
  function buildHandlerNoRewards(config: CampaignConfigProto): RuleEvaluationRowHandler {
    return new RuleEvaluationRowHandler(
      sequelize,
      fakeCacheFor(config),
      ruleEvaluator,
      progressRepository,
      trackerStatusRepository,
      resolver,
      {} as unknown as CapEnforcementService,
      {} as unknown as RewardEntryRepository,
      {} as unknown as RewardEntryOutboxRepository,
      new MetricsService(),
      fakeLoggerFactory(),
    );
  }

  /** TC-3: real reward-granting path, same shape `reward-kind-stamping.spec.ts` uses. */
  function buildHandlerWithRealRewards(config: CampaignConfigProto): RuleEvaluationRowHandler {
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
      new MetricsService(),
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
      activityCode: 'GROCERY_PURCHASE',
      activityType: 'TRANSACTION',
      activityCategory: 'RETAIL',
      activityValue: '10.0000',
      activityValueUnit: 'MYR',
      channel: 'WEB',
      activityPerformedEnv: 'PROD',
      activityName: 'Grocery Purchase',
      campaignCode: 'CAMP_SIB',
      trackerCode: 'TRK_SIB',
      trackerComponentCode: 'COMP_SIB',
      merchantCode: null,
      sourceTransport: 'GRPC',
      ...overrides,
    };
  }

  /** Insert and claim in the SAME transaction (T-INT-044's race-free shape, same helper
   * `reward-kind-stamping.spec.ts` already established) — never visible as `pending` to any
   * concurrently-running claim worker, so no cross-process reader lease is needed. */
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

  async function loadProgressRows(
    trackerCode: string,
    customerIdHash: string,
  ): Promise<
    Array<{ tracker_component_code: string; completion_cycle: number; is_completed: boolean }>
  > {
    return sequelize.query(
      `SELECT tracker_component_code, completion_cycle, is_completed
         FROM realtime_activity_processing.customer_tracker_component_progress
        WHERE tenant_id = :tenantId AND customer_id_hash = :customerIdHash AND tracker_code = :trackerCode
        ORDER BY tracker_component_code ASC, completion_cycle ASC`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId: TENANT_ID, customerIdHash, trackerCode },
      },
    );
  }

  /** Simulates one real-world activity submission's own fan-out: inserts+claims one
   * `activity_logs` row per component code (exactly what `ActivityIngestionService.ingest()`
   * produces today for N sibling matches — Scope item in this task's own file: fan-out itself is
   * unchanged), then hands each fanned-out row to `handler.handle()` in turn, exactly the order
   * `ActivityLogClaimWorker` would dequeue them serialized by the advisory lock. Returns the rows
   * in the same order they were handled.
   *
   * Every row shares one `dedupKey`, generated fresh per call — exactly
   * `ActivityIngestionService.ingest()`'s own real shape (`activity-ingestion.service.ts`'s own
   * header: `dedupKey` computed once per inbound activity, reused verbatim for every fanned-out
   * row) — this is the signal `findSiblingAdvancedByDedupKey` depends on to recognize "these N rows
   * are all the same real-world submission".
   */
  async function submitActivity(
    handler: RuleEvaluationRowHandler,
    customerIdHash: string,
    campaignCode: string,
    trackerCode: string,
    componentCodes: readonly string[],
    handleOrder: readonly string[] = componentCodes,
  ): Promise<Map<string, ActivityLogRow>> {
    const dedupKey = `dedup-${Math.random().toString(36).slice(2)}`;
    const rowsByCode = new Map<string, ActivityLogRow>();
    for (const code of componentCodes) {
      rowsByCode.set(
        code,
        await insertAndClaim({
          customerIdHash,
          campaignCode,
          trackerCode,
          trackerComponentCode: code,
          dedupKey,
        }),
      );
    }
    for (const code of handleOrder) {
      const row = rowsByCode.get(code);
      if (!row) {
        throw new Error(`handleOrder referenced an unknown component code: ${code}`);
      }
      await handler.handle(row);
    }
    return rowsByCode;
  }

  const FIVE_COMPONENTS: ComponentSpec[] = [1, 2, 3, 4, 5].map((n) => ({
    id: 99_900 + n,
    code: `CMP_SIB_${n}`,
    activityId: 701,
    sequenceOrder: n,
  }));
  const COMPONENT_CODES = FIVE_COMPONENTS.map((c) => c.code);

  // TC-1: one activity fans out to 5 sibling components — exactly 1 progress row created (slot 1),
  // the other 4 rows end `processed` with the skip comment, 0 reward_entry rows (rewards: []).
  it('TC-1: one activity fanning out to 5 siblings advances only the lowest-sequence_order slot', async () => {
    const customerIdHash = `tc1-${Math.random().toString(36).slice(2)}`;
    const config = campaignConfig({
      campaignCode: 'CAMP_SIB_TC1',
      trackerCode: 'TRK_SIB_TC1',
      completionLogic: 'n_of',
      completionThreshold: 5,
      components: FIVE_COMPONENTS,
    });
    const handler = buildHandlerNoRewards(config);

    const rows = await submitActivity(
      handler,
      customerIdHash,
      'CAMP_SIB_TC1',
      'TRK_SIB_TC1',
      COMPONENT_CODES,
    );

    const progress = await loadProgressRows('TRK_SIB_TC1', customerIdHash);
    expect(progress).toHaveLength(1);
    expect(progress[0].tracker_component_code).toBe('CMP_SIB_1');
    expect(progress[0].is_completed).toBe(true);

    // Rows 2-5 are fanned out from the SAME real-world submission as row 1 (shared dedup_key) — by
    // the time each of them is handled, CMP_SIB_1 has already advanced *from this exact
    // submission*, so each is gated by the "already advanced this activity" reason, not a fresh
    // "current pending slot" recomputation (which would otherwise cascade — see this task's own
    // header on `rule-evaluation-row-handler.service.ts`).
    for (const code of COMPONENT_CODES.slice(1)) {
      const reloaded = await loadActivityLog(rows.get(code)!.id);
      expect(reloaded.status).toBe('processed');
      expect(reloaded.comment).toContain(
        'Sibling component "CMP_SIB_1" already advanced from this same activity',
      );
      expect(reloaded.comment).toContain(`activity did not advance component "${code}"`);
    }
    const targetReloaded = await loadActivityLog(rows.get('CMP_SIB_1')!.id);
    expect(targetReloaded.status).toBe('processed');
    expect(targetReloaded.comment).not.toContain('did not advance');

    const rewardRows = await sequelize.query(
      'SELECT 1 FROM realtime_activity_processing.reward_entry WHERE tenant_id = :tenantId AND campaign_code = :campaignCode',
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId: TENANT_ID, campaignCode: 'CAMP_SIB_TC1' },
      },
    );
    expect(rewardRows).toHaveLength(0);
  });

  // TC-2: a second activity submission (slot 1 already complete) advances slot 2 only.
  it('TC-2: a second submission with slot 1 already complete advances slot 2 only, slots 3-5 untouched', async () => {
    const customerIdHash = `tc2-${Math.random().toString(36).slice(2)}`;
    const config = campaignConfig({
      campaignCode: 'CAMP_SIB_TC2',
      trackerCode: 'TRK_SIB_TC2',
      completionLogic: 'n_of',
      completionThreshold: 5,
      components: FIVE_COMPONENTS,
    });
    const handler = buildHandlerNoRewards(config);

    await submitActivity(handler, customerIdHash, 'CAMP_SIB_TC2', 'TRK_SIB_TC2', COMPONENT_CODES);
    const secondSubmissionRows = await submitActivity(
      handler,
      customerIdHash,
      'CAMP_SIB_TC2',
      'TRK_SIB_TC2',
      COMPONENT_CODES,
    );

    const progress = await loadProgressRows('TRK_SIB_TC2', customerIdHash);
    expect(progress).toHaveLength(2);
    expect(progress.map((p) => p.tracker_component_code)).toEqual(['CMP_SIB_1', 'CMP_SIB_2']);
    expect(progress.every((p) => p.is_completed)).toBe(true);

    // Slot 1's own row from the second submission is gated by the ordinary "pending slot"
    // recomputation (slot 1 was already complete from a *different*, earlier submission) — it
    // points at slot 2, the next eligible sibling, not "already advanced".
    const slot1SecondSubmission = await loadActivityLog(secondSubmissionRows.get('CMP_SIB_1')!.id);
    expect(slot1SecondSubmission.comment).toContain(
      'Sibling component "CMP_SIB_2" is this tracker\'s current pending slot',
    );
    // Slots 3-5 in the second submission are gated by "already advanced this activity" — slot 2
    // advanced from this exact same second submission.
    for (const code of ['CMP_SIB_3', 'CMP_SIB_4', 'CMP_SIB_5']) {
      const reloaded = await loadActivityLog(secondSubmissionRows.get(code)!.id);
      expect(reloaded.comment).toContain(
        'Sibling component "CMP_SIB_2" already advanced from this same activity',
      );
    }
  });

  // TC-3: five sequential submissions, one per slot -> tracker completes exactly once, after the
  // 5th, and the bound campaign-level reward is created exactly once, not 5 times.
  it('TC-3: five sequential submissions complete the tracker exactly once and grant the bound reward exactly once', async () => {
    const customerIdHash = `tc3-${Math.random().toString(36).slice(2)}`;
    const reward: BoundRewardProto = {
      rewardId: 99_950,
      rewardVersionId: 1,
      versionNo: 1,
      systemCode: 'RWD_SIB_TC3',
      rewardType: 'cashback',
      deliveryMode: 'wallet',
      policiesJson: JSON.stringify({ fixedAmount: '5.00' }),
      unitType: 'currency',
      unitCode: 'MYR',
      level: 'campaign',
      refId: 0,
      status: 'active',
    };
    const config = campaignConfig({
      campaignCode: 'CAMP_SIB_TC3',
      trackerCode: 'TRK_SIB_TC3',
      completionLogic: 'n_of',
      completionThreshold: 5,
      components: FIVE_COMPONENTS,
      rewards: [reward],
      caps: [fakeCap()],
    });
    const handler = buildHandlerWithRealRewards(config);

    for (let i = 0; i < 5; i += 1) {
      await submitActivity(handler, customerIdHash, 'CAMP_SIB_TC3', 'TRK_SIB_TC3', COMPONENT_CODES);
    }

    const progress = await loadProgressRows('TRK_SIB_TC3', customerIdHash);
    expect(progress).toHaveLength(5);
    expect(progress.every((p) => p.is_completed)).toBe(true);

    const trackerStatusRows = await sequelize.query<{ is_completed: boolean }>(
      `SELECT is_completed FROM realtime_activity_processing.customer_tracker_status
        WHERE tenant_id = :tenantId AND customer_id_hash = :customerIdHash AND tracker_code = :trackerCode`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId: TENANT_ID, customerIdHash, trackerCode: 'TRK_SIB_TC3' },
      },
    );
    expect(trackerStatusRows).toHaveLength(1);
    expect(trackerStatusRows[0].is_completed).toBe(true);

    const rewardRows = await sequelize.query(
      `SELECT 1 FROM realtime_activity_processing.reward_entry
        WHERE tenant_id = :tenantId AND campaign_code = :campaignCode`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId: TENANT_ID, campaignCode: 'CAMP_SIB_TC3' },
      },
    );
    expect(rewardRows).toHaveLength(1);
  });

  // TC-4: components bound to distinct (non-shared) activities — the common case — is unaffected.
  it('TC-4: components bound to distinct activities are unaffected — both advance independently from their own activity', async () => {
    const customerIdHash = `tc4-${Math.random().toString(36).slice(2)}`;
    const components: ComponentSpec[] = [
      { id: 99_960, code: 'CMP_DISTINCT_1', activityId: 801, sequenceOrder: 1 },
      { id: 99_961, code: 'CMP_DISTINCT_2', activityId: 802, sequenceOrder: 2 },
    ];
    const config = campaignConfig({
      campaignCode: 'CAMP_SIB_TC4',
      trackerCode: 'TRK_SIB_TC4',
      completionLogic: 'all',
      completionThreshold: 0,
      components,
    });
    const handler = buildHandlerNoRewards(config);

    const rowA = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_SIB_TC4',
      trackerComponentCode: 'CMP_DISTINCT_1',
    });
    await handler.handle(rowA);

    const progressAfterFirst = await loadProgressRows('TRK_SIB_TC4', customerIdHash);
    expect(progressAfterFirst).toHaveLength(1);
    expect(progressAfterFirst[0].tracker_component_code).toBe('CMP_DISTINCT_1');

    const reloadedA = await loadActivityLog(rowA.id);
    expect(reloadedA.comment).not.toContain('did not advance');

    const rowB = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_SIB_TC4',
      trackerComponentCode: 'CMP_DISTINCT_2',
    });
    await handler.handle(rowB);

    const progressAfterSecond = await loadProgressRows('TRK_SIB_TC4', customerIdHash);
    expect(progressAfterSecond).toHaveLength(2);
    expect(progressAfterSecond.every((p) => p.is_completed)).toBe(true);
  });

  // TC-5: two of the five sibling rows claimed/processed out of sequence_order order still
  // converges to exactly one advance — the lowest-sequence_order not-yet-completed component at
  // the moment each row is actually handled, never two.
  it('TC-5: siblings handled out of sequence_order order still converge to exactly one advance', async () => {
    const customerIdHash = `tc5-${Math.random().toString(36).slice(2)}`;
    const config = campaignConfig({
      campaignCode: 'CAMP_SIB_TC5',
      trackerCode: 'TRK_SIB_TC5',
      completionLogic: 'n_of',
      completionThreshold: 5,
      components: FIVE_COMPONENTS,
    });
    const handler = buildHandlerNoRewards(config);

    // Deliberately reversed handle order (5, 4, 3, 2, 1) — simulates a claim worker dequeuing the
    // 5 fanned-out rows in a non-default order.
    const reversedOrder = [...COMPONENT_CODES].reverse();
    const rows = await submitActivity(
      handler,
      customerIdHash,
      'CAMP_SIB_TC5',
      'TRK_SIB_TC5',
      COMPONENT_CODES,
      reversedOrder,
    );

    const progress = await loadProgressRows('TRK_SIB_TC5', customerIdHash);
    expect(progress).toHaveLength(1);
    expect(progress[0].tracker_component_code).toBe('CMP_SIB_1');

    for (const code of COMPONENT_CODES.slice(1)) {
      const reloaded = await loadActivityLog(rows.get(code)!.id);
      expect(reloaded.comment).toContain('did not advance');
    }
  });

  // TC-6: regression against the live, currently-unbound RULE_ACTIVITY_VALUE_001 shape
  // (`BACKLOG.md` RS-05) — the exclusivity guard still selects exactly one target component, and
  // T-RAP-063's own "unresolved placeholder -> evaluated as not passed, never throws" protection is
  // completely unaffected: the resolved target's own rule evaluation still correctly resolves as
  // not-passed, so no progress row is created for it either. Proves this fix and RS-05 are
  // independent.
  it('TC-6: an unbound RULE_ACTIVITY_VALUE_001-shaped rule still resolves as not-passed for whichever sibling is selected as target', async () => {
    const customerIdHash = `tc6-${Math.random().toString(36).slice(2)}`;
    const config = campaignConfig({
      campaignCode: 'CAMP_SIB_TC6',
      trackerCode: 'TRK_SIB_TC6',
      completionLogic: 'n_of',
      completionThreshold: 5,
      components: FIVE_COMPONENTS,
      ruleBuilder: (spec) => unboundOperatorRule(spec.id, spec.id),
    });
    const handler = buildHandlerNoRewards(config);

    const rows = await submitActivity(
      handler,
      customerIdHash,
      'CAMP_SIB_TC6',
      'TRK_SIB_TC6',
      COMPONENT_CODES,
    );

    // The guard still selected CMP_SIB_1 as the target (same selection as TC-1) ...
    const targetReloaded = await loadActivityLog(rows.get('CMP_SIB_1')!.id);
    expect(targetReloaded.comment).not.toContain('did not advance');
    // ... but T-RAP-063's own unresolved-placeholder protection means it never passed the rule, so
    // no progress row was created at all — the exact, still-safe state the live system is in today
    // per this task's own "Why this is real today" section.
    expect(targetReloaded.comment).toContain('unresolved placeholder');
    expect(targetReloaded.status).toBe('processed');

    const progress = await loadProgressRows('TRK_SIB_TC6', customerIdHash);
    expect(progress).toHaveLength(0);

    // Every sibling was still correctly gated — only one row was even offered to rule evaluation.
    for (const code of COMPONENT_CODES.slice(1)) {
      const reloaded = await loadActivityLog(rows.get(code)!.id);
      expect(reloaded.comment).toContain('did not advance');
    }
  });
});
