/**
 * T-RR-034. First module registration for `src/modules/dispatch/**` — T-RR-033's own three files
 * (`dispatch-channel-config.repository.ts`/`.cache.ts`/`dispatch-channel-resolver.service.ts`)
 * were built without one (that task's own "Files owned" list has no `dispatch.module.ts"), so this
 * task wires all of them together with this task's own outbound-Kafka-leg providers.
 *
 * Imports `EncryptionModule` (T-RR-005, done) and `ServiceConfigModule` (T-RR-006, done) rather
 * than reaching into `src/modules/encryption/**`/`src/modules/service-config/**` directly — both
 * are other agents' own file scope (R3); importing their already-exported modules is normal
 * cross-module consumption, not an edit to any file either one owns.
 *
 * **Not wired into `AppModule` by this task** — same convention `ClaimWorkerModule` (T-RR-020),
 * `ServiceConfigModule` (T-RR-006) and `RedemptionStateMachineModule` (T-RR-021) already
 * documented: `AppModule` isn't in this task's own "Files owned" list (R3), and
 * `RedemptionStateMachineModule`'s own `REDEMPTION_COMPLETION_SIDE_EFFECTS_PORT` binding is still
 * the `NotImplementedRedemptionCompletionSideEffects` stub (`redemption-completion-side-effects.
 * port.ts`'s own header) — nothing calls `RewardTrackingOutboxRepository.enqueue()` from the real
 * pipeline yet. Swapping that provider binding for a real implementation built on top of this
 * module's own exports (and T-RR-036's `NotificationService`) is a distinct, not-yet-filed unit of
 * work belonging to whichever task next wires `RedemptionStateMachineModule` into `AppModule` for
 * real use (`redemption-state-machine.module.ts`'s own header names T-RR-024 as "the first real
 * caller" — that module is `src/modules/redemption/**`, outside this task's own file scope, R3).
 * Flagged for the architect in this task's own completion report rather than worked around here.
 *
 * **T-RR-035 extends this same file** (both tasks are `agent-rr-integration`'s own) with the REST
 * fallback client, the tier-3 retry repository/worker, and their DI wiring into
 * `OutboxPublisherService`'s own now-three-dependency constructor — same "extra registration added
 * when the implementation genuinely needs it, inside this agent's own `dispatch/**` scope grant"
 * precedent this file's own header already establishes.
 *
 * **T-RR-062 adds `RewardTrackingGrpcClient`** (the third dispatch channel) to both `providers` and
 * `exports` — same "extra registration added when the implementation genuinely needs it, inside
 * this agent's own `dispatch/**` scope grant" precedent this file's own header already establishes.
 * `OutboxPublisherService` receives it as its own new, `@Optional()`, last constructor parameter
 * (see that file's own header for why it is appended last, not inserted alongside
 * `kafkaProducer`/`restClient`) — Nest's normal type-based DI still supplies a real instance here,
 * this module being the one place that actually constructs the full provider graph.
 *
 * **T-RR-069 adds `TenantSchemaCacheModule` (`agent-rr-foundation`'s own file scope, T-RR-007) as
 * an import**, purely to reach its already-exported `DispatchChannelConfigCache` — the *real*,
 * invalidation-endpoint-and-reconciliation-poller-connected instance — and alias it onto the
 * `DISPATCH_CHANNEL_CONFIG_REAL_CACHE` token this module's own `DispatchChannelConfigCache`
 * (T-RR-033's class, `./dispatch-channel-config.cache.ts`) now optionally accepts as a fourth
 * constructor argument. This is the same "importing an already-exported module is normal
 * cross-module consumption, not an edit to any file either one owns" precedent this file's own
 * header already established for `EncryptionModule`/`ServiceConfigModule` — never a change to
 * `tenant-schema-cache.module.ts` itself. No cycle: `TenantSchemaCacheModule` does not import
 * `DispatchModule` (directly or transitively), so this is a plain one-directional edge, same as
 * `CacheInvalidationModule`'s own import of `TenantSchemaCacheModule`. See
 * `dispatch-channel-config.cache.ts`'s own header for the full defect/fix writeup.
 */
import { Module } from '@nestjs/common';
import { EncryptionModule } from '@/modules/encryption/encryption.module';
import { ServiceConfigModule } from '@/modules/service-config/service-config.module';
import { TenantSchemaCacheModule } from '@/modules/tenant-schema-cache/tenant-schema-cache.module';
import { DispatchChannelConfigCache as SharedDispatchChannelConfigCache } from '@/modules/tenant-schema-cache/dispatch-channel-config.cache';
import { DispatchChannelConfigRepository } from './dispatch-channel-config.repository';
import {
  DISPATCH_CHANNEL_CONFIG_REAL_CACHE,
  DispatchChannelConfigCache,
} from './dispatch-channel-config.cache';
import { DispatchChannelResolverService } from './dispatch-channel-resolver.service';
import { RewardTrackingOutboxRepository } from './reward-tracking-outbox.repository';
import { RewardTrackingKafkaProducerClient } from './reward-tracking-kafka-producer.client';
import { RewardTrackingRestClient } from './reward-tracking-rest.client';
import { RewardTrackingGrpcClient } from './reward-tracking-grpc.client';
import { RewardTrackingDispatchRetryRepository } from './reward-tracking-dispatch-retry.repository';
import { RewardTrackingDispatchRetryWorker } from './reward-tracking-dispatch-retry.worker';
import { DispatchMetricsService } from './dispatch-metrics.service';
import { OutboxPublisherService } from './outbox-publisher.service';

@Module({
  imports: [EncryptionModule, ServiceConfigModule, TenantSchemaCacheModule],
  providers: [
    DispatchChannelConfigRepository,
    // T-RR-069: aliases the token `DispatchChannelConfigCache` optionally injects (see that
    // file's own header) onto the one real, shared instance `TenantSchemaCacheModule` already
    // exports and `CacheInvalidationService`/`ReconciliationPollerService` already operate on —
    // `useExisting` (not `useValue`/`useFactory`), so this is a plain alias, never a second
    // instance.
    { provide: DISPATCH_CHANNEL_CONFIG_REAL_CACHE, useExisting: SharedDispatchChannelConfigCache },
    DispatchChannelConfigCache,
    DispatchChannelResolverService,
    RewardTrackingOutboxRepository,
    RewardTrackingKafkaProducerClient,
    RewardTrackingRestClient,
    RewardTrackingGrpcClient,
    RewardTrackingDispatchRetryRepository,
    RewardTrackingDispatchRetryWorker,
    DispatchMetricsService,
    OutboxPublisherService,
  ],
  exports: [
    DispatchChannelResolverService,
    RewardTrackingOutboxRepository,
    RewardTrackingKafkaProducerClient,
    RewardTrackingRestClient,
    RewardTrackingGrpcClient,
    RewardTrackingDispatchRetryRepository,
    RewardTrackingDispatchRetryWorker,
    DispatchMetricsService,
    OutboxPublisherService,
  ],
})
export class DispatchModule {}
