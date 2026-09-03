import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import type { Config } from './config/config.schema';

/**
 * `ConfigModule.forRoot({ validate: validateConfig })` (config.module.ts) runs during
 * `NestFactory.create` below and calls `process.exit(1)` before this function ever reaches
 * `app.listen(...)` if a required environment variable is missing or malformed (TC-4) — see
 * config.schema.ts's header for the full contract.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService<Config, true>);
  const port = configService.get('PORT', { infer: true });

  await app.listen(port);
}

bootstrap();
