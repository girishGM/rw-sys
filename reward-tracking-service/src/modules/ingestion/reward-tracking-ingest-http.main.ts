/**
 * T-RTS-013. Standalone composition root for `RewardTrackingIngestController`, run as its own
 * process for this task's own verification step 2 (`curl` a running instance) — the identical
 * "extra file added when the implementation genuinely needs it, inside this agent's own scope
 * grant" precedent `grpc-server.main.ts` (T-RTS-011, confirmed by direct read) already established
 * for its own sibling transport: not listed in this task's literal "Files owned" list, but squarely
 * inside this agent's delegated `src/modules/ingestion/**` scope grant
 * (`reward-tracking-service-plan/project.config.json`), flagged explicitly here and in this task's
 * completion report.
 *
 * **Not `src/main.ts`'s own HTTP listener** — `src/main.ts`/`src/app.module.ts` are both exclusively
 * `agent-rts-foundation`'s file scope (same gap `grpc.module.ts`/`kafka.module.ts` already flagged
 * for their own transports). Wiring `RewardTrackingIngestController` into the real, single HTTP app
 * `src/main.ts` bootstraps (the correct final production topology for a REST endpoint, unlike gRPC/
 * Kafka which are naturally separate processes/protocols) is a follow-up for `agent-rts-foundation`,
 * flagged in this task's own completion report — this file exists solely to produce a real,
 * `curl`-able running instance today, not as the intended long-term deployment shape.
 */
import 'reflect-metadata';
import { loadDotenvFilesIntoProcessEnv } from '@/config/load-dotenv-files';

// Deliberately before the `ConfigModule`/`RewardTrackingIngestionModule` imports below — identical
// reasoning to `main.ts`'s own header (T-RTS-001) and `grpc-server.main.ts`'s own header
// (T-RTS-011): `ConfigModule.forRoot(...)` runs synchronously the moment `config.module.ts` is
// `require`'d, so `process.env` must already be fully populated by then.
loadDotenvFilesIntoProcessEnv();

import { Module, Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule } from '@/config/config.module';
import { LoggingModule } from '@/observability/logging.module';
import { RewardTrackingIngestionModule } from './reward-tracking-ingestion.module';
import { RewardTrackingIngestController } from './reward-tracking-ingest.controller';

@Module({
  // T-RTS-049 — `LoggingModule` also arrives transitively via `RewardTrackingIngestionModule`
  // (Nest dedupes an identically-referenced module class across one dependency graph), imported
  // here explicitly too since `RewardTrackingIngestController` itself injects both
  // `MetricsService`/`StructuredLoggerFactory` directly.
  imports: [ConfigModule, RewardTrackingIngestionModule, LoggingModule],
  controllers: [RewardTrackingIngestController],
})
class RewardTrackingIngestHttpRootModule {}

/** Distinct from the main HTTP app's own `PORT` (default `3040`, `config.schema.ts`) — this is a
 * standalone verification process, never both listening on the same port at once. */
export const DEFAULT_REST_INGEST_PORT = 3041;

function resolvePort(): number {
  const raw = process.env.RTS_REST_INGEST_PORT?.trim();
  if (!raw) {
    return DEFAULT_REST_INGEST_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid RTS_REST_INGEST_PORT: "${raw}" is not a positive integer`);
  }
  return parsed;
}

export interface RewardTrackingIngestHttpServerHandle {
  app: INestApplication;
  port: number;
  close: () => Promise<void>;
}

export async function createRewardTrackingIngestHttpServer(
  portOverride?: number,
): Promise<RewardTrackingIngestHttpServerHandle> {
  const app = await NestFactory.create(RewardTrackingIngestHttpRootModule, {
    logger: ['log', 'warn', 'error'],
  });
  const port = portOverride ?? resolvePort();
  await app.listen(port);
  return { app, port, close: () => app.close() };
}

const logger = new Logger('RewardTrackingIngestHttpBootstrap');

/* istanbul ignore next -- exercised as a real process by manual curl verification (this task's own
 * verification step 2), not by the automated suite. */
if (require.main === module) {
  createRewardTrackingIngestHttpServer()
    .then((handle) => {
      logger.log(`RewardTrackingIngestController HTTP server listening on port ${handle.port}`);
    })
    .catch((error: unknown) => {
      logger.error(
        'REST ingest server failed to start',
        error instanceof Error ? error.stack : String(error),
      );
      process.exitCode = 1;
    });
}
