/**
 * T-RR-040. Not wired into `AppModule` (`src/app.module.ts` is `agent-rr-foundation`'s exclusive
 * file scope, not this task's — same precedent RAP's own `observability.module.ts` documents for the
 * identical constraint, confirmed by direct read). Any later module that wants
 * `MetricsRegistry`/`StructuredLoggerFactory`/`LogRedactorService` imports this module directly, the
 * same "later tasks import this module directly" precedent `encryption.module.ts`'s own header sets
 * for `LogRedactorService`.
 *
 * Imports `EncryptionModule` for `EncryptionService` (this module's own `LogRedactorService` needs it
 * for `hash()`) rather than redeclaring a second key-loading path — one `EncryptionService` instance
 * per process, matching every other module that already depends on it.
 */
import { Module } from '@nestjs/common';
import { EncryptionModule } from '@/modules/encryption/encryption.module';
import { LogRedactorService } from './log-redactor.service';
import { MetricsRegistry } from './metrics.registry';
import { StructuredLoggerFactory } from './structured-logger.service';

@Module({
  imports: [EncryptionModule],
  providers: [LogRedactorService, MetricsRegistry, StructuredLoggerFactory],
  exports: [LogRedactorService, MetricsRegistry, StructuredLoggerFactory],
})
export class ObservabilityModule {}
