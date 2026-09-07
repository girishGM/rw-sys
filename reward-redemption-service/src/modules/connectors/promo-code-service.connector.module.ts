/**
 * T-RR-031. Wires `PromoCodeServiceConnector` and registers it into T-RR-030's `ConnectorRegistry`
 * under `'PROMO_CODE_SERVICE'` from this module's own `onModuleInit` — exactly the pattern
 * `connector-registry.ts`'s own header (T-RR-030 implementation note 3) anticipates for both
 * connector tasks: "each calling `register()` from its own module's `onModuleInit` (or
 * equivalent) once it exists."
 *
 * Not itself in T-RR-031's "Files owned" list (only `promo-code-service.connector.ts`/`.types.ts`/
 * the spec file are), but required for the registration this task's own implementation note 7
 * asks for and squarely inside this agent's own `src/modules/connectors/**` file-scope grant —
 * same "extra file added when the implementation genuinely needs it, inside this agent's own
 * scope grant" precedent `dispatch.module.ts`'s/`reward-tracking-outbox.repository.ts`'s own
 * headers already establish for T-RR-034/T-RR-035.
 *
 * Not wired into `AppModule` by this task — same convention `ConnectorsModule`'s own header
 * documents ("registration into `AppModule` is the eventual real-caller's own job"); nothing in
 * this service's pipeline calls `ConnectorRegistry.resolve()` from a fully wired `AppModule` yet
 * (`RedemptionProcessingOrchestrator`, T-RR-024, is still `in_progress`).
 *
 * `ObservabilityModule` is imported (T-RR-059) so `PromoCodeServiceConnector` can inject the real
 * `MetricsRegistry` and increment `external_system_call_total` — the identical "import, don't
 * re-provide" convention `RewardIngestionModule` already sets for the same module (T-RR-056).
 *
 * **T-RR-080.** `PromoCodeChannelResolverService` and `PromoCodeServiceGrpcClient` are now also
 * provided here and injected into `PromoCodeServiceConnector` — the real DI graph always wires
 * both together (the connector's own header documents why either one alone, with the other
 * absent, still degrades safely to REST-only). Neither needs its own module: both are simple,
 * self-contained providers (own `pg.Pool`/gRPC channel respectively), the same "provide directly
 * on the connector's own module, no extra module file" precedent this module already sets for
 * itself. `PromoCodeServiceGrpcClient` is registered via a `useFactory` provider, not Nest's
 * implicit constructor-injection — its own constructor parameter is a plain options interface, not
 * a class, the identical reasoning RAP's own `dispatch.module.ts` documents for
 * `RewardGrpcFallbackClient` (confirmed by direct read).
 */
import { Module, type OnModuleInit } from '@nestjs/common';
import { EncryptionModule } from '@/modules/encryption/encryption.module';
import { ObservabilityModule } from '@/observability/observability.module';
import { ServiceConfigModule } from '@/modules/service-config/service-config.module';
import { ConnectorsModule } from './connectors.module';
import { ConnectorRegistry } from './connector-registry';
import { PromoCodeServiceConnector } from './promo-code-service.connector';
import { PromoCodeChannelResolverService } from './promo-code-channel-resolver.service';
import {
  PromoCodeServiceGrpcClient,
  loadPromoCodeServiceGrpcClientOptions,
} from './promo-code-service-grpc.client';
import { PromoCodeServiceKafkaClient } from './promo-code-service-kafka.client';

/**
 * T-RR-081. `PromoCodeServiceKafkaClient` is now also provided here and injected into
 * `PromoCodeServiceConnector` — same "provide directly on the connector's own module, no extra
 * module file" precedent `PromoCodeChannelResolverService`/`PromoCodeServiceGrpcClient` above
 * already set. Unlike either of those, it needs `ServiceConfigResolverService`
 * (`connectors.promoCode.kafkaReplyTimeoutMs`, that class's own header) — `ServiceConfigModule` is
 * imported here for exactly that, the same "import, don't re-provide" convention
 * `EncryptionModule`/`ObservabilityModule` already establish for this module.
 */
@Module({
  imports: [EncryptionModule, ConnectorsModule, ObservabilityModule, ServiceConfigModule],
  providers: [
    PromoCodeServiceConnector,
    PromoCodeChannelResolverService,
    {
      provide: PromoCodeServiceGrpcClient,
      useFactory: (): PromoCodeServiceGrpcClient =>
        new PromoCodeServiceGrpcClient(loadPromoCodeServiceGrpcClientOptions()),
    },
    PromoCodeServiceKafkaClient,
  ],
  exports: [PromoCodeServiceConnector],
})
export class PromoCodeServiceConnectorModule implements OnModuleInit {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly connector: PromoCodeServiceConnector,
  ) {}

  onModuleInit(): void {
    this.registry.register('PROMO_CODE_SERVICE', this.connector);
  }
}
