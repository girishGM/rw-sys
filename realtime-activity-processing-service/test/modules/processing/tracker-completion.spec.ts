/**
 * T-RAP-032. Covers the tracker-completion aggregator built on top of T-RAP-031's own advisory
 * lock + rule evaluation + component-progress chain (`05-PROCESSING-PIPELINE.md` §5 point 2).
 *
 * Two tiers, same split `rule-evaluation.spec.ts` (T-RAP-031) already established:
 *  - Pure-logic tests (`TrackerCompletionEvaluatorService`) against fakes — no real DB.
 *  - Persistence tests (TC-1..5) against the real local Postgres 16 server (root `CLAUDE.md`),
 *    connected as the real least-privilege `rap_app` role, driven end to end through
 *    `RuleEvaluationRowHandler.handle()` exactly as production traffic would — proving the
 *    `customer_tracker_status` upsert really happens inside the same transaction T-RAP-031 opened,
 *    not a separately wired call.
 */
import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { TrackerCompletionEvaluatorService } from '@/modules/processing/tracker-completion-evaluator.service';
import { TrackerStatusRepository } from '@/modules/processing/tracker-status.repository';
import { TrackerComponentProgressRepository } from '@/modules/processing/tracker-component-progress.repository';
import { RuleEvaluationRowHandler } from '@/modules/processing/rule-evaluation-row-handler.service';
import type { CapEnforcementService } from '@/modules/budget/cap-enforcement.service';
import type { RewardEntryRepository } from '@/modules/reward-entry/reward-entry.repository';
import type { RewardEntryOutboxRepository } from '@/modules/reward-entry/reward-entry-outbox.repository';
import { RuleEvaluatorService } from '@/modules/processing/rule-evaluator.service';
import type { AdvisoryLockTimeoutResolver } from '@/modules/processing/processing.config';
import {
  ActivityLogsRepository,
  type FanOutRowInput,
} from '@/modules/activity-mapping/activity-logs.repository';
import type { CampaignConfigCacheService } from '@/modules/campaign-cache/campaign-config-cache.service';
import type {
  BoundRuleProto,
  CampaignConfigProto,
  TrackerComponentProto,
} from '@/modules/campaign-cache/campaign-config.client';
import type { ActivityLogRow } from '@/database/models/activity-log.model';
import type { CustomerTrackerStatusRow } from '@/database/models/customer-tracker-status.model';
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

const TENANT_ID = 950_000 + Math.floor(Math.random() * 49_999);

// ---------------------------------------------------------------------------------------------
// Pure-logic tests — no real DB.
// ---------------------------------------------------------------------------------------------

describe('TrackerCompletionEvaluatorService.isComplete (pure, no DB)', () => {
  const evaluator = new TrackerCompletionEvaluatorService();

  it('"all": incomplete until completedCount reaches the total component membership', () => {
    expect(
      evaluator.isComplete({
        completionLogic: 'all',
        completionThreshold: 0,
        componentsRequiredCount: 2,
        componentsCompletedCount: 1,
      }),
    ).toBe(false);
    expect(
      evaluator.isComplete({
        completionLogic: 'all',
        completionThreshold: 0,
        componentsRequiredCount: 2,
        componentsCompletedCount: 2,
      }),
    ).toBe(true);
  });

  it('"any": complete as soon as one component completes', () => {
    expect(
      evaluator.isComplete({
        completionLogic: 'any',
        completionThreshold: 0,
        componentsRequiredCount: 5,
        componentsCompletedCount: 1,
      }),
    ).toBe(true);
    expect(
      evaluator.isComplete({
        completionLogic: 'any',
        completionThreshold: 0,
        componentsRequiredCount: 5,
        componentsCompletedCount: 0,
      }),
    ).toBe(false);
  });

  it('"n_of": complete once completedCount reaches completion_threshold, regardless of total membership', () => {
    expect(
      evaluator.isComplete({
        completionLogic: 'n_of',
        completionThreshold: 2,
        componentsRequiredCount: 3,
        componentsCompletedCount: 1,
      }),
    ).toBe(false);
    expect(
      evaluator.isComplete({
        completionLogic: 'n_of',
        completionThreshold: 2,
        componentsRequiredCount: 3,
        componentsCompletedCount: 2,
      }),
    ).toBe(true);
  });

  it('an unsupported completion_logic throws (a genuine configuration defect, not a "not complete" outcome)', () => {
    expect(() =>
      evaluator.isComplete({
        completionLogic: 'sequence',
        completionThreshold: 0,
        componentsRequiredCount: 1,
        componentsCompletedCount: 1,
      }),
    ).toThrow(/unsupported tracker completion_logic/i);
  });
});

