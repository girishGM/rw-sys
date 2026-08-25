/**
 * T-055 — `@AllowWhileMfaPending()`, the exact counterpart of T-011's
 * `@AllowWhilePasswordChangeRequired()`.
 *
 * A route carrying this decorator is reachable by a caller who has proved their password but has
 * not yet satisfied (or even enrolled) a second factor. **Four routes carry it and no others**
 * (implementation note 4): `/auth/mfa/enrol`, `/auth/mfa/verify`, `/auth/mfa/recover` and
 * `/auth/logout`.
 *
 * ### Why the exemption is a decorator and not a path list
 *
 * A list of paths in a guard drifts from the routes it describes — a controller renamed in one
 * file, an exemption left behind in another, and the hole is invisible until somebody goes
 * looking. Metadata on the handler cannot drift, because it *is* the handler. The same argument
 * `password-change-exempt.decorator.ts` makes; keeping the two mechanisms identical is
 * deliberate, so a reviewer who understands one understands both.
 *
 * ### The rule for adding a fifth
 *
 * Adding this decorator to a route is a security decision, not a convenience: every route it is
 * added to becomes reachable with **half** a credential. The test that keeps this honest is
 * `mfa.e2e-spec.ts`'s inventory check, which enumerates every route carrying this metadata and
 * fails if it is not exactly the four above.
 */
import { SetMetadata } from '@nestjs/common';

export const MFA_EXEMPT_KEY = 'mfa:exempt';

export const AllowWhileMfaPending = () => SetMetadata(MFA_EXEMPT_KEY, true);
