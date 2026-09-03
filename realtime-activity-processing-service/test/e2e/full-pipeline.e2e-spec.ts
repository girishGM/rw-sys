/**
 * T-RAP-041. Single-instance full-pipeline coverage — TC-1 (cross-transport parity), TC-2
 * (concurrent-duplicate simulation, single instance), TC-4 (budget-breach scenario, single
 * instance) and TC-7 (full happy path through to the progress API). See
 * `full-pipeline-test-helpers.ts`'s own header for what "one instance" means in this file and why.
 *
 * Two-instance coverage (TC-3, TC-5, TC-6) lives in `full-pipeline-multi-instance.e2e-spec.ts` —
 * kept in its own file so a routine single-instance run doesn't also pay the cost of standing up a
 * second full instance every time (same "kept separate so a normal run doesn't pay that cost every
 * time" precedent `progress-api-perf.e2e-spec.ts`'s own header already set for this project).
 *
 * Requires a running local Redpanda (`docker compose up -d redpanda`) and the real local Postgres
 * 16 server (root `CLAUDE.md`), already migrated — this suite is real infrastructure throughout, by
 * design (T-RAP-041's own Objective: "against real NestJS modules ... not mocks").
 *
 * Deviation from the task file's literal verification step 1 command (`npm run test:e2e`): no
 * `test:e2e` script exists in `package.json` (same gap `grpc-server.e2e-spec.ts`/
 * `activity-ingest.consumer.e2e-spec.ts` already document) — this project's single `testRegex`
 * already matches `.e2e-spec.ts` files under `test/`, so `npm test -- full-pipeline` runs both of
 * this task's own files. See this task's own completion report for the "run 3 times" evidence,
 * produced by running that filtered command three times in isolation (this file's own worker
 * bundle runs a real, globally-scoped `ActivityLogClaimWorker` against the whole
 * `realtime_activity_processing.activity_logs` table for the file's own lifetime — the same
 * accepted, already-documented full-parallel-`npm test` contamination risk `claim-worker.spec.ts`/
 * T-RAP-047/048/051 already carry, not a new category this task introduces).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import {
  EncryptionService,
  loadEncryptionKeyMaterial,
} from '@/modules/encryption/encryption.service';
import { ProgressApiRootModule } from '@/modules/progress-api/progress-api-server.main';
import {
  loadProgressApiAuthSecret,
  signProgressApiToken,
} from '@/modules/progress-api/progress-api-token';
import {
  buildActivityIngestProducer,
  buildCampaign,
  buildCampaignBudgetCap,
  buildComponentReward,
  buildTestSequelize,
  cleanupTenant,
  deriveComponentId,
  grpcActivityRequest,
  kafkaActivityMessage,
  publishActivity,
  READER_LEASE_ACQUIRE_TIMEOUT_MS,
  startInstance,
  startMockPortal,
  waitUntil,
  watchRewardCreatedTopic,
  type MockPortal,
  type RewardCreatedWatcher,
} from './full-pipeline-test-helpers';
import type { Producer } from 'kafkajs';

// T-RAP-056 retry 2 (was retry 1's flat 360_000). A second independent review measured a real
// writer hold of 502s and reproduced genuine reader-lease acquire timeouts in this file's own
// TC-1/TC-2/TC-7 as a direct result — retry 1's own `READER_LEASE_ACQUIRE_TIMEOUT_MS` (240_000) was
// smaller than the writer's own real worst-case hold, so no per-test budget built on top of it could
// have been safe no matter how it was derived. This file's own default is now IMPORTED
// `READER_LEASE_ACQUIRE_TIMEOUT_MS` (see that constant's own doc comment in
// `full-pipeline-test-helpers.ts` for the full writer-hold-aware arithmetic) plus this file's own
// heaviest single-TC real work once a lease is actually held (TC-7's own three sequential
// `waitUntil` stages, 60_000 + 60_000 + 30_000 = 150_000, plus generous overhead margin — 180_000)
// — an expression, not a re-guessed literal, so the two constants can never independently drift
// apart again the way retry 1's did. Every `it()` in this file now relies on this SAME shared
// default (no smaller per-test override survives this retry — see TC-2/TC-4's own history: a
// per-test override *smaller* than this value would silently truncate the very lock-wait budget
// every `startInstance()` call now legitimately needs). Only matters under real lock contention; a
// normal, uncontended run still finishes in well under a minute per TC.
jest.setTimeout(READER_LEASE_ACQUIRE_TIMEOUT_MS + 180_000);

const AES_KEY_B64 = Buffer.alloc(32, 21).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 22).toString('base64');
const AUTH_SECRET_B64 = Buffer.alloc(32, 23).toString('base64');

let nextTenantId = 950_000 + Math.floor(Math.random() * 40_000);
function freshTenantId(): number {
  nextTenantId += 1;
  return nextTenantId;
}

describe('T-RAP-041 — full pipeline, single instance (real gRPC + real Kafka + real processing/dispatch, real Postgres/Redpanda)', () => {
  let sequelize: Sequelize;
  let mockPortal: MockPortal;
  let producer: Producer;
  let progressApiApp: INestApplication;
  let encryption: EncryptionService;
  const usedTenantIds: number[] = [];

  beforeAll(async () => {
    process.env.FIELD_ENCRYPTION_AES_KEY = AES_KEY_B64;
    process.env.FIELD_ENCRYPTION_HMAC_KEY = HMAC_KEY_B64;
    process.env.PROGRESS_API_AUTH_SECRET = AUTH_SECRET_B64;

    sequelize = buildTestSequelize();
    await sequelize.authenticate();
    mockPortal = await startMockPortal();
    producer = await buildActivityIngestProducer('t-rap-041-producer');
    encryption = new EncryptionService(loadEncryptionKeyMaterial());

    const moduleRef = await Test.createTestingModule({
      imports: [ProgressApiRootModule],
    }).compile();
    progressApiApp = moduleRef.createNestApplication();
    await progressApiApp.init();
  });

  afterAll(async () => {
    for (const tenantId of usedTenantIds) {
      await cleanupTenant(sequelize, tenantId);
    }
    await producer.disconnect();
    await mockPortal.stop();
    await progressApiApp.close();
    await sequelize.close();
  });

  function reserveTenant(): number {
    const tenantId = freshTenantId();
    usedTenantIds.push(tenantId);
    return tenantId;
  }

  function progressToken(customerId: string, tenantId: number): string {
    return signProgressApiToken(
      { tenantId, customerId, exp: Math.floor(Date.now() / 1000) + 3600 },
      loadProgressApiAuthSecret(),
    );
  }

  async function processedRow(
    tenantId: number,
    dedupKey: string,
  ): Promise<
    Array<{
      id: string;
      status: string;
      comment: string | null;
      tracker_component_code: string;
      source_transport: string;
    }>
  > {
    return sequelize.query(
      `SELECT id, status, comment, tracker_component_code, source_transport
         FROM realtime_activity_processing.activity_logs
        WHERE tenant_id = :tenantId AND dedup_key = :dedupKey`,
      { type: QueryTypes.SELECT, replacements: { tenantId, dedupKey } },
    );
  }

  async function rewardEntriesFor(
    tenantId: number,
    campaignCode: string,
  ): Promise<
    Array<{ id: string; customer_id_hash: string; reward_value: string; dispatch_status: string }>
  > {
    return sequelize.query(
      `SELECT id, customer_id_hash, reward_value, dispatch_status
         FROM realtime_activity_processing.reward_entry
        WHERE tenant_id = :tenantId AND campaign_code = :campaignCode`,
      { type: QueryTypes.SELECT, replacements: { tenantId, campaignCode } },
    );
  }

  // TC-1 — verification step 1's own cross-transport-parity property.
  it('TC-1: the same logical activity, submitted via gRPC and via Kafka, produces structurally identical outcomes', async () => {
    const tenantId = reserveTenant();
    const componentId = deriveComponentId(tenantId);
    const { payload } = buildCampaign({
      tenantId,
      campaignCode: `CAMP-TC1-${tenantId}`,
      rewards: [buildComponentReward(componentId)],
    });
    mockPortal.setCampaigns(tenantId, [payload]);

    const instance = await startInstance({
      tenantId,
      mockPortalPort: mockPortal.port,
      grpcIdentity: `tc1-${tenantId}`,
      aesKeyB64: AES_KEY_B64,
      hmacKeyB64: HMAC_KEY_B64,
    });

    try {
      const custGrpc = `cust-tc1-grpc-${randomUUID()}`;
      const eventGrpc = `evt-tc1-grpc-${randomUUID()}`;
      const custKafka = `cust-tc1-kafka-${randomUUID()}`;
      const eventKafka = `evt-tc1-kafka-${randomUUID()}`;

      const grpcResponse = await instance.submitGrpc(grpcActivityRequest(custGrpc, eventGrpc));
      expect(grpcResponse.status).toBe('accepted');
      expect(grpcResponse.matchedTrackerComponents).toEqual([
        payload.trackers[0].components[0].componentCode,
      ]);

      await publishActivity(
        producer,
        custKafka,
        kafkaActivityMessage(tenantId, custKafka, eventKafka),
      );

      await waitUntil(async () => {
        const [grpcRow] = await processedRow(tenantId, eventGrpc);
        const [kafkaRow] = await processedRow(tenantId, eventKafka);
        return grpcRow?.status === 'processed' && kafkaRow?.status === 'processed';
      }, 60_000);

      const [grpcRow] = await processedRow(tenantId, eventGrpc);
      const [kafkaRow] = await processedRow(tenantId, eventKafka);

      expect(grpcRow.source_transport).toBe('GRPC');
      expect(kafkaRow.source_transport).toBe('KAFKA');
      // The shape of the outcome — tracker component matched, comment wording, reward count — is
      // identical across transports; only the transport tag itself and the identifiers differ.
      expect(grpcRow.tracker_component_code).toBe(kafkaRow.tracker_component_code);
      expect(grpcRow.comment).toBe(kafkaRow.comment);

      const rewards = await rewardEntriesFor(tenantId, payload.campaignCode);
      expect(rewards).toHaveLength(2);
      const hashGrpc = encryption.hash(custGrpc);
      const hashKafka = encryption.hash(custKafka);
      const rewardGrpc = rewards.find((r) => r.customer_id_hash === hashGrpc);
      const rewardKafka = rewards.find((r) => r.customer_id_hash === hashKafka);
      expect(rewardGrpc?.reward_value).toBe(rewardKafka?.reward_value);
    } finally {
      await instance.close();
    }
  });

  // TC-2 — concurrent-duplicate simulation, single instance, mixed transports.
  it('TC-2: the same activity fired concurrently from a mix of gRPC and Kafka callers produces exactly one outcome', async () => {
    const tenantId = reserveTenant();
    const componentId = deriveComponentId(tenantId);
    const { payload } = buildCampaign({
      tenantId,
      campaignCode: `CAMP-TC2-${tenantId}`,
      rewards: [buildComponentReward(componentId)],
    });
    mockPortal.setCampaigns(tenantId, [payload]);

    const instance = await startInstance({
      tenantId,
      mockPortalPort: mockPortal.port,
      grpcIdentity: `tc2-${tenantId}`,
      aesKeyB64: AES_KEY_B64,
      hmacKeyB64: HMAC_KEY_B64,
    });

    try {
      const customerId = `cust-tc2-${randomUUID()}`;
      const eventId = `evt-tc2-${randomUUID()}`;
      const request = grpcActivityRequest(customerId, eventId);
      const kafkaMessage = kafkaActivityMessage(tenantId, customerId, eventId);

      const results = await Promise.allSettled([
        instance.submitGrpc(request),
        instance.submitGrpc(request),
        publishActivity(producer, customerId, kafkaMessage),
        publishActivity(producer, customerId, kafkaMessage),
      ]);
      for (const result of results) {
        expect(result.status).toBe('fulfilled');
      }

      await waitUntil(async () => {
        const rows = await processedRow(tenantId, eventId);
        return rows.length === 1 && rows[0].status === 'processed';
      }, 60_000);

      const rows = await processedRow(tenantId, eventId);
      expect(rows).toHaveLength(1);

      const rewards = await rewardEntriesFor(tenantId, payload.campaignCode);
      expect(rewards).toHaveLength(1);

      // Secondary sanity check on the gRPC response contract itself, on top of the DB row-count
      // proof above: the two concurrent gRPC calls for the identical `dedupKey` must never *both*
      // report "accepted" — whichever of the four concurrent attempts (2 gRPC, 2 Kafka) actually
      // wins the race is not deterministic (real scheduling — a Kafka publish returns as soon as
      // the broker acks it, well before its own consumer round-trip completes, so either transport
      // can legitimately be the one that lands first), but a double-accept on the same dedupKey
      // from the same transport would be exactly the duplicate-processing bug this test exists to
      // catch.
      const grpcStatuses = results
        .slice(0, 2)
        .map((r) =>
          r.status === 'fulfilled' ? (r.value as { status: string }).status : 'rejected',
        );
      const acceptedCount = grpcStatuses.filter((status) => status === 'accepted').length;
      expect(acceptedCount).toBeLessThanOrEqual(1);
    } finally {
      await instance.close();
    }
    // T-RAP-056 retry 2: this test's own explicit 90_000 override (smaller than this file's own
    // shared default) was removed — it could never have tolerated a real lock-wait behind the
    // writer, and every `startInstance()` call in this file now needs the same tolerance. Falls
    // through to the file's own `jest.setTimeout` above.
  });

  // TC-4 — budget-breach scenario, single instance.
  it('TC-4: a shared campaign budget is never overspent under concurrent load from many customers', async () => {
    const tenantId = reserveTenant();
    const CUSTOMER_COUNT = 8;
    const REWARD_VALUE = '5.00';
    const MAX_TOTAL = '25.00'; // exactly 5 of 8 customers can be rewarded before the cap is hit.
    const componentId = deriveComponentId(tenantId);
    const { payload } = buildCampaign({
      tenantId,
      campaignCode: `CAMP-TC4-${tenantId}`,
      rewards: [
        buildComponentReward(componentId, {
          policiesJson: JSON.stringify({ fixedAmount: REWARD_VALUE }),
        }),
      ],
      caps: [buildCampaignBudgetCap({ maxTotalAmount: MAX_TOTAL })],
    });
    mockPortal.setCampaigns(tenantId, [payload]);

    const instance = await startInstance({
      tenantId,
      mockPortalPort: mockPortal.port,
      grpcIdentity: `tc4-${tenantId}`,
      aesKeyB64: AES_KEY_B64,
      hmacKeyB64: HMAC_KEY_B64,
    });

    try {
      const customers = Array.from({ length: CUSTOMER_COUNT }, (_, i) => ({
        customerId: `cust-tc4-${i}-${randomUUID()}`,
        eventId: `evt-tc4-${i}-${randomUUID()}`,
        viaGrpc: i % 2 === 0,
      }));

      await Promise.all(
        customers.map((c) =>
          c.viaGrpc
            ? instance.submitGrpc(grpcActivityRequest(c.customerId, c.eventId))
            : publishActivity(
                producer,
                c.customerId,
                kafkaActivityMessage(tenantId, c.customerId, c.eventId),
              ),
        ),
      );

      await waitUntil(async () => {
        const rows = await sequelize.query<{ status: string }>(
          `SELECT status FROM realtime_activity_processing.activity_logs
             WHERE tenant_id = :tenantId AND dedup_key IN (:eventIds)`,
          {
            type: QueryTypes.SELECT,
            replacements: { tenantId, eventIds: customers.map((c) => c.eventId) },
          },
        );
        return (
          rows.length === CUSTOMER_COUNT &&
          rows.every((r) => r.status === 'processed' || r.status === 'error')
        );
      }, 90_000);

      const rewards = await rewardEntriesFor(tenantId, payload.campaignCode);
      expect(rewards).toHaveLength(5);
      const totalRewarded = rewards.reduce((sum, r) => sum + Number(r.reward_value), 0);
      expect(totalRewarded).toBeCloseTo(25, 5);

      const [budgetRow] = await sequelize.query<{
        consumed_amount: string;
        consumed_count: number;
      }>(
        `SELECT consumed_amount, consumed_count FROM realtime_activity_processing.budget_consumption
           WHERE tenant_id = :tenantId AND campaign_code = :campaignCode`,
        { type: QueryTypes.SELECT, replacements: { tenantId, campaignCode: payload.campaignCode } },
      );
      expect(budgetRow).toBeDefined();
      expect(Number(budgetRow.consumed_amount)).toBeCloseTo(25, 5);
      expect(budgetRow.consumed_count).toBe(5);

      const deniedRows = await sequelize.query<{ comment: string | null }>(
        `SELECT comment FROM realtime_activity_processing.activity_logs
           WHERE tenant_id = :tenantId AND status = 'error' AND dedup_key IN (:eventIds)`,
        {
          type: QueryTypes.SELECT,
          replacements: { tenantId, eventIds: customers.map((c) => c.eventId) },
        },
      );
      expect(deniedRows).toHaveLength(3);
      for (const row of deniedRows) {
        expect(row.comment).toEqual(expect.stringMatching(/cap breach/));
      }
    } finally {
      await instance.close();
    }
    // T-RAP-056 retry 2: this test's own explicit 120_000 override (smaller than this file's own
    // shared default) was removed — see TC-2's own identical note above.
  });

  // TC-7 — full happy path, single activity, every stage observed in sequence.
  it('TC-7: activity -> component progress -> tracker completion -> reward entry -> Kafka dispatch -> visible in progress API', async () => {
    const tenantId = reserveTenant();
    const componentId = deriveComponentId(tenantId);
    const { payload } = buildCampaign({
      tenantId,
      campaignCode: `CAMP-TC7-${tenantId}`,
      rewards: [buildComponentReward(componentId)],
    });
    mockPortal.setCampaigns(tenantId, [payload]);

    const instance = await startInstance({
      tenantId,
      mockPortalPort: mockPortal.port,
      grpcIdentity: `tc7-${tenantId}`,
      aesKeyB64: AES_KEY_B64,
      hmacKeyB64: HMAC_KEY_B64,
    });
    const rewardWatcher: RewardCreatedWatcher = await watchRewardCreatedTopic(
      `t-rap-041-tc7-watcher-${tenantId}`,
    );

    try {
      const customerId = `cust-tc7-${randomUUID()}`;
      const eventId = `evt-tc7-${randomUUID()}`;
      const campaignCode = payload.campaignCode;
      const trackerCode = payload.trackers[0].trackerCode;
      const componentCode = payload.trackers[0].components[0].componentCode;

      // Stage 1: ingestion accepts and matches the component.
      const response = await instance.submitGrpc(grpcActivityRequest(customerId, eventId));
      expect(response.status).toBe('accepted');
      expect(response.matchedTrackerComponents).toEqual([componentCode]);

      // Stage 2: component progress completes.
      const customerIdHash = encryption.hash(customerId);
      await waitUntil(async () => {
        const [row] = await sequelize.query<{ is_completed: boolean }>(
          `SELECT is_completed FROM realtime_activity_processing.customer_tracker_component_progress
             WHERE tenant_id = :tenantId AND customer_id_hash = :hash AND campaign_code = :campaignCode
               AND tracker_component_code = :componentCode`,
          {
            type: QueryTypes.SELECT,
            replacements: { tenantId, hash: customerIdHash, campaignCode, componentCode },
          },
        );
        return row?.is_completed === true;
      }, 60_000);

      // Stage 3: tracker completion.
      const [trackerStatus] = await sequelize.query<{ is_completed: boolean }>(
        `SELECT is_completed FROM realtime_activity_processing.customer_tracker_status
           WHERE tenant_id = :tenantId AND customer_id_hash = :hash AND campaign_code = :campaignCode
             AND tracker_code = :trackerCode`,
        {
          type: QueryTypes.SELECT,
          replacements: { tenantId, hash: customerIdHash, campaignCode, trackerCode },
        },
      );
      expect(trackerStatus?.is_completed).toBe(true);

      // Stage 4: reward entry created.
      const rewards = await rewardEntriesFor(tenantId, campaignCode);
      expect(rewards).toHaveLength(1);
      expect(rewards[0].customer_id_hash).toBe(customerIdHash);

      // Stage 5: Kafka dispatch — the outbox publisher (started by `startInstance`) picks up the
      // pending row and publishes it for real onto `reward.entry.created.v1`.
      await waitUntil(
        () =>
          rewardWatcher.messages.some(
            (m) => (m.value as { campaignCode?: string })?.campaignCode === campaignCode,
          ),
        60_000,
      );
      const dispatched = rewardWatcher.messages.find(
        (m) => (m.value as { campaignCode?: string })?.campaignCode === campaignCode,
      );
      expect(dispatched?.value).toMatchObject({
        customerId,
        campaignCode,
        trackerCode,
        trackerComponentCode: componentCode,
      });

      await waitUntil(async () => {
        const entries = await rewardEntriesFor(tenantId, campaignCode);
        return entries[0]?.dispatch_status === 'dispatched';
      }, 30_000);

      // Stage 6: visible in the progress API.
      const token = progressToken(customerId, tenantId);
      const apiResponse = await request(progressApiApp.getHttpServer())
        .get(`/progress/customers/${customerId}/campaigns/${campaignCode}/trackers/${trackerCode}`)
        .set('Authorization', `Bearer ${token}`);
      expect(apiResponse.status).toBe(200);
      expect(apiResponse.body.isCompleted).toBe(true);
      expect(apiResponse.body.components).toEqual([
        { componentCode, currentCount: 1, requiredCount: 1, isCompleted: true },
      ]);
    } finally {
      await rewardWatcher.stop();
      await instance.close();
    }
  });
});
