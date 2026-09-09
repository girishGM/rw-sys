/**
 * T-RR-062 — Verification step 3: "Seed a GLOBAL row with primary_channel='GRPC', run one outbox
 * cycle against a local gRPC test server" — real Postgres (root `CLAUDE.md`) throughout, a real
 * `@grpc/grpc-js` mock reward-tracking-service (same convention `reward-tracking-grpc.client.spec.ts`
 * already establishes), and the real `OutboxPublisherService`/`RewardTrackingOutboxRepository`/
 * `DispatchChannelResolverService` classes — no fakes on the actual dispatch path.
 *
 * Seeds a **tenant-scoped `GLOBAL`-level** row (`scope_level='GLOBAL', scope_ref_code=NULL,
 * tenant_id=<this suite's own random tenant>`), not the real shared `tenant_id IS NULL` `GLOBAL`
 * row every other environment resolves to by default — the identical "tenant-specific wins over
 * tenant-agnostic at the same scope level" mechanism `dispatch-channel-resolver.spec.ts`'s own TC-5
 * already proves, applied here so this suite can exercise a real `GRPC`-primary resolution without
 * ever mutating the one row every other real-DB dispatch test in this service implicitly depends on.
 */
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { Pool } from 'pg';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { createMigrationConnection } from '@/database/migration-connection';
import type { Config } from '@/config/config.schema';
import {
  EncryptionService,
  loadEncryptionKeyMaterial,
} from '@/modules/encryption/encryption.service';
import { RewardTrackingOutboxRepository } from '@/modules/dispatch/reward-tracking-outbox.repository';
import { DispatchChannelConfigRepository } from '@/modules/dispatch/dispatch-channel-config.repository';
import { DispatchChannelConfigCache } from '@/modules/dispatch/dispatch-channel-config.cache';
import { DispatchChannelResolverService } from '@/modules/dispatch/dispatch-channel-resolver.service';
import { OutboxPublisherService } from '@/modules/dispatch/outbox-publisher.service';
import { RewardTrackingKafkaProducerClient } from '@/modules/dispatch/reward-tracking-kafka-producer.client';
import { RewardTrackingRestClient } from '@/modules/dispatch/reward-tracking-rest.client';
import { RewardTrackingGrpcClient } from '@/modules/dispatch/reward-tracking-grpc.client';
import { RewardTrackingDispatchRetryRepository } from '@/modules/dispatch/reward-tracking-dispatch-retry.repository';
import { DispatchMetricsService } from '@/modules/dispatch/dispatch-metrics.service';
import type { DispatchServiceConfigResolver } from '@/modules/dispatch/dispatch.config';
import { insertEntry } from './fixtures/reward-redemption-entry.fixture';

const TENANT_ID = 970_000 + Math.floor(Math.random() * 29_999);

function realDbConfigService(): ConfigService<Config, true> {
  const values: Partial<Config> = {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: Number(process.env.DB_PORT),
    DB_NAME: process.env.DB_NAME,
    DB_SSL: process.env.DB_SSL === 'true',
    DB_APP_USERNAME: process.env.DB_APP_USERNAME,
    DB_APP_PASSWORD: process.env.DB_APP_PASSWORD,
  } as Partial<Config>;
  return {
    get: ((key: keyof Config) => values[key]) as ConfigService<Config, true>['get'],
  } as ConfigService<Config, true>;
}

function newAppPool(): Pool {
  return new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_APP_USERNAME,
    password: process.env.DB_APP_PASSWORD,
  });
}

function protoPath(): string {
  return join(__dirname, '..', '..', 'proto', 'reward_tracking_dispatch.proto');
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
    rewardtracking: {
      ingest: { v1: { RewardTrackingIngestService: { service: grpc.ServiceDefinition } } };
    };
  };
  return proto.rewardtracking.ingest.v1.RewardTrackingIngestService.service;
}

interface MockServer {
  server: grpc.Server;
  port: number;
  received: Record<string, unknown>[];
}

function startMockServer(): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    const received: Record<string, unknown>[] = [];
    const server = new grpc.Server();
    server.addService(loadServiceDefinition(), {
      IngestRewardTrackingEvent: (
        call: grpc.ServerUnaryCall<Record<string, unknown>, { status: string }>,
        callback: grpc.sendUnaryData<{ status: string }>,
      ) => {
        received.push(call.request);
        callback(null, { status: 'applied' });
      },
    } as unknown as grpc.UntypedServiceImplementation);
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ server, port, received });
    });
  });
}

