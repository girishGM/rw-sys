/**
 * T-010 — DI wiring for the credential layer.
 *
 * Provider-only by design: T-010's scope is explicitly "**Out:** HTTP endpoints (T-011)", so
 * there is no controller here yet and this module is deliberately *not* imported into
 * `AppModule` — a module with no controllers and no consumers would add a boot-time
 * dependency on the database for no behaviour. T-011 adds `AuthController`, the token and
 * session services and the `AppModule` import; T-055 adds the MFA step-up. This file is an
 * append-only registration point for both (05-EXECUTION-PLAN §3): add to the arrays, do not
 * rewrite them.
 *
 * *(T-011, 2026-08-17: done — the controller, the `AppModule` import and the session layer are
 * all in place. The paragraph above is left as written because it is the reason the arrays
 * below are append-only, which is still true and still binding on T-055.)*
 *
 * The file is an addition to T-010's declared "Files owned" list and belongs to no other
 * task's list either; recorded as a deviation in the completion report.
 *
 * `CREDENTIAL_STORE` is bound to `CredentialRepository` here and nowhere else, which is what
 * lets every service in this module be unit-tested against an in-memory double while
 * production gets the real, raw-SQL implementation — see `credential.repository.ts` for why
 * that implementation does not, and cannot, go through `ScopedRepository`.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@/config/config.module';
import { CryptoModule } from '@/common/crypto/crypto.module';
import { BlindIndexService, FieldCryptoService } from '@/common/crypto';
import { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import { dataProtectionConfigFactory } from '@/common/data-protection/data-protection.config';
import { DatabaseModule } from '@/database/database.module';
// T-018 — see the `imports` array below for why this is `TransportHandshakeModule` and not
// `TransportCryptoModule`.
import { TransportHandshakeModule } from '@/common/transport-crypto/transport-handshake.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CredentialRepository, CREDENTIAL_STORE } from './services/credential.repository';
import { CredentialService } from './services/credential.service';
import { LockoutService } from './services/lockout.service';
import { PasswordPolicyService } from './services/password-policy.service';
import { SessionRepository, SESSION_STORE } from './services/session.repository';
import { SessionService } from './services/session.service';
import { STEP_UP_HOOK } from './services/step-up.hook';
import { TokenService } from './services/token.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PasswordChangeRequiredGuard } from './guards/password-change-required.guard';
import { SessionValidGuard } from './guards/session-valid.guard';
// T-055 — mandatory TOTP MFA for `super_admin`.
import { MfaAdminController } from './mfa-admin.controller';
import { MfaController } from './mfa.controller';
import { MfaPendingConfinementGuard, MfaRequiredGuard } from './guards/mfa-required.guard';
import { MfaPendingTokenService } from './services/mfa-pending-token.service';
import { MfaRepository, MFA_STORE } from './services/mfa.repository';
import { MfaService } from './services/mfa.service';
import { TotpStepUpHook } from './services/totp-step-up.hook';

/**
 * T-011 appended `AuthController`, the token/session services, the three guards and the step-up
 * hook binding, and added the `AppModule` import that makes `/auth/*` reachable.
 *
 * Two bindings here are the module's whole extension story, and both are one line:
 *
 *  - `STEP_UP_HOOK → NoopStepUpHook` is what T-055 replaces to make MFA mandatory for
 *    `super_admin` without touching `auth.service.ts`'s login flow (see `step-up.hook.ts`);
 *  - `SESSION_STORE → SessionRepository`, like `CREDENTIAL_STORE` before it, is bound here and
 *    nowhere else, which is what lets every service in this module be unit-tested against an
 *    in-memory double while production gets the raw-SQL implementation.
 *
 * The three guards are **exported, not registered globally**. `AuthController` applies them with
 * `@UseGuards`; T-013 composes the global chain in the order 00-ARCHITECTURE.md §6 fixes, and
 * T-015 applies them to `/me`. See `auth.controller.ts`'s header for why global registration is
 * not this task's to make.
 */
