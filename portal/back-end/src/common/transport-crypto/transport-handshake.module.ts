/**
 * T-018 — the handshake half of transport encryption, wired for DI.
 *
 * ### Why this is a second module rather than part of `TransportCryptoModule`
 *
 * A DI cycle, and it is not avoidable by ordering:
 *
 * ```
 * AuthModule ──(needs HandshakeService, to complete the handshake on POST /auth/login)──► ?
 * TransportCryptoModule ──(needs PolicyCacheService, for `fields` mode)──► DataProtectionModule
 * DataProtectionModule ──► SecurityModule ──► AuthModule
 * ```
 *
 * If `AuthModule` imported `TransportCryptoModule`, that closes the loop and Nest needs a
 * `forwardRef` — the arrangement `portal-user-email.crypto.ts` already documents hitting on the
 * same edge for T-056, and resolved there the same way: keep the piece `AuthModule` needs free of
 * any dependency on the policy engine.
 *
 * So this module holds exactly what the login flow needs — the ECDH derivation and the
 * `transport_key_enc` store — and depends on nothing but `CryptoModule` and `DatabaseModule`.
 * `TransportCryptoModule` imports *this* module plus `DataProtectionModule` and owns the two
 * interceptors. `AuthModule` imports this one only.
 *
 * `CryptoModule` is imported here rather than globally for the reason its own header gives:
 * `KeyRegistryService.onModuleInit()` fails the boot when the key registry is unusable, which is
 * right for a process about to encrypt and wrong for one that is not.
 */
import { Module } from '@nestjs/common';
import { CryptoModule } from '@/common/crypto/crypto.module';
import { DatabaseModule } from '@/database/database.module';
import { HandshakeService } from './handshake.service';
import {
  SESSION_TRANSPORT_KEY_STORE,
  SessionTransportKeyRepository,
} from './session-transport-key.repository';

@Module({
  imports: [CryptoModule, DatabaseModule],
  providers: [
    { provide: SESSION_TRANSPORT_KEY_STORE, useClass: SessionTransportKeyRepository },
    HandshakeService,
  ],
  exports: [HandshakeService, SESSION_TRANSPORT_KEY_STORE],
})
export class TransportHandshakeModule {}
