/**
 * T-RAP-031. Covers the advisory lock + rule evaluation + progress-counter chain
 * (`05-PROCESSING-PIPELINE.md` §3-§5).
 *
 * Two tiers, same split `claim-worker.spec.ts` (T-RAP-030) already established for this project:
 *  - Pure-logic tests (`RuleEvaluatorService`, `buildCustomerCampaignLockKey`,
 *    `resolveAdvisoryLockWaitTimeoutMs`'s own fallback) against fakes — no real DB.
 *  - Concurrency-safety and persistence tests (TC-1..6, R2) against the real local Postgres 16
 *    server (root `CLAUDE.md`), connected as the real least-privilege `rap_app` role —
 *    `pg_advisory_xact_lock`'s own serialization guarantee is exactly the kind of thing a mock
 *    cannot prove.
 */
import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes, type Transaction } from 'sequelize';
import {
  DEFAULT_REQUIRED_COUNT,
  RuleEvaluatorService,
} from '@/modules/processing/rule-evaluator.service';
import {
  acquireCustomerCampaignAdvisoryLock,
  buildCustomerCampaignLockKey,
} from '@/modules/processing/advisory-lock.util';
import {
  TrackerComponentProgressRepository,
  type UpsertProgressInput,
  type UpsertProgressResult,
} from '@/modules/processing/tracker-component-progress.repository';
import { TrackerCompletionEvaluatorService } from '@/modules/processing/tracker-completion-evaluator.service';
import { TrackerStatusRepository } from '@/modules/processing/tracker-status.repository';
import { RuleEvaluationRowHandler } from '@/modules/processing/rule-evaluation-row-handler.service';
import type { CapEnforcementService } from '@/modules/budget/cap-enforcement.service';
import type { RewardEntryRepository } from '@/modules/reward-entry/reward-entry.repository';
import type { RewardEntryOutboxRepository } from '@/modules/reward-entry/reward-entry-outbox.repository';
import {
  DEFAULT_ADVISORY_LOCK_WAIT_TIMEOUT_MS,
  resolveAdvisoryLockWaitTimeoutMs,
  type AdvisoryLockTimeoutResolver,
} from '@/modules/processing/processing.config';
import {
  ActivityLogsRepository,
  type FanOutRowInput,
} from '@/modules/activity-mapping/activity-logs.repository';
import type { CampaignConfigCacheService } from '@/modules/campaign-cache/campaign-config-cache.service';
import type {
  BoundRuleProto,
  CampaignConfigProto,
} from '@/modules/campaign-cache/campaign-config.client';
import type { ActivityLogRow } from '@/database/models/activity-log.model';
import type { CustomerTrackerComponentProgressRow } from '@/database/models/customer-tracker-component-progress.model';
import { Logger } from '@nestjs/common';
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

const TENANT_ID = 940_000 + Math.floor(Math.random() * 59_999);

// ---------------------------------------------------------------------------------------------
// Pure-logic tests — no real DB.
// ---------------------------------------------------------------------------------------------

function fakeRow(overrides: Partial<ActivityLogRow> = {}): ActivityLogRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    correlation_id: '22222222-2222-4222-8222-222222222222',
    dedup_key: 'dedup-1',
    tenant_id: TENANT_ID,
    customer_id_encrypted: 'ciphertext',
    customer_id_hash: 'a'.repeat(64),
    customer_id_type: 'INTERNAL_ID',
    activity_performed_date: new Date(),
    transaction_type: null,
    activity_code: 'PURCHASE',
    activity_type: 'TRANSACTION',
    activity_category: 'RETAIL',
    activity_value: '10.0000',
    activity_value_unit: 'USD',
    channel: 'WEB',
    activity_performed_env: 'PROD',
    activity_name: 'Online purchase',
    campaign_code: 'CAMP1',
    tracker_code: 'TRK1',
    tracker_component_code: 'COMP1',
    merchant_code: null,
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

