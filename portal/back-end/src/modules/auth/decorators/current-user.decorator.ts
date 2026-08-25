/**
 * T-011 — `@CurrentUser()`, and the two request-shaped types the guards populate.
 *
 * ### The rule this file exists to make mechanical
 *
 * AGENT-PROTOCOL R3: *"`tenantId`, `countryId`, `merchantId` and `role` come from the verified
 * JWT only. If a DTO contains one of these, that is a bug."*
 *
 * {@link AuthenticatedUser} is the one structure those four values may be read from, and the
 * only thing that ever constructs it is `JwtAuthGuard`, from claims `TokenService` has already
 * verified. A handler that wants the caller's tenant takes `@CurrentUser()` and reads it;
 * there is no supported path by which a request body could reach the same field. That is what
 * makes the rule enforceable by review rather than by vigilance — a `tenantId` arriving from a
 * DTO is visibly a different variable from the one everything else uses.
 */
import {
  createParamDecorator,
  InternalServerErrorException,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import type { PortalRole } from '@/database/portal-models';

/**
 * The caller, as established by the guard chain.
 *
 * Everything up to `tokenId` comes from the **verified** access token. `mustChangePassword` does
 * not: it is read live from `portal_users` by `SessionValidGuard`, because a value cached in a
 * 15-minute token would keep a user confined to the change-password screen for a quarter of an
 * hour after they had already changed it (T-011 TC-20).
 */
export interface AuthenticatedUser {
  readonly userId: number;
  readonly sessionId: string;
  readonly role: PortalRole;
  readonly countryId: number | null;
  readonly tenantId: number | null;
  readonly merchantId: number | null;
  readonly rbacVersion: number;
  readonly tokenId: string;
  /** Live from the database, not from the token. Populated by `SessionValidGuard`. */
  readonly mustChangePassword: boolean;
}

/**
 * An Express request after the guard chain has run.
 *
 * `authUser` is optional in the type because it genuinely is absent on `@Public()` routes;
 * making it non-optional would force every consumer into a non-null assertion, which is exactly
 * the habit that turns "the guard always sets this" into "the guard usually sets this".
 */
export interface AuthenticatedRequest extends Request {
  authUser?: AuthenticatedUser;
}

/**
 * The decorator's body, exported separately from the decorator itself.
 *
 * `createParamDecorator` buries its factory inside Nest's route-argument metadata, where a unit
 * test can only reach it by reimplementing the lookup — and a test that reimplements the thing
 * it is testing proves nothing. Naming the function makes the behaviour below directly
 * assertable; the decorator is then a one-line adapter with nothing left to get wrong.
 *
 * Throws 500 rather than handing back `undefined` when no user is present. A handler that asks
 * for `@CurrentUser()` on a route that is `@Public()` — or on one whose guards were never
 * applied — has a wiring bug, and the safe failure for a wiring bug in an authorisation-relevant
 * path is a loud one. Returning `undefined` would let the handler proceed with an unauthenticated
 * caller and, most likely, an unscoped query.
 */
export function currentUserFrom(context: ExecutionContext): AuthenticatedUser {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (request.authUser === undefined) {
    throw new InternalServerErrorException(
      'CurrentUser was requested on a route with no authenticated user',
    );
  }
  return request.authUser;
}

/** Injects the authenticated caller into a handler parameter. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => currentUserFrom(context),
);
