import 'reflect-metadata';
import { loadDotenvFilesIntoProcessEnv } from './config/load-dotenv-files';

// T-RR-050. Deliberately BEFORE the `AppModule`/`ConfigModule` imports below, not merely before
// `NestFactory.create` further down — `require('./app.module')` (what TypeScript compiles the
// `import { AppModule }` line below to) transitively `require`s `config.module.ts`, whose
// `NestConfigModule.forRoot(...)` call runs synchronously, up to and including `validate(...)`,
// the moment that `require` executes (`config.module.ts`'s own header). Populating `process.env`
// here first means every var read directly from `process.env` by a later module
// (`FIELD_ENCRYPTION_*`, `CACHE_ADMIN_TOKEN`, ...) is guaranteed to see it, exactly like Jest's
// own `test/database/env.setup.ts` already guarantees for the test suite — see
// `load-dotenv-files.ts`'s own header for the full root-cause writeup. TypeScript preserves the
// textual order of `import`/statement lines when compiling to CommonJS `require()` calls (verified
// empirically for this task), so this ordering is not fragile against a future TS version silently
// hoisting requires — it is standard, spec-guaranteed CommonJS module evaluation order.
loadDotenvFilesIntoProcessEnv();

import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type { INestApplication, INestApplicationContext, INestMicroservice } from '@nestjs/common';
import { AppModule } from './app.module';
import type { Config } from './config/config.schema';
import { createGrpcMicroservice } from './grpc/grpc-server.main';
import { createKafkaConsumerContext } from './messaging/ingest/kafka-consumer.main';
import { RewardEntryCreatedConsumer } from './messaging/ingest/reward-entry-created.consumer';
import { createClaimWorkerContext } from './modules/processing/claim-worker.main';
import { PromoCodeServiceKafkaClient } from './modules/connectors/promo-code-service-kafka.client';

