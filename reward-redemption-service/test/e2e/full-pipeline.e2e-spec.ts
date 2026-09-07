/**
 * T-RR-041 — the full, real ingest -> claim -> resolve -> connector -> state-machine -> dispatch ->
 * notification pipeline, exercised end to end across all three real ingestion transports, both
 * real connectors, both dispatch tiers, and the notification leg. See this task's own
 * `fixtures/reward-entry.fixtures.ts` header for what is real vs. faked and why (only the
 * portal-feed resolution is faked — everything else, including the real mTLS gRPC server, the real
 * Kafka consumer/producer against the real local Redpanda broker, and the real REST controller on
 * the real `AppModule`, is the actual production code).
 *
 * TC-1/TC-2/TC-3: cross-channel parity for the connector-backed happy path (implementation note 2).
 * TC-4: the second real connector (`CoreBankingConnector`).
 * TC-8: retry exhaustion. TC-9: Kafka-unavailable -> REST-fallback dispatch tier. TC-10/TC-11:
 * notification on/off. TC-12: a malformed entry on each of the three channels.
 */
import { readFileSync } from 'node:fs';
import type { INestMicroservice, INestApplicationContext, INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { QueryTypes, type Sequelize } from 'sequelize';
import type { Pool, Client } from 'pg';
import { createGrpcMicroservice } from '@/grpc/grpc-server.main';
import { createKafkaConsumerContext } from '@/messaging/ingest/kafka-consumer.main';
import {
  RewardEntryCreatedConsumer,
  REWARD_ENTRY_CREATED_TOPIC,
} from '@/messaging/ingest/reward-entry-created.consumer';
import { REWARD_ENTRY_CREATED_DLQ_TOPIC } from '@/messaging/ingest/reward-entry-created-dlq.producer';
import { REWARD_TRACKING_COMPLETED_TOPIC } from '@/modules/dispatch/reward-tracking-kafka-producer.client';
import { RewardTrackingKafkaProducerClient } from '@/modules/dispatch/reward-tracking-kafka-producer.client';
import { RewardTrackingRestClient } from '@/modules/dispatch/reward-tracking-rest.client';
import { OutboxPublisherService } from '@/modules/dispatch/outbox-publisher.service';
import { AppModule } from '@/app.module';
import { TestCertAuthority, type IssuedCertificate } from '../grpc/support/test-cert-authority';
import {
  createTestClient,
  callSubmitRewardEntry,
  type RewardIngestServiceTestClient,
} from '../grpc/support/test-grpc-client';
import {
  PROMO_CODE_AUTH_SECRET_ENV_VAR,
  PROMO_CODE_AUTH_SECRET_VALUE,
  buildCanonicalFixtureEntry,
  buildClaimRepository,
  buildCoreBankingConnectorConfig,
  buildDbPool,
  buildMalformedGrpcEntry,
  buildMalformedKafkaMessageValue,
  buildMalformedRestBody,
  buildPromoCodeConnectorConfig,
  buildRealPipeline,
  destroyRealPipeline,
  cleanupEntry,
  claimSpecificEntry,
  clearCoreBankingStubOutcome,
  countEntryRows,
  countRelatedRows,
  createMigrationDb,
  fetchRow,
  forceNextAttemptNow,
  getFreePort,
  jsonResponse,
  promoCodeSuccessBody,
  realDbConfigService,
  setCoreBankingStubOutcome,
  sleep,
  toGrpcRewardEntry,
  toKafkaMessageValue,
  toRestRequestBody,
  waitForCondition,
  backdatePastCompletionSweepGrace,
  acquireCrossFileClaimMutex,
  releaseCrossFileClaimMutex,
  stampTenantCountryEnrichment,
  type CanonicalFixtureEntry,
  type IngestionChannel,
  type RealPipelineHandles,
} from './fixtures/reward-entry.fixtures';

jest.setTimeout(180_000);

const GRPC_IDENTITY = 'rr-e2e-full-pipeline-client';
const TENANT_ID = 967_000 + Math.floor(Math.random() * 999);
const REST_TOKEN = process.env.REWARD_ENTRY_INGEST_TOKEN;

describe('T-RR-041 — full pipeline (real gRPC + real Kafka + real REST + real Postgres)', () => {
  let migrationDb: Sequelize;
  let sharedPool: Pool;
  let mutexClient: Client;
  let ca: TestCertAuthority;
  let grpcApp: INestMicroservice;
  let grpcClient: RewardIngestServiceTestClient;
  let kafkaApp: INestApplicationContext;
  let kafkaProducer: Producer;
  let restApp: INestApplication;
  const entryIdsToClean: string[] = [];
  const campaignsToClean: string[] = [];

  beforeAll(async () => {
    if (!REST_TOKEN) {
      throw new Error('REWARD_ENTRY_INGEST_TOKEN is not set — see .env.local');
    }
    mutexClient = await acquireCrossFileClaimMutex();
    migrationDb = createMigrationDb();
    await migrationDb.authenticate();
    sharedPool = buildDbPool();

    ca = TestCertAuthority.build();
    const grpcPort = await getFreePort();
    process.env.GRPC_SERVER_PORT = String(grpcPort);
    process.env.GRPC_SERVER_TLS_CA_PATH = ca.caCertPath;
    process.env.GRPC_SERVER_TLS_CERT_PATH = ca.serverCertPath;
    process.env.GRPC_SERVER_TLS_KEY_PATH = ca.serverKeyPath;
    process.env.GRPC_SERVER_ALLOWED_IDENTITIES = `${GRPC_IDENTITY}:${TENANT_ID}`;
    delete process.env.GRPC_SERVER_ENABLED;

    const maybeGrpcApp = await createGrpcMicroservice();
    if (maybeGrpcApp === null) {
      throw new Error('expected createGrpcMicroservice() to return a microservice in this test');
    }
    grpcApp = maybeGrpcApp;
    await grpcApp.listen();

    const clientCert: IssuedCertificate = ca.issueClientCert(GRPC_IDENTITY);
    const credentials = grpc.credentials.createSsl(
      readFileSync(ca.caCertPath),
      readFileSync(clientCert.keyPath),
      readFileSync(clientCert.certPath),
    );
    grpcClient = createTestClient(`localhost:${grpcPort}`, credentials);

    const maybeKafkaApp = await createKafkaConsumerContext();
    if (maybeKafkaApp === null) {
      throw new Error(
        'expected createKafkaConsumerContext() to return an app context in this test',
      );
    }
    kafkaApp = maybeKafkaApp;
    await kafkaApp.get(RewardEntryCreatedConsumer).start();

    const kafka = new Kafka({
      clientId: 'rr-e2e-full-pipeline-producer',
      brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(',').map((b) => b.trim()),
      logLevel: logLevel.NOTHING,
    });
    kafkaProducer = kafka.producer();
    await kafkaProducer.connect();

    const restModuleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    restApp = restModuleRef.createNestApplication();
    await restApp.init();

    await warmUpKafkaConsumer();
  }, 300_000);

  afterAll(async () => {
    for (const id of entryIdsToClean) {
      await cleanupEntry(migrationDb, id);
    }
    for (const campaignCode of campaignsToClean) {
      await clearCoreBankingStubOutcome(migrationDb, campaignCode);
    }
    const steps: Array<() => Promise<void> | void> = [
      () => grpcClient?.close(),
      () => grpcApp?.close(),
      () => kafkaApp?.close(),
      () => kafkaProducer?.disconnect(),
      () => restApp?.close(),
      () => sharedPool?.end(),
      () => migrationDb?.close(),
      () => ca?.cleanup(),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        console.warn('T-RR-041 full-pipeline teardown step failed:', error);
      }
    }
    await releaseCrossFileClaimMutex(mutexClient);
  }, 60_000);

  /**
   * T-RR-071: `OutboxPublisherService.doRunOnce`'s own `findPendingBatch` has no tenant filter at
   * all (`outbox-publisher.service.ts`'s own header — it drains the whole
   * `reward_tracking_dispatch_outbox` table, oldest-first, `LIMIT batchSize`). Now that T-RR-071's
   * own fix stops one malformed row from poisoning the whole batch, this suite's tests finally
   * reach the real ambient `PENDING` backlog this shared dev Postgres instance (root `CLAUDE.md`)
   * accumulates across every agent's own concurrent test runs — the same root cause T-RR-070
   * already documented for `reward-tracking-outbox.repository.spec.ts`, just never reachable here
   * until now. Backdating this test's own row's own `created_at` (the same "make the row we care
   * about unambiguously oldest" idiom `backdatePastCompletionSweepGrace` already uses for the
   * *entry* table's own grace window) is cheap — one indexed point `UPDATE` by `reward_entry_id` —
   * and guarantees this row is first in `findPendingBatch`'s own `ORDER BY created_at ASC`
   * regardless of how large the ambient backlog grows. (A batch sized dynamically to *cover* the
   * whole backlog was tried first and rejected: it makes `OutboxPublisherService` actually
   * *dispatch* every one of however many thousand ambient rows exist, real network/DB round trips
   * per row, which both takes minutes under concurrent load and races the very backlog it's trying
   * to measure.)
   */
  async function backdateOutboxRowToOldest(rewardEntryId: string): Promise<void> {
    await migrationDb.query(
      `UPDATE reward_redemption.reward_tracking_dispatch_outbox
          SET created_at = TIMESTAMP '1970-01-01 00:00:00+00'
        WHERE reward_entry_id = :id`,
      { type: QueryTypes.RAW, replacements: { id: rewardEntryId } },
    );
  }

  /**
   * T-RR-071: built with `batchSize: 1`, not `pipeline.outboxPublisher`'s own `batchSize: 100`
   * (`buildRealPipeline`'s own header) — combined with `backdateOutboxRowToOldest` above,
   * `findPendingBatch(1)` is guaranteed to return *only* this test's own row, never touching the
   * real ambient backlog at all. This matters beyond just speed for a test using a genuinely
   * unreachable Kafka broker (TC-9): `RewardTrackingKafkaProducerClient.publish` re-attempts a real
   * `connect()` (3s `connectionTimeout`, `reward-tracking-kafka-producer.client.ts`'s own header)
   * on every call whenever the previous attempt never produced a live `this.producer` — draining
   * even a few dozen ambient rows through a batch this size would mean a few dozen real, sequential
   * 3s connection timeouts, minutes of pure waste. Reuses every real collaborator
   * `buildRealPipeline` already built (`RealPipelineHandles`'s own exposed fields) so metrics/outbox
   * state stay on the exact same objects the rest of the test asserts against — only `batchSize`
   * differs from `pipeline.outboxPublisher`.
   */
  function buildSingleRowOutboxPublisher(
    pipeline: RealPipelineHandles,
    overrides: {
      kafkaProducer?: RewardTrackingKafkaProducerClient;
      restClient?: RewardTrackingRestClient;
    } = {},
  ): OutboxPublisherService {
    return new OutboxPublisherService(
      pipeline.outboxRepository,
      pipeline.dispatchResolver,
      pipeline.encryption,
      overrides.kafkaProducer ?? pipeline.kafkaProducerClient,
      pipeline.dispatchMetrics,
      pipeline.serviceConfigResolver,
      overrides.restClient ??
        new RewardTrackingRestClient({
          baseUrl: 'http://reward-tracking-service.test',
          token: 'test-token',
          timeoutMs: 5_000,
        }),
      pipeline.retryRepository,
      1,
      false,
    );
  }

  async function warmUpKafkaConsumer(): Promise<void> {
    const canary = buildCanonicalFixtureEntry(TENANT_ID, {
      campaignCode: 'WARMUP-CANARY-TRR041-FP',
    });
    const deadline = Date.now() + 30_000;
    for (;;) {
      await kafkaProducer.send({
        topic: REWARD_ENTRY_CREATED_TOPIC,
        messages: [{ key: canary.customerId, value: toKafkaMessageValue(canary) }],
      });
      if ((await countEntryRows(migrationDb, canary.id)) >= 1) {
        entryIdsToClean.push(canary.id);
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error('Kafka consumer warm-up timed out waiting for the canary to be consumed');
      }
      await sleep(500);
    }
  }

  async function sendViaChannel(
    channel: IngestionChannel,
    fixture: CanonicalFixtureEntry,
  ): Promise<void> {
    if (channel === 'GRPC') {
      await callSubmitRewardEntry(grpcClient, toGrpcRewardEntry(fixture));
      return;
    }
    if (channel === 'REST') {
      const response = await request(restApp.getHttpServer())
        .post('/api/v1/reward-entries')
        .set('Authorization', `Bearer ${REST_TOKEN}`)
        .send(toRestRequestBody(fixture));
      expect(response.status).toBe(200);
      return;
    }
    await kafkaProducer.send({
      topic: REWARD_ENTRY_CREATED_TOPIC,
      messages: [{ key: fixture.customerId, value: toKafkaMessageValue(fixture) }],
    });
    await waitForCondition(
      async () => (await countEntryRows(migrationDb, fixture.id)) >= 1,
      20_000,
    );
  }

  // ---------------------------------------------------------------------------------------------
  // TC-1/TC-2/TC-3 — cross-channel parity, PromoCodeServiceConnector success -> Kafka dispatch
  // ---------------------------------------------------------------------------------------------
  describe('TC-1/TC-2/TC-3 — cross-channel parity through PromoCodeServiceConnector success', () => {
    let fetchSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;
    const ORIGINAL_ENV = { ...process.env };

    beforeEach(() => {
      process.env = {
        ...ORIGINAL_ENV,
        [PROMO_CODE_AUTH_SECRET_ENV_VAR]: PROMO_CODE_AUTH_SECRET_VALUE,
      };
      fetchSpy = jest.spyOn(global, 'fetch');
      warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      fetchSpy.mockRestore();
      warnSpy.mockRestore();
      process.env = { ...ORIGINAL_ENV };
    });

    async function runHappyPathViaChannel(
      channel: IngestionChannel,
      opts: { verifyKafkaTopic?: boolean } = {},
    ): Promise<void> {
      const fixture = buildCanonicalFixtureEntry(TENANT_ID);
      entryIdsToClean.push(fixture.id);
      fetchSpy.mockResolvedValue(
        jsonResponse(200, promoCodeSuccessBody({ promoCodeId: `promo-${fixture.id}` })),
      );

      await sendViaChannel(channel, fixture);
      expect(await countEntryRows(migrationDb, fixture.id)).toBe(1);
      const ingestedRow = await fetchRow(migrationDb, fixture.id);
      expect(ingestedRow.ingestion_channel).toBe(channel);

      await stampTenantCountryEnrichment(migrationDb, fixture.id);
      const claimRepository = buildClaimRepository(sharedPool);
      const claimed = await claimSpecificEntry(claimRepository, migrationDb, fixture.id);

      let completedTopicConsumer: Consumer | undefined;
      const observedCompletedMessages: Array<Record<string, unknown>> = [];
      if (opts.verifyKafkaTopic) {
        completedTopicConsumer = await startCompletedTopicConsumer(observedCompletedMessages);
      }

      const pipeline = buildRealPipeline({
        systemCode: 'PROMO_CODE_SERVICE',
        connectorConfig: buildPromoCodeConnectorConfig(),
        notificationsEnabled: false,
        sharedPool,
      });
      const { orchestrator, completionSweep, dispatchMetrics } = pipeline;
      // T-RR-071: see `buildSingleRowOutboxPublisher`'s own header — never `pipeline.outboxPublisher`
      // itself, whose `batchSize: 100` would also drain the real ambient backlog.
      const outboxPublisher = buildSingleRowOutboxPublisher(pipeline);

      try {
        const afterConnector = await orchestrator.processClaimedEntry(claimed);
        expect(afterConnector.status).toBe('dispatched_external');
        expect(afterConnector.external_system_code).toBe('PROMO_CODE_SERVICE');
        expect(afterConnector.external_reference_id).toBe(`promo-${fixture.id}`);
        // Implementation note 7: assert the actual outbound HTTP call, not merely "the connector
        // was called" — the correct Authorization header and body shape.
        const [, requestInit] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [
          string,
          RequestInit,
        ];
        expect((requestInit.headers as Record<string, string>).Authorization).toBe(
          `Bearer ${PROMO_CODE_AUTH_SECRET_VALUE}`,
        );
        const sentBody = JSON.parse(requestInit.body as string) as Record<string, unknown>;
        expect(sentBody.correlationId).toBe(fixture.correlationId);
        expect(sentBody.bindRefId).toBe(fixture.campaignCode);

        await backdatePastCompletionSweepGrace(migrationDb, fixture.id);
        await completionSweep.sweepOnce();

        const completedRow = await fetchRow(migrationDb, fixture.id);
        expect(completedRow.status).toBe('completed');

        // T-RR-071: guarantee this row is the oldest (hence first) row `findPendingBatch` returns
        // — see `backdateOutboxRowToOldest`'s own header for why, now that this cycle actually
        // reaches the real ambient backlog.
        await backdateOutboxRowToOldest(fixture.id);
        await outboxPublisher.runOnce();
        // `buildSingleRowOutboxPublisher`'s own `batchSize: 1` plus the backdate just above
        // guarantees this cycle touches *only* this test's own row — the exact count is still safe.
        expect(dispatchMetrics.getDispatchTierCount('kafka')).toBe(1);

        const outboxRows = await migrationDb.query<{ status: string }>(
          'SELECT status FROM reward_redemption.reward_tracking_dispatch_outbox WHERE reward_entry_id = :id',
          { type: QueryTypes.SELECT, replacements: { id: fixture.id } },
        );
        expect(outboxRows).toHaveLength(1);
        expect(outboxRows[0].status).toBe('PUBLISHED');

        if (opts.verifyKafkaTopic) {
          await waitForCondition(
            async () => observedCompletedMessages.some((m) => m.rewardEntryId === fixture.id),
            20_000,
          );
          const observed = observedCompletedMessages.find((m) => m.rewardEntryId === fixture.id);
          expect(observed).toMatchObject({
            rewardEntryId: fixture.id,
            campaignCode: fixture.campaignCode,
            externalSystemCode: 'PROMO_CODE_SERVICE',
            externalReferenceId: `promo-${fixture.id}`,
          });
          expect(typeof observed?.customerId).toBe('string');
          expect(observed?.customerId).not.toBe(''); // R8: decrypted plaintext present on the wire message
        }
      } finally {
        await completedTopicConsumer?.disconnect();
        await destroyRealPipeline(pipeline);
      }
    }

    // TC-1
    it('TC-1: gRPC ingestion -> full pipeline -> PromoCodeServiceConnector success -> Kafka dispatch (asserts the real published message)', async () => {
      await runHappyPathViaChannel('GRPC', { verifyKafkaTopic: true });
    });

    // TC-2
    it('TC-2: REST ingestion -> identical observable outcome apart from ingestion_channel', async () => {
      await runHappyPathViaChannel('REST');
    });

    // TC-3
    it('TC-3: Kafka ingestion -> identical observable outcome apart from ingestion_channel', async () => {
      await runHappyPathViaChannel('KAFKA');
    });
  });

  async function startCompletedTopicConsumer(
    sink: Array<Record<string, unknown>>,
  ): Promise<Consumer> {
    const kafka = new Kafka({
      clientId: 'rr-e2e-full-pipeline-completed-consumer',
      brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(',').map((b) => b.trim()),
      logLevel: logLevel.NOTHING,
    });
    const consumer = kafka.consumer({ groupId: `rr-e2e-full-pipeline-completed-${Date.now()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: REWARD_TRACKING_COMPLETED_TOPIC, fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) {
          return;
        }
        sink.push(JSON.parse(message.value.toString()) as Record<string, unknown>);
      },
    });

    // Warm-up canary — same "seeks to log end at first fetch" pitfall
    // `cross-channel-parity.e2e-spec.ts` already documents, applied here to this second topic.
    const warmupProducer = new RewardTrackingKafkaProducerClient(realDbConfigService());
    const canaryId = `warmup-canary-${Date.now()}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      await warmupProducer.publish(REWARD_TRACKING_COMPLETED_TOPIC, canaryId, {
        rewardEntryId: canaryId,
      });
      if (sink.some((m) => m.rewardEntryId === canaryId)) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error('completed-topic consumer warm-up timed out');
      }
      await sleep(300);
    }
    sink.length = 0; // discard the canary — only real test messages matter to the caller
    // Avoid leaking this throwaway producer's own open Kafka connection past this helper's own
    // call — `onModuleDestroy()` disconnects it if (and only if) `connect()` ever actually ran.
    await warmupProducer.onModuleDestroy();
    return consumer;
  }

  // ---------------------------------------------------------------------------------------------
  // TC-4 — CoreBankingConnector success
  // ---------------------------------------------------------------------------------------------
  it('TC-4: CoreBankingConnector stub configured SUCCESS -> entry reaches completed via the stub connector, external_system_code = CORE_BANKING, no real network call made', async () => {
    const fixture = buildCanonicalFixtureEntry(TENANT_ID);
    entryIdsToClean.push(fixture.id);
    campaignsToClean.push(fixture.campaignCode);
    await sendViaChannel('REST', fixture);
    await stampTenantCountryEnrichment(migrationDb, fixture.id);
    await setCoreBankingStubOutcome(migrationDb, fixture.campaignCode, 'SUCCESS');

    const claimRepository = buildClaimRepository(sharedPool);
    const claimed = await claimSpecificEntry(claimRepository, migrationDb, fixture.id);

    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      const { orchestrator } = buildRealPipeline({
        systemCode: 'CORE_BANKING',
        connectorConfig: buildCoreBankingConnectorConfig(),
        notificationsEnabled: false,
        sharedPool,
      });

      const result = await orchestrator.processClaimedEntry(claimed);
      expect(result.status).toBe('dispatched_external');
      expect(result.external_system_code).toBe('CORE_BANKING');
      expect(result.external_reference_id).toMatch(/^CB-/);
      // The stub connector performs zero I/O — no real network call, ever
      // (`core-banking.connector.ts`'s own header).
      expect(fetchSpy).not.toHaveBeenCalled();

      expect(
        await countRelatedRows(migrationDb, 'external_system_call_log', fixture.id),
      ).toBeGreaterThan(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------------------------
  // TC-8 — retryable failure repeated until max_retry_attempts, then failed
  // ---------------------------------------------------------------------------------------------
  it('TC-8: CoreBankingConnector configured RETRYABLE_FAILURE repeatedly -> cycles processing -> retrying -> processing the expected number of times, then failed', async () => {
    const fixture = buildCanonicalFixtureEntry(TENANT_ID);
    entryIdsToClean.push(fixture.id);
    campaignsToClean.push(fixture.campaignCode);
    await sendViaChannel('REST', fixture);
    await stampTenantCountryEnrichment(migrationDb, fixture.id);
    await setCoreBankingStubOutcome(migrationDb, fixture.campaignCode, 'RETRYABLE_FAILURE');

    const claimRepository = buildClaimRepository(sharedPool);
    const { orchestrator } = buildRealPipeline({
      systemCode: 'CORE_BANKING',
      connectorConfig: buildCoreBankingConnectorConfig({ max_retry_attempts: 3 }),
      notificationsEnabled: false,
      sharedPool,
    });

    let lastResult = await orchestrator.processClaimedEntry(
      await claimSpecificEntry(claimRepository, migrationDb, fixture.id),
    );
    expect(lastResult.status).toBe('retrying');
    expect(lastResult.retry_count).toBe(1);

    await forceNextAttemptNow(migrationDb, fixture.id);
    lastResult = await orchestrator.processClaimedEntry(
      await claimSpecificEntry(claimRepository, migrationDb, fixture.id),
    );
    expect(lastResult.status).toBe('retrying');
    expect(lastResult.retry_count).toBe(2);

    await forceNextAttemptNow(migrationDb, fixture.id);
    lastResult = await orchestrator.processClaimedEntry(
      await claimSpecificEntry(claimRepository, migrationDb, fixture.id),
    );
    // max_retry_attempts = 3: the third attempt exhausts the budget -> failed, not retrying again.
    expect(lastResult.status).toBe('failed');

    const failedRows = await migrationDb.query<{ total_attempts: number }>(
      'SELECT total_attempts FROM reward_redemption.reward_redemption_failed WHERE reward_entry_id = :id',
      { type: QueryTypes.SELECT, replacements: { id: fixture.id } },
    );
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0].total_attempts).toBe(3);
  });

  // ---------------------------------------------------------------------------------------------
  // TC-9 — Kafka broker unavailable at dispatch time -> REST fallback delivers
  // ---------------------------------------------------------------------------------------------
  it('TC-9: Kafka broker unavailable at dispatch time -> REST fallback delivers the completed payload, redemption itself unaffected', async () => {
    const fixture = buildCanonicalFixtureEntry(TENANT_ID);
    entryIdsToClean.push(fixture.id);
    campaignsToClean.push(fixture.campaignCode);
    await sendViaChannel('REST', fixture);
    await stampTenantCountryEnrichment(migrationDb, fixture.id);
    await setCoreBankingStubOutcome(migrationDb, fixture.campaignCode, 'SUCCESS');

    const claimRepository = buildClaimRepository(sharedPool);
    const claimed = await claimSpecificEntry(claimRepository, migrationDb, fixture.id);

    // A real client pointed at an unreachable broker — `connect()` fails with a real
    // `KafkaBrokerUnreachableError`, `OutboxPublisherService`'s own documented immediate-fallback
    // trigger (`outbox-publisher.service.ts`'s own header, implementation note 4).
    const unreachableKafkaProducer = new RewardTrackingKafkaProducerClient(
      realDbConfigService({ KAFKA_BROKERS: 'localhost:1' }),
    );
    const restClient = new RewardTrackingRestClient({
      baseUrl: 'http://reward-tracking-service.test',
      token: 'test-token',
      timeoutMs: 5_000,
    });

    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonResponse(200, { status: 'accepted' }));
    const pipeline = buildRealPipeline({
      systemCode: 'CORE_BANKING',
      connectorConfig: buildCoreBankingConnectorConfig(),
      notificationsEnabled: false,
      sharedPool,
      kafkaProducer: unreachableKafkaProducer,
      restClient,
    });
    const { orchestrator, completionSweep, dispatchMetrics } = pipeline;
    // T-RR-071: see `buildSingleRowOutboxPublisher`'s own header — critically important for this
    // specific test, not just efficiency: `unreachableKafkaProducer` re-attempts a real, failing
    // 3s-timeout `connect()` on every `publish()` call, so draining any of the real ambient
    // backlog here (`pipeline.outboxPublisher`'s own `batchSize: 100`) would mean dozens of real,
    // sequential 3s connection timeouts.
    const outboxPublisher = buildSingleRowOutboxPublisher(pipeline, {
      kafkaProducer: unreachableKafkaProducer,
      restClient,
    });

    try {
      const afterConnector = await orchestrator.processClaimedEntry(claimed);
      expect(afterConnector.status).toBe('dispatched_external');

      await backdatePastCompletionSweepGrace(migrationDb, fixture.id);
      await completionSweep.sweepOnce();
      const completedRow = await fetchRow(migrationDb, fixture.id);
      // The redemption itself is unaffected by any later dispatch-tier failure (§7's own rule).
      expect(completedRow.status).toBe('completed');

      // T-RR-071: guarantee this row is the oldest (hence first, and — combined with
      // `buildSingleRowOutboxPublisher`'s own `batchSize: 1` — the *only* row `findPendingBatch`
      // returns this cycle.
      await backdateOutboxRowToOldest(fixture.id);
      await outboxPublisher.runOnce();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, requestInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://reward-tracking-service.test/api/v1/redemptions/completed');
      expect((requestInit.headers as Record<string, string>).Authorization).toBe(
        'Bearer test-token',
      );
      const sentBody = JSON.parse(requestInit.body as string) as Record<string, unknown>;
      expect(sentBody.rewardEntryId).toBe(fixture.id);

      expect(dispatchMetrics.getDispatchTierCount('rest')).toBe(1);
      expect(dispatchMetrics.getDispatchTierCount('kafka')).toBe(0);

      const outboxRows = await migrationDb.query<{ status: string }>(
        'SELECT status FROM reward_redemption.reward_tracking_dispatch_outbox WHERE reward_entry_id = :id',
        { type: QueryTypes.SELECT, replacements: { id: fixture.id } },
      );
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0].status).toBe('PUBLISHED');
    } finally {
      fetchSpy.mockRestore();
      await destroyRealPipeline(pipeline);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // TC-10/TC-11 — notification on/off
  // ---------------------------------------------------------------------------------------------
  describe('TC-10/TC-11 — notification-enabled vs. notification-disabled campaign', () => {
    it('TC-10: notification-enabled campaign -> notification_log row present with correct hash-only customer reference', async () => {
      const fixture = buildCanonicalFixtureEntry(TENANT_ID);
      entryIdsToClean.push(fixture.id);
      campaignsToClean.push(fixture.campaignCode);
      await sendViaChannel('REST', fixture);
      await stampTenantCountryEnrichment(migrationDb, fixture.id);
      await setCoreBankingStubOutcome(migrationDb, fixture.campaignCode, 'SUCCESS');

      const claimRepository = buildClaimRepository(sharedPool);
      const claimed = await claimSpecificEntry(claimRepository, migrationDb, fixture.id);

      const { orchestrator, completionSweep, notificationMetrics } = buildRealPipeline({
        systemCode: 'CORE_BANKING',
        connectorConfig: buildCoreBankingConnectorConfig(),
        notificationsEnabled: true,
        sharedPool,
      });

      await orchestrator.processClaimedEntry(claimed);
      await backdatePastCompletionSweepGrace(migrationDb, fixture.id);
      await completionSweep.sweepOnce();

      const completedRow = await fetchRow(migrationDb, fixture.id);
      expect(completedRow.status).toBe('completed');
      expect(notificationMetrics.getNotificationLoggedCount()).toBe(1);

      const notificationRows = await migrationDb.query<{ customer_id_hash: string }>(
        'SELECT customer_id_hash FROM reward_redemption.notification_log WHERE reward_entry_id = :id',
        { type: QueryTypes.SELECT, replacements: { id: fixture.id } },
      );
      expect(notificationRows).toHaveLength(1);
      // R8: only the hash, matching the entry's own stored hash — never plaintext/encrypted.
      expect(notificationRows[0].customer_id_hash).toBe(completedRow.customer_id_hash);
    });

    it('TC-11: notification-disabled campaign -> no notification_log row', async () => {
      const fixture = buildCanonicalFixtureEntry(TENANT_ID);
      entryIdsToClean.push(fixture.id);
      campaignsToClean.push(fixture.campaignCode);
      await sendViaChannel('REST', fixture);
      await stampTenantCountryEnrichment(migrationDb, fixture.id);
      await setCoreBankingStubOutcome(migrationDb, fixture.campaignCode, 'SUCCESS');

      const claimRepository = buildClaimRepository(sharedPool);
      const claimed = await claimSpecificEntry(claimRepository, migrationDb, fixture.id);

      const { orchestrator, completionSweep, notificationMetrics } = buildRealPipeline({
        systemCode: 'CORE_BANKING',
        connectorConfig: buildCoreBankingConnectorConfig(),
        notificationsEnabled: false,
        sharedPool,
      });

      await orchestrator.processClaimedEntry(claimed);
      await backdatePastCompletionSweepGrace(migrationDb, fixture.id);
      await completionSweep.sweepOnce();

      const completedRow = await fetchRow(migrationDb, fixture.id);
      expect(completedRow.status).toBe('completed');
      expect(notificationMetrics.getNotificationLoggedCount()).toBe(0);
      expect(await countRelatedRows(migrationDb, 'notification_log', fixture.id)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // TC-12 — a malformed entry on each of the three channels
  // ---------------------------------------------------------------------------------------------
  describe('TC-12 — a malformed entry on each channel is rejected without ever becoming a row', () => {
    it('REST: a body missing campaignCode -> 400, no row inserted', async () => {
      const fixture = buildCanonicalFixtureEntry(TENANT_ID);
      const response = await request(restApp.getHttpServer())
        .post('/api/v1/reward-entries')
        .set('Authorization', `Bearer ${REST_TOKEN}`)
        .send(buildMalformedRestBody(fixture));

      expect(response.status).toBe(400);
      expect(await countEntryRows(migrationDb, fixture.id)).toBe(0);
    });

    it('gRPC: an empty id -> INVALID_ARGUMENT, no row inserted', async () => {
      const fixture = buildCanonicalFixtureEntry(TENANT_ID);
      await expect(
        callSubmitRewardEntry(grpcClient, buildMalformedGrpcEntry(fixture)),
      ).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    });

    it('Kafka: a message missing campaignCode -> DLQ-eligible, never inserted as a row', async () => {
      const fixture = buildCanonicalFixtureEntry(TENANT_ID);
      const dlqMessages: Array<Record<string, unknown>> = [];
      const dlqConsumer = await startDlqTopicConsumer(dlqMessages);

      try {
        await kafkaProducer.send({
          topic: REWARD_ENTRY_CREATED_TOPIC,
          messages: [{ key: fixture.customerId, value: buildMalformedKafkaMessageValue(fixture) }],
        });

        await waitForCondition(
          async () => dlqMessages.some((m) => (m.id as string | undefined) === fixture.id),
          30_000,
        );
        expect(await countEntryRows(migrationDb, fixture.id)).toBe(0);
      } finally {
        await dlqConsumer.disconnect();
      }
    });
  });

  async function startDlqTopicConsumer(sink: Array<Record<string, unknown>>): Promise<Consumer> {
    const kafka = new Kafka({
      clientId: 'rr-e2e-full-pipeline-dlq-consumer',
      brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(',').map((b) => b.trim()),
      logLevel: logLevel.NOTHING,
    });
    const consumer = kafka.consumer({ groupId: `rr-e2e-full-pipeline-dlq-${Date.now()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: REWARD_ENTRY_CREATED_DLQ_TOPIC, fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) {
          return;
        }
        try {
          sink.push(JSON.parse(message.value.toString()) as Record<string, unknown>);
        } catch {
          sink.push({ raw: message.value.toString() });
        }
      },
    });

    // Warm-up canary on the DLQ topic itself — a raw kafkajs producer publish is enough here (the
    // DLQ producer's own message shape is irrelevant to proving this consumer is actively fetching).
    const canaryId = `warmup-canary-dlq-${Date.now()}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      await kafkaProducer.send({
        topic: REWARD_ENTRY_CREATED_DLQ_TOPIC,
        messages: [{ key: canaryId, value: JSON.stringify({ id: canaryId }) }],
      });
      if (sink.some((m) => m.id === canaryId)) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error('DLQ-topic consumer warm-up timed out');
      }
      await sleep(300);
    }
    sink.length = 0;
    return consumer;
  }
});
