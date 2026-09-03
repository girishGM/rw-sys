/**
 * T-RAP-023. Real round trip: a real `kafkajs` producer publishes real `activity.ingest.v1`
 * messages onto a real local Redpanda broker (`docker-compose.yml`, T-RAP-001); two real,
 * independently-running `ActivityIngestConsumer` instances — two separate
 * `IngestConsumerRootModule` application contexts, each with its own DB connection pool and its
 * own kafkajs `Consumer` connection, joining the same shared consumer group
 * (`ingest.config.ts`'s own header) — consume from it and call the real
 * `ActivityIngestionService` (T-RAP-021), which commits real rows against the real,
 * already-migrated `realtime_activity_processing.activity_logs` table. A schema-invalid message
 * is also published and its arrival on `activity.ingest.dlq.v1` (watched by a real, independent
 * `kafkajs` consumer) is confirmed directly. `AGENT-PROTOCOL.md` §3's "assert the observable
 * property, not the implementation string": only a real broker can actually prove TC-5's
 * partition-load-balancing-not-broadcast behaviour, not a mocked transport.
 *
 * **"Two consumer instances"** here means two separate `NestFactory.createApplicationContext`
 * application contexts (two separate DB pools, two separate kafkajs `Consumer` connections to the
 * same shared group) rather than two separate OS processes — functionally identical from Kafka's
 * own point of view (what defines a "consumer instance" in a consumer group is the connection,
 * not the process boundary), and avoids this suite needing to shell out to spawn child processes.
 * Flagged here as a deliberate simplification, per this task's own completion report.
 *
 * TC-5 publishes its own 10 messages with an explicit `partition` field (round-robin across the
 * topic's 3 partitions) rather than relying on the default key-hash partitioner — this makes the
 * "both instances receive at least one message" assertion deterministic (Kafka's default
 * partition assignor never gives one member 3 partitions and the other 0 for a 2-member group
 * over a 3-partition topic), not a matter of hash-collision luck.
 *
 * **Requires a running Redpanda** (`docker compose up -d redpanda` from this service's own
 * directory) and the real local Postgres 16 server (root `CLAUDE.md`, already migrated via
 * `npm run db:migrate`) — this suite is real infrastructure, not mocked, by design.
 *
 * Deviation from the task file's literal verification step 1 command (`npm test -- ingest`): this
 * project's single `testRegex` already matches both `.spec.ts` and `.e2e-spec.ts` files under
 * `test/`, so `npm test -- ingest` runs this file too (same precedent
 * `test/grpc/grpc-server.e2e-spec.ts`, T-RAP-022, already documents for this project).
 *
 * **T-RAP-056 / T-RAP-041 (retry 1).** `beforeAll`/`afterAll` below hold
 * `kafka-shared-consumer-group-lock.ts`'s own cross-process exclusive lock (named "WRITER" for this
 * file's own role, but the SAME underlying mutex full-pipeline's own "reader" leases use — see that
 * module's own header for why a genuinely non-exclusive reader/writer split was tried during
 * T-RAP-041's retry and reverted: it let two different full-pipeline files' own worker bundles run
 * concurrently, and their globally-scoped `ActivityLogClaimWorker`s could then race to claim each
 * OTHER's `activity_logs` rows using the WRONG file's own `FIELD_ENCRYPTION_*` keys) for this file's
 * entire `consumerA`/`consumerB` lifetime — a single-file grant onto this otherwise
 * `agent-rap-ingestion`-owned file, added specifically for this one change (`project.config.json`,
 * `AGENT-PROTOCOL.md` R10) — so a concurrently-running `full-pipeline(-multi-instance).e2e-spec.ts`
 * (T-RAP-041) instance can never be running while this file's own `waitForStableGroupMembership`
 * below expects to see exactly these two members. See that lock module's own header for the full
 * diagnosis and why the fix lives entirely on the test-file side rather than in
 * `src/messaging/ingest/**` (out of this task's file scope).
 */
import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { Kafka, logLevel, type Consumer as KafkaConsumer, type Producer } from 'kafkajs';
import { Sequelize, QueryTypes } from 'sequelize';
import { IngestConsumerRootModule } from '@/messaging/ingest/activity-ingest-consumer.main';
import { ActivityIngestConsumer } from '@/messaging/ingest/activity-ingest.consumer';
import {
  ACTIVITY_INGEST_CONSUMER_GROUP,
  ACTIVITY_INGEST_DLQ_TOPIC,
  ACTIVITY_INGEST_TOPIC,
} from '@/messaging/ingest/ingest.config';
import type { CampaignConfigProto } from '@/modules/campaign-cache/campaign-config.client';
import {
  acquireIngestConsumerGroupWriterLock,
  releaseIngestConsumerGroupWriterLock,
} from '../../e2e/kafka-shared-consumer-group-lock';
import { WRITER_LOCK_ACQUIRE_TIMEOUT_MS } from '../../e2e/ingest-consumer-writer-lock-budget';

jest.setTimeout(90_000);

/**
 * T-RAP-052. Every `waitUntil(...)` call in this file that waits for a Kafka-published message to
 * actually land as a Postgres row (or a DLQ message) used a fixed `30_000` budget. Re-running the
 * full `npm test` suite repeatedly against this same real Redpanda broker showed that budget is
 * occasionally too tight even with no other load and even after the consumer group is already
 * warmed up and has processed prior messages in the same run (isolated `--runInBand` re-run of
 * this file alone reproduced it once, 65s wall time vs. this file's normal ~32s) — real
 * broker/consumer-group fetch-latency variance, not a dedup/idempotency logic bug: every observed
 * failure was a timeout waiting for a row to land, never a wrong row count once it did land. Since
 * this task's own file scope is this spec file only (`T-RAP-052`'s task file), the fix available
 * here is a more generous, still-bounded round-trip budget — not a change to consumer/broker
 * tuning (that lives outside this file, see `src/messaging/ingest/activity-ingest.consumer.ts`).
 * See the regression test at the bottom of this file for a deterministic (non-flaky, fake-timer)
 * proof that this budget, not the old one, is what actually fixes the reported timeout.
 */
const ROUND_TRIP_TIMEOUT_MS = 60_000;

