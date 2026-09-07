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
import { Logger } from '@nestjs/common';
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
import {
  createRewardTrackingIngestHttpServer,
  type RewardTrackingIngestHttpServerHandle,
} from './modules/ingestion/reward-tracking-ingest-http.main';

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
 */
const GRPC_INGEST_ENABLED_ENV_VAR = 'RTS_GRPC_INGEST_ENABLED';
const REST_INGEST_ENABLED_ENV_VAR = 'RTS_REST_INGEST_ENABLED';

function isFlagEnabled(envVar: string): boolean {
  return process.env[envVar] === 'true';
}

export interface HybridBootstrapHandle {
  app: INestApplication;
  port: number;
  grpc: RewardTrackingGrpcServerHandle | null;
  kafka: INestApplicationContext | null;
  restIngest: RewardTrackingIngestHttpServerHandle | null;
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
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService<Config, true>);
  const port = configService.get('PORT', { infer: true });

  // A port already occupied by another process must fail loudly and exit non-zero, never hang
  // silently — `app.listen(...)` rejects the returned promise on a listener 'error' (e.g.
  // EADDRINUSE), which the catch below turns into a clear, explicit message before exiting.
  await app.listen(port);

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

  let restIngest: RewardTrackingIngestHttpServerHandle | null = null;
  if (isFlagEnabled(REST_INGEST_ENABLED_ENV_VAR)) {
    restIngest = await createRewardTrackingIngestHttpServer();
    logger.log(`RewardTrackingIngestController HTTP server listening on port ${restIngest.port}`);
  }

  return {
    app,
    port,
    grpc,
    kafka,
    restIngest,
    close: async () => {
      await restIngest?.close();
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
