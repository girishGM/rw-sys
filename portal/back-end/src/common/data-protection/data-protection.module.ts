/**
 * T-017 — DI wiring for the data-protection engine.
 *
 * A module file is an addition to T-017's declared *Files owned* list, following the precedent
 * T-010…T-015 each set (`auth.module.ts`, `security.module.ts`, `rbac.module.ts`,
 * `audit.module.ts`, `errors.module.ts`, `me.module.ts`); recorded as a deviation in the
 * completion report.
 *
 * ---
 *
 * ### What is registered globally, and what is not
 *
 * `ResponseMaskingInterceptor` is an `APP_INTERCEPTOR`. It has to be: masking that applies only
 * to the controllers somebody remembered to annotate is not masking, exactly as
 * `security.module.ts` argues about `CsrfGuard`. Its position in `AppModule`'s `imports` array
 * **is load-bearing**, for a reason that is the opposite of the usual one:
 *
 * > Nest runs interceptors' request-side logic in registration order and their response-side
 * > logic in **reverse** registration order. This interceptor only does response-side work, so a
 * > module registered *earlier* than this one wraps its output. T-018's payload-encryption
 * > interceptor must therefore be registered **before** `DataProtectionModule` for the fixed
 * > order of §8 — `DTO → mask → serialise → encrypt` — to hold. `response-masking.interceptor.ts`
 * > carries the same note; it is written in both places because getting it wrong encrypts the
 * > unmasked body and nothing visibly fails.
 *
 * The **log serialiser is not registered here.** `redact.ts` states the same boundary for T-014's
 * function: this task owns the serialiser, T-019/T-052 own the logger transport it plugs into.
 * `createLogMaskingSerialiser({ policies })` is exported for them, and until they wire it the
 * pattern-based `redact()` T-014 already installs in `AuditService` and
 * `ErrorNormalizationFilter` remains in force — so this task's arrival cannot make logging *less*
 * safe than it was.
 *
 * The **model hooks are installed at boot**, not per request, by {@link DataProtectionModule
 * .onApplicationBootstrap}. They are installed after the policy cache has loaded, because they
 * are generated from it; if the cache failed to load, no hooks are installed and — critically —
 * nothing is written unencrypted either, because the columns that would need encrypting are the
 * ones whose policies did not load, and a write to them proceeds exactly as it did before this
 * task existed. That is the one place the engine's failure is *not* fail-closed, and it is called
 * out in the completion report rather than hidden: see the note there on `enabled: false`.
 *
 * ### Why `CryptoModule` is imported here rather than globally
 *
 * `KeyRegistryService.onModuleInit()` fails the boot when the key registry is unusable — correct
 * for a process about to encrypt, wrong for one that is not (T-016 completion report, deviation
 * 3). Importing it from this module means the strict boot check applies exactly when the
 * encryption engine is switched on.
 */
import { Inject, Logger, Module, OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { BlindIndexService, FieldCryptoService } from '@/common/crypto';
import { CryptoModule } from '@/common/crypto/crypto.module';
import { AuditModule } from '@/common/audit/audit.module';
import { ScopeModule } from '@/common/scope/scope.module';
import { SecurityModule } from '@/common/security/security.module';
import { DatabaseModule } from '@/database/database.module';
import { scopedModels } from '@/common/scope/scope-strategy';
import {
  DATA_PROTECTION_CONFIG,
  dataProtectionConfigFactory,
  type DataProtectionConfig,
} from './data-protection.config';
import { installEncryptionHooks } from './model-encryption.hooks';
import { PolicyCacheService } from './policy-cache.service';
import { POLICY_STORE, PolicyRepository } from './policy.repository';
import { ResponseMaskingInterceptor } from './response-masking.interceptor';
import { RevealController } from './reveal.controller';
import { RevealService } from './reveal.service';

@Module({
  imports: [DatabaseModule, CryptoModule, AuditModule, ScopeModule, SecurityModule],
  controllers: [RevealController],
  providers: [
    { provide: DATA_PROTECTION_CONFIG, useFactory: dataProtectionConfigFactory },
    { provide: POLICY_STORE, useClass: PolicyRepository },
    PolicyCacheService,
    RevealService,
    ResponseMaskingInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: ResponseMaskingInterceptor },
  ],
  // `PolicyCacheService` is exported for T-018 (which needs `in_transit` per field) and for
  // T-019/T-052 (which need it to build the log serialiser). The config token travels with it
  // because T-018 reads `transport.mode` and `transport.routeOverrides` from the same document.
  exports: [PolicyCacheService, DATA_PROTECTION_CONFIG],
})
export class DataProtectionModule implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(DataProtectionModule.name);

  constructor(
    private readonly policies: PolicyCacheService,
    private readonly fieldCrypto: FieldCryptoService,
    private readonly blindIndex: BlindIndexService,
    @Inject(DATA_PROTECTION_CONFIG) private readonly config: DataProtectionConfig,
  ) {}

  /**
   * `PolicyCacheService` loads itself in its own `onModuleInit`; this is here to make the
   * ordering explicit rather than incidental. Nest guarantees a provider's `onModuleInit` runs
   * before its module's, so by the time {@link onApplicationBootstrap} installs hooks the cache
   * has either loaded or failed loudly.
   */
  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logger.warn(
        'Data protection is DISABLED (config/data-protection.json "enabled": false). No ' +
          'encryption hooks, no response masking, no reveal endpoint. Columns already ' +
          'encrypted stay encrypted and will read back as "v1.…" ciphertext.',
      );
    }
  }

  onApplicationBootstrap(): void {
    if (!this.config.enabled) return;
    if (!this.policies.isLoaded) {
      this.logger.error(
        'Policy cache is unloaded at bootstrap, so NO encryption hooks were installed. Reads and ' +
          'responses fail closed (masked), but a write to an at-rest-protected column would be ' +
          'stored as plaintext. Fix the policy table and restart before writing.',
      );
      return;
    }

    installEncryptionHooks(scopedModels(), {
      policies: this.policies,
      fieldCrypto: this.fieldCrypto,
      blindIndex: this.blindIndex,
      bindRecordIdAsAAD: this.config.atRest.bindRecordIdAsAAD,
      logger: this.logger,
    });
  }
}
