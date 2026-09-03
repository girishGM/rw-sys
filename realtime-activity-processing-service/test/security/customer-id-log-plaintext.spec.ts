/**
 * T-RAP-042 — TC-2. Independent proof that a real ingestion call, through the real
 * `ActivityIngestionService.ingest` (T-RAP-021, `05-PROCESSING-PIPELINE.md` §1), never writes the
 * plaintext `customerId` — or its ciphertext form — to any log line (`AGENT-PROTOCOL.md` R4).
 *
 * Unlike `activity-ingestion.service.spec.ts`'s own TC-8 (which asserts against a mocked
 * `Logger.log` call), this captures the *actual* process-level log corpus (`process.stdout`/
 * `process.stderr`, what Nest's default `ConsoleLogger` really writes to) produced by a call that
 * uses the real `EncryptionService` (real AES-256-GCM ciphertext, not a hand-rolled mock string) —
 * this task's own Implementation note 1: "actually attempt the bad case ... rather than reading the
 * code and concluding it must be fine." Every other collaborator (`CorrelationIdService`,
 * `IdempotencyService`, `ActivityMapper`, `LogRedactorService`, `ActivityLogsRepository`) is a real
 * or trivially-faked instance — none of them is the control this test exists to exercise, and a
 * zero-match `ActivityMapper` keeps this test from needing a real DB/transaction at all (`ingest`
 * returns before touching `ActivityLogsRepository`/`sequelize` in that path — see that method's own
 * step 5).
 */
import 'reflect-metadata';
import type { Sequelize } from 'sequelize';
import { ActivityIngestionService } from '@/modules/activity-mapping/activity-ingestion.service';
import type { ActivityMapper } from '@/modules/activity-mapping/activity-mapper';
import type { ActivityLogsRepository } from '@/modules/activity-mapping/activity-logs.repository';
import { CorrelationIdService } from '@/modules/idempotency/correlation-id.service';
import { IdempotencyService } from '@/modules/idempotency/idempotency.service';
import type { InboundActivity } from '@/modules/idempotency/inbound-activity.types';
import { EncryptionService } from '@/modules/encryption/encryption.service';
import { LogRedactorService } from '@/modules/encryption/log-redactor.service';
import type { FieldEncryptionConfigRepository } from '@/modules/encryption/field-encryption-config.repository';
import { MetricsService } from '@/observability/metrics.service';
import { StructuredLoggerFactory } from '@/observability/structured-logger';

const AES_KEY = Buffer.alloc(32, 111).toString('base64');
const HMAC_KEY = Buffer.alloc(32, 112).toString('base64');

const PLAINTEXT_CUSTOMER_ID = 'SECREVIEW-LOG-PLAINTEXT-CUST-88771';

function buildActivity(): InboundActivity {
  return {
    tenantId: 1,
    customerId: PLAINTEXT_CUSTOMER_ID,
    customerIdType: 'INTERNAL_ID',
    activityPerformedDate: new Date('2026-09-01T10:15:30.000Z'),
    activityCode: 'PURCHASE',
    activityType: 'TRANSACTION',
    activityCategory: 'RETAIL',
    activityValue: '100.0000',
    activityValueUnit: 'USD',
    channel: 'WEB',
    activityPerformedEnv: 'PROD',
    activityName: 'T-RAP-042 log-corpus fixture',
    sourceTransport: 'GRPC',
  };
}

