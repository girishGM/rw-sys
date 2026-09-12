/**
 * T-RAP-062. Covers `reward_kind`/`promo_code_config_id`/`promo_code_config_version_no` stamping
 * onto `reward_entry` (`05-PROCESSING-PIPELINE.md` §6 point 3, `reward-entry.model.ts`'s own
 * header) — driven end to end through `RuleEvaluationRowHandler.handle()` exactly as production
 * traffic would, same "real Postgres, rap_app role, real handler" discipline
 * `cap-enforcement.spec.ts`/`reward-entry.repository.spec.ts` (T-RAP-033/034) already established
 * for this file-scope owner's task chain — proving these three fields really land inside the same
 * transaction T-RAP-031/033/034 opened, not a separately-wired mapping.
 *
 * `insertAndClaim()` below inserts and claims its own row in one transaction (T-INT-044's own
 * race-free fix, `reward-entry.repository.spec.ts`'s own copy of this helper) rather than the
 * two-statement/reader-lease shape `rule-evaluation.spec.ts`/`cap-enforcement.spec.ts` still carry
 * — no window during which a foreign, concurrently-running claim worker could see this row
 * `pending` at all, so no cross-process lease is needed here either.
 *
 * TC-5 (`migrate -> rollback -> migrate`) is proven by the bash gate
 * (`AGENT-PROTOCOL.md` §4), evidenced in this task's own completion report, not re-asserted here —
 * this file assumes the schema is already migrated, same convention `migrations.spec.ts` documents
 * for its own TC-1/TC-5. TC-6 (the pre-existing `rule-evaluation-row-handler.service.spec.ts`-family
 * suites still green) is likewise evidenced by the full `npm test` run in that same report, not
 * re-run inside this file.
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
import { RewardEntryOutboxRepository } from '@/modules/reward-entry/reward-entry-outbox.repository';
import { toRewardEntryGrpcPayload } from '@/modules/dispatch/reward-grpc-fallback.client';
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

const TENANT_ID = 980_000 + Math.floor(Math.random() * 19_999);

describe('reward_kind / promo-code identity+version stamping (real Postgres, rap_app role) — T-RAP-062', () => {
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
      campaignId: overrides.campaignId ?? 9800,
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
          trackerId: 8400,
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

  function buildHandler(config: CampaignConfigProto): RuleEvaluationRowHandler {
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
      correlationId: '77777777-7777-4777-8777-777777777777',
      dedupKey: `dedup-${Math.random().toString(36).slice(2)}`,
      tenantId: TENANT_ID,
      customerIdEncrypted: 'ciphertext-base64==',
      customerIdHash: 'g'.repeat(64),
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
      campaignCode: 'CAMPD',
      trackerCode: 'TRKD',
      trackerComponentCode: 'COMPD',
      merchantCode: null,
      sourceTransport: 'GRPC',
      ...overrides,
    };
  }

  /** T-INT-044's own race-free shape (`reward-entry.repository.spec.ts`'s own copy of this
   * helper): insert and claim in the SAME transaction, so this row never becomes visible as
   * `pending` to any concurrently-running claim worker at all. */
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

  async function loadRewardEntry(campaignCode: string): Promise<Record<string, unknown>> {
    const rows = await sequelize.query(
      `SELECT * FROM realtime_activity_processing.reward_entry
        WHERE tenant_id = :tenantId AND campaign_code = :campaignCode`,
      { type: QueryTypes.SELECT, replacements: { tenantId: TENANT_ID, campaignCode } },
    );
    expect(rows).toHaveLength(1);
    return rows[0] as Record<string, unknown>;
  }

  async function loadOutboxPayload(rewardEntryId: string): Promise<Record<string, unknown>> {
    const rows = await sequelize.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM realtime_activity_processing.reward_entry_outbox
        WHERE reward_entry_id = :id`,
      { type: QueryTypes.SELECT, replacements: { id: rewardEntryId } },
    );
    expect(rows).toHaveLength(1);
    return rows[0].payload;
  }

  // TC-1: BoundReward.reward_kind = 'PERCENTAGE' -> reward_entry.reward_kind = 'PERCENTAGE'.
  it("TC-1: a granted reward whose BoundReward.reward_kind = 'PERCENTAGE' stamps reward_entry.reward_kind = 'PERCENTAGE'", async () => {
    const reward = fakeReward({
      rewardId: 98_101,
      systemCode: 'RWD_TC1',
      refId: 98_101,
      rewardKind: 'PERCENTAGE',
    });
    const config = campaignConfig({
      campaignCode: 'CAMP_RKS_TC1',
      trackerCode: 'TRK_RKS_TC1',
      componentId: 98_101,
      componentCode: 'COMP_RKS_TC1',
      rewards: [reward],
      caps: [fakeCap()],
    });
    const handler = buildHandler(config);
    const row = await insertAndClaim({
      customerIdHash: `tc1-${Math.random().toString(36).slice(2)}`,
      campaignCode: 'CAMP_RKS_TC1',
      trackerCode: 'TRK_RKS_TC1',
      trackerComponentCode: 'COMP_RKS_TC1',
    });

    await handler.handle(row);

    const rewardEntry = await loadRewardEntry('CAMP_RKS_TC1');
    expect(rewardEntry.reward_kind).toBe('PERCENTAGE');
    expect(rewardEntry.promo_code_config_id).toBeNull();
    expect(rewardEntry.promo_code_config_version_no).toBeNull();
    // Every pre-existing field this row shape already carried is unchanged.
    expect(rewardEntry.reward_code).toBe('RWD_TC1');
    expect(rewardEntry.reward_category).toBe('cashback');
  });

  // TC-2: BoundReward.reward_kind not yet set upstream (empty string, proto3's own "absent" value)
  // -> reward_entry.reward_kind IS NULL, never fabricated to a fallback string.
  it('TC-2: an empty (not-yet-set) BoundReward.reward_kind stamps reward_entry.reward_kind = NULL', async () => {
    const reward = fakeReward({
      rewardId: 98_102,
      systemCode: 'RWD_TC2',
      refId: 98_102,
      rewardKind: '',
    });
    const config = campaignConfig({
      campaignCode: 'CAMP_RKS_TC2',
      trackerCode: 'TRK_RKS_TC2',
      componentId: 98_102,
      componentCode: 'COMP_RKS_TC2',
      rewards: [reward],
      caps: [fakeCap()],
    });
    const handler = buildHandler(config);
    const row = await insertAndClaim({
      customerIdHash: `tc2-${Math.random().toString(36).slice(2)}`,
      campaignCode: 'CAMP_RKS_TC2',
      trackerCode: 'TRK_RKS_TC2',
      trackerComponentCode: 'COMP_RKS_TC2',
    });

    await handler.handle(row);

    const rewardEntry = await loadRewardEntry('CAMP_RKS_TC2');
    expect(rewardEntry.reward_kind).toBeNull();
  });

  // TC-3: a PROMO_CODE-kind reward with promo_code_config_id/version_no set on BoundReward -> both
  // land on reward_entry unchanged.
  it('TC-3: a PROMO_CODE-kind reward carries its promo_code_config_id/version_no onto reward_entry unchanged', async () => {
    const reward = fakeReward({
      rewardId: 98_103,
      systemCode: 'RWD_TC3',
      refId: 98_103,
      rewardType: 'PROMO_CODE',
      rewardKind: 'PROMO_CODE',
      policiesJson: JSON.stringify({ apiProvider: 'PROMO_CODE_CONFIG_SERVICE' }),
      promoCodeConfigId: 'PCC-4711',
      promoCodeConfigVersionNo: 3,
    });
    const config = campaignConfig({
      campaignCode: 'CAMP_RKS_TC3',
      trackerCode: 'TRK_RKS_TC3',
      componentId: 98_103,
      componentCode: 'COMP_RKS_TC3',
      rewards: [reward],
      caps: [], // no CampaignCap rows -> reward value never needs resolving (T-INT-045)
    });
    const handler = buildHandler(config);
    const row = await insertAndClaim({
      customerIdHash: `tc3-${Math.random().toString(36).slice(2)}`,
      campaignCode: 'CAMP_RKS_TC3',
      trackerCode: 'TRK_RKS_TC3',
      trackerComponentCode: 'COMP_RKS_TC3',
    });

    await handler.handle(row);

    const rewardEntry = await loadRewardEntry('CAMP_RKS_TC3');
    expect(rewardEntry.reward_kind).toBe('PROMO_CODE');
    expect(rewardEntry.promo_code_config_id).toBe('PCC-4711');
    expect(rewardEntry.promo_code_config_version_no).toBe(3);
  });

  // TC-4: a non-PROMO_CODE reward -> both promo-code fields stay NULL.
  it('TC-4: a non-PROMO_CODE reward leaves promo_code_config_id/version_no NULL on reward_entry', async () => {
    const reward = fakeReward({
      rewardId: 98_104,
      systemCode: 'RWD_TC4',
      refId: 98_104,
      rewardType: 'cashback',
      rewardKind: 'FIXED_AMOUNT',
    });
    const config = campaignConfig({
      campaignCode: 'CAMP_RKS_TC4',
      trackerCode: 'TRK_RKS_TC4',
      componentId: 98_104,
      componentCode: 'COMP_RKS_TC4',
      rewards: [reward],
      caps: [fakeCap()],
    });
    const handler = buildHandler(config);
    const row = await insertAndClaim({
      customerIdHash: `tc4-${Math.random().toString(36).slice(2)}`,
      campaignCode: 'CAMP_RKS_TC4',
      trackerCode: 'TRK_RKS_TC4',
      trackerComponentCode: 'COMP_RKS_TC4',
    });

    await handler.handle(row);

    const rewardEntry = await loadRewardEntry('CAMP_RKS_TC4');
    expect(rewardEntry.reward_kind).toBe('FIXED_AMOUNT');
    expect(rewardEntry.promo_code_config_id).toBeNull();
    expect(rewardEntry.promo_code_config_version_no).toBeNull();
  });

  // TC-7: the outbound reward.entry.created.v1 payload (persisted onto reward_entry_outbox in the
  // same transaction, `05-PROCESSING-PIPELINE.md` §7 point 1) carries all three fields, matching
  // the stored reward_entry values exactly — and the gRPC-fallback wire mapping
  // (`toRewardEntryGrpcPayload`, tier 2/`03-GRPC-CONTRACT.md` §3) carries them too.
  it('TC-7: the reward.entry.created.v1 outbox payload and the gRPC-fallback wire payload both carry the stamped fields', async () => {
    const reward = fakeReward({
      rewardId: 98_107,
      systemCode: 'RWD_TC7',
      refId: 98_107,
      rewardType: 'PROMO_CODE',
      rewardKind: 'PROMO_CODE',
      policiesJson: JSON.stringify({ apiProvider: 'PROMO_CODE_CONFIG_SERVICE' }),
      promoCodeConfigId: 'PCC-9900',
      promoCodeConfigVersionNo: 7,
    });
    const config = campaignConfig({
      campaignCode: 'CAMP_RKS_TC7',
      trackerCode: 'TRK_RKS_TC7',
      componentId: 98_107,
      componentCode: 'COMP_RKS_TC7',
      rewards: [reward],
      caps: [],
    });
    const handler = buildHandler(config);
    const row = await insertAndClaim({
      customerIdHash: `tc7-${Math.random().toString(36).slice(2)}`,
      campaignCode: 'CAMP_RKS_TC7',
      trackerCode: 'TRK_RKS_TC7',
      trackerComponentCode: 'COMP_RKS_TC7',
    });

    await handler.handle(row);

    const rewardEntry = await loadRewardEntry('CAMP_RKS_TC7');
    const outboxPayload = await loadOutboxPayload(rewardEntry.id as string);

    expect(outboxPayload.rewardKind).toBe('PROMO_CODE');
    expect(outboxPayload.promoCodeConfigId).toBe('PCC-9900');
    expect(outboxPayload.promoCodeConfigVersionNo).toBe(7);
    expect(outboxPayload.rewardKind).toBe(rewardEntry.reward_kind);
    expect(outboxPayload.promoCodeConfigId).toBe(rewardEntry.promo_code_config_id);
    expect(outboxPayload.promoCodeConfigVersionNo).toBe(rewardEntry.promo_code_config_version_no);

    // Tier 2 (gRPC fallback, `reward-grpc-fallback.client.ts`) builds its own wire payload from
    // this exact outbox-shaped object — proves the mapping this task added there really carries
    // the fields through too, not just the Kafka leg.
    const grpcPayload = toRewardEntryGrpcPayload(
      outboxPayload as never,
      'decrypted-customer-id-not-under-test',
    );
    expect(grpcPayload.rewardKind).toBe('PROMO_CODE');
    expect(grpcPayload.promoCodeConfigId).toBe('PCC-9900');
    expect(grpcPayload.promoCodeConfigVersionNo).toBe(7);
  });
});
