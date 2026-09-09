/**
 * T-RTS-012. Wires the Kafka transport adapter's own providers. Imports
 * `RewardTrackingIngestionModule` (T-RTS-010, exported `RewardTrackingIngestionService`) rather
 * than duplicating it — the R8 "one shared domain method, three thin adapters" convention this
 * whole wave follows, same as `grpc.module.ts` (T-RTS-011).
 *
 * **Not registered in `AppModule`'s own imports by this task** — `app.module.ts` is exclusively
 * `agent-rts-foundation`'s file scope (`reward-tracking-service-plan/project.config.json`), the
 * identical gap `grpc.module.ts`'s own header already flagged. This module is fully
 * self-contained and independently testable/runnable instead: real process startup goes through
 * `kafka-consumer.main.ts` (this task's own standalone composition root, alongside this file,
 * mirroring `reward-redemption-service`'s own `T-RR-012` `kafka-consumer.main.ts` precedent —
 * confirmed by direct read). Folding this into a single hybrid process — if that is the
 * preferred production topology — is a follow-up for `agent-rts-foundation` (flagged in this
 * task's own completion report), since it requires editing a file outside this task's scope.
 *
 * R6 fix (post-review): own `CustomerIdCryptoService` instance, not a shared provider.
 * `RewardTrackingIngestionModule` exports only `RewardTrackingIngestionService`, not
 * `CustomerIdCryptoService` — its own providers list is T-RTS-010's owned file, not this task's
 * (R10). Building a second, independent instance here (via the same exported
 * `loadCustomerIdCryptoKeyMaterial()` factory function that module itself uses) rather than
 * widening that module's exports follows the identical precedent `customer-rewards-api.module.ts`
 * (T-RTS-030) already established for this exact class: it is a stateless wrapper over two
 * `Buffer` keys, so a second instance costs nothing. Used by `RewardTrackingConsumerService` to
 * hash (never encrypt/decrypt) a plaintext `customerId` before it can reach the DLQ topic, closing
 * the gap the independent review of this task's first submission caught (see that service's own
 * header for the full story).
 */
import { Module } from '@nestjs/common';
import { RewardTrackingIngestionModule } from '@/modules/ingestion/reward-tracking-ingestion.module';
import { LoggingModule } from '@/observability/logging.module';
import {
  CustomerIdCryptoService,
  loadCustomerIdCryptoKeyMaterial,
} from '@/modules/ingestion/customer-id-crypto.service';
import {
  RewardTrackingConsumerService,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  DEFAULT_RETRY_BACKOFF_BASE_MS,
  DEFAULT_RETRY_BACKOFF_MAX_MS,
} from './reward-tracking-consumer.service';
import { RewardTrackingDlqProducer } from './reward-tracking-dlq.producer';

@Module({
  // T-RTS-049 — `LoggingModule` also arrives transitively via `RewardTrackingIngestionModule`
  // (Nest dedupes an identically-referenced module class across one dependency graph), imported
  // here explicitly too since this module's own `RewardTrackingConsumerService` injects both
  // `MetricsService`/`StructuredLoggerFactory` directly.
  imports: [RewardTrackingIngestionModule, LoggingModule],
  providers: [
    RewardTrackingDlqProducer,
    { provide: RETRY_BACKOFF_BASE_MS, useValue: DEFAULT_RETRY_BACKOFF_BASE_MS },
    { provide: RETRY_BACKOFF_MAX_MS, useValue: DEFAULT_RETRY_BACKOFF_MAX_MS },
    {
      provide: CustomerIdCryptoService,
      useFactory: (): CustomerIdCryptoService =>
        new CustomerIdCryptoService(loadCustomerIdCryptoKeyMaterial()),
    },
    RewardTrackingConsumerService,
  ],
  exports: [RewardTrackingConsumerService],
})
export class KafkaModule {}
