/**
 * T-PC-022. `OutboxPublisherWorker` against the real Postgres 16 server (root `CLAUDE.md`), as
 * the real `promo_code_app` role — same real-DB convention `promo-code-generation.service.spec.ts`
 * (T-PC-021) already established, per `AGENT-PROTOCOL.md` §3 ("assert the observable property,
 * not the implementation string"). `KafkaProducerService` is the one thing mocked (a plain
 * `{ publish: jest.fn() }` stand-in, never a hand-rolled broker) — a real broker round trip is
 * this task's own Verification steps 3/4 (`docker compose up`, manual), not `npm test`.
 *
 * Every row this suite needs is inserted directly via raw SQL (`seedPromoCode`/`seedOutboxRow`),
 * matching the task file's own Verification step 3 phrasing ("insert a `PENDING` row directly") —
 * this suite never goes through `PromoCodeGenerationService` to create rows.
 *
 * TC-9's `FAILED`-shaped payload is seeded synthetically. `T-PC-021`'s completion report already
 * flagged a real, still-open architectural tension for the architect: `promo_code_outbox.
 * promo_code_id` is a `NOT NULL` FK, so a genuine `FAILED` business outcome with no `promo_code`
 * row (e.g. `CONFIG_NOT_BOUND`) cannot yet reach this table under the current schema/T-PC-021
 * design. That question is out of this task's scope (Scope: "the promo_code_outbox row's own
 * creation... T-PC-021's transactional insert") — TC-9 here only proves this worker's own
 * publish-fidelity (it forwards whatever `payload` a row holds, unmodified), independent of
 * however such a row eventually gets created.
 *
 * **Isolation note**: `promo_code_outbox` has no `tenant_id` column (`01-DATABASE.md` §4) and the
 * poll query is deliberately global/un-scoped (that's the whole point of a single drain queue) —
 * so this suite cannot assume it's the only thing touching `PENDING` rows table-wide when other
 * test files' own real, `AppModule`-booted `OutboxPublisherWorker` could in principle also be
 * alive (`OUTBOX_PUBLISHER_AUTOSTART` disables that under `NODE_ENV=test`, see
 * `outbox-publisher.config.ts`) and other suites create real rows of their own
 * (`promo-code-generation.service.spec.ts`'s own KAFKA-transport TC-7, for one). Tests that check
 * a *specific* row's own fate (TC-1/2/3/7/8/9/10) therefore filter `publish.mock.calls` down to
 * their own known `correlationId` rather than asserting a total call count; tests that need a
 * closed, exact row set (TC-4/5/11/12) instead exercise `OutboxRepository`/config wiring directly
 * rather than depending on the whole table's global contents being otherwise empty.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createAppTestConnection } from '../../config/support/app-connection';
import { createMigrationConnection } from '@/database/migration-connection';
import { OutboxRepository } from '@/modules/outbox/outbox.repository';
import { OutboxPublisherWorker } from '@/modules/outbox/outbox-publisher.worker';
import type { KafkaProducerService } from '@/modules/outbox/kafka-producer.service';
import { GENERATE_RESULT_TOPIC } from '@/modules/generation/promo-code-generation.constants';

type PublishMock = jest.Mock<Promise<void>, [string, string, Record<string, unknown>]>;

interface SuccessPayload {
  status: 'SUCCESS';
  promoCodeId: string;
  code: string;
  rewardValueType: string;
  rewardValue: string;
  rewardUnit: string;
  expiresAt: string | null;
  errorCode: null;
  errorMessage: null;
}

describe('T-PC-022 — OutboxPublisherWorker', () => {
  let sequelize: Sequelize;
  let repository: OutboxRepository;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    sequelize = createAppTestConnection();
    await sequelize.authenticate();
    repository = new OutboxRepository(sequelize);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      await sequelize.query(
        `DELETE FROM promo_code.promo_code_outbox
           WHERE promo_code_id IN (SELECT id FROM promo_code.promo_code WHERE tenant_id = :tenantId)`,
        { replacements: { tenantId } },
      );
      await sequelize.query('DELETE FROM promo_code.promo_code WHERE tenant_id = :tenantId', {
        replacements: { tenantId },
      });
      await sequelize.query(
        'DELETE FROM promo_code.promo_code_config WHERE tenant_id = :tenantId',
        { replacements: { tenantId } },
      );
    }
    await sequelize.close();
  });

  function freshTenant(): string {
    const id = randomUUID();
    tenantIds.push(id);
    return id;
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function successPayload(overrides: Partial<SuccessPayload> = {}): SuccessPayload {
    return {
      status: 'SUCCESS',
      promoCodeId: randomUUID(),
      code: `SAVE10-${randomUUID().slice(0, 6).toUpperCase()}`,
      rewardValueType: 'PERCENTAGE',
      rewardValue: '10.0000',
      rewardUnit: '%',
      expiresAt: null,
      errorCode: null,
      errorMessage: null,
      ...overrides,
    };
  }

  async function seedConfig(tenantId: string): Promise<string> {
    const [row] = await sequelize.query<{ id: string }>(
      `INSERT INTO promo_code.promo_code_config
         (tenant_id, name, code_length, character_set, reward_value_type, reward_value,
          reward_unit, created_by, updated_by)
       VALUES (:tenantId, :name, 8, 'ALPHANUMERIC', 'FIXED_AMOUNT', 10.00, 'USD', :userId, :userId)
       RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, name: `outbox-test-${randomUUID()}`, userId: randomUUID() },
      },
    );
    return row.id;
  }

  async function seedPromoCode(
    tenantId: string,
    configId: string,
  ): Promise<{ id: string; correlationId: string }> {
    const correlationId = randomUUID();
    const [row] = await sequelize.query<{ id: string; correlation_id: string }>(
      `INSERT INTO promo_code.promo_code
         (promo_code_config_id, code, customer_id, tenant_id, reward_value_type, reward_value,
          reward_unit, correlation_id, transport)
       VALUES (:configId, :code, 'cust_8213', :tenantId, 'FIXED_AMOUNT', '10.0000', 'USD',
               :correlationId, 'KAFKA')
       RETURNING id, correlation_id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          configId,
          code: `CODE-${randomUUID().slice(0, 10)}`,
          tenantId,
          correlationId,
        },
      },
    );
    return { id: row.id, correlationId: row.correlation_id };
  }

  async function seedOutboxRow(
    promoCodeId: string,
    payload: object,
    overrides: { status?: string; attempts?: number; createdAt?: string } = {},
  ): Promise<string> {
    const [row] = await sequelize.query<{ id: string }>(
      `INSERT INTO promo_code.promo_code_outbox
         (promo_code_id, topic, payload, status, attempts, created_at)
       VALUES (:promoCodeId, :topic, :payload, :status, :attempts, :createdAt)
       RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          promoCodeId,
          topic: GENERATE_RESULT_TOPIC,
          payload: JSON.stringify(payload),
          status: overrides.status ?? 'PENDING',
          attempts: overrides.attempts ?? 0,
          createdAt: overrides.createdAt ?? new Date().toISOString(),
        },
      },
    );
    return row.id;
  }

  async function fetchOutboxRow(
    id: string,
  ): Promise<{ status: string; attempts: number; published_at: Date | null }> {
    const rows = await sequelize.query<{
      status: string;
      attempts: number;
      published_at: Date | null;
    }>(`SELECT status, attempts, published_at FROM promo_code.promo_code_outbox WHERE id = :id`, {
      type: QueryTypes.SELECT,
      replacements: { id },
    });
    return rows[0];
  }

  function fakeKafkaProducer(publish: PublishMock): KafkaProducerService {
    return { publish } as unknown as KafkaProducerService;
  }

  /**
   * Filters `publish.mock.calls` down to the ones keyed by `key` (the partition key, always
   * `correlationId` — `02-KAFKA-CONTRACTS.md` §5). Isolation note above: never assume the total
   * call count reflects only this test's own row.
   */
  function callsFor(
    publish: PublishMock,
    key: string,
  ): [string, string, Record<string, unknown>][] {
    return publish.mock.calls.filter((call) => call[1] === key);
  }

  /**
   * A publish mock whose reject/resolve behavior is keyed on `targetKey` (this test's own
   * `correlationId`) rather than on call order — if this worker's batch happens to also include
   * an unrelated real row from another concurrently-running suite (isolation note above), that
   * row always just resolves harmlessly instead of accidentally consuming an outcome meant for
   * this test's own row.
   */
  function keyedPublish(
    targetKey: string,
    behaviorForAttempt: (attemptNumber: number) => 'reject' | 'resolve',
  ): PublishMock {
    const attemptCounts = new Map<string, number>();
    return jest.fn(async (_topic: string, key: string, _message: Record<string, unknown>) => {
      if (key !== targetKey) {
        return;
      }
      const attemptNumber = (attemptCounts.get(key) ?? 0) + 1;
      attemptCounts.set(key, attemptNumber);
      if (behaviorForAttempt(attemptNumber) === 'reject') {
        throw new Error('broker unreachable');
      }
    }) as PublishMock;
  }

  function buildWorker(
    kafkaProducer: KafkaProducerService,
    options: {
      batchSize?: number;
      maxAttempts?: number;
      backoffBaseMs?: number;
      backoffMaxMs?: number;
      pollIntervalMs?: number;
    } = {},
  ): OutboxPublisherWorker {
    return new OutboxPublisherWorker(
      repository,
      kafkaProducer,
      options.pollIntervalMs ?? 500,
      options.batchSize ?? 20,
      options.maxAttempts ?? 5,
      options.backoffBaseMs ?? 1,
      options.backoffMaxMs ?? 50,
    );
  }

  // TC-1
  it('TC-1: a PENDING row is published, marked PUBLISHED, published_at set, attempts=1', async () => {
    const tenantId = freshTenant();
    const configId = await seedConfig(tenantId);
    const { id: promoCodeId, correlationId } = await seedPromoCode(tenantId, configId);
    const outboxId = await seedOutboxRow(promoCodeId, successPayload({ promoCodeId }));

    const publish: PublishMock = jest.fn().mockResolvedValue(undefined);
    const worker = buildWorker(fakeKafkaProducer(publish));

    await worker.runOnce();

    const myCalls = callsFor(publish, correlationId);
    expect(myCalls).toHaveLength(1);
    expect(myCalls[0][0]).toBe(GENERATE_RESULT_TOPIC);

    const row = await fetchOutboxRow(outboxId);
    expect(row.status).toBe('PUBLISHED');
    expect(row.attempts).toBe(1);
    expect(row.published_at).not.toBeNull();
  });

  // TC-2
  it('TC-2: Kafka publish fails once then succeeds — attempts=2, eventually PUBLISHED', async () => {
    const tenantId = freshTenant();
    const configId = await seedConfig(tenantId);
    const { id: promoCodeId, correlationId } = await seedPromoCode(tenantId, configId);
    const outboxId = await seedOutboxRow(promoCodeId, successPayload({ promoCodeId }));

    const publish = keyedPublish(correlationId, (attempt) =>
      attempt === 1 ? 'reject' : 'resolve',
    );
    const worker = buildWorker(fakeKafkaProducer(publish), { backoffBaseMs: 1, backoffMaxMs: 5 });

    await worker.runOnce();
    let row = await fetchOutboxRow(outboxId);
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);

    await wait(10);
    await worker.runOnce();

    expect(callsFor(publish, correlationId)).toHaveLength(2);
    row = await fetchOutboxRow(outboxId);
    expect(row.status).toBe('PUBLISHED');
    expect(row.attempts).toBe(2);
  });

  // TC-3
  it('TC-3: Kafka publish fails on every attempt up to the configured max — FAILED, attempts=max', async () => {
    const tenantId = freshTenant();
    const configId = await seedConfig(tenantId);
    const { id: promoCodeId, correlationId } = await seedPromoCode(tenantId, configId);
    const outboxId = await seedOutboxRow(promoCodeId, successPayload({ promoCodeId }));

    const maxAttempts = 3;
    const publish = keyedPublish(correlationId, () => 'reject');
    const worker = buildWorker(fakeKafkaProducer(publish), {
      maxAttempts,
      backoffBaseMs: 1,
      backoffMaxMs: 5,
    });

    for (let i = 0; i < maxAttempts; i += 1) {
      await worker.runOnce();
      await wait(10);
    }

    expect(callsFor(publish, correlationId)).toHaveLength(maxAttempts);
    const row = await fetchOutboxRow(outboxId);
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(maxAttempts);
  });

  // TC-4
  it('TC-4: multiple PENDING rows are all published, oldest created_at processed first', async () => {
    const tenantId = freshTenant();
    const configId = await seedConfig(tenantId);
    const now = Date.now();
    // Deliberately NOT inserted in age order, so passing this proves the ORDER BY, not
    // insertion order.
    const ageOffsetsMs = [1_000, 3_000, 2_000];
    const seeded: { correlationId: string; ageMs: number }[] = [];
    for (const ageMs of ageOffsetsMs) {
      const { id: promoCodeId, correlationId } = await seedPromoCode(tenantId, configId);
      await seedOutboxRow(promoCodeId, successPayload({ promoCodeId }), {
        createdAt: new Date(now - ageMs).toISOString(),
      });
      seeded.push({ correlationId, ageMs });
    }
    const expectedOrder = [...seeded].sort((a, b) => b.ageMs - a.ageMs).map((s) => s.correlationId);
    const knownKeys = new Set(seeded.map((s) => s.correlationId));

    const publish: PublishMock = jest.fn().mockResolvedValue(undefined);
    const worker = buildWorker(fakeKafkaProducer(publish));
    await worker.runOnce();

    // Isolation note: filter the global call order down to this test's own 3 known rows —
    // some other concurrently running suite's own real row may also have landed in the batch.
    const myPublishOrder = publish.mock.calls
      .map((call) => call[1])
      .filter((key) => knownKeys.has(key));
    expect(myPublishOrder).toEqual(expectedOrder);
  });

  // TC-5
  it('TC-5: never re-selects an already-PUBLISHED row', async () => {
    const tenantId = freshTenant();
    const configId = await seedConfig(tenantId);
    const { id: publishedPromoCodeId, correlationId: publishedCorrelationId } = await seedPromoCode(
      tenantId,
      configId,
    );
    const publishedOutboxId = await seedOutboxRow(
      publishedPromoCodeId,
      successPayload({ promoCodeId: publishedPromoCodeId }),
      { status: 'PUBLISHED', attempts: 1 },
    );
    const { id: pendingPromoCodeId, correlationId } = await seedPromoCode(tenantId, configId);
    await seedOutboxRow(pendingPromoCodeId, successPayload({ promoCodeId: pendingPromoCodeId }));

    const publish: PublishMock = jest.fn().mockResolvedValue(undefined);
    const worker = buildWorker(fakeKafkaProducer(publish));
    await worker.runOnce();

    expect(callsFor(publish, correlationId)).toHaveLength(1);
    // The already-PUBLISHED row must never be re-selected, proven two ways: its own key is
    // never among the calls, and its DB row is untouched.
    expect(callsFor(publish, publishedCorrelationId)).toHaveLength(0);
    const publishedRow = await fetchOutboxRow(publishedOutboxId);
    expect(publishedRow.attempts).toBe(1); // unchanged — never re-selected
  });

  // TC-6
  it('TC-6: the poll query plan uses ix_promo_code_outbox_pending, not a sequential scan', async () => {
    const tenantId = freshTenant();
    const configId = await seedConfig(tenantId);
    const { id: promoCodeId } = await seedPromoCode(tenantId, configId);

    // Bulk-seed enough non-PENDING "noise" that a sequential scan over the whole table is
    // materially costlier than this predicate's own partial index — proving the real benefit
    // (implementation note 1): the partial index's size tracks the PENDING backlog only, never
    // the ever-growing historical table. No PENDING row is created here (would otherwise leak
    // into later tests' own poll-query assertions).
    await sequelize.query(
      `INSERT INTO promo_code.promo_code_outbox (promo_code_id, topic, payload, status, attempts, created_at)
         SELECT :promoCodeId, :topic, '{}'::jsonb, 'PUBLISHED', 1, now() - (s || ' seconds')::interval
           FROM generate_series(1, 5000) AS s`,
      { type: QueryTypes.RAW, replacements: { promoCodeId, topic: GENERATE_RESULT_TOPIC } },
    );

    // ANALYZE requires table-owner/superuser privileges `promo_code_app` doesn't have (R1) — a
    // short-lived migration-role connection, test-only, same precedent
    // `test/database/migrations.spec.ts` already established for `createMigrationConnection`.
    const migrationConnection = createMigrationConnection();
    try {
      await migrationConnection.authenticate();
      await migrationConnection.query('ANALYZE promo_code.promo_code_outbox;', {
        type: QueryTypes.RAW,
      });
    } finally {
      await migrationConnection.close();
    }

    const capturedQueries: string[] = [];
    const loggingConnection = createAppTestConnection((sql) => capturedQueries.push(sql));
    const loggingRepository = new OutboxRepository(loggingConnection);
    let planText: string;
    try {
      await loggingRepository.findPendingBatch(20);
      const captured = capturedQueries.find((sql) => sql.includes('promo_code_outbox'));
      expect(captured).toBeDefined();
      const rawSql = (captured as string).replace(/^Executing \([^)]*\):\s*/, '');
      const plan = await loggingConnection.query<Record<string, string>>(`EXPLAIN ${rawSql}`, {
        type: QueryTypes.SELECT,
      });
      planText = plan.map((row) => Object.values(row)[0]).join('\n');
    } finally {
      await loggingConnection.close();
    }

    expect(planText).toContain('ix_promo_code_outbox_pending');
    expect(planText).not.toContain('Seq Scan');
  });

  // TC-7
  it('TC-7: published envelope matches 02-KAFKA-CONTRACTS.md §2 exactly', async () => {
    const tenantId = freshTenant();
    const configId = await seedConfig(tenantId);
    const { id: promoCodeId, correlationId } = await seedPromoCode(tenantId, configId);
    await seedOutboxRow(promoCodeId, successPayload({ promoCodeId }));

    const publish: PublishMock = jest.fn().mockResolvedValue(undefined);
    const worker = buildWorker(fakeKafkaProducer(publish));
    await worker.runOnce();

    const myCalls = callsFor(publish, correlationId);
    expect(myCalls).toHaveLength(1);
    const [topicArg, , envelope] = myCalls[0];
    expect(topicArg).toBe(GENERATE_RESULT_TOPIC);
    expect(typeof envelope.eventId).toBe('string');
    expect(envelope.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(envelope.eventType).toBe('promo-code.generate.result');
    expect(envelope.eventVersion).toBe('1.0');
    expect(typeof envelope.occurredAt).toBe('string');
    expect(new Date(envelope.occurredAt as string).toISOString()).toBe(envelope.occurredAt);
    expect(envelope.correlationId).toBe(correlationId);
    expect(envelope.tenantId).toBe(tenantId);
    expect(envelope.source).toBe('promo-code-service');
    expect(typeof envelope.data).toBe('object');
  });

  // TC-8
  it("TC-8: published data shape for a SUCCESS result matches §5's example shape", async () => {
    const tenantId = freshTenant();
    const configId = await seedConfig(tenantId);
    const { id: promoCodeId, correlationId } = await seedPromoCode(tenantId, configId);
    const payload = successPayload({
      promoCodeId,
      code: 'SAVE10-X7K2Q',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    await seedOutboxRow(promoCodeId, payload);

    const publish: PublishMock = jest.fn().mockResolvedValue(undefined);
    const worker = buildWorker(fakeKafkaProducer(publish));
    await worker.runOnce();

    const myCalls = callsFor(publish, correlationId);
    expect(myCalls).toHaveLength(1);
    expect(myCalls[0][2].data).toEqual(payload);
  });

  // TC-9
  it("TC-9: published data shape for a FAILED result matches §5's example shape, errorCode/errorMessage populated", async () => {
    const tenantId = freshTenant();
    const configId = await seedConfig(tenantId);
    const { id: promoCodeId, correlationId } = await seedPromoCode(tenantId, configId);
    const failedPayload = {
      status: 'FAILED',
      promoCodeId: null,
      code: null,
      rewardValueType: null,
      rewardValue: null,
      rewardUnit: null,
      expiresAt: null,
      errorCode: 'GENERATION_EXHAUSTED',
      errorMessage: 'Exhausted 5 collision-retry attempts',
    };
    await seedOutboxRow(promoCodeId, failedPayload);

    const publish: PublishMock = jest.fn().mockResolvedValue(undefined);
    const worker = buildWorker(fakeKafkaProducer(publish));
    await worker.runOnce();

    const myCalls = callsFor(publish, correlationId);
    expect(myCalls).toHaveLength(1);
    expect(myCalls[0][2].data).toEqual(failedPayload);
  });

  // TC-10
  it('TC-10: a crash between a successful Kafka send and the DB update is republished — new eventId, same correlationId', async () => {
    const tenantId = freshTenant();
    const configId = await seedConfig(tenantId);
    const { id: promoCodeId, correlationId } = await seedPromoCode(tenantId, configId);
    const outboxId = await seedOutboxRow(promoCodeId, successPayload({ promoCodeId }));

    const publish: PublishMock = jest.fn().mockResolvedValue(undefined);
    const worker = buildWorker(fakeKafkaProducer(publish), { backoffBaseMs: 1, backoffMaxMs: 5 });

    // Simulate the process crashing after the Kafka send succeeded but before `markPublished`
    // commits: the send is real (the mock resolves), only the DB write "fails" — and only for
    // *this test's own* row (isolation note above: an unrelated real row from another
    // concurrently-running suite must not have its own, legitimate `markPublished` call broken
    // by this test's fault injection).
    const originalMarkPublished = repository.markPublished.bind(repository);
    let crashInjected = false;
    const markPublishedSpy = jest
      .spyOn(repository, 'markPublished')
      .mockImplementation(async (id: string) => {
        if (id === outboxId && !crashInjected) {
          crashInjected = true;
          throw new Error('simulated crash before DB update');
        }
        return originalMarkPublished(id);
      });

    await worker.runOnce(); // "attempt 1": publish succeeds, DB update "crashes"
    markPublishedSpy.mockRestore();

    let row = await fetchOutboxRow(outboxId);
    expect(row.status).toBe('PENDING');

    await wait(10);
    await worker.runOnce(); // "restart": row picked back up, republished

    const myCalls = callsFor(publish, correlationId);
    expect(myCalls).toHaveLength(2);
    const firstEventId = myCalls[0][2].eventId;
    const secondEventId = myCalls[1][2].eventId;
    expect(secondEventId).not.toBe(firstEventId);
    expect(myCalls[0][2].correlationId).toBe(correlationId);
    expect(myCalls[1][2].correlationId).toBe(correlationId);

    row = await fetchOutboxRow(outboxId);
    expect(row.status).toBe('PUBLISHED');
  });

  // TC-11
  it('TC-11: a poll cycle with zero PENDING rows is a no-op — no error, no publish call', async () => {
    // Mocked repository, deliberately not the real DB (isolation note above): this property must
    // hold when the table is genuinely empty, which this suite cannot assert about the real,
    // globally-shared table while other suites may be running concurrently.
    const findPendingBatchSpy = jest.spyOn(repository, 'findPendingBatch').mockResolvedValue([]);
    const publish: PublishMock = jest.fn().mockResolvedValue(undefined);
    const worker = buildWorker(fakeKafkaProducer(publish));

    await expect(worker.runOnce()).resolves.toBeUndefined();

    expect(findPendingBatchSpy).toHaveBeenCalledWith(20);
    expect(publish).not.toHaveBeenCalled();
  });

  // TC-12
  it('TC-12: batch size is read from config, not hardcoded — changing it changes the fetch size', async () => {
    // Mocked repository (isolation note above): this proves the DI wiring itself — that
    // `OUTBOX_BATCH_SIZE`'s configured value is what actually reaches
    // `OutboxRepository.findPendingBatch` — independent of how many real rows exist table-wide
    // at the moment this runs.
    const findPendingBatchSpy = jest.spyOn(repository, 'findPendingBatch').mockResolvedValue([]);
    const publish: PublishMock = jest.fn().mockResolvedValue(undefined);

    const smallBatchWorker = buildWorker(fakeKafkaProducer(publish), { batchSize: 2 });
    await smallBatchWorker.runOnce();
    expect(findPendingBatchSpy).toHaveBeenLastCalledWith(2);

    const largeBatchWorker = buildWorker(fakeKafkaProducer(publish), { batchSize: 37 });
    await largeBatchWorker.runOnce();
    expect(findPendingBatchSpy).toHaveBeenLastCalledWith(37);
  });

  // TC-13 (T-PC-045)
  it('TC-13: findPendingBatch(batchSize, { rowIds }) only returns rows in scope, even when other PENDING rows exist outside it', async () => {
    const tenantId = freshTenant();
    const configId = await seedConfig(tenantId);
    const { id: minePromoCodeId } = await seedPromoCode(tenantId, configId);
    const mineOutboxId = await seedOutboxRow(
      minePromoCodeId,
      successPayload({ promoCodeId: minePromoCodeId }),
    );
    const { id: otherPromoCodeId } = await seedPromoCode(tenantId, configId);
    const otherOutboxId = await seedOutboxRow(
      otherPromoCodeId,
      successPayload({ promoCodeId: otherPromoCodeId }),
    );

    const scoped = await repository.findPendingBatch(20, { rowIds: [mineOutboxId] });

    expect(scoped.map((row) => row.id)).toEqual([mineOutboxId]);
    expect(scoped.map((row) => row.id)).not.toContain(otherOutboxId);
  });

  // TC-14 (T-PC-045 regression)
  it(
    "TC-14 (T-PC-045 regression): runOnce(scope) restricted to a caller's own known row must not " +
      "publish a concurrent, unrelated PENDING row it doesn't own — reproduces T-PC-040's reported " +
      'cross-suite race by seeding a second, not-yet-observed row exactly the way a concurrently ' +
      "running test file's own committed-but-not-yet-asserted row would look",
    async () => {
      const tenantId = freshTenant();
      const configId = await seedConfig(tenantId);
      const { id: minePromoCodeId, correlationId: mineCorrelationId } = await seedPromoCode(
        tenantId,
        configId,
      );
      const mineOutboxId = await seedOutboxRow(
        minePromoCodeId,
        successPayload({ promoCodeId: minePromoCodeId }),
      );
      // Stands in for a different, concurrently-running e2e test's own row: committed, still
      // PENDING, not yet observed by its own owner's assertion — T-PC-045's own filed evidence.
      const { id: otherPromoCodeId, correlationId: otherCorrelationId } = await seedPromoCode(
        tenantId,
        configId,
      );
      const otherOutboxId = await seedOutboxRow(
        otherPromoCodeId,
        successPayload({ promoCodeId: otherPromoCodeId }),
      );

      const publish: PublishMock = jest.fn().mockResolvedValue(undefined);
      const worker = buildWorker(fakeKafkaProducer(publish));

      await worker.runOnce({ rowIds: [mineOutboxId] });

      expect(callsFor(publish, mineCorrelationId)).toHaveLength(1);
      expect(callsFor(publish, otherCorrelationId)).toHaveLength(0);

      const mineRow = await fetchOutboxRow(mineOutboxId);
      expect(mineRow.status).toBe('PUBLISHED');

      // The "other" row — this is the property the reported race actually depends on — must be
      // completely untouched: still PENDING, `attempts` unincremented, exactly as its own owner
      // would still find it.
      const otherRow = await fetchOutboxRow(otherOutboxId);
      expect(otherRow.status).toBe('PENDING');
      expect(otherRow.attempts).toBe(0);
    },
  );

  describe('poll interval configuration (implementation note 6)', () => {
    it('start() schedules runOnce at the configured pollIntervalMs, stop() cancels it', () => {
      jest.useFakeTimers();
      try {
        const publish: PublishMock = jest.fn().mockResolvedValue(undefined);
        const worker = buildWorker(fakeKafkaProducer(publish), { pollIntervalMs: 1000 });
        const runOnceSpy = jest.spyOn(worker, 'runOnce').mockResolvedValue(undefined);

        worker.start();
        expect(runOnceSpy).not.toHaveBeenCalled();
        jest.advanceTimersByTime(999);
        expect(runOnceSpy).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(runOnceSpy).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(1000);
        expect(runOnceSpy).toHaveBeenCalledTimes(2);

        worker.stop();
        jest.advanceTimersByTime(5000);
        expect(runOnceSpy).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
