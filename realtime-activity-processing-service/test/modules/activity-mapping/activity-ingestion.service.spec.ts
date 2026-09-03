/**
 * T-RAP-021 / T-RAP-058. Unit tests for `ActivityIngestionService.ingest` — every collaborator
 * (`CorrelationIdService`, `IdempotencyService`, `ActivityMapper`, `EncryptionService`,
 * `LogRedactorService`, `ActivityLogsRepository`, the Sequelize connection) is a hand-rolled fake,
 * no DB, no Nest test module. Real-Postgres concurrency behaviour (TC-7's actual race) is proven
 * separately in `activity-logs.repository.spec.ts`; this suite proves `ingest`'s own orchestration
 * — what gets passed to each collaborator, and how their outputs become the returned `IngestResult`.
 *
 * `MetricsService`/`StructuredLoggerFactory` are the *real* T-RAP-043 classes, not fakes — both are
 * plain, dependency-light and already designed for exactly this kind of assertion
 * (`MetricsService.getCounterValue`, `StructuredLogger`'s own `console.*` output,
 * `structured-logger.spec.ts`'s own testing convention) — a fake would only restate what those
 * classes already guarantee, which is a change-detector, not a test (`AGENT-PROTOCOL.md` §3).
 */
import type { Transaction } from 'sequelize';
import { ActivityIngestionService } from '@/modules/activity-mapping/activity-ingestion.service';
import type {
  ActivityLogsRepository,
  InsertedFanOutRow,
} from '@/modules/activity-mapping/activity-logs.repository';
import type { ActivityMapper } from '@/modules/activity-mapping/activity-mapper';
import type { CorrelationIdService } from '@/modules/idempotency/correlation-id.service';
import type { IdempotencyService } from '@/modules/idempotency/idempotency.service';
import type { InboundActivity } from '@/modules/idempotency/inbound-activity.types';
import type { EncryptionService } from '@/modules/encryption/encryption.service';
import type { LogRedactorService } from '@/modules/encryption/log-redactor.service';
import type { MatchedTrackerComponent } from '@/modules/campaign-cache/campaign-config-cache.service';
import { MetricsService } from '@/observability/metrics.service';
import { StructuredLoggerFactory } from '@/observability/structured-logger';

function buildActivity(overrides: Partial<InboundActivity> = {}): InboundActivity {
  return {
    tenantId: 1,
    customerId: 'CUST-PLAINTEXT-00042',
    customerIdType: 'INTERNAL_ID',
    activityPerformedDate: new Date('2026-09-01T10:15:30.000Z'),
    activityCode: 'PURCHASE',
    activityType: 'TRANSACTION',
    activityCategory: 'RETAIL',
    activityValue: '100.0000',
    activityValueUnit: 'USD',
    channel: 'WEB',
    activityPerformedEnv: 'PROD',
    activityName: 'Online purchase',
    sourceTransport: 'GRPC',
    ...overrides,
  };
}

function component(overrides: Partial<MatchedTrackerComponent> = {}): MatchedTrackerComponent {
  return {
    tenantId: 1,
    campaignCode: 'CAMP1',
    campaignId: 1,
    trackerCode: 'TRK1',
    trackerId: 1,
    componentCode: 'COMP1',
    componentId: 1,
    activityId: 1,
    activityCode: 'PURCHASE',
    ...overrides,
  };
}

const CIPHERTEXT = 'CIPHERTEXT-base64==';
const HASH = 'h'.repeat(64);

interface Harness {
  service: ActivityIngestionService;
  correlationIdService: CorrelationIdService;
  idempotencyService: IdempotencyService;
  mapper: ActivityMapper;
  encryption: EncryptionService;
  logRedactor: LogRedactorService;
  repository: ActivityLogsRepository;
  insertFanOutRows: jest.Mock;
  metrics: MetricsService;
}

