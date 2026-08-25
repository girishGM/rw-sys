/**
 * T-012 — the HTTP-facing failures of the hardening layer, mirroring `auth.exceptions.ts`.
 *
 * Every class here hands Nest a body already in 03-API-CONTRACT.md §1's envelope shape, for the
 * reason T-011's file spells out: `ErrorNormalisationFilter` (T-014) has not landed, and these
 * responses have properties of their own that must hold with or without it — chiefly TC-15's
 * requirement that a 429 disclose nothing about *which* limit tripped or how much quota is
 * left. When T-014's filter arrives it will recognise these as `HttpException`s carrying a
 * well-formed body and pass the code through.
 *
 * **No error in this file carries a limit name, a counter, a quota, a key or a reason.** The
 * `code` is a catalogue key; everything an operator needs is in the server log instead.
 *
 * This file is an addition to T-012's declared *Files owned* list. Recorded as a deviation in
 * the completion report.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { SECURITY_ERROR_CODE, SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS } from './security.constants';

/** The documented envelope. Exported so tests assert against one definition, not a literal. */
export function securityErrorBody(code: string): { error: { code: string } } {
  return { error: { code } };
}

/** 403 — a mutating request arrived with no `X-CSRF-Token` header (TC-7). */
export class CsrfTokenMissingHttpException extends HttpException {
  constructor() {
    super(securityErrorBody(SECURITY_ERROR_CODE.CSRF_TOKEN_MISSING), HttpStatus.FORBIDDEN);
  }
}

/**
 * 403 — the header was present but did not equal the session-bound value (TC-8).
 *
 * Distinguished from "missing" because the two mean genuinely different things to a *legitimate*
 * client — a missing header is a bug in the SPA's interceptor, a mismatched one is a stale tab
 * whose session was replaced — and neither tells an attacker anything they did not already know:
 * a cross-site caller cannot read the cookie in either case, so it learns only whether it sent a
 * header it already knows it sent.
 */
export class CsrfTokenInvalidHttpException extends HttpException {
  constructor() {
    super(securityErrorBody(SECURITY_ERROR_CODE.CSRF_TOKEN_INVALID), HttpStatus.FORBIDDEN);
  }
}

/**
 * 429 for **every** rate limit, carrying `Retry-After` and nothing else (TC-15).
 *
 * The seconds value is the only quantitative thing that leaves the server, and it is the one
 * the RFC requires for a client to behave well. It reveals when *this* window resets, which is
 * not the same as revealing which limit was hit or how many attempts remain.
 */
export class RateLimitedHttpException extends HttpException {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(securityErrorBody(SECURITY_ERROR_CODE.RATE_LIMITED), HttpStatus.TOO_MANY_REQUESTS);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * 503 for a shed request: the global login ceiling (AR-12, TC-22), or a fail-closed auth route
 * whose counter store is unreachable (AR-11, TC-20).
 *
 * One class for both because the client cannot act differently on them and an attacker must not
 * be able to tell them apart — see `SECURITY_ERROR_CODE.SERVICE_UNAVAILABLE`.
 */
export class ServiceUnavailableHttpException extends HttpException {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number = SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS) {
    super(
      securityErrorBody(SECURITY_ERROR_CODE.SERVICE_UNAVAILABLE),
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