// ---------------------------------------------------------------------------------------------
// Real Postgres, rap_app role — TC-1..5, driven end to end through RuleEvaluationRowHandler.
// ---------------------------------------------------------------------------------------------

describe('Tracker completion aggregation (real Postgres, rap_app role)', () => {
  let sequelize: Sequelize;
  let fanOutRepository: ActivityLogsRepository;
  let progressRepository: TrackerComponentProgressRepository;
  let trackerStatusRepository: TrackerStatusRepository;
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
    ruleEvaluator = new RuleEvaluatorService();
  });

  afterAll(async () => {
    await sequelize.query(
      'DELETE FROM realtime_activity_processing.customer_tracker_status WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await sequelize.query(
      'DELETE FROM realtime_activity_processing.customer_tracker_component_progress WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await sequelize.query(
      'DELETE FROM realtime_activity_processing.activity_logs WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await sequelize.close();
  });

  function rule(overrides: Partial<BoundRuleProto> = {}): BoundRuleProto {
    return {
      ruleId: 1,
      ruleVersionId: 1,
      versionNo: 1,
      ruleCode: 'RULE_MIN_VALUE',
      expression: 'activity.activity_value >= 1',
      parametersJson: '{}',
      // No requiredCount override -> DEFAULT_REQUIRED_COUNT (1): a component completes on its
      // first passing activity, which keeps every scenario below to one activity per component.
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
    trackerCode: string;
    completionLogic: string;
    completionThreshold: number;
    componentIds: readonly [number, string][];
    ruleTrackerComponentIdOverride?: never;
  }): CampaignConfigProto {
    const components = overrides.componentIds.map(([id, code]) => trackerComponentProto(id, code));
    const rules = overrides.componentIds.map(([id]) =>
      rule({ ruleId: id, ruleCode: `RULE_${id}`, trackerComponentId: id }),
    );
    return {
      campaignId: 9101,
      campaignCode: 'CAMP1',
      tenantId: TENANT_ID,
      countryId: 1,
      status: 'active',
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-12-31T00:00:00.000Z',
      budget: { amount: '10000.00', currency: 'USD' },
      maxParticipants: 1000,
      merchants: [],
      trackers: [
        {
          trackerId: 8101,
          trackerCode: overrides.trackerCode,
          name: overrides.trackerCode,
          completionLogic: overrides.completionLogic,
          completionThreshold: overrides.completionThreshold,
          status: 'active',
          components,
        },
      ],
      rules,
      rewards: [],
      etag: 'etag-1',
      configHash: 'hash-1',
      notModified: false,
      servedAt: '2026-01-01T00:00:00.000Z',
      caps: [],
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
    overrides: { metrics?: MetricsService } = {},
  ): RuleEvaluationRowHandler {
    return new RuleEvaluationRowHandler(
      sequelize,
      fakeCacheFor(config),
      ruleEvaluator,
      progressRepository,
      trackerStatusRepository,
      resolver,
      // Every fixture in this file seeds `rewards: []`, so `CapEnforcementService` is never
      // actually invoked — T-RAP-033's own `cap-enforcement.spec.ts` exercises the real service.
      {} as unknown as CapEnforcementService,
      // Same reasoning — with no granted assignments ever produced, T-RAP-034's reward-entry
      // insert path is never reached either; T-RAP-034's own tests exercise the real repositories.
      {} as unknown as RewardEntryRepository,
      {} as unknown as RewardEntryOutboxRepository,
      overrides.metrics ?? new MetricsService(),
      fakeLoggerFactory(),
    );
  }

  function pendingRowInput(overrides: Partial<FanOutRowInput> = {}): FanOutRowInput {
    return {
      correlationId: '44444444-4444-4444-8444-444444444444',
      dedupKey: `dedup-${Math.random().toString(36).slice(2)}`,
      tenantId: TENANT_ID,
      customerIdEncrypted: 'ciphertext-base64==',
      customerIdHash: 'd'.repeat(64),
      customerIdType: 'INTERNAL_ID',
      activityPerformedDate: new Date(),
      transactionType: null,
      activityCode: 'PURCHASE',
      activityType: 'TRANSACTION',
      activityCategory: 'RETAIL',
      activityValue: '10.0000',
      activityValueUnit: 'USD',
      channel: 'WEB',
      activityPerformedEnv: 'PROD',
      activityName: 'Online purchase',
      campaignCode: 'CAMP1',
      trackerCode: 'TRK1',
      trackerComponentCode: 'COMP1',
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
   * mitigation incomplete for two separate reasons:
   *   1. A fixed attempt budget (300) is still exhaustible under genuine full-parallel `npm test`
   *      contention — it was only ever a question of how much contention, not whether.
   *   2. The give-back loop's match condition (`next.tenant_id === TENANT_ID`) accepts *any*
   *      pending row belonging to this file's tenant, not specifically the row this call just
   *      inserted. If an *earlier* `insertAndClaim()` call sharing this file's single `TENANT_ID`
   *      ever exhausted its own attempt budget under load, its freshly-inserted row was left
   *      stranded `pending` — and a *later* call in this same file could then claim that stranded
   *      row instead of its own — see the regression test below, which reproduces this
   *      deterministically.
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
  // real full-suite load: `insertAndClaim()` must claim the exact row it just inserted, never a
  // *different* pending row that merely happens to share this file's own `TENANT_ID`. Retry 1's
  // give-back loop matched on `tenant_id` alone, so if an earlier call in this same file ever
  // exhausted its own attempt budget under contention, its freshly-inserted row was left stranded
  // `pending` — and a later call sharing the same `TENANT_ID` could then claim that stranded row
  // instead of its own, tripping a wrong-tracker/component error even though nothing about the
  // later call's own row or fixtures was wrong.
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

  async function loadTrackerStatus(
    trackerCode: string,
    customerIdHash: string,
  ): Promise<CustomerTrackerStatusRow[]> {
    return sequelize.query<CustomerTrackerStatusRow>(
      `SELECT * FROM realtime_activity_processing.customer_tracker_status
        WHERE tenant_id = :tenantId AND customer_id_hash = :customerIdHash
          AND tracker_code = :trackerCode
        ORDER BY completion_cycle ASC`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId: TENANT_ID, customerIdHash, trackerCode },
      },
    );
  }

  // TC-1 + TC-2: completion_logic = 'all', 2 components.
  it('TC-1/TC-2: "all" — not complete after the first of two components, complete after the second', async () => {
    const customerIdHash = `tc1-${Math.random().toString(36).slice(2)}`;
    const config = campaignConfig({
      trackerCode: 'TRK_ALL',
      completionLogic: 'all',
      completionThreshold: 0,
      componentIds: [
        [9201, 'COMP_ALL_1'],
        [9202, 'COMP_ALL_2'],
      ],
    });
    const metrics = new MetricsService();
    const handler = buildHandler(config, { metrics });

    const rowA = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_ALL',
      trackerComponentCode: 'COMP_ALL_1',
    });
    await handler.handle(rowA);

    // TC-1: only the first of two components has completed — tracker not yet complete.
    let [status] = await loadTrackerStatus('TRK_ALL', customerIdHash);
    expect(status.components_completed_count).toBe(1);
    expect(status.components_required_count).toBe(2);
    expect(status.is_completed).toBe(false);
    expect(status.completed_at).toBeNull();
    // T-RAP-059: one component completion so far -> one increment.
    expect(
      metrics.getCounterValue('tracker_components_completed_total', { campaign_code: 'CAMP1' }),
    ).toBe(1);

    const rowB = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_ALL',
      trackerComponentCode: 'COMP_ALL_2',
    });
    await handler.handle(rowB);

    // TC-2: the second component also completes — tracker is now complete.
    [status] = await loadTrackerStatus('TRK_ALL', customerIdHash);
    expect(status.components_completed_count).toBe(2);
    expect(status.is_completed).toBe(true);
    expect(status.completed_at).not.toBeNull();
    // T-RAP-059: a second, independent component completion -> a second increment (component-level
    // metric, not a tracker-level one — this is not "1 per tracker completion").
    expect(
      metrics.getCounterValue('tracker_components_completed_total', { campaign_code: 'CAMP1' }),
    ).toBe(2);

    const activityLogB = await sequelize.query<ActivityLogRow>(
      'SELECT * FROM realtime_activity_processing.activity_logs WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id: rowB.id } },
    );
    expect(activityLogB[0].comment).toContain('is now complete');
  });

  // TC-3: completion_logic = 'any', several components, one completes.
  it('TC-3: "any" — tracker completes immediately once one of several components completes', async () => {
    const customerIdHash = `tc3-${Math.random().toString(36).slice(2)}`;
    const config = campaignConfig({
      trackerCode: 'TRK_ANY',
      completionLogic: 'any',
      completionThreshold: 0,
      componentIds: [
        [9301, 'COMP_ANY_1'],
        [9302, 'COMP_ANY_2'],
        [9303, 'COMP_ANY_3'],
      ],
    });
    const handler = buildHandler(config);

    const row = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_ANY',
      trackerComponentCode: 'COMP_ANY_2',
    });
    await handler.handle(row);

    const [status] = await loadTrackerStatus('TRK_ANY', customerIdHash);
    expect(status.components_completed_count).toBe(1);
    expect(status.components_required_count).toBe(3);
    expect(status.is_completed).toBe(true);
    expect(status.completed_at).not.toBeNull();
  });

  // TC-4: completion_logic = 'n_of', threshold = 2, 3 components, 2 complete.
  it('TC-4: "n_of" — tracker completes once completion_threshold components have completed', async () => {
    const customerIdHash = `tc4-${Math.random().toString(36).slice(2)}`;
    const config = campaignConfig({
      trackerCode: 'TRK_NOF',
      completionLogic: 'n_of',
      completionThreshold: 2,
      componentIds: [
        [9401, 'COMP_NOF_1'],
        [9402, 'COMP_NOF_2'],
        [9403, 'COMP_NOF_3'],
      ],
    });
    const handler = buildHandler(config);

    const rowA = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_NOF',
      trackerComponentCode: 'COMP_NOF_1',
    });
    await handler.handle(rowA);

    let [status] = await loadTrackerStatus('TRK_NOF', customerIdHash);
    expect(status.is_completed).toBe(false);

    const rowB = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_NOF',
      trackerComponentCode: 'COMP_NOF_2',
    });
    await handler.handle(rowB);

    [status] = await loadTrackerStatus('TRK_NOF', customerIdHash);
    expect(status.components_completed_count).toBe(2);
    expect(status.components_required_count).toBe(3);
    expect(status.is_completed).toBe(true);
  });

  // TC-5: an already-complete tracker, another (repeatable) component completes later.
  it('TC-5: a tracker already complete advances completion_cycle rather than double-marking the same cycle', async () => {
    const customerIdHash = `tc5-${Math.random().toString(36).slice(2)}`;
    const config = campaignConfig({
      trackerCode: 'TRK_REPEAT',
      completionLogic: 'any',
      completionThreshold: 0,
      componentIds: [[9501, 'COMP_REPEAT_1']],
    });
    const handler = buildHandler(config);

    const rowA = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_REPEAT',
      trackerComponentCode: 'COMP_REPEAT_1',
    });
    await handler.handle(rowA);

    const rowB = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_REPEAT',
      trackerComponentCode: 'COMP_REPEAT_1',
    });
    await handler.handle(rowB);

    const rows = await loadTrackerStatus('TRK_REPEAT', customerIdHash);
    expect(rows).toHaveLength(2);
    expect(rows[0].completion_cycle).toBe(1);
    expect(rows[0].is_completed).toBe(true);
    expect(rows[0].components_completed_count).toBe(1);
    expect(rows[1].completion_cycle).toBe(2);
    expect(rows[1].is_completed).toBe(true);
    expect(rows[1].components_completed_count).toBe(1);
  });

  // A row that only partially completes its own component leaves customer_tracker_status untouched.
  it('a component that has not yet completed does not create a customer_tracker_status row at all', async () => {
    const customerIdHash = `tc-partial-${Math.random().toString(36).slice(2)}`;
    const config = campaignConfig({
      trackerCode: 'TRK_PARTIAL',
      completionLogic: 'all',
      completionThreshold: 0,
      componentIds: [
        [9601, 'COMP_PARTIAL_1'],
        [9602, 'COMP_PARTIAL_2'],
      ],
    });
    // Override the bound rule so the component needs 2 passing activities to complete.
    config.rules = config.rules.map((r) =>
      r.trackerComponentId === 9601 ? { ...r, boundValuesJson: '{"requiredCount":2}' } : r,
    );
    const handler = buildHandler(config);

    const row = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_PARTIAL',
      trackerComponentCode: 'COMP_PARTIAL_1',
    });
    await handler.handle(row);

    const rows = await loadTrackerStatus('TRK_PARTIAL', customerIdHash);
    expect(rows).toHaveLength(0);
  });
});
