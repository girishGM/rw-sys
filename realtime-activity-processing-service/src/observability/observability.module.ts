/**
 * T-RAP-043. Not wired into `AppModule` (`src/app.module.ts` is `agent-rap-foundation`'s exclusive
 * file scope, not this task's — same precedent `progress-api.module.ts`/`grpc-server.main.ts`'s own
 * headers already document for the identical constraint, `AGENT-PROTOCOL.md` R10). Every Wave 2/3
 * module that wants `MetricsService`/`StructuredLoggerFactory` imports this module directly, the
 * same "later tasks import this module directly" precedent `encryption.module.ts`'s own header sets
 * for `LogRedactorService`.
 *
 * Imports `EncryptionModule` for `LogRedactorService` rather than redeclaring it here — one
 * `LogRedactorService` instance per process, matching every other module that already depends on it
 * (`activity-mapping.module.ts` et al.), not a second, independently-refreshed copy.
 */
import { Module } from '@nestjs/common';
import { EncryptionModule } from '@/modules/encryption/encryption.module';
import { MetricsService } from './metrics.service';
import { StructuredLoggerFactory } from './structured-logger';

@Module({
  imports: [EncryptionModule],
  providers: [MetricsService, StructuredLoggerFactory],
  exports: [MetricsService, StructuredLoggerFactory],
})
export class ObservabilityModule {}
