/**
 * T-RR-007. `Authorization: Bearer <CACHE_ADMIN_TOKEN>` check for `POST
 * /api/v1/cache/invalidate` (`04-REST-CONTRACT.md` §4). Loaded once at guard-construction time
 * (Nest providers are singletons by default unless request-scoped, and this one isn't) — same
 * eager-throw-on-missing-secret precedent `EncryptionModule`'s own factory provider and RAP's own
 * `ProgressApiAuthGuard` already establish, so a misconfigured deployment fails at boot, not on
 * the first real request.
 *
 * R9/implementation note 6: rejects a request presenting any *other* known token (e.g.
 * `REWARD_ENTRY_INGEST_TOKEN`) even if a sloppy local `.env` happens to set it identically —
 * comparison is always against this guard's own loaded `CACHE_ADMIN_TOKEN` value specifically.
 */
import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { loadCacheAdminToken } from './cache-admin-token';

/** The fixed identity recorded in `cache_invalidation_audit.invoked_by` for every call this guard
 * authorizes. `CACHE_ADMIN_TOKEN` is a single shared secret, not a per-caller credential encoding
 * its own principal (unlike RAP's JWT-shaped `ProgressApiAuthGuard`) — there is no finer-grained
 * identity to resolve from it, so every authorized call is attributed to this one named identity
 * rather than inventing one. */
export const CACHE_ADMIN_INVOKED_BY = 'cache-admin-token';

const BEARER_PREFIX = 'Bearer ';

@Injectable()
export class CacheAdminAuthGuard implements CanActivate {
  private readonly token = loadCacheAdminToken();

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const presented = header.slice(BEARER_PREFIX.length).trim();
    // Never log/echo `presented` or `this.token` anywhere (R9) — the exception message below is
    // deliberately generic.
    if (presented.length === 0 || presented !== this.token) {
      throw new UnauthorizedException('Invalid bearer token');
    }
    return true;
  }
}
