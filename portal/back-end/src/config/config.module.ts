import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema';

/**
 * @Global so every module can inject `ConfigService<Env>` without re-importing this.
 * `validate` runs synchronously during Nest's bootstrap; a failure calls process.exit(1)
 * before any controller, guard or DB connection is ever constructed (see env.schema.ts).
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: ['.env.local', `.env.${process.env.NODE_ENV || 'development'}`, '.env'],
    }),
  ],
  exports: [NestConfigModule],
})
export class ConfigModule {}
