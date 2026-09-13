import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, Module } from '@nestjs/common';
import type { INestApplication, INestApplicationContext, INestMicroservice } from '@nestjs/common';
import { AppModule } from './app.module';
import { ConfigModule } from './config/config.module';
import type { Config } from './config/config.schema';
import { createGrpcMicroservice } from './grpc/grpc-server.main';
import { createIngestConsumerContext } from './messaging/ingest/activity-ingest-consumer.main';
import { ActivityIngestConsumer } from './messaging/ingest/activity-ingest.consumer';
import { ProgressApiModule } from './modules/progress-api/progress-api.module';
import { ProcessingModule } from './modules/processing/processing.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';

/**
 * T-INT-003 (extended by T-INT-043). Hybrid bootstrap: the primary HTTP app (`AppModule` — always
 * on, this is Render's whole deployed process today) plus four transports that previously only
 * existed as standalone, never-wired-in composition roots (`ARCHITECTURE.md` §3.1) — the mTLS
 * `ActivityIngestService` gRPC server (`src/grpc/grpc-server.main.ts`), the `activity.ingest.v1`
 * Kafka consumer (`src/messaging/ingest/activity-ingest-consumer.main.ts`), the customer progress
 * REST API (`src/modules/progress-api/progress-api-server.main.ts`), and — T-INT-043 — the
 * processing/dispatch worker bundle (`ProcessingModule` + `DispatchModule`: `ActivityLogClaimWorker`
 * → `RuleEvaluatorService`/`TrackerCompletionEvaluatorService` → `CapEnforcementService` →
 * `reward_entry` creation → `OutboxPublisherService`/`RewardDispatchRetryWorker` dispatch to
 * reward-redemption-service). Each is started as its own separate
 * `NestApplication`/`NestMicroservice`/`NestApplicationContext` instance in this same OS process,
 * reusing the bootstrap functions those files already export where one exists — this file invents
 * no new transport-startup logic of its own (task file implementation note 1). None of the three
 * pre-existing standalone `*.main.ts` files is modified, deleted, or bypassed (R2) — each remains
 * independently runnable exactly as before this task (TC-7). `ProcessingModule`/`DispatchModule`
 * had no standalone `*.main.ts` of their own before T-INT-043 (confirmed by grepping every
 * `*.main.ts` in this service plus `app.module.ts` — see that task's own "Evidence" section); this
 * file's own `ProcessingWorkerRootModule`/`createProcessingWorkerContext()` below are that gap's
 * first real composition root, added directly here rather than as a fifth standalone file, per
 * T-INT-043's own Scope note that either shape is acceptable and this one is the more consistent
 * choice given `main.ts` already hosts three other hybrid-only gates with the identical shape.
 *
 * ## Why each of the four gates below defaults OFF here specifically, even though two of them
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
 * task's own completion report under "Deviations". `PROGRESS_API_ENABLED` and (T-INT-043)
 * `PROCESSING_ENABLED` are both brand-new vars (neither standalone-equivalent exists to reuse or
 * diverge from — `ProcessingModule`/`DispatchModule` had no standalone entry point at all) and are
 * given the same off-by-default treatment for symmetry with the other two, exactly as
 * implementation note 1 asks.
 *
 * **T-INT-062 correction — the customer progress API is no longer a fourth "started as its own
 * separate NestApplication" transport.** The description above (T-INT-003) had it listening on its
 * own port (`resolveProgressApiPort()`, default 3021) inside this same process — exactly the same
 * "second port Render never routes to" bug `T-INT-057` already found and fixed for
 * reward-tracking-service's own REST ingest (`reward-service-integration-plan/tasks/
 * T-INT-057-*.md`/`reward-tracking-service/src/main.ts`). The fix mirrors that precedent exactly:
 * `HybridAppWithProgressApiModule` below simply imports `AppModule` plus `ProgressApiModule` — whose
 * own `@Module({ controllers: [ProgressController] })` declaration (`progress-api.module.ts`) needs
 * no re-declaring here, unlike RTS's own ingest controller, which its ingestion module doesn't
 * declare itself. `startHybridBootstrap()` below picks this wrapper, instead of plain `AppModule`,
 * as its ONE `NestFactory.create(...)` root module whenever `PROGRESS_API_ENABLED` is the literal
 * string `'true'`, decided BEFORE the single `app.listen(port)` call — so `/progress/...` (when
 * enabled) is reachable on the exact same port `/health` answers on, no second listener, no second
 * port. `PROGRESS_API_PORT` has no effect on this hybrid path anymore — it still governs only the
 * untouched standalone `progress-api-server.main.ts` (R2).
 *
 * One real, deliberate behavior difference from the gRPC/Kafka/processing gates below, flagged
 * explicitly here and in this task's own completion report ("Deviations"): those three are each
 * wrapped in `attemptOptionalTransport`'s try/catch, so a misconfigured one (TC-6 below) can never
 * take down the already-`app.listen()`-ing primary HTTP app. The progress API's own
 * `ProgressApiAuthGuard` construction (which throws if `PROGRESS_API_AUTH_SECRET` is unset —
 * `progress-api-auth.guard.ts`'s own header) now runs as part of building `NestFactory.create(...)`'s
 * module graph itself, BEFORE `app.listen()` is ever reached — so an explicitly-enabled-but-
 * misconfigured progress API fails the *whole* hybrid boot (a raw, uncaught rejection out of
 * `startHybridBootstrap()`, not a `HybridBootstrapError` with a still-live `partial.httpApp`), not
 * just that one transport. This is the same trade-off T-INT-057 already accepted for RTS's own
 * REST-ingest fold-in ("Fail loud, never silently downgrade... exits non-zero... one call earlier
 * than before, not a behavior change an operator would observe") — an unavoidable consequence of
 * Nest fixing a module graph at creation time, not a design choice available to a fix that still
 * had to put this route on the one port Render actually exposes.
 */
