/**
 * T-121 — DI wiring for `/field-context-providers` and `/field-api-lookup-providers`.
 *
 * Follows `rewards.module.ts`'s precedent: `RbacModule` brings `ScopedRepository` and the
 * already-global `RolesGuard`/`PermissionsGuard`/`TenancyScopeInterceptor`, `AuditModule` brings
 * `AuditContext`, `DatabaseModule` supplies `SEQUELIZE` (the create path's transaction), and
 * `CryptoModule` (T-016) supplies the `FieldCryptoService` that `FieldApiLookupConfigCrypto`
 * needs. Nothing here registers a guard or interceptor of its own.
 *
 * `FieldValueSourceRegistriesService` is exported because T-123 (live lookup endpoints) needs
 * `getAuthConfigForLookup`, and T-122 needs to validate a field's value-source reference against
 * these registries.
 *
 * T-123 — `FieldValueSourceLookupController`/`FieldValueSourceLookupService` appended below,
 * per 05-EXECUTION-PLAN.md §3's "append-only registration point" convention for a shared module
 * file (the same move `rules.module.ts` already makes for `RuleRegistriesController`, T-108).
 * Nothing above this comment was changed. `FieldApiLookupHttpClient` is registered as its own
 * provider, not constructed inline by the service, so a test can substitute a double the same
 * way `FieldValueSourceRegistriesService`'s own spec substitutes `ScopedRepository`.
 */
import { Module } from '@nestjs/common';
import { AuditModule } from '@/common/audit/audit.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { CryptoModule } from '@/common/crypto/crypto.module';
import { DatabaseModule } from '@/database/database.module';
import { FieldValueSourceRegistriesController } from './field-value-source-registries.controller';
import { FieldValueSourceRegistriesService } from './field-value-source-registries.service';
import { FieldApiLookupConfigCrypto } from './field-api-lookup-config.crypto';
import { FieldValueSourceLookupController } from './field-value-source-lookup.controller';
import {
  FieldApiLookupHttpClient,
  FieldValueSourceLookupService,
} from './field-value-source-lookup.service';

@Module({
  imports: [RbacModule, AuditModule, DatabaseModule, CryptoModule],
  controllers: [FieldValueSourceRegistriesController, FieldValueSourceLookupController],
  providers: [
    FieldValueSourceRegistriesService,
    FieldApiLookupConfigCrypto,
    FieldValueSourceLookupService,
    FieldApiLookupHttpClient,
  ],
  exports: [FieldValueSourceRegistriesService, FieldApiLookupConfigCrypto],
})
export class FieldValueSourcesModule {}
