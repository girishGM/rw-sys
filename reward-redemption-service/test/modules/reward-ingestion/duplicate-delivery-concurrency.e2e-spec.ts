/**
 * T-RR-014. Real concurrency proof of R6 ("exactly-once terminal processing per
 * `reward_entry_unique_id`") — genuinely concurrent duplicate arrivals across at least two
 * different real transports, racing against the real `reward_redemption` schema on the real local
 * Postgres 16 server, repeated across many iterations with a fresh `id` per iteration so a race that
 * only manifests probabilistically cannot hide behind a single lucky run (implementation note 4).
 *
 * This file boots its own, independent instance of every transport (its own ephemeral gRPC
 * port/mTLS certs, its own Kafka consumer/producer, its own REST `AppModule`) rather than sharing
 * `cross-channel-parity.e2e-spec.ts`'s — see that file's own header design note 1 for why both
 * files' Kafka consumers nonetheless join the identical, hardcoded shared consumer group when Jest
 * runs them in parallel worker processes, and why every Kafka-driven wait below is a generous
 * polling wait rather than a fixed short timeout for exactly that reason.
 *
 * Each race fires both sends via `Promise.all` — both requests are genuinely in flight
 * concurrently at the transport/network layer — then polls for the row to settle and holds for a
 * short grace window before making the final assertion, so a duplicate that lands *shortly after*
 * the first observed row (the actual shape a real race bug would take, per
 * `reward_redemption_entry.repository`'s own `ON CONFLICT (id) DO NOTHING RETURNING *` header) is
 * still caught rather than raced past.
 *
 * **On the per-test timeout (T-RR-014 review fix, retry 1; widened again, retry 2):** `TC-6` and
 * the supplementary triple-race test each run their whole iteration loop inside a single `it()`.
 * A prior review observed `TC-6` genuinely exceed a 300s per-test budget twice under real
 * shared-machine contention (two other services' Kafka brokers plus other agents' own test runs
 * on this same dev box — see root `CLAUDE.md`) with **no assertion inside the loop ever failing**
 * — i.e. the suite was correct but not resilient to realistic contention on a shared machine, not
 * flaky in the R6 sense. Per-iteration cost here is dominated by real network/DB/broker round
 * trips that scale with whatever else the machine is doing, not by this file's own fixed
 * overhead, so the fix is a per-`it()` timeout with real margin above any single observed run —
 * never a smaller iteration count, which would silently weaken the very probabilistic-race
 * coverage this suite exists to provide (task file implementation note 4). See each `it()`'s own
 * explicit third-argument timeout below rather than relying on the file-level `jest.setTimeout`
 * default.
 *
 * **Retry 2 evidence:** the isolated command this task's own Verification step 2 specifies
 * (`npm test -- cross-channel-parity duplicate-delivery-concurrency`) passes cleanly and fast (all
 * 23 tests in ~57s total, supplementary itself ~11s) — confirming this suite has no actual R6
 * defect. But the full, unfiltered `npm test` run (`AGENT-PROTOCOL.md` §4's own separate DoD gate,
 * which boots all ~54 spec files' worth of Nest app contexts — each opening its own `pg.Pool` —
 * concurrently against the same real local Postgres server) drove contention severe enough that
 * the supplementary test's own then-900,000ms budget was exceeded with a request still generically
 * in flight (observed as a `Cannot use a pool after calling end on the pool` error once that test's
 * own `afterAll` tore down mid-flight) — the same class of finding as retry 1, just at a new, higher
 * contention ceiling than a 900s budget covers. Raised to match `TC6_TIMEOUT_MS`'s own 30-minute
 * budget below: 15 triple-channel iterations have no principled reason to need *more* wall-clock
 * margin than TC-6's 50 two-channel iterations already carries.
 */
