/**
 * T-RR-010. Wires the shared `RewardIngestionService` + its own `RewardRedemptionEntryRepository`,
 * so each of the three inbound-channel tasks (`T-RR-011` gRPC, `T-RR-012` Kafka, `T-RR-013` REST)
 * imports this module directly instead of re-deriving how to construct either. `EncryptionModule`
 * is imported (not re-provided) so `RewardIngestionService` gets the same `EncryptionService`/
 * `LogRedactorService` instances the rest of this application uses (T-RR-005).
 *
 * Not registered in `AppModule`'s own imports by this task — unlike `EncryptionModule` (registered
 * directly by T-RR-005 specifically because its factory provider must crash boot eagerly even
 * without a real consumer yet), this module has no such standalone boot-time concern, and none of
 * this task's own "Files owned" includes `app.module.ts`. Each of `T-RR-011`/`T-RR-012`/`T-RR-013`
 * imports `RewardIngestionModule` directly into its own module and is the one that ultimately
 * wires a concrete controller/consumer/server into `AppModule`.
 *
 * `ObservabilityModule` is imported (T-RR-056) so `RewardIngestionService` can inject the real
 * `MetricsRegistry` and increment `reward_entries_ingested_total` — the identical
 * "import, don't re-provide" convention `EncryptionModule` already sets on this same module.
 */
import { Module } from '@nestjs/common';
import { EncryptionModule } from '@/modules/encryption/encryption.module';
import { ObservabilityModule } from '@/observability/observability.module';
import { RewardIngestionService } from './reward-ingestion.service';
import { RewardRedemptionEntryRepository } from './reward-redemption-entry.repository';

@Module({
  imports: [EncryptionModule, ObservabilityModule],
  providers: [RewardIngestionService, RewardRedemptionEntryRepository],
  exports: [RewardIngestionService],
})
export class RewardIngestionModule {}
