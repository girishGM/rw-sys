/**
 * T-032 — DI wiring for `/rewards`.
 *
 * Follows `rules.module.ts`'s precedent (T-031) exactly, plus `CryptoModule` (T-016) for
 * `FieldCryptoService`, which `RewardConnectorConfigCrypto` needs (implementation note 4). Not
 * imported by `AppModule` until now (see `crypto.module.ts`'s own header for why it is opt-in
 * per consumer rather than global) — this is the first Wave-3 feature module that needs it.
 *
 * T-116 adds `RewardCategoriesController` (`/reward-categories`, `/reward-sub-categories`) —
 * not in that task's own declared `Files owned` list, but this file is the only place a new
 * controller in this module can be registered, the same "module file is an addition to this
 * task's declared Files owned list" precedent `rules.module.ts`'s own header records for
 * T-030/T-031 (05-EXECUTION-PLAN.md §3 names `app.module.ts`/the router as append-only
 * registration points; a feature module's own `controllers`/`providers` array is the same kind
 * of surface, one level down).
 */
import { Module } from '@nestjs/common';
import { AuditModule } from '@/common/audit/audit.module';
import { CryptoModule } from '@/common/crypto/crypto.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { DatabaseModule } from '@/database/database.module';
import { RewardConnectorConfigCrypto } from './reward-connector-config.crypto';
import { RewardCategoriesController } from './reward-categories.controller';
import { RewardsController } from './rewards.controller';
import { RewardsService } from './rewards.service';

@Module({
  imports: [RbacModule, AuditModule, DatabaseModule, CryptoModule],
  controllers: [RewardsController, RewardCategoriesController],
  providers: [RewardsService, RewardConnectorConfigCrypto],
  exports: [RewardsService],
})
export class RewardsModule {}