function buildHarness(
  options: {
    matches?: MatchedTrackerComponent[];
    insertedRows?: InsertedFanOutRow[] | ((rows: unknown[]) => InsertedFanOutRow[]);
    dedupKey?: string;
  } = {},
): Harness {
  const matches = options.matches ?? [component()];

  const correlationIdService = {
    resolve: jest.fn((input?: string) => input || 'generated-correlation-id'),
  } as unknown as CorrelationIdService;

  const idempotencyService = {
    deriveDedupKey: jest.fn(() => options.dedupKey ?? 'dedup-key-1'),
  } as unknown as IdempotencyService;

  const mapper = {
    mapToComponents: jest.fn(() => matches),
  } as unknown as ActivityMapper;

  const encryption = {
    encrypt: jest.fn(() => CIPHERTEXT),
    hash: jest.fn(() => HASH),
  } as unknown as EncryptionService;

  const logRedactor = {
    redact: jest.fn((_field: string, value: string) => value),
  } as unknown as LogRedactorService;

  const insertFanOutRows = jest.fn(async (rows: unknown[]) => {
    if (typeof options.insertedRows === 'function') {
      return options.insertedRows(rows);
    }
    if (options.insertedRows) {
      return options.insertedRows;
    }
    // Default: everything requested lands, mirroring a fresh (non-duplicate) insert.
    return (
      rows as {
        dedupKey: string;
        campaignCode: string;
        trackerCode: string;
        trackerComponentCode: string;
      }[]
    ).map((row, i) => ({
      id: `row-${i}`,
      dedupKey: row.dedupKey,
      campaignCode: row.campaignCode,
      trackerCode: row.trackerCode,
      trackerComponentCode: row.trackerComponentCode,
    }));
  });

  const repository = { insertFanOutRows } as unknown as ActivityLogsRepository;

  const sequelize = {
    transaction: jest.fn(async (cb: (t: Transaction) => Promise<unknown>) => cb({} as Transaction)),
  };

  const metrics = new MetricsService();
  const loggerFactory = new StructuredLoggerFactory(logRedactor);

  const service = new ActivityIngestionService(
    correlationIdService,
    idempotencyService,
    mapper,
    encryption,
    logRedactor,
    repository,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only fake connection, not `any` in production code (R9)
    sequelize as any,
    metrics,
    loggerFactory,
  );

  return {
    service,
    correlationIdService,
    idempotencyService,
    mapper,
    encryption,
    logRedactor,
    repository,
    insertFanOutRows,
    metrics,
  };
}

