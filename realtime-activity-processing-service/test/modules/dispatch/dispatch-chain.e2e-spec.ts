/**
 * T-RAP-034. Verification step 2: "observe the dispatch chain fall through to gRPC fallback (with
 * a mock reward-redemption-service stub) then to the retry table when that's also unavailable ...
 * confirms the full three-tier fallback live, not just per-tier unit tests."
 *
 * This file automates that proof reproducibly (a genuinely unreachable Kafka broker — no server
 * bound on the target port at all — rather than requiring a human to physically stop the local
 * Redpanda container every run) against **real** collaborators throughout: a real Postgres
 * `reward_entry`/`reward_entry_outbox`/`reward_dispatch_retry` round trip (`rap_app` role), a real
 * `kafkajs` connection attempt (`RewardKafkaProducerClient`, real TCP connect-timeout failure, not
 * mocked), and a real `@grpc/grpc-js` mock server for the tier-2/tier-3 gRPC leg (same precedent
 * `reward-grpc-fallback.spec.ts`/`budget-breach-callback.spec.ts` already established). The
 * completion report separately records the literal "stop the local Redpanda container" manual
 * check this step also asks for.
 */
import 'reflect-metadata';
import { join } from 'node:path';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { ConfigService } from '@nestjs/config';
import { EncryptionService } from '@/modules/encryption/encryption.service';
import {
  ActivityLogsRepository,
  type FanOutRowInput,
} from '@/modules/activity-mapping/activity-logs.repository';
import type { ActivityLogRow } from '@/database/models/activity-log.model';
import { RewardEntryRepository } from '@/modules/reward-entry/reward-entry.repository';
import { RewardEntryOutboxRepository } from '@/modules/reward-entry/reward-entry-outbox.repository';
import { OutboxPublisherService } from '@/modules/dispatch/outbox-publisher.service';
import { RewardDispatchRetryWorker } from '@/modules/dispatch/reward-dispatch-retry.worker';
import { RewardDispatchRetryRepository } from '@/modules/dispatch/reward-dispatch-retry.repository';
import { RewardKafkaProducerClient } from '@/modules/dispatch/reward-kafka-producer.client';
import {
  RewardGrpcFallbackClient,
  type RewardEntryGrpcPayload,
} from '@/modules/dispatch/reward-grpc-fallback.client';
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

const TENANT_ID = 980_000 + Math.floor(Math.random() * 19_999);
const AES_KEY_B64 = Buffer.alloc(32, 11).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 13).toString('base64');
const encryption = new EncryptionService({
  aesKey: Buffer.from(AES_KEY_B64, 'base64'),
  hmacKey: Buffer.from(HMAC_KEY_B64, 'base64'),
});

/** No listener at all — a real, immediate "unreachable broker" for `RewardKafkaProducerClient`'s
 * own real `kafkajs` connect attempt (`connectionTimeout: 3_000`, `retry: { retries: 0 }`).
 * MANUAL_VERIFICATION_TEMP: overridable so this same file can be pointed at the real local
 * Redpanda broker (`.env.development`'s own `KAFKA_BROKERS`) while it is manually stopped, for
 * T-RAP-034's verification step 2 — reverted immediately after that one recorded run. */
const UNREACHABLE_KAFKA_BROKERS = process.env.MANUAL_KAFKA_BROKERS_OVERRIDE ?? '127.0.0.1:1';

function fakeConfigService(kafkaBrokers: string): ConfigService {
  return {
    get: (key: string) => (key === 'KAFKA_BROKERS' ? kafkaBrokers : undefined),
  } as unknown as ConfigService;
}

function protoPath(): string {
  return join(__dirname, '..', '..', '..', 'proto', 'reward_ingest.proto');
}

function loadServiceDefinition(): grpc.ServiceDefinition {
  const packageDefinition = protoLoader.loadSync(protoPath(), {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    rewardrap: { reward: { v1: { RewardIngestService: { service: grpc.ServiceDefinition } } } };
  };
  return proto.rewardrap.reward.v1.RewardIngestService.service;
}

/** A mock `reward-redemption-service` whose behaviour can be flipped mid-test (`failing` toggle)
 * — models "gRPC fallback then to the retry table when that's also unavailable" (fails), and this
 * same stub recovering on a later retry-table attempt (succeeds), without needing two servers. */
function startToggleableGrpcMock(): Promise<{
  server: grpc.Server;
  port: number;
  setFailing: (failing: boolean) => void;
  requests: RewardEntryGrpcPayload[];
}> {
  let failing = true;
  const requests: RewardEntryGrpcPayload[] = [];
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();
    server.addService(loadServiceDefinition(), {
      submitRewardEntry: (
        call: grpc.ServerUnaryCall<
          RewardEntryGrpcPayload,
          { rewardEntryId: string; status: string }
        >,
        callback: grpc.sendUnaryData<{ rewardEntryId: string; status: string }>,
      ) => {
        requests.push(call.request);
        if (failing) {
          callback(
            {
              code: grpc.status.UNAVAILABLE,
              message: 'redemption ledger unavailable',
            } as grpc.ServiceError,
            null,
          );
          return;
        }
        callback(null, { rewardEntryId: call.request.id, status: 'accepted' });
      },
    } as unknown as grpc.UntypedServiceImplementation);
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ server, port, setFailing: (value: boolean) => (failing = value), requests });
    });
  });
}

