/**
 * T-INT-054. `Authorization: Bearer <ACTIVITY_INGEST_REST_TOKEN>` check for
 * `POST /api/v1/activities` (the new REST option for `SubmitActivity`, alongside the existing mTLS
 * gRPC endpoint — `activity-ingest-rest.controller.ts`'s own header). Structurally mirrors
 * `reward-redemption-service`'s own `IngestTokenGuard`
 * (`reward-redemption-service/src/rest/reward-entries/ingest-token.guard.ts`, T-RR-013, confirmed
 * by direct read) — same constant-time comparison, same "a naive `===` never leaks how many
 * leading characters of a guessed token are correct" reasoning.
 *
 * **One deliberate difference from that precedent, and from this service's own
 * `ProgressApiAuthGuard`: the token is read from `process.env` lazily, on every request, not once
 * at guard-construction time.** `RewardEntriesModule`'s `IngestTokenGuard` can safely throw at
 * construction because `REWARD_ENTRY_INGEST_TOKEN` missing there means that ENTIRE service (a
 * single-purpose app) cannot do its job at all — failing loud at boot is correct. This controller
 * is different: it is registered inside `AppModule`, the one Nest module Render's current
 * deployment already runs unconditionally for `/health` (`realtime-activity-processing-service/
 * CLAUDE.md`'s own "Standalone entry points" table) — a construction-time throw here would crash
 * that already-working process the moment this code ships to an environment that hasn't yet been
 * given `ACTIVITY_INGEST_REST_TOKEN`, exactly the regression `src/main.ts`'s own header warns
 * against for every other hybrid-gated transport. Reading lazily means an unconfigured deployment
 * degrades to "every request to this one new route gets a 503" (`ServiceUnavailableException`)
 * rather than "the whole process never starts" — `/health` and every other route stay unaffected
 * either way. Disclosed here and in this task's own completion report as a genuinely new decision.
 */
import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

const BEARER_PREFIX = 'Bearer ';

/** Constant-time comparison — both inputs are length-checked first since `timingSafeEqual` itself
 * throws on mismatched buffer lengths rather than returning `false`. Identical to RR's own
 * `IngestTokenGuard`'s `safeEqual` (deliberately copied, not shared via a base class — a shared
 * abstraction between two guards that must never accept each other's token risks a copy-paste bug
 * quietly widening one token's acceptance to the other, the same reasoning RR's own guard's header
 * gives). */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

@Injectable()
export class ActivityIngestRestTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const token = process.env.ACTIVITY_INGEST_REST_TOKEN?.trim();
    if (!token) {
      throw new ServiceUnavailableException(
        'ACTIVITY_INGEST_REST_TOKEN is not configured on this deployment — the REST option for ' +
          'SubmitActivity is not available (the mTLS gRPC endpoint is unaffected)',
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    const presented = header.slice(BEARER_PREFIX.length).trim();
    if (presented.length === 0 || !safeEqual(presented, token)) {
      throw new UnauthorizedException('Invalid activity ingest token');
    }

    return true;
  }
}
