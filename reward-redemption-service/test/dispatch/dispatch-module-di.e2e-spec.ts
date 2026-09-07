/**
 * T-RR-064 — regression test for the defect this task fixes: `RewardTrackingRestClient`'s own
 * constructor had an interface-typed options parameter with a JS default (
 * `loadRewardTrackingRestClientOptions()`) but no `@Optional()` decorator, so real Nest DI treated
 * "no provider found for this token" as a hard failure and threw `"Nest can't resolve dependencies
 * of the RewardTrackingRestClient (?)"` at module-compile time — before this constructor's own
 * default value ever had a chance to run. Reproduced originally via
 * `test/redemption/redemption-completion-side-effects.spec.ts` (T-RR-061) and
 * `test/processing/claim-worker-module-di.e2e-spec.ts` (T-RR-058), both outside this task's own
 * file scope (`AGENT-PROTOCOL.md` R3) — this spec proves the same defect class directly against
 * `DispatchModule` itself, the actual module `RewardTrackingRestClient` is registered in, using
 * only files this task owns.
 *
 * Same "construct the real module graph, not a copy of it" precedent
 * `claim-worker-module-di.e2e-spec.ts` (T-RR-058) and `processing-module-di.e2e-spec.ts`
 * (T-RR-055) already established. Sets `REWARD_TRACKING_REST_TOKEN` directly in this file's own
 * `process.env` (never a real secret, never logged) rather than depending on `.env.development`
 * having a value for it — `.env.example`/`.env.development` are `agent-rr-foundation`'s own file
 * scope (R3), and whether either one documents/sets this fourth bearer token is a distinct,
 * separately filed concern (see this task's own completion report) from the DI-wiring defect this
 * spec exists to catch.
 *
 * **Deliberately never calls `.init()`** on the compiled module — same reasoning
 * `claim-worker-module-di.e2e-spec.ts` documents for its own module graph (this one transitively
 * pulls in `RedemptionStateMachineModule`-adjacent lifecycle hooks through nothing here directly,
 * but `.compile()` alone is sufficient to prove DI resolution and never issues any I/O, matching
 * that same precedent).
 */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@/config/config.module';
import { DispatchModule } from '@/modules/dispatch/dispatch.module';
import { DispatchChannelResolverService } from '@/modules/dispatch/dispatch-channel-resolver.service';
import { RewardTrackingOutboxRepository } from '@/modules/dispatch/reward-tracking-outbox.repository';
import { RewardTrackingKafkaProducerClient } from '@/modules/dispatch/reward-tracking-kafka-producer.client';
import { RewardTrackingRestClient } from '@/modules/dispatch/reward-tracking-rest.client';
import { RewardTrackingDispatchRetryRepository } from '@/modules/dispatch/reward-tracking-dispatch-retry.repository';
import { RewardTrackingDispatchRetryWorker } from '@/modules/dispatch/reward-tracking-dispatch-retry.worker';
import { OutboxPublisherService } from '@/modules/dispatch/outbox-publisher.service';

describe('T-RR-064 — DispatchModule compiles via real Nest DI', () => {
  const ORIGINAL_TOKEN = process.env.REWARD_TRACKING_REST_TOKEN;

  beforeAll(() => {
    // A real deployment/CI value would come from the environment, never a file this task owns —
    // see this file's own header. Never a real secret.
    process.env.REWARD_TRACKING_REST_TOKEN = 'test-only-reward-tracking-token';
  });

  afterAll(() => {
    process.env.REWARD_TRACKING_REST_TOKEN = ORIGINAL_TOKEN;
  });

  it('TC-2/TC-3: resolves RewardTrackingRestClient (constructed via its own JS-default options) and every sibling provider', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DispatchModule],
    }).compile();

    try {
      // The defect's own evidence named `RewardTrackingRestClient` as unresolvable in the real
      // graph — proving it is a real, DI-resolved singleton (not just present in the source tree)
      // is exactly what closes that evidence.
      expect(moduleRef.get(RewardTrackingRestClient)).toBeInstanceOf(RewardTrackingRestClient);
      // Adjacent providers in the same module — none of these has the interface/array-typed
      // constructor-param-without-@Optional() shape, so all must be unaffected by this fix.
      expect(moduleRef.get(DispatchChannelResolverService)).toBeInstanceOf(
        DispatchChannelResolverService,
      );
      expect(moduleRef.get(RewardTrackingOutboxRepository)).toBeInstanceOf(
        RewardTrackingOutboxRepository,
      );
      expect(moduleRef.get(RewardTrackingKafkaProducerClient)).toBeInstanceOf(
        RewardTrackingKafkaProducerClient,
      );
      expect(moduleRef.get(RewardTrackingDispatchRetryRepository)).toBeInstanceOf(
        RewardTrackingDispatchRetryRepository,
      );
      expect(moduleRef.get(RewardTrackingDispatchRetryWorker)).toBeInstanceOf(
        RewardTrackingDispatchRetryWorker,
      );
      expect(moduleRef.get(OutboxPublisherService)).toBeInstanceOf(OutboxPublisherService);
    } finally {
      // Real `pg.Pool`/kafkajs-backed providers were constructed above (never connected to,
      // `.compile()` never issues I/O — same reasoning `claim-worker-module-di.e2e-spec.ts`
      // documents for its own graph) — closing releases them rather than leaking an open handle
      // into the rest of the Jest run.
      await moduleRef.close();
    }
  });
});