describe('Reward dispatch chain, live (real Postgres + real kafkajs connect attempt + real gRPC mock)', () => {
  let sequelize: Sequelize;
  let fanOutRepository: ActivityLogsRepository;
  let rewardEntryRepository: RewardEntryRepository;
  let rewardEntryOutboxRepository: RewardEntryOutboxRepository;
  let retryRepository: RewardDispatchRetryRepository;
  let grpcMock: Awaited<ReturnType<typeof startToggleableGrpcMock>>;

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
    rewardEntryRepository = new RewardEntryRepository(sequelize);
    rewardEntryOutboxRepository = new RewardEntryOutboxRepository(sequelize);
    retryRepository = new RewardDispatchRetryRepository(sequelize);
    grpcMock = await startToggleableGrpcMock();
  }, 20_000);

  afterAll(async () => {
    grpcMock.server.forceShutdown();
    await sequelize.query(
      `DELETE FROM realtime_activity_processing.reward_dispatch_retry
        WHERE reward_entry_id IN (
          SELECT id FROM realtime_activity_processing.reward_entry WHERE tenant_id = :tenantId
        )`,
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await sequelize.query(
      `DELETE FROM realtime_activity_processing.reward_entry_outbox
        WHERE reward_entry_id IN (
          SELECT id FROM realtime_activity_processing.reward_entry WHERE tenant_id = :tenantId
        )`,
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    for (const table of ['reward_entry', 'activity_logs']) {
      await sequelize.query(
        `DELETE FROM realtime_activity_processing.${table} WHERE tenant_id = :tenantId`,
        { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
      );
    }
    await sequelize.close();
  });

  function pendingRowInput(overrides: Partial<FanOutRowInput> = {}): FanOutRowInput {
    return {
      correlationId: '77777777-7777-4777-8777-777777777777',
      dedupKey: `dedup-${Math.random().toString(36).slice(2)}`,
      tenantId: TENANT_ID,
      customerIdEncrypted: encryption.encrypt('CUST-LIVE'),
      customerIdHash: 'a'.repeat(64),
      customerIdType: 'INTERNAL_ID',
      activityPerformedDate: new Date(),
      transactionType: null,
      activityCode: 'PURCHASE',
      activityType: 'TRANSACTION',
      activityCategory: 'RETAIL',
      activityValue: '10.0000',
      activityValueUnit: 'MYR',
      channel: 'WEB',
      activityPerformedEnv: 'PROD',
      activityName: 'Online purchase',
      campaignCode: 'CAMP_LIVE',
      trackerCode: 'TRK_LIVE',
      trackerComponentCode: 'COMP_LIVE',
      merchantCode: null,
      sourceTransport: 'GRPC',
      ...overrides,
    };
  }

  // T-RAP-034 retry 2/3 (review-flagged): same rationale as
  // `reward-entry.repository.spec.ts`'s own `insertAndClaim` (see its header comment in full for
  // both rejected intermediate attempts). Neither T-RAP-047's give-back fix (bump
  // `activity_reached_date` + `maxAttempts` 20 -> 300) nor a direct by-`id` claim alone survived
  // real full-suite `npm test` parallelism (both still measurably flaked). The fix that is
  // actually race-free: insert the row and claim it (flip it to `processing`) in the *same*
  // transaction, before it ever commits — Postgres never exposes an uncommitted row to another
  // session, so no concurrently-running suite's genuinely-global `claimNextPendingRow()` can ever
  // observe this row as `pending` at all.
  async function insertAndClaim(overrides: Partial<FanOutRowInput> = {}): Promise<ActivityLogRow> {
    const claimed = await sequelize.transaction(async (t) => {
      const [inserted] = await fanOutRepository.insertFanOutRows([pendingRowInput(overrides)], t);
      const rows = await sequelize.query<ActivityLogRow>(
        `UPDATE realtime_activity_processing.activity_logs
            SET status = 'processing', updated_at = now()
          WHERE id = :id
          RETURNING *`,
        { type: QueryTypes.SELECT, replacements: { id: inserted.id }, transaction: t },
      );
      return rows[0];
    });
    if (claimed === undefined) {
      throw new Error('Failed to claim the row this test just inserted');
    }
    return claimed;
  }

  it(
    'Kafka unreachable -> gRPC fallback also fails -> reward_dispatch_retry row created -> ' +
      'retry worker later resolves it once the mock reward-redemption-service recovers',
    async () => {
      grpcMock.setFailing(true);
      const metrics = new MetricsService();

      const activityRow = await insertAndClaim();
      const transaction = await sequelize.transaction();
      const rewardEntry = await rewardEntryRepository.insertForGrantedAssignment(transaction, {
        row: activityRow,
        rewardCode: 'RWD_LIVE',
        rewardCategory: 'cashback',
        rewardValue: '9.99',
        rewardValueUnit: 'MYR',
        completionCycle: 1,
        rewardEntryDate: new Date(),
      });
      const outboxRow = await rewardEntryOutboxRepository.insertPending(transaction, rewardEntry!);
      await transaction.commit();

      const unreachableKafkaProducer = new RewardKafkaProducerClient(
        fakeConfigService(UNREACHABLE_KAFKA_BROKERS),
      );
      const grpcClient = new RewardGrpcFallbackClient({
        host: '127.0.0.1',
        port: grpcMock.port,
        timeoutMs: 3000,
      });
      // Threshold 0: attempts (0) >= threshold (0) is true on the very first cycle, so this
      // exercises the gRPC leg immediately rather than waiting out a real Kafka connect-timeout
      // retry loop — the "Kafka unreachable" half is proven directly below instead.
      const outboxPublisher = new OutboxPublisherService(
        rewardEntryOutboxRepository,
        rewardEntryRepository,
        retryRepository,
        unreachableKafkaProducer,
        grpcClient,
        encryption,
        { getRewardDispatchMaxRetryAttempts: () => 0 },
        metrics,
        fakeLoggerFactory(),
        500,
        20,
        false,
      );

      // Prove the Kafka leg really is unreachable (real TCP/connect-timeout failure, not a stub).
      await expect(
        unreachableKafkaProducer.publish('reward.entry.created.v1', 'k', {}),
      ).rejects.toThrow();

      await outboxPublisher.runOnce({ rowIds: [outboxRow.id] });

      const afterFirstCycle = await rewardEntryRepository.findById(rewardEntry!.id);
      expect(afterFirstCycle?.dispatch_status).toBe('failed');
      expect(grpcMock.requests.length).toBeGreaterThanOrEqual(1);

      const retryRows = await retryRepository.findDueBatch(50);
      const retryRow = retryRows.find((r) => r.reward_entry_id === rewardEntry!.id);
      expect(retryRow).toBeDefined();

      // Recovery: the mock reward-redemption-service starts accepting again, the retry-table
      // worker's next due cycle resolves it.
      grpcMock.setFailing(false);
      const retryWorker = new RewardDispatchRetryWorker(
        retryRepository,
        rewardEntryRepository,
        unreachableKafkaProducer,
        grpcClient,
        encryption,
        { getRewardDispatchMaxRetryAttempts: () => 8 },
        metrics,
        fakeLoggerFactory(),
        2000,
        20,
        1000,
        60_000,
        false,
      );
      await retryWorker.runOnce();

      const resolvedRow = await sequelize.query<{ status: string }>(
        `SELECT status FROM realtime_activity_processing.reward_dispatch_retry WHERE id = :id`,
        { type: QueryTypes.SELECT, replacements: { id: retryRow!.id } },
      );
      expect(resolvedRow[0].status).toBe('resolved');

      const afterRecovery = await rewardEntryRepository.findById(rewardEntry!.id);
      expect(afterRecovery?.dispatch_status).toBe('dispatched');
      // T-RAP-059: the full three-tier chain live — tier 1/2 both failed for this row (no
      // increment), only tier 3 (retry-table) ever actually succeeds.
      expect(metrics.getCounterValue('reward_dispatch_tier_total', { tier: 'kafka' })).toBe(0);
      expect(metrics.getCounterValue('reward_dispatch_tier_total', { tier: 'grpc' })).toBe(0);
      expect(metrics.getCounterValue('reward_dispatch_tier_total', { tier: 'retry_table' })).toBe(
        1,
      );

      unreachableKafkaProducer.onModuleDestroy();
      grpcClient.onModuleDestroy();
    },
    20_000,
  );
});