/**
 * T-INT-004. Hybrid bootstrap: the primary HTTP app (`AppModule` — always on, this is Render's
 * whole deployed process today) plus the two transports that previously only existed as
 * standalone, never-wired-in composition roots (`ARCHITECTURE.md` §3.1, finding 6d) — the mTLS
 * `RewardIngestService` gRPC server (`src/grpc/grpc-server.main.ts`, T-RR-011) and the
 * `reward.entry.created.v1` Kafka consumer (`src/messaging/ingest/kafka-consumer.main.ts`,
 * T-RR-012). Each is started as its own separate `NestMicroservice`/`NestApplicationContext`
 * instance in this same OS process, reusing the bootstrap functions those files already export —
 * this file invents no new transport-startup logic of its own (task file implementation note 1).
 * Neither standalone `*.main.ts` file is modified, deleted, or bypassed (R2) — each remains
 * independently runnable exactly as before this task (TC-6, and `test/grpc/reward-ingest.e2e-spec.ts`
 * / the real-`ts-node`-subprocess `test/encryption/real-main-boot.e2e-spec.ts` continuing to pass
 * unmodified is this task's own evidence of that). Same multi-instance-in-one-process shape, same
 * reasoning, as `realtime-activity-processing-service`'s own T-INT-003 (confirmed by direct read of
 * that project's `src/main.ts`).
 *
 * **T-INT-047** adds a third optional composition root, the same shape as the two above: the
 * claim-worker/processing/dispatch pipeline (`src/modules/processing/claim-worker.main.ts`'s own
 * exported `createClaimWorkerContext()`, T-RR-058) — before this task, `ClaimWorkerModule` was
 * never registered in `AppModule` and its own standalone `claim-worker.main.ts` composition root
 * was never started by anything (`tasks/T-INT-047-*.md`'s own "Evidence" section: a `received` row
 * sat unclaimed indefinitely against a real, hybrid-bootstrapped local process). This file still
 * invents no new startup logic for that pipeline either — `createClaimWorkerContext()` is reused
 * verbatim, exactly like the gRPC/Kafka pattern above. `CLAIM_WORKER_ENABLED` is this new gate's
 * own env var, same name `claim-worker.module.ts`'s own runtime-config factory already reads for
 * the standalone process — but, like the two gates below, evaluated independently at *this* call
 * site with the opposite unset-default (`=== 'true'`, default OFF in the hybrid process) rather
 * than inheriting `claim-worker.module.ts`'s own "unset = enabled" convention, for the identical
 * reason the next section documents for gRPC/Kafka: a claim-worker run for real also transitively
 * spins up `CompletionSweepService`'s own always-on sweep loop
 * (`src/modules/redemption/completion-sweep.service.ts`, no `enabled` gate of its own), and neither
 * loop's own dependency chain (the two real connector modules, `RedemptionStateMachineModule`, the
 * dispatch/notification chain) has ever been exercised inside Render's today-deployed hybrid
 * process — defaulting this ON in an environment that has never confirmed those config values are
 * production-correct would risk the same "crash the whole hybrid process, taking `/health` down
 * with it" failure mode the gRPC/Kafka gates below were already flipped to avoid. See this task's
 * own completion report for the deployment-topology choice this task made in full (a Render
 * `worker` service, `render.yaml`, is the actual always-on deployment shape for this pipeline —
 * this hybrid-process gate exists for local/dev convenience only, matching `claim-worker.main.ts`'s
 * own header, which already recommended a dedicated worker service as the real deployment shape).
 *
 * **T-INT-053** adds a fourth optional gate, `PROMO_CODE_KAFKA_REPLY_CONSUMER_ENABLED`, fixing a
 * real defect this plan's own T-INT-040 verification pass found live: `PromoCodeServiceKafkaClient`
 * (`src/modules/connectors/promo-code-service-kafka.client.ts`, T-RR-081) opens the one shared,
 * long-lived kafkajs consumer for `promo-code.generate.result.v1` that `requestAndAwaitReply()`
 * needs to ever resolve a pending Kafka request — but nothing in any real running process ever
 * called its own `.start()` (`tasks/T-INT-053-*.md`'s own "Evidence": five real, independent
 * request/reply round trips, five genuinely fast successful replies from a real promo-code-service,
 * and RR's own side never received even one of them, exhausting its full Kafka retry budget every
 * time). **This gate is deliberately NOT resolved from a brand-new, separately-constructed
 * application context** the way that might first look symmetrical with the two gates above — the
 * pending-reply registry `PromoCodeServiceKafkaClient` keeps (`PromoCodeKafkaRequestReplyRegistry`)
 * is in-memory, per-instance state, and the only caller of `requestAndAwaitReply()` in this whole
 * service (`PromoCodeServiceConnector`, resolved via `ConnectorRegistry` from inside
 * `RedemptionProcessingOrchestrator`) only ever runs as part of `ClaimWorkerModule`'s own DI graph
 * (`claim-worker.module.ts`'s own header confirms `PromoCodeServiceConnectorModule` is imported
 * there, not anywhere `AppModule` itself reaches). Starting a fresh, second `PromoCodeServiceKafkaClient`
 * instance in an unrelated context would open a real consumer that faithfully receives every real
 * reply and then drops every single one as "no pending entry" (`handleResultMessage`'s own documented
 * behavior) — an even more confusing failure mode than the one this task fixes, since the consumer
 * would *look* started. Instead, this gate resolves `PromoCodeServiceKafkaClient` **from
 * `claimWorkerResult.handle`** (the exact same context `createClaimWorkerContext()` already builds
 * for the `CLAIM_WORKER_ENABLED` gate immediately above), the identical instance
 * `RedemptionProcessingOrchestrator` itself resolves its own `PromoCodeServiceConnector` from — so
 * a reply this consumer receives always resolves the correct, still-pending promise. This is why
 * enabling this gate with `CLAIM_WORKER_ENABLED` left off is treated as a hard failure (a thrown
 * `Error`, surfaced the same "explicitly enabled, refuses to start" way implementation note 4
 * already governs below) rather than a silent no-op: a promo-code reply consumer with no orchestrator
 * in the same process to ever call `requestAndAwaitReply()` would just as silently misdiagnose as
 * "working" while doing nothing useful. **Known, disclosed gap** (this task's own completion
 * report, "Deviations"): Render's real, always-on deployment shape for the claim-worker pipeline is
 * the dedicated `worker` service in `render.yaml` (`claim-worker.main.ts`, T-INT-047), not this
 * hybrid gate — and `claim-worker.main.ts` is outside this task's own "Files owned" list, so this
 * fix does not yet reach that topology. This gate covers exactly the same scope
 * `CLAIM_WORKER_ENABLED` above already covers: local/dev convenience, and the one topology this
 * task's own evidence was gathered against (a real, hybrid-bootstrapped local process).
 *
 * ## Why each of the four gates below defaults OFF here specifically, even though each already
 * ## defaults ON in its own standalone file/module when unset
 *
 * `grpc-server.config.ts`'s `loadGrpcServerConfig()` treats "unset" as "enabled" (only the literal
 * string `"false"` disables it), and `kafka-consumer.main.ts`'s own `isEnabled()` does the same
 * (`!== 'false'`) — both are the correct default for a single-purpose standalone process an
 * operator only ever starts on purpose. Wired into this hybrid process, though, that default would
 * mean Render's today-deployed process — which already has to set
 * `GRPC_SERVER_TLS_CA_PATH`/`_CERT_PATH`/`_KEY_PATH`/`GRPC_SERVER_ALLOWED_IDENTITIES` to
 * *some* non-empty string just to satisfy `config.schema.ts`'s own unconditional validation
 * (`src/config/config.schema.ts`, T-RR-004 — that check runs regardless of whether the gRPC
 * transport is ever actually started), but has never been confirmed to point those paths at real,
 * readable mTLS material for this hybrid path — would attempt to start the gRPC transport by
 * `loadGrpcServerConfig()`'s own default, hit `readRequiredFile`'s own fail-loud missing/unreadable
 * file check, and crash the *entire* hybrid process, taking down `/health` with it. That is exactly
 * the regression this task's own Definition of Done forbids ("Render's existing deployed behavior
 * is provably unaffected"). So each gate below is evaluated independently, at this call site, with
 * the opposite unset-default (`=== 'true'`, not `!== 'false'`) from what each transport's own
 * internal function uses — the identical, already-reviewed T-INT-003 deviation from a literal
 * reading of implementation note 3, recorded here as this task's own instance of that same,
 * disclosed deviation (see this task's own completion report under "Deviations"). T-INT-047's own
 * `CLAIM_WORKER_ENABLED` gate above follows this exact same convention, for the same reason —
 * T-INT-053's own `PROMO_CODE_KAFKA_REPLY_CONSUMER_ENABLED` gate does too, though for that one the
 * default-OFF choice is additionally load-bearing for the "requires CLAIM_WORKER_ENABLED=true in
 * the same process" hard-failure this file's own header above documents, not just crash-avoidance.
 */
