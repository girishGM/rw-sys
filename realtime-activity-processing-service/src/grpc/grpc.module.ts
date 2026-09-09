/**
 * T-RAP-022. Wires the gRPC transport adapter's own providers/controller. Imports
 * `ActivityMappingModule` (T-RAP-021, exported `ActivityIngestionService`) rather than duplicating
 * it — same "no second copy of the domain service" convention this project already follows
 * (`activity-mapping.module.ts`'s own header, `AGENT-PROTOCOL.md` R5).
 *
 * `ServiceIdentityRegistry` is built via a factory provider, not Nest's implicit constructor
 * injection — its own constructor parameter is a plain `ReadonlyMap`, not a class
 * (`service-identity.registry.ts`'s own header).
 *
 * ## T-INT-020's own `ProgressQueryController` wiring — deliberately NOT a plain `ProgressApiModule` import
 *
 * `ProgressQueryController` needs `ProgressService` (T-RAP-040), so the obvious move — mirroring
 * `ActivityMappingModule` above — would be `imports: [..., ProgressApiModule]`. That module's own
 * `providers` array also declares `ProgressApiAuthGuard`, though: a provider Nest instantiates
 * eagerly the moment its owning module initializes, *regardless* of whether anything in this
 * module's own dependency graph actually injects it (`ProgressApiAuthGuard` is only ever consumed
 * by `ProgressController`'s own `@UseGuards()`, a controller this module never registers).
 * `ProgressApiAuthGuard`'s own constructor eagerly calls `loadProgressApiAuthSecret()` (same
 * fail-loud-at-boot precedent this controller's own `secret` field copies) — so a plain
 * `ProgressApiModule` import would make `PROGRESS_API_AUTH_SECRET` a **new, silent requirement**
 * for booting this gRPC server at all, breaking every existing test/deployment that boots
 * `GrpcMicroserviceRootModule` without ever calling `ProgressQueryService` (confirmed against a
 * real run: `test/grpc/grpc-server.e2e-spec.ts` and `test/main/hybrid-bootstrap.e2e-spec.ts`, both
 * pre-existing and neither owned by this task, failed to boot with exactly that error before this
 * file took the approach below instead).
 *
 * So this module reuses `ProgressApiModule`'s own **exported providers** directly — `ProgressService`/
 * `ProgressRepository`, plus a second, independent `PROGRESS_API_SEQUELIZE`-token Postgres
 * connection built the identical way `progress-api.module.ts`'s own factory does — without
 * importing the module itself, and therefore without ever constructing its unrelated
 * `ProgressApiAuthGuard`/`ProgressController`/HTTP-only providers. `ProgressQueryController` has
 * its own bearer-token check instead (see that file's own header) — `ProgressApiAuthGuard` was
 * never going to be used by this transport regardless of how it's wired in. A second connection
 * pool to the same database, one per transport module, is this project's own established norm,
 * not a new pattern (`activity-mapping.module.ts`, `progress-api.module.ts` and every other
 * self-contained module here already each own their own pool — see those files' own headers).
 * `EncryptionModule` (for `ProgressService`'s own `EncryptionService` dependency) is imported
 * directly for the same reason; importing it a second time alongside `ActivityMappingModule`'s own
 * import of it is safe — Nest resolves a non-dynamic module import to the same singleton instance
 * everywhere it appears in the graph, exactly as `EncryptionModule`'s own header already documents
 * for its `campaign-config-cache.module.ts` sibling precedent.
 */
import { Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sequelize } from 'sequelize-typescript';
import type { Config } from '@/config/config.schema';
import { ActivityMappingModule } from '@/modules/activity-mapping/activity-mapping.module';
import { EncryptionModule } from '@/modules/encryption/encryption.module';
import {
  PROGRESS_API_SEQUELIZE,
  ProgressRepository,
} from '@/modules/progress-api/progress.repository';
import { ProgressService } from '@/modules/progress-api/progress.service';
import { loadServiceIdentityRegistry } from './grpc-server.config';
import { ServiceIdentityRegistry } from './service-identity.registry';
import { ResolvedIdentityContext } from './resolved-identity.context';
import { MtlsGuard } from './mtls.guard';
import { ActivityIngestController } from './activity-ingest.controller';
import { ProgressQueryController } from './progress-query.controller';

/**
 * Same "no built-in Nest lifecycle hook for a raw Sequelize instance" fix every other
 * self-contained connection in this project already applies — see `progress-api.module.ts`'s own
 * identically-named class for the canonical explanation.
 */
@Injectable()
class ProgressQuerySequelizeShutdownHook implements OnModuleDestroy {
  constructor(@Inject(PROGRESS_API_SEQUELIZE) private readonly sequelize: Sequelize) {}

  async onModuleDestroy(): Promise<void> {
    await this.sequelize.close();
  }
}

@Module({
  imports: [ActivityMappingModule, EncryptionModule],
  controllers: [ActivityIngestController, ProgressQueryController],
  providers: [
    {
      provide: ServiceIdentityRegistry,
      useFactory: (): ServiceIdentityRegistry =>
        new ServiceIdentityRegistry(loadServiceIdentityRegistry()),
    },
    ResolvedIdentityContext,
    MtlsGuard,
    // T-INT-020's own `ProgressQueryController` wiring — see this file's own header for why this
    // is a second, independent connection rather than a plain `ProgressApiModule` import.
    {
      provide: PROGRESS_API_SEQUELIZE,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Config, true>): Sequelize =>
        new Sequelize({
          dialect: 'postgres',
          host: configService.get('DB_HOST', { infer: true }),
          port: configService.get('DB_PORT', { infer: true }),
          database: configService.get('DB_NAME', { infer: true }),
          username: configService.get('DB_APP_USERNAME', { infer: true }),
          password: configService.get('DB_APP_PASSWORD', { infer: true }),
          logging: false,
          dialectOptions: configService.get('DB_SSL', { infer: true })
            ? { ssl: { require: true, rejectUnauthorized: false } }
            : {},
        }),
    },
    ProgressRepository,
    ProgressService,
    ProgressQuerySequelizeShutdownHook,
  ],
})
export class GrpcModule {}
