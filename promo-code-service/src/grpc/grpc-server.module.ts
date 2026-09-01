/**
 * T-PC-031. Wires the gRPC transport adapter's own providers/controller. Imports
 * `PromoCodeGenerationModule` (T-PC-021, exported `PromoCodeGenerationService`) and
 * `PromoCodeConfigModule` (T-PC-010, exported `PROMO_CODE_SEQUELIZE` + `PromoCodeConfigRepository`)
 * rather than duplicating either — same "no second Postgres connection, no second copy of a
 * service" convention every other module in this schema already follows
 * (`campaign-binding.module.ts`'s own header). `ServiceIdentityRepository` reuses the same
 * `PROMO_CODE_SEQUELIZE` pool for its own table (`grpc_service_identity`, migration `008`).
 */
import { Module } from '@nestjs/common';
import { PromoCodeGenerationModule } from '../modules/generation/promo-code-generation.module';
import { PromoCodeConfigModule } from '../modules/promo-code-config/promo-code-config.module';
import { ServiceIdentityRepository } from './service-identity.repository';
import { MtlsGuard } from './mtls.guard';
import { PromoCodeController } from './promo-code.controller';

@Module({
  imports: [PromoCodeGenerationModule, PromoCodeConfigModule],
  controllers: [PromoCodeController],
  providers: [ServiceIdentityRepository, MtlsGuard],
})
export class GrpcServerModule {}
