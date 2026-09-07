/**
 * T-RR-041 — TC-5. R6's single most safety-critical case in this task's own file scope: the same
 * logical `id` submitted via REST, then gRPC, then Kafka — three overlapping duplicate submissions
 * across three different real transports for one logical entry. Exactly one
 * `reward_redemption_entry` row must ever exist, and — after driving that one row through the full
 * pipeline — exactly one `external_system_call_log` row and one `reward_tracking_dispatch_outbox`
 * row, never duplicated by any of the three channels.
 *
 * Real mTLS gRPC server (T-RR-011), real Kafka consumer against the real local Redpanda broker
 * (T-RR-012), real REST controller on the real `AppModule` (T-RR-013) — the same three-transport
 * harness `test/modules/reward-ingestion/cross-channel-parity.e2e-spec.ts` (T-RR-014) already
 * established and proved safe to run in parallel with sibling spec files in this same Jest run
 * (its own header's design notes 1/2 apply identically here: shared Kafka consumer group,
 * warm-up-canary-proven readiness, generous polling waits).
 */
import { readFileSync } from 'node:fs';
import type { INestMicroservice, INestApplicationContext, INestApplication } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import { Kafka, logLevel, type Producer } from 'kafkajs';
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
import { AppModule } from '@/app.module';
import { TestCertAuthority, type IssuedCertificate } from '../grpc/support/test-cert-authority';
import {
  createTestClient,
  callSubmitRewardEntry,
  type RewardIngestServiceTestClient,
} from '../grpc/support/test-grpc-client';
import {
  buildCanonicalFixtureEntry,
  buildClaimRepository,
  buildCoreBankingConnectorConfig,
  buildDbPool,
  buildRealPipeline,
  cleanupEntry,
  claimSpecificEntry,
  countEntryRows,
  countRelatedRows,
  createMigrationDb,
  fetchRow,
  getFreePort,
  sleep,
  toGrpcRewardEntry,
  toKafkaMessageValue,
  toRestRequestBody,
  waitForCondition,
  acquireCrossFileClaimMutex,
  releaseCrossFileClaimMutex,
  stampTenantCountryEnrichment,
  type CanonicalFixtureEntry,
  type IngestionChannel,
} from './fixtures/reward-entry.fixtures';

jest.setTimeout(180_000);

const GRPC_IDENTITY = 'rr-e2e-duplicate-arrival-client';
const TENANT_ID = 966_000 + Math.floor(Math.random() * 999);
const REST_TOKEN = process.env.REWARD_ENTRY_INGEST_TOKEN;
const CHANNELS: IngestionChannel[] = ['GRPC', 'KAFKA', 'REST'];

describe('T-RR-041 — duplicate-arrival (TC-5, R6)', () => {
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
      clientId: 'rr-e2e-duplicate-arrival-producer',
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
        console.warn('T-RR-041 duplicate-arrival teardown step failed:', error);
      }
    }
    await releaseCrossFileClaimMutex(mutexClient);
  }, 60_000);

  async function warmUpKafkaConsumer(): Promise<void> {
    const canary = buildCanonicalFixtureEntry(TENANT_ID, { campaignCode: 'WARMUP-CANARY-TRR041' });
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

  // TC-5
  it('TC-5: the same id submitted via REST, then gRPC, then Kafka -> exactly one row, no cross-channel-triplicated call-log/outbox rows', async () => {
    const fixture = buildCanonicalFixtureEntry(TENANT_ID);
    entryIdsToClean.push(fixture.id);

    await sendViaChannel('REST', fixture);
    await sendViaChannel('GRPC', fixture);
    await sendViaChannel('KAFKA', fixture);

    expect(await countEntryRows(migrationDb, fixture.id)).toBe(1);
    const row = await fetchRow(migrationDb, fixture.id);
    // First writer wins (R6) — REST inserted first, gRPC/Kafka both resolved to the safe,
    // already-existing-row no-op.
    expect(row.ingestion_channel).toBe('REST');

    await stampTenantCountryEnrichment(migrationDb, fixture.id);
    const claimRepository = buildClaimRepository(sharedPool);
    const claimed = await claimSpecificEntry(claimRepository, migrationDb, fixture.id);

    const { orchestrator, completionSweep } = buildRealPipeline({
      systemCode: 'CORE_BANKING',
      connectorConfig: buildCoreBankingConnectorConfig(),
      notificationsEnabled: false,
      sharedPool,
    });

    const afterConnector = await orchestrator.processClaimedEntry(claimed);
    expect(afterConnector.status).toBe('dispatched_external');

    await migrationDb.query(
      `UPDATE reward_redemption.reward_redemption_entry
         SET updated_at = now() - interval '1 hour'
       WHERE id = :id`,
      { type: QueryTypes.RAW, replacements: { id: fixture.id } },
    );
    await completionSweep.sweepOnce();

    const completedRow = await fetchRow(migrationDb, fixture.id);
    expect(completedRow.status).toBe('completed');

    // The heart of R6 for this test: three overlapping submissions across three channels for the
    // one logical entry never produced more than one downstream side effect anywhere.
    expect(await countEntryRows(migrationDb, fixture.id)).toBe(1);
    // T-RR-067 (fixed): a single successful connector call now writes exactly ONE
    // `external_system_call_log` row, not two. Before that fix, `RedemptionStateMachineService
    // .markDispatchedExternal` (`05-PROCESSING-PIPELINE.md` §6) also inserted its own row on the
    // `SUCCESS` transition, on top of the connector's own unconditional `writeCallLog`
    // (`08-EXTERNAL-INTEGRATION-CONTRACTS.md` §2/§3) — an observability duplication, not a
    // correctness bug (no double redemption, no double external call), but real, and reproduced by
    // this exact test (see T-RR-067's own completion report for the previously-observed `2`). The
    // connector is now the row's sole writer; `1`, not `2`, is this test's own correct expected
    // value for a single real connector call. The actual R6 property this test proves is unchanged:
    // three overlapping channel submissions never multiply that baseline (would be `2`/`3` if
    // cross-channel dedup, or this test's own single manual claim/process call, had somehow let the
    // entry be processed more than once).
    expect(await countRelatedRows(migrationDb, 'external_system_call_log', fixture.id)).toBe(1);
    expect(await countRelatedRows(migrationDb, 'reward_tracking_dispatch_outbox', fixture.id)).toBe(
      1,
    );
  });

  // Exhaustive ordering coverage beyond TC-5's own literal ordering — every pairwise ordering and
  // the full six-permutation matrix, at the ingestion layer only (R6's dedup guarantee does not
  // depend on which channel arrives first).
  function orderedPairs(): Array<[IngestionChannel, IngestionChannel]> {
    const pairs: Array<[IngestionChannel, IngestionChannel]> = [];
    for (const first of CHANNELS) {
      for (const second of CHANNELS) {
        if (first !== second) {
          pairs.push([first, second]);
        }
      }
    }
    return pairs;
  }

  describe.each(orderedPairs())('ordering matrix: %s then %s (same id)', (first, second) => {
    it('exactly one row, no error on either channel', async () => {
      const fixture = buildCanonicalFixtureEntry(TENANT_ID);
      entryIdsToClean.push(fixture.id);
      await sendViaChannel(first, fixture);
      await sendViaChannel(second, fixture);

      expect(await countEntryRows(migrationDb, fixture.id)).toBe(1);
      const row = await fetchRow(migrationDb, fixture.id);
      expect(row.ingestion_channel).toBe(first);
    });
  });
});