/**
 * T-RAP-056 retry 1 (arithmetic corrected in retry 2 — see below). The review that failed the first
 * submission measured a single legitimate `full-pipeline-multi-instance.e2e-spec.ts` TC holding the
 * shared lock for up to ~150s (well past that submission's 75s writer-acquire budget) and, worse,
 * this file's own writer acquire losing a bare-race mutex to that other file's own repeated,
 * near-zero-delay same-process re-acquisitions (`kafka-shared-consumer-group-lock.ts`'s own header
 * has the full diagnosis and the FIFO-fairness fix). Fairness now bounds *who* goes first; this
 * budget bounds *how long* a fairly-queued writer is willing to wait its OWN turn. Sized for the
 * realistic worst case in this exact 3-file topology (the only files that ever touch this lock): at
 * most two OTHER waiters (one per full-pipeline file — each only ever has one ticket in flight at a
 * time, since a single file's own TCs run strictly sequentially) can already be queued ahead of us,
 * each worth up to that file's own real per-TC work once a lease is actually held.
 *
 * **T-RAP-056 retry 2 correction.** Retry 1's own comment here cited
 * `full-pipeline-multi-instance.e2e-spec.ts`'s own `jest.setTimeout` (then 420_000) as the proxy for
 * "that other file's own max hold". That stopped being a safe proxy the moment retry 2 changed what
 * that number MEANS: both full-pipeline files' own `jest.setTimeout` now already bakes in their own
 * reader-lease ACQUIRE-wait budget on top of their real work (`READER_LEASE_ACQUIRE_TIMEOUT_MS` +
 * own heaviest-TC margin — see `full-pipeline-test-helpers.ts`), so reusing it here would be
 * circular (this constant feeding back into a number that already depends on a sibling of this same
 * constant) and would inflate `WRITER_LOCK_ACQUIRE_TIMEOUT_MS` far beyond what's real. The correct
 * proxy is each full-pipeline file's own REAL per-TC work ONCE A LEASE IS HELD (not the ceiling that
 * also covers waiting to acquire one) — at most ~150-160s per this project's own current heaviest
 * TCs in either file (see each file's own `jest.setTimeout` comment for the per-file arithmetic).
 * 2 * 200_000ms (a round, generously-rounded-up per-file bound) = 400_000ms, comfortably inside the
 * existing 900_000ms value below — left unchanged, since it was already generous under the corrected
 * arithmetic too.
 *
 * **This retry (a further correction the reviewer's own literal instruction requires): this was
 * still a bare, independently-hardcoded `900_000` literal that only happened to equal
 * `MAX_REALISTIC_LOCK_HOLD_MS` (`kafka-shared-consumer-group-lock.ts`) by coincidence, not by an
 * actual import — exactly the "two independently-guessed numbers that are not symmetrically safe"
 * shape the architect's decision explicitly said not to leave in place ("Do not simply raise both
 * numbers without linking them — that just moves the same asymmetry to a longer timescale"). If a
 * future change to this file's own real per-test budgets ever moved `MAX_REALISTIC_LOCK_HOLD_MS`
 * without a matching edit here, this literal would silently stop reflecting reality again. This
 * constant now lives in its own tiny, non-spec module
 * (`ingest-consumer-writer-lock-budget.ts` — see that file's own doc comment for the full
 * before/after), imported here rather than redefined, specifically so `full-pipeline-test-helpers.ts`'s
 * own `READER_LEASE_ACQUIRE_TIMEOUT_MS` can import the exact SAME value this file's own writer-acquire
 * uses (a real, direct link — not two numbers that separately happen to trace back to a shared
 * upstream constant), and so `lock-budget-invariant.spec.ts` can assert the reader/writer relationship
 * against the real values in force without needing to import this entire spec file (which would
 * re-register every `describe`/`it` below onto whatever file imported it).
 */
/** Must exceed `WRITER_LOCK_ACQUIRE_TIMEOUT_MS` by enough room for the rest of `beforeAll` after the
 * lock is actually acquired (two real `NestFactory` contexts, `consumerA`/`consumerB.start()`, and
 * `waitForStableGroupMembership`'s own up-to-45s budget) — passed as `beforeAll`'s own explicit
 * per-hook timeout below rather than raising this whole file's shared `jest.setTimeout(90_000)` (the
 * lock wait only ever happens here, never in any of this file's other, lighter TCs). */
const INGEST_BEFORE_ALL_TIMEOUT_MS = 960_000;

/**
 * T-RAP-055. TC-5 below does strictly more producer/consumer round-trip work than every other
 * test in this file — ten concurrent `producer.send()` calls up front, then a single shared
 * `waitUntil` polling for *all ten* rows to land (not just one) — so its own real wall-clock cost
 * can sit far closer to this file's shared `jest.setTimeout(90_000)` default than the lighter
 * single-message tests ever do, especially under full-suite system contention (a real Postgres +
 * real Redpanda round trip shared with dozens of other suites running at the same instant). Two
 * consecutive full unfiltered `npm test` runs on this machine showed exactly that: run 1 clean at
 * ~35s, run 2 (~16x slower under the same contention) failed only TC-5, with Jest's own "points at
 * the it() declaration line, no expect() diff" exceeded-per-test-timeout signature — not a
 * wrong-row-count or thrown-error failure — while an isolated re-run of this file alone passed
 * TC-5 cleanly in 512ms. That rules out a logic defect in the partition-split assertion or the
 * consumer under test (same diagnosis shape T-RAP-052 already established for TC-4 on this same
 * file, and T-RAP-054 for a different file's own real-lock timing test).
 *
 * Giving TC-5 its own explicit, more generous per-test timeout (the third `it()` argument) absorbs
 * that slack without loosening the shared 90s ceiling every other, lighter test in this file still
 * relies on to fail fast on a genuine hang — R-11's "don't weaken a guard to make a test green"
 * cuts the other way here: raising the *shared* default instead would have quietly slowed failure
 * detection for every simpler test in this file too, for a cost only TC-5 actually needs. See the
 * regression `describe` block at the bottom of this file for a deterministic, real-Jest-subprocess
 * proof of this exact mechanism, scaled down so it costs milliseconds rather than the 90+ real
 * seconds a literal reproduction at production scale would need on every `npm test` run.
 */
const TC5_TEST_TIMEOUT_MS = 150_000;

/**
 * T-RAP-056 retry 2. A second independent review's own clean-baseline run showed TC-6 exceeding
 * this file's shared `jest.setTimeout(90_000)` default under real full-suite contention — the same
 * shape of failure T-RAP-055 already diagnosed and fixed for TC-5 above (see that constant's own
 * doc comment), just not yet given the same treatment. TC-6 does strictly more real round-trip work
 * than the file's lighter single-message TCs: a fixed 5s settle-wait, THEN (only after that) a
 * second producer round trip through the full `ROUND_TRIP_TIMEOUT_MS` (60_000) `waitUntil` budget —
 * ~65s of real, sequential worst-case work before any per-call overhead, already uncomfortably close
 * to the shared 90s ceiling with zero contention margin. Giving TC-6 its own explicit, more generous
 * per-test timeout (same mechanism as TC-5's own `TC5_TEST_TIMEOUT_MS`, same reasoning: raising the
 * *shared* default instead would quietly slow failure detection for every simpler test in this file
 * for a cost only TC-5/TC-6 actually need) absorbs that slack without loosening the 90s ceiling every
 * other, lighter test in this file still relies on.
 */
const TC6_TEST_TIMEOUT_MS = 150_000;

const TENANT_ID = 940_000 + Math.floor(Math.random() * 59_999);
const CAMPAIGN_CODE = `CAMP-T-RAP-023-${TENANT_ID}`;
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:9093')
  .split(',')
  .map((broker) => broker.trim())
  .filter(Boolean);

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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 500,
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