describe('RuleEvaluatorService.evaluate (pure, no DB)', () => {
  const evaluator = new RuleEvaluatorService();

  it('a single numeric rule that passes: passed=true', () => {
    const outcome = evaluator.evaluate(fakeRow({ activity_value: '10.0000' }), [
      rule({ expression: 'activity.activity_value >= 1' }),
    ]);
    expect(outcome).toEqual({ passed: true, failedRuleCode: null, comment: expect.any(String) });
  });

  it('a single numeric rule that fails: passed=false, failedRuleCode set, comment names the rule', () => {
    const outcome = evaluator.evaluate(fakeRow({ activity_value: '0.5000' }), [
      rule({ ruleCode: 'RULE_MIN_VALUE', expression: 'activity.activity_value >= 1' }),
    ]);
    expect(outcome.passed).toBe(false);
    expect(outcome.failedRuleCode).toBe('RULE_MIN_VALUE');
    expect(outcome.comment).toContain('RULE_MIN_VALUE');
  });

  it('a string equality rule that passes', () => {
    const outcome = evaluator.evaluate(fakeRow({ activity_type: 'SIGNUP' }), [
      rule({ expression: 'activity.activity_type == "SIGNUP"' }),
    ]);
    expect(outcome.passed).toBe(true);
  });

  it('a string equality rule that fails', () => {
    const outcome = evaluator.evaluate(fakeRow({ activity_type: 'TRANSACTION' }), [
      rule({ expression: 'activity.activity_type == "SIGNUP"' }),
    ]);
    expect(outcome.passed).toBe(false);
  });

  it('a string inequality rule (!=)', () => {
    const outcome = evaluator.evaluate(fakeRow({ channel: 'MOBILE' }), [
      rule({ expression: 'activity.channel != "WEB"' }),
    ]);
    expect(outcome.passed).toBe(true);
  });

  it('a compound (&&) expression: both clauses must pass', () => {
    const row = fakeRow({ channel: 'MOBILE', activity_value: '50.0000' });
    const passing = evaluator.evaluate(row, [
      rule({ expression: 'activity.channel == "MOBILE" && activity.activity_value >= 10' }),
    ]);
    expect(passing.passed).toBe(true);

    const failing = evaluator.evaluate(row, [
      rule({ expression: 'activity.channel == "MOBILE" && activity.activity_value >= 1000' }),
    ]);
    expect(failing.passed).toBe(false);
  });

  it('every bound rule must pass — the first failing rule short-circuits with its own code', () => {
    const row = fakeRow({ activity_value: '10.0000', activity_type: 'TRANSACTION' });
    const outcome = evaluator.evaluate(row, [
      rule({ ruleCode: 'RULE_A', expression: 'activity.activity_value >= 1' }),
      rule({ ruleCode: 'RULE_B', expression: 'activity.activity_type == "SIGNUP"' }),
    ]);
    expect(outcome.passed).toBe(false);
    expect(outcome.failedRuleCode).toBe('RULE_B');
  });

  it('an inactive rule is ignored entirely', () => {
    const outcome = evaluator.evaluate(fakeRow({ activity_value: '0.0000' }), [
      rule({ status: 'inactive', expression: 'activity.activity_value >= 1' }),
    ]);
    expect(outcome.passed).toBe(true);
  });

  it('no bound rules at all: vacuously passes', () => {
    const outcome = evaluator.evaluate(fakeRow(), []);
    expect(outcome.passed).toBe(true);
    expect(outcome.comment).toMatch(/no active rules/i);
  });

  it('a malformed expression throws (a genuine configuration defect, not a "rule failed" outcome)', () => {
    expect(() =>
      evaluator.evaluate(fakeRow(), [rule({ expression: 'not a valid expression' })]),
    ).toThrow();
  });

  it('a reference to an unknown activity field throws', () => {
    expect(() =>
      evaluator.evaluate(fakeRow(), [rule({ expression: 'activity.not_a_real_column == "x"' })]),
    ).toThrow();
  });

  it('an unsupported operator against a string literal throws', () => {
    expect(() =>
      evaluator.evaluate(fakeRow(), [rule({ expression: 'activity.channel >= "WEB"' })]),
    ).toThrow();
  });

  // TC-6 (evaluator half): the same row, evaluated twice, produces the identical outcome — no
  // hidden state, no non-determinism.
  it('TC-6: evaluating the same row+rules twice yields the identical outcome', () => {
    const row = fakeRow({ activity_value: '10.0000' });
    const ruleRefs = [rule({ expression: 'activity.activity_value >= 1' })];
    expect(evaluator.evaluate(row, ruleRefs)).toEqual(evaluator.evaluate(row, ruleRefs));
  });
});

