/**
 * T-RR-011. Wires the gRPC transport adapter's own providers/controller. Imports
 * `RewardIngestionModule` (T-RR-010, exported `RewardIngestionService`) rather than duplicating
 * it — the R10 "one shared domain method, three thin adapters" convention this whole wave follows.
 *
 * `ServiceIdentityRegistry` is built via a factory provider, not Nest's implicit constructor
 * injection — its own constructor parameter is a plain `ReadonlyMap`, not a class
 * (`service-identity.registry.ts`'s own header).
 */
import { Module } from '@nestjs/common';
import { RewardIngestionModule } from '@/modules/reward-ingestion/reward-ingestion.module';
import { loadServiceIdentityRegistry } from './grpc-server.config';
import { ServiceIdentityRegistry } from './service-identity.registry';
import { ResolvedIdentityContext } from './resolved-identity.context';
import { MtlsGuard } from './mtls.guard';
import { RewardIngestController } from './reward-ingest.controller';

@Module({
  imports: [RewardIngestionModule],
  controllers: [RewardIngestController],
  providers: [
    {
      provide: ServiceIdentityRegistry,
      useFactory: (): ServiceIdentityRegistry =>
        new ServiceIdentityRegistry(loadServiceIdentityRegistry()),
    },
    ResolvedIdentityContext,
    MtlsGuard,
  ],
})
export class GrpcModule {}