const logger = new Logger('Bootstrap');

export interface HybridBootstrapResult {
  httpApp: INestApplication;
  grpcApp: INestMicroservice | null;
  kafkaConsumerContext: INestApplicationContext | null;
  /** T-INT-047. `null` unless `CLAIM_WORKER_ENABLED=true` — see this file's own header above for
   * why this hybrid-level gate defaults OFF even though `claim-worker.module.ts`'s own runtime
   * config for the same env var name defaults it ON for the standalone process. */
  claimWorkerContext: INestApplicationContext | null;
  /** T-INT-053. `null` unless `PROMO_CODE_KAFKA_REPLY_CONSUMER_ENABLED=true` (and, required, only
   * ever non-null alongside a non-null `claimWorkerContext` — see this file's own header above).
   * The started `PromoCodeServiceKafkaClient` instance itself, resolved from `claimWorkerContext`,
   * not a separate handle of its own kind. */
  promoCodeKafkaReplyConsumer: PromoCodeServiceKafkaClient | null;
}

interface TransportFailure {
  label: string;
  error: unknown;
}

/**
 * Thrown when at least one *explicitly enabled* transport failed to start (implementation note 4:
 * "an operator who sets `GRPC_SERVER_ENABLED=true` without valid TLS material should see the
 * process refuse to start, not silently skip the transport"). Carries every handle that DID start
 * successfully (including the always-on `httpApp`) so a caller — the `require.main` guard below,
 * or a test — can still close them cleanly rather than leaking connections/listeners.
 */
