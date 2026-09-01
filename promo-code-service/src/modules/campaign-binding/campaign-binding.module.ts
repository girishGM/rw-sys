/**
 * T-PC-012. Imports `PromoCodeConfigModule` (T-PC-010) to reuse both its `PROMO_CODE_SEQUELIZE`
 * connection pool and its exported `PromoCodeConfigService` — that module's own header already
 * anticipated this ("so the sibling `campaign-binding` module (T-PC-012, same file-scope owner)
 * can import this module and reuse both... instead of duplicating either"). No second Postgres
 * connection is opened here.
 *
 * `CampaignBindingService` is exported so T-PC-021 (Wave 2, a different agent's task, out of
 * this file scope) can import this module and call `resolveActiveBinding` in-process, per this
 * task's implementation note 5.
 */
import { Module } from '@nestjs/common';
import { PromoCodeConfigModule } from '../promo-code-config/promo-code-config.module';
import { CampaignBindingRepository } from './campaign-binding.repository';
import { CampaignBindingService } from './campaign-binding.service';
import { CampaignBindingController } from './campaign-binding.controller';

@Module({
  imports: [PromoCodeConfigModule],
  controllers: [CampaignBindingController],
  providers: [CampaignBindingRepository, CampaignBindingService],
  exports: [CampaignBindingService],
})
export class CampaignBindingModule {}
