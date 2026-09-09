/**
 * T-INT-004. Real round trip through `startHybridBootstrap()` (`src/main.ts`) — the primary HTTP
 * app (`AppModule`) plus, independently, each of the two previously-standalone-only transports
 * this task wires in: the mTLS `RewardIngestService` gRPC server and the
 * `reward.entry.created.v1` Kafka consumer. Every scenario below calls `startHybridBootstrap()`
 * directly against real infrastructure (real local Postgres 16, real local Redpanda, a real
 * ephemeral mTLS CA) — the same "call the exported factory directly, in-process" precedent
 * `test/grpc/reward-ingest.e2e-spec.ts` (T-RR-011) and RAP's own `test/main/hybrid-bootstrap.e2e-spec.ts`
 * (T-INT-003, confirmed by direct read) already set. `AGENT-PROTOCOL.md` §3's "assert the
 * observable property, not the implementation string": every assertion below is either a real
 * socket probe, a real gRPC client round trip against a real listening server, a real Kafka
 * publish + row landing in real Postgres, or a real HTTP request — never just "the function we
 * expect to have been called was called".
 *
 * Real-process-level verification (`npm run start:dev` + `curl`, and re-running
 * `ts-node ... grpc-server.main.ts` standalone) is this task's own completion report's job (task
 * file's own "Verification steps" table) — this file covers the task file's own TC-1 through
 * TC-5. TC-6 ("the standalone gRPC file still works unmodified") is proven by
 * `test/grpc/reward-ingest.e2e-spec.ts` continuing to import and exercise that exact same,
 * untouched `createGrpcMicroservice` export this file also imports — not re-proven here.
 *
 * **Kafka consumer-group**: `reward-entry-created.consumer.ts`'s own
 * `REWARD_ENTRY_CREATED_CONSUMER_GROUP` is one fixed, shared group id every real consumer this
 * project boots joins (`kafka-consumer.main.ts`, `test/modules/reward-ingestion/
 * cross-channel-parity.e2e-spec.ts`, `test/e2e/full-pipeline.e2e-spec.ts` all already join it with
 * no dedicated isolation lock) — this file follows that same, already-established precedent rather
 * than inventing a new one; each Kafka scenario below uses its own fresh, random dedup key so a
 * message delivered to a differently-timed consumer instance never causes a false positive.
 */
import 'reflect-metadata';

// T-INT-047. Deliberately BEFORE the `@/main` import below, not merely before
// `startHybridBootstrap()` is first called — `src/config/config.module.ts`'s own
// `NestConfigModule.forRoot({ validate: validateConfig, ... })` validates `process.env` **once**,
// synchronously, the moment `config.module.ts` is first `require`'d (that file's own header,
// T-RR-004/T-RR-050) — which happens transitively the instant this file's own `import {
// startHybridBootstrap, ... } from '@/main'` line below is evaluated, i.e. before ANY `it()` body
// in this file ever runs. `ConfigService.get('PORT', ...)` then always returns that ONE frozen,
// validated value for the rest of this file's own process lifetime — a later `process.env.PORT =
// ...` assignment inside `resetEnvToBaseline()` (below) has **no effect on it**, unlike every other
// env var this file resets, which every consuming module (`grpc-server.config.ts`,
// `kafka-consumer.main.ts`, `claim-worker.module.ts`, ...) reads directly and live from
// `process.env` instead (each of those files' own header already documents exactly why, for the
// identical reason `config.schema.ts` is deliberately NOT the source those files use). Confirmed
// empirically while implementing T-INT-047: this suite's own real HTTP listener always bound
// `.env.development`'s literal `PORT=3030`, never whatever `resetEnvToBaseline()` set — invisible
// as long as only one real-HTTP-listener-binding file existed in this whole suite, and a real,
// reproducible `EADDRINUSE :::3030` the moment a second one
// (`test/main/claim-worker-hybrid-gate.e2e-spec.ts`) was added and Jest scheduled both into
// different parallel workers at the same wall-clock moment.
//
// Not literally `PORT=0` — `config.schema.ts`'s own `PORT: z.coerce.number().int().positive()`
// rejects `0` at this same synchronous validation step (confirmed empirically: "PORT: Number must
// be greater than 0"), and `app.listen()`'s own real ephemeral-port assignment only happens
// *after* that validation already ran, so passing 0 through `config.schema.ts` is not an option
// here the way it would be calling `http.Server.listen(0)` directly. A random, fixed-range port
// number picked once at module-load time (never `getFreePort()`, which is inherently async and
// cannot run before a synchronous, module-load-time statement) is this file's own low-collision
// substitute — this file's own range (`52000-56999`) is disjoint from
// `test/main/claim-worker-hybrid-gate.e2e-spec.ts`'s own range, so the two real HTTP-listening
// files this suite now has can never collide with each other, and a collision against any other,
// unrelated real process on this machine is exceedingly unlikely (never zero, but no worse than
// `getFreePort()`'s own already-accepted residual TOCTOU risk was for every scenario except the
// specific two-file case this task's own evidence reproduced).
process.env.PORT = String(52_000 + Math.floor(Math.random() * 5_000));

