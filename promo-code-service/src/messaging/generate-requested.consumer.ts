/**
 * T-PC-030. The Kafka consumer for `promo-code.generate.requested.v1` — a thin adapter over
 * `PromoCodeGenerationService` (T-PC-021), nothing else (R10, `ARCHITECTURE.md` §6's own framing
 * of Wave 2/3's "one non-negotiable architectural rule"). `processMessage` does exactly three
 * things per implementation note 1: validate/deserialize, call
 * `promoCodeGenerationService.generateCode({...mapped fields, transport: 'KAFKA'})`, and
 * acknowledge/DLQ based on whether deserialization succeeded — it never itself decides
 * `CONFIG_NOT_BOUND` vs. retries a collision; those decisions already happened inside T-PC-021 by
 * the time this adapter's call returns (TC-14: code inspection finds no such symbol here).
 *
 * **DLQ is strictly for poison messages** (implementation note 2, `02-KAFKA-CONTRACTS.md` §6): a
 * `FAILED` result from `generateCode()` (`CONFIG_NOT_BOUND`, `CONFIG_INACTIVE`,
 * `GENERATION_EXHAUSTED`, `INVALID_REQUEST`) is a completely normal, successfully-processed
 * outcome — acknowledged like `SUCCESS`, never retried, never DLQ'd (TC-6/TC-7). Only a message
 * that throws before `generateCode()` returns (malformed JSON, a missing required envelope field,
 * TC-3/TC-4) — or a transient failure `generateCode()` itself throws, e.g. a DB blip (TC-12) — is
 * a DLQ candidate, and only after `MAX_PROCESSING_ATTEMPTS` bounded retries with exponential
 * backoff (implementation note 3, `02-KAFKA-CONTRACTS.md` §6) are exhausted (TC-13).
 *
 * `processMessage` never throws — every outcome (`'ACK'` or `'DLQ'`) is a return value, so both
 * the real kafkajs `eachMessage` loop (`start()`, below) and this task's own test suite can drive
 * the identical method without a try/catch of their own. kafkajs auto-commits the consumer's
 * offset once `eachMessage`'s callback resolves without throwing, so every message — whichever
 * outcome it reaches — is acknowledged exactly once (never redelivered by this adapter's own
 * choice; only a real consumer crash mid-processing can still redeliver, TC-9, which is exactly
 * the idempotent-retry case T-PC-021 already owns).
 *
 * Partition key (`correlationId`, implementation note 4, `02-KAFKA-CONTRACTS.md` §3) is entirely a
 * producer-side (reward-redemption-service, not built here) concern; this consumer's only own
 * responsibility toward that guarantee is correct consumer-group configuration
 * (`GENERATE_REQUESTED_CONSUMER_GROUP`) and processing each partition's messages sequentially
 * (kafkajs's own `eachMessage` already guarantees in-partition ordering — nothing extra needed
 * here to preserve it).
 *
 * **T-PC-047.** `processMessage` runs its entire body inside `CorrelationContextService.run(...)`,
 * so every log line for a given message — including the retry/backoff warnings and the final DLQ
 * error, not just whatever `PromoCodeGenerationService` itself logs — carries a `correlationId`.
 * The context is seeded *before* the authoritative parse/validate loop below even runs (best
 * effort, tolerant of a completely malformed payload): `raw.key` is this producer's own partition
 * key, which is always `correlationId` by convention (implementation note 4 above); a best-effort
 * `JSON.parse` of `raw.value` refines that to the envelope's own `correlationId`/`tenantId` when the
 * payload happens to be well-formed JSON with those fields, even if envelope/payload *validation*
 * (the authoritative kind, below) later fails. Deliberately a single top-level wrap, not a nested
 * one per retry attempt — `CorrelationContextService.run`'s context is fixed for its whole callback,
 * and re-parsing per attempt would only ever recompute the identical value. One entry-point log
 * line is emitted as soon as the context is established, same discipline
 * `correlation-context.middleware.ts` documents for the HTTP transport ("a request that touches no
 * other logger call site still has at least one structured line to grep by correlationId") — the
 * Kafka/gRPC "once wired" follow-up that middleware's own header explicitly flags this task as
 * closing.
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, logLevel, type Consumer, type EachMessagePayload } from 'kafkajs';
import { PromoCodeGenerationService } from '../modules/generation/promo-code-generation.service';
import {
  CorrelationContextService,
  type CorrelationContext,
} from '../observability/logging/correlation-context.service';
import { DlqProducerService } from './dlq-producer.service';
import { parseEnvelope } from './envelope.schema';
import { parseGenerateRequestedPayload } from './generate-requested-payload.schema';
import {
  GENERATE_REQUESTED_CONSUMER_GROUP,
  GENERATE_REQUESTED_DLQ_TOPIC,
  GENERATE_REQUESTED_TOPIC,
  MAX_PROCESSING_ATTEMPTS,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
} from './kafka-consumer.config';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The one shape both the real kafkajs message and this suite's synthetic ones share. */
export interface RawKafkaMessage {
  key: string | null;
  value: string | null;
}

