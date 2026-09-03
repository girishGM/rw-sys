/**
 * T-RAP-040. Standalone composition root for the customer progress HTTP API, run as its own
 * process — **not** wired into `src/main.ts`'s HTTP bootstrap.
 *
 * ### Why a separate entry point instead of a hybrid app in `main.ts`
 *
 * `src/main.ts`/`src/app.module.ts` are both exclusively `agent-rap-foundation`'s file scope
 * (`realtime-activity-processing-service-plan/project.config.json`); this agent's own delegated
 * scope is `src/modules/progress-api/**`. Rather than edit either foundation-owned file, this
 * module ships a fully self-contained composition root instead — its own tiny root module
 * (`ProgressApiRootModule` below, importing only the `@Global` `ConfigModule` and this module's
 * own `ProgressApiModule`) and its own `NestFactory.create(...)` bootstrap. Every test exercises
 * this same root module directly, so this file and the test suite share identical wiring. Same
 * precedent `src/grpc/grpc-server.main.ts` (T-RAP-022) already set for the identical file-scope
 * reason.
 *
 * **Follow-up flagged for the architect/reviewer** (this task's own completion report): running
 * this as a third OS process alongside `main.ts`'s HTTP process and `grpc-server.main.ts`'s gRPC
 * process is a legitimate, working deployment shape (`ARCHITECTURE.md` never mandates one
 * process), but folding it into a single hybrid process — if that is the preferred production
 * topology — is a follow-up for `agent-rap-foundation`, since it requires editing files outside
 * this task's scope.
 */
import 'reflect-metadata';
import { Module, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@/config/config.module';
import { ProgressApiModule } from './progress-api.module';

@Module({
  imports: [ConfigModule, ProgressApiModule],
})
export class ProgressApiRootModule {}

const logger = new Logger('ProgressApiServerBootstrap');

/** `PROGRESS_API_PORT` — read directly from `process.env`, not `ConfigService`/
 * `src/config/config.schema.ts` (out of this task's file scope — same precedent
 * `campaign-config.client.ts`'s `loadCampaignConfigClientOptions()` already documents). Defaults
 * to 3021 (`src/main.ts`'s own HTTP process already owns 3020, `PORT`). */
const DEFAULT_PROGRESS_API_PORT = 3021;

export function resolveProgressApiPort(): number {
  const raw = process.env.PROGRESS_API_PORT?.trim();
  if (!raw) {
    return DEFAULT_PROGRESS_API_PORT;
  }
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PROGRESS_API_PORT: "${raw}" is not a positive integer`);
  }
  return port;
}

export async function createProgressApiApp(): Promise<INestApplication> {
  return NestFactory.create(ProgressApiRootModule);
}

export async function bootstrap(): Promise<void> {
  const app = await createProgressApiApp();
  const port = resolveProgressApiPort();
  await app.listen(port);
  logger.log(`Customer progress API listening on port ${port}`);
}

/* istanbul ignore next -- exercised as a real process by manual/e2e HTTP verification, not by the
 * automated unit suite (which boots `ProgressApiRootModule` directly via `NestFactory.create` for
 * a faster, in-process real-Postgres run — see `test/e2e/progress-api.e2e-spec.ts`). */
if (require.main === module) {
  bootstrap().catch((error) => {
    logger.error(
      'Customer progress API server failed to start',
      error instanceof Error ? error.stack : error,
    );
    process.exitCode = 1;
  });
}
