/**
 * T-RAP-040. Owns its own runtime Postgres connection (the least-privilege `rap_app` role, R1) —
 * same self-contained-connection precedent every prior module in this service follows (see
 * `activity-mapping.module.ts`'s own header). Imports `EncryptionModule` for `EncryptionService`
 * (`customer_id_hash`, R4) rather than opening a second copy of it.
 *
 * Not wired into `AppModule` (`src/app.module.ts` is `agent-rap-foundation`'s exclusive file
 * scope, not this task's — same reasoning `src/grpc/grpc-server.main.ts`'s own header documents
 * for the identical constraint). `progress-api-server.main.ts` (this same directory, this same
 * file-scope owner) is this module's own standalone composition root instead.
 */
import { Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sequelize } from 'sequelize-typescript';
import type { Config } from '@/config/config.schema';
import { EncryptionModule } from '@/modules/encryption/encryption.module';
import { ProgressApiAuthGuard } from './progress-api-auth.guard';
import { ProgressController } from './progress.controller';
import { PROGRESS_API_SEQUELIZE, ProgressRepository } from './progress.repository';
import { ProgressService } from './progress.service';

/**
 * `ProgressApiModule`'s own Sequelize connection pool has no built-in Nest lifecycle hook by
 * default — same leaked-connection fix every prior module's own `SequelizeShutdownHook` already
 * documents (see e.g. `activity-mapping.module.ts`'s own header).
 */
@Injectable()
class SequelizeShutdownHook implements OnModuleDestroy {
  constructor(@Inject(PROGRESS_API_SEQUELIZE) private readonly sequelize: Sequelize) {}

  async onModuleDestroy(): Promise<void> {
    await this.sequelize.close();
  }
}

@Module({
  imports: [EncryptionModule],
  controllers: [ProgressController],
  providers: [
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
    ProgressApiAuthGuard,
    SequelizeShutdownHook,
  ],
  exports: [PROGRESS_API_SEQUELIZE, ProgressRepository, ProgressService],
})
export class ProgressApiModule {}
