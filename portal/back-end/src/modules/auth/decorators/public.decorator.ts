/**
 * T-011 — marks a route as reachable without a session.
 *
 * **This decorator is an exception mechanism, not a convenience.** 03-API-CONTRACT.md §15
 * enumerates the *complete* list of public routes — four `/auth` endpoints and two health
 * checks — and states that "anything else is a bug". T-051's pre-release checklist and T-050's
 * route-inventory test both re-derive that list from the running application and fail if it has
 * grown. So adding `@Public()` to a route is a decision that shows up in two independent
 * automated checks and in a security review; it is not a way to make a failing test pass.
 *
 * The metadata is read by `JwtAuthGuard`, `SessionValidGuard` and `PasswordChangeRequiredGuard`
 * — all three, independently. A guard that silently skipped the check because a *different*
 * guard had already decided the route was public would make the three-layer model
 * (02-SECURITY.md §5) into one layer wearing three hats.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';

/** Metadata key. Namespaced so it cannot collide with another module's `SetMetadata` call. */
export const IS_PUBLIC_KEY = 'auth:isPublic';

export const Public = (): CustomDecorator<string> => SetMetadata(IS_PUBLIC_KEY, true);