import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import type { Sequelize } from 'sequelize';
import request from 'supertest';
import { startHybridBootstrap, HybridBootstrapError, type HybridBootstrapResult } from '@/main';
import { REWARD_ENTRY_CREATED_TOPIC } from '@/messaging/ingest/reward-entry-created.consumer';
import { TestCertAuthority, type IssuedCertificate } from '../grpc/support/test-cert-authority';
import {
  createTestClient,
  callSubmitRewardEntry,
  type RewardIngestServiceTestClient,
} from '../grpc/support/test-grpc-client';
import {
  getFreePort,
  waitForCondition,
  createMigrationDb,
  fetchRow,
  countEntryRows,
  cleanupEntry,
  buildCanonicalFixtureEntry,
  toGrpcRewardEntry,
  toKafkaMessageValue,
} from '../e2e/fixtures/reward-entry.fixtures';

jest.setTimeout(90_000);

let nextTenantId = 960_000 + Math.floor(Math.random() * 20_000);
function freshTenantId(): number {
  nextTenantId += 1;
  return nextTenantId;
}

/**
 * A test scenario that expects `startHybridBootstrap()` to SUCCEED must still never leak its
 * primary HTTP app if something unexpected throws instead (a `HybridBootstrapError` carries every
 * handle that DID start, including `httpApp`, specifically so a caller can clean up rather than
 * leaving a live listener/DB pool open for the rest of the Jest process's life — see `src/main.ts`'s
 * own header). Rethrows the original error either way so the test itself still fails normally.
 */
async function startExpectingSuccess(): Promise<HybridBootstrapResult> {
  try {
    return await startHybridBootstrap();
  } catch (error) {
    if (error instanceof HybridBootstrapError) {
      await error.partial.httpApp.close().catch(() => {});
    }
    throw error;
  }
}

function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

/**
 * Baseline env every scenario starts from: both T-INT-004 hybrid gates unset (= disabled), the
 * inbound gRPC server's own required-by-`config.schema.ts` vars set to placeholder, non-empty
 * strings that are never actually read unless a scenario also sets `GRPC_SERVER_ENABLED=true`
 * (`config.schema.ts` validates these four are non-empty on every boot, real transport or not —
 * `src/main.ts`'s own header explains why). `.env.development`'s own
 * `FIELD_ENCRYPTION_*`/`PORTAL_CONFIG_TENANT_IDS`/DB/Kafka-broker vars are left exactly as
 * `test/database/env.setup.ts` already loaded them — only what this task's own gates touch is
 * reset here.
 *
 * **T-INT-047 update.** `PORT` is no longer reset here — it moved to a single, module-load-time
 * `process.env.PORT = '0'` statement above this file's own `import { startHybridBootstrap, ... }
 * from '@/main'` line (see that statement's own comment for why: `ConfigService.get('PORT', ...)`
 * freezes its value the moment `config.module.ts` first loads, so a later per-`it()` reassignment
 * here had no effect on it). `GRPC_SERVER_PORT` below is unaffected by that same freeze —
 * `grpc-server.config.ts` reads it directly and live from `process.env`, never through
 * `ConfigService` (that file's own header) — so resetting it fresh, per test, here is still correct
 * and still needed (a real gRPC client dials that exact port number by value, TC-2/TC-4 below).
 */
async function resetEnvToBaseline(): Promise<void> {
  delete process.env.GRPC_SERVER_ENABLED;
  delete process.env.KAFKA_CONSUMER_ENABLED;
  process.env.GRPC_SERVER_PORT = String(await getFreePort());
  process.env.GRPC_SERVER_TLS_CA_PATH = './dev-certs/ca.pem';
  process.env.GRPC_SERVER_TLS_CERT_PATH = './dev-certs/server-cert.pem';
  process.env.GRPC_SERVER_TLS_KEY_PATH = './dev-certs/server-key.pem';
  process.env.GRPC_SERVER_ALLOWED_IDENTITIES = 'placeholder-identity:1';
}