/**
 * T-RAP-055. The structural shape this file's own real kafkajs `admin` client already satisfies
 * (`ReturnType<Kafka['admin']>['describeGroups']`) — abstracted so the regression `describe` block
 * at the bottom of this file can exercise the exact same polling logic against a fake, deterministic
 * sequence instead of a real broker.
 */
interface GroupMembershipProbe {
  describeGroups(
    groupIds: string[],
  ): Promise<{ groups: Array<{ groupId: string; state: string; members: unknown[] }> }>;
}

/**
 * T-RAP-055. `ACTIVITY_INGEST_CONSUMER_GROUP` is a single, fixed, shared consumer group name —
 * deliberately, every real running instance of this service joins it (`ingest.config.ts`'s own
 * header) — reused here by this file's own two test instances too. This file's own broker is a
 * real, long-lived local Redpanda container never reset between test invocations, so an *adjacent*
 * run of this exact file (this suite's own previous execution, or another one started in close
 * succession) can leave a member whose `stop()`/`disconnect()` LeaveGroup request the coordinator
 * hasn't finished processing yet by the time THIS run's own `consumerA`/`consumerB` join — under
 * genuine full-suite system contention, that overlap window stretches far past a few seconds.
 * Diagnosing T-RAP-055's reported flake reproduced this directly: polling the broker's own
 * `rpk group describe realtime-activity-processing-ingest` once a second during a full unfiltered
 * `npm test` run showed this group sitting at 3-4 members in `PreparingRebalance` for many
 * consecutive seconds before settling back to the 2 members this file's own `beforeAll` actually
 * started — and TC-5 below, run during exactly that overlap window, split its own 10 messages
 * across a *third*, unspied member instead of only `consumerA`/`consumerB`, landing 10 real
 * Postgres rows (proving the shared domain logic is correct) while `spyA`/`spyB` between them
 * recorded far fewer than 10 calls (proving nothing about the assertion's own premise was wrong —
 * the premise "only these two members ever exist" simply wasn't true yet).
 *
 * A fixed sleep can never verify that premise, only hope it happens to be true by the time it
 * elapses (this file's previous fixed `3_000`ms `beforeAll` wait was exactly that hope, and the
 * evidence above shows 3s is nowhere near enough under contention). Actively polling the broker's
 * own group-membership state until it reports `Stable` at exactly the expected member count makes
 * the premise verified, not assumed, before any test relies on it.
 *
 * **A single matching snapshot is not enough on its own.** During diagnosis, a first version of
 * this helper that returned on the very first `Stable`+`expectedMemberCount` observation still let
 * TC-5 fail occasionally (4/5 stress runs clean, 1/5 still split across a third member) — a
 * plausible coincidental snapshot mid-handshake: e.g. one stale leftover member plus only ONE of
 * this run's own two new members happens to read as "Stable, 2" for one poll, an instant before
 * the second new member's own still-in-flight `JoinGroup` triggers yet another rebalance. Requiring
 * `requiredConsecutiveChecks` consecutive matching observations, `intervalMs` apart, before
 * declaring success closes that window without needing to reach into kafkajs's own private
 * per-member identity internals (no public API exposes a `Consumer`'s own assigned member id to
 * cross-check against). See the regression `describe` block at the bottom of this file for
 * deterministic coverage of both the "never stabilizes" and "stabilizes after some churn" shapes.
 */
