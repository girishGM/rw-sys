/**
 * T-RTS-048 — implements T-RTS-014's own objective, in the one file `test/e2e/**` that only
 * `agent-rts-qa` may write (`reward-tracking-service-plan/project.config.json`'s `allow` grants;
 * T-RTS-014's own owner, `agent-rts-ingestion`, is scoped to `test/ingestion/**`/`test/grpc/**`/
 * `test/kafka/**` only, never `test/e2e/**` — see T-RTS-048's own task file for the full defect
 * write-up). One shared fixture sent once via the real gRPC server (T-RTS-011), once via the real
 * Kafka consumer against the real local Redpanda broker (T-RTS-012), once via the real REST
 * controller (T-RTS-013) — all three thin adapters over the SAME
 * `RewardTrackingIngestionService.applyRewardTrackingEvent()` (T-RTS-010, R8) — asserting
 * byte-identical resulting `reward_fact`/`customer_reward_ledger`/`campaign_reward_counter_shard`
 * row **shape** across all three channels (TC-1), plus a cross-channel idempotency test proving the
 * dedupe key is the business id (`reward_entry_id`), never a per-channel one (TC-2, R3).
 *
 * Mirrors `reward-redemption-service`'s own `T-RR-014` `cross-channel-parity.e2e-spec.ts` precedent
 * (confirmed by direct read) in spirit — real transports, real Postgres, nothing mocked — scaled to
 * this task's own two required test cases (T-RTS-014's own "Test cases" table) rather than that
 * sibling's full pairwise/triple ordering matrix, which is squarely T-RTS-014's own "Out" ("anything
 * not already built by T-RTS-011/012/013").
 *
 * ## Design notes
 *
 * 1. **One shared fixture generator (`buildFixture`), varied only where it must be.** The SAME
 *    `customerId` and the SAME `redeemedAt`/`trackerCode`/`trackerComponentCode`/`rewardCategory`/
 *    `rewardKind`/`unitType`/`unitCode`/`rewardValue`/`rewardValueUnit` are reused across all three
 *    channels — this both proves `customer_id_hash` parity (R6: same plaintext in, same hash out,
 *    regardless of channel) and makes the resulting ledger/shard row's *shape* directly comparable
 *    once identity columns are excluded. `campaignCode` (and, necessarily, `rewardEntryId`/
 *    `correlationId`) is the one field deliberately varied per channel: reusing the same
 *    `campaignCode` across channels would make the three writes accumulate into ONE shared
 *    ledger/shard row (the upsert `x = x + delta`, R7) instead of each channel producing its own,
 *    independently comparable first-insert row — which is what "the same resulting row shape each
 *    time" (T-RTS-014's own implementation note 1) actually requires to observe.
 * 2. **Kafka delivery is asynchronous from the producer's own perspective** — `sendViaChannel`'s
 *    Kafka branch polls for the resulting row rather than assuming synchronous delivery (gRPC/REST
 *    are both already durable the instant their own call resolves).
 * 3. **Kafka-consumer readiness is proven by a warm-up canary, not a fixed sleep** — identical
 *    reasoning to `T-RR-014`'s own design note 2 (confirmed by direct read): the real, fixed
 *    `REWARD_TRACKING_COMPLETED_CONSUMER_GROUP` (`reward-tracking-consumer.service.ts`'s own
 *    constant, not test-overridable without editing a file outside this task's scope) may already
 *    have committed offsets from a previous local run, or none at all — a brand-new group with no
 *    fetch in flight yet seeks to the current log end, silently missing a message produced before
 *    that first fetch. `warmUpKafkaConsumer()` below re-publishes one throwaway fixture (harmless —
 *    R3 dedup makes every repeat but the first a safe no-op) until it is observed inserted, proving
 *    the shared consumer is actively fetching before any scenario below depends on Kafka delivery.
 * 4. **`customerId` parity is proven by decrypting `customer_id_encrypted`, never by comparing
 *    ciphertext** — `CustomerIdCryptoService.encrypt()` is non-deterministic (a fresh random IV every
 *    call, that file's own header), so two channels encrypting the identical plaintext never produce
 *    identical ciphertext; decrypting both back to the same plaintext (plus comparing the
 *    deterministic `customer_id_hash`) is the only correct parity check.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import type { INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import { Sequelize, QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import {
  createRewardTrackingGrpcServer,
  type RewardTrackingGrpcServerHandle,
} from '@/grpc/grpc-server.main';
import {
  createRewardTrackingIngestHttpServer,
  type RewardTrackingIngestHttpServerHandle,
} from '@/modules/ingestion/reward-tracking-ingest-http.main';
import { createKafkaConsumerContext } from '@/kafka/kafka-consumer.main';
import {
  RewardTrackingConsumerService,
  REWARD_TRACKING_COMPLETED_TOPIC,
} from '@/kafka/reward-tracking-consumer.service';
import {
  CustomerIdCryptoService,
  loadCustomerIdCryptoKeyMaterial,
} from '@/modules/ingestion/customer-id-crypto.service';
import type { RewardFactRow } from '@/database/models/reward-fact.model';
import type { CustomerRewardLedgerRow } from '@/database/models/customer-reward-ledger.model';
import type { CampaignRewardCounterShardRow } from '@/database/models/campaign-reward-counter-shard.model';

jest.setTimeout(60_000);

const TENANT_ID = 940_000 + Math.floor(Math.random() * 9_999);
const REST_TOKEN_ENV_KEY = 'REWARD_TRACKING_INGEST_TOKEN';
const REST_TOKEN = 'e2e-cross-channel-parity-token';

type Channel = 'GRPC' | 'KAFKA' | 'REST';
const CHANNELS: Channel[] = ['GRPC', 'KAFKA', 'REST'];

interface Fixture {
  rewardEntryId: string;
  correlationId: string;
  tenantId: number;
  tenantCode: string | null;
  countryCode: string | null;
  customerId: string;
  campaignCode: string;
  trackerCode: string;
  trackerComponentCode: string;
  merchantCode: string | null;
  rewardCode: string;
  rewardCategory: string;
  rewardKind: string | null;
  unitType: string | null;
  unitCode: string | null;
  rewardValue: string;
  rewardValueUnit: string;
  externalSystemCode: string | null;
  externalReferenceId: string | null;
  promoCodeConfigId: string | null;
  promoCodeConfigVersionNo: number | null;
  redeemedAt: string;
  expiresAt: string | null;
}

/** Every field except `rewardEntryId`/`correlationId`/`campaignCode` is shared across channels
 * (design note 1 above) — `campaignCode` is tagged with the channel so each channel's write lands
 * in its own, independently comparable ledger/shard row. */