describe('ActivityIngestionService.ingest', () => {
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    // T-RAP-058: `this.logger` is now `StructuredLogger`, which writes one JSON line per call via
    // `console.log` (`structured-logger.spec.ts`'s own testing convention) — no more `Logger`.
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // TC-1: activityCode matching exactly one active component -> one row, pending (repository is
  // the one that actually writes 'pending' — this asserts the row handed to it is correct).
  it('inserts exactly one fan-out row for a single-component match', async () => {
    const { service, insertFanOutRows } = buildHarness({ matches: [component()] });

    const result = await service.ingest(buildActivity());

    expect(insertFanOutRows).toHaveBeenCalledTimes(1);
    const [rows] = insertFanOutRows.mock.calls[0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      campaignCode: 'CAMP1',
      trackerCode: 'TRK1',
      trackerComponentCode: 'COMP1',
      customerIdEncrypted: CIPHERTEXT,
      customerIdHash: HASH,
      sourceTransport: 'GRPC',
    });
    expect(result.status).toBe('accepted');
    expect(result.matchedTrackerComponents).toEqual(['COMP1']);
  });

  // TC-2: two matched components in the same campaign -> two rows, same correlationId/dedupKey.
  it('inserts one row per matched component in the same campaign, sharing correlationId/dedupKey', async () => {
    const matches = [component({ componentCode: 'COMP1' }), component({ componentCode: 'COMP2' })];
    const { service, insertFanOutRows } = buildHarness({ matches });

    const result = await service.ingest(buildActivity({ correlationId: 'caller-corr-id' }));

    const [rows] = insertFanOutRows.mock.calls[0];
    expect(rows).toHaveLength(2);
    expect(rows.every((r: { correlationId: string }) => r.correlationId === 'caller-corr-id')).toBe(
      true,
    );
    expect(new Set(rows.map((r: { dedupKey: string }) => r.dedupKey)).size).toBe(1);
    expect(result.matchedTrackerComponents.sort()).toEqual(['COMP1', 'COMP2']);
  });

  // TC-3: components in two different campaigns -> one row per campaign, both pending.
  it('inserts one row per campaign when the activity matches components in different campaigns', async () => {
    const matches = [
      component({ campaignCode: 'CAMP1', componentCode: 'COMP1' }),
      component({ campaignCode: 'CAMP2', componentCode: 'COMP2' }),
    ];
    const { service, insertFanOutRows } = buildHarness({ matches });

    await service.ingest(buildActivity());

    const [rows] = insertFanOutRows.mock.calls[0];
    expect(new Set(rows.map((r: { campaignCode: string }) => r.campaignCode))).toEqual(
      new Set(['CAMP1', 'CAMP2']),
    );
  });

  // TC-4: transactionType-only activity resolves to the matched component's own activityCode.
  it('stores the resolved activityCode when the activity only carried a transactionType', async () => {
    const matches = [component({ activityCode: 'RESOLVED_CODE' })];
    const { service, insertFanOutRows } = buildHarness({ matches });

    await service.ingest(
      buildActivity({ activityCode: undefined, transactionType: 'TXN_PURCHASE' }),
    );

    const [rows] = insertFanOutRows.mock.calls[0];
    expect(rows[0].activityCode).toBe('RESOLVED_CODE');
    expect(rows[0].transactionType).toBe('TXN_PURCHASE');
  });

  // TC-5: zero matches -> no insert attempted, not an error.
  it('does not call the repository and reports accepted/[] when nothing matches', async () => {
    const { service, insertFanOutRows } = buildHarness({ matches: [] });

    const result = await service.ingest(buildActivity());

    expect(insertFanOutRows).not.toHaveBeenCalled();
    expect(result).toEqual({
      correlationId: 'generated-correlation-id',
      dedupKey: 'dedup-key-1',
      status: 'accepted',
      matchedTrackerComponents: [],
    });
  });

  // TC-6: whole-activity duplicate -> repository returns [] (every tuple already existed) ->
  // 'duplicate', no new rows reported.
  it('reports duplicate with no matchedTrackerComponents when nothing new was inserted', async () => {
    const { service } = buildHarness({ matches: [component()], insertedRows: [] });

    const result = await service.ingest(buildActivity());

    expect(result.status).toBe('duplicate');
    expect(result.matchedTrackerComponents).toEqual([]);
  });

  // Task implementation note 4: partial duplicate — some rows land, some don't -> still 'accepted'.
  it('reports accepted when only some of the matched rows are genuinely new', async () => {
    const matches = [component({ componentCode: 'COMP1' }), component({ componentCode: 'COMP2' })];
    const { service } = buildHarness({
      matches,
      insertedRows: (rows) =>
        (
          rows as {
            dedupKey: string;
            campaignCode: string;
            trackerCode: string;
            trackerComponentCode: string;
          }[]
        )
          .filter((r) => r.trackerComponentCode === 'COMP2')
          .map((r, i) => ({ id: `row-${i}`, ...r })),
    });

    const result = await service.ingest(buildActivity());

    expect(result.status).toBe('accepted');
    expect(result.matchedTrackerComponents).toEqual(['COMP2']);
  });

  // TC-8: no plaintext or ciphertext customerId in any log line. Now that `this.logger` is a
  // `StructuredLogger` (T-RAP-058), a call site emits one JSON line via `console.log` per call —
  // this asserts the whole serialized line (every field, not just `message`), since a structured
  // logger makes it just as easy to leak a value into an extra field as into `message` itself.
  it('never logs the plaintext or ciphertext customerId', async () => {
    const { service } = buildHarness({ matches: [component()] });

    await service.ingest(buildActivity({ customerId: 'CUST-PLAINTEXT-00042' }));

    const loggedLines = consoleLogSpy.mock.calls.map((call) => String(call[0]));
    expect(loggedLines.length).toBeGreaterThan(0);
    for (const line of loggedLines) {
      expect(line).not.toContain('CUST-PLAINTEXT-00042');
      expect(line).not.toContain(CIPHERTEXT);
    }
    // The hash IS a safe, expected identifier in logs (R4: "use customer_id_hash ... for every
    // ... log").
    expect(loggedLines.some((line) => line.includes(HASH))).toBe(true);
  });

  it('derives customerIdEncrypted/customerIdHash from EncryptionService, never a raw or ad hoc value', async () => {
    const { service, encryption, insertFanOutRows } = buildHarness({ matches: [component()] });

    await service.ingest(buildActivity({ customerId: 'CUST-PLAINTEXT-00042' }));

    expect(encryption.encrypt).toHaveBeenCalledWith('CUST-PLAINTEXT-00042');
    expect(encryption.hash).toHaveBeenCalledWith('CUST-PLAINTEXT-00042');
    const [rows] = insertFanOutRows.mock.calls[0];
    expect(rows[0].customerIdEncrypted).toBe(CIPHERTEXT);
    expect(rows[0].customerIdHash).toBe(HASH);
  });

  it('runs activityValue through LogRedactorService (config-driven redaction, no code change needed)', async () => {
    const { service, logRedactor } = buildHarness({ matches: [component()] });

    await service.ingest(buildActivity({ activityValue: '250.5000' }));

    expect(logRedactor.redact).toHaveBeenCalledWith('activityValue', '250.5000', {
      tenantId: 1,
    });
  });

  it('resolves correlationId via CorrelationIdService and dedupKey via IdempotencyService, then reuses both for every row', async () => {
    const { service, correlationIdService, idempotencyService, insertFanOutRows } = buildHarness({
      matches: [component({ componentCode: 'COMP1' }), component({ componentCode: 'COMP2' })],
    });

    const activity = buildActivity({ correlationId: 'caller-corr-id' });
    const result = await service.ingest(activity);

    expect(correlationIdService.resolve).toHaveBeenCalledWith('caller-corr-id');
    expect(idempotencyService.deriveDedupKey).toHaveBeenCalledWith(activity);
    expect(result.correlationId).toBe('caller-corr-id');
    expect(result.dedupKey).toBe('dedup-key-1');
    const [rows] = insertFanOutRows.mock.calls[0];
    expect(
      rows.every(
        (r: { correlationId: string; dedupKey: string }) =>
          r.correlationId === 'caller-corr-id' && r.dedupKey === 'dedup-key-1',
      ),
    ).toBe(true);
  });
});

