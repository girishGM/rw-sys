/**
 * T-PC-040. Shared system-level test harness for every spec under `test/e2e/**`. Boots this
 * service's three real, independently-deployable composition roots side by side against the same
 * real, already-migrated `promo_code` schema (root `CLAUDE.md`'s Postgres 16 server) and the same
 * real Redpanda broker (`testcontainers.config.ts`) — mirroring this service's actual production
 * topology exactly, not a single artificial "one process has everything" shape that doesn't exist
 * in production:
 *
 *  - **HTTP** (`AppModule` — `src/main.ts`'s own composition root): REST admin/bind endpoints,
 *    `PromoCodeGenerationService`, `OutboxPublisherModule`.
 *  - **gRPC** (`GrpcMicroserviceRootModule` — `src/grpc/grpc-server.main.ts`'s own composition
 *    root, T-PC-031): the mTLS `GenerateCode`/`ListActivePromoCodeConfigs` server, on its own real
 *    port with a real ephemeral CA (`test/grpc/support/test-cert-authority.ts`).
 *  - **Kafka** (`KafkaConsumerModule` — `src/messaging/kafka-consumer.main.ts`'s own composition
 *    root, T-PC-030): the real `GenerateRequestedConsumer`, actually connected and consuming.
 *
 * Three separate Nest DI containers, exactly as three separate OS processes would be in
 * production (`grpc-server.main.ts`'s own header: "running this as a second OS process... is a
 * legitimate, working deployment shape... folding it into a single hybrid process... is a
 * follow-up for `agent-promo-foundation`") — this harness does not invent a fourth, hybrid
 * composition root that has never actually been built or reviewed. State is shared the only way
 * production ever shares it: through the real Postgres database and the real Kafka broker, never
 * through in-memory references crossing container boundaries.
 *
 * **The outbox worker is deliberately never auto-started here** — `OUTBOX_PUBLISHER_AUTOSTART`
 * still resolves to its own `NODE_ENV=test` default (`outbox-publisher.config.ts`'s own header:
 * "every `*.e2e-spec.ts` in this project... never races a live poller against a real, global,
 * un-scoped `promo_code_outbox` query while another suite's own rows exist"). Specs that need a
 * result actually published use `withOutboxPump` below, which drives
 * `OutboxPublisherWorker.runOnce()` directly on its own short interval — the same
 * "tests can drive it deterministically instead of racing `setInterval`" discipline that worker's
 * own header already documents, just exercised here against a real broker instead of a mocked
 * producer.
 *
 * **T-PC-045 follow-through**: `withOutboxPump` now always drives `runOnce({ rowIds: [...] })`
 * scoped to the one outbox row its own caller's `tenantId`/`correlationId` resolves to, never a
 * bare unscoped `runOnce()` — T-PC-045 added `OutboxBatchScope` (`outbox.repository.ts`) precisely
 * so an e2e caller like this one stops reaching into every other concurrently-running suite's own
 * `PENDING` rows. Before the row exists yet (the consumer hasn't committed it), a tick is a no-op —
 * there is nothing this caller could own yet to scope to, and skipping is strictly safer than
 * falling back to an unscoped fetch. This closes the exact two failure modes T-PC-045's own filed
 * evidence and this task's own verification pass reproduced under a full, parallel `npm test`: a
 * different file's row being published before that file observed it `PENDING`
 * (`outbox-broker-outage.e2e-spec.ts` TC-6), and the same row being published twice because two
 * concurrent unscoped batches both fetched it before either marked it `PUBLISHED`
 * (`kafka-round-trip.e2e-spec.ts` TC-4/TC-8).
 *
 * Fixture provisioning (`createBoundConfig`) goes through the real REST endpoints
 * (`POST /api/v1/promo-code-configs`, `POST /api/v1/campaign-promo-configs`) exactly as
 * `reward-redemption-service`'s own operators would, per this task's implementation note 6 ("via
 * the real REST/service APIs, not direct SQL inserts that could drift from what the actual write
 * paths produce"). The one exception is `grpc_service_identity` (mTLS allowlist) — that table has
 * no REST surface at all (by design, `03-GRPC-CONTRACT.md` §3: an internal-only allowlist), so
 * this harness seeds it the same way `test/grpc/grpc-server.e2e-spec.ts` (T-PC-031) already does:
 * a direct `INSERT` through the real, least-privilege `promo_code_app` connection.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import type { INestApplication, INestMicroservice } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { NestFactory } from '@nestjs/core';
import * as grpc from '@grpc/grpc-js';
import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';

import { AppModule } from '@/app.module';
import { ConfigModule } from '@/config/config.module';
import { KafkaConsumerModule } from '@/messaging/kafka-consumer.module';
import { GenerateRequestedConsumer } from '@/messaging/generate-requested.consumer';
import { GrpcMicroserviceRootModule } from '@/grpc/grpc-server.main';
import { buildGrpcMicroserviceOptions } from '@/grpc/grpc-server.bootstrap';
import { OutboxPublisherWorker } from '@/modules/outbox/outbox-publisher.worker';

import { TestCertAuthority, type IssuedCertificate } from '../../grpc/support/test-cert-authority';
import {
  createTestClient,
  type PromoCodeServiceTestClient,
} from '../../grpc/support/test-grpc-client';
import { createAppTestConnection } from '../../config/support/app-connection';
import { KAFKA_BROKERS } from './testcontainers.config';

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `fn` until it returns a non-`null` value, or throws once `timeoutMs` elapses. The one
 * "wait for an asynchronous, cross-process effect to become observable" primitive every spec in
 * this suite is built on — the same shape `test/messaging/generate-requested.consumer.e2e-spec.ts`
 * (T-PC-030) already established.
 */