export class HybridBootstrapError extends Error {
  constructor(
    message: string,
    readonly partial: HybridBootstrapResult,
    readonly failures: readonly TransportFailure[],
  ) {
    super(message);
    this.name = 'HybridBootstrapError';
  }
}

/**
 * Runs `start()` only when `enabled` is `true`. A transport that isn't enabled is a silent,
 * expected no-op (not an error) — matches today's deployed behavior when nothing opts in. A
 * transport that IS enabled but throws during startup is logged and reported back as a failure,
 * never allowed to take down whichever of the other transports hasn't been attempted yet
 * (implementation note 4: "a crash in one transport must not take down the other").
 */
async function attemptOptionalTransport<T>(
  enabled: boolean,
  label: string,
  start: () => Promise<T>,
): Promise<{ handle: T | null; failure: TransportFailure | null }> {
  if (!enabled) {
    logger.log(`${label}: not started (disabled by default in the hybrid bootstrap)`);
    return { handle: null, failure: null };
  }
  try {
    const handle = await start();
    logger.log(`${label}: started (hybrid bootstrap)`);
    return { handle, failure: null };
  } catch (error) {
    logger.error(
      `${label}: explicitly enabled but failed to start`,
      error instanceof Error ? error.stack : String(error),
    );
    return { handle: null, failure: { label, error } };
  }
}

/**
 * `ConfigModule.forRoot({ validate: validateConfig })` (config.module.ts) runs during
 * `NestFactory.create` below and calls `process.exit(1)` before this function ever reaches
 * `app.listen(...)` if a required environment variable is missing or malformed — see
 * config.schema.ts's own header for the full contract. This still applies unchanged; the two
 * optional transports added by this task read their own env vars directly (never through
 * `ConfigService`/`config.schema.ts`, out of each transport's own file-scope split — see
 * `grpc-server.config.ts`/`kafka-consumer.main.ts`'s own headers), so an unset/invalid value for
 * one of THEIR required vars only crashes boot when that specific transport has been explicitly
 * enabled here.
 *
 * TC-8 (T-RR-001): a port already occupied by another process must still fail loudly and exit
 * non-zero, never hang silently — `app.listen(...)` rejects the returned promise on a listener
 * 'error' (e.g. EADDRINUSE), which the `require.main` guard below turns into a clear, explicit
 * message before exiting. That primary-HTTP-listener contract is unchanged by this task.
 *
 * Never calls `process.exit` itself — that decision belongs to the caller (the `require.main`
 * guard below when this runs as a real process, or a test when it doesn't).
 */
