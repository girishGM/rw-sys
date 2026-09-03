/**
 * T-RAP-041. Shared harness for this task's own full-pipeline e2e specs
 * (`full-pipeline.e2e-spec.ts` / `full-pipeline-multi-instance.e2e-spec.ts`) — nothing here is
 * production code.
 *
 * **What "one instance" means in this file.** `05-PROCESSING-PIPELINE.md`/`ARCHITECTURE.md` §6
 * describe this service as several independently-deployable processes (its own gRPC ingress,
 * `src/grpc/grpc-server.main.ts`; its own Kafka ingress, `src/messaging/ingest/activity-ingest-
 * consumer.main.ts`; a processing worker + dispatch poller + invalidation watcher, none of which
 * has its own dedicated `*.main.ts` yet — Wave 3's own tasks left them "not wired into `AppModule`",
 * same convention every module header in `src/modules/{processing,dispatch,invalidation}/**` cites).
 * `startInstance()` below bundles exactly those pieces into one composition unit per call: a real
 * `GrpcMicroserviceRootModule` (real mTLS, its own ephemeral CA/port), a real
 * `IngestConsumerRootModule` (real kafkajs consumer, joining the one shared, real consumer group
 * every production instance joins), and a real application context combining `ProcessingModule` +
 * `DispatchModule` + `InvalidationModule` (real claim worker, real outbox publisher, real watch
 * stream — each its own DI container, each independently bootstrapping its own
 * `CampaignConfigCacheService` from the same mock portal / same DB snapshot, exactly as three
 * separate OS processes would). Two calls to `startInstance()` against the same mock portal/real
 * Postgres/real Redpanda is this file's own stand-in for "two instances (two processes)"
 * (T-RAP-041's own implementation note 4) — same deliberate, documented simplification
 * `activity-ingest.consumer.e2e-spec.ts`'s own header already establishes for this project
 * ("two separate application contexts ... functionally identical from [the transport]'s own point
 * of view" — extended here across three transports/roles instead of one).
 *
 * **Deviation, flagged for the reviewer**: `AGENT-PROTOCOL.md` R2/R6/R7's actual guarantees (the
 * advisory-lock/row-lock/unique-index chain, idempotency-before-fan-out) are already proven, one
 * mechanism at a time, by each owning task's own unit/integration specs (`rule-evaluation.spec.ts`,
 * `cap-enforcement.spec.ts`, `activity-ingest.consumer.e2e-spec.ts`'s own TC-4, etc.) — this file's
 * job (`T-RAP-041`'s own Scope "Out": "unit-level coverage ... this task is specifically about
 * proving the *integration*") is to prove the same properties hold once every one of those pieces
 * runs together, for real, at once. It deliberately does not re-derive rule-expression/cap-matching
 * edge cases already covered elsewhere.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { ConfigModule } from '@/config/config.module';
import { ProcessingModule } from '@/modules/processing/processing.module';
import { ActivityLogClaimWorker } from '@/modules/processing/activity-log-claim.worker';
import { DispatchModule } from '@/modules/dispatch/dispatch.module';
import { OutboxPublisherService } from '@/modules/dispatch/outbox-publisher.service';
import { REWARD_ENTRY_CREATED_TOPIC } from '@/modules/reward-entry/reward-entry-outbox.repository';
import { InvalidationModule } from '@/modules/invalidation/invalidation.module';
import { WatchStreamConsumer } from '@/modules/invalidation/watch-stream.consumer';
import { CampaignConfigCacheService } from '@/modules/campaign-cache/campaign-config-cache.service';
import type {
  BoundRewardProto,
  BoundRuleProto,
  CampaignCapProto,
  CampaignConfigListProto,
  CampaignConfigProto,
  ConfigChangeEventProto,
} from '@/modules/campaign-cache/campaign-config.client';
import { createGrpcMicroservice } from '@/grpc/grpc-server.main';
import { createIngestConsumerContext } from '@/messaging/ingest/activity-ingest-consumer.main';
import { ActivityIngestConsumer } from '@/messaging/ingest/activity-ingest.consumer';
import { ACTIVITY_INGEST_TOPIC } from '@/messaging/ingest/ingest.config';
import {
  acquireIngestConsumerGroupReaderLease,
  type IngestConsumerGroupReaderLease,
} from './kafka-shared-consumer-group-lock';
import { WRITER_LOCK_ACQUIRE_TIMEOUT_MS } from './ingest-consumer-writer-lock-budget';
import { TestCertAuthority, type IssuedCertificate } from '../grpc/support/test-cert-authority';
import {
  createTestClient,
  callSubmitActivity,
  type ActivityIngestServiceTestClient,
} from '../grpc/support/test-grpc-client';

export const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:9093')
  .split(',')
  .map((broker) => broker.trim())
  .filter(Boolean);

// -------------------------------------------------------------------------------------------
// Generic helpers
// -------------------------------------------------------------------------------------------

export function getFreePort(): Promise<number> {
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

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 300,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    }
    await wait(intervalMs);
  }
}

export function buildTestSequelize(): Sequelize {
  return new Sequelize({
    dialect: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    username: process.env.DB_APP_USERNAME,
    password: process.env.DB_APP_PASSWORD,
    logging: false,
    pool: { max: 20 },
  });
}

/** Deletes every row this file's own writes could have produced for one tenant — children before
 * parents: `reward_dispatch_retry`/`reward_entry_outbox` both FK onto `reward_entry`, and
 * `customer_tracker_component_progress.last_activity_log_id` FKs onto `activity_logs` (so that
 * table must be cleared before `activity_logs` itself, not after — `01-DATABASE.md` §4). */