export async function pollUntil<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== null) {
      return result;
    }
    if (Date.now() > deadline) {
      throw new Error(`pollUntil: timed out after ${timeoutMs}ms`);
    }
    await wait(intervalMs);
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

/**
 * The one PK this task's own e2e suite ever needs to resolve `promo_code.promo_code_outbox.id`
 * from — the same `tenant_id`/`correlation_id` join `outbox-broker-outage.e2e-spec.ts`'s own local
 * `findOutboxRow` already uses, generalised here so `withOutboxPump` can scope every `runOnce()`
 * call it drives (T-PC-045) instead of reaching into the whole, globally-shared table.
 */
export async function findOutboxRowId(
  sequelize: Sequelize,
  tenantId: string,
  correlationId: string,
): Promise<string | null> {
  const rows = await sequelize.query<{ id: string }>(
    `SELECT o.id
       FROM promo_code.promo_code_outbox o
       JOIN promo_code.promo_code p ON p.id = o.promo_code_id
      WHERE p.tenant_id = :tenantId AND p.correlation_id = :correlationId`,
    { type: QueryTypes.SELECT, replacements: { tenantId, correlationId } },
  );
  return rows[0]?.id ?? null;
}

/**
 * Runs `fn` while `harness.outboxWorker.runOnce({ rowIds: [...] })` is driven repeatedly on a
 * short interval in the background, scoped to the single outbox row `tenantId`/`correlationId`
 * resolves to (T-PC-045) — for a spec that needs a real outbox row to actually reach `PUBLISHED`
 * without turning on the (deliberately disabled under `NODE_ENV=test`) autostart poller and
 * without ever touching a row this caller doesn't own (this file's own header). Until the row is
 * committed (the Kafka consumer hasn't processed the request yet), each tick is a no-op — there is
 * nothing yet to scope to, and an unscoped fallback would reintroduce exactly the race this
 * function exists to close. `runOnce()` failures are swallowed here exactly as
 * `OutboxPublisherWorker.start()`'s own real `setInterval` callback already swallows them (that
 * method's own header) — a mid-pump failure (e.g. TC-6's own broker outage) is expected, not a
 * defect in this harness.
 */
