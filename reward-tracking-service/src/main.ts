import 'reflect-metadata';
import { loadDotenvFilesIntoProcessEnv } from './config/load-dotenv-files';

// T-RTS-001. Deliberately BEFORE the `AppModule`/`ConfigModule` imports below, not merely before
// `NestFactory.create` further down — `require('./app.module')` (what TypeScript compiles the
// `import { AppModule }` line below to) transitively `require`s `config.module.ts`, whose
// `NestConfigModule.forRoot(...)` call runs synchronously, up to and including `validate(...)`,
// the moment that `require` executes (`config.module.ts`'s own header). Populating `process.env`
// here first means every var read directly from `process.env` by a later module is guaranteed to
// see it, exactly like `test/env.setup.ts` already guarantees for the test suite. TypeScript
// preserves the textual order of `import`/statement lines when compiling to CommonJS `require()`
// calls, so this ordering is standard, spec-guaranteed CommonJS module evaluation order — not
// fragile against a future TS version silently hoisting requires.
loadDotenvFilesIntoProcessEnv();

import { NestFactory } from '@nestjs/core';
import { Logger, Module } from '@nestjs/common';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import type { Config } from './config/config.schema';
import {
  createRewardTrackingGrpcServer,
  type RewardTrackingGrpcServerHandle,
} from './grpc/grpc-server.main';
import {
  createKafkaConsumerContext,
  KAFKA_CONSUMER_ENABLED_ENV_VAR,
} from './kafka/kafka-consumer.main';
import { RewardTrackingConsumerService } from './kafka/reward-tracking-consumer.service';
import { LoggingModule } from './observability/logging.module';
import { RewardTrackingIngestionModule } from './modules/ingestion/reward-tracking-ingestion.module';
import { RewardTrackingIngestController } from './modules/ingestion/reward-tracking-ingest.controller';