const logger = new Logger('Bootstrap');

/**
 * T-INT-043. `ProcessingModule` (`ActivityLogClaimWorker`/`StaleProcessingSweepService`, both
 * autostart by default — see each service's own `OnModuleInit`) + `DispatchModule`
 * (`OutboxPublisherService`/`RewardDispatchRetryWorker`, both autostart by default whenever
 * `NODE_ENV !== 'test'` — `dispatch.module.ts`'s own `OUTBOX_PUBLISHER_AUTOSTART`/
 * `RETRY_WORKER_AUTOSTART` factories). Constructing this application context is therefore
 * sufficient on its own to start the whole chain end to end in a real (non-test) process — no
 * explicit `.start()` call is needed here, unlike `test/e2e/full-pipeline-test-helpers.ts`'s own
 * `WorkerRootModule` equivalent, which runs under `NODE_ENV=test` and does call `.start()`
 * explicitly for that reason. `InvalidationModule` is deliberately NOT imported here — out of
 * T-INT-043's own Scope ("Out: Any other RAP module").
 */
@Module({ imports: [ConfigModule, ProcessingModule, DispatchModule] })
export class ProcessingWorkerRootModule {}

/** No enable-gate of its own (mirrors `createProgressApiApp()`'s own precedent) — the only gate is
 * `PROCESSING_ENABLED`, read at the `startHybridBootstrap()` call site below. */
export async function createProcessingWorkerContext(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(ProcessingWorkerRootModule);
}

/**
 * T-INT-062. Composes the real `AppModule` together with the customer progress API
 * (`ProgressApiModule`, which already declares `ProgressController` as its own `controllers`) into
 * one module graph, so `NestFactory.create(...)` below produces a single `INestApplication`/single
 * `http.Server` whose routes include both — no second `app.listen(...)` call, no second port. Only
 * ever selected as the root module when `PROGRESS_API_ENABLED === 'true'` (see
 * `startHybridBootstrap()` below); otherwise plain `AppModule` is used unchanged, so
 * `/progress/...` is genuinely absent (404, TC-2), not merely unauthenticated. See this file's own
 * header for the full "why" (T-INT-057 precedent, why `app.module.ts` itself isn't touched here
 * either — this module imports the already-exported `AppModule` class as a sibling, not the other
 * way around, so this fix stays entirely inside this task's own "Files owned" list).
 */
@Module({ imports: [AppModule, ProgressApiModule] })
export class HybridAppWithProgressApiModule {}

