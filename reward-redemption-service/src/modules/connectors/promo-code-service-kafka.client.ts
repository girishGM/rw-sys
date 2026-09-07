/**
 * T-RR-081. `PromoCodeServiceKafkaClient` — the Kafka transport for `PromoCodeServiceConnector`'s
 * third channel: publishes `promo-code.generate.requested.v1` and runs the one shared,
 * process-wide consumer for `promo-code.generate.result.v1`
 * (`promo-code-service-plan/02-KAFKA-CONTRACTS.md` §2/§3/§5), feeding every arriving result into
 * `PromoCodeKafkaRequestReplyRegistry` so `requestAndAwaitReply()` below can present the whole
 * round trip to its one caller as an ordinary `Promise<PromoCodeGenerateResultData>` — this file's
 * own sibling registry file carries the full reasoning for that shape.
 *
 * **Register before publish, not the task file's own listed order.** The task file's own Scope
 * section lists the four responsibilities as "(1) publishes ... (2) registers ... (3) resolves
 * it ... (4) times out" — read as prose describing what this pair of files does, not as a literal
 * call-ordering requirement. This class registers the pending entry *first*, then publishes,
 * specifically to close the (admittedly tiny, but real) race where an extremely fast reply could
 * otherwise arrive before a pending entry existed to resolve — `PromoCodeKafkaRequestReplyRegistry
 * .resolveResult()` treats "no pending entry" identically whether the cause is a genuinely late
 * reply or a too-early one (TC-3), so getting this ordering right is the only way to guarantee a
 * fast, well-behaved round trip never gets misclassified as dropped.
 *
 * **One shared consumer, many pending callers** (implementation note 4): `start()` opens exactly
 * one long-lived kafkajs consumer in a stable, shared consumer group — mirroring
 * `RewardEntryCreatedConsumer`'s own convention (T-RR-012) — never one consumer per redemption
 * attempt. Unlike that consumer, this one uses kafkajs's own default auto-commit: there is no
 * durable write this handler must keep in lockstep with an offset (T-RR-012's own manual-commit
 * requirement exists because `ingest()` durably inserts a row; this handler only ever
 * resolves/drops an in-memory promise), and a redelivered result after a crash is already safe —
 * `resolveResult()` either resolves the same still-pending promise again (a no-op, since it was
 * already resolved and removed) or logs-and-drops it as "no pending entry" (TC-3), never a
 * double-anything.
 *
 * **`requestAndAwaitReply()` never falls back to REST/gRPC itself** — a publish failure (this
 * class's own transport-level condition, e.g. broker unreachable) is reported by throwing a plain
 * `Error` (not `PromoCodeKafkaReplyTimeoutError`); `PromoCodeServiceConnector` is the one place
 * that decides what either failure mode means for the outer `redeem()` call (this task's own
 * implementation note 3), never this class.
 */