/**
 * T-INT-005. Fixes the "standalone entry point" disease (`reward-service-integration-plan/
 * ARCHITECTURE.md` §3.1) on the RTS side: the gRPC ingest server (`src/grpc/grpc-server.main.ts`,
 * T-RTS-011), the Kafka `reward.redemption.completed.v1` consumer (`src/kafka/kafka-consumer.
 * main.ts`, T-RTS-012), and the standalone REST ingest HTTP server (`src/modules/ingestion/
 * reward-tracking-ingest-http.main.ts`, T-RTS-013) are each optionally started in this same OS
 * process, alongside the primary HTTP app this file has always bootstrapped — each gated by its
 * own explicit env flag, each reusing the already-exported bootstrap function its own standalone
 * file exposes. None of those three files is modified, replaced, or has its own standalone
 * `require.main === module` block removed (R2, this plan's own `AGENT-PROTOCOL.md`) — every one of
 * them remains independently runnable exactly as it was before this task.
 *
 * **All three gates default OFF** (unset, or anything other than the literal string `"true"`), so
 * a deploy with none of them set — Render's current REST-only config — behaves identically to
 * before this task: only the primary HTTP listener opens (TC-1).
 *
 * **The Kafka gate deliberately does NOT reuse `kafka-consumer.main.ts`'s own default-enabled
 * semantics.** That file's own `isEnabled()` treats "unset" as enabled (`!== 'false'`) — the
 * correct default for a *standalone* process, where the whole point of running that file at all is
 * to consume, so nobody wants to also have to remember a second flag just to turn it on. This
 * hybrid bootstrap has the opposite default requirement (TC-1: unset must mean "not started" here
 * too), so this file makes its own, separate, explicit decision — `isFlagEnabled(
 * KAFKA_CONSUMER_ENABLED_ENV_VAR)` below requires the literal string `"true"` — before ever calling
 * `createKafkaConsumerContext()`. The same env var name is reused deliberately (one name, one
 * meaning, for an operator reading `.env.example`), just with a stricter "must be exactly true"
 * reading at this call site than the standalone file's own "must be exactly false to turn off"
 * reading of the same name. Once this call site's own gate is `"true"`, `createKafkaConsumerContext
 * ()`'s own internal check trivially also passes (it only rejects `"false"`), so the two never
 * disagree.
 *
 * **Fail loud, never silently downgrade, on an explicitly-enabled transport's own misconfiguration**
 * (matching every one of these three files' own fail-fast behavior when run standalone, and
 * T-INT-003/T-INT-004's identical convention on RAP/RR): each conditional start below is awaited
 * directly, not wrapped in a swallowing try/catch, so a genuine problem (a bad proto path, an
 * occupied port, a missing `REWARD_TRACKING_INGEST_TOKEN` for the REST ingest guard) propagates out
 * of `bootstrap()` and is caught by this file's own top-level `bootstrap().catch(...)` below, which
 * logs clearly and exits non-zero — never a transport an operator explicitly turned on getting
 * quietly skipped.
 *
 * `CampaignCacheModule` (the fourth piece this task wires — `campaign-hierarchy.client.ts`,
 * T-RTS-020) is **not** started here: it is a plain `@Module`, not a listener, so it is imported
 * directly into `AppModule`'s own `imports` array instead (`app.module.ts`, this task) — its own
 * `CampaignHierarchyClient.onModuleInit()` runs automatically as part of `NestFactory.create(
 * AppModule)`/`app.listen(port)` below, no separate call needed here, and it never gates or crashes
 * this process even when the portal is unreachable or unconfigured (that class's own header, R1).
 *
 * **T-INT-057 correction — REST ingest is no longer a fourth "started alongside" sub-server.**
 * Render only exposes a single port per `web` service (the same constraint RAP's/RR's own gRPC/mTLS
 * gaps already document for this tier); the original shape above booted
 * `RewardTrackingIngestController` via `createRewardTrackingIngestHttpServer()` on its own
 * `RTS_REST_INGEST_PORT` (default `3041`) — a second `http.Server` Render never routes to, so every
 * REST dispatch from `reward-redemption-service` to the one externally-reachable hostname/port
 * 404'd (no route registered there at all; see this task's own evidence). The fix folds
 * `RewardTrackingIngestController`'s module directly into **this same primary HTTP listener**
 * instead: `bootstrap()` below picks its own root module — plain `AppModule`, or
 * `HybridAppWithRestIngestModule` (this file, further down) which simply imports `AppModule` plus
 * `RewardTrackingIngestionModule`/`LoggingModule` and additionally declares
 * `RewardTrackingIngestController` — based on `RTS_REST_INGEST_ENABLED` *before* the one
 * `NestFactory.create(...)`/`app.listen(port)` call, so the ingest route (when enabled) is reachable
 * on the exact same port `/health` answers on (TC-1), and is a true 404 on that same port when the
 * gate is unset/false (TC-2) — matching R2/T-INT-004's own "fold a standalone transport into the
 * always-on main app rather than invent a second exposed port" precedent, not a new pattern.
 * `RewardTrackingIngestController`/`RewardTrackingIngestionModule`/the guard/DTO are reused
 * completely unmodified (TC-3: identical validation/side effects to the old standalone-server
 * behavior) — only how the module graph is composed changes.
 *
 * `src/app.module.ts` is deliberately **not** edited for this — `HybridAppWithRestIngestModule`
 * imports the already-exported `AppModule` class as a sibling module instead of the other way
 * around, so `RewardTrackingIngestController`'s routes end up on the same Express instance/module
 * graph without touching a file outside this task's own "Files owned" list. `ConfigModule` is
 * `@Global()` (`config.module.ts`) so it doesn't need re-importing here once it arrives via
 * `AppModule`; `LoggingModule` is imported explicitly for the identical reason
 * `reward-tracking-ingest-http.main.ts`'s own root module already documents (T-RTS-049) —
 * `RewardTrackingIngestController` injects `MetricsService`/`StructuredLoggerFactory` directly, and
 * `RewardTrackingIngestionModule` doesn't re-export the `LoggingModule` it imports internally.
 *
 * The standalone `reward-tracking-ingest-http.main.ts` composition root (T-RTS-013) is untouched and
 * no longer imported by this file at all (R2) — it remains independently runnable as its own process
 * for local/dev use or any future multi-port topology (TC-4); this file simply stops being one of
 * its callers.
 */
const GRPC_INGEST_ENABLED_ENV_VAR = 'RTS_GRPC_INGEST_ENABLED';
const REST_INGEST_ENABLED_ENV_VAR = 'RTS_REST_INGEST_ENABLED';

function isFlagEnabled(envVar: string): boolean {
  return process.env[envVar] === 'true';
}

/**
 * T-INT-057. Composes the real `AppModule` together with the REST ingest transport
 * (`RewardTrackingIngestionModule` + `RewardTrackingIngestController`) into one module graph, so
 * `NestFactory.create(...)` below produces a single `INestApplication`/single `http.Server` whose
 * routes include both — no second `app.listen(...)` call, no second port. Only ever selected as the
 * root module when `RTS_REST_INGEST_ENABLED === 'true'` (see `bootstrap()` below); otherwise plain
 * `AppModule` is used unchanged, so the ingest route is genuinely absent (TC-2), not merely
 * unauthenticated. See this file's own header for the full "why" (R2/T-INT-004 precedent, why
 * `app.module.ts` itself isn't touched, why `LoggingModule` is imported explicitly here).
 */