export interface HybridBootstrapResult {
  httpApp: INestApplication;
  grpcApp: INestMicroservice | null;
  ingestConsumerContext: INestApplicationContext | null;
  /** `true` when `ProgressController`'s routes (T-INT-062) are mounted on this same `httpApp`/port
   * — unlike `grpcApp`/`ingestConsumerContext`/`processingWorkerContext` below, there is no separate
   * handle to return here: this transport shares the primary app's own lifecycle/`close()` entirely.
   * Same `restIngestMounted: boolean` precedent `reward-tracking-service/src/main.ts`'s own
   * T-INT-057 fix already set for the identical shape of change. */
  progressApiMounted: boolean;
  processingWorkerContext: INestApplicationContext | null;
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
 * config.schema.ts's header for the full contract. This still applies unchanged; the optional
 * transports added by T-INT-003/T-INT-043 read their own env vars directly, never through
 * `ConfigService`/`config.schema.ts` (out of `agent-rap-foundation`'s own delegated split — see
 * each transport's own config file header), so an unset/invalid value for one of THEIR required
 * vars only crashes boot when that specific transport has been explicitly enabled.
 *
 * Never calls `process.exit` itself — that decision belongs to the caller (the `require.main`
 * guard below when this runs as a real process, or a test when it doesn't).
 */
export async function startHybridBootstrap(): Promise<HybridBootstrapResult> {
  // T-INT-062: read BEFORE NestFactory.create(...) — the root module itself depends on this value
  // (HybridAppWithProgressApiModule's own header above), and a Nest module graph is fixed at
  // creation time, so this is the one point in this function where that decision can be made.
  const progressApiEnabled = process.env.PROGRESS_API_ENABLED === 'true';

  const app = await NestFactory.create(
    progressApiEnabled ? HybridAppWithProgressApiModule : AppModule,
  );

  const configService = app.get(ConfigService<Config, true>);
  const port = configService.get('PORT', { infer: true });

  await app.listen(port);
  logger.log(`HTTP server listening on port ${port}`);
  if (progressApiEnabled) {
    logger.log(
      `customer progress API mounted on the primary HTTP listener (port ${port}, same as /health) — T-INT-062`,
    );
  }

  const grpcServerEnabled = process.env.GRPC_SERVER_ENABLED === 'true';
  const activityIngestConsumerEnabled = process.env.ACTIVITY_INGEST_CONSUMER_ENABLED === 'true';
  const processingEnabled = process.env.PROCESSING_ENABLED === 'true';

  const grpcResult = await attemptOptionalTransport(
    grpcServerEnabled,
    'gRPC transport (ActivityIngestService)',
    async () => {
      const grpcApp = await createGrpcMicroservice();
      if (grpcApp !== null) {
        // T-INT-062 retry 2 (review fix): `createGrpcMicroservice()` can succeed (a real,
        // fully-constructed `INestMicroservice`, its own live NestContainer already built) and
        // THEN `.listen()` can still fail (a real, transient `EADDRINUSE` — the exact race
        // `test/main/hybrid-bootstrap.e2e-spec.ts`'s own TC-5 hit under a full, default-parallel
        // `npm test` run: `getFreePort()` finding a port that a DIFFERENT parallel worker's own
        // test grabs a moment later). Before this fix, that already-built `grpcApp` was simply
        // dropped on the floor here — never returned (so `attemptOptionalTransport`'s own catch,
        // and this whole function's `HybridBootstrapError.partial`, never got a reference to it),
        // never closed. A constructed-but-never-closed `INestMicroservice` still has a live
        // `NestContainer`; if anything about it settles asynchronously later (this project's own
        // gRPC bootstrap holds open credentials/handles), an unhandled rejection carrying that
        // container is exactly what corrupts jest-worker's `messageParent` IPC relay
        // (`TypeError: Converting circular structure to JSON`) for the whole file — the same
        // observable crash TC-7's own retry-2 fix addresses for a different trigger. Closing it
        // here, before rethrowing, means `attemptOptionalTransport`'s caller never needs to know
        // this ever existed.
        try {
          await grpcApp.listen();
        } catch (error) {
          await grpcApp.close().catch(() => {});
          throw error;
        }
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
        // T-INT-062 retry 2: same "don't drop an already-constructed handle on a later failure"
        // fix as the gRPC transport above — `.start()` failing after a successful
        // `createIngestConsumerContext()` must not leak the context it already built.
        try {
          await context.get(ActivityIngestConsumer).start();
        } catch (error) {
          await context.close().catch(() => {});
          throw error;
        }
      }
      return context;
    },
  );

  const processingResult = await attemptOptionalTransport(
    processingEnabled,
    'processing/dispatch worker (ProcessingModule + DispatchModule)',
    async () => createProcessingWorkerContext(),
  );

  const result: HybridBootstrapResult = {
    httpApp: app,
    grpcApp: grpcResult.handle,
    ingestConsumerContext: ingestResult.handle,
    progressApiMounted: progressApiEnabled,
    processingWorkerContext: processingResult.handle,
  };

  const failures = [grpcResult.failure, ingestResult.failure, processingResult.failure].filter(
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