export async function startHybridBootstrap(): Promise<HybridBootstrapResult> {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService<Config, true>);
  const port = configService.get('PORT', { infer: true });

  await app.listen(port);
  logger.log(`HTTP server listening on port ${port}`);

  const grpcServerEnabled = process.env.GRPC_SERVER_ENABLED === 'true';
  const kafkaConsumerEnabled = process.env.KAFKA_CONSUMER_ENABLED === 'true';
  // T-INT-047. Same opposite-of-standalone-default convention as the two gates above — see this
  // file's own header.
  const claimWorkerEnabled = process.env.CLAIM_WORKER_ENABLED === 'true';
  // T-INT-053. Same convention — see this file's own header for why this one additionally requires
  // `claimWorkerEnabled` to also be true in this same process.
  const promoCodeKafkaReplyConsumerEnabled =
    process.env.PROMO_CODE_KAFKA_REPLY_CONSUMER_ENABLED === 'true';

  const grpcResult = await attemptOptionalTransport(
    grpcServerEnabled,
    'gRPC transport (RewardIngestService)',
    async () => {
      const grpcApp = await createGrpcMicroservice();
      if (grpcApp !== null) {
        await grpcApp.listen();
      }
      return grpcApp;
    },
  );

  const kafkaResult = await attemptOptionalTransport(
    kafkaConsumerEnabled,
    'reward.entry.created.v1 Kafka consumer',
    async () => {
      const context = await createKafkaConsumerContext();
      if (context !== null) {
        await context.get(RewardEntryCreatedConsumer).start();
      }
      return context;
    },
  );

  // T-INT-047. `createClaimWorkerContext()` (`src/modules/processing/claim-worker.main.ts`) never
  // returns `null` itself — unlike `createKafkaConsumerContext()`, its own "do I even start"
  // decision is left entirely to this call site (see that file's own header) — so
  // `attemptOptionalTransport`'s own `enabled` gate is what determines whether it is ever called
  // at all in this hybrid process.
  const claimWorkerResult = await attemptOptionalTransport(
    claimWorkerEnabled,
    'claim worker (ClaimWorkerModule / RedemptionProcessingOrchestrator)',
    async () => createClaimWorkerContext(),
  );

  // T-INT-053. Fixes the defect this task's own file documents in full above: nothing in any real
  // running process ever called `.start()` on `PromoCodeServiceKafkaClient`, so
  // `requestAndAwaitReply()` could never resolve a real, successful reply and every Kafka-primary
  // `rr-to-promo-code` redemption exhausted its full retry budget instead. Deliberately resolved
  // FROM `claimWorkerResult.handle` (never a fresh, separately-constructed application context) —
  // see this file's own header for why any other instance would silently drop every real reply
  // instead of fixing anything.
  const promoCodeKafkaReplyConsumerResult = await attemptOptionalTransport(
    promoCodeKafkaReplyConsumerEnabled,
    'promo-code.generate.result.v1 Kafka reply consumer (PromoCodeServiceKafkaClient)',
    async () => {
      if (!claimWorkerResult.handle) {
        throw new Error(
          'PROMO_CODE_KAFKA_REPLY_CONSUMER_ENABLED=true requires CLAIM_WORKER_ENABLED=true in the ' +
            'same process — this consumer must share the exact DI graph instance that resolves ' +
            'PromoCodeServiceConnector/calls requestAndAwaitReply() (inside ClaimWorkerModule), ' +
            'otherwise it can never resolve any pending Kafka reply.',
        );
      }
      const client = claimWorkerResult.handle.get(PromoCodeServiceKafkaClient);
      await client.start();
      return client;
    },
  );

  const result: HybridBootstrapResult = {
    httpApp: app,
    grpcApp: grpcResult.handle,
    kafkaConsumerContext: kafkaResult.handle,
    claimWorkerContext: claimWorkerResult.handle,
    promoCodeKafkaReplyConsumer: promoCodeKafkaReplyConsumerResult.handle,
  };

  const failures = [
    grpcResult.failure,
    kafkaResult.failure,
    claimWorkerResult.failure,
    promoCodeKafkaReplyConsumerResult.failure,
  ].filter((failure): failure is TransportFailure => failure !== null);

  if (failures.length > 0) {
    const labels = failures.map((failure) => failure.label).join(', ');
    throw new HybridBootstrapError(
      `${failures.length} explicitly-enabled transport(s) failed to start: ${labels}`,
      result,
      failures,
    );
  }

  return result;
}

/* istanbul ignore next -- exercised as a real process (task file's own Verification steps 2-3) and
 * by `test/main/hybrid-bootstrap.e2e-spec.ts` calling `startHybridBootstrap()` directly; this
 * guard's own `process.exit` call is a thin, deliberately untested process-exit path (same
 * convention every other standalone `*.main.ts` file in this project, and RAP's own T-INT-003
 * `src/main.ts`, already use). */
if (require.main === module) {
  startHybridBootstrap().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`reward-redemption-service failed to start: ${message}`);
    process.exit(1);
  });
}
