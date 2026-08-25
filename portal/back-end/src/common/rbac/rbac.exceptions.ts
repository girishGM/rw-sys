/**
 * T-013 — the single authorisation failure.
 *
 * ### What is not in the body, and why each omission is deliberate (TC-3)
 *
 * | Absent | Why |
 * |---|---|
 * | the resource name | tells a caller which entities exist behind an endpoint they cannot reach |
 * | the row id | confirms the row exists — the 403-vs-404 leak of 02-SECURITY.md §5.1, in a different costume |
 * | the required role or permission | hands an attacker the exact escalation target |
 * | which layer denied | maps the authorisation model: role vs permission vs unguarded route |
 *
 * What is left is `{ "error": { "code": "PERM_DENIED" } }` — a `system_messages` key the SPA
 * localises client-side (T004_004 seeds the text). The precise cause is logged server-side by
 * whichever guard raised it, where it belongs.
 *
 * The class takes no constructor arguments, deliberately, so that "just add the entity name for
 * debugging" is a change to this file — visible in a diff — rather than a call-site decision.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { PERMISSION_DENIED_CODE } from './rbac.constants';

export class PermissionDeniedHttpException extends HttpException {
  constructor() {
    super({ error: { code: PERMISSION_DENIED_CODE } }, HttpStatus.FORBIDDEN);
  }
}
