/**
 * T-RR-014. Real, end-to-end proof of `AGENT-PROTOCOL.md` R6/R10 across all three live ingestion
 * transports at once — the real mTLS gRPC server (`T-RR-011`), the real Kafka consumer against the
 * real local Redpanda broker (`T-RR-012`), and the real REST controller wired into the real
 * `AppModule` (`T-RR-013`) — all pointed at the same real, already-migrated `reward_redemption`
 * schema on the real local Postgres 16 server (root `CLAUDE.md`). Every scenario below sends the
 * exact same canonical fixture entry (`fixtures/reward-entry.fixture.ts`) through one or more
 * channels and asserts, against the real database, that exactly one row exists and every field the
 * ingestion path owns matches the fixture — never a mocked transport, never an assertion about which
 * function was called.
 *
 * ## Design notes worth reading before touching this file
 *
 * 1. **Kafka consumer group is shared across this file and `duplicate-delivery-concurrency.e2e-
 *    spec.ts`.** `RewardEntryCreatedConsumer.start()` hardcodes the real, fixed
 *    `REWARD_ENTRY_CREATED_CONSUMER_GROUP` (`02-KAFKA-CONTRACTS.md` §1's "one shared group",
 *    `reward-entry-created.consumer.ts`'s own header) — that constant is not test-overridable
 *    without editing that file, which is outside this task's own scope (this task's own "Out"
 *    section: no change to T-RR-010–013's implementation). When Jest runs both `*.e2e-spec.ts`
 *    files in this directory in separate parallel worker processes, both open a real consumer that
 *    joins the SAME consumer group against the SAME real broker — correct by construction (either
 *    group member processing a given message produces an identical observable outcome, since both
 *    run the identical code against the identical database), but a group rebalance when a second
 *    member joins/leaves can pause delivery for a few seconds. Every Kafka-driven wait below is a
 *    generous, polling wait for exactly this reason — never a fixed short timeout.
 * 2. **Kafka-consumer readiness is proven by a warm-up canary, not a fixed sleep.** A brand-new
 *    consumer group with no committed offset seeks to the *current* log end the moment its first
 *    fetch request actually goes out — a message produced before that moment is silently never
 *    seen, a well-known Kafka pitfall. `warmUpKafkaConsumer()` below re-publishes one throwaway
 *    fixture (harmless to publish repeatedly — R6 dedup makes every repeat but the first a safe
 *    no-op) until it is observed inserted, proving the shared consumer is actively fetching before
 *    any scenario below depends on Kafka delivery.
 * 3. **`status` is asserted as "one of the reachable values", never pinned to exactly `'received'`.**
 *    This mirrors the identical, already-established tolerance in `test/grpc/reward-ingest.e2e-
 *    spec.ts` TC-2 and `test/rest/reward-entries/reward-entries.e2e-spec.ts` TC-2: this service's
 *    own `ClaimWorkerService`/`RedemptionStateMachineService` real-DB test suites (T-RR-020/T-RR-021)
 *    run an actual, un-tenant-scoped polling worker against this same table when Jest runs their
 *    spec files in parallel with this one — a real, already-filed race (`T-RR-052`/`T-RR-053`, both
 *    owned by `agent-rr-processing`, outside this task's file scope) that can advance a freshly
 *    inserted row's `status` before this suite's own assertion runs. Every other ingestion-owned
 *    field this suite asserts is unaffected by that race (only Wave 2's own worker code touches
 *    `status`/the claim-time columns), so the field-for-field comparison below still catches a real
 *    R10 parity bug without being flaky against a pre-existing, out-of-scope defect.
 * 4. **`customerId` parity is proven by decrypting `customer_id_encrypted`, never by comparing
 *    ciphertext** (R8) — `EncryptionService.encrypt()` is non-deterministic (a fresh random IV every
 *    call, `encryption.service.ts`'s own header), so two channels encrypting the identical plaintext
 *    never produce identical ciphertext; decrypting both back to the same plaintext is the only
 *    correct parity check.
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
import {
  EncryptionService,
  loadEncryptionKeyMaterial,
} from '@/modules/encryption/encryption.service';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';
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
  expectedRowFields,
  type CanonicalFixtureEntry,
} from './fixtures/reward-entry.fixture';

jest.setTimeout(180_000);

const GRPC_IDENTITY = 'rr-e2e-parity-client';
const TENANT_ID = 972_000 + Math.floor(Math.random() * 999);
const REST_TOKEN = process.env.REWARD_ENTRY_INGEST_TOKEN;

const CHANNELS: IngestionChannel[] = ['GRPC', 'KAFKA', 'REST'];

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

/** All 6 ordered (first, second) pairs over the 3 channels — implementation note 2's "every
 * pairwise ordering", both directions of each unordered pair. */
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

