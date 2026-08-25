/**
 * T-018 — payload encryption between the SPA and the API, on top of TLS
 * (07-DATA-PROTECTION.md §5).
 *
 * ============================================================================================
 * ## What this protects against — and what it does not
 *
 * Application-layer payload encryption buys three specific things over TLS alone:
 *
 *  1. protection from **TLS-terminating intermediaries** — load balancers, WAFs, corporate
 *     proxies — that see plaintext today;
 *  2. payloads stay opaque in **access logs, APM traces and crash dumps** at every hop;
 *  3. it satisfies compliance mandates requiring encryption independent of transport.
 *
 * **It does not protect against XSS.** A script running in the page can call the same encrypt
 * function the application calls, with the same non-extractable `CryptoKey`, and obtain the same
 * result. Making the key non-extractable stops the key being *stolen and used elsewhere*; it does
 * not stop it being *used in place*. Anyone claiming otherwise is overselling it.
 *
 * The controls that do address XSS are the strict CSP and the httpOnly cookies in
 * 02-SECURITY.md. This module is defence in depth against the network path, and nothing more.
 * Task file implementation note 1 asks for that statement to live here, in the module's own doc
 * comment, so that nobody builds false confidence on it.
 * ============================================================================================
 *
 * ## Two global interceptors, and why their position in `AppModule` is load-bearing
 *
 * `PayloadDecryptInterceptor` must run **before** `ValidationPipe` — it does, because Nest runs
 * every interceptor's pre-phase before any pipe — and **after** the guard chain, which is what
 * lets it take the session id from a verified token rather than from the envelope.
 *
 * `PayloadEncryptInterceptor` must run **after** `ResponseMaskingInterceptor` (T-017). Nest runs
 * response-side interceptor logic in *reverse* registration order, so "after" means this module
 * is listed **before** `DataProtectionModule` in `AppModule.imports`. `data-protection.module.ts`
 * and `response-masking.interceptor.ts` both carry the same note from the other side; T-018 TC-17
 * is the test that proves it, because getting it wrong encrypts the unmasked body and nothing
 * else visibly fails.
 *
 * ## Rollback
 *
 * `"transport": { "mode": "off" }` in `config/data-protection.json`. Both interceptors become
 * no-ops and the application continues on TLS alone. Nothing is stored that needs unwinding: a
 * `transport_key_enc` left in a session row is unreadable ciphertext that dies with the session.
 */
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { DataProtectionModule } from '@/common/data-protection/data-protection.module';
import { PayloadDecryptInterceptor } from './payload-decrypt.interceptor';
import { PayloadEncryptInterceptor } from './payload-encrypt.interceptor';
import { TransportHandshakeModule } from './transport-handshake.module';
import { TransportPolicyService } from './transport-policy.service';

@Module({
  imports: [TransportHandshakeModule, DataProtectionModule],
  providers: [
    TransportPolicyService,
    PayloadDecryptInterceptor,
    PayloadEncryptInterceptor,
    // Order within this array matters too, and in the ordinary direction: the decrypt
    // interceptor's *pre*-phase must run before the encrypt interceptor's, so that the transport
    // key is resolved (and memoised on the request) exactly once per request.
    { provide: APP_INTERCEPTOR, useExisting: PayloadDecryptInterceptor },
    { provide: APP_INTERCEPTOR, useExisting: PayloadEncryptInterceptor },
  ],
  exports: [TransportPolicyService],
})
export class TransportCryptoModule {}
