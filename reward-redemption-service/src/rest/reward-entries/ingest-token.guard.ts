/**
 * T-RR-013. `Authorization: Bearer <REWARD_ENTRY_INGEST_TOKEN>` check for
 * `POST /api/v1/reward-entries` (`04-REST-CONTRACT.md` §1). Nest runs class-level `@UseGuards`
 * before `@Body()` is ever bound to the handler's parameters, so an unauthenticated caller is
 * rejected `401` before this endpoint's own request-body validation
 * (`reward-entry-request.dto.ts`) ever runs — implementation note 3's "an unauthenticated caller
 * should not be able to probe this endpoint's validation logic at all."
 *
 * Reads **only** `REWARD_ENTRY_INGEST_TOKEN` — never any other of this service's three bearer
 * secrets (`CACHE_ADMIN_TOKEN`, `GENERATION_SERVICE_TOKEN`), even if a misconfigured environment
 * happened to set two of them identically (implementation note 4, R9). Structurally identical to
 * this service's own `CacheAdminAuthGuard`
 * (`src/modules/cache-invalidation/cache-admin.guard.ts`, T-RR-007) — same eager-throw-at-
 * construction-time-on-missing-secret precedent, so a misconfigured deployment fails at boot
 * (well, at `RewardEntriesModule` construction time) rather than on the first real request — and
 * the same constant-time comparison promo-code-service's own `GenerationServiceTokenGuard`
 * (`promo-code-service/src/modules/generation/generation-service-token.guard.ts`, confirmed by
 * direct read) already established, so a naive `===` never leaks, via response-time variance, how
 * many leading characters of a guessed token are correct. Deliberately copied rather than shared
 * via a base class or a generic "any configured token" check — a shared abstraction between guards
 * that must never accept each other's token risks a copy-paste bug quietly widening one token's
 * acceptance to the other, the same reasoning that guard's own header gives for not sharing with
 * `InternalServiceTokenGuard`.
 */
import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

const BEARER_PREFIX = 'Bearer ';

export class MissingRewardEntryIngestTokenError extends Error {
  constructor() {
    super(
      'Missing required environment variable REWARD_ENTRY_INGEST_TOKEN — set it in ' +
        '.env.development (see .env.example) before RewardEntriesModule can construct its auth ' +
        'guard.',
    );
    this.name = 'MissingRewardEntryIngestTokenError';
  }
}

/** Constant-time comparison — both inputs are length-checked first since `timingSafeEqual` itself
 * throws on mismatched buffer lengths rather than returning `false`. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

@Injectable()
export class IngestTokenGuard implements CanActivate {
  private readonly token: string;

  constructor() {
    const token = process.env.REWARD_ENTRY_INGEST_TOKEN;
    if (!token || token.trim().length === 0) {
      throw new MissingRewardEntryIngestTokenError();
    }
    this.token = token;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;

    if (!header || !header.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    const presented = header.slice(BEARER_PREFIX.length).trim();
    // TC-4: presenting e.g. CACHE_ADMIN_TOKEN's own value here fails this same branch — `token` is
    // always read from `REWARD_ENTRY_INGEST_TOKEN` above, a distinct env var/secret, so the two are
    // never interchangeable by construction, not by an extra check.
    if (presented.length === 0 || !safeEqual(presented, this.token)) {
      throw new UnauthorizedException('Invalid reward entry ingest token');
    }

    return true;
  }
}
