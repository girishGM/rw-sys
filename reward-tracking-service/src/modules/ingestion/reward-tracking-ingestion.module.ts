/**
 * T-RTS-010. Wires the shared `RewardTrackingIngestionService` and its own four repositories +
 * `ShardCountResolverService` + `CustomerIdCryptoService`, so each of the three inbound-channel tasks
 * (`T-RTS-011` gRPC, `T-RTS-012` Kafka, `T-RTS-013` REST) imports this module directly instead of
 * re-deriving how to construct any of them.
 *
 * `CustomerIdCryptoService` is provided via a factory (not plain constructor injection) for the exact
 * same reason `reward-redemption-service`'s own `EncryptionModule` provides `EncryptionService` that
 * way: its constructor parameter is a plain `CustomerIdCryptoKeyMaterial` interface, not a class, so
 * Nest's `design:paramtypes` reflection cannot resolve it to a DI token on its own, and
 * `loadCustomerIdCryptoKeyMaterial()`'s throw-on-missing/malformed-env-var must happen eagerly, at
 * module-construction time — a missing `FIELD_ENCRYPTION_AES_KEY`/`FIELD_ENCRYPTION_HMAC_KEY` must
 * crash boot loudly (R6/R12), never surface only once the first real event arrives.
 *
 * Not registered in `AppModule`'s own imports by this task (`app.module.ts` isn't in this task's
 * "Files owned" list) — each of `T-RTS-011`/`T-RTS-012`/`T-RTS-013` imports
 * `RewardTrackingIngestionModule` directly into its own module and is the one that ultimately wires a
 * concrete controller/consumer/server into `AppModule`, mirroring `reward-redemption-service`'s own
 * `RewardIngestionModule` precedent exactly.
 */
import { Module } from '@nestjs/common';
import { LoggingModule } from '@/observability/logging.module';
import { RewardTrackingIngestionService } from './reward-tracking-ingestion.service';
import { InboundEventLogRepository } from './inbound-event-log.repository';
import { RewardFactRepository } from './reward-fact.repository';
import { CustomerRewardLedgerRepository } from './customer-reward-ledger.repository';
import { CampaignRewardCounterShardRepository } from './campaign-reward-counter-shard.repository';
import { ShardCountResolverService } from './shard-count-resolver.service';
import {
  CustomerIdCryptoService,
  loadCustomerIdCryptoKeyMaterial,
} from './customer-id-crypto.service';

@Module({
  imports: [LoggingModule],
  providers: [
    RewardTrackingIngestionService,
    InboundEventLogRepository,
    RewardFactRepository,
    CustomerRewardLedgerRepository,
    CampaignRewardCounterShardRepository,
    ShardCountResolverService,
    {
      provide: CustomerIdCryptoService,
      useFactory: (): CustomerIdCryptoService =>
        new CustomerIdCryptoService(loadCustomerIdCryptoKeyMaterial()),
    },
  ],
  exports: [RewardTrackingIngestionService],
})
export class RewardTrackingIngestionModule {}
