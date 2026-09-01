/**
 * T-PC-030. Topic/consumer-group names and retry/backoff tuning for the `generate.requested`
 * consumer (`02-KAFKA-CONTRACTS.md` §3/§6). `KAFKA_BROKERS` itself is already a required key in
 * the shared `src/config/config.schema.ts` (T-PC-001, extended by T-PC-022's own header) — read
 * via `ConfigService` in `kafka-consumer.module.ts`/`generate-requested.consumer.ts`, never
 * re-declared here. Everything in this file is either a fixed protocol constant (topic names,
 * consumer group, retry count — §3/§6's own exact values, never environment-overridable) or an
 * optional tuning knob with a safe default (backoff timing), same "optional tuning knob vs.
 * required secret" split `outbox-publisher.config.ts` (T-PC-022) established — this file
 * deliberately never extends `src/config/config.schema.ts`'s required-env Zod schema, since
 * `src/config/**` remains outside this agent's own delegated scope (`project.config.json`, R8).
 */

/** `02-KAFKA-CONTRACTS.md` §3. */
export const GENERATE_REQUESTED_TOPIC = 'promo-code.generate.requested.v1';

/** `02-KAFKA-CONTRACTS.md` §6. */
export const GENERATE_REQUESTED_DLQ_TOPIC = 'promo-code.generate.requested.v1.dlq';

/** `02-KAFKA-CONTRACTS.md` §3. */
export const GENERATE_REQUESTED_CONSUMER_GROUP = 'promo-code-service.generate-requested';

/**
 * `02-KAFKA-CONTRACTS.md` §6: "bounded retry (3 attempts, exponential backoff)" — a fixed
 * protocol value (implementation note 3: "not a different number improvised at implementation
 * time, exactly 3 attempts"), never environment-overridable, unlike the outbox worker's own
 * tunables.
 */
export const MAX_PROCESSING_ATTEMPTS = 3;

/** DI token: base delay (ms) for the exponential backoff between processing attempts. */
export const RETRY_BACKOFF_BASE_MS = Symbol('KAFKA_CONSUMER_RETRY_BACKOFF_BASE_MS');
export const DEFAULT_RETRY_BACKOFF_BASE_MS = 200;

/** DI token: upper bound (ms) the exponential backoff is clamped to. */
export const RETRY_BACKOFF_MAX_MS = Symbol('KAFKA_CONSUMER_RETRY_BACKOFF_MAX_MS');
export const DEFAULT_RETRY_BACKOFF_MAX_MS = 5_000;

/**
 * Whether the standalone consumer process (`kafka-consumer.main.ts`) actually connects and starts
 * consuming — this task's own Rollback lever ("Stop the Kafka consumer microservice listener
 * (config flag)"), same `GRPC_SERVER_ENABLED`/`OUTBOX_PUBLISHER_AUTOSTART` convention already
 * established for this project. Read directly from `process.env` in `kafka-consumer.main.ts` (not
 * through `ConfigService`), same reasoning `grpc-server.main.ts`/`grpc-server.config.ts` already
 * established for this agent's own standalone entry points.
 */
export const KAFKA_CONSUMER_ENABLED_ENV_VAR = 'KAFKA_CONSUMER_ENABLED';

/**
 * T-PC-048. `codes_generated_total`/`promo_code_generation_duration_seconds` only reflect real
 * generation once `KafkaConsumerModule` imports `MetricsModule` (see that module's own T-PC-048
 * note) — but that instrumentation is useless to an operator unless *this* process's own
 * `GET /metrics` is reachable: `KafkaConsumerRootModule` bootstrapped via
 * `NestFactory.createApplicationContext` before this task, which has no HTTP listener (or any
 * listener) at all, so a scraper aimed only at the HTTP `AppModule` process never saw a
 * Kafka-originated generation (the defect this task fixes — see `kafka-consumer.main.ts`'s own
 * header). `KAFKA_METRICS_PORT` (default 9102, distinct from the HTTP `AppModule`'s own default
 * `PORT` 3010 and the gRPC process's own `GRPC_METRICS_PORT` default 9101, so all three can run on
 * one dev machine at once without colliding) is this process's own metrics HTTP port.
 */
export const DEFAULT_KAFKA_METRICS_PORT = 9102;

export function parseKafkaMetricsPort(): number {
  const raw = process.env.KAFKA_METRICS_PORT;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_KAFKA_METRICS_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid Kafka consumer configuration: KAFKA_METRICS_PORT must be a positive integer, got "${raw}"`,
    );
  }
  return parsed;
}

/**
 * `KAFKA_METRICS_ENABLED` (default enabled) — this task's own Rollback lever, same
 * `KAFKA_CONSUMER_ENABLED` convention above: set to `"false"` to keep the Kafka consumer itself
 * running while turning off just its `GET /metrics` HTTP listener, with nothing left to tear down
 * separately (no socket is ever opened).
 */
export function isKafkaMetricsListenerEnabled(): boolean {
  return process.env.KAFKA_METRICS_ENABLED !== 'false';
}