@Module({
  imports: [AppModule, RewardTrackingIngestionModule, LoggingModule],
  controllers: [RewardTrackingIngestController],
})
class HybridAppWithRestIngestModule {}

export interface HybridBootstrapHandle {
  app: INestApplication;
  port: number;
  grpc: RewardTrackingGrpcServerHandle | null;
  kafka: INestApplicationContext | null;
  /** `true` when `RewardTrackingIngestController`'s routes are mounted on this same `app`/`port`
   * (T-INT-057) — unlike `grpc`/`kafka` above, there is no separate handle to return here: this
   * transport shares the primary app's own listener/lifecycle entirely, so `close()` below tears it
   * down via the same `app.close()` call, nothing extra. */
  restIngestMounted: boolean;
  /** Closes every transport this bootstrap actually started, plus the primary HTTP app — tests'
   * own convenience, mirroring each standalone file's own `close()`/`onModuleDestroy` shape. */
  close: () => Promise<void>;
}

const logger = new Logger('RewardTrackingHybridBootstrap');

/**
 * `ConfigModule.forRoot({ validate: validateConfig })` runs during `NestFactory.create` below and
 * calls `process.exit(1)` before this function ever reaches `app.listen(...)` if a required
 * bootstrap environment variable is missing or malformed — see `config.schema.ts`'s own header for
 * the full contract.
 */
export async function bootstrap(): Promise<HybridBootstrapHandle> {
  const restIngestMounted = isFlagEnabled(REST_INGEST_ENABLED_ENV_VAR);
  // T-INT-057: the root module is chosen BEFORE `NestFactory.create(...)` — the one place this
  // decision can be made, since a Nest module graph is fixed at creation time. A missing
  // `REWARD_TRACKING_INGEST_TOKEN` while this gate is `true` throws here (inside
  // `RewardTrackingIngestTokenGuard`'s own constructor, resolved as part of building this graph),
  // which is still "fail loud, exit non-zero" (this file's own header) — just one call earlier than
  // before this task, not a behavior change an operator would observe.
  const app = await NestFactory.create(
    restIngestMounted ? HybridAppWithRestIngestModule : AppModule,
  );
  const configService = app.get(ConfigService<Config, true>);
  const port = configService.get('PORT', { infer: true });

  // A port already occupied by another process must fail loudly and exit non-zero, never hang
  // silently — `app.listen(...)` rejects the returned promise on a listener 'error' (e.g.
  // EADDRINUSE), which the catch below turns into a clear, explicit message before exiting.
  await app.listen(port);

  if (restIngestMounted) {
    logger.log(
      `RewardTrackingIngestController REST route mounted on the primary HTTP listener (port ${port}, same as /health) — T-INT-057`,
    );
  }

  let grpc: RewardTrackingGrpcServerHandle | null = null;
  if (isFlagEnabled(GRPC_INGEST_ENABLED_ENV_VAR)) {
    grpc = await createRewardTrackingGrpcServer();
    logger.log(`RewardTrackingIngestService gRPC server listening on port ${grpc.port}`);
  }

  let kafka: INestApplicationContext | null = null;
  if (isFlagEnabled(KAFKA_CONSUMER_ENABLED_ENV_VAR)) {
    // See this file's own header for why this call site's own gate check (above) — not
    // `createKafkaConsumerContext()`'s internal default-enabled check alone — is what decides
    // whether this ever runs in the hybrid bootstrap.
    const kafkaContext = await createKafkaConsumerContext();
    if (kafkaContext) {
      await kafkaContext.get(RewardTrackingConsumerService).start();
      logger.log('reward.redemption.completed.v1 consumer listening (shared consumer group)');
      kafka = kafkaContext;
    }
  }

  return {
    app,
    port,
    grpc,
    kafka,
    restIngestMounted,
    close: async () => {
      if (kafka) {
        await kafka.get(RewardTrackingConsumerService).stop();
        await kafka.close();
      }
      await grpc?.close();
      await app.close();
    },
  };
}

/* istanbul ignore next -- exercised as a real process by manual verification (this task's own
 * verification steps 2/3), not by the automated suite (which calls `bootstrap()` directly for a
 * faster in-process real-Postgres run — see `test/main/hybrid-bootstrap.e2e-spec.ts`). */
if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`reward-tracking-service failed to start: ${message}`);
    process.exit(1);
  });
}
