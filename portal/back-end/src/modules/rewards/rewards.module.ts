/**
 * T-032 — DI wiring for `/rewards`.
 *
 * Follows `rules.module.ts`'s precedent (T-031) exactly, plus `CryptoModule` (T-016) for
 * `FieldCryptoService`, which `RewardConnectorConfigCrypto` needs (implementation note 4). Not
 * imported by `AppModule` until now (see `crypto.module.ts`'s own header for why it is opt-in
 * per consumer rather than global) — this is the first Wave-3 feature module that needs it.
 */
import { Module } from '@nestjs/common';
import { AuditModule } from '@/common/audit/audit.module';
import { CryptoModule } from '@/common/crypto/crypto.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { DatabaseModule } from '@/database/database.module';
import { RewardConnectorConfigCrypto } from './reward-connector-config.crypto';
import { RewardsController } from './rewards.controller';
import { RewardsService } from './rewards.service';

@Module({
  imports: [RbacModule, AuditModule, DatabaseModule, CryptoModule],
  controllers: [RewardsController],
  providers: [RewardsService, RewardConnectorConfigCrypto],
  exports: [RewardsService],
})
export class RewardsModule {}
