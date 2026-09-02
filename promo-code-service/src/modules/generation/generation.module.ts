/**
 * T-PC-056. Wires the REST transport adapter (`PromoCodeGenerateController`,
 * `GenerationServiceTokenGuard`, `GenerationServiceTokenStartupCheck`) onto the existing
 * `PromoCodeGenerationModule` (T-PC-021) — this module owns no domain logic of its own and opens
 * no new database connection; it only imports `PromoCodeGenerationModule` for its exported
 * `PromoCodeGenerationService`, same "reuse, don't duplicate" convention that module's own header
 * already established for `PromoCodeConfigModule`/`CampaignBindingModule`.
 *
 * Kept as a separate file/class from `promo-code-generation.module.ts` on purpose — that module is
 * the transport-neutral domain module (R10), this one is a transport adapter's own registration,
 * exactly the same split `grpc-server.module.ts`/`kafka-consumer.module.ts` already draw for the
 * other two transports.
 */
import { Module } from '@nestjs/common';
import { PromoCodeGenerationModule } from './promo-code-generation.module';
import { PromoCodeGenerateController } from './promo-code-generate.controller';
import { GenerationServiceTokenStartupCheck } from './generation-service-token-startup-check.provider';

@Module({
  imports: [PromoCodeGenerationModule],
  controllers: [PromoCodeGenerateController],
  providers: [GenerationServiceTokenStartupCheck],
})
export class GenerationModule {}
