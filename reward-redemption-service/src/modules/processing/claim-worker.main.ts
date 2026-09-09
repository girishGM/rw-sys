/**
 * T-RR-058 (defect fix). Standalone composition root for the claim-worker poll loop, run as its
 * own process — mirrors `src/grpc/grpc-server.main.ts` (T-RR-011) / `src/messaging/ingest/
 * kafka-consumer.main.ts` (T-RR-012)'s own precedent in full: `src/main.ts`/`src/app.module.ts` are
 * both exclusively `agent-rr-foundation`'s file scope (`project.config.json`), and this defect's own
 * evidence ("there is no standalone claim-worker bootstrap entry point either, unlike
 * `grpc-server.main.ts`/`kafka-consumer.main.ts`") names the missing half of that exact pattern.
 * Rather than edit either foundation-owned file, this ships a fully self-contained composition
 * root instead — its own tiny root module (`ClaimWorkerRootModule` below, importing the `@Global`
 * `ConfigModule` — needed transitively because `ClaimWorkerModule`'s own dependency chain
 * (`RewardRedemptionEntryClaimRepository`, the two real connector modules,
 * `RedemptionStateMachineModule`, ...) injects `ConfigService<Config, true>` at several points —
 * and this task's own `ClaimWorkerModule`) plus a `NestFactory.createApplicationContext(...)`
 * bootstrap (an application context, not a microservice/HTTP listener — the claim worker is a pure
 * background poll loop with no inbound transport of its own, the identical shape
 * `kafka-consumer.main.ts` already uses for the same reason).
 *
 * **Follow-up flagged for the architect/reviewer** (this task's own completion report): running
 * this as a third standalone OS process alongside `main.ts`'s HTTP process and the gRPC/Kafka
 * processes is a legitimate, working deployment shape (`ARCHITECTURE.md` never mandates one
 * process, and `grpc-server.main.ts`'s own header already established this same precedent) — but
 * folding it into a single hybrid process via `main.ts`, or wiring an actual process-manager/
 * `package.json` script entry for it, is a follow-up for `agent-rr-foundation`, since both require
 * editing a file outside this task's scope.
 *
 * **Not exercised by an `.init()`/`NestFactory.createApplicationContext()` test.** Unlike
 * `grpc-server.main.ts`/`kafka-consumer.main.ts` (each exercised by their own real e2e spec that
 * boots the exported root module directly), this file's own `ClaimWorkerRootModule` is instead
 * proven correct via a `Test.createTestingModule(...).compile()`-only check
 * (`test/processing/claim-worker-module-di.e2e-spec.ts`) — deliberately never calling `.init()` on
 * it. Reason: `.init()` runs `onApplicationBootstrap` on *every* provider in the graph, and this
 * module's own transitive import of `RedemptionStateMachineModule` pulls in
 * `CompletionSweepService`, whose `onApplicationBootstrap` unconditionally starts its own real,
 * unscoped sweep loop against the shared `reward_redemption_entry` table (confirmed by direct read,
 * `completion-sweep.service.ts` — no `enabled` gate exists there at all, unlike this file's own
 * `ClaimWorkerService`). Combined with `ClaimWorkerService`'s own real claim loop, an `.init()`'d
 * test here would immediately start claiming/sweeping real rows out from under every other
 * concurrently-running real-Postgres spec file in this repo, with no tenant-scoping seam available
 * to contain it from this task's own file scope (`completion-sweep.service.ts` is
 * `src/modules/redemption/**`, in scope, but adding a scoping mechanism to it is a materially
 * different, not-yet-filed unit of work, not this defect's own fix). `.compile()` alone never calls
 * `onModuleInit`/`onApplicationBootstrap` (confirmed by direct read,
 * `@nestjs/testing/testing-module.builder.js`), so it proves the DI graph is valid Nest wiring
 * without ever touching the real table — the same real hazard this task's own regression test
 * instead proves the *fix* against using tenant-scoped, directly-constructed real-DB fixtures
 * (`claim-worker.service.spec.ts`'s own real-Postgres describe block), never a live application
 * context. Running this file's own `bootstrap()` for real (as any deployed instance of this process
 * does) is exactly the intended, correct behavior — only an automated *test* of it is unsafe against
 * the shared table.
 *
 * **T-INT-053 (retry 1 — widened scope).** The independent review of this task's first attempt
 * found a real gap: `src/main.ts`'s own `PROMO_CODE_KAFKA_REPLY_CONSUMER_ENABLED` gate (that
 * task's original fix) never reaches Render's actual deployed topology, because THIS file — not
 * `src/main.ts` — is the one composition root that ever resolves `PromoCodeServiceConnector`/calls
 * `requestAndAwaitReply()` in production (`render.yaml`'s own dedicated `worker` service runs
 * this file; the `web` service running `src/main.ts` never sets `CLAIM_WORKER_ENABLED`, so it
 * never constructs this DI graph at all). `startPromoCodeKafkaReplyConsumer()` below closes that
 * gap the same "reuse the exported bootstrap, add one more `.start()` call" way `src/main.ts`'s
 * own T-INT-053 gate already does — resolving `PromoCodeServiceKafkaClient` from the exact same
 * `INestApplicationContext` this process already builds (never a second, independently-constructed
 * context — the same in-memory pending-reply-registry reasoning `src/main.ts`'s own header
 * documents in full applies identically here, since this IS the process that DI graph reasoning
 * describes).
 *
 * Deliberately **not** gated behind a new env var, unlike `src/main.ts`'s own opt-in gate: this
 * process's entire purpose is already running exactly this pipeline (`CLAIM_WORKER_ENABLED`
 * defaults enabled here, `render.yaml`'s own note), so there is no shared, unrelated responsibility
 * this new consumer could conflict with the way a gate on the multi-purpose `web` process protects
 * `/health`. It IS, however, non-fatal: `startPromoCodeKafkaReplyConsumer()` catches and logs
 * rather than throws, so an unreachable/placeholder `KAFKA_BROKERS` value (this Blueprint's own
 * documented `sync: false` state today, since Render provisions no Kafka cluster — `render.yaml`'s
 * own header) degrades to "Kafka-primary `rr-to-promo-code` redemptions still time out and retry,
 * exactly as before this fix" rather than crashing the entire worker process and halting every
 * redemption regardless of transport — the same "a transport failing to start must not take down
 * anything else" principle `src/main.ts`'s own `attemptOptionalTransport` already established,
 * reproduced narrowly here rather than imported from that file (a distinct, `web`-service-only
 * composition root this file has no reason to depend on).
 */
