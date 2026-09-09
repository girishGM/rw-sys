/**
 * T-RR-005. Wires `EncryptionService`, `FieldEncryptionConfigRepository` and `LogRedactorService`
 * so later Wave 1+ tasks (T-RR-010's shared ingestion service, in particular) can import this
 * module directly instead of re-deriving key handling.
 *
 * Registered directly in `AppModule`'s imports (not deferred the way `ClaimWorkerModule` currently
 * is) specifically so this task's own Verification step 3 — a missing/malformed
 * `FIELD_ENCRYPTION_*` env var must crash the whole process at boot, not just "whenever some later
 * task's module happens to get wired in" — is true starting now, matching the fail-fast discipline
 * `ConfigModule` already established for its own bootstrap vars (T-RR-004).
 */
import { Module } from '@nestjs/common';
import { EncryptionService, loadEncryptionKeyMaterial } from './encryption.service';
import { FieldEncryptionConfigRepository } from './field-encryption-config.repository';
import { LogRedactorService } from './log-redactor.service';

@Module({
  providers: [
    {
      // Not Nest's implicit constructor-injection: `EncryptionService`'s own constructor
      // parameter is a plain `EncryptionKeyMaterial` interface, not a class, which Nest's
      // `design:paramtypes` reflection cannot resolve to a DI token — and
      // `loadEncryptionKeyMaterial()`'s throw-on-missing/malformed-env-var (TC-5/TC-6) must happen
      // eagerly, at module-construction time (`encryption.service.ts`'s own header explains why).
      provide: EncryptionService,
      useFactory: (): EncryptionService => new EncryptionService(loadEncryptionKeyMaterial()),
    },
    FieldEncryptionConfigRepository,
    LogRedactorService,
  ],
  exports: [EncryptionService, FieldEncryptionConfigRepository, LogRedactorService],
})
export class EncryptionModule {}
