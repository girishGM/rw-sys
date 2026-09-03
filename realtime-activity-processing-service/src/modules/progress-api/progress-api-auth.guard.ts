/**
 * T-RAP-040. `Authorization: Bearer <token>` check for every route on `ProgressController` — see
 * `progress-api-token.ts`'s own header for why this is a new, narrow credential type rather than a
 * reuse of an existing one. Two failure modes, deliberately distinct HTTP statuses (TC-5):
 *  - No token / an invalid or expired token → `401 Unauthorized` ("who are you").
 *  - A valid token for a *different* `customerId` than the one in the URL → `403 Forbidden`
 *    ("I know who you are, and you may not read this row") — the cross-customer access attempt
 *    this task's own test-case table calls out by name.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  InvalidProgressApiTokenError,
  loadProgressApiAuthSecret,
  verifyProgressApiToken,
} from './progress-api-token';

export interface ProgressAuthContext {
  tenantId: number;
  customerId: string;
}

export interface RequestWithProgressAuth extends Request {
  progressAuth: ProgressAuthContext;
}

const BEARER_PREFIX = 'Bearer ';

@Injectable()
export class ProgressApiAuthGuard implements CanActivate {
  // Loaded once at guard-construction time (Nest providers are singletons by default) — same
  // eager-throw-on-missing-secret precedent `encryption.service.ts`'s own factory-provider
  // construction already sets, so a misconfigured deployment fails at boot, not on the first
  // real request.
  private readonly secret = loadProgressApiAuthSecret();

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithProgressAuth>();
    const claims = this.authenticate(request);

    const requestedCustomerId = request.params.customerId;
    if (requestedCustomerId !== undefined && claims.customerId !== requestedCustomerId) {
      throw new ForbiddenException('Token is not authorized for this customerId');
    }

    request.progressAuth = { tenantId: claims.tenantId, customerId: claims.customerId };
    return true;
  }

  private authenticate(request: Request): { tenantId: number; customerId: string } {
    const header = request.headers.authorization;
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice(BEARER_PREFIX.length).trim();
    if (token.length === 0) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      return verifyProgressApiToken(token, this.secret);
    } catch (error) {
      if (error instanceof InvalidProgressApiTokenError) {
        throw new UnauthorizedException('Invalid or expired token');
      }
      throw error;
    }
  }
}
