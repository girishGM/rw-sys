/**
 * T-PC-021. Imports `PromoCodeConfigModule` (T-PC-010, reused for its `PROMO_CODE_SEQUELIZE`
 * connection pool and exported `PromoCodeConfigService` — no second Postgres connection opened
 * here, same convention `campaign-binding.module.ts` already established) and
 * `CampaignBindingModule` (T-PC-012, for its exported `CampaignBindingService`, anticipated by
 * that module's own header: "so T-PC-021 ... can import this module and call
 * `resolveActiveBinding` in-process").
 *
 * `GENERATION_MAX_RETRY_ATTEMPTS` is read from `GENERATION_MAX_RETRY_ATTEMPTS` via
 * `ConfigService.get` **without** `{ infer: true }` — deliberately not added to
 * `src/config/config.schema.ts`'s required-env Zod schema (outside this task's file scope, R8),
 * because it is an optional tuning knob with a documented safe default (5,
 * `03-GRPC-CONTRACT.md` §4), not a required secret/connection string that must crash boot when
 * absent (`config.schema.ts`'s own header describes that class of field). `ConfigService` still
 * resolves any key present in `process.env`/the loaded `.env` file even when the key isn't in the
 * validated schema, so this stays a real, overridable env var without touching that file.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PromoCodeConfigModule } from '../promo-code-config/promo-code-config.module';
import { CampaignBindingModule } from '../campaign-binding/campaign-binding.module';
import { CodeGenerator } from './code-generator';
import { PromoCodeRepository } from './promo-code.repository';
import { PromoCodeGenerationService } from './promo-code-generation.service';
import {
  DEFAULT_GENERATION_MAX_RETRY_ATTEMPTS,
  GENERATION_MAX_RETRY_ATTEMPTS,
} from './promo-code-generation.constants';

@Module({
  imports: [PromoCodeConfigModule, CampaignBindingModule],
  providers: [
    CodeGenerator,
    PromoCodeRepository,
    {
      provide: GENERATION_MAX_RETRY_ATTEMPTS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): number => {
        const raw = configService.get<string>('GENERATION_MAX_RETRY_ATTEMPTS');
        const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
        return Number.isInteger(parsed) && parsed > 0
          ? parsed
          : DEFAULT_GENERATION_MAX_RETRY_ATTEMPTS;
      },
    },
    PromoCodeGenerationService,
  ],
  exports: [PromoCodeGenerationService],
})
export class PromoCodeGenerationModule {}
