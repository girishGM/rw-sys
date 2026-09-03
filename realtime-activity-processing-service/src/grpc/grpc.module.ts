/**
 * T-RAP-022. Wires the gRPC transport adapter's own providers/controller. Imports
 * `ActivityMappingModule` (T-RAP-021, exported `ActivityIngestionService`) rather than duplicating
 * it — same "no second copy of the domain service" convention this project already follows
 * (`activity-mapping.module.ts`'s own header, `AGENT-PROTOCOL.md` R5).
 *
 * `ServiceIdentityRegistry` is built via a factory provider, not Nest's implicit constructor
 * injection — its own constructor parameter is a plain `ReadonlyMap`, not a class
 * (`service-identity.registry.ts`'s own header).
 */
import { Module } from '@nestjs/common';
import { ActivityMappingModule } from '@/modules/activity-mapping/activity-mapping.module';
import { loadServiceIdentityRegistry } from './grpc-server.config';
import { ServiceIdentityRegistry } from './service-identity.registry';
import { ResolvedIdentityContext } from './resolved-identity.context';
import { MtlsGuard } from './mtls.guard';
import { ActivityIngestController } from './activity-ingest.controller';

@Module({
  imports: [ActivityMappingModule],
  controllers: [ActivityIngestController],
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
