/**
 * T-INT-053 (retry 1 — widened scope). Regression coverage for the actual production-topology gap
 * the independent review of this task's first attempt found: `src/main.ts`'s own
 * `PROMO_CODE_KAFKA_REPLY_CONSUMER_ENABLED` gate never reaches Render's real deployed process,
 * because `claim-worker.main.ts` — not `src/main.ts` — is the one composition root
 * `render.yaml`'s own dedicated `worker` service actually runs, and the only place
 * `PromoCodeServiceConnector`/`requestAndAwaitReply()` is ever resolved in production.
 *
 * This file proves `startPromoCodeKafkaReplyConsumer()` — the function `claim-worker.main.ts`'s own
 * `bootstrap()` now calls — against a fake `INestApplicationContext`, exactly the same testing
 * discipline `test/main/promo-code-kafka-reply-consumer-hybrid-gate.e2e-spec.ts` already
 * established for `src/main.ts`'s own analogous gate: `PromoCodeServiceKafkaClient` itself is a
 * REAL instance (constructed directly, bypassing DI) with only its own `start()` method spied on,
 * never a hand-rolled stand-in with the same name (AGENT-PROTOCOL.md §3). This deliberately never
 * calls `createClaimWorkerContext()`/`bootstrap()` themselves — this file's own header explains why
 * that would unsafely start a real, unscoped `CompletionSweepService` sweep loop against the shared
 * `reward_redemption_entry` table — matching the identical precedent
 * `test/processing/claim-worker-module-di.e2e-spec.ts` already sets for this same file.
 */
import { ConfigService } from '@nestjs/config';
import type { INestApplicationContext } from '@nestjs/common';
import { startPromoCodeKafkaReplyConsumer } from '@/modules/processing/claim-worker.main';
import { PromoCodeServiceKafkaClient } from '@/modules/connectors/promo-code-service-kafka.client';
import type { Config } from '@/config/config.schema';

/** Same fake shape `promo-code-kafka-reply-consumer-hybrid-gate.e2e-spec.ts` already establishes. */
function fakePromoCodeServiceKafkaClient(): {
  client: PromoCodeServiceKafkaClient;
  startSpy: jest.SpyInstance<Promise<void>, []>;
} {
  const fakeConfigService = { get: () => 'localhost:9094' } as unknown as ConfigService<
    Config,
    true
  >;
  const fakeServiceConfig = { resolve: jest.fn().mockResolvedValue(10_000) };
  const client = new PromoCodeServiceKafkaClient(fakeConfigService, fakeServiceConfig);
  const startSpy = jest.spyOn(client, 'start').mockResolvedValue(undefined);
  return { client, startSpy };
}

function fakeContextResolving(client: PromoCodeServiceKafkaClient): INestApplicationContext {
  return { get: jest.fn().mockReturnValue(client) } as unknown as INestApplicationContext;
}

describe('T-INT-053 (retry 1) — claim-worker.main.ts starts PromoCodeServiceKafkaClient from its OWN process context', () => {
  it('TC-1: resolves PromoCodeServiceKafkaClient from the given context and calls the real .start()', async () => {
    const { client, startSpy } = fakePromoCodeServiceKafkaClient();
    const context = fakeContextResolving(client);

    const result = await startPromoCodeKafkaReplyConsumer(context);

    expect(context.get).toHaveBeenCalledWith(PromoCodeServiceKafkaClient);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe(client);
  });

  it('TC-2 (non-fatal): a failing .start() (e.g. unreachable/placeholder KAFKA_BROKERS) is logged and swallowed, never thrown', async () => {
    const { client, startSpy } = fakePromoCodeServiceKafkaClient();
    const boom = new Error('simulated broker connection failure');
    startSpy.mockRejectedValue(boom);
    const context = fakeContextResolving(client);

    // Must resolve, not reject — the claim worker's own poll loop must keep running even if this
    // one reply consumer fails to start (this file's own header/`claim-worker.main.ts`'s header).
    await expect(startPromoCodeKafkaReplyConsumer(context)).resolves.toBeNull();
  });

  it('TC-3: a synchronously-throwing context.get(...) (e.g. the provider is missing from the graph) is also non-fatal', async () => {
    const context = {
      get: jest.fn().mockImplementation(() => {
        throw new Error("Nest can't resolve dependencies of PromoCodeServiceKafkaClient");
      }),
    } as unknown as INestApplicationContext;

    await expect(startPromoCodeKafkaReplyConsumer(context)).resolves.toBeNull();
  });
});