/**
 * T-RAP-058. `06-CONFIGURABILITY-AND-OBSERVABILITY.md` §3's own contract, exercised at this file's
 * one real call site: `activities_ingested_total{transport}`, `activity_logs_fanout_total` and
 * `dedup_hits_total` increment exactly where the defect's evidence specifies, and every log line
 * carries `correlationId`/`tenantId`/`campaignCode` as separate JSON fields, never interpolated
 * into `message`.
 */
describe('ActivityIngestionService.ingest — observability (T-RAP-058)', () => {
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function loggedEntries(): Record<string, unknown>[] {
    return consoleLogSpy.mock.calls.map((call) => JSON.parse(String(call[0])));
  }

  // TC-1 (reproduce before fix): asserted below as the fixed behaviour, and separately proven to
  // fail on the pre-fix code by temporarily reverting this file's own production changes and
  // re-running this suite (see this task's completion report) — TC-3's own regression requirement.
  it('increments activities_ingested_total{transport} exactly once per inbound activity, labelled by sourceTransport', async () => {
    const { service, metrics } = buildHarness({ matches: [component()] });

    await service.ingest(buildActivity({ sourceTransport: 'GRPC' }));
    await service.ingest(buildActivity({ sourceTransport: 'KAFKA' }));

    expect(metrics.getCounterValue('activities_ingested_total', { transport: 'grpc' })).toBe(1);
    expect(metrics.getCounterValue('activities_ingested_total', { transport: 'kafka' })).toBe(1);
  });

  it('increments activities_ingested_total even when the activity matches nothing (still "ingested")', async () => {
    const { service, metrics } = buildHarness({ matches: [] });

    await service.ingest(buildActivity({ sourceTransport: 'GRPC' }));

    expect(metrics.getCounterValue('activities_ingested_total', { transport: 'grpc' })).toBe(1);
  });

  it('increments activity_logs_fanout_total by the number of rows actually inserted', async () => {
    const matches = [component({ componentCode: 'COMP1' }), component({ componentCode: 'COMP2' })];
    const { service, metrics } = buildHarness({ matches });

    await service.ingest(buildActivity());

    expect(metrics.getCounterValue('activity_logs_fanout_total')).toBe(2);
  });

  it('does not increment activity_logs_fanout_total when nothing matched (no insert attempted)', async () => {
    const { service, metrics } = buildHarness({ matches: [] });

    await service.ingest(buildActivity());

    expect(metrics.getCounterValue('activity_logs_fanout_total')).toBe(0);
  });

  it('increments activity_logs_fanout_total by only the genuinely-new rows on a partial duplicate', async () => {
    const matches = [component({ componentCode: 'COMP1' }), component({ componentCode: 'COMP2' })];
    const { service, metrics } = buildHarness({
      matches,
      insertedRows: (rows) =>
        (
          rows as {
            dedupKey: string;
            campaignCode: string;
            trackerCode: string;
            trackerComponentCode: string;
          }[]
        )
          .filter((r) => r.trackerComponentCode === 'COMP2')
          .map((r, i) => ({ id: `row-${i}`, ...r })),
    });

    await service.ingest(buildActivity());

    expect(metrics.getCounterValue('activity_logs_fanout_total')).toBe(1);
  });

  it('increments dedup_hits_total exactly on a whole-activity duplicate, never on a fresh or partial insert', async () => {
    const { service: duplicateService, metrics: duplicateMetrics } = buildHarness({
      matches: [component()],
      insertedRows: [],
    });
    await duplicateService.ingest(buildActivity());
    expect(duplicateMetrics.getCounterValue('dedup_hits_total')).toBe(1);

    const { service: freshService, metrics: freshMetrics } = buildHarness({
      matches: [component()],
    });
    await freshService.ingest(buildActivity());
    expect(freshMetrics.getCounterValue('dedup_hits_total')).toBe(0);

    const partialMatches = [
      component({ componentCode: 'COMP1' }),
      component({ componentCode: 'COMP2' }),
    ];
    const { service: partialService, metrics: partialMetrics } = buildHarness({
      matches: partialMatches,
      insertedRows: (rows) =>
        (rows as { trackerComponentCode: string }[])
          .filter((r) => r.trackerComponentCode === 'COMP2')
          .map((r, i) => ({ id: `row-${i}`, ...r }) as unknown as InsertedFanOutRow),
    });
    await partialService.ingest(buildActivity());
    expect(partialMetrics.getCounterValue('dedup_hits_total')).toBe(0);

    const { service: zeroMatchService, metrics: zeroMatchMetrics } = buildHarness({ matches: [] });
    await zeroMatchService.ingest(buildActivity());
    expect(zeroMatchMetrics.getCounterValue('dedup_hits_total')).toBe(0);
  });

  // TC-2/TC-3: the actual observable property — assert the parsed JSON structure a real log
  // aggregator would filter/aggregate on, not a restated literal (AGENT-PROTOCOL.md §3).
  it('emits correlationId/tenantId/campaignCode as separate structured JSON fields, never interpolated into the log message', async () => {
    const { service } = buildHarness({ matches: [component({ campaignCode: 'CAMP1' })] });

    await service.ingest(buildActivity({ correlationId: 'corr-structured-1', tenantId: 9 }));

    const entries = loggedEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.correlationId).toBe('corr-structured-1');
      expect(typeof entry.message).toBe('string');
      expect(String(entry.message)).not.toContain('corr-structured-1');
    }
    expect(entries.some((entry) => entry.tenantId === 9)).toBe(true);
    expect(entries.some((entry) => entry.campaignCode === 'CAMP1')).toBe(true);
  });

  it('omits campaignCode from the summary log when matches span more than one campaign, rather than guessing', async () => {
    const matches = [
      component({ campaignCode: 'CAMP1', componentCode: 'COMP1' }),
      component({ campaignCode: 'CAMP2', componentCode: 'COMP2' }),
    ];
    const { service } = buildHarness({ matches });

    await service.ingest(buildActivity());

    const summaryEntry = loggedEntries().find((entry) => entry.message === 'activity ingested');
    expect(summaryEntry).toBeDefined();
    expect(summaryEntry?.campaignCode).toBeUndefined();
  });

  it('every log line this service emits is one JSON object via console.log (StructuredLogger), never a plain Logger call', async () => {
    const { service } = buildHarness({ matches: [component()] });

    await service.ingest(buildActivity());

    expect(consoleLogSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of consoleLogSpy.mock.calls) {
      expect(() => JSON.parse(String(call[0]))).not.toThrow();
    }
  });
});