export async function withOutboxPump<T>(
  harness: Pick<E2ETestHarness, 'sequelize' | 'outboxWorker'>,
  tenantId: string,
  correlationId: string,
  fn: () => Promise<T>,
  intervalMs = 200,
): Promise<T> {
  let scopedRowId: string | null = null;
  const timer = setInterval(() => {
    void (async () => {
      if (!scopedRowId) {
        scopedRowId = await findOutboxRowId(harness.sequelize, tenantId, correlationId);
      }
      if (scopedRowId) {
        await harness.outboxWorker.runOnce({ rowIds: [scopedRowId] });
      }
    })().catch(() => undefined);
  }, intervalMs);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/** Consumes `topic` from the beginning until `matches` returns `true` for some message, or times
 * out. Every spec's own way of asserting "the published result", never just "the method was
 * called" (`AGENT-PROTOCOL.md` §3). */
export async function waitForKafkaMessage(
  topic: string,
  timeoutMs: number,
  matches: (key: string | null, value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const kafka = new Kafka({
    clientId: `t-pc-040-e2e-reader-${randomUUID()}`,
    brokers: KAFKA_BROKERS,
    logLevel: logLevel.NOTHING,
  });
  const consumer: Consumer = kafka.consumer({ groupId: `t-pc-040-e2e-${randomUUID()}` });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });

  let found: Record<string, unknown> | null = null;
  const runPromise = consumer.run({
    eachMessage: async ({ message }) => {
      if (found !== null || !message.value) {
        return;
      }
      const value = JSON.parse(message.value.toString()) as Record<string, unknown>;
      const key = message.key ? message.key.toString() : null;
      if (matches(key, value)) {
        found = value;
      }
    },
  });

  try {
    return await pollUntil(() => Promise.resolve(found), timeoutMs, 250);
  } finally {
    await consumer.stop();
    await consumer.disconnect();
    await runPromise.catch(() => undefined);
  }
}

/** Consumes `topic` from the beginning for the entire `windowMs`, collecting every message that
 * satisfies `matches` — unlike `waitForKafkaMessage` (which stops at the *first* match), this is
 * what TC-4/TC-8-style "exactly one, never a duplicate" assertions need: proving the *absence* of
 * a second matching message is only possible by watching the whole window, not by stopping early. */
export async function collectKafkaMessages(
  topic: string,
  windowMs: number,
  matches: (key: string | null, value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>[]> {
  const kafka = new Kafka({
    clientId: `t-pc-040-e2e-collector-${randomUUID()}`,
    brokers: KAFKA_BROKERS,
    logLevel: logLevel.NOTHING,
  });
  const consumer: Consumer = kafka.consumer({ groupId: `t-pc-040-e2e-collect-${randomUUID()}` });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });

  const found: Record<string, unknown>[] = [];
  const runPromise = consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) {
        return;
      }
      const value = JSON.parse(message.value.toString()) as Record<string, unknown>;
      const key = message.key ? message.key.toString() : null;
      if (matches(key, value)) {
        found.push(value);
      }
    },
  });

  await wait(windowMs);
  await consumer.stop();
  await consumer.disconnect();
  await runPromise.catch(() => undefined);
  return found;
}

export interface BoundConfigOverrides {
  name?: string;
  codePrefix?: string;
  codePostfix?: string;
  codeLength?: number;
  characterSet?: 'NUMERIC' | 'ALPHA' | 'ALPHANUMERIC';
  rewardValueType?: 'FIXED_AMOUNT' | 'PERCENTAGE' | 'POINTS';
  rewardValue?: number;
  rewardUnit?: string;
  merchantId?: string;
  codeExpiryDays?: number;
}

export interface BoundConfigFixture {
  tenantId: string;
  actorId: string;
  configId: string;
  bindRefId: string;
}

export class E2ETestHarness {
  private constructor(
    readonly app: INestApplication,
    readonly grpcApp: INestMicroservice,
    readonly grpcAddress: string,
    private readonly kafkaModuleRef: TestingModule,
    readonly kafkaConsumer: GenerateRequestedConsumer,
    readonly sequelize: Sequelize,
    readonly outboxWorker: OutboxPublisherWorker,
    private readonly ca: TestCertAuthority,
    private readonly allowedCert: IssuedCertificate,
    readonly producer: Producer,
    private readonly serviceIdentityIds: string[],
    private readonly tenantIds: string[],
  ) {}