import 'reflect-metadata';
import { loadDotenvFilesIntoProcessEnv } from '@/config/load-dotenv-files';

// Deliberately before the `ConfigModule`/`ClaimWorkerModule` imports below — see this file's own
// header and `main.ts`'s/`grpc-server.main.ts`'s own headers (T-RR-050) for why import/call
// position both matter here.
loadDotenvFilesIntoProcessEnv();

import { Module, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { ConfigModule } from '@/config/config.module';
import { PromoCodeServiceKafkaClient } from '@/modules/connectors/promo-code-service-kafka.client';
import { ClaimWorkerModule } from './claim-worker.module';

@Module({
  imports: [ConfigModule, ClaimWorkerModule],
})
export class ClaimWorkerRootModule {}

const logger = new Logger('ClaimWorkerBootstrap');

/** Always returns a constructed application context — `ClaimWorkerModule`'s own
 * `CLAIM_WORKER_ENABLED` (default enabled) governs whether `ClaimWorkerService` actually starts
 * polling once `onApplicationBootstrap` runs (`claim-worker.module.ts`'s own header), the same
 * "the module itself owns the enabled/disabled decision" shape already proven safe by
 * `ClaimWorkerService`'s own existing `enabled: false` test case — there is no need to duplicate
 * that gate here the way `kafka-consumer.main.ts` does for its own transport-level
 * `KAFKA_CONSUMER_ENABLED` check. */
export async function createClaimWorkerContext(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(ClaimWorkerRootModule);
}

/**
 * T-INT-053 (retry 1). Resolves `PromoCodeServiceKafkaClient` from the SAME context this process
 * already built for the claim worker itself (this file's own header has the full "why not a
 * second context" reasoning) and starts its shared `promo-code.generate.result.v1` reply consumer.
 * Never throws — a failure here is logged and swallowed so it can never take down the claim
 * worker's own poll loop, which this file's whole existence is dedicated to keeping running.
 * Exported (not inlined into `bootstrap()`) so it can be unit-tested directly against a fake
 * context, without needing a full `.init()`'d real application context
 * (this file's own header explains why that is unsafe to do in an automated test).
 */
export async function startPromoCodeKafkaReplyConsumer(
  context: INestApplicationContext,
): Promise<PromoCodeServiceKafkaClient | null> {
  try {
    const client = context.get(PromoCodeServiceKafkaClient);
    await client.start();
    logger.log(
      'promo-code.generate.result.v1 Kafka reply consumer (PromoCodeServiceKafkaClient): ' +
        'started (claim-worker process)',
    );
    return client;
  } catch (error) {
    logger.error(
      'promo-code.generate.result.v1 Kafka reply consumer failed to start — Kafka-primary ' +
        'rr-to-promo-code redemptions will time out and retry exactly as before this fix, but ' +
        'the claim worker poll loop itself keeps running unaffected (REST/gRPC-primary ' +
        'redemptions are not impacted by this failure).',
      error instanceof Error ? error.stack : String(error),
    );
    return null;
  }
}

export async function bootstrap(): Promise<void> {
  const context = await createClaimWorkerContext();
  logger.log('Claim worker started (poll loop running via OnApplicationBootstrap)');
  await startPromoCodeKafkaReplyConsumer(context);
}

/* istanbul ignore next -- exercised as a real process against the real local Postgres/connector
 * targets, not by the automated unit suite (this file's own header explains why the automated
 * suite deliberately never calls `.init()`/`createApplicationContext()` on this exact root module). */
if (require.main === module) {
  bootstrap().catch((error) => {
    logger.error('Claim worker failed to start', error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