function stopMockServer(server: grpc.Server): Promise<void> {
  return new Promise((resolve) => server.tryShutdown(() => resolve()));
}

/**
 * `findPendingBatch`'s real `ORDER BY created_at ASC LIMIT $1` has no tenant filter
 * (`reward-tracking-outbox.repository.ts`'s own header — genuine, intentional production
 * behaviour, T-RR-070) — on this shared, real dev Postgres instance, other specs' own stray
 * `PENDING` rows number in the thousands. Simply widening this suite's own `batchSize` to cover
 * all of them (T-RR-070's own fix for a *read-only* presence assertion) is unsafe **here**: unlike
 * a plain `findPendingBatch` read, this suite's own `OutboxPublisherService.runOnce()` would
 * actually *attempt real dispatch* on every row it fetches — sweeping thousands of unrelated,
 * long-stray rows through real Kafka/REST/gRPC calls this suite has no business making, mutating
 * shared state far outside its own `TENANT_ID`, and risking the exact multi-minute hang observed
 * while first authoring this file (reproduced: this test never returned within a 120s wall-clock
 * timeout with a table-covering batch size).
 *
 * The fix: a thin `findPendingBatch` override, scoped to only this suite's own tenant, delegating
 * every other method straight through to the real repository — so `markPublished`/
 * `incrementAttempts`/`markFailed` still write real rows via real SQL, but `OutboxPublisherService`
 * never sees, and therefore never attempts to dispatch, a row this suite didn't itself enqueue.
 */