export type ProcessOutcome = 'ACK' | 'DLQ';

@Injectable()
export class GenerateRequestedConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GenerateRequestedConsumer.name);
  private consumer: Consumer | null = null;

  constructor(
    private readonly generationService: PromoCodeGenerationService,
    private readonly dlqProducer: DlqProducerService,
    private readonly configService: ConfigService,
    @Inject(RETRY_BACKOFF_BASE_MS) private readonly backoffBaseMs: number,
    @Inject(RETRY_BACKOFF_MAX_MS) private readonly backoffMaxMs: number,
    private readonly correlationContext: CorrelationContextService,
  ) {}

  /**
   * Deliberately a no-op. `KafkaConsumerModule` may be composed by a test's own
   * `Test.createTestingModule` (which must never open a real broker connection just from module
   * construction — same "boot must not depend on broker reachability" discipline
   * `kafka-producer.service.ts`'s own header documents for a different mechanism); only
   * `kafka-consumer.main.ts`'s standalone bootstrap ever calls `start()`, gated by its own
   * `KAFKA_CONSUMER_ENABLED` rollback lever.
   */
  onModuleInit(): void {
    // No autostart path — see this method's own comment above.
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Starts the real kafkajs consumer loop. Only ever called from `kafka-consumer.main.ts`. */
  async start(): Promise<void> {
    if (this.consumer) {
      return;
    }
    const brokers = String(this.configService.get<string>('KAFKA_BROKERS') ?? '')
      .split(',')
      .map((broker) => broker.trim())
      .filter(Boolean);
    const kafka = new Kafka({
      clientId: 'promo-code-service-generate-requested-consumer',
      brokers,
      logLevel: logLevel.NOTHING,
    });
    const consumer = kafka.consumer({ groupId: GENERATE_REQUESTED_CONSUMER_GROUP });
    await consumer.connect();
    await consumer.subscribe({ topic: GENERATE_REQUESTED_TOPIC, fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ message }: EachMessagePayload) => {
        await this.processMessage({
          key: message.key ? message.key.toString() : null,
          value: message.value ? message.value.toString() : null,
        });
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
   * suite drive directly (`AGENT-PROTOCOL.md` §3: "assert the observable property" — exercising
   * this exact method is what proves TC-1..TC-14). Bounded retry wraps the *entire* pipeline
   * (parse → validate envelope → validate payload → `generateCode()`) uniformly — implementation
   * note 3: "use the same schema validation for the retry attempts as the first attempt" — so a
   * transient `generateCode()` failure (TC-12) and a deterministic schema failure (TC-3/TC-4) both
   * go through the identical bounded-retry-then-DLQ path.
   */
  async processMessage(raw: RawKafkaMessage): Promise<ProcessOutcome> {
    return this.correlationContext.run(this.buildBestEffortContext(raw), () => {
      this.logger.log(`${GENERATE_REQUESTED_TOPIC} message received`);
      return this.processMessageWithContext(raw);
    });
  }

  /**
   * Best-effort `correlationId`/`tenantId` for logging purposes only — never used for anything
   * that affects the actual processing/retry/DLQ decision below, which always re-derives its own
   * authoritative values from `parseEnvelope`/`parseGenerateRequestedPayload`. Tolerant of
   * completely malformed JSON (TC-4's own scenario): a parse failure here just leaves the context
   * at `raw.key`-only (or `''`, if even the key is absent), rather than throwing before the real
   * retry loop gets a chance to run.
   */
  private buildBestEffortContext(raw: RawKafkaMessage): CorrelationContext {
    let correlationId = raw.key ?? '';
    let tenantId: string | undefined;
    try {
      const parsed: unknown = JSON.parse(raw.value ?? '');
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const candidate = parsed as Record<string, unknown>;
        if (typeof candidate.correlationId === 'string' && candidate.correlationId.length > 0) {
          correlationId = candidate.correlationId;
        }
        if (typeof candidate.tenantId === 'string') {
          tenantId = candidate.tenantId;
        }
      }
    } catch {
      // Best-effort only — see this method's own header comment.
    }
    return { correlationId, tenantId, transport: 'KAFKA', rpc: GENERATE_REQUESTED_TOPIC };
  }

  private async processMessageWithContext(raw: RawKafkaMessage): Promise<ProcessOutcome> {
    let lastErrorMessage = 'unknown error';
    let bestEffortEnvelope: Record<string, unknown> | null = null;

    for (let attempt = 1; attempt <= MAX_PROCESSING_ATTEMPTS; attempt += 1) {
      try {
        const parsedJson: unknown = JSON.parse(raw.value ?? '');
        if (typeof parsedJson === 'object' && parsedJson !== null && !Array.isArray(parsedJson)) {
          bestEffortEnvelope = parsedJson as Record<string, unknown>;
        }

        const envelopeResult = parseEnvelope(parsedJson);
        if (!envelopeResult.ok) {
          throw new Error(envelopeResult.message);
        }
        const envelope = envelopeResult.data;

        const payloadResult = parseGenerateRequestedPayload(envelope.data);
        if (!payloadResult.ok) {
          throw new Error(payloadResult.message);
        }
        const payload = payloadResult.data;

        await this.generationService.generateCode({
          correlationId: envelope.correlationId,
          tenantId: envelope.tenantId,
          bindLevel: payload.bindLevel,
          bindRefId: payload.bindRefId,
          customerId: payload.customerId,
          merchantId: payload.merchantId ?? null,
          transport: 'KAFKA',
          activityContext: payload.activityContext ?? null,
        });
        // TC-6/TC-7: whatever `generateCode()` decided (SUCCESS or a business FAILED) is a
        // completely normal, successfully-processed outcome from this adapter's own point of
        // view — acknowledged, never retried, never DLQ'd.
        return 'ACK';
      } catch (error) {
        lastErrorMessage = error instanceof Error ? error.message : String(error);
        if (attempt < MAX_PROCESSING_ATTEMPTS) {
          const backoffMs = Math.min(this.backoffBaseMs * 2 ** (attempt - 1), this.backoffMaxMs);
          this.logger.warn(
            `generate.requested processing failed (attempt ${attempt}/${MAX_PROCESSING_ATTEMPTS}), ` +
              `retrying in ${backoffMs}ms: ${lastErrorMessage}`,
          );
          await wait(backoffMs);
        }
      }
    }

    this.logger.error(
      `generate.requested message routed to DLQ after ${MAX_PROCESSING_ATTEMPTS} attempts: ${lastErrorMessage}`,
    );
    // Implementation note 5: preserve the original envelope+data untouched. `bestEffortEnvelope`
    // is the last successfully-`JSON.parse`d object seen across attempts (even one that failed
    // envelope/payload validation) — for a message that never parsed as JSON at all (TC-4), there
    // is no envelope to preserve, so the raw original string is embedded verbatim under `raw`
    // instead (best-effort equivalent for an unparseable payload — flagged in the completion
    // report's "Deviations from spec").
    await this.dlqProducer.publish(GENERATE_REQUESTED_DLQ_TOPIC, raw.key, {
      ...(bestEffortEnvelope ?? { raw: raw.value }),
      error: lastErrorMessage,
      failedAt: new Date().toISOString(),
    });
    return 'DLQ';
  }
}
