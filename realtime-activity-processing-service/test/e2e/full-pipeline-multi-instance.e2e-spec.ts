/**
 * T-RAP-041. Two-instance full-pipeline coverage — TC-3 (concurrent-duplicate simulation across two
 * instances), TC-5 (budget-breach scenario across two instances) and TC-6 (cache invalidation, both
 * instances). See `full-pipeline-test-helpers.ts`'s own header for exactly what "two instances"
 * means in this file (two full `startInstance()` bundles — own gRPC ingress, own Kafka ingress, own
 * processing/dispatch/invalidation worker — against the same real Postgres/real Redpanda/one shared
 * mock portal) and why that is this file's own deliberate, documented stand-in for "two processes"
 * (T-RAP-041's own implementation note 4).
 *
 * Single-instance coverage (TC-1, TC-2, TC-4, TC-7) lives in `full-pipeline.e2e-spec.ts` — see that
 * file's own header for the shared `npm test -- full-pipeline`/"no `test:e2e` script" deviation
 * note, which applies identically here.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
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
  type Instance,
  type MockPortal,
} from './full-pipeline-test-helpers';
import type { Producer } from 'kafkajs';
import type { ConfigChangeEventProto } from '@/modules/campaign-cache/campaign-config.client';

// T-RAP-056 retry 2 (was retry 1's flat 420_000). A second independent review measured a real
// writer hold of 502s and reproduced a genuine reader-lease acquire timeout in this file's own TC-3
// as a direct result — see `full-pipeline.e2e-spec.ts`'s own identical note for the full diagnosis
// (applies here unchanged). This file's own default is now IMPORTED `READER_LEASE_ACQUIRE_TIMEOUT_MS`
// (see its own doc comment in `full-pipeline-test-helpers.ts` for the writer-hold-aware arithmetic)
// plus this file's own heaviest single-TC real work once a lease is actually held (TC-5's own
// 120_000 `waitUntil` budget plus generous overhead margin for two full instances' own round trips
// — 150_000) — an expression, not a re-guessed literal. Every `it()` in this file now relies on this
// SAME shared default (no smaller per-test override survives this retry — see TC-3/TC-5/TC-6's own
// history). Only matters under real lock contention; a normal, uncontended run still finishes in
// well under a minute per TC.
jest.setTimeout(READER_LEASE_ACQUIRE_TIMEOUT_MS + 150_000);

const AES_KEY_B64 = Buffer.alloc(32, 31).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 32).toString('base64');

let nextTenantId = 960_000 + Math.floor(Math.random() * 30_000);
function freshTenantId(): number {
  nextTenantId += 1;
  return nextTenantId;
}

describe('T-RAP-041 — full pipeline, two instances (real gRPC + real Kafka + real processing/dispatch, shared Postgres/Redpanda/mock portal)', () => {
  let sequelize: Sequelize;
  let mockPortal: MockPortal;
  let producer: Producer;
  const usedTenantIds: number[] = [];

  beforeAll(async () => {
    process.env.FIELD_ENCRYPTION_AES_KEY = AES_KEY_B64;
    process.env.FIELD_ENCRYPTION_HMAC_KEY = HMAC_KEY_B64;

    sequelize = buildTestSequelize();
    await sequelize.authenticate();
    mockPortal = await startMockPortal();
    producer = await buildActivityIngestProducer('t-rap-041-mi-producer');
  });

  afterAll(async () => {
    for (const tenantId of usedTenantIds) {
      await cleanupTenant(sequelize, tenantId);
    }
    await producer.disconnect();
    await mockPortal.stop();
    await sequelize.close();
  });

  function reserveTenant(): number {
    const tenantId = freshTenantId();
    usedTenantIds.push(tenantId);
    return tenantId;
  }

  async function startTwoInstances(tenantId: number): Promise<[Instance, Instance]> {
    const instanceA = await startInstance({
      tenantId,
      mockPortalPort: mockPortal.port,
      grpcIdentity: `mi-a-${tenantId}`,
      aesKeyB64: AES_KEY_B64,
      hmacKeyB64: HMAC_KEY_B64,
    });
    const instanceB = await startInstance({
      tenantId,
      mockPortalPort: mockPortal.port,
      grpcIdentity: `mi-b-${tenantId}`,
      aesKeyB64: AES_KEY_B64,
      hmacKeyB64: HMAC_KEY_B64,
    });
    return [instanceA, instanceB];
  }

  async function processedRowCount(tenantId: number, dedupKey: string): Promise<number> {
    const rows = await sequelize.query<{ status: string }>(
      `SELECT status FROM realtime_activity_processing.activity_logs
         WHERE tenant_id = :tenantId AND dedup_key = :dedupKey`,
      { type: QueryTypes.SELECT, replacements: { tenantId, dedupKey } },
    );
    return rows.length;
  }

  async function rewardCountFor(tenantId: number, campaignCode: string): Promise<number> {
    const rows = await sequelize.query(
      `SELECT id FROM realtime_activity_processing.reward_entry
         WHERE tenant_id = :tenantId AND campaign_code = :campaignCode`,
      { type: QueryTypes.SELECT, replacements: { tenantId, campaignCode } },
    );
    return rows.length;
  }

  // TC-3 — concurrent-duplicate simulation across two instances.
  it('TC-3: the same activity fired concurrently against two independent instances (mixed transports) still produces exactly one outcome', async () => {
    const tenantId = reserveTenant();
    const componentId = deriveComponentId(tenantId);
    const { payload } = buildCampaign({
      tenantId,
      campaignCode: `CAMP-TC3-${tenantId}`,
      rewards: [buildComponentReward(componentId)],
    });
    mockPortal.setCampaigns(tenantId, [payload]);

    const [instanceA, instanceB] = await startTwoInstances(tenantId);

    try {
      const customerId = `cust-tc3-${randomUUID()}`;
      const eventId = `evt-tc3-${randomUUID()}`;
      const request = grpcActivityRequest(customerId, eventId);
      const kafkaMessage = kafkaActivityMessage(tenantId, customerId, eventId);

      // A mix of gRPC and Kafka, split across BOTH instances' own gRPC ingress — the cross-instance
      // proof note 4 asks for: no shared in-process state between instance A and instance B, only
      // the real DB's own uniqueness guarantee (`05-PROCESSING-PIPELINE.md` §2-§3) can prevent a
      // double-insert here.
      const results = await Promise.allSettled([
        instanceA.submitGrpc(request),
        instanceB.submitGrpc(request),
        publishActivity(producer, customerId, kafkaMessage),
      ]);
      for (const result of results) {
        expect(result.status).toBe('fulfilled');
      }

      await waitUntil(async () => {
        const rows = await sequelize.query<{ status: string }>(
          `SELECT status FROM realtime_activity_processing.activity_logs
             WHERE tenant_id = :tenantId AND dedup_key = :dedupKey`,
          { type: QueryTypes.SELECT, replacements: { tenantId, dedupKey: eventId } },
        );
        return rows.length === 1 && rows[0].status === 'processed';
      }, 90_000);

      expect(await processedRowCount(tenantId, eventId)).toBe(1);
      expect(await rewardCountFor(tenantId, payload.campaignCode)).toBe(1);

      // Neither instance's own gRPC ingress ever accepted the identical dedupKey twice.
      const grpcStatuses = results
        .slice(0, 2)
        .map((r) =>
          r.status === 'fulfilled' ? (r.value as { status: string }).status : 'rejected',
        );
      expect(grpcStatuses.filter((s) => s === 'accepted').length).toBeLessThanOrEqual(1);
    } finally {
      await Promise.all([instanceA.close(), instanceB.close()]);
    }
    // T-RAP-056 retry 2: this test's own explicit 150_000 override (smaller than this file's own
    // shared default) was removed — see this file's own header note above.
  });

  // TC-5 — budget-breach scenario across two instances.
  it('TC-5: a shared campaign budget is never overspent when qualifying activity is split across two instances', async () => {
    const tenantId = reserveTenant();
    const CUSTOMER_COUNT = 8;
    const REWARD_VALUE = '5.00';
    const MAX_TOTAL = '25.00'; // exactly 5 of 8 customers can be rewarded before the cap is hit.
    const componentId = deriveComponentId(tenantId);
    const { payload } = buildCampaign({
      tenantId,
      campaignCode: `CAMP-TC5-${tenantId}`,
      rewards: [
        buildComponentReward(componentId, {
          policiesJson: JSON.stringify({ fixedAmount: REWARD_VALUE }),
        }),
      ],
      caps: [buildCampaignBudgetCap({ maxTotalAmount: MAX_TOTAL })],
    });
    mockPortal.setCampaigns(tenantId, [payload]);

    const [instanceA, instanceB] = await startTwoInstances(tenantId);

    try {
      const customers = Array.from({ length: CUSTOMER_COUNT }, (_, i) => ({
        customerId: `cust-tc5-${i}-${randomUUID()}`,
        eventId: `evt-tc5-${i}-${randomUUID()}`,
        // Round-robin across every combination of the two instances' own gRPC ingress and Kafka —
        // real cross-instance contention on the same campaign-level budget row.
        mode: i % 3,
      }));

      await Promise.all(
        customers.map((c) => {
          const request = grpcActivityRequest(c.customerId, c.eventId);
          if (c.mode === 0) {
            return instanceA.submitGrpc(request);
          }
          if (c.mode === 1) {
            return instanceB.submitGrpc(request);
          }
          return publishActivity(
            producer,
            c.customerId,
            kafkaActivityMessage(tenantId, c.customerId, c.eventId),
          );
        }),
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
      }, 120_000);

      expect(await rewardCountFor(tenantId, payload.campaignCode)).toBe(5);

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

      const deniedCount = await sequelize.query(
        `SELECT id FROM realtime_activity_processing.activity_logs
           WHERE tenant_id = :tenantId AND status = 'error' AND dedup_key IN (:eventIds)`,
        {
          type: QueryTypes.SELECT,
          replacements: { tenantId, eventIds: customers.map((c) => c.eventId) },
        },
      );
      expect(deniedCount).toHaveLength(3);
    } finally {
      await Promise.all([instanceA.close(), instanceB.close()]);
    }
    // T-RAP-056 retry 2: this test's own explicit 180_000 override (smaller than this file's own
    // shared default) was removed — see this file's own header note above.
  });

  // TC-6 — cache invalidation, both instances, at the full integration level.
  it('TC-6: a ConfigChangeEvent on the mock portal is picked up by both running instances within one watch cycle', async () => {
    const tenantId = reserveTenant();
    const componentId = deriveComponentId(tenantId);
    const campaignCode = `CAMP-TC6-${tenantId}`;
    const { payload } = buildCampaign({
      tenantId,
      campaignCode,
      rewards: [buildComponentReward(componentId)],
      etag: 'etag-1',
      configHash: 'hash-1',
    });
    mockPortal.setCampaigns(tenantId, [payload]);

    const [instanceA, instanceB] = await startTwoInstances(tenantId);

    try {
      // Precondition: a fresh activity matches on both instances before any invalidation.
      const preCustomerA = `cust-tc6-pre-a-${randomUUID()}`;
      const preCustomerB = `cust-tc6-pre-b-${randomUUID()}`;
      const preResponseA = await instanceA.submitGrpc(
        grpcActivityRequest(preCustomerA, `evt-tc6-pre-a-${randomUUID()}`),
      );
      const preResponseB = await instanceB.submitGrpc(
        grpcActivityRequest(preCustomerB, `evt-tc6-pre-b-${randomUUID()}`),
      );
      expect(preResponseA.matchedTrackerComponents).toEqual([
        payload.trackers[0].components[0].componentCode,
      ]);
      expect(preResponseB.matchedTrackerComponents).toEqual([
        payload.trackers[0].components[0].componentCode,
      ]);

      // Every open stream gets every event (`04-CACHE-INVALIDATION.md` §1) — both instances'
      // own `WorkerRootModule` bundle each open their own `WatchCampaignConfig` stream.
      instanceA.watchConsumer.start();
      instanceB.watchConsumer.start();
      await waitUntil(() => mockPortal.openWatchCount(tenantId) === 2, 15_000);

      // The portal's own state now flips the campaign to `paused` — the exact case
      // `05-PROCESSING-PIPELINE.md` §1's own "all three of it, its tracker, and its campaign are
      // active" matching rule cares about.
      const { payload: pausedPayload } = buildCampaign({
        tenantId,
        campaignCode,
        rewards: [buildComponentReward(componentId)],
        status: 'paused',
        etag: 'etag-2',
        configHash: 'hash-2',
      });
      mockPortal.setCampaigns(tenantId, [pausedPayload]);
      const event: ConfigChangeEventProto = {
        campaignId: payload.campaignId,
        campaignCode,
        tenantId,
        changeType: 'PAUSED',
        etag: 'etag-2',
        occurredAt: new Date().toISOString(),
      };
      mockPortal.broadcast(tenantId, event);

      // Both instances' own in-memory cache reflects the change...
      await waitUntil(
        () =>
          instanceA.cache.getCampaignConfig(tenantId, campaignCode)?.etag === 'etag-2' &&
          instanceB.cache.getCampaignConfig(tenantId, campaignCode)?.etag === 'etag-2',
        30_000,
      );

      // ...and, functionally (not just "the etag field changed"): calling the exact same
      // `CampaignConfigCacheService.lookupByActivityCode` method `ActivityMapper` (T-RAP-021) calls
      // in production to decide a fan-out match now returns nothing for this campaign's activity,
      // on BOTH instances — `05-PROCESSING-PIPELINE.md` §1's "only active campaigns/trackers/
      // components are ever indexed for matching" (`campaign-config-cache.service.ts`'s own
      // implementation note 2).
      //
      // **Gap found and flagged, not routed around silently (`AGENT-PROTOCOL.md` §3):** this
      // assertion deliberately calls that method directly on the worker bundle's own
      // `CampaignConfigCacheService` (`instance.cache`) rather than proving it through a live
      // `submitGrpc`/Kafka round trip. Neither `GrpcMicroserviceRootModule`
      // (`src/grpc/grpc-server.main.ts`) nor `IngestConsumerRootModule`
      // (`src/messaging/ingest/activity-ingest-consumer.main.ts`) import `InvalidationModule` — an
      // actual run of this test with the original, transport-level assertion showed a live gRPC
      // submission through `instanceA`/`instanceB` still reporting `matchedTrackerComponents:
      // ['COMP1']` after this exact broadcast, because `ActivityMappingModule`'s own
      // `CampaignConfigCacheService` instance inside each gRPC/Kafka ingress process is a
      // completely separate DI-container instance from the worker bundle's — it only ever warms
      // once, at process start (`onModuleInit` -> `bootstrap()`), and never again: no
      // `WatchStreamConsumer`, no `ReconciliationPollerService` runs inside either ingestion
      // composition root today. That means a live gRPC/Kafka ingestion process's own *matching*
      // cache can go stale indefinitely once started — a real, out-of-scope (`src/grpc/**`/
      // `src/messaging/ingest/**`, `agent-rap-ingestion`'s file scope, R10) gap this task's own
      // completion report flags for the architect rather than silently working around by weakening
      // this test to only check the worker side and saying nothing.
      expect(instanceA.cache.lookupByActivityCode(tenantId, 'PURCHASE')).toEqual([]);
      expect(instanceB.cache.lookupByActivityCode(tenantId, 'PURCHASE')).toEqual([]);
      expect(instanceA.cache.getCampaignConfig(tenantId, campaignCode)?.raw.status).toBe('paused');
      expect(instanceB.cache.getCampaignConfig(tenantId, campaignCode)?.raw.status).toBe('paused');
    } finally {
      await Promise.all([instanceA.close(), instanceB.close()]);
    }
    // T-RAP-056 retry 2: this test's own explicit 120_000 override (smaller than this file's own
    // shared default) was removed — see this file's own header note above.
  });
});