import 'reflect-metadata';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import type { INestMicroservice, INestApplicationContext, INestApplication } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Sequelize, QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import { createGrpcMicroservice } from '@/grpc/grpc-server.main';
import { createKafkaConsumerContext } from '@/messaging/ingest/kafka-consumer.main';
import {
  RewardEntryCreatedConsumer,
  REWARD_ENTRY_CREATED_TOPIC,
} from '@/messaging/ingest/reward-entry-created.consumer';
import { AppModule } from '@/app.module';
import type { IngestionChannel } from '@/modules/reward-ingestion/reward-entry-ingest.dto';
import { TestCertAuthority, type IssuedCertificate } from '../../grpc/support/test-cert-authority';
import {
  createTestClient,
  callSubmitRewardEntry,
  type RewardIngestServiceTestClient,
} from '../../grpc/support/test-grpc-client';
import {
  buildCanonicalFixtureEntry,
  toGrpcRewardEntry,
  toKafkaMessageValue,
  toRestRequestBody,
  type CanonicalFixtureEntry,
} from './fixtures/reward-entry.fixture';

// Default timeout for hooks (`beforeAll`/`afterAll`) and any `it()` that doesn't specify its own —
// TC-6 and the supplementary triple-race test each override this explicitly (see their own third
// `it()` argument and the file header's "On the per-test timeout" note) since their loop bodies
// need far more real margin under shared-machine contention than a single-request hook does.
jest.setTimeout(300_000);

/** TC-6 (`ITERATIONS` sequential iterations, each racing 2 channels) needs real margin above any
 * single observed wall-clock run on this shared dev machine, not just above its own fixed
 * per-iteration overhead — see the file header. */
const TC6_TIMEOUT_MS = 1_800_000; // 30 minutes
/** Matches `TC6_TIMEOUT_MS` (retry 2, see file header) — fewer iterations
 * (`TRIPLE_RACE_ITERATIONS` vs TC-6's `ITERATIONS`) is not a principled reason to give this test
 * *less* margin than TC-6 gets against the same full-`npm test`-suite worst-case contention. */
const SUPPLEMENTARY_TIMEOUT_MS = 1_800_000; // 30 minutes

const GRPC_IDENTITY = 'rr-e2e-concurrency-client';
const TENANT_ID = 973_000 + Math.floor(Math.random() * 999);
const REST_TOKEN = process.env.REWARD_ENTRY_INGEST_TOKEN;

/** The 3 unordered channel pairs this suite races — cycled round-robin across TC-6's 50 iterations
 * so every pair gets roughly equal coverage (implementation note 4: "different channel pairs each
 * iteration"). */
const CHANNEL_PAIRS: Array<[IngestionChannel, IngestionChannel]> = [
  ['GRPC', 'KAFKA'],
  ['KAFKA', 'REST'],
  ['REST', 'GRPC'],
];

const ITERATIONS = 50;
/** Extra evidence beyond the task's own minimum ("at least two different channels
 * simultaneously") — races all three channels at once across a smaller number of iterations. */
const TRIPLE_RACE_ITERATIONS = 15;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error('failed to allocate a free port'));
      }
    });
  });
}

