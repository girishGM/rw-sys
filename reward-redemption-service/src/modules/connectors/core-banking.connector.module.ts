/**
 * T-RR-032. Wires `CoreBankingConnector` and registers it into T-RR-030's `ConnectorRegistry`
 * under `'CORE_BANKING'` from this module's own `onModuleInit` — the exact same pattern
 * `PromoCodeServiceConnectorModule` (T-RR-031) already establishes for its own connector.
 *
 * Not itself in T-RR-032's "Files owned" list (only `core-banking.connector.ts`/the spec file
 * are), but required for the registration implementation note 6 asks for and squarely inside this
 * agent's own `src/modules/connectors/**` file-scope grant — same "extra file added when the
 * implementation genuinely needs it, inside this agent's own scope grant" precedent
 * `promo-code-service.connector.module.ts`'s own header already establishes.
 *
 * Not wired into `AppModule` by this task — same convention `ConnectorsModule`/
 * `PromoCodeServiceConnectorModule` both already document.
 *
 * `ObservabilityModule` is imported (T-RR-059) so `CoreBankingConnector` can inject the real
 * `MetricsRegistry` and increment `external_system_call_total` — the identical "import, don't
 * re-provide" convention `RewardIngestionModule` already sets for the same module (T-RR-056).
 */
import { Module, type OnModuleInit } from '@nestjs/common';
import { ServiceConfigModule } from '@/modules/service-config/service-config.module';
import { ObservabilityModule } from '@/observability/observability.module';
import { ConnectorsModule } from './connectors.module';
import { ConnectorRegistry } from './connector-registry';
import { CoreBankingConnector } from './core-banking.connector';

@Module({
  imports: [ServiceConfigModule, ConnectorsModule, ObservabilityModule],
  providers: [CoreBankingConnector],
  exports: [CoreBankingConnector],
})
export class CoreBankingConnectorModule implements OnModuleInit {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly connector: CoreBankingConnector,
  ) {}

  onModuleInit(): void {
    this.registry.register('CORE_BANKING', this.connector);
  }
}