function scopedToOwnTenant(
  repository: RewardTrackingOutboxRepository,
  tenantId: number,
): RewardTrackingOutboxRepository {
  return new Proxy(repository, {
    get(target, prop, receiver) {
      if (prop === 'findPendingBatch') {
        return async (batchSize: number) => {
          const rows = await target.findPendingBatch(batchSize);
          return rows.filter((row) => row.tenantId === tenantId);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe('T-RR-062 Verification step 3 — real Postgres + real local gRPC server, GRPC as the resolved primary channel', () => {
  let migrationDb: Sequelize;
  let appPool: Pool;
  let mock: MockServer;
  let outboxRepository: RewardTrackingOutboxRepository;
  let encryption: EncryptionService;
  let resolver: DispatchChannelResolverService;
  let grpcClient: RewardTrackingGrpcClient;
  let kafkaProducer: RewardTrackingKafkaProducerClient;
  let restClient: RewardTrackingRestClient;
  let retryRepository: RewardTrackingDispatchRetryRepository;
  let configResolver: DispatchServiceConfigResolver;

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
    appPool = newAppPool();
    mock = await startMockServer();

    // Tenant-scoped GLOBAL row — see this file's own header for why this, not the real shared
    // GLOBAL row, is seeded.
    await migrationDb.query(
      `INSERT INTO reward_redemption.dispatch_channel_config
         (scope_level, scope_ref_code, tenant_id, kafka_enabled, rest_enabled, grpc_enabled,
          primary_channel, fallback_channel)
       VALUES ('GLOBAL', NULL, :tenantId, true, true, true, 'GRPC', 'REST')`,
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );

    outboxRepository = new RewardTrackingOutboxRepository(realDbConfigService(), appPool);
    const dispatchRepo = new DispatchChannelConfigRepository(realDbConfigService(), appPool);
    const fakeServiceConfigCache = {
      resolve: jest.fn().mockResolvedValue(0), // TTL 0 — this suite never relies on caching.
    };
    const cache = new DispatchChannelConfigCache(
      dispatchRepo,
      fakeServiceConfigCache as unknown as ConstructorParameters<
        typeof DispatchChannelConfigCache
      >[1],
    );
    resolver = new DispatchChannelResolverService(cache);
    encryption = new EncryptionService(loadEncryptionKeyMaterial());
    grpcClient = new RewardTrackingGrpcClient({
      host: '127.0.0.1',
      port: mock.port,
      timeoutMs: 3_000,
    });
    kafkaProducer = { publish: jest.fn() } as unknown as RewardTrackingKafkaProducerClient;
    restClient = { dispatch: jest.fn() } as unknown as RewardTrackingRestClient;
    retryRepository = { create: jest.fn() } as unknown as RewardTrackingDispatchRetryRepository;
    configResolver = {
      resolve: jest.fn(async (key: string) => {
        if (key === 'dispatch.kafka.attemptsBeforeFallback') {
          return 3;
        }
        throw new Error(`unexpected service_config key "${key}"`);
      }),
    } as unknown as DispatchServiceConfigResolver;
  });

  afterAll(async () => {
    await migrationDb.query(
      `DELETE FROM reward_redemption.reward_tracking_dispatch_outbox
         WHERE reward_entry_id IN (
           SELECT id FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenantId
         )`,
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await migrationDb.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await migrationDb.query(
      'DELETE FROM reward_redemption.dispatch_channel_config WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await migrationDb.close();
    // `outboxRepository`/`dispatchRepo` share this one `appPool` instance (passed explicitly to
    // both) — ending it once, via either repository's own `onModuleDestroy()`, is correct for
    // both; calling `appPool.end()` again afterward would double-end the same pool.
    await outboxRepository.onModuleDestroy();
    grpcClient.onModuleDestroy();
    await stopMockServer(mock.server);
  });

  it('a PENDING row resolved to GRPC reaches PUBLISHED via the real local gRPC server, with a payload shape matching the Kafka/REST one field-for-field', async () => {
    const entry = await insertEntry(migrationDb, TENANT_ID, {
      tracker_code: 'TRK-GRPC-LIVE',
      tracker_component_code: 'COMP-GRPC-LIVE',
      merchant_code: 'MERCH-GRPC-LIVE',
      // The fixture's own default (`ciphertext-placeholder`) is not real AES-GCM ciphertext —
      // `OutboxPublisherService.processRow` decrypts this at the point of publish (R8), so it must
      // be real ciphertext produced by the exact `EncryptionService` instance this suite's own
      // `publisher` was built with.
      customer_id_encrypted: encryption.encrypt('CUST-GRPC-LIVE'),
    });
    const client = await appPool.connect();
    let outboxId: string;
    try {
      await client.query('BEGIN');
      const inserted = await outboxRepository.enqueue(client, entry);
      await client.query('COMMIT');
      outboxId = inserted.id;
    } finally {
      client.release();
    }

    // Sized dynamically (this file's own `scopedToOwnTenant` header) so the one real SELECT
    // `findPendingBatch` issues actually reaches this suite's own just-enqueued row no matter how
    // many other stray `PENDING` rows this shared, real dev Postgres table currently holds — safe
    // here specifically because `scopedToOwnTenant` filters the result down to this suite's own
    // `TENANT_ID` *before* `OutboxPublisherService` ever sees it, so only this one row is actually
    // dispatched.
    const [{ count }] = await migrationDb.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM reward_redemption.reward_tracking_dispatch_outbox WHERE status = 'PENDING'",
      { type: QueryTypes.SELECT },
    );
    const publisher = new OutboxPublisherService(
      scopedToOwnTenant(outboxRepository, TENANT_ID),
      resolver,
      encryption,
      kafkaProducer,
      new DispatchMetricsService(),
      configResolver,
      restClient,
      retryRepository,
      Number(count) + 10,
      false,
      grpcClient,
    );
    await publisher.runOnce();

    const [row] = await migrationDb.query<{ status: string }>(
      'SELECT status FROM reward_redemption.reward_tracking_dispatch_outbox WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id: outboxId } },
    );
    expect(row.status).toBe('PUBLISHED');

    expect(mock.received).toHaveLength(1);
    const wireMessage = mock.received[0];
    // Same field set every Kafka/REST message carries (`toRewardTrackingMessage`'s own shape),
    // proto3's "empty means absent" convention substituted for `null` at the wire level (this
    // client's own header) — proves the three channels carry the same information end to end.
    expect(wireMessage.rewardEntryId).toBe(entry.id);
    expect(wireMessage.customerId).toBe('CUST-GRPC-LIVE');
    expect(wireMessage.trackerCode).toBe('TRK-GRPC-LIVE');
    expect(wireMessage.trackerComponentCode).toBe('COMP-GRPC-LIVE');
    expect(wireMessage.merchantCode).toBe('MERCH-GRPC-LIVE');
    expect(wireMessage.campaignCode).toBe(entry.campaign_code);
    expect(wireMessage.rewardCode).toBe(entry.reward_code);
    expect(wireMessage.correlationId).toBe(entry.correlation_id);
    // Never the encrypted form on the wire (R8).
    expect(wireMessage).not.toHaveProperty('customerIdEncrypted');
  });
});