export async function cleanupTenant(sequelize: Sequelize, tenantId: number): Promise<void> {
  await sequelize.query(
    `DELETE FROM realtime_activity_processing.reward_dispatch_retry
      WHERE reward_entry_id IN (
        SELECT id FROM realtime_activity_processing.reward_entry WHERE tenant_id = :tenantId
      )`,
    { type: QueryTypes.RAW, replacements: { tenantId } },
  );
  await sequelize.query(
    `DELETE FROM realtime_activity_processing.reward_entry_outbox
      WHERE reward_entry_id IN (
        SELECT id FROM realtime_activity_processing.reward_entry WHERE tenant_id = :tenantId
      )`,
    { type: QueryTypes.RAW, replacements: { tenantId } },
  );
  for (const table of [
    'reward_entry',
    'customer_tracker_component_progress',
    'customer_tracker_status',
    'activity_logs',
    'budget_consumption',
    'customer_reward_limit_consumption',
    'activity_external_code_map',
    'campaign_config_snapshot',
  ]) {
    await sequelize.query(
      `DELETE FROM realtime_activity_processing.${table} WHERE tenant_id = :tenantId`,
      { type: QueryTypes.RAW, replacements: { tenantId } },
    );
  }
}

// -------------------------------------------------------------------------------------------
// Mock portal — same field-for-field discipline `campaign-config-cache.e2e-spec.ts` (T-RAP-010) /
// `watch-stream.consumer.e2e-spec.ts` (T-RAP-011) already established, extended with a mutable,
// broadcastable, multi-tenant state so this file's own instances can share one mock portal server.
// -------------------------------------------------------------------------------------------

function campaignConfigProtoPath(): string {
  return join(__dirname, '..', '..', 'proto', 'campaign_config.proto');
}