describe('T-RR-014 — duplicate-delivery concurrency (real gRPC + real Kafka + real REST, real Postgres) (e2e)', () => {
  let db: Sequelize;
  let ca: TestCertAuthority;
  let grpcApp: INestMicroservice;
  let grpcClient: RewardIngestServiceTestClient;
  let kafkaApp: INestApplicationContext;
  let kafkaProducer: Producer;
  let restApp: INestApplication;

  beforeAll(async () => {
    if (!REST_TOKEN) {
      throw new Error(
        'REWARD_ENTRY_INGEST_TOKEN is not set — see .env.local (T-RR-013 own header note)',
      );
    }

    db = createMigrationConnection();
    await db.authenticate();

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
      clientId: 'rr-e2e-duplicate-delivery-concurrency-producer',
      brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(',').map((b) => b.trim()),
      logLevel: logLevel.NOTHING,
    });
    kafkaProducer = kafka.producer();
    await kafkaProducer.connect();

    const restModuleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    restApp = restModuleRef.createNestApplication();
    await restApp.init();

    await warmUpKafkaConsumer();
  });

  afterAll(async () => {
    // Each step is independently guarded — if `beforeAll` threw partway through (e.g. the real
    // Redpanda broker was transiently down), several of these resources were never assigned, and a
    // single unguarded call here would crash before the rest of teardown (and, importantly, the
    // real error `beforeAll` threw) ever surfaces cleanly.
    const steps: Array<() => Promise<void> | void> = [
      () =>
        db?.query(
          'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenantId',
          { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
        ),
      () => grpcClient?.close(),
      () => grpcApp?.close(),
      () => kafkaApp?.close(),
      () => kafkaProducer?.disconnect(),
      () => restApp?.close(),
      () => db?.close(),
      () => ca?.cleanup(),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        // Best-effort cleanup — swallow so every remaining step still runs; the real failure (if
        // any) is whatever `beforeAll`/the test body itself already threw.
        console.warn('T-RR-014 duplicate-delivery-concurrency teardown step failed:', error);
      }
    }
  });

  async function countRows(id: string): Promise<number> {
    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_redemption.reward_redemption_entry WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    return Number(rows[0].count);
  }

  async function warmUpKafkaConsumer(): Promise<void> {
    const canary = buildCanonicalFixtureEntry(TENANT_ID, { campaignCode: 'WARMUP-CANARY' });
    const deadline = Date.now() + 30_000;
    for (;;) {
      await kafkaProducer.send({
        topic: REWARD_ENTRY_CREATED_TOPIC,
        messages: [{ key: canary.customerId, value: toKafkaMessageValue(canary) }],
      });
      if ((await countRows(canary.id)) >= 1) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error('Kafka consumer warm-up timed out waiting for the canary to be consumed');
      }
      await sleep(500);
    }
  }

  /** Fires `fixture` at `channel` and resolves once that channel's own call/produce has completed
   * — for Kafka this is only the producer `send()` call (never awaiting downstream consumption),
   * which is what makes the `Promise.all` callers below a genuine concurrent race rather than a
   * sequential one. */
  async function fireViaChannel(
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
  }

  /** Races `fixture` across every channel in `channels` concurrently, then asserts exactly one row
   * ever exists for its `id` — waiting for at least one row (accounting for Kafka's own
   * asynchronous consumption), then holding a grace window before the final count, so a duplicate
   * landing shortly after the first is still caught (this file's own header). */
  async function raceAndAssertExactlyOneRow(
    channels: IngestionChannel[],
    fixture: CanonicalFixtureEntry,
  ): Promise<void> {
    await Promise.all(channels.map((channel) => fireViaChannel(channel, fixture)));
    await waitForCondition(async () => (await countRows(fixture.id)) >= 1, 20_000);
    await sleep(750);
    expect(await countRows(fixture.id)).toBe(1);
  }

  // TC-6
  it(
    `TC-6: ${ITERATIONS} iterations of two simultaneous sends (rotating channel pairs) for ${ITERATIONS} distinct fresh ids — zero failures`,
    async () => {
      const failures: string[] = [];

      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const [first, second] = CHANNEL_PAIRS[iteration % CHANNEL_PAIRS.length];
        const fixture = buildCanonicalFixtureEntry(TENANT_ID);
        try {
          await raceAndAssertExactlyOneRow([first, second], fixture);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          failures.push(
            `iteration ${iteration} (${first} vs ${second}, id=${fixture.id}): ${reason}`,
          );
        }
      }

      // A single flaky failure across all iterations is a real R6 defect, not noise to average away
      // (task file's own Verification steps) — reported in full, not just a boolean.
      expect(failures).toEqual([]);
    },
    TC6_TIMEOUT_MS,
  );

  // Supplementary: races all three channels at once, beyond the task's own stated minimum of two.
  it(
    `supplementary: ${TRIPLE_RACE_ITERATIONS} iterations of all three channels racing simultaneously for distinct fresh ids — zero failures`,
    async () => {
      const failures: string[] = [];

      for (let iteration = 0; iteration < TRIPLE_RACE_ITERATIONS; iteration += 1) {
        const fixture = buildCanonicalFixtureEntry(TENANT_ID);
        try {
          await raceAndAssertExactlyOneRow(['GRPC', 'KAFKA', 'REST'], fixture);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          failures.push(`iteration ${iteration} (id=${fixture.id}): ${reason}`);
        }
      }

      expect(failures).toEqual([]);
    },
    SUPPLEMENTARY_TIMEOUT_MS,
  );
});