@Module({
  // `ConfigModule` is `@Global`, so in the running application this import is redundant — it is
  // here so the module is self-contained: `TokenService` injects `ConfigService` for the RS256
  // key pair, and a module whose graph only resolves because some *other* module happened to
  // load a global one is a module that cannot be unit-tested and fails confusingly in isolation.
  // T-055 appended `CryptoModule`: `MfaService` encrypts `mfa_secret_enc` through T-016's
  // `FieldCryptoService` — "the same as every other encrypted portal column" (implementation
  // note 2) — rather than reaching for `node:crypto` and inventing a second envelope format.
  //
  // T-018 appended `TransportHandshakeModule`, for `HandshakeService`: the ECDH handshake happens
  // *at login* (07-DATA-PROTECTION.md §5), so `AuthController` is where the client's public key
  // arrives and where the derived key gets bound to the session that was just issued.
  //
  // It is deliberately **not** `TransportCryptoModule`. That module imports
  // `DataProtectionModule` (it needs `PolicyCacheService` for `fields` mode), which imports
  // `SecurityModule`, which imports this module — a cycle needing `forwardRef`, on exactly the
  // edge `portal-user-email.crypto.ts` already documents for T-056. `TransportHandshakeModule`
  // holds only the ECDH derivation and the `transport_key_enc` store and depends on nothing but
  // `CryptoModule` and `DatabaseModule`, so this import closes no loop.
  imports: [ConfigModule, CryptoModule, DatabaseModule, TransportHandshakeModule],
  controllers: [AuthController, MfaController, MfaAdminController],
  providers: [
    // T-056 appended this. It is a `useFactory` rather than a class provider for one structural
    // reason: `PortalUserEmailCrypto` needs `atRest.bindRecordIdAsAAD` from the data-protection
    // config, and this module **cannot** import `DataProtectionModule` to get it —
    // `DataProtectionModule` imports `SecurityModule`, which imports this module, so that edge
    // would close a DI cycle. Calling the config factory directly is a plain function call with no
    // module graph attached, and it reads the same `config/data-protection.json` the hooks read, so
    // the ciphertext written by the hooks and the ciphertext read here are bound to the same AAD.
    {
      provide: PortalUserEmailCrypto,
      useFactory: (fieldCrypto: FieldCryptoService, blindIndex: BlindIndexService) =>
        new PortalUserEmailCrypto(
          fieldCrypto,
          blindIndex,
          dataProtectionConfigFactory().atRest.bindRecordIdAsAAD,
        ),
      inject: [FieldCryptoService, BlindIndexService],
    },
    { provide: CREDENTIAL_STORE, useClass: CredentialRepository },
    { provide: SESSION_STORE, useClass: SessionRepository },
    { provide: MFA_STORE, useClass: MfaRepository },
    // T-055 replaced `NoopStepUpHook` here — **this is the one line** `step-up.hook.ts` said this
    // task would change, and the login flow above it is untouched apart from carrying the hook's
    // `pendingToken` out to the cookie layer. See `totp-step-up.hook.ts`.
    { provide: STEP_UP_HOOK, useClass: TotpStepUpHook },
    CredentialService,
    LockoutService,
    PasswordPolicyService,
    TokenService,
    SessionService,
    AuthService,
    JwtAuthGuard,
    SessionValidGuard,
    PasswordChangeRequiredGuard,
    MfaPendingTokenService,
    MfaService,
    MfaPendingConfinementGuard,
    MfaRequiredGuard,
  ],
  exports: [
    CredentialService,
    LockoutService,
    PasswordPolicyService,
    CREDENTIAL_STORE,
    SESSION_STORE,
    TokenService,
    SessionService,
    AuthService,
    JwtAuthGuard,
    SessionValidGuard,
    PasswordChangeRequiredGuard,
    // Exported, not registered globally, for the same reason the three above are: `RbacModule`
    // composes the global chain in 00-ARCHITECTURE.md §6's fixed order (positions 4b and 6c).
    MFA_STORE,
    MfaService,
    MfaPendingTokenService,
    MfaPendingConfinementGuard,
    MfaRequiredGuard,
  ],
})
export class AuthModule {}
