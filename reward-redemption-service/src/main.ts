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
 * ## Why each of the two gates below defaults OFF here specifically, even though both already
 * ## default ON in their own standalone files/modules when unset
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
 * disclosed deviation (see this task's own completion report under "Deviations").
 */
const logger = new Logger('Bootstrap');

export interface HybridBootstrapResult {
  httpApp: INestApplication;
  grpcApp: INestMicroservice | null;
  kafkaConsumerContext: INestApplicationContext | null;
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

  const result: HybridBootstrapResult = {
    httpApp: app,
    grpcApp: grpcResult.handle,
    kafkaConsumerContext: kafkaResult.handle,
  };

  const failures = [grpcResult.failure, kafkaResult.failure].filter(
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