/** All 6 full-triple permutations — implementation note 2's "all six orderings of the three". */
function allTriplePermutations(): IngestionChannel[][] {
  const permutations: IngestionChannel[][] = [];
  const permute = (remaining: IngestionChannel[], current: IngestionChannel[]): void => {
    if (remaining.length === 0) {
      permutations.push(current);
      return;
    }
    remaining.forEach((channel, index) => {
      const rest = [...remaining.slice(0, index), ...remaining.slice(index + 1)];
      permute(rest, [...current, channel]);
    });
  };
  permute(CHANNELS, []);
  return permutations;
}

describe('T-RR-014 — cross-channel parity (real gRPC + real Kafka + real REST, real Postgres) (e2e)', () => {
  let db: Sequelize;
  let ca: TestCertAuthority;
  let grpcApp: INestMicroservice;
  let grpcClient: RewardIngestServiceTestClient;
  let kafkaApp: INestApplicationContext;
  let kafkaProducer: Producer;
  let restApp: INestApplication;
  let encryption: EncryptionService;

  beforeAll(async () => {
    if (!REST_TOKEN) {
      throw new Error(
        'REWARD_ENTRY_INGEST_TOKEN is not set — see .env.local (T-RR-013 own header note)',
      );
    }

    db = createMigrationConnection();
    await db.authenticate();
    encryption = new EncryptionService(loadEncryptionKeyMaterial());

    // --- gRPC transport (real mTLS server, ephemeral CA/certs/port — same pattern
    // `test/grpc/reward-ingest.e2e-spec.ts` already establishes) ---
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

    // --- Kafka transport (real consumer against the real local Redpanda broker) ---
    const maybeKafkaApp = await createKafkaConsumerContext();
    if (maybeKafkaApp === null) {
      throw new Error(
        'expected createKafkaConsumerContext() to return an app context in this test',
      );
    }
    kafkaApp = maybeKafkaApp;
    await kafkaApp.get(RewardEntryCreatedConsumer).start();

    const kafka = new Kafka({
      clientId: 'rr-e2e-cross-channel-parity-producer',
      brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(',').map((b) => b.trim()),
      logLevel: logLevel.NOTHING,
    });
    kafkaProducer = kafka.producer();
    await kafkaProducer.connect();

    // --- REST transport (real AppModule, same pattern `reward-entries.e2e-spec.ts` establishes) ---
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
        console.warn('T-RR-014 cross-channel-parity teardown step failed:', error);
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

  async function fetchRow(id: string): Promise<RewardRedemptionEntryRow> {
    const rows = await db.query<RewardRedemptionEntryRow>(
      'SELECT * FROM reward_redemption.reward_redemption_entry WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    if (rows.length !== 1) {
      throw new Error(`expected exactly one row for id ${id}, found ${rows.length}`);
    }
    return rows[0];
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

  /** Sends `fixture` via `channel` and only resolves once the row is durably visible in the real
   * database — for gRPC/REST that is already true the instant the call resolves; for Kafka this
   * additionally polls (design note 1/2 above) since consumption is asynchronous from the
   * producer's own perspective. */
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
    await waitForCondition(async () => (await countRows(fixture.id)) >= 1, 20_000);
  }

  /** Field-for-field comparison (implementation note 3) against every column the ingestion path
   * owns, plus the two timestamp columns (compared as ISO instants, not raw `Date` object
   * equality) and `customerId` (compared by decryption, design note 4 above). Deliberately never
   * compares `status` to a single exact value — design note 3 above. */
  function expectRowMatchesFixture(
    row: RewardRedemptionEntryRow,
    fixture: CanonicalFixtureEntry,
    channel: IngestionChannel,
  ): void {
    const expected = expectedRowFields(fixture, channel);
    (Object.keys(expected) as Array<keyof RewardRedemptionEntryRow>).forEach((key) => {
      expect(row[key]).toEqual(expected[key]);
    });

    expect(new Date(row.activity_performed_date).toISOString()).toBe(
      new Date(fixture.activityPerformedDate).toISOString(),
    );
    expect(new Date(row.reward_entry_date).toISOString()).toBe(
      new Date(fixture.rewardEntryDate).toISOString(),
    );

    expect(encryption.decrypt(row.customer_id_encrypted)).toBe(fixture.customerId);
    expect(row.customer_id_hash).toBe(encryption.hash(fixture.customerId));

    // Deferred to Wave 2 (implementation note 3 in the task file) — must remain untouched by
    // ingestion.
    expect(row.country_code).toBeNull();
    expect(row.tenant_code).toBeNull();
    // NOT NULL, stamped from this instance's own NODE_ENV, never from the wire (T-RR-010's own
    // header) — asserted as "present", not pinned to a literal value this test would otherwise
    // have to keep in lockstep with local dev config.
    expect(typeof row.reward_processed_env).toBe('string');
    expect(row.reward_processed_env.length).toBeGreaterThan(0);
    // See design note 3 above.
    expect([
      'received',
      'processing',
      'dispatched_external',
      'completed',
      'retrying',
      'failed',
    ]).toContain(row.status);
  }

  // TC-1
  it('TC-1: gRPC only — row matches the fixture field-for-field, ingestion_channel = GRPC', async () => {
    const fixture = buildCanonicalFixtureEntry(TENANT_ID);
    await sendViaChannel('GRPC', fixture);

    expect(await countRows(fixture.id)).toBe(1);
    const row = await fetchRow(fixture.id);
    expect(row.ingestion_channel).toBe('GRPC');
    expectRowMatchesFixture(row, fixture, 'GRPC');
  });

  // TC-2
  it('TC-2: Kafka only — row matches the fixture field-for-field, ingestion_channel = KAFKA', async () => {
    const fixture = buildCanonicalFixtureEntry(TENANT_ID);
    await sendViaChannel('KAFKA', fixture);

    expect(await countRows(fixture.id)).toBe(1);
    const row = await fetchRow(fixture.id);
    expect(row.ingestion_channel).toBe('KAFKA');
    expectRowMatchesFixture(row, fixture, 'KAFKA');
  });

  // TC-3
  it('TC-3: REST only — row matches the fixture field-for-field, ingestion_channel = REST', async () => {
    const fixture = buildCanonicalFixtureEntry(TENANT_ID);
    await sendViaChannel('REST', fixture);

    expect(await countRows(fixture.id)).toBe(1);
    const row = await fetchRow(fixture.id);
    expect(row.ingestion_channel).toBe('REST');
    expectRowMatchesFixture(row, fixture, 'REST');
  });

  // TC-4
  it('TC-4: gRPC then Kafka for the same id — first writer wins, Kafka ack/offset-commit still succeeds cleanly', async () => {
    const fixture = buildCanonicalFixtureEntry(TENANT_ID);
    await sendViaChannel('GRPC', fixture);
    // Duplicate id on a different channel — must resolve without throwing and must not insert a
    // second row (R6).
    await sendViaChannel('KAFKA', fixture);

    expect(await countRows(fixture.id)).toBe(1);
    const row = await fetchRow(fixture.id);
    expect(row.ingestion_channel).toBe('GRPC');

    // Proves the shared consumer loop is still healthy after handling that duplicate (never
    // wedged/crashed by it) — a fresh, distinct entry sent Kafka-only still lands normally.
    const followUp = buildCanonicalFixtureEntry(TENANT_ID);
    await sendViaChannel('KAFKA', followUp);
    expect(await countRows(followUp.id)).toBe(1);
  });

  // TC-5
  it('TC-5: same id via all three channels in rapid succession — exactly one row, no channel errors', async () => {
    const fixture = buildCanonicalFixtureEntry(TENANT_ID);

    const results = await Promise.allSettled([
      sendViaChannel('GRPC', fixture),
      sendViaChannel('KAFKA', fixture),
      sendViaChannel('REST', fixture),
    ]);

    for (const result of results) {
      expect(result.status).toBe('fulfilled');
    }
    expect(await countRows(fixture.id)).toBe(1);
    const row = await fetchRow(fixture.id);
    expect(CHANNELS).toContain(row.ingestion_channel);
  });

  // TC-7 (deliberately self-contained rather than reusing TC-1/TC-2's own rows across `it` blocks —
  // functionally identical, since both scenarios' fixtures share every field except `id`/
  // `correlationId`/`customerId`, and this avoids any inter-test ordering dependency).
  it('TC-7: a gRPC-only row and a Kafka-only row of the same canonical content match on every field except id/ingestion_channel/timestamps', async () => {
    const grpcFixture = buildCanonicalFixtureEntry(TENANT_ID);
    const kafkaFixture = buildCanonicalFixtureEntry(TENANT_ID);
    await sendViaChannel('GRPC', grpcFixture);
    await sendViaChannel('KAFKA', kafkaFixture);

    const grpcRow = await fetchRow(grpcFixture.id);
    const kafkaRow = await fetchRow(kafkaFixture.id);

    const grpcExpected = expectedRowFields(grpcFixture, 'GRPC');
    const kafkaExpected = expectedRowFields(kafkaFixture, 'KAFKA');
    // `ingestion_channel` and `correlation_id` are the two deliberate differences (each fixture's
    // own `correlationId` is freshly randomized per `buildCanonicalFixtureEntry` call, exactly like
    // `id`/`customerId` — none of the three is part of "the same canonical content") — every other
    // field the fixtures share must compare equal between the two independently-inserted rows.
    const {
      ingestion_channel: grpcChannel,
      correlation_id: grpcCorrelationId,
      ...grpcRest
    } = grpcExpected;
    const {
      ingestion_channel: kafkaChannel,
      correlation_id: kafkaCorrelationId,
      ...kafkaRest
    } = kafkaExpected;
    expect(grpcChannel).toBe('GRPC');
    expect(kafkaChannel).toBe('KAFKA');
    expect(grpcCorrelationId).toBe(grpcFixture.correlationId);
    expect(kafkaCorrelationId).toBe(kafkaFixture.correlationId);
    expect(grpcRest).toEqual(kafkaRest);
    expect(grpcRow.reward_processed_env).toBe(kafkaRow.reward_processed_env);
  });

  // Implementation note 2's exhaustive ordering matrix, beyond the numbered TCs above.
  describe.each(orderedPairs())('ordering matrix: %s then %s (same id)', (first, second) => {
    it('exactly one row, first writer wins', async () => {
      const fixture = buildCanonicalFixtureEntry(TENANT_ID);
      await sendViaChannel(first, fixture);
      await sendViaChannel(second, fixture);

      expect(await countRows(fixture.id)).toBe(1);
      const row = await fetchRow(fixture.id);
      expect(row.ingestion_channel).toBe(first);
      expectRowMatchesFixture(row, fixture, first);
    });
  });

  // Each permutation is wrapped in a single-element outer array — `describe.each` spreads an
  // array-of-arrays as positional callback arguments, so without this wrapping each individual
  // channel would be passed as its own argument instead of the whole ordering as one.
  describe.each(allTriplePermutations().map((order) => [order]))(
    'ordering matrix: full triple %j (same id)',
    (order: IngestionChannel[]) => {
      it('exactly one row, first writer wins', async () => {
        const fixture = buildCanonicalFixtureEntry(TENANT_ID);
        for (const channel of order) {
          await sendViaChannel(channel, fixture);
        }

        expect(await countRows(fixture.id)).toBe(1);
        const row = await fetchRow(fixture.id);
        expect(row.ingestion_channel).toBe(order[0]);
        expectRowMatchesFixture(row, fixture, order[0]);
      });
    },
  );

  describe.each(CHANNELS)('ordering matrix: %s sending the same id twice in a row', (channel) => {
    it('exactly one row, no error on either send', async () => {
      const fixture = buildCanonicalFixtureEntry(TENANT_ID);
      await sendViaChannel(channel, fixture);
      await sendViaChannel(channel, fixture);

      expect(await countRows(fixture.id)).toBe(1);
      const row = await fetchRow(fixture.id);
      expect(row.ingestion_channel).toBe(channel);
    });
  });
});
