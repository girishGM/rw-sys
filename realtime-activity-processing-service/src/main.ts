import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type { INestApplication, INestApplicationContext, INestMicroservice } from '@nestjs/common';
import { AppModule } from './app.module';
import type { Config } from './config/config.schema';
import { createGrpcMicroservice } from './grpc/grpc-server.main';
import { createIngestConsumerContext } from './messaging/ingest/activity-ingest-consumer.main';
import { ActivityIngestConsumer } from './messaging/ingest/activity-ingest.consumer';
import {
  createProgressApiApp,
  resolveProgressApiPort,
} from './modules/progress-api/progress-api-server.main';

/**
 * T-INT-003. Hybrid bootstrap: the primary HTTP app (`AppModule` — always on, this is Render's
 * whole deployed process today) plus three transports that previously only existed as standalone,
 * never-wired-in composition roots (`ARCHITECTURE.md` §3.1) — the mTLS `ActivityIngestService`
 * gRPC server (`src/grpc/grpc-server.main.ts`), the `activity.ingest.v1` Kafka consumer
 * (`src/messaging/ingest/activity-ingest-consumer.main.ts`), and the customer progress REST API
 * (`src/modules/progress-api/progress-api-server.main.ts`). Each of the three is started as its
 * own separate `NestApplication`/`NestMicroservice`/`NestApplicationContext` instance in this same
 * OS process, reusing the bootstrap functions those files already export — this file invents no
 * new transport-startup logic of its own (task file implementation note 1). None of the three
 * standalone `*.main.ts` files is modified, deleted, or bypassed (R2) — each remains independently
 * runnable exactly as before this task (TC-7).
 *
 * ## Why each of the three gates below defaults OFF here specifically, even though two of them
 * ## (`GRPC_SERVER_ENABLED`, `ACTIVITY_INGEST_CONSUMER_ENABLED`) already default ON in their own
 * ## standalone files when unset
 *
 * `grpc-server.config.ts`'s `loadGrpcServerConfig()` and `ingest.config.ts`'s
 * `ACTIVITY_INGEST_CONSUMER_ENABLED_ENV_VAR` check both treat "unset" as "enabled" — the correct
 * default for a single-purpose standalone process an operator only ever starts on purpose. Wired
 * into this hybrid process, though, that default would mean Render's today-unconfigured deploy (no
 * `GRPC_SERVER_ENABLED`, no TLS material set at all — `realtime-activity-processing-service/CLAUDE.md`'s
 * own "Render deployment" section) would attempt to start the gRPC transport by that function's own
 * default, hit its own fail-loud missing-TLS-material check, and crash the *entire* hybrid process —
 * taking down the `/health` endpoint Render depends on, a regression this task's own Definition of
 * Done explicitly forbids ("Render's existing deployed behavior... is provably unaffected"). So each
 * gate below is evaluated independently, at this call site, with the opposite unset-default
 * (`=== 'true'`, not `!== 'false'`) from what each transport's own internal function uses — an
 * explicit T-INT-003 deviation from a literal reading of implementation note 3, recorded in this
 * task's own completion report under "Deviations". `PROGRESS_API_ENABLED` is a brand-new var (the
 * standalone progress-api file has no gate of its own to reuse or diverge from) and is given the
 * same off-by-default treatment for symmetry with the other two, exactly as implementation note 1
 * asks.
 */
const logger = new Logger('Bootstrap');

export interface HybridBootstrapResult {
  httpApp: INestApplication;
  grpcApp: INestMicroservice | null;
  ingestConsumerContext: INestApplicationContext | null;
  progressApiApp: INestApplication | null;
}

interface TransportFailure {
  label: string;
  error: unknown;
}

/**
 * Thrown when at least one *explicitly enabled* transport failed to start (implementation note 4:
 * "the one exception is if an operator explicitly enabled a transport and its required config...
 * is missing/invalid, which should fail loudly and exit non-zero"). Carries every handle that DID
 * start successfully (including the always-on `httpApp`) so a caller — the `require.main` guard
 * below, or a test — can still close them cleanly rather than leaking connections/listeners.
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
 * never allowed to take down whichever of the other two transports haven't been attempted yet
 * (implementation note 4's "a crash in one transport must not take down the other two").
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
 * config.schema.ts's header for the full contract. This still applies unchanged; the three
 * optional transports added by this task read their own env vars directly, never through
 * `ConfigService`/`config.schema.ts` (out of `agent-rap-foundation`'s own delegated split — see
 * each transport's own config file header), so an unset/invalid value for one of THEIR required
 * vars only crashes boot when that specific transport has been explicitly enabled.
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
  const activityIngestConsumerEnabled = process.env.ACTIVITY_INGEST_CONSUMER_ENABLED === 'true';
  const progressApiEnabled = process.env.PROGRESS_API_ENABLED === 'true';

  const grpcResult = await attemptOptionalTransport(
    grpcServerEnabled,
    'gRPC transport (ActivityIngestService)',
    async () => {
      const grpcApp = await createGrpcMicroservice();
      if (grpcApp !== null) {
        await grpcApp.listen();
      }
      return grpcApp;
    },
  );

  const ingestResult = await attemptOptionalTransport(
    activityIngestConsumerEnabled,
    'activity.ingest.v1 Kafka consumer',
    async () => {
      const context = await createIngestConsumerContext();
      if (context !== null) {
        await context.get(ActivityIngestConsumer).start();
      }
      return context;
    },
  );

  const progressApiResult = await attemptOptionalTransport(
    progressApiEnabled,
    'customer progress API',
    async () => {
      const progressApiApp = await createProgressApiApp();
      await progressApiApp.listen(resolveProgressApiPort());
      return progressApiApp;
    },
  );

  const result: HybridBootstrapResult = {
    httpApp: app,
    grpcApp: grpcResult.handle,
    ingestConsumerContext: ingestResult.handle,
    progressApiApp: progressApiResult.handle,
  };

  const failures = [grpcResult.failure, ingestResult.failure, progressApiResult.failure].filter(
    (failure): failure is TransportFailure => failure !== null,
  );

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

/* istanbul ignore next -- exercised as a real process (task file's own Verification steps 2-4) and
 * by `test/main/hybrid-bootstrap.e2e-spec.ts` calling `startHybridBootstrap()` directly; this
 * guard's own `process.exit` call is a thin, deliberately untested process-exit path (same
 * convention every other standalone `*.main.ts` file in this project already uses). */
if (require.main === module) {
  startHybridBootstrap().catch((error) => {
    logger.error(
      'Fatal error during hybrid bootstrap',
      error instanceof Error ? error.stack : String(error),
    );
    process.exit(1);
  });
}