describe('T-RAP-042 TC-2 — no plaintext or ciphertext customerId in the real log corpus', () => {
  let logSpies: jest.SpyInstance[];
  const captured: string[] = [];

  // T-RAP-060: this file originally spied on `process.stdout.write`/`process.stderr.write`
  // directly. That works when this file is the only one Jest runs, but reproduces, deterministically
  // (not just under contention — confirmed with as few as one other, completely unrelated spec file,
  // real or mocked infra irrelevant), a false negative (`captured.length` stays `0`) whenever Jest
  // runs more than a trivial number of test files: `jest-environment-node`'s own per-test-file
  // `console` (a `BufferedConsole`/`CustomConsole` instance, not literally the same object as the
  // outer Node process's `console`) only flushes to the REAL `process.stdout`/`process.stderr`
  // *after* the owning test file finishes — well after this test's own synchronous assertion already
  // ran. Spying on the global `console`'s own methods instead (`log`/`warn`/`error`/`debug` — every
  // level `StructuredLogger.write()`, `structured-logger.ts`, can call) intercepts one layer earlier,
  // before that buffering, so it reliably captures every real call `ActivityIngestionService`'s own
  // collaborators make during `ingest()`, regardless of how many other files Jest runs alongside this
  // one — still "the actual log corpus a real call produces", not a mocked `Logger` instance
  // (this file's own header explains why that distinction matters), just intercepted at the `console`
  // boundary rather than the OS-write boundary.
  beforeEach(() => {
    captured.length = 0;
    const record = (...args: unknown[]): void => {
      captured.push(args.map((arg) => String(arg)).join(' '));
    };
    logSpies = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(console, level).mockImplementation(record),
    );
  });

  afterEach(() => {
    logSpies.forEach((spy) => spy.mockRestore());
  });

  it('captures something (this test would be vacuous otherwise) and never emits the plaintext or ciphertext customerId', async () => {
    const encryption = new EncryptionService({
      aesKey: Buffer.from(AES_KEY, 'base64'),
      hmacKey: Buffer.from(HMAC_KEY, 'base64'),
    });
    const expectedCiphertext = encryption.encrypt(PLAINTEXT_CUSTOMER_ID);
    const expectedHash = encryption.hash(PLAINTEXT_CUSTOMER_ID);

    const fakeFieldEncryptionConfigRepository = {
      findAll: async () => [],
    } as unknown as FieldEncryptionConfigRepository;
    const logRedactor = new LogRedactorService(fakeFieldEncryptionConfigRepository);

    const zeroMatchMapper = { mapToComponents: () => [] } as unknown as ActivityMapper;
    const unusedRepository = {} as unknown as ActivityLogsRepository;
    const unusedSequelize = {} as unknown as Sequelize;

    // T-RAP-060: T-RAP-058 added these two required args (`06-CONFIGURABILITY-AND-OBSERVABILITY.md`
    // §3's metrics/structured-log wiring) to `ActivityIngestionService`'s real constructor — a real
    // `MetricsService` (this test asserts nothing about counters, just needs a real, working
    // instance) and a real `StructuredLoggerFactory` built from this test's own already-constructed
    // `logRedactor`, the same instance every other collaborator here already shares.
    const service = new ActivityIngestionService(
      new CorrelationIdService(),
      new IdempotencyService(),
      zeroMatchMapper,
      encryption,
      logRedactor,
      unusedRepository,
      unusedSequelize,
      new MetricsService(),
      new StructuredLoggerFactory(logRedactor),
    );

    const result = await service.ingest(buildActivity());
    expect(result.status).toBe('accepted');
    expect(result.matchedTrackerComponents).toEqual([]);

    expect(captured.length).toBeGreaterThan(0);
    const corpus = captured.join('\n');

    // The encryption ciphertext itself must never appear either
    // (`06-CONFIGURABILITY-AND-OBSERVABILITY.md` §1: "logs never carry even the ciphertext").
    expect(expectedCiphertext.length).toBeGreaterThan(0);
    expect(corpus).not.toContain(PLAINTEXT_CUSTOMER_ID);
    expect(corpus).not.toContain(expectedCiphertext);
    // The hash form IS expected to appear (`customerIdHash` is deliberately logged unconditionally,
    // `activity-ingestion.service.ts`'s own `logReceipt` header) — sanity-checks that this test
    // really did capture the real receipt log line, not an empty/short-circuited run.
    expect(corpus).toContain(expectedHash);
  });
});
