import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validateConfig } from './config.schema';

/**
 * @Global so every module can inject `ConfigService<Config>` without re-importing this.
 * `validate` (config.schema.ts) runs synchronously during Nest's bootstrap; a failure calls
 * `process.exit(1)` before any controller, guard or DB connection is ever constructed —
 * see that file's header and TC-4.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validate: validateConfig,
      envFilePath: ['.env.local', `.env.${process.env.NODE_ENV || 'development'}`, '.env'],
    }),
  ],
  exports: [NestConfigModule],
})
export class ConfigModule {}