function loadCampaignConfigServiceDefinition(): grpc.ServiceDefinition {
  const packageDefinition = protoLoader.loadSync(campaignConfigProtoPath(), {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    rewardportal: {
      config: { v1: { CampaignConfigService: { service: grpc.ServiceDefinition } } };
    };
  };
  return proto.rewardportal.config.v1.CampaignConfigService.service;
}

export interface MockPortal {
  server: grpc.Server;
  port: number;
  /** Replaces the full campaign list for one tenant (e.g. a status flip / etag bump) — visible to
   * the next `ListActiveCampaigns`/`GetCampaignConfig` call immediately. */
  setCampaigns(tenantId: number, campaigns: CampaignConfigProto[]): void;
  /** Pushes one `ConfigChangeEvent` to every currently-open `WatchCampaignConfig` call for this
   * tenant — the real "every open stream gets every event" broadcast property
   * (`04-CACHE-INVALIDATION.md` §1), not a per-consumer-group delivery. */
  broadcast(tenantId: number, event: ConfigChangeEventProto): void;
  openWatchCount(tenantId: number): number;
  stop(): Promise<void>;
}

function unimplemented(callback: grpc.sendUnaryData<unknown>): void {
  callback({
    name: 'Unimplemented',
    message: 'not used by T-RAP-041',
    code: grpc.status.UNIMPLEMENTED,
  });
}

export async function startMockPortal(): Promise<MockPortal> {
  const campaignsByTenant = new Map<number, CampaignConfigProto[]>();
  const watchCallsByTenant = new Map<
    number,
    grpc.ServerWritableStream<{ tenantId: number }, ConfigChangeEventProto>[]
  >();

  const handlers: grpc.UntypedServiceImplementation = {
    listActiveCampaigns: (
      call: grpc.ServerUnaryCall<{ tenantId: number }, CampaignConfigListProto>,
      callback: grpc.sendUnaryData<CampaignConfigListProto>,
    ) => {
      const campaigns = campaignsByTenant.get(call.request.tenantId) ?? [];
      callback(null, {
        campaigns,
        servedAt: new Date().toISOString(),
        sectionsReturned: [],
        sectionsOmitted: [],
      });
    },
    getCampaignConfig: (
      call: grpc.ServerUnaryCall<{ tenantId: number; campaignCode: string }, CampaignConfigProto>,
      callback: grpc.sendUnaryData<CampaignConfigProto>,
    ) => {
      const campaigns = campaignsByTenant.get(call.request.tenantId) ?? [];
      const found = campaigns.find((c) => c.campaignCode === call.request.campaignCode);
      if (!found) {
        callback({ name: 'NotFound', message: 'campaign not found', code: grpc.status.NOT_FOUND });
        return;
      }
      callback(null, found);
    },
    watchCampaignConfig: (
      call: grpc.ServerWritableStream<{ tenantId: number }, ConfigChangeEventProto>,
    ) => {
      const tenantId = call.request.tenantId;
      const calls = watchCallsByTenant.get(tenantId) ?? [];
      calls.push(call);
      watchCallsByTenant.set(tenantId, calls);
      call.on('cancelled', () => {
        watchCallsByTenant.set(
          tenantId,
          (watchCallsByTenant.get(tenantId) ?? []).filter((c) => c !== call),
        );
        call.end();
      });
    },
    resolveRuleVersion: (_call: unknown, callback: grpc.sendUnaryData<unknown>) =>
      unimplemented(callback),
    resolveRewardVersion: (_call: unknown, callback: grpc.sendUnaryData<unknown>) =>
      unimplemented(callback),
    getBudgetStatus: (_call: unknown, callback: grpc.sendUnaryData<unknown>) =>
      unimplemented(callback),
  };

  const server = new grpc.Server();
  server.addService(loadCampaignConfigServiceDefinition(), handlers);
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, boundPort) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(boundPort);
    });
  });

  return {
    server,
    port,
    setCampaigns(tenantId, campaigns) {
      campaignsByTenant.set(tenantId, campaigns);
    },
    broadcast(tenantId, event) {
      for (const call of watchCallsByTenant.get(tenantId) ?? []) {
        call.write(event);
      }
    },
    openWatchCount(tenantId) {
      return (watchCallsByTenant.get(tenantId) ?? []).length;
    },
    stop() {
      return new Promise((resolve) => server.tryShutdown(() => resolve()));
    },
  };
}

// -------------------------------------------------------------------------------------------
// Campaign/reward/cap fixture builders
// -------------------------------------------------------------------------------------------

export interface CampaignSpec {
  tenantId: number;
  campaignCode: string;
  campaignId?: number;
  trackerCode?: string;
  componentCode?: string;
  activityCode?: string;
  status?: string;
  rules?: BoundRuleProto[];
  rewards?: BoundRewardProto[];
  caps?: CampaignCapProto[];
  etag?: string;
  configHash?: string;
}

export interface BuiltCampaign {
  payload: CampaignConfigProto;
  componentId: number;
  trackerId: number;
}

/** The same deterministic `(trackerId, componentId, activityId)` derivation `buildCampaign` uses
 * internally, exposed so a caller can build a `BoundRewardProto`/`CampaignCapProto` bound to this
 * campaign's own component *before* calling `buildCampaign` — `buildCampaign`'s own `rewards`/
 * `caps` are inputs, not outputs, so they can't be derived from its own return value. */
