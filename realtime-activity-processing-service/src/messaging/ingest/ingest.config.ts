/**
 * T-RAP-023. Topic/consumer-group names and retry/backoff tuning for the `activity.ingest.v1`
 * consumer (`02-KAFKA-CONTRACTS.md` §1/§2). Fixed protocol constants (topic names, consumer
 * group id, retry count) are never environment-overridable — same "fixed protocol value vs.
 * optional tuning knob" split `promo-code-service`'s own `kafka-consumer.config.ts` (T-PC-030)
 * already established for the sibling project, reused here for the identical reason. Deliberately
 * never extends `src/config/config.schema.ts`'s required-env Zod schema — `src/config/**` is
 * outside this agent's own delegated scope (`project.config.json`, `AGENT-PROTOCOL.md` R8's
 * "optional tuning knob, not a required secret" carve-out).
 *
 * **`ACTIVITY_INGEST_CONSUMER_GROUP` is the one deliberate difference from T-RAP-011's own
 * `WatchStreamConsumer`** (task Objective/implementation note 1): a single, fixed, shared
 * consumer group id — every running instance of this service joins the SAME group, so Kafka's own
 * partition-assignment protocol load-balances `activity.ingest.v1` across however many instances
 * are running (each message processed exactly once *total*, `02-KAFKA-CONTRACTS.md` §1), the
 * deliberate opposite of `WatchStreamConsumer`'s broadcast/per-instance-unique group id
 * (`04-CACHE-INVALIDATION.md` §1: "every open stream gets every event pushed to it directly").
 */

/** `02-KAFKA-CONTRACTS.md` §1. */
export const ACTIVITY_INGEST_TOPIC = 'activity.ingest.v1';

/** `02-KAFKA-CONTRACTS.md` §2. */
export const ACTIVITY_INGEST_DLQ_TOPIC = 'activity.ingest.dlq.v1';

/**
 * Fixed and stable across restarts (task implementation note 1) — never per-instance-unique.
 */
export const ACTIVITY_INGEST_CONSUMER_GROUP = 'realtime-activity-processing-ingest';

/**
 * "retried a bounded number of times (consumer-side)" (task Objective, implementation note 3) —
 * a fixed protocol value, same discipline `promo-code-service`'s own `MAX_PROCESSING_ATTEMPTS`
 * documents ("not a different number improvised at implementation time").
 */
export const MAX_PROCESSING_ATTEMPTS = 3;

/** DI token: base delay (ms) for the exponential backoff between processing attempts. */
export const RETRY_BACKOFF_BASE_MS = Symbol('ACTIVITY_INGEST_RETRY_BACKOFF_BASE_MS');
export const DEFAULT_RETRY_BACKOFF_BASE_MS = 200;

/** DI token: upper bound (ms) the exponential backoff is clamped to. */
export const RETRY_BACKOFF_MAX_MS = Symbol('ACTIVITY_INGEST_RETRY_BACKOFF_MAX_MS');
export const DEFAULT_RETRY_BACKOFF_MAX_MS = 5_000;

/**
 * Whether the standalone consumer process (`activity-ingest-consumer.main.ts`) actually connects
 * and starts consuming — same `GRPC_SERVER_ENABLED`/`KAFKA_CONSUMER_ENABLED` rollback-lever
 * convention already established across this repo (`grpc-server.config.ts`,
 * `promo-code-service`'s own `kafka-consumer.config.ts`). Read directly from `process.env` in
 * `activity-ingest-consumer.main.ts` (not through `ConfigService`), same reasoning
 * `grpc-server.main.ts` already established for this agent's own standalone entry points.
 */
export const ACTIVITY_INGEST_CONSUMER_ENABLED_ENV_VAR = 'ACTIVITY_INGEST_CONSUMER_ENABLED';