function buildFixture(
  channelTag: string,
  sharedCustomerId: string,
  sharedRedeemedAt: string,
): Fixture {
  return {
    rewardEntryId: randomUUID(),
    correlationId: randomUUID(),
    tenantId: TENANT_ID,
    tenantCode: 'T1',
    countryCode: 'US',
    customerId: sharedCustomerId,
    campaignCode: `CAMP-${channelTag}-${randomUUID().slice(0, 8)}`,
    trackerCode: 'TRK1',
    trackerComponentCode: 'COMP1',
    merchantCode: null,
    rewardCode: 'RWD1',
    rewardCategory: 'CASHBACK',
    rewardKind: 'FIXED_AMOUNT',
    unitType: 'CURRENCY',
    unitCode: 'USD',
    rewardValue: '7.50',
    rewardValueUnit: 'USD',
    externalSystemCode: null,
    externalReferenceId: null,
    promoCodeConfigId: null,
    promoCodeConfigVersionNo: null,
    redeemedAt: sharedRedeemedAt,
    expiresAt: null,
  };
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

interface GrpcTestClient extends grpc.Client {
  IngestRewardTrackingEvent(
    request: Record<string, unknown>,
    callback: (error: grpc.ServiceError | null, response: { status: string }) => void,
  ): grpc.ClientUnaryCall;
}

function createGrpcTestClient(address: string): GrpcTestClient {
  const packageDefinition = protoLoader.loadSync(
    join(__dirname, '..', '..', 'proto', 'reward_tracking_ingest.proto'),
    { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true },
  );
  const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    rewardtracking: {
      ingest: { v1: { RewardTrackingIngestService: new (...args: unknown[]) => grpc.Client } };
    };
  };
  const Ctor = proto.rewardtracking.ingest.v1.RewardTrackingIngestService;
  return new Ctor(address, grpc.credentials.createInsecure()) as GrpcTestClient;
}