  static async create(): Promise<E2ETestHarness> {
    const ca = TestCertAuthority.build();
    const grpcPort = await getFreePort();
    process.env.GRPC_PORT = String(grpcPort);
    process.env.GRPC_TLS_CA_PATH = ca.caCertPath;
    process.env.GRPC_TLS_CERT_PATH = ca.serverCertPath;
    process.env.GRPC_TLS_KEY_PATH = ca.serverKeyPath;
    delete process.env.GRPC_SERVER_ENABLED;

    const httpModuleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = httpModuleRef.createNestApplication();
    await app.init();
    const outboxWorker = httpModuleRef.get(OutboxPublisherWorker);

    const grpcOptions = buildGrpcMicroserviceOptions();
    if (grpcOptions === null) {
      throw new Error('E2ETestHarness: expected buildGrpcMicroserviceOptions() to return options');
    }
    const grpcApp = await NestFactory.createMicroservice(GrpcMicroserviceRootModule, grpcOptions);
    await grpcApp.listen();
    const grpcAddress = `localhost:${grpcPort}`;

    const kafkaModuleRef = await Test.createTestingModule({
      imports: [ConfigModule, KafkaConsumerModule],
    }).compile();
    await kafkaModuleRef.init();
    const kafkaConsumer = kafkaModuleRef.get(GenerateRequestedConsumer);
    await kafkaConsumer.start();

    const sequelize = createAppTestConnection();
    await sequelize.authenticate();

    // A fresh identity string per harness instance, never a shared constant — `npm test`'s
    // default multi-worker Jest run boots one `E2ETestHarness` per `test/e2e/*.e2e-spec.ts` file
    // *concurrently*, each against the same real Postgres database; a shared literal here would
    // make two of those harnesses race the same `INSERT` and one would lose to
    // `grpc_service_identity`'s own uniqueness constraint (observed directly: a real, reproducible
    // failure under plain `npm test`, fixed here rather than only ever run with `--runInBand`).
    // Kept short: an X.509 `CN` attribute is capped at 64 bytes, and `TestCertAuthority.issueClientCert`
    // puts this string directly there — a longer, more descriptive prefix overflowed that limit.
    const allowedIdentity = `t-pc-040-e2e-${randomUUID()}`;
    const allowedCert = ca.issueClientCert(allowedIdentity);
    const [identityRow] = await sequelize.query<{ id: string }>(
      `INSERT INTO promo_code.grpc_service_identity (service_identity, description, created_by)
         VALUES (:identity, 'T-PC-040 e2e harness', :actor) RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: { identity: allowedIdentity, actor: randomUUID() },
      },
    );

    const kafka = new Kafka({
      clientId: 't-pc-040-e2e-producer',
      brokers: KAFKA_BROKERS,
      logLevel: logLevel.NOTHING,
    });
    const producer = kafka.producer();
    await producer.connect();

    return new E2ETestHarness(
      app,
      grpcApp,
      grpcAddress,
      kafkaModuleRef,
      kafkaConsumer,
      sequelize,
      outboxWorker,
      ca,
      allowedCert,
      producer,
      [identityRow.id],
      [],
    );
  }

  freshTenant(): string {
    const tenantId = randomUUID();
    this.tenantIds.push(tenantId);
    return tenantId;
  }

  private authHeader(): [string, string] {
    return ['Authorization', `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`];
  }

  /**
   * Implementation note 6: provisions a tenant + `ACTIVE` `promo_code_config` +
   * `CAMPAIGN`-level binding entirely through the real REST endpoints this service ships, not a
   * direct SQL insert.
   */
  async createBoundConfig(overrides: BoundConfigOverrides = {}): Promise<BoundConfigFixture> {
    const tenantId = this.freshTenant();
    const actorId = randomUUID();

    const createResponse = await request(this.app.getHttpServer())
      .post('/api/v1/promo-code-configs')
      .set(...this.authHeader())
      .send({
        tenantId,
        actorId,
        merchantId: overrides.merchantId,
        name: overrides.name ?? `t-pc-040 e2e config ${randomUUID()}`,
        codePrefix: overrides.codePrefix ?? 'E2E-',
        codePostfix: overrides.codePostfix,
        codeLength: overrides.codeLength ?? 10,
        characterSet: overrides.characterSet ?? 'ALPHANUMERIC',
        excludeAmbiguousChars: true,
        rewardValueType: overrides.rewardValueType ?? 'FIXED_AMOUNT',
        rewardValue: overrides.rewardValue ?? 5,
        rewardUnit: overrides.rewardUnit ?? 'USD',
        maxRedemptionsPerCode: 1,
        codeExpiryDays: overrides.codeExpiryDays ?? 30,
      });
    if (createResponse.status !== 201) {
      throw new Error(
        `E2ETestHarness.createBoundConfig: config create failed (${createResponse.status}): ` +
          JSON.stringify(createResponse.body),
      );
    }
    const configId = createResponse.body.id as string;

    const bindRefId = randomUUID();
    const bindResponse = await request(this.app.getHttpServer())
      .post('/api/v1/campaign-promo-configs')
      .set(...this.authHeader())
      .send({
        promoCodeConfigId: configId,
        tenantId,
        bindLevel: 'CAMPAIGN',
        bindRefId,
        boundBy: actorId,
      });
    if (bindResponse.status !== 201) {
      throw new Error(
        `E2ETestHarness.createBoundConfig: bind failed (${bindResponse.status}): ` +
          JSON.stringify(bindResponse.body),
      );
    }

    return { tenantId, actorId, configId, bindRefId };
  }

  private grpcClientWith(cert: IssuedCertificate): PromoCodeServiceTestClient {
    const credentials = grpc.credentials.createSsl(
      readFileSync(this.ca.caCertPath),
      readFileSync(cert.keyPath),
      readFileSync(cert.certPath),
    );
    return createTestClient(this.grpcAddress, credentials);
  }

  /** A client presenting the certificate this harness's own allowlist seed grants. */
  allowedGrpcClient(): PromoCodeServiceTestClient {
    return this.grpcClientWith(this.allowedCert);
  }

  /** No client key/cert pair presented at all — only the CA, to verify the server certificate. */
  noCertGrpcClient(): PromoCodeServiceTestClient {
    const credentials = grpc.credentials.createSsl(readFileSync(this.ca.caCertPath));
    return createTestClient(this.grpcAddress, credentials);
  }

  async publishGenerateRequested(
    topic: string,
    correlationId: string,
    tenantId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const envelope = {
      eventId: randomUUID(),
      eventType: 'promo-code.generate.requested',
      eventVersion: '1.0',
      occurredAt: new Date().toISOString(),
      correlationId,
      tenantId,
      source: 'reward-redemption-service',
      data,
    };
    await this.producer.send({
      topic,
      messages: [{ key: correlationId, value: JSON.stringify(envelope) }],
    });
  }

  /** Cleans up every row this harness (or a spec using it) created, then closes every real
   * connection this harness opened — HTTP app, gRPC microservice, Kafka consumer/producer,
   * Postgres, and the ephemeral mTLS CA's temp directory. */
  async teardown(): Promise<void> {
    for (const tenantId of this.tenantIds) {
      await this.sequelize.query(
        `DELETE FROM promo_code.promo_code_outbox
           WHERE promo_code_id IN (SELECT id FROM promo_code.promo_code WHERE tenant_id = :tenantId)`,
        { replacements: { tenantId } },
      );
      await this.sequelize.query('DELETE FROM promo_code.promo_code WHERE tenant_id = :tenantId', {
        replacements: { tenantId },
      });
      await this.sequelize.query(
        'DELETE FROM promo_code.campaign_promo_config WHERE tenant_id = :tenantId',
        { replacements: { tenantId } },
      );
      await this.sequelize.query(
        `DELETE FROM promo_code.promo_code_config_audit
           WHERE promo_code_config_id IN (
             SELECT id FROM promo_code.promo_code_config WHERE tenant_id = :tenantId
           )`,
        { replacements: { tenantId } },
      );
      await this.sequelize.query(
        'DELETE FROM promo_code.promo_code_config WHERE tenant_id = :tenantId',
        { replacements: { tenantId } },
      );
    }
    if (this.serviceIdentityIds.length > 0) {
      await this.sequelize.query(
        'DELETE FROM promo_code.grpc_service_identity WHERE id IN (:ids)',
        {
          type: QueryTypes.RAW,
          replacements: { ids: this.serviceIdentityIds },
        },
      );
    }

    await this.producer.disconnect();
    await this.kafkaConsumer.stop();
    await this.kafkaModuleRef.close();
    await this.sequelize.close();
    await this.grpcApp.close();
    await this.app.close();
    this.ca.cleanup();
  }
}