export function deriveComponentId(tenantId: number, campaignId?: number): number {
  return (campaignId ?? tenantId) * 100 + 2;
}

export function buildCampaign(spec: CampaignSpec): BuiltCampaign {
  const campaignId = spec.campaignId ?? spec.tenantId;
  const trackerId = campaignId * 100 + 1;
  const componentId = deriveComponentId(spec.tenantId, spec.campaignId);
  const activityId = campaignId * 100 + 3;
  const payload: CampaignConfigProto = {
    campaignId,
    campaignCode: spec.campaignCode,
    tenantId: spec.tenantId,
    countryId: 1,
    status: spec.status ?? 'active',
    startDate: '2020-01-01T00:00:00.000Z',
    endDate: '2030-01-01T00:00:00.000Z',
    budget: { amount: '1000000.0000', currency: 'MYR' },
    maxParticipants: 1_000_000,
    merchants: [
      {
        merchantId: 1,
        merchantCode: 'MERCH1',
        name: 'T-RAP-041 e2e merchant',
        status: 'active',
        activities: [
          {
            activityId,
            activityCode: spec.activityCode ?? 'PURCHASE',
            name: 'Purchase',
            externalCodes: [],
          },
        ],
      },
    ],
    trackers: [
      {
        trackerId,
        trackerCode: spec.trackerCode ?? 'TRK1',
        name: 'T-RAP-041 e2e tracker',
        completionLogic: 'all',
        completionThreshold: 1,
        status: 'active',
        components: [
          {
            componentId,
            componentCode: spec.componentCode ?? 'COMP1',
            name: 'T-RAP-041 e2e component',
            activityId,
            sequenceOrder: 1,
            isMandatory: true,
            status: 'active',
          },
        ],
      },
    ],
    rules: spec.rules ?? [],
    rewards: spec.rewards ?? [],
    etag: spec.etag ?? 'etag-1',
    configHash: spec.configHash ?? 'hash-1',
    notModified: false,
    servedAt: new Date().toISOString(),
    caps: spec.caps ?? [],
    sectionsReturned: ['BASIC', 'MERCHANTS', 'TRACKERS', 'RULES', 'REWARDS', 'CAPS'],
    sectionsOmitted: [],
  };
  return { payload, componentId, trackerId };
}

export function buildComponentReward(
  componentId: number,
  overrides: Partial<BoundRewardProto> = {},
): BoundRewardProto {
  return {
    rewardId: componentId + 5000,
    rewardVersionId: 1,
    versionNo: 1,
    systemCode: `RWD-${componentId}`,
    rewardType: 'cashback',
    deliveryMode: 'wallet',
    policiesJson: JSON.stringify({ fixedAmount: '5.00' }),
    unitType: 'currency',
    unitCode: 'MYR',
    level: 'component',
    refId: componentId,
    status: 'active',
    ...overrides,
  };
}