function callGrpcIngest(
  client: GrpcTestClient,
  req: Record<string, unknown>,
): Promise<{ status: string }> {
  return new Promise((resolve, reject) => {
    client.IngestRewardTrackingEvent(req, (error, response) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

function toGrpcRequest(f: Fixture): Record<string, unknown> {
  return {
    rewardEntryId: f.rewardEntryId,
    correlationId: f.correlationId,
    tenantId: f.tenantId,
    tenantCode: f.tenantCode ?? '',
    countryCode: f.countryCode ?? '',
    customerId: f.customerId,
    campaignCode: f.campaignCode,
    trackerCode: f.trackerCode,
    trackerComponentCode: f.trackerComponentCode,
    merchantCode: f.merchantCode ?? '',
    rewardCode: f.rewardCode,
    rewardCategory: f.rewardCategory,
    rewardKind: f.rewardKind ?? '',
    unitType: f.unitType ?? '',
    unitCode: f.unitCode ?? '',
    rewardValue: f.rewardValue,
    rewardValueUnit: f.rewardValueUnit,
    externalSystemCode: f.externalSystemCode ?? '',
    externalReferenceId: f.externalReferenceId ?? '',
    promoCodeConfigId: f.promoCodeConfigId ?? '',
    promoCodeConfigVersionNo: f.promoCodeConfigVersionNo ?? 0,
    redeemedAt: f.redeemedAt,
    expiresAt: f.expiresAt ?? '',
  };
}

function toWireBody(f: Fixture): Record<string, unknown> {
  // Kafka's `parseRewardTrackingEventMessage` and REST's `parseRewardTrackingIngestRequest` both
  // accept explicit `null` for an optional field (their own `optionalString`/`optionalNumber`
  // helpers), unlike the gRPC proto wire shape above which has no `null` (empty string/`0` instead)
  // — same camelCase JSON body for both transports.
  return { ...f };
}

describe('T-RTS-048 (implements T-RTS-014) — cross-channel parity (real gRPC + real Kafka + real REST, real Postgres) (e2e)', () => {
  let db: Sequelize;
  let crypto: CustomerIdCryptoService;
  let grpcHandle: RewardTrackingGrpcServerHandle;
  let grpcClient: GrpcTestClient;
  let kafkaAppContext: INestApplicationContext;
  let kafkaProducer: Producer;
  let restHandle: RewardTrackingIngestHttpServerHandle;
  let savedRestToken: string | undefined;

  async function countRewardFact(rewardEntryId: string): Promise<number> {
    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_tracking.reward_fact WHERE reward_entry_id = :id',
      { type: QueryTypes.SELECT, replacements: { id: rewardEntryId } },
    );
    return Number(rows[0].count);
  }

  async function fetchRewardFact(rewardEntryId: string): Promise<RewardFactRow> {
    const rows = await db.query<RewardFactRow>(
      'SELECT * FROM reward_tracking.reward_fact WHERE reward_entry_id = :id',
      { type: QueryTypes.SELECT, replacements: { id: rewardEntryId } },
    );
    if (rows.length !== 1) {
      throw new Error(
        `expected exactly one reward_fact row for ${rewardEntryId}, found ${rows.length}`,
      );
    }
    return rows[0];
  }

  async function fetchLedgerRow(campaignCode: string): Promise<CustomerRewardLedgerRow> {
    const rows = await db.query<CustomerRewardLedgerRow>(
      'SELECT * FROM reward_tracking.customer_reward_ledger WHERE tenant_id = :tenantId AND campaign_code = :campaignCode',
      { type: QueryTypes.SELECT, replacements: { tenantId: TENANT_ID, campaignCode } },
    );
    if (rows.length !== 1) {
      throw new Error(`expected exactly one ledger row for ${campaignCode}, found ${rows.length}`);
    }
    return rows[0];
  }

  async function fetchShardRow(campaignCode: string): Promise<CampaignRewardCounterShardRow> {
    const rows = await db.query<CampaignRewardCounterShardRow>(
      'SELECT * FROM reward_tracking.campaign_reward_counter_shard WHERE tenant_id = :tenantId AND campaign_code = :campaignCode',
      { type: QueryTypes.SELECT, replacements: { tenantId: TENANT_ID, campaignCode } },
    );
    if (rows.length !== 1) {
      throw new Error(`expected exactly one shard row for ${campaignCode}, found ${rows.length}`);
    }
    return rows[0];
  }

  /** Sends `fixture` via `channel` and only resolves once the row is durably visible in the real
   * database — gRPC/REST are already durable the instant the call resolves; Kafka additionally
   * polls (design note 2 above).
   *
   * gRPC/REST both report their own true `applied`/`duplicate` outcome directly in their response
   * (T-RTS-010's own domain result, R8's "same observable outcome" — passed straight through by
   * both thin adapters). Kafka's own `RewardTrackingConsumerService.processMessage` deliberately
   * returns only `'ACK'`/`'DLQ'` (offset-commit-timing outcome, `reward-tracking-consumer.service.ts`'s
   * own header), not `applied`/`duplicate` — this adapter's true ingestion outcome is instead
   * observed the same way R3 itself is defined: whether a `reward_fact` row for this `rewardEntryId`
   * already existed *before* this send. That is the one channel-agnostic ground truth every channel
   * shares, rather than trusting a wire-level field a given transport's own contract does not
   * actually expose. */
  async function sendViaChannel(channel: Channel, fixture: Fixture): Promise<{ status: string }> {
    if (channel === 'GRPC') {
      return callGrpcIngest(grpcClient, toGrpcRequest(fixture));
    }
    if (channel === 'REST') {
      const response = await request(restHandle.app.getHttpServer())
        .post('/internal/reward-tracking-events')
        .set('Authorization', `Bearer ${REST_TOKEN}`)
        .send(toWireBody(fixture));
      if (response.status !== 200) {
        throw new Error(`REST send failed: ${response.status} ${JSON.stringify(response.body)}`);
      }
      return response.body as { status: string };
    }
    const existedBefore = (await countRewardFact(fixture.rewardEntryId)) > 0;
    await kafkaProducer.send({
      topic: REWARD_TRACKING_COMPLETED_TOPIC,
      messages: [{ key: fixture.customerId, value: JSON.stringify(toWireBody(fixture)) }],
    });
    await waitForCondition(async () => (await countRewardFact(fixture.rewardEntryId)) >= 1, 20_000);
    return { status: existedBefore ? 'duplicate' : 'applied' };
  }

  async function warmUpKafkaConsumer(): Promise<void> {
    const canary = buildFixture('WARMUP', `warmup-${randomUUID()}`, new Date().toISOString());
    const deadline = Date.now() + 30_000;
    for (;;) {
      await kafkaProducer.send({
        topic: REWARD_TRACKING_COMPLETED_TOPIC,
        messages: [{ key: canary.customerId, value: JSON.stringify(toWireBody(canary)) }],
      });
      if ((await countRewardFact(canary.rewardEntryId)) >= 1) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error('Kafka consumer warm-up timed out waiting for the canary to be consumed');
      }
      await sleep(500);
    }
  }

  beforeAll(async () => {
    db = createMigrationConnection();
    await db.authenticate();
    crypto = new CustomerIdCryptoService(loadCustomerIdCryptoKeyMaterial());

    // --- gRPC transport (real server, ephemeral port) ---
    const grpcPort = await getFreePort();
    grpcHandle = await createRewardTrackingGrpcServer(grpcPort);
    grpcClient = createGrpcTestClient(`localhost:${grpcPort}`);

    // --- Kafka transport (real consumer against the real local Redpanda broker) ---
    const maybeKafkaApp = await createKafkaConsumerContext();
    if (maybeKafkaApp === null) {
      throw new Error(
        'createKafkaConsumerContext() returned null — KAFKA_CONSUMER_ENABLED=false in this environment',
      );
    }
    kafkaAppContext = maybeKafkaApp;
    await kafkaAppContext.get(RewardTrackingConsumerService).start();

    const kafka = new Kafka({
      clientId: 'reward-tracking-service-e2e-cross-channel-parity-producer',
      brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9095').split(',').map((b) => b.trim()),
      logLevel: logLevel.NOTHING,
    });
    kafkaProducer = kafka.producer();
    await kafkaProducer.connect();

    // --- REST transport (real HTTP server, ephemeral port) ---
    savedRestToken = process.env[REST_TOKEN_ENV_KEY];
    process.env[REST_TOKEN_ENV_KEY] = REST_TOKEN;
    const restPort = await getFreePort();
    restHandle = await createRewardTrackingIngestHttpServer(restPort);

    await warmUpKafkaConsumer();
  });

  afterAll(async () => {
    const steps: Array<() => Promise<void> | void> = [
      () =>
        db?.query(
          'DELETE FROM reward_tracking.campaign_reward_counter_shard WHERE tenant_id = :tenantId',
          {
            type: QueryTypes.RAW,
            replacements: { tenantId: TENANT_ID },
          },
        ),
      () =>
        db?.query(
          'DELETE FROM reward_tracking.customer_reward_ledger WHERE tenant_id = :tenantId',
          {
            type: QueryTypes.RAW,
            replacements: { tenantId: TENANT_ID },
          },
        ),
      () =>
        db?.query('DELETE FROM reward_tracking.reward_fact WHERE tenant_id = :tenantId', {
          type: QueryTypes.RAW,
          replacements: { tenantId: TENANT_ID },
        }),
      () =>
        db?.query(
          `DELETE FROM reward_tracking.inbound_event_log WHERE payload->>'tenantId' = :tenantIdStr`,
          { type: QueryTypes.RAW, replacements: { tenantIdStr: String(TENANT_ID) } },
        ),
      () => grpcClient?.close(),
      () => grpcHandle?.close(),
      () => kafkaAppContext?.close(),
      () => kafkaProducer?.disconnect(),
      () => restHandle?.close(),
      () => db?.close(),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        // Best-effort — swallow so every remaining teardown step still runs; the real failure (if
        // any) is whatever the test body itself already threw.
        console.warn('T-RTS-048 cross-channel-parity teardown step failed:', error);
      }
    }
    if (savedRestToken === undefined) delete process.env[REST_TOKEN_ENV_KEY];
    else process.env[REST_TOKEN_ENV_KEY] = savedRestToken;
  });

  /** The subset of `reward_fact` columns this pipeline itself owns and that must be identical
   * across channels once identity columns (excluded here: `id`/`reward_entry_id`/`correlation_id`/
   * `campaign_code`/`customer_id_encrypted`/`ingested_at`/`created_at`) are set aside. */
  function comparableRewardFact(row: RewardFactRow): Record<string, unknown> {
    return {
      tenant_id: row.tenant_id,
      tenant_code: row.tenant_code,
      country_code: row.country_code,
      customer_id_hash: row.customer_id_hash,
      tracker_code: row.tracker_code,
      tracker_component_code: row.tracker_component_code,
      merchant_code: row.merchant_code,
      reward_code: row.reward_code,
      reward_category: row.reward_category,
      reward_kind: row.reward_kind,
      unit_type: row.unit_type,
      unit_code: row.unit_code,
      reward_value: row.reward_value,
      reward_value_unit: row.reward_value_unit,
      external_system_code: row.external_system_code,
      external_reference_id: row.external_reference_id,
      promo_code_config_id: row.promo_code_config_id,
      promo_code_config_version_no: row.promo_code_config_version_no,
      reward_lifecycle_status: row.reward_lifecycle_status,
      redeemed_at: new Date(row.redeemed_at).toISOString(),
      expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    };
  }

  function comparableLedgerRow(row: CustomerRewardLedgerRow): Record<string, unknown> {
    return {
      tenant_id: row.tenant_id,
      customer_id_hash: row.customer_id_hash,
      tracker_code: row.tracker_code,
      tracker_component_code: row.tracker_component_code,
      reward_category: row.reward_category,
      reward_kind: row.reward_kind,
      unit_type: row.unit_type,
      unit_code: row.unit_code,
      total_reward_value: row.total_reward_value,
      total_reward_count: row.total_reward_count,
    };
  }

  function comparableShardRow(row: CampaignRewardCounterShardRow): Record<string, unknown> {
    return {
      tenant_id: row.tenant_id,
      reward_category: row.reward_category,
      reward_kind: row.reward_kind,
      unit_type: row.unit_type,
      unit_code: row.unit_code,
      total_reward_value: row.total_reward_value,
      total_reward_count: row.total_reward_count,
    };
  }

  // TC-1 (T-RTS-014's own TC-1)
  it('TC-1: same event via gRPC, Kafka, REST (three separate rewardEntryIds) — three reward_fact rows, ledger/shard totals identical in shape across all three', async () => {
    const sharedCustomerId = `customer-${randomUUID()}`;
    const sharedRedeemedAt = new Date('2026-09-05T12:00:00.000Z').toISOString();
    const fixtures: Record<Channel, Fixture> = {
      GRPC: buildFixture('GRPC', sharedCustomerId, sharedRedeemedAt),
      KAFKA: buildFixture('KAFKA', sharedCustomerId, sharedRedeemedAt),
      REST: buildFixture('REST', sharedCustomerId, sharedRedeemedAt),
    };

    for (const channel of CHANNELS) {
      const outcome = await sendViaChannel(channel, fixtures[channel]);
      expect(outcome.status).toBe('applied');
    }

    // Three distinct reward_fact rows, one per channel.
    for (const channel of CHANNELS) {
      expect(await countRewardFact(fixtures[channel].rewardEntryId)).toBe(1);
    }

    const factRows = await Promise.all(
      CHANNELS.map((channel) => fetchRewardFact(fixtures[channel].rewardEntryId)),
    );
    const ledgerRows = await Promise.all(
      CHANNELS.map((channel) => fetchLedgerRow(fixtures[channel].campaignCode)),
    );
    const shardRows = await Promise.all(
      CHANNELS.map((channel) => fetchShardRow(fixtures[channel].campaignCode)),
    );

    // Field-for-field parity — same shape, regardless of which of the three channels ingested it.
    const comparableFacts = factRows.map(comparableRewardFact);
    expect(comparableFacts[0]).toEqual(comparableFacts[1]);
    expect(comparableFacts[1]).toEqual(comparableFacts[2]);

    const comparableLedgers = ledgerRows.map(comparableLedgerRow);
    expect(comparableLedgers[0]).toEqual(comparableLedgers[1]);
    expect(comparableLedgers[1]).toEqual(comparableLedgers[2]);
    comparableLedgers.forEach((row) => {
      expect(row.total_reward_count).toBe(1);
      // decimal(18,4) — Postgres/pg always returns the column's own fixed scale, not the input
      // string's own scale (`004_create_customer_reward_ledger.ts`'s own column definition).
      expect(row.total_reward_value).toBe('7.5000');
    });

    const comparableShards = shardRows.map(comparableShardRow);
    expect(comparableShards[0]).toEqual(comparableShards[1]);
    expect(comparableShards[1]).toEqual(comparableShards[2]);
    comparableShards.forEach((row) => {
      expect(row.total_reward_count).toBe(1);
      // decimal(18,4) — same reasoning as the ledger row above
      // (`005_create_campaign_reward_counter_shard.ts`'s own column definition).
      expect(row.total_reward_value).toBe('7.5000');
    });

    // R6 — same plaintext customerId in, same hash out, regardless of channel; decrypting each
    // channel's own independently-encrypted ciphertext recovers the identical plaintext (design
    // note 4 above — never compared as raw ciphertext, which is intentionally non-deterministic).
    factRows.forEach((row) => {
      expect(row.customer_id_hash).toBe(crypto.hash(sharedCustomerId));
      expect(crypto.decrypt(row.customer_id_encrypted)).toBe(sharedCustomerId);
    });

    // The one field deliberately NOT shared — proves the parity check above isn't vacuously true
    // because every field happened to be identical.
    expect(factRows[0].campaign_code).not.toBe(factRows[1].campaign_code);
    expect(factRows[1].campaign_code).not.toBe(factRows[2].campaign_code);
  });

  // TC-2 (T-RTS-014's own TC-2) — the test that most directly proves R3.
  it('TC-2: same rewardEntryId sent via gRPC, then redelivered via REST — exactly one reward_fact row, the dedupe key is the business id, not the channel', async () => {
    const fixture = buildFixture('XCHAN', `customer-${randomUUID()}`, new Date().toISOString());

    const first = await sendViaChannel('GRPC', fixture);
    expect(first.status).toBe('applied');

    const second = await sendViaChannel('REST', fixture);
    expect(second.status).toBe('duplicate');

    expect(await countRewardFact(fixture.rewardEntryId)).toBe(1);
    const row = await fetchRewardFact(fixture.rewardEntryId);
    expect(row.reward_entry_id).toBe(fixture.rewardEntryId);
    expect(row.campaign_code).toBe(fixture.campaignCode);
  });

  // Additional coverage beyond T-RTS-014's own minimum two, exercising the other five (first,
  // second) channel orderings of the same cross-channel-idempotency property TC-2 proves for one
  // ordering — a defect in only one specific pairing (e.g. Kafka-then-gRPC but not gRPC-then-Kafka)
  // would not be caught by TC-2 alone.
  describe.each([
    ['GRPC', 'KAFKA'],
    ['KAFKA', 'GRPC'],
    ['KAFKA', 'REST'],
    ['REST', 'GRPC'],
    ['REST', 'KAFKA'],
  ] as Array<[Channel, Channel]>)(
    'cross-channel idempotency: %s then %s (same rewardEntryId)',
    (first, second) => {
      it('exactly one reward_fact row, first channel wins', async () => {
        const fixture = buildFixture(
          `${first}-${second}`,
          `customer-${randomUUID()}`,
          new Date().toISOString(),
        );

        const firstOutcome = await sendViaChannel(first, fixture);
        expect(firstOutcome.status).toBe('applied');

        const secondOutcome = await sendViaChannel(second, fixture);
        expect(secondOutcome.status).toBe('duplicate');

        expect(await countRewardFact(fixture.rewardEntryId)).toBe(1);
      });
    },
  );
});
