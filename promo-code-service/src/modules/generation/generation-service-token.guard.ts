/**
 * T-PC-056. Validates the `GENERATION_SERVICE_TOKEN` bearer secret every request to
 * `POST /api/v1/promo-codes/generate` requires — a **distinct** secret from
 * `INTERNAL_SERVICE_TOKEN` (`src/modules/promo-code-config/guards/internal-service-token.guard.ts`,
 * T-PC-011), per R11: config/list/bind calls (lower trust, held by the portal) and code
 * generation (higher trust — mints real, payable value, held only by a real generation caller)
 * must never be authorized by the same secret.
 *
 * Copied verbatim in structure from `InternalServiceTokenGuard`, substituting
 * `GENERATION_SERVICE_TOKEN` for `INTERNAL_SERVICE_TOKEN` throughout (task file implementation
 * note 3) — **not** imported/extended from that guard. A shared base class for two guards that
 * must never accept each other's token is exactly the kind of shared abstraction that risks a
 * copy-paste bug quietly widening one token's acceptance to the other (R11); two small,
 * independent, boring files are safer here than one clever one.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

const BEARER_PREFIX = 'Bearer ';

/**
 * Constant-time comparison — a naive `===` would leak, via response-time variance, how many
 * leading characters of a guessed token are correct. Both inputs are hashed-length-normalised
 * (via a fixed-length buffer compare) rather than compared directly when lengths differ, since
 * `timingSafeEqual` itself throws on mismatched buffer lengths.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

@Injectable()
export class GenerationServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers['authorization'];

    if (!header || Array.isArray(header) || !header.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    const presented = header.slice(BEARER_PREFIX.length).trim();
    const expected = process.env.GENERATION_SERVICE_TOKEN;
    if (!expected) {
      // Fails fast rather than silently accepting every caller —
      // `GenerationServiceTokenStartupCheck`'s own boot-time validation (R4) means this branch
      // should be unreachable in a properly configured process, but a guard must never treat "no
      // expected value" as "any value is valid" (that would defeat the entire control).
      throw new UnauthorizedException('Generation service token is not configured');
    }

    if (presented.length === 0 || !safeEqual(presented, expected)) {
      // TC-4: presenting `INTERNAL_SERVICE_TOKEN`'s own value here fails this same branch —
      // `expected` is always read from `GENERATION_SERVICE_TOKEN`, a distinct env var/secret, so
      // the two tokens are never interchangeable by construction, not by an extra check.
      throw new UnauthorizedException('Invalid generation service token');
    }

    return true;
  }
}
