/**
 * T-PC-011. Validates the shared internal-service bearer token every REST request in this
 * module requires (`04-API-CONTRACT.md` header: "a shared internal service token (bearer,
 * rotated independently of any portal user/session credential)"). This is not a portal user
 * session or JWT — it is a distinct secret this service and the portal backend both hold
 * (implementation note 2).
 *
 * Deviation from the task file's literal path (`src/common/guards/internal-service-token.guard.ts`):
 * `src/common/**` is not granted to any agent in `project.config.json`
 * (`promo-code-service-plan/project.config.json`) — this agent's own file scope is limited to
 * `src/modules/promo-code-config/**` and `src/modules/campaign-binding/**`. Both the config REST
 * surface (this task) and the future bind API (T-PC-012, same owning agent) live inside that
 * scope, so this guard is kept here instead of introducing a new, ungranted top-level directory.
 * T-PC-012 imports it from here rather than duplicating it. See the completion report's
 * "Deviations from spec" section.
 *
 * The token is read directly from `process.env` rather than through `ConfigService`/
 * `config.schema.ts`'s central `Config` type, for the same file-scope reason — `src/config/**`
 * is granted only to `agent-promo-foundation`. `InternalServiceTokenStartupCheck` (this module,
 * registered as a provider in `promo-code-config.module.ts`) validates the secret is present and
 * non-empty at boot instead — see that file's header for why it isn't appended to
 * `config.schema.ts` itself — so a missing secret still fails boot loudly (R4) rather than only
 * failing the first real request.
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
export class InternalServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers['authorization'];

    if (!header || Array.isArray(header) || !header.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    const presented = header.slice(BEARER_PREFIX.length).trim();
    const expected = process.env.INTERNAL_SERVICE_TOKEN;
    if (!expected) {
      // Fails fast rather than silently accepting every caller — config.schema.ts's own
      // boot-time validation (R4) means this branch should be unreachable in a properly
      // configured process, but a guard must never treat "no expected value" as "any value
      // is valid" (that would defeat the entire control).
      throw new UnauthorizedException('Internal service token is not configured');
    }

    if (presented.length === 0 || !safeEqual(presented, expected)) {
      throw new UnauthorizedException('Invalid internal service token');
    }

    return true;
  }
}