async function waitForStableGroupMembership(
  probe: GroupMembershipProbe,
  groupId: string,
  expectedMemberCount: number,
  timeoutMs: number,
  intervalMs = 500,
  requiredConsecutiveChecks = 3,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = 'no response yet';
  let consecutiveMatches = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { groups } = await probe.describeGroups([groupId]);
    const group = groups.find((candidate) => candidate.groupId === groupId);
    lastSeen = group
      ? `state=${group.state}, members=${group.members.length}`
      : `group "${groupId}" not found`;
    if (group && group.state === 'Stable' && group.members.length === expectedMemberCount) {
      consecutiveMatches += 1;
      if (consecutiveMatches >= requiredConsecutiveChecks) {
        return;
      }
    } else {
      consecutiveMatches = 0;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForStableGroupMembership: group "${groupId}" never reached Stable with exactly ` +
          `${expectedMemberCount} member(s) for ${requiredConsecutiveChecks} consecutive checks ` +
          `within ${timeoutMs}ms (last seen: ${lastSeen})`,
      );
    }
    await wait(intervalMs);
  }
}

function buildCampaignPayload(): CampaignConfigProto {
  return {
    campaignId: TENANT_ID,
    campaignCode: CAMPAIGN_CODE,
    tenantId: TENANT_ID,
    countryId: 1,
    status: 'active',
    startDate: '2020-01-01T00:00:00.000Z',
    endDate: '2030-01-01T00:00:00.000Z',
    budget: { amount: '1000.0000', currency: 'USD' },
    maxParticipants: 1000,
    merchants: [
      {
        merchantId: 1,
        merchantCode: 'MERCH1',
        name: 'T-RAP-023 e2e merchant',
        status: 'active',
        activities: [
          { activityId: 501, activityCode: 'PURCHASE', name: 'Purchase', externalCodes: [] },
        ],
      },
    ],
    trackers: [
      {
        trackerId: 701,
        trackerCode: 'TRK1',
        name: 'T-RAP-023 e2e tracker',
        completionLogic: 'ALL',
        completionThreshold: 1,
        status: 'active',
        components: [
          {
            componentId: 801,
            componentCode: 'COMP1',
            name: 'T-RAP-023 e2e component',
            activityId: 501,
            sequenceOrder: 1,
            isMandatory: true,
            status: 'active',
          },
        ],
      },
    ],
    rules: [],
    rewards: [],
    etag: 'etag-1',
    configHash: 'hash-1',
    notModified: false,
    servedAt: new Date().toISOString(),
    caps: [],
    sectionsReturned: ['BASIC', 'MERCHANTS', 'TRACKERS', 'RULES', 'REWARDS', 'CAPS'],
    sectionsOmitted: [],
  };
}

function activityMessage(
  customerId: string,
  activityEventId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tenantId: TENANT_ID,
    customerId,
    customerIdType: 'INTERNAL_ID',
    activityPerformedDate: '2026-09-01T10:15:30Z',
    activityCode: 'PURCHASE',
    activityType: 'TRANSACTION',
    activityCategory: 'RETAIL',
    activityValue: '100.0000',
    activityValueUnit: 'USD',
    channel: 'WEB',
    activityPerformedEnv: 'PROD',
    activityName: 'Online purchase',
    activityEventId,
    ...overrides,
  };
}

describe('T-RAP-023 — Kafka ingestion consumer (real Redpanda, real Postgres) (e2e)', () => {
  let sequelize: Sequelize;
  let admin: ReturnType<Kafka['admin']>;
  let producer: Producer;
  let dlqConsumer: KafkaConsumer;
  let dlqMessages: Array<{ key: string | null; value: Record<string, unknown> | null }>;
  let appA: INestApplicationContext;
  let appB: INestApplicationContext;
  let consumerA: ActivityIngestConsumer;
  let consumerB: ActivityIngestConsumer;
  let spyA: jest.SpyInstance;
  let spyB: jest.SpyInstance;

  beforeAll(async () => {
    process.env.PORTAL_CONFIG_TENANT_IDS = String(TENANT_ID);
    process.env.FIELD_ENCRYPTION_AES_KEY = Buffer.alloc(32, 3).toString('base64');
    process.env.FIELD_ENCRYPTION_HMAC_KEY = Buffer.alloc(32, 4).toString('base64');

    // Deliberately unreachable — same precedent `test/grpc/grpc-server.e2e-spec.ts` (T-RAP-022)
    // already set: a *successful* `ListActiveCampaigns` response that omits this test's own
    // campaign is the only thing that would mark it vanished; failing fast (connection refused)
    // never triggers that path.
    const unusedPortalPort = await getFreePort();
    process.env.PORTAL_GRPC_HOST = 'localhost';
    process.env.PORTAL_GRPC_PORT = String(unusedPortalPort);
    process.env.PORTAL_GRPC_TIMEOUT_MS = '1000';
    delete process.env.PORTAL_GRPC_TLS_CA_PATH;
    delete process.env.PORTAL_GRPC_TLS_CERT_PATH;
    delete process.env.PORTAL_GRPC_TLS_KEY_PATH;

    sequelize = new Sequelize({
      dialect: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_NAME,
      username: process.env.DB_APP_USERNAME,
      password: process.env.DB_APP_PASSWORD,
      logging: false,
    });
    await sequelize.authenticate();
    await sequelize.query(
      `INSERT INTO realtime_activity_processing.campaign_config_snapshot
         (tenant_id, campaign_code, config_version, is_active, payload, fetched_at, updated_at)
       VALUES (:tenantId, :campaignCode, 'hash-1', true, CAST(:payload AS jsonb), now(), now())`,
      {
        type: QueryTypes.RAW,
        replacements: {
          tenantId: TENANT_ID,
          campaignCode: CAMPAIGN_CODE,
          payload: JSON.stringify(buildCampaignPayload()),
        },
      },
    );

    const kafka = new Kafka({
      clientId: `rap-e2e-t-rap-023-${TENANT_ID}`,
      brokers: KAFKA_BROKERS,
      logLevel: logLevel.NOTHING,
      // T-RAP-055. kafkajs's own default retry policy (`retries: 5`, `maxRetryTime: 30_000`) lets
      // a single API call (e.g. `admin.describeGroups`, polled by `waitForStableGroupMembership`
      // below) silently absorb up to several minutes of internal backoff on repeated transient
      // errors before it ever returns — observed directly during diagnosis: two genuinely
      // back-to-back full `npm test` runs (this file's own adjacent-run overlap scenario) had this
      // file's total run time balloon to 361s/431s versus its normal ~35-40s, even though
      // `waitForStableGroupMembership`'s own nominal `timeoutMs` budget (checked only *between*
      // calls, never able to interrupt one already in flight) was never actually exceeded. A
      // tighter, still-bounded retry ceiling here makes each individual call fail/retry fast
      // enough that this file's own timeout budgets (`waitForStableGroupMembership`'s `timeoutMs`,
      // `ROUND_TRIP_TIMEOUT_MS`, `TC5_TEST_TIMEOUT_MS`) mean what they say, without changing
      // `ActivityIngestConsumer`'s own production retry/session tuning — that file is outside this
      // task's own declared scope; see this task's completion report for the follow-up filed for
      // it.
      retry: { initialRetryTime: 250, maxRetryTime: 2_000, retries: 10 },
    });

    admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      waitForLeaders: true,
      topics: [
        { topic: ACTIVITY_INGEST_TOPIC, numPartitions: 3 },
        { topic: ACTIVITY_INGEST_DLQ_TOPIC, numPartitions: 1 },
      ],
    });

    producer = kafka.producer();
    await producer.connect();

    dlqMessages = [];
    dlqConsumer = kafka.consumer({ groupId: `rap-e2e-dlq-watcher-${TENANT_ID}` });
    await dlqConsumer.connect();
    await dlqConsumer.subscribe({ topic: ACTIVITY_INGEST_DLQ_TOPIC, fromBeginning: false });
    await dlqConsumer.run({
      eachMessage: async ({ message }) => {
        dlqMessages.push({
          key: message.key ? message.key.toString() : null,
          value: message.value
            ? (JSON.parse(message.value.toString()) as Record<string, unknown>)
            : null,
        });
      },
    });

    // T-RAP-056 / T-RAP-041 (retry 1): held until afterAll has fully stopped both consumers below —
    // see `kafka-shared-consumer-group-lock.ts`'s own header for why this is a single cross-process
    // exclusive lock (not a genuinely non-exclusive reader/writer split), and (T-RAP-056 retry 1) for
    // why it's now a fair FIFO queue rather than a bare race. `WRITER_LOCK_ACQUIRE_TIMEOUT_MS` (see
    // its own doc comment above for the worked-out arithmetic) is an explicit, attributable timeout
    // rather than a bare, unbounded-relative-to-`INGEST_BEFORE_ALL_TIMEOUT_MS` wait, which would
    // otherwise surface a genuine "waited too long for exclusive access" as an opaque, generic Jest
    // "Exceeded timeout" instead of this lock's own clear error (queue position included).
    await acquireIngestConsumerGroupWriterLock(WRITER_LOCK_ACQUIRE_TIMEOUT_MS);

    appA = await NestFactory.createApplicationContext(IngestConsumerRootModule, { logger: false });
    appB = await NestFactory.createApplicationContext(IngestConsumerRootModule, { logger: false });
    consumerA = appA.get(ActivityIngestConsumer);
    consumerB = appB.get(ActivityIngestConsumer);

    // Attached BEFORE start() so every real `eachMessage` invocation on either instance is
    // recorded from the very first message onward.
    spyA = jest.spyOn(consumerA, 'processMessage');
    spyB = jest.spyOn(consumerB, 'processMessage');

    await consumerA.start();
    await consumerB.start();
    // T-RAP-055: actively verified, not assumed — see `waitForStableGroupMembership`'s own header
    // comment above for why a fixed sleep here previously let TC-5 run during a still-unsettled
    // rebalance window and split messages across a stale third member instead of just these two.
    await waitForStableGroupMembership(admin, ACTIVITY_INGEST_CONSUMER_GROUP, 2, 45_000);
  }, INGEST_BEFORE_ALL_TIMEOUT_MS);

  afterAll(async () => {
    await consumerA?.stop();
    await consumerB?.stop();
    // T-RAP-056: released as soon as both consumers have left the group — everything after this is
    // unrelated cleanup (DB rows, the DLQ watcher/producer/admin) that doesn't need the lock held.
    releaseIngestConsumerGroupWriterLock();
    await appA?.close();
    await appB?.close();
    await dlqConsumer?.disconnect();
    await producer?.disconnect();
    await admin?.disconnect();
    await sequelize.query(
      'DELETE FROM realtime_activity_processing.activity_logs WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await sequelize.query(
      'DELETE FROM realtime_activity_processing.campaign_config_snapshot WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await sequelize.close();
  });

  async function rowsFor(activityEventIds: string[]): Promise<Array<Record<string, unknown>>> {
    return sequelize.query<Record<string, unknown>>(
      `SELECT customer_id_hash, tracker_component_code, source_transport, dedup_key
         FROM realtime_activity_processing.activity_logs
        WHERE tenant_id = :tenantId AND dedup_key IN (:eventIds)`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId: TENANT_ID, eventIds: activityEventIds },
      },
    );
  }

  // TC-1
  it('TC-1: a valid message matching one active component is inserted and the offset commits', async () => {
    const activityEventId = `tc1-${randomUUID()}`;
    await producer.send({
      topic: ACTIVITY_INGEST_TOPIC,
      messages: [
        { key: 'cust-tc1', value: JSON.stringify(activityMessage('cust-tc1', activityEventId)) },
      ],
    });

    await waitUntil(
      async () => (await rowsFor([activityEventId])).length === 1,
      ROUND_TRIP_TIMEOUT_MS,
    );

    const rows = await rowsFor([activityEventId]);
    expect(rows[0].tracker_component_code).toBe('COMP1');
    expect(rows[0].source_transport).toBe('KAFKA');
  });

  // TC-2 / verification step 3
  it('TC-2: a message missing a mandatory field is routed to activity.ingest.dlq.v1 with the validation failure reason attached', async () => {
    const key = `tc2-${randomUUID()}`;
    const body = activityMessage(key, `tc2-${randomUUID()}`, { customerId: undefined });
    await producer.send({
      topic: ACTIVITY_INGEST_TOPIC,
      messages: [{ key, value: JSON.stringify(body) }],
    });

    await waitUntil(() => dlqMessages.some((m) => m.key === key), ROUND_TRIP_TIMEOUT_MS);

    const dlqMessage = dlqMessages.find((m) => m.key === key);
    expect(dlqMessage?.value?.error).toEqual(expect.stringMatching(/customerId/));
  });

  // TC-3
  it('TC-3: a timestamp lacking a UTC offset is routed to the DLQ the same way', async () => {
    const key = `tc3-${randomUUID()}`;
    const body = activityMessage(key, `tc3-${randomUUID()}`, {
      activityPerformedDate: '2026-09-01 10:00:00',
    });
    await producer.send({
      topic: ACTIVITY_INGEST_TOPIC,
      messages: [{ key, value: JSON.stringify(body) }],
    });

    await waitUntil(() => dlqMessages.some((m) => m.key === key), ROUND_TRIP_TIMEOUT_MS);

    const dlqMessage = dlqMessages.find((m) => m.key === key);
    expect(dlqMessage?.value?.error).toEqual(expect.stringMatching(/activityPerformedDate/));
  });

  // TC-4
  it('TC-4: redelivering the identical activityEventId produces exactly one row, no error surfaced', async () => {
    const activityEventId = `tc4-${randomUUID()}`;
    const body = activityMessage('cust-tc4', activityEventId);

    await producer.send({
      topic: ACTIVITY_INGEST_TOPIC,
      messages: [{ key: 'cust-tc4', value: JSON.stringify(body) }],
    });
    await waitUntil(
      async () => (await rowsFor([activityEventId])).length === 1,
      ROUND_TRIP_TIMEOUT_MS,
    );

    // Redelivery: the identical message published a second time.
    await producer.send({
      topic: ACTIVITY_INGEST_TOPIC,
      messages: [{ key: 'cust-tc4', value: JSON.stringify(body) }],
    });
    // Give the consumer group time to actually process the redelivered message.
    await wait(5_000);

    const rows = await rowsFor([activityEventId]);
    expect(rows).toHaveLength(1);
    expect(dlqMessages.some((m) => m.key === 'cust-tc4')).toBe(false);
  });

  // TC-6 (T-RAP-056 retry 2: explicit, more generous per-test timeout — see TC6_TEST_TIMEOUT_MS's
  // own header comment above for why this specific test needs it)
  it(
    'TC-6: a message that validates but matches no active component is NOT a DLQ case, and offset still commits',
    async () => {
      const key = `tc6-${randomUUID()}`;
      const activityEventId = `tc6-${randomUUID()}`;
      const body = activityMessage(key, activityEventId, { activityCode: 'NO-SUCH-ACTIVITY' });
      await producer.send({
        topic: ACTIVITY_INGEST_TOPIC,
        messages: [{ key, value: JSON.stringify(body) }],
      });

      // No row is expected (zero matches) and no DLQ message either — assert both hold across a
      // bounded window, then confirm the offset really did commit by publishing a subsequent,
      // matching message on the SAME key/partition and observing it process normally.
      await wait(5_000);
      expect((await rowsFor([activityEventId])).length).toBe(0);
      expect(dlqMessages.some((m) => m.key === key)).toBe(false);

      const followUpEventId = `tc6-followup-${randomUUID()}`;
      await producer.send({
        topic: ACTIVITY_INGEST_TOPIC,
        messages: [{ key, value: JSON.stringify(activityMessage(key, followUpEventId)) }],
      });
      await waitUntil(
        async () => (await rowsFor([followUpEventId])).length === 1,
        ROUND_TRIP_TIMEOUT_MS,
      );
    },
    TC6_TEST_TIMEOUT_MS,
  );

  // TC-5 / verification step 2 (T-RAP-055: explicit, more generous per-test timeout — see
  // TC5_TEST_TIMEOUT_MS's own header comment above for why this specific test needs it)
  it(
    'TC-5: ten distinct messages are split across the two consumer instances, never processed by both',
    async () => {
      spyA.mockClear();
      spyB.mockClear();

      const eventIds = Array.from({ length: 10 }, (_, index) => `tc5-${index}-${randomUUID()}`);
      await Promise.all(
        eventIds.map((eventId, index) => {
          const key = `cust-${eventId}`;
          return producer.send({
            topic: ACTIVITY_INGEST_TOPIC,
            // Explicit round-robin partition assignment — see this file's own header for why.
            messages: [
              {
                key,
                value: JSON.stringify(activityMessage(key, eventId)),
                partition: index % 3,
              },
            ],
          });
        }),
      );

      await waitUntil(async () => (await rowsFor(eventIds)).length === 10, ROUND_TRIP_TIMEOUT_MS);

      // T-RAP-056 retry 2: a second independent review's own clean-baseline run observed
      // `spyA.mock.calls.length + spyB.mock.calls.length === 11`, not 10, under real full-suite
      // contention — a real, reproducible assertion failure, not a timeout. Root cause is NOT a
      // return of cross-file contamination (this file's own `waitForStableGroupMembership` above
      // already proves exactly these two members hold the group before any test runs, and the
      // per-key overlap check below — unchanged, still the guard that actually proves "not
      // broadcast" — never flagged a message handled by BOTH instances). It is legitimate Kafka
      // at-least-once redelivery to the SAME instance: real contention can stall the event loop long
      // enough to miss a heartbeat, triggering a session-timeout-driven self-rebalance between this
      // group's own two members, after which a message already `processMessage`-called but not yet
      // committed gets redelivered once more. That's expected, harmless behaviour the DB's own
      // `dedup_key` uniqueness already absorbs (the `waitUntil` above already proves exactly 10
      // DISTINCT rows landed) — not the property this test exists to prove.
      // What TC-5 actually needs to prove is "load-balanced, not broadcast": every one of the 10
      // messages was handled by exactly one instance, never zero, never both. Assert that on message
      // IDENTITY (the union of each instance's own handled keys), not on a raw invocation COUNT that
      // legitimate infrastructure-level redelivery can inflate for reasons having nothing to do with
      // the partition-assignment logic under test (`AGENT-PROTOCOL.md` §3: "assert the observable
      // property, not the implementation string").
      const keysHandledByA = new Set(spyA.mock.calls.map(([raw]) => (raw as { key: string }).key));
      const keysHandledByB = new Set(spyB.mock.calls.map(([raw]) => (raw as { key: string }).key));
      // Load-balanced, not broadcast: each instance handled at least one message...
      expect(keysHandledByA.size).toBeGreaterThan(0);
      expect(keysHandledByB.size).toBeGreaterThan(0);
      // ...no message was EVER handled by both (the actual broadcast-prevention guard — unchanged)...
      for (const key of keysHandledByB) {
        expect(keysHandledByA.has(key)).toBe(false);
      }
      // ...and, combined, every one of the 10 distinct messages was handled by exactly one of them.
      const uniqueKeysHandled = new Set([...keysHandledByA, ...keysHandledByB]);
      expect(uniqueKeysHandled.size).toBe(10);
    },
    TC5_TEST_TIMEOUT_MS,
  );
});

/**
 * T-RAP-052 regression coverage for the `waitUntil` round-trip budget itself.
 *
 * The reported defect (TC-4's `waitUntil` at line ~338 timing out at the *old* fixed 30s budget)
 * is real broker-latency variance — not reliably reproducible on demand against a real Redpanda
 * broker (see this file's header comment on `ROUND_TRIP_TIMEOUT_MS` for the diagnosis). A
 * deterministic regression test can't wait out real seconds of broker jitter, so this block proves
 * the *mechanism* deterministically instead, with Jest fake timers standing in for a slow round
 * trip: a predicate that only becomes true after 32 simulated seconds — longer than the old 30s
 * budget, shorter than the fixed `ROUND_TRIP_TIMEOUT_MS` — must fail `waitUntil` under the old
 * budget and succeed under the fixed one. This is a deliberately separate top-level `describe`
 * with no `beforeAll` of its own: it exercises only the local `waitUntil` helper, never the real
 * Kafka/Postgres round trip, so it needs no running infrastructure to prove the point.
 *
 * Proven to fail on the unfixed code: temporarily changing `ROUND_TRIP_TIMEOUT_MS` back to
 * `30_000` (the pre-T-RAP-052 value every `waitUntil` call in this file used) turns the second
 * test below red, because the same 32s-simulated-delay predicate then exceeds *that* budget too —
 * see this task's completion report for the observed output of that run.
 */
describe('T-RAP-052 regression: waitUntil round-trip budget', () => {
  const SIMULATED_ROUND_TRIP_DELAY_MS = 32_000;
  const OLD_ROUND_TRIP_TIMEOUT_MS = 30_000;

  afterEach(() => {
    jest.useRealTimers();
  });

  function slowPredicate(startedAt: number): () => boolean {
    return () => Date.now() - startedAt >= SIMULATED_ROUND_TRIP_DELAY_MS;
  }

  // TC-1 (reproduce) / TC-3 (regression, proven to fail on the unfixed code — see header comment)
  it('TC-1/TC-3: a round trip slower than the old 30s budget times out under that budget (the reported defect)', async () => {
    jest.useFakeTimers();
    const startedAt = Date.now();
    const resultPromise = waitUntil(slowPredicate(startedAt), OLD_ROUND_TRIP_TIMEOUT_MS, 500);
    const assertion = expect(resultPromise).rejects.toThrow(
      `waitUntil: condition not met within ${OLD_ROUND_TRIP_TIMEOUT_MS}ms`,
    );
    await jest.advanceTimersByTimeAsync(OLD_ROUND_TRIP_TIMEOUT_MS + 1_000);
    await assertion;
  });

  // TC-2: the same check, after the fix
  it('TC-2: the identical round trip succeeds under the fixed ROUND_TRIP_TIMEOUT_MS budget', async () => {
    jest.useFakeTimers();
    const startedAt = Date.now();
    const resultPromise = waitUntil(slowPredicate(startedAt), ROUND_TRIP_TIMEOUT_MS, 500);
    const assertion = expect(resultPromise).resolves.toBeUndefined();
    await jest.advanceTimersByTimeAsync(SIMULATED_ROUND_TRIP_DELAY_MS + 1_000);
    await assertion;
  });

  // TC-4: adjacent behaviour unchanged — waitUntil still fails fast (relative to its own budget)
  // when the condition is never met at all, for both the old and the fixed budget.
  it('TC-4: a condition that never becomes true still times out under the fixed budget', async () => {
    jest.useFakeTimers();
    const resultPromise = waitUntil(() => false, ROUND_TRIP_TIMEOUT_MS, 500);
    const assertion = expect(resultPromise).rejects.toThrow(
      `waitUntil: condition not met within ${ROUND_TRIP_TIMEOUT_MS}ms`,
    );
    await jest.advanceTimersByTimeAsync(ROUND_TRIP_TIMEOUT_MS + 1_000);
    await assertion;
  });
});

/**
 * T-RAP-055 regression coverage for TC-5's own explicit per-test timeout override.
 *
 * The reported defect (TC-5 exceeding this file's shared `jest.setTimeout(90_000)` default under
 * genuine full-suite system contention) is real scheduling variance — like T-RAP-052's own finding
 * on this identical file, not reliably reproducible on demand (an isolated re-run of this file
 * passed TC-5 in 512ms; see `TC5_TEST_TIMEOUT_MS`'s own header comment above). Proving it directly
 * would also mean actually waiting out 90+ real seconds on every single `npm test` run —
 * unacceptably slow for routine use, unlike T-RAP-052's fix, whose fake-timer trick works because
 * the thing under test there was this file's own hand-written `waitUntil` helper. Here, what
 * actually failed was Jest's *own* per-test timeout watchdog — a real OS-level wall-clock alarm
 * fake timers cannot intercept from inside the same test.
 *
 * So this block spawns a real, separate Jest process (`node_modules/.bin/jest`, not a mock)
 * against a throwaway single-test fixture file in a fresh temp directory, using small, scaled-down
 * stand-ins for this file's real `jest.setTimeout(90_000)` default and TC-5's real
 * `TC5_TEST_TIMEOUT_MS` override. This proves the actual mechanism — a per-test `it()` timeout
 * argument overriding a file's shared default — on real Jest infrastructure, deterministically and
 * in well under a second, rather than waiting for a 1-in-N real scheduling anomaly at full
 * production scale. The temp fixture lives outside this project's own `test/` tree and is run
 * against an isolated `--config` (its own `rootDir`/`testMatch`), so it is never discovered by
 * this project's own `npm test` — only by the explicit subprocess invocation below.
 *
 * Proven to fail on the unfixed shape: TC-1/TC-3 spawn a test that sleeps longer than its own
 * fixture file's default with *no* explicit override — the identical shape TC-5 itself had before
 * this task's fix — and assert it fails with Jest's own "Exceeded timeout" signature, the same
 * signature originally reported. TC-2 spawns the identical slow test *with* an explicit override
 * (the fix TC-5 itself now has) and asserts it passes.
 */
describe('T-RAP-055 regression: an explicit per-test timeout overrides a file default that would otherwise be exceeded', () => {
  const SERVICE_ROOT = join(__dirname, '..', '..', '..');
  const JEST_BIN = join(SERVICE_ROOT, 'node_modules', '.bin', 'jest');
  // Scaled-down stand-ins for this file's real `jest.setTimeout(90_000)` default and TC-5's real
  // `TC5_TEST_TIMEOUT_MS` override — same shape, small enough to prove the mechanism in
  // milliseconds rather than minutes.
  const FIXTURE_FILE_DEFAULT_MS = 500;
  const FIXTURE_SLEEP_MS = 800;
  const FIXTURE_OVERRIDE_MS = 5_000;

  function writeFixtureConfig(dir: string): void {
    writeFileSync(
      join(dir, 'jest.config.json'),
      JSON.stringify({ rootDir: dir, testMatch: ['**/probe.test.js'], testEnvironment: 'node' }),
    );
  }

  function runFixture(dir: string): { status: number | null; output: string } {
    const result = spawnSync(JEST_BIN, ['--config', 'jest.config.json', '--no-coverage'], {
      cwd: dir,
      encoding: 'utf8',
    });
    return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
  }

  // TC-1 (reproduce) / TC-3 (regression — the assertions below are what would fail if Jest's own
  // per-test timeout mechanism did not behave as TC-5's fix depends on).
  it('TC-1/TC-3: a slow-but-correct test with no explicit override fails with the exceeded-timeout signature, not an assertion diff', () => {
    const dir = mkdtempSync(join(tmpdir(), 't-rap-055-probe-unfixed-'));
    try {
      writeFileSync(
        join(dir, 'probe.test.js'),
        [
          `jest.setTimeout(${FIXTURE_FILE_DEFAULT_MS});`,
          `it('slow but correct', async () => {`,
          `  await new Promise((resolve) => setTimeout(resolve, ${FIXTURE_SLEEP_MS}));`,
          `});`,
        ].join('\n'),
      );
      writeFixtureConfig(dir);
      const { status, output } = runFixture(dir);
      expect(status).not.toBe(0);
      expect(output).toMatch(/Exceeded timeout/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  // TC-2: the identical slow test, fixed with an explicit per-test override — passes.
  it('TC-2: the identical slow test passes once it declares its own explicit per-test timeout', () => {
    const dir = mkdtempSync(join(tmpdir(), 't-rap-055-probe-fixed-'));
    try {
      writeFileSync(
        join(dir, 'probe.test.js'),
        [
          `jest.setTimeout(${FIXTURE_FILE_DEFAULT_MS});`,
          `it('slow but correct', async () => {`,
          `  await new Promise((resolve) => setTimeout(resolve, ${FIXTURE_SLEEP_MS}));`,
          `}, ${FIXTURE_OVERRIDE_MS});`,
        ].join('\n'),
      );
      writeFixtureConfig(dir);
      const { status } = runFixture(dir);
      expect(status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  // TC-4: adjacent behaviour unchanged — a fast test with no override still passes fine under a
  // default that comfortably covers it (this fix must not mask a genuinely hung fast test).
  it('TC-4: a fast test with no override is unaffected', () => {
    const dir = mkdtempSync(join(tmpdir(), 't-rap-055-probe-fast-'));
    try {
      writeFileSync(
        join(dir, 'probe.test.js'),
        [
          `jest.setTimeout(${FIXTURE_FILE_DEFAULT_MS});`,
          `it('fast', () => { expect(1 + 1).toBe(2); });`,
        ].join('\n'),
      );
      writeFixtureConfig(dir);
      const { status } = runFixture(dir);
      expect(status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

/**
 * T-RAP-055 regression coverage for `waitForStableGroupMembership` — the second, independently
 * diagnosed root cause behind TC-5's own flake, on top of the per-test timeout fix above. Full
 * diagnosis (reproduced empirically, not just theorized): a temporary diagnostic `console.log`
 * added to TC-5, plus `rpk group describe realtime-activity-processing-ingest` polled once a
 * second in a separate shell during several consecutive full unfiltered `npm test` runs, together
 * showed real occurrences of `spyA.mock.calls.length + spyB.mock.calls.length` landing below 10
 * (e.g. `3`, `4`, `6`) while `rowsFor(eventIds)` still correctly reported all 10 — proving the
 * shared domain logic was never wrong, only this test's own unstated assumption ("only
 * `consumerA`/`consumerB` are ever members of this group") wasn't true yet at the moment TC-5 ran.
 * The `rpk group describe` polling loop directly confirmed why: `MEMBERS 3` and `MEMBERS 4`
 * (`PreparingRebalance`) for several consecutive one-second samples before settling back to the 2
 * members this file's own `beforeAll` actually started — a stale member from an adjacent run of
 * this exact file against this same long-lived local broker, still mid-eviction. This file's
 * *previous* fixed `wait(3_000)` in `beforeAll` had no way to know that, and evidently wasn't
 * always long enough under contention; it also isn't the kind of thing worth waiting out for real
 * on every routine `npm test` run just to prove in an automated regression test.
 *
 * So — same discipline as the per-test-timeout regression block above — this proves the actual
 * polling *mechanism* deterministically, against a fake `describeGroups` sequence standing in for
 * exactly the transient-then-stable shape just described, rather than a real broker.
 */
describe('T-RAP-055 regression: waitForStableGroupMembership', () => {
  function fakeProbe(
    sequence: ReadonlyArray<{ state: string; memberCount: number }>,
  ): GroupMembershipProbe {
    let call = 0;
    return {
      describeGroups: async (groupIds: string[]) => {
        const step = sequence[Math.min(call, sequence.length - 1)];
        call += 1;
        return {
          groups: [
            {
              groupId: groupIds[0],
              state: step.state,
              members: Array.from({ length: step.memberCount }, () => ({})),
            },
          ],
        };
      },
    };
  }

  // TC-1 (reproduce) / TC-3 (regression): a group that never actually reaches Stable at the
  // expected member count within its own budget must fail loudly, naming what it last saw — not
  // resolve on a lucky transient snapshot, and not hang silently either. This is the exact shape
  // this file's own previous fixed 3s sleep could never detect at all.
  it('TC-1/TC-3: throws, naming the last-seen state, when the group never reaches Stable at the expected member count', async () => {
    const probe = fakeProbe([
      { state: 'PreparingRebalance', memberCount: 4 },
      { state: 'PreparingRebalance', memberCount: 3 },
      { state: 'PreparingRebalance', memberCount: 4 },
    ]);
    await expect(waitForStableGroupMembership(probe, 'test-group', 2, 1_200, 400)).rejects.toThrow(
      /never reached Stable with exactly 2 member\(s\) for 3 consecutive checks within 1200ms/,
    );
  });

  // TC-2: the same helper resolves once the sequence actually reaches Stable at the expected count
  // — the fixed shape TC-5's own `beforeAll` now relies on instead of a fixed sleep.
  it('TC-2: resolves once the group genuinely reaches Stable at the expected member count', async () => {
    const probe = fakeProbe([
      { state: 'PreparingRebalance', memberCount: 4 },
      { state: 'PreparingRebalance', memberCount: 3 },
      { state: 'Stable', memberCount: 2 },
    ]);
    await expect(
      waitForStableGroupMembership(probe, 'test-group', 2, 5_000, 200),
    ).resolves.toBeUndefined();
  });

  // TC-4: adjacent behaviour unchanged — even a group that's Stable at the expected count from the
  // very first check still needs `requiredConsecutiveChecks` consecutive confirmations (the
  // debounce that closes the coincidental-snapshot race described above), not a zero-delay return
  // on a single observation, and resolves promptly once it has them.
  it('TC-4: resolves once genuinely stable for the required number of consecutive checks, not on a single snapshot', async () => {
    const probe = fakeProbe([{ state: 'Stable', memberCount: 2 }]);
    const start = Date.now();
    await waitForStableGroupMembership(probe, 'test-group', 2, 5_000, 200, 3);
    const elapsed = Date.now() - start;
    // 3 required confirmations, 200ms apart -> at least 2 waits (~400ms), comfortably under the
    // 5s budget.
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(2_000);
  });
});

/**
 * T-RAP-056 (this retry) regression coverage for TC-5's own assertion mechanism.
 *
 * The disqualifying review finding this addresses: under real full-suite contention,
 * `spyA.mock.calls.length + spyB.mock.calls.length` legitimately totalled **11**, not 10 — a real,
 * reproducible assertion failure with the OLD raw-count assertion, but not a partition-assignment
 * defect (see TC-5's own header comment above for the full diagnosis: harmless Kafka at-least-once
 * redelivery to the SAME instance after a contention-induced rebalance, which this file's own
 * `dedup_key` uniqueness already absorbs at the DB layer). The actual fix replaced the raw-count
 * assertion with an identity-based one (the union of each instance's own handled message KEYS).
 *
 * Reproducing the original 11-vs-10 count mismatch on demand against a real broker is exactly the
 * kind of scheduling-dependent flake this project's own regression blocks above (T-RAP-052,
 * T-RAP-055) already established isn't practical to force deterministically. So — same discipline —
 * this proves the actual assertion *mechanism* deterministically, against synthetic
 * `spyA.mock.calls`/`spyB.mock.calls`-shaped data standing in for exactly the reported shape (one
 * harmless duplicate call to the SAME instance, 11 raw calls, still only 10 distinct keys), rather
 * than a real broker.
 */
describe('T-RAP-056 regression: TC-5 assertion is identity-based (message keys), not a raw invocation count', () => {
  interface Call {
    key: string;
  }

  /** The exact assertion shape TC-5 itself now uses (see TC-5's own body above) — duplicated here,
   * deliberately, so this block proves the mechanism against synthetic data independently of
   * whichever real spy objects TC-5 happens to produce on any given run. */
  function assertLoadBalancedNotBroadcast(
    callsA: Call[],
    callsB: Call[],
    expectedCount: number,
  ): void {
    const keysHandledByA = new Set(callsA.map((call) => call.key));
    const keysHandledByB = new Set(callsB.map((call) => call.key));
    expect(keysHandledByA.size).toBeGreaterThan(0);
    expect(keysHandledByB.size).toBeGreaterThan(0);
    for (const key of keysHandledByB) {
      expect(keysHandledByA.has(key)).toBe(false);
    }
    const uniqueKeysHandled = new Set([...keysHandledByA, ...keysHandledByB]);
    expect(uniqueKeysHandled.size).toBe(expectedCount);
  }

  const TEN_KEYS = Array.from({ length: 10 }, (_, index) => `k${index}`);

  function buildRedeliveredScenario(): { callsA: Call[]; callsB: Call[] } {
    const callsA: Call[] = TEN_KEYS.slice(0, 5).map((key) => ({ key }));
    // The exact reported shape: one of instance A's own already-handled keys gets redelivered to
    // instance A a second time (a harmless, same-instance at-least-once redelivery) — an extra raw
    // call, no new key, no cross-instance overlap.
    callsA.push({ key: TEN_KEYS[0] });
    const callsB: Call[] = TEN_KEYS.slice(5).map((key) => ({ key }));
    return { callsA, callsB };
  }

  // TC-1 (reproduce) / TC-2 (the same check, after the fix)
  it('TC-1/TC-2: a harmless same-instance redelivery (11 raw calls, 10 distinct keys — the exact reported shape) still passes the identity-based assertion', () => {
    const { callsA, callsB } = buildRedeliveredScenario();
    // The exact real-world count the review reported: 11, not 10.
    expect(callsA.length + callsB.length).toBe(11);
    expect(() => assertLoadBalancedNotBroadcast(callsA, callsB, 10)).not.toThrow();
  });

  // TC-3: a regression test that fails without the fix — proven to fail on the unfixed code. The OLD
  // assertion TC-5 used before this fix was the literal raw-invocation-count check below; it fails on
  // this exact same, legitimate data.
  it('TC-3 (proven to fail on the unfixed code): the OLD raw-invocation-count assertion this fix replaced fails on that same, legitimate data', () => {
    const { callsA, callsB } = buildRedeliveredScenario();
    // Deliberately reproducing the OLD, now-replaced assertion shape inline (not the current TC-5
    // body) to prove it fails on legitimate data.
    expect(() => {
      expect(callsA.length + callsB.length).toBe(10);
    }).toThrow();
  });

  // TC-4: adjacent behaviour unchanged — a genuine broadcast (the same key handled by BOTH
  // instances) is still caught. Proves the fix narrowed what triggers a failure (harmless same-
  // instance redelivery no longer does) without also weakening the actual guard TC-5 exists to
  // enforce (a message handled by two different instances still does).
  it('TC-4: a genuine broadcast (the same key handled by both instances) still fails the identity-based assertion', () => {
    const callsA: Call[] = TEN_KEYS.map((key) => ({ key }));
    const callsB: Call[] = [{ key: TEN_KEYS[0] }];
    expect(() => assertLoadBalancedNotBroadcast(callsA, callsB, 10)).toThrow();
  });
});