import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import type { Config } from '@/config/config.schema';
import type { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import type { PromoCodeBindLevel } from './promo-code-service.connector.types';
import { PromoCodeKafkaRequestReplyRegistry } from './promo-code-kafka-request-reply.registry';

/** `promo-code-service-plan/02-KAFKA-CONTRACTS.md` §3 — produced by this service. */
export const PROMO_CODE_GENERATE_REQUESTED_TOPIC = 'promo-code.generate.requested.v1';
/** `promo-code-service-plan/02-KAFKA-CONTRACTS.md` §5 — consumed by this service. */
export const PROMO_CODE_GENERATE_RESULT_TOPIC = 'promo-code.generate.result.v1';

/** Fixed and stable across restarts, same "one shared group" convention
 * `REWARD_ENTRY_CREATED_CONSUMER_GROUP` already established (T-RR-012) — every running instance
 * of this service joins the SAME group, so Kafka's own partition-assignment protocol
 * load-balances this topic across however many instances are running. */
export const PROMO_CODE_GENERATE_RESULT_CONSUMER_GROUP =
  'reward-redemption-service-promo-code-kafka-reply';

/** `connectors.promoCode.kafkaReplyTimeoutMs` (T-RR-081 implementation note 5) — resolved with a
 * hardcoded fallback-with-warn-log exactly like every other as-yet-unseeded `service_config` key
 * in this plan (`dispatch.config.ts`'s own convention, T-RR-034 implementation note 1). */
export const DEFAULT_KAFKA_REPLY_TIMEOUT_MS = 10_000;

/** `promo-code-service-plan/02-KAFKA-CONTRACTS.md` §3's own `data` payload shape for the request
 * topic — deliberately its own type, distinct from `PromoCodeGenerateRequest` (the REST/gRPC wire
 * shape, `promo-code-service.connector.types.ts`): the Kafka contract's `data` never repeats
 * `correlationId`/`tenantId` (both live on the shared envelope instead, §2) and spells its
 * free-form context field `metadata` (an object), not REST's `metadataJson` (a pre-serialized
 * string) — confirmed by direct read of both contracts, not assumed identical. */
export interface PromoCodeGenerateRequestData {
  bindLevel: PromoCodeBindLevel;
  bindRefId: string;
  customerId: string;
  merchantId: string | null;
  activityContext: {
    amount: string;
    currency: string;
    metadata: Record<string, unknown>;
  };
}

/** `promo-code-service-plan/02-KAFKA-CONTRACTS.md` §5's own `data` payload shape for the result
 * topic — nullable fields exactly as that section's own worked example shows (`errorCode`/
 * `errorMessage: null` on `SUCCESS`), unlike the REST/gRPC `PromoCodeGenerateResponse`'s
 * always-present-empty-string convention (`promo-code-service.connector.types.ts`'s own header).
 * `PromoCodeServiceConnector.normalizeKafkaResultData` bridges the two so `classifyGenerateResponseBody`
 * has exactly one shape to classify regardless of transport. */
export interface PromoCodeGenerateResultData {
  status: 'SUCCESS' | 'FAILED';
  promoCodeId: string | null;
  code: string | null;
  rewardValueType: string | null;
  rewardValue: string | null;
  rewardUnit: string | null;
  expiresAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

interface KafkaEnvelope<T> {
  eventId: string;
  eventType: string;
  eventVersion: string;
  occurredAt: string;
  correlationId: string;
  tenantId: string;
  source: string;
  data: T;
}

/** `02-KAFKA-CONTRACTS.md` §2's own common envelope, shared by every topic in that document. */
function buildEnvelope<T>(
  eventType: string,
  correlationId: string,
  tenantId: string,
  data: T,
): KafkaEnvelope<T> {
  return {
    eventId: randomUUID(),
    eventType,
    eventVersion: '1.0',
    occurredAt: new Date().toISOString(),
    correlationId,
    tenantId,
    source: 'reward-redemption-service',
    data,
  };
}

function brokersFrom(configService: ConfigService<Config, true>): string[] {
  return configService
    .get('KAFKA_BROKERS', { infer: true })
    .split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
}

/** The one typed method this client actually needs off `ServiceConfigResolverService` — same
 * narrow-structural-type discipline `dispatch.config.ts`'s own `DispatchServiceConfigResolver`
 * established, so a test can pass a lightweight fake instead of the real class. */
export type PromoCodeKafkaServiceConfigResolver = Pick<ServiceConfigResolverService, 'resolve'>;

@Injectable()
export class PromoCodeServiceKafkaClient implements OnModuleDestroy {
  private readonly logger = new Logger(PromoCodeServiceKafkaClient.name);
  private readonly registry = new PromoCodeKafkaRequestReplyRegistry<PromoCodeGenerateResultData>();

  private producer: Producer | null = null;
  private connectingProducer: Promise<void> | null = null;
  private consumer: Consumer | null = null;

  constructor(
    private readonly config: ConfigService<Config, true>,
    private readonly serviceConfig: PromoCodeKafkaServiceConfigResolver,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.stop();
    const producer = this.producer;
    this.producer = null;
    if (producer) {
      await producer.disconnect();
    }
  }

  /**
   * Registers a pending reply (before publishing — this file's own header), publishes the
   * request, and returns the eventual result. Throws a plain `Error` if the *publish itself*
   * fails (a transport-level condition — the request was never sent) — never
   * `PromoCodeKafkaReplyTimeoutError` for that case, which is reserved for "sent successfully, no
   * reply arrived in time." `PromoCodeServiceConnector` distinguishes the two by error type.
   */
  async requestAndAwaitReply(
    correlationId: string,
    tenantId: string,
    data: PromoCodeGenerateRequestData,
  ): Promise<PromoCodeGenerateResultData> {
    const timeoutMs = await this.resolveTimeoutMs();
    const resultPromise = this.registry.register(correlationId, timeoutMs);
    // Defensive only: if `publish()` below throws, `cancel()` rejects this same promise
    // immediately (never left to leak until the timer fires) — nothing else ever awaits it in
    // that branch, so without this no-op handler Node would report an unhandled rejection.
    resultPromise.catch(() => undefined);

    try {
      await this.publish(correlationId, tenantId, data);
    } catch (error) {
      const asError = error instanceof Error ? error : new Error(String(error));
      this.registry.cancel(correlationId, asError);
      this.logger.warn(
        `PromoCodeServiceKafkaClient publish failed for correlationId ${correlationId}: ${asError.message}`,
      );
      throw asError;
    }

    return resultPromise;
  }

  private async resolveTimeoutMs(): Promise<number> {
    try {
      return (await this.serviceConfig.resolve(
        'connectors.promoCode.kafkaReplyTimeoutMs',
        'int',
      )) as number;
    } catch {
      this.logger.warn(
        'service_config key "connectors.promoCode.kafkaReplyTimeoutMs" is not seeded for this ' +
          `context — using default ${DEFAULT_KAFKA_REPLY_TIMEOUT_MS}ms.`,
      );
      return DEFAULT_KAFKA_REPLY_TIMEOUT_MS;
    }
  }

  private async connectProducer(): Promise<void> {
    if (this.producer) {
      return;
    }
    if (this.connectingProducer) {
      return this.connectingProducer;
    }
    const kafka = new Kafka({
      clientId: 'reward-redemption-service-promo-code-kafka-connector',
      brokers: brokersFrom(this.config),
      logLevel: logLevel.NOTHING,
      retry: { retries: 0 },
      connectionTimeout: 3_000,
    });
    const producer = kafka.producer();
    this.connectingProducer = producer
      .connect()
      .then(() => {
        this.producer = producer;
      })
      .finally(() => {
        this.connectingProducer = null;
      });
    await this.connectingProducer;
  }

  private async publish(
    correlationId: string,
    tenantId: string,
    data: PromoCodeGenerateRequestData,
  ): Promise<void> {
    await this.connectProducer();
    if (!this.producer) {
      throw new Error('PromoCodeServiceKafkaClient: producer failed to connect');
    }
    const envelope = buildEnvelope('promo-code.generate.requested', correlationId, tenantId, data);
    await this.producer.send({
      topic: PROMO_CODE_GENERATE_REQUESTED_TOPIC,
      messages: [{ key: correlationId, value: JSON.stringify(envelope) }],
    });
  }

  /**
   * Starts the one shared `promo-code.generate.result.v1` consumer (implementation note 4).
   * Idempotent — a second call while already running is a no-op. Not autostarted from any
   * lifecycle hook (same "module construction, including a test's own `Test.createTestingModule`,
   * must never open a real broker connection" convention `RewardEntryCreatedConsumer.onModuleInit`
   * documents) — wiring a real caller of this method into a running process is out of this task's
   * own scope (`AGENT-PROTOCOL.md` R3: `src/main.ts`/standalone bootstrap entry points are not in
   * this task's "Files owned" list).
   */
  async start(): Promise<void> {
    if (this.consumer) {
      return;
    }
    const kafka = new Kafka({
      clientId: 'reward-redemption-service-promo-code-kafka-reply-consumer',
      brokers: brokersFrom(this.config),
      logLevel: logLevel.NOTHING,
    });
    const consumer = kafka.consumer({ groupId: PROMO_CODE_GENERATE_RESULT_CONSUMER_GROUP });
    await consumer.connect();
    await consumer.subscribe({ topic: PROMO_CODE_GENERATE_RESULT_TOPIC, fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ message }) => {
        this.handleResultMessage(message.value ? message.value.toString() : null);
      },
    });
    this.consumer = consumer;
  }

  async stop(): Promise<void> {
    const consumer = this.consumer;
    this.consumer = null;
    if (consumer) {
      await consumer.disconnect();
    }
  }

  /**
   * The one entry point both the real kafkajs `eachMessage` loop (above) and this task's own test
   * suite drive directly (`AGENT-PROTOCOL.md` §3: "assert the observable property"). A malformed
   * message (unparseable JSON, missing `correlationId`, an unrecognized `data.status`) is logged
   * and dropped — never thrown — so one poison message on this topic can never crash the shared
   * consumer and strand every other still-pending redemption (the same robustness TC-3 requires
   * for a merely-late result, extended here to a merely-malformed one).
   */
  handleResultMessage(raw: string | null): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw ?? '');
    } catch (error) {
      this.logger.warn(
        `PromoCodeServiceKafkaClient: unparseable ${PROMO_CODE_GENERATE_RESULT_TOPIC} message, ` +
          `dropped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      this.logger.warn(
        `PromoCodeServiceKafkaClient: ${PROMO_CODE_GENERATE_RESULT_TOPIC} message is not an ` +
          'object, dropped.',
      );
      return;
    }

    const envelope = parsed as Partial<KafkaEnvelope<Partial<PromoCodeGenerateResultData>>>;
    const correlationId = envelope.correlationId;
    const data = envelope.data;
    if (typeof correlationId !== 'string' || correlationId.length === 0) {
      this.logger.warn(
        `PromoCodeServiceKafkaClient: ${PROMO_CODE_GENERATE_RESULT_TOPIC} message missing a ` +
          'string correlationId, dropped.',
      );
      return;
    }
    if (!data || (data.status !== 'SUCCESS' && data.status !== 'FAILED')) {
      this.logger.warn(
        `PromoCodeServiceKafkaClient: ${PROMO_CODE_GENERATE_RESULT_TOPIC} message for ` +
          `correlationId ${correlationId} has an unrecognized data.status, dropped.`,
      );
      return;
    }

    this.registry.resolveResult(correlationId, {
      status: data.status,
      promoCodeId: data.promoCodeId ?? null,
      code: data.code ?? null,
      rewardValueType: data.rewardValueType ?? null,
      rewardValue: data.rewardValue ?? null,
      rewardUnit: data.rewardUnit ?? null,
      expiresAt: data.expiresAt ?? null,
      errorCode: data.errorCode ?? null,
      errorMessage: data.errorMessage ?? null,
    });
  }
}