export function buildCampaignBudgetCap(
  overrides: Partial<CampaignCapProto> = {},
): CampaignCapProto {
  return {
    capClass: 'budget',
    scopeLevel: 'campaign',
    scopeRefId: 0,
    periodType: 'lifetime',
    periodValue: 0,
    windowStartTime: '',
    windowEndTime: '',
    periodTimezone: '',
    unitType: 'currency',
    unitCode: 'MYR',
    rewardType: '',
    maxTotalAmount: '25.00',
    maxOccurrences: 0,
    maxCustomers: 0,
    onBreach: 'reject',
    warnAtPercent: 0,
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------
// Ingestion request/message builders
// -------------------------------------------------------------------------------------------

export function grpcActivityRequest(
  customerId: string,
  activityEventId: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    customerId,
    customerIdType: 'INTERNAL_ID',
    activityPerformedDate: '2026-09-01T10:15:30Z',
    activityCode: 'PURCHASE',
    activityType: 'TRANSACTION',
    activityCategory: 'RETAIL',
    activityValue: '100.0000',
    activityValueUnit: 'MYR',
    channel: 'WEB',
    activityPerformedEnv: 'PROD',
    activityName: 'Online purchase',
    activityEventId,
    ...overrides,
  };
}

export function kafkaActivityMessage(
  tenantId: number,
  customerId: string,
  activityEventId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tenantId,
    customerId,
    customerIdType: 'INTERNAL_ID',
    activityPerformedDate: '2026-09-01T10:15:30Z',
    activityCode: 'PURCHASE',
    activityType: 'TRANSACTION',
    activityCategory: 'RETAIL',
    activityValue: '100.0000',
    activityValueUnit: 'MYR',
    channel: 'WEB',
    activityPerformedEnv: 'PROD',
    activityName: 'Online purchase',
    activityEventId,
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------
// One "instance" — real gRPC ingress + real Kafka ingress + real processing/dispatch/invalidation
// worker bundle, all pointed at the same real Postgres / real Redpanda / one shared mock portal.
// -------------------------------------------------------------------------------------------

/** `ProcessingModule` (claim worker, autostarts by default — no override needed/provided) +
 * `DispatchModule` (outbox publisher — started explicitly below, `OUTBOX_PUBLISHER_AUTOSTART`
 * defaults `false` under `NODE_ENV=test`) + `InvalidationModule` (watch stream — started
 * explicitly only by the TC-6 cache-invalidation spec). Combining all three into one application
 * context (rather than three) is this file's own choice, not a production topology claim — nothing
 * stops a real deployment from splitting them further; what matters for this task is that each is
 * the real class, doing real work, against the real DB. */
@Module({ imports: [ConfigModule, ProcessingModule, DispatchModule, InvalidationModule] })
class WorkerRootModule {}

export interface Instance {
  tenantId: number;
  grpcAddress: string;
  grpcClient: ActivityIngestServiceTestClient;
  cache: CampaignConfigCacheService;
  claimWorker: ActivityLogClaimWorker;
  outboxPublisher: OutboxPublisherService;
  watchConsumer: WatchStreamConsumer;
  submitGrpc(request: Record<string, string>): ReturnType<typeof callSubmitActivity>;
  close(): Promise<void>;
}

export interface StartInstanceOptions {
  tenantId: number;
  mockPortalPort: number;
  grpcIdentity: string;
  aesKeyB64: string;
  hmacKeyB64: string;
}

// T-RAP-056 retry 2 (was retry 1's flat 240_000, guessed independently of the writer's own real
// hold time). A second independent review measured `activity-ingest.consumer.e2e-spec.ts`'s own
// writer role legitimately holding this lock for 502s in one clean-baseline run — nearly 2.1x
// retry 1's own reader budget — and reproduced two real reader-lease acquire timeouts as a direct
// result (`full-pipeline.e2e-spec.ts` TC-1/TC-2/TC-7, `full-pipeline-multi-instance.e2e-spec.ts`
// TC-3). Retry 1's own fairness fix (FIFO queueing) guarantees a fairly-queued reader is never
// starved by a same-process repeat re-acquirer; it does NOT bound how long a legitimately queued
// reader may need to wait for a slow-but-alive holder to finish real work.
//
// T-RAP-056 (this retry): retry 2 derived this budget from `MAX_REALISTIC_LOCK_HOLD_MS` directly
// (imported from the lock module) while `activity-ingest.consumer.e2e-spec.ts`'s own
// `WRITER_LOCK_ACQUIRE_TIMEOUT_MS` separately hardcoded the SAME numeric value as its own literal —
// two independently-written numbers that only happened to agree, not an actual link. A third
// independent review's architect decision called this out by name: "make the reader's wait
// proportional to / derived from the writer's own configured budget so the two can never drift out
// of sync again... do not simply raise both numbers without linking them." This budget is now
// derived directly FROM `WRITER_LOCK_ACQUIRE_TIMEOUT_MS` itself (imported from
// `ingest-consumer-writer-lock-budget.ts`, the one shared module both this file and the ingest-
// consumer spec file now import — see that module's own doc comment for the full history), not from
// a same-valued sibling constant:
//   - `WRITER_LOCK_ACQUIRE_TIMEOUT_MS` (900_000, itself `MAX_REALISTIC_LOCK_HOLD_MS`): the dominant
//     case — waiting behind `activity-ingest.consumer.e2e-spec.ts`'s own entire suite.
//   - `OTHER_READER_FILE_MAX_HOLD_MS` (200_000, below): the other, smaller case this constant must
//     ALSO cover — arriving to find the OTHER full-pipeline file's own current TC already holding
//     the lock, with the writer already queued next behind it (queue order sums, regardless of
//     which of the two participants happens to be holding vs. next in line).
//   - +20_000 poll/heartbeat overhead margin.
// This is now a real import chain (reader -> writer's own budget -> the lock module's own
// real-arithmetic constant), not two numbers that separately happen to trace back to a shared
// upstream value — `lock-budget-invariant.spec.ts` asserts the resulting relationship directly so a
// future change to either side that reintroduces the asymmetry fails fast, deterministically, without
// needing a multi-minute real e2e run to notice. Kept well below both full-pipeline files' own
// `jest.setTimeout` (each file imports this exact constant to derive its own value — see each file's
// own comment) so a genuine timeout here still surfaces as this lock's own clear, attributable error
// (queue position included) rather than an opaque, generic Jest "Exceeded timeout".
const OTHER_READER_FILE_MAX_HOLD_MS = 200_000;
export const READER_LEASE_ACQUIRE_TIMEOUT_MS =
  WRITER_LOCK_ACQUIRE_TIMEOUT_MS + OTHER_READER_FILE_MAX_HOLD_MS + 20_000;

export async function startInstance(options: StartInstanceOptions): Promise<Instance> {
  // T-RAP-056 / T-RAP-041 (retry 1). This instance's own Kafka ingress AND its own worker bundle
  // (`ActivityLogClaimWorker` et al.) run for this whole function's lifetime, held exclusively (see
  // `kafka-shared-consumer-group-lock.ts`'s own header — including why a non-exclusive reader/writer
  // split was tried and reverted) from before the Kafka join until `close()` has fully torn
  // everything down, so this instance's own real consumer(s)/worker bundle can never be counted by
  // `activity-ingest.consumer.e2e-spec.ts`'s own exact-membership assertion, and can never race a
  // DIFFERENT full-pipeline file's own worker bundle (different `FIELD_ENCRYPTION_*` keys) to claim
  // the same shared `activity_logs` table. Reentrant within THIS process, so
  // `full-pipeline-multi-instance.e2e-spec.ts`'s own two, sequential, single-test `startInstance()`
  // calls never block on each other.
  const readerLease: IngestConsumerGroupReaderLease = await acquireIngestConsumerGroupReaderLease(
    READER_LEASE_ACQUIRE_TIMEOUT_MS,
  );
  try {
    process.env.PORTAL_CONFIG_TENANT_IDS = String(options.tenantId);
    process.env.PORTAL_GRPC_HOST = '127.0.0.1';
    process.env.PORTAL_GRPC_PORT = String(options.mockPortalPort);
    process.env.PORTAL_GRPC_TIMEOUT_MS = '5000';
    delete process.env.PORTAL_GRPC_TLS_CA_PATH;
    delete process.env.PORTAL_GRPC_TLS_CERT_PATH;
    delete process.env.PORTAL_GRPC_TLS_KEY_PATH;
    process.env.FIELD_ENCRYPTION_AES_KEY = options.aesKeyB64;
    process.env.FIELD_ENCRYPTION_HMAC_KEY = options.hmacKeyB64;

    // --- gRPC ingress (real mTLS, own ephemeral CA/port) ---
    const ca = TestCertAuthority.build();
    const grpcPort = await getFreePort();
    process.env.GRPC_SERVER_PORT = String(grpcPort);
    process.env.GRPC_SERVER_TLS_CA_PATH = ca.caCertPath;
    process.env.GRPC_SERVER_TLS_CERT_PATH = ca.serverCertPath;
    process.env.GRPC_SERVER_TLS_KEY_PATH = ca.serverKeyPath;
    process.env.GRPC_SERVER_ALLOWED_IDENTITIES = `${options.grpcIdentity}:${options.tenantId}`;
    delete process.env.GRPC_SERVER_ENABLED;

    const grpcApp = await createGrpcMicroservice();
    if (grpcApp === null) {
      throw new Error('expected createGrpcMicroservice() to return a microservice in this harness');
    }
    await grpcApp.listen();
    const grpcAddress = `127.0.0.1:${grpcPort}`;
    const clientCert: IssuedCertificate = ca.issueClientCert(options.grpcIdentity);
    const credentials = grpc.credentials.createSsl(
      readFileSync(ca.caCertPath),
      readFileSync(clientCert.keyPath),
      readFileSync(clientCert.certPath),
    );
    const grpcClient = createTestClient(grpcAddress, credentials);

    // --- Kafka ingress (real kafkajs consumer, shared consumer group) ---
    const kafkaAppCtx: INestApplicationContext | null = await createIngestConsumerContext();
    if (kafkaAppCtx === null) {
      throw new Error('expected createIngestConsumerContext() to return a context in this harness');
    }
    const kafkaConsumer = kafkaAppCtx.get(ActivityIngestConsumer);
    await kafkaConsumer.start();

    // --- Processing + dispatch + invalidation worker bundle ---
    const workerApp: INestApplicationContext = await NestFactory.createApplicationContext(
      WorkerRootModule,
      { logger: false },
    );
    const cache = workerApp.get(CampaignConfigCacheService);
    const claimWorker = workerApp.get(ActivityLogClaimWorker);
    const outboxPublisher = workerApp.get(OutboxPublisherService);
    outboxPublisher.start();
    const watchConsumer = workerApp.get(WatchStreamConsumer);

    let closed = false;
    return {
      tenantId: options.tenantId,
      grpcAddress,
      grpcClient,
      cache,
      claimWorker,
      outboxPublisher,
      watchConsumer,
      submitGrpc: (request) => callSubmitActivity(grpcClient, request as never),
      async close() {
        if (closed) {
          return;
        }
        closed = true;
        try {
          grpcClient.close();
          await kafkaConsumer.stop();
          await Promise.all([grpcApp.close(), kafkaAppCtx.close(), workerApp.close()]);
          ca.cleanup();
        } finally {
          readerLease.release();
        }
      },
    };
  } catch (error) {
    // Never leaves this instance's own reader lease held when `startInstance()` itself fails partway
    // through startup — otherwise a single failed instance start would leave a stale reader marker
    // that could delay the writer's own next acquire until that marker's heartbeat goes stale.
    readerLease.release();
    throw error;
  }
}

// -------------------------------------------------------------------------------------------
// Raw kafkajs helpers this file's own tests use directly (submitting "via Kafka", watching the
// reward-dispatch topic) — no Nest module involved, same convention
// `activity-ingest.consumer.e2e-spec.ts` already established for this project.
// -------------------------------------------------------------------------------------------

export function buildKafkaClient(clientId: string): Kafka {
  return new Kafka({ clientId, brokers: KAFKA_BROKERS, logLevel: logLevel.NOTHING });
}

export async function buildActivityIngestProducer(clientId: string): Promise<Producer> {
  const kafka = buildKafkaClient(clientId);
  const producer = kafka.producer();
  await producer.connect();
  return producer;
}

export async function publishActivity(
  producer: Producer,
  key: string,
  message: Record<string, unknown>,
): Promise<void> {
  await producer.send({
    topic: ACTIVITY_INGEST_TOPIC,
    messages: [{ key, value: JSON.stringify(message) }],
  });
}

export interface RewardCreatedWatcher {
  messages: Array<{ key: string | null; value: Record<string, unknown> | null }>;
  stop(): Promise<void>;
}

export async function watchRewardCreatedTopic(groupId: string): Promise<RewardCreatedWatcher> {
  const kafka = buildKafkaClient(`rap-e2e-reward-watcher-${groupId}`);
  const consumer = kafka.consumer({ groupId });
  const messages: Array<{ key: string | null; value: Record<string, unknown> | null }> = [];
  await consumer.connect();
  await consumer.subscribe({ topic: REWARD_ENTRY_CREATED_TOPIC, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      messages.push({
        key: message.key ? message.key.toString() : null,
        value: message.value
          ? (JSON.parse(message.value.toString()) as Record<string, unknown>)
          : null,
      });
    },
  });
  return {
    messages,
    stop: () => consumer.disconnect(),
  };
}

// Re-exported so spec files don't need a second import line for the one type they name directly.
export type { ActivityIngestServiceTestClient };
