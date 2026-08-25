/**
 * T-018 — the two HTTP failures payload encryption can produce.
 *
 * Both follow the pattern `auth.exceptions.ts` established: an `HttpException` whose response is
 * already the `{ error: { code } }` envelope 03-API-CONTRACT.md §1 fixes, so
 * `ErrorNormalizationFilter` (T-014) recognises the code and passes it through unchanged.
 *
 * ### Why the split between 400 and 401 is a security decision, not tidiness
 *
 * Task file implementation note 7: *"A request encrypted with a revoked session's key → 401, not
 * 400: it is an authentication problem."* The distinction the client acts on is real —
 *
 *  - **400** means *"you and I share a key, and this particular payload was mangled."* The right
 *    client reaction is to surface an error and stop. Retrying cannot help, and a client that
 *    retries a 400 in a loop is the failure mode note 8 explicitly forbids.
 *  - **401** means *"the key you used is not the key of your session."* The right client reaction
 *    is the one it already has for every other 401: refresh, and on failure go to the login
 *    screen — which re-runs the handshake and mints a new key.
 *
 * Collapsing them into one code would make a revoked session look like a corrupt payload, and the
 * SPA would sit there showing an error to a user whose only problem is that they need to log in
 * again.
 *
 * ### Neither carries any detail
 *
 * Not which field failed, not whether the tag or the base64 was wrong, not the expected `kid`.
 * The reason lives in the server log with the correlation id attached. See
 * `transport-envelope.ts`'s `EnvelopeFailureReason`.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { AUTH_ERROR_CODE } from '@/modules/auth/session.constants';
import { TRANSPORT_ERROR_CODE } from './transport-crypto.constants';

/** Builds the documented envelope. Mirrors `authErrorBody`, deliberately kept independent. */
export function transportErrorBody(code: string): { error: { code: string } } {
  return { error: { code } };
}

/**
 * 400 — a payload arrived that this server holds the key for and still could not open.
 *
 * Constructed with no arguments, for the same reason `InvalidCredentialsHttpException` is: a
 * caller that cannot pass a reason cannot leak one.
 */
export class PayloadDecryptFailedHttpException extends HttpException {
  constructor() {
    super(transportErrorBody(TRANSPORT_ERROR_CODE.PAYLOAD_DECRYPT_FAILED), HttpStatus.BAD_REQUEST);
  }
}

/**
 * 401 — the envelope names a session that is not the caller's, or the caller's session has no
 * transport key (it was destroyed by logout, or never established).
 *
 * Reuses `AUTH_SESSION_INVALID` rather than minting a transport-specific 401 code on purpose: the
 * SPA's handling of "your session is not usable" must not fork on *why*, and
 * `SessionInvalidHttpException` already documents at length why that taxonomy is deliberately
 * coarse.
 */
export class TransportSessionInvalidHttpException extends HttpException {
  constructor() {
    super(transportErrorBody(AUTH_ERROR_CODE.SESSION_INVALID), HttpStatus.UNAUTHORIZED);
  }
}