describe('RuleEvaluatorService.resolveRequiredCount (pure, no DB)', () => {
  const evaluator = new RuleEvaluatorService();

  it('defaults to 1 when no rule carries a requiredCount override', () => {
    expect(evaluator.resolveRequiredCount([rule({ boundValuesJson: '{}' })])).toBe(
      DEFAULT_REQUIRED_COUNT,
    );
  });

  it('honours a camelCase requiredCount override', () => {
    expect(evaluator.resolveRequiredCount([rule({ boundValuesJson: '{"requiredCount":5}' })])).toBe(
      5,
    );
  });

  it('honours a snake_case required_count override', () => {
    expect(
      evaluator.resolveRequiredCount([rule({ boundValuesJson: '{"required_count":3}' })]),
    ).toBe(3);
  });

  it('takes the max across multiple active rules', () => {
    expect(
      evaluator.resolveRequiredCount([
        rule({ ruleCode: 'A', boundValuesJson: '{"requiredCount":2}' }),
        rule({ ruleCode: 'B', boundValuesJson: '{"requiredCount":5}' }),
      ]),
    ).toBe(5);
  });

  it("ignores an inactive rule's override", () => {
    expect(
      evaluator.resolveRequiredCount([
        rule({ status: 'inactive', boundValuesJson: '{"requiredCount":9}' }),
      ]),
    ).toBe(DEFAULT_REQUIRED_COUNT);
  });

  it('malformed boundValuesJson is logged and ignored, not thrown', () => {
    expect(() =>
      evaluator.resolveRequiredCount([rule({ boundValuesJson: 'not json' })]),
    ).not.toThrow();
    expect(evaluator.resolveRequiredCount([rule({ boundValuesJson: 'not json' })])).toBe(
      DEFAULT_REQUIRED_COUNT,
    );
  });
});

describe('buildCustomerCampaignLockKey (pure)', () => {
  it('concatenates tenant, customer hash and campaign code with ":"', () => {
    expect(buildCustomerCampaignLockKey(7, 'hash123', 'CAMP1')).toBe('7:hash123:CAMP1');
  });

  it('two different customers under the same campaign produce different keys', () => {
    expect(buildCustomerCampaignLockKey(7, 'hashA', 'CAMP1')).not.toBe(
      buildCustomerCampaignLockKey(7, 'hashB', 'CAMP1'),
    );
  });
});

