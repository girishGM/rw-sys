/**
 * T-011 — marks the handful of routes a session confined by `must_change_password` may still
 * reach (implementation note 7: exactly `/auth/change-password` and `/auth/logout`).
 *
 * ### Why metadata rather than a path allowlist
 *
 * The obvious alternative is for `PasswordChangeRequiredGuard` to hold a list of URLs. That
 * breaks silently the first time a route moves, a prefix changes, or someone adds a trailing
 * slash — and it breaks *open*, because a path that no longer matches the "confined" test is a
 * path the confined session can suddenly reach. Metadata is attached to the handler itself, so
 * it travels with the route wherever it is mounted, and a route that forgets the decorator is
 * blocked rather than allowed.
 *
 * T-055 reuses the same shape for its `MFA_PENDING` state, which confines a session to
 * `/auth/mfa/enrol` and `/auth/logout` by the identical mechanism (02-SECURITY.md §2a).
 *
 * This file is an addition to T-011's declared *Files owned* list — the task names two
 * decorators and this is a third, in the same directory the task owns. Recorded as a deviation
 * in the completion report.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const PASSWORD_CHANGE_EXEMPT_KEY = 'auth:passwordChangeExempt';

export const AllowWhilePasswordChangeRequired = (): CustomDecorator<string> =>
  SetMetadata(PASSWORD_CHANGE_EXEMPT_KEY, true);
