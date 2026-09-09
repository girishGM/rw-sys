/**
 * T-RTS-011. Standalone composition root + raw `@grpc/grpc-js` server for
 * `RewardTrackingIngestService.IngestRewardTrackingEvent`, run as its own process — **not** wired
 * into `src/main.ts`'s HTTP bootstrap (`grpc.module.ts`'s own header explains why: `src/main.ts`/
 * `src/app.module.ts` are both exclusively `agent-rts-foundation`'s file scope). Not added to this
 * task's own literal "Files owned" list in the task file, but squarely inside this agent's
 * delegated `src/grpc/**` scope grant (`project.config.json`) and necessary to produce a real,
 * `grpcurl`-able running instance for this task's own verification step 2 — same "extra file added
 * when the implementation genuinely needs it, inside this agent's own scope grant" precedent
 * `reward-redemption-service`'s own `T-RR-035` already established (see that task's own
 * `reward-tracking-outbox.repository.ts` header) — flagged explicitly in this task's completion
 * report.
 *
 * No `@nestjs/microservices` (not a dependency of this service — `grpc.module.ts`'s own header).
 * Uses `NestFactory.createApplicationContext` purely for dependency injection (to construct
 * `RewardTrackingIngestGrpcController` and its own transitive `RewardTrackingIngestionService`
 * dependency chain), then hand-builds a plain `grpc.Server` and binds it — the server-side mirror
 * of `src/modules/campaign-cache/campaign-hierarchy.client.ts`'s own raw-`@grpc/grpc-js`
 * CLIENT-side approach (T-RTS-020).
 *
 * Plaintext (`grpc.ServerCredentials.createInsecure()`), no mTLS — unlike
 * `reward-redemption-service`'s own inbound `RewardIngestService`, neither `ARCHITECTURE.md` nor
 * this task's own file mentions an mTLS/identity-allowlist requirement for this particular inbound
 * channel; adding one would be scope this task was never asked for. Flagged in the completion
 * report as a security posture worth the architect's explicit confirmation, not silently assumed.
 */
import 'reflect-metadata';
import { loadDotenvFilesIntoProcessEnv } from '@/config/load-dotenv-files';

// Deliberately before the `ConfigModule`/`GrpcModule` imports below — identical reasoning to
// `main.ts`'s own header (T-RTS-001) and `reward-redemption-service/src/grpc/grpc-server.main.ts`'s
// own header (T-RR-011/T-RR-012): `ConfigModule.forRoot(...)` runs synchronously the moment
// `config.module.ts` is `require`'d, so `process.env` must already be fully populated by then.
loadDotenvFilesIntoProcessEnv();

import { join } from 'node:path';
import { Module, Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ConfigModule } from '@/config/config.module';
import { GrpcModule } from './grpc.module';
import { RewardTrackingIngestGrpcController } from './reward-tracking-ingest.grpc-controller';

@Module({
  imports: [ConfigModule, GrpcModule],
})
class GrpcServerRootModule {}

/** Distinct from the portal's `50051`, promo-code-service's `50061`,
 * `realtime-activity-processing-service`'s inbound `50071`, and `reward-redemption-service`'s
 * inbound `50081` (`reward-redemption-service-plan/03-GRPC-CONTRACT.md`'s own port-allocation
 * section) — this service's own inbound gRPC ingest port is next in that sequence. */
export const DEFAULT_GRPC_INGEST_PORT = 50091;

function resolvePort(): number {
  const raw = process.env.RTS_GRPC_INGEST_PORT?.trim();
  if (!raw) {
    return DEFAULT_GRPC_INGEST_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid RTS_GRPC_INGEST_PORT: "${raw}" is not a positive integer`);
  }
  return parsed;
}

/** `proto/reward_tracking_ingest.proto` lives at the project root (this contract's own canonical
 * home, per that file's own header — unlike `T-RTS-020`'s client-side copy under
 * `src/modules/campaign-cache/proto/`), so this resolves two directories up from `dist/src/grpc/`
 * (or `src/grpc/` under `ts-node`) to the project root, then into `proto/`. */
function resolveProtoPath(): string {
  return join(__dirname, '..', '..', 'proto', 'reward_tracking_ingest.proto');
}

function loadServiceDefinition(): grpc.ServiceDefinition {
  const packageDefinition = protoLoader.loadSync(resolveProtoPath(), {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    rewardtracking: {
      ingest: { v1: { RewardTrackingIngestService: grpc.ServiceClientConstructor } };
    };
  };
  return proto.rewardtracking.ingest.v1.RewardTrackingIngestService.service;
}

export interface RewardTrackingGrpcServerHandle {
  server: grpc.Server;
  port: number;
  appContext: INestApplicationContext;
  close: () => Promise<void>;
}

/**
 * Builds the DI container, constructs a real `grpc.Server`, registers the one RPC this contract
 * exposes, and binds it. `portOverride` exists solely so tests can bind an ephemeral, collision-free
 * port (`test/grpc/reward-tracking-ingest.grpc-controller.spec.ts`'s own precedent, mirroring
 * `reward-redemption-service`'s own `createGrpcMicroservice()` test-friendly export).
 */
export async function createRewardTrackingGrpcServer(
  portOverride?: number,
): Promise<RewardTrackingGrpcServerHandle> {
  const appContext = await NestFactory.createApplicationContext(GrpcServerRootModule, {
    logger: ['log', 'warn', 'error'],
  });
  const controller = appContext.get(RewardTrackingIngestGrpcController);

  const server = new grpc.Server();
  server.addService(loadServiceDefinition(), {
    IngestRewardTrackingEvent: controller.handleIngestRewardTrackingEvent,
  });

  const port = portOverride ?? resolvePort();
  await new Promise<void>((resolve, reject) => {
    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  return {
    server,
    port,
    appContext,
    close: async () => {
      await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
      await appContext.close();
    },
  };
}

const logger = new Logger('RewardTrackingGrpcServerBootstrap');

/* istanbul ignore next -- exercised as a real process by manual grpcurl verification (this task's
 * own verification step 2), not by the automated suite (which calls
 * `createRewardTrackingGrpcServer()` directly for a faster in-process real-Postgres run — see
 * `test/grpc/reward-tracking-ingest.grpc-controller.spec.ts`). */
if (require.main === module) {
  createRewardTrackingGrpcServer()
    .then((handle) => {
      logger.log(`RewardTrackingIngestService gRPC server listening on port ${handle.port}`);
    })
    .catch((error: unknown) => {
      logger.error(
        'gRPC server failed to start',
        error instanceof Error ? error.stack : String(error),
      );
      process.exitCode = 1;
    });
}