describe('resolveAdvisoryLockWaitTimeoutMs (pure)', () => {
  const logger = new Logger('test');

  it('returns the resolver value when available', () => {
    const resolver: AdvisoryLockTimeoutResolver = { getAdvisoryLockWaitTimeoutMs: () => 7000 };
    expect(resolveAdvisoryLockWaitTimeoutMs(resolver, {}, logger)).toBe(7000);
  });

  it('falls back to the documented default when the resolver throws (unseeded context)', () => {
    const resolver: AdvisoryLockTimeoutResolver = {
      getAdvisoryLockWaitTimeoutMs: () => {
        throw new Error('unconfigured');
      },
    };
    expect(resolveAdvisoryLockWaitTimeoutMs(resolver, {}, logger)).toBe(
      DEFAULT_ADVISORY_LOCK_WAIT_TIMEOUT_MS,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Real Postgres, rap_app role — the concurrency/persistence proofs a mock cannot provide.
// ---------------------------------------------------------------------------------------------

describe('RuleEvaluationRowHandler / advisory lock (real Postgres, rap_app role)', () => {
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

  function pendingRowInput(overrides: Partial<FanOutRowInput> = {}): FanOutRowInput {
    return {
      correlationId: '33333333-3333-4333-8333-333333333333',
      dedupKey: `dedup-${Math.random().toString(36).slice(2)}`,
      tenantId: TENANT_ID,
      customerIdEncrypted: 'ciphertext-base64==',
      customerIdHash: 'c'.repeat(64),
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
   *      row instead of its own, exactly what independent review observed for real (a later test
   *      resolving the wrong tracker/component from a stranger row) — see the regression test
   *      below, which reproduces this deterministically.
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
  // instead of its own, tripping this file's own "Cached campaign config ... has no active
  // tracker/component matching" error even though nothing about the later call's own row or
  // fixtures was wrong (exactly what independent review observed for real in this file's TC-4).
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

  function trackerComponentProto(componentId: number, componentCode: string) {
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
    componentId: number;
    componentCode: string;
    rules: BoundRuleProto[];
  }): CampaignConfigProto {
    return {
      campaignId: 9001,
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
          trackerId: 801,
          trackerCode: overrides.trackerCode,
          name: overrides.trackerCode,
          completionLogic: 'all',
          completionThreshold: 1,
          status: 'active',
          components: [trackerComponentProto(overrides.componentId, overrides.componentCode)],
        },
      ],
      rules: overrides.rules,
      rewards: [],
      etag: 'etag-1',
      configHash: 'hash-1',
      notModified: false,
      servedAt: '2026-01-01T00:00:00.000Z',
      caps: [],
      sectionsReturned: ['BASIC', 'MERCHANTS', 'TRACKERS', 'RULES', 'REWARDS', 'CAPS'],
      sectionsOmitted: [],
    };
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
    overrides: {
      progressRepository?: TrackerComponentProgressRepository;
      metrics?: MetricsService;
    } = {},
  ): RuleEvaluationRowHandler {
    return new RuleEvaluationRowHandler(
      sequelize,
      fakeCacheFor(config),
      ruleEvaluator,
      overrides.progressRepository ?? progressRepository,
      trackerStatusRepository,
      resolver,
      // Every fixture in this file seeds `rewards: []`, so `CapEnforcementService` is never
      // actually invoked (`resolveRewardAssignments` short-circuits on an empty list) — T-RAP-033's
      // own `cap-enforcement.spec.ts` exercises the real service.
      {} as unknown as CapEnforcementService,
      // Same reasoning — with no granted assignments ever produced, T-RAP-034's reward-entry
      // insert path is never reached either; T-RAP-034's own tests exercise the real repositories.
      {} as unknown as RewardEntryRepository,
      {} as unknown as RewardEntryOutboxRepository,
      overrides.metrics ?? new MetricsService(),
      fakeLoggerFactory(),
    );
  }

  async function loadProgress(
    trackerComponentCode: string,
    customerIdHash: string,
  ): Promise<CustomerTrackerComponentProgressRow[]> {
    return sequelize.query<CustomerTrackerComponentProgressRow>(
      `SELECT * FROM realtime_activity_processing.customer_tracker_component_progress
        WHERE tenant_id = :tenantId AND customer_id_hash = :customerIdHash
          AND tracker_component_code = :trackerComponentCode
        ORDER BY completion_cycle ASC`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId: TENANT_ID, customerIdHash, trackerComponentCode },
      },
    );
  }

  async function loadActivityLog(id: string): Promise<ActivityLogRow> {
    const [row] = await sequelize.query<ActivityLogRow>(
      'SELECT * FROM realtime_activity_processing.activity_logs WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    return row;
  }

  // TC-1: first contributing activity, requiredCount=2 -> not yet completed.
  it('TC-1: first passing activity creates a progress row, current_count=1, is_completed=false', async () => {
    const customerIdHash = `tc1-${Math.random().toString(36).slice(2)}`;
    const config = campaignConfig({
      trackerCode: 'TRK_TC1',
      componentId: 9101,
      componentCode: 'COMP_TC1',
      rules: [
        rule({
          ruleId: 9101,
          ruleCode: 'RULE_TC1',
          expression: 'activity.activity_value >= 1',
          boundValuesJson: '{"requiredCount":2}',
          trackerComponentId: 9101,
        }),
      ],
    });
    const row = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_TC1',
      trackerComponentCode: 'COMP_TC1',
      activityValue: '10.0000',
    });

    await buildHandler(config).handle(row);

    const [progress] = await loadProgress('COMP_TC1', customerIdHash);
    expect(progress.current_count).toBe(1);
    expect(progress.is_completed).toBe(false);
    expect(progress.required_count).toBe(2);

    const activityLog = await loadActivityLog(row.id);
    expect(activityLog.status).toBe('processed');
    expect(activityLog.comment).toBeTruthy();
  });

  // T-RAP-059: `markProcessed`'s own log line carries correlationId/tenantId/campaignCode as
  // separate structured JSON fields (06-CONFIGURABILITY-AND-OBSERVABILITY.md §3), never
  // string-interpolated into the message — asserted against the actual emitted console line, not
  // an internal implementation string.
  it('T-RAP-059: the row-completion log line carries correlationId/tenantId/campaignCode as separate JSON fields', async () => {
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
    try {
      const customerIdHash = `t-rap-059-${Math.random().toString(36).slice(2)}`;
      const config = campaignConfig({
        trackerCode: 'TRK_T059',
        componentId: 9059,
        componentCode: 'COMP_T059',
        rules: [
          rule({
            ruleId: 9059,
            ruleCode: 'RULE_T059',
            expression: 'activity.activity_value >= 1',
            trackerComponentId: 9059,
          }),
        ],
      });
      const row = await insertAndClaim({
        customerIdHash,
        trackerCode: 'TRK_T059',
        trackerComponentCode: 'COMP_T059',
        activityValue: '10.0000',
      });

      await buildHandler(config).handle(row);

      const entries = debugSpy.mock.calls
        .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
        .filter((entry) => entry.activityLogId === row.id);
      expect(entries).toHaveLength(1);
      expect(entries[0].correlationId).toBe(row.correlation_id);
      expect(entries[0].tenantId).toBe(row.tenant_id);
      expect(entries[0].campaignCode).toBe(row.campaign_code);
      // Never baked into the free-text message itself — proves the fields are structural, not
      // string-interpolated.
      expect(String(entries[0].message)).not.toContain(row.correlation_id);
    } finally {
      debugSpy.mockRestore();
    }
  });

  // TC-2: reaching required_count.
  it('TC-2: reaching required_count sets is_completed=true and completed_at', async () => {
    const customerIdHash = `tc2-${Math.random().toString(36).slice(2)}`;
    const config = campaignConfig({
      trackerCode: 'TRK_TC2',
      componentId: 9102,
      componentCode: 'COMP_TC2',
      rules: [
        rule({
          ruleId: 9102,
          ruleCode: 'RULE_TC2',
          expression: 'activity.activity_value >= 1',
          boundValuesJson: '{"requiredCount":2}',
          trackerComponentId: 9102,
        }),
      ],
    });
    const metrics = new MetricsService();
    const handler = buildHandler(config, { metrics });

    const rowA = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_TC2',
      trackerComponentCode: 'COMP_TC2',
      activityValue: '10.0000',
    });
    await handler.handle(rowA);
    // T-RAP-059 regression: not yet complete after the first passing activity (requiredCount=2).
    expect(
      metrics.getCounterValue('tracker_components_completed_total', { campaign_code: 'CAMP1' }),
    ).toBe(0);
    const rowB = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_TC2',
      trackerComponentCode: 'COMP_TC2',
      activityValue: '10.0000',
    });
    await handler.handle(rowB);

    const [progress] = await loadProgress('COMP_TC2', customerIdHash);
    expect(progress.current_count).toBe(2);
    expect(progress.is_completed).toBe(true);
    // T-RAP-059: tracker_components_completed_total{campaign_code} increments exactly once, the
    // instant the component's own required_count is reached.
    expect(
      metrics.getCounterValue('tracker_components_completed_total', { campaign_code: 'CAMP1' }),
    ).toBe(1);
    expect(progress.completed_at).not.toBeNull();
  });

  // TC-3: a rule fails.
  it('TC-3: a failing rule leaves activity_logs processed with an explanatory comment and no progress row', async () => {
    const customerIdHash = `tc3-${Math.random().toString(36).slice(2)}`;
    const config = campaignConfig({
      trackerCode: 'TRK_TC3',
      componentId: 9103,
      componentCode: 'COMP_TC3',
      rules: [
        rule({
          ruleId: 9103,
          ruleCode: 'RULE_TC3',
          expression: 'activity.activity_type == "SIGNUP"',
          trackerComponentId: 9103,
        }),
      ],
    });
    const row = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_TC3',
      trackerComponentCode: 'COMP_TC3',
      activityType: 'TRANSACTION',
    });

    await buildHandler(config).handle(row);

    const progress = await loadProgress('COMP_TC3', customerIdHash);
    expect(progress).toHaveLength(0);

    const activityLog = await loadActivityLog(row.id);
    expect(activityLog.status).toBe('processed');
    expect(activityLog.error_code).toBeNull();
    expect(activityLog.comment).toContain('RULE_TC3');
  });

  // TC-4: two activities for the same customer+campaign processed concurrently.
  it('TC-4: two concurrent activities for the same customer+campaign — no lost update, final current_count reflects both', async () => {
    const customerIdHash = `tc4-${Math.random().toString(36).slice(2)}`;
    const config = campaignConfig({
      trackerCode: 'TRK_TC4',
      componentId: 9104,
      componentCode: 'COMP_TC4',
      rules: [
        rule({
          ruleId: 9104,
          ruleCode: 'RULE_TC4',
          expression: 'activity.activity_value >= 1',
          boundValuesJson: '{"requiredCount":2}',
          trackerComponentId: 9104,
        }),
      ],
    });
    const handler = buildHandler(config);

    const rowA = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_TC4',
      trackerComponentCode: 'COMP_TC4',
      activityValue: '10.0000',
    });
    const rowB = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_TC4',
      trackerComponentCode: 'COMP_TC4',
      activityValue: '10.0000',
    });

    await Promise.all([handler.handle(rowA), handler.handle(rowB)]);

    const [progress] = await loadProgress('COMP_TC4', customerIdHash);
    expect(progress.current_count).toBe(2);
    expect(progress.is_completed).toBe(true);
  });

  // Verification step 2: the advisory lock genuinely serializes same-key transactions — proven by
  // real timestamps, not by inference from the end state above.
  //
  // T-RAP-048 retry 3/3: this test's own steady-state cost is tiny (two sequential 150ms holds,
  // ~300ms total), but it opens two real Postgres connections/transactions and genuinely blocks on
  // `pg_advisory_xact_lock` — under extreme *system-level* contention (CPU/IO/connection-pool
  // starvation from the rest of a full unfiltered `npm test` run happening at the same instant,
  // not a defect in this test's own logic or in `acquireCustomerCampaignAdvisoryLock`'s
  // serialization) that can occasionally take much longer than Jest's 5000ms default per-test
  // timeout — reproduced deterministically during diagnosis (see the regression test directly
  // below, and the task's own completion report) by temporarily stretching `holdMs` well past
  // 5000ms with no explicit timeout override: it fails with exactly the reported signature
  // ("Exceeded timeout of 5000 ms", pointing at the `it()` line, no `expect()` diff). Raising only
  // this test's own timeout (not the lock/serialization logic, which is provably correct — the
  // release timestamp is always recorded before the real `COMMIT` that releases the lock) absorbs
  // that slack without weakening what the test actually proves.
  //
  // (This was diagnosed and fixed under a separately-filed T-RAP-054 during the previous retry.
  // Per AGENT-PROTOCOL.md §7.1 — "don't file your own bugs; if the file is one your task owns, it
  // is in scope, fix it" — this file is one of T-RAP-048's own owned files, so that filing was
  // itself the defect: independent review correctly rejected it. The fix stands exactly as
  // diagnosed; it is simply re-attributed here as T-RAP-048's own in-scope work, and T-RAP-054 has
  // been removed from this task's `depends` — see this task's completion report.)
  it('verification step 2: the advisory lock serializes same-key transactions (measurable via timestamps)', async () => {
    const customerIdHash = `lock-${Math.random().toString(36).slice(2)}`;
    const timeline: { label: string; acquiredAt: number; releasedAt: number }[] = [];

    async function holdLock(label: string, holdMs: number): Promise<void> {
      await sequelize.transaction(async (transaction: Transaction) => {
        await acquireCustomerCampaignAdvisoryLock(sequelize, transaction, {
          tenantId: TENANT_ID,
          customerIdHash,
          campaignCode: 'CAMP_LOCK',
          waitTimeoutMs: 5000,
        });
        const acquiredAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        timeline.push({ label, acquiredAt, releasedAt: Date.now() });
      });
    }

    await Promise.all([holdLock('first', 150), holdLock('second', 150)]);

    expect(timeline).toHaveLength(2);
    const [a, b] = timeline;
    // Serialized: whichever ran second must have acquired the lock at/after the other's release.
    const [earlier, later] = a.releasedAt <= b.acquiredAt ? [a, b] : [b, a];
    expect(later.acquiredAt).toBeGreaterThanOrEqual(earlier.releasedAt);
  }, 15_000);

  // T-RAP-048 regression (TC-3): proves the actual mechanism of the fix above, deterministically
  // rather than waiting for a 1-in-N real scheduling anomaly. This transaction is deliberately
  // slower than Jest's own 5000ms per-test default even with zero system contention — a genuinely
  // correct, real-Postgres advisory-lock transaction that simply takes a while. Reverting this
  // test's own explicit timeout (the third `it()` argument) reproduces the exact reported failure
  // signature: "Exceeded timeout of 5000 ms", pointing at this `it()` declaration, no `expect()`
  // diff — proven during diagnosis and recorded in this task's completion report. With the
  // explicit override in place, it passes comfortably.
  it("T-RAP-048 regression: a genuinely slow (but correct) real-lock transaction must not fail merely for exceeding Jest's 5000ms default", async () => {
    const customerIdHash = `t-rap-048-slow-${Math.random().toString(36).slice(2)}`;
    const start = Date.now();

    await sequelize.transaction(async (transaction: Transaction) => {
      await acquireCustomerCampaignAdvisoryLock(sequelize, transaction, {
        tenantId: TENANT_ID,
        customerIdHash,
        campaignCode: 'CAMP_LOCK_SLOW',
        waitTimeoutMs: 10_000,
      });
      // Deliberately past Jest's 5000ms per-test default -- simulates exactly the "genuinely
      // slow, genuinely correct real-Postgres transaction" shape the reported defect describes,
      // without depending on real full-suite system contention to trigger it.
      await new Promise((resolve) => setTimeout(resolve, 5_300));
    });

    expect(Date.now() - start).toBeGreaterThanOrEqual(5_300);
  }, 8_000);

  // TC-5: a repeatable component already complete starts a new completion_cycle.
  it('TC-5: a repeatable component already complete starts a new completion_cycle, not a double-mark', async () => {
    const customerIdHash = `tc5-${Math.random().toString(36).slice(2)}`;
    const config = campaignConfig({
      trackerCode: 'TRK_TC5',
      componentId: 9105,
      componentCode: 'COMP_TC5',
      rules: [
        rule({
          ruleId: 9105,
          ruleCode: 'RULE_TC5',
          expression: 'activity.activity_value >= 1',
          // No requiredCount override -> DEFAULT_REQUIRED_COUNT (1): completes on the first pass.
          trackerComponentId: 9105,
        }),
      ],
    });
    const handler = buildHandler(config);

    const rowA = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_TC5',
      trackerComponentCode: 'COMP_TC5',
      activityValue: '10.0000',
    });
    await handler.handle(rowA);

    const rowB = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_TC5',
      trackerComponentCode: 'COMP_TC5',
      activityValue: '10.0000',
    });
    await handler.handle(rowB);

    const rows = await loadProgress('COMP_TC5', customerIdHash);
    expect(rows).toHaveLength(2);
    expect(rows[0].completion_cycle).toBe(1);
    expect(rows[0].is_completed).toBe(true);
    expect(rows[0].current_count).toBe(1);
    expect(rows[1].completion_cycle).toBe(2);
    expect(rows[1].is_completed).toBe(true);
    expect(rows[1].current_count).toBe(1);
  });

  // TC-6: a simulated crash-and-retry on the same claimed row is idempotent — no double-increment.
  it('TC-6: a simulated crash after the progress write (before commit) leaves no trace; the retried attempt produces exactly one increment', async () => {
    const customerIdHash = `tc6-${Math.random().toString(36).slice(2)}`;
    const config = campaignConfig({
      trackerCode: 'TRK_TC6',
      componentId: 9106,
      componentCode: 'COMP_TC6',
      rules: [
        rule({
          ruleId: 9106,
          ruleCode: 'RULE_TC6',
          expression: 'activity.activity_value >= 1',
          trackerComponentId: 9106,
        }),
      ],
    });

    class CrashOnceProgressRepository extends TrackerComponentProgressRepository {
      crashed = false;
      async upsertOnPassingActivity(
        transaction: Transaction,
        input: UpsertProgressInput,
      ): Promise<UpsertProgressResult> {
        // Real work happens inside the transaction first, proving the crash below rolls back
        // work that already ran, not just work that never started.
        const result = await super.upsertOnPassingActivity(transaction, input);
        if (!this.crashed) {
          this.crashed = true;
          throw new Error('simulated crash after progress write, before commit');
        }
        return result;
      }
    }
    const crashRepository = new CrashOnceProgressRepository(sequelize);
    const crashHandler = buildHandler(config, { progressRepository: crashRepository });

    const row = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_TC6',
      trackerComponentCode: 'COMP_TC6',
      activityValue: '10.0000',
    });

    await expect(crashHandler.handle(row)).rejects.toThrow('simulated crash');

    // Nothing committed: no progress row, activity_logs row still `processing` (T-RAP-030's own
    // stale sweep is what would reclaim it back to `pending` in production — this test drives the
    // retry directly instead of waiting on that timeout).
    expect(await loadProgress('COMP_TC6', customerIdHash)).toHaveLength(0);
    const afterCrash = await loadActivityLog(row.id);
    expect(afterCrash.status).toBe('processing');

    // Retry with the real (non-crashing) repository — same claimed row, same transaction shape.
    const realHandler = buildHandler(config);
    await realHandler.handle(row);

    const rows = await loadProgress('COMP_TC6', customerIdHash);
    expect(rows).toHaveLength(1);
    expect(rows[0].current_count).toBe(1);
    expect(rows[0].is_completed).toBe(true);
    const afterRetry = await loadActivityLog(row.id);
    expect(afterRetry.status).toBe('processed');
  });

  it("a cached campaign config that no longer has the claimed row's tracker/component throws (genuine error, not a rule outcome)", async () => {
    const customerIdHash = `err-${Math.random().toString(36).slice(2)}`;
    const config = campaignConfig({
      trackerCode: 'TRK_OTHER',
      componentId: 9199,
      componentCode: 'COMP_OTHER',
      rules: [],
    });
    const row = await insertAndClaim({
      customerIdHash,
      trackerCode: 'TRK_MISSING',
      trackerComponentCode: 'COMP_MISSING',
    });

    await expect(buildHandler(config).handle(row)).rejects.toThrow(/no active tracker\/component/i);
  });
});