describe('T-INT-004 — hybrid bootstrap (src/main.ts) (e2e, real Postgres, real Redpanda, real mTLS)', () => {
  // TC-1
  it('TC-1: with both gates unset, only the primary HTTP listener opens', async () => {
    await resetEnvToBaseline();

    const result = await startExpectingSuccess();
    try {
      expect(result.grpcApp).toBeNull();
      expect(result.kafkaConsumerContext).toBeNull();

      const health = await request(result.httpApp.getHttpServer()).get('/health');
      expect(health.status).toBe(200);

      // Confirm absence at the socket level too, not just "the handle is null".
      const grpcPort = Number(process.env.GRPC_SERVER_PORT);
      await expect(isPortOpen(grpcPort)).resolves.toBe(false);
    } finally {
      await result.httpApp.close();
    }
  });

  // TC-2
  it('TC-2: GRPC_SERVER_ENABLED=true starts a real, working mTLS gRPC listener', async () => {
    await resetEnvToBaseline();
    const tenantId = freshTenantId();

    const ca = TestCertAuthority.build();
    const grpcPort = await getFreePort();
    const identity = `rr-int004-tc2-${tenantId}`;
    process.env.GRPC_SERVER_ENABLED = 'true';
    process.env.GRPC_SERVER_PORT = String(grpcPort);
    process.env.GRPC_SERVER_TLS_CA_PATH = ca.caCertPath;
    process.env.GRPC_SERVER_TLS_CERT_PATH = ca.serverCertPath;
    process.env.GRPC_SERVER_TLS_KEY_PATH = ca.serverKeyPath;
    process.env.GRPC_SERVER_ALLOWED_IDENTITIES = `${identity}:${tenantId}`;

    const fixture = buildCanonicalFixtureEntry(tenantId);
    const db: Sequelize = createMigrationDb();
    const result = await startExpectingSuccess();
    let client: RewardIngestServiceTestClient | undefined;
    try {
      expect(result.grpcApp).not.toBeNull();
      expect(result.kafkaConsumerContext).toBeNull();

      const clientCert: IssuedCertificate = ca.issueClientCert(identity);
      const credentials = grpc.credentials.createSsl(
        readFileSync(ca.caCertPath),
        readFileSync(clientCert.keyPath),
        readFileSync(clientCert.certPath),
      );
      client = createTestClient(`127.0.0.1:${grpcPort}`, credentials);

      // A REAL response from a REAL listening server through this task's own hybrid bootstrap,
      // not a mocked transport.
      const response = await callSubmitRewardEntry(client, toGrpcRewardEntry(fixture));
      expect(response.rewardEntryId).toBe(fixture.id);
      expect(response.status).toBe('received');

      const row = await fetchRow(db, fixture.id);
      expect(row.ingestion_channel).toBe('GRPC');
    } finally {
      client?.close();
      await result.grpcApp?.close();
      await result.httpApp.close();
      ca.cleanup();
      await cleanupEntry(db, fixture.id);
      await db.close();
    }
  });

  // TC-3
  it('TC-3: KAFKA_CONSUMER_ENABLED=true consumes a real message from reward.entry.created.v1', async () => {
    await resetEnvToBaseline();
    const tenantId = freshTenantId();
    process.env.KAFKA_CONSUMER_ENABLED = 'true';

    const fixture = buildCanonicalFixtureEntry(tenantId);
    const db: Sequelize = createMigrationDb();
    let producer: Producer | undefined;
    try {
      const result = await startExpectingSuccess();
      try {
        expect(result.kafkaConsumerContext).not.toBeNull();
        expect(result.grpcApp).toBeNull();

        const kafka = new Kafka({
          clientId: 'rr-int004-tc3-producer',
          brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','),
          logLevel: logLevel.NOTHING,
        });
        producer = kafka.producer();
        await producer.connect();

        await producer.send({
          topic: REWARD_ENTRY_CREATED_TOPIC,
          messages: [{ key: fixture.customerId, value: toKafkaMessageValue(fixture) }],
        });

        await waitForCondition(async () => (await countEntryRows(db, fixture.id)) === 1, 30_000);

        const row = await fetchRow(db, fixture.id);
        expect(row.ingestion_channel).toBe('KAFKA');
      } finally {
        await result.kafkaConsumerContext?.close();
        await result.httpApp.close();
      }
    } finally {
      await producer?.disconnect();
      await cleanupEntry(db, fixture.id);
      await db.close();
    }
  }, 120_000);

  // TC-4
  it('TC-4: both gates enabled simultaneously come up in one process with no collision', async () => {
    await resetEnvToBaseline();
    const tenantId = freshTenantId();

    const ca = TestCertAuthority.build();
    const grpcPort = await getFreePort();
    const identity = `rr-int004-tc4-${tenantId}`;
    process.env.GRPC_SERVER_ENABLED = 'true';
    process.env.GRPC_SERVER_PORT = String(grpcPort);
    process.env.GRPC_SERVER_TLS_CA_PATH = ca.caCertPath;
    process.env.GRPC_SERVER_TLS_CERT_PATH = ca.serverCertPath;
    process.env.GRPC_SERVER_TLS_KEY_PATH = ca.serverKeyPath;
    process.env.GRPC_SERVER_ALLOWED_IDENTITIES = `${identity}:${tenantId}`;
    process.env.KAFKA_CONSUMER_ENABLED = 'true';

    const grpcFixture = buildCanonicalFixtureEntry(tenantId);
    const kafkaFixture = buildCanonicalFixtureEntry(tenantId);
    const db: Sequelize = createMigrationDb();
    let producer: Producer | undefined;
    let client: RewardIngestServiceTestClient | undefined;
    try {
      const result = await startExpectingSuccess();
      try {
        expect(result.grpcApp).not.toBeNull();
        expect(result.kafkaConsumerContext).not.toBeNull();

        // HTTP surface (both /health and the real REST ingestion route, already registered in
        // AppModule from Wave 1 onward — this task changes nothing about that wiring).
        const health = await request(result.httpApp.getHttpServer()).get('/health');
        expect(health.status).toBe(200);

        // gRPC surface.
        const clientCert: IssuedCertificate = ca.issueClientCert(identity);
        const credentials = grpc.credentials.createSsl(
          readFileSync(ca.caCertPath),
          readFileSync(clientCert.keyPath),
          readFileSync(clientCert.certPath),
        );
        client = createTestClient(`127.0.0.1:${grpcPort}`, credentials);
        const grpcResponse = await callSubmitRewardEntry(client, toGrpcRewardEntry(grpcFixture));
        expect(grpcResponse.status).toBe('received');

        // Kafka surface.
        const kafka = new Kafka({
          clientId: 'rr-int004-tc4-producer',
          brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','),
          logLevel: logLevel.NOTHING,
        });
        producer = kafka.producer();
        await producer.connect();
        await producer.send({
          topic: REWARD_ENTRY_CREATED_TOPIC,
          messages: [{ key: kafkaFixture.customerId, value: toKafkaMessageValue(kafkaFixture) }],
        });

        await waitForCondition(
          async () => (await countEntryRows(db, kafkaFixture.id)) === 1,
          30_000,
        );

        const grpcRow = await fetchRow(db, grpcFixture.id);
        expect(grpcRow.ingestion_channel).toBe('GRPC');
        const kafkaRow = await fetchRow(db, kafkaFixture.id);
        expect(kafkaRow.ingestion_channel).toBe('KAFKA');
      } finally {
        client?.close();
        await result.grpcApp?.close();
        await result.kafkaConsumerContext?.close();
        await result.httpApp.close();
      }
    } finally {
      await producer?.disconnect();
      ca.cleanup();
      await cleanupEntry(db, grpcFixture.id);
      await cleanupEntry(db, kafkaFixture.id);
      await db.close();
    }
  }, 120_000);

  // TC-5 (negative)
  it('TC-5: GRPC_SERVER_ENABLED=true with unreadable TLS material rejects, without silently downgrading', async () => {
    await resetEnvToBaseline();
    process.env.GRPC_SERVER_ENABLED = 'true';
    // Baseline's own GRPC_SERVER_TLS_* values point at files that do not exist on disk — the
    // "explicitly enabled, required config missing/invalid" case.

    let caught: HybridBootstrapError | undefined;
    try {
      await startHybridBootstrap();
      throw new Error('expected startHybridBootstrap() to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(HybridBootstrapError);
      caught = error as HybridBootstrapError;
    }

    try {
      expect(caught!.failures).toHaveLength(1);
      expect(caught!.failures[0].label).toContain('gRPC');
      expect(caught!.partial.grpcApp).toBeNull();
      expect(caught!.partial.kafkaConsumerContext).toBeNull();

      // The primary HTTP app must still be a real, live, working app — a misconfigured OPTIONAL
      // transport must never take the primary listener down with it (implementation note 4).
      expect(caught!.partial.httpApp).toBeDefined();
      const health = await request(caught!.partial.httpApp.getHttpServer()).get('/health');
      expect(health.status).toBe(200);
    } finally {
      await caught?.partial.httpApp.close();
    }
  });
});
