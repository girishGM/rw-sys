/**
 * T-017 — `GET /api/v1/reveal/:policyKey/:recordId` (07-DATA-PROTECTION.md §8).
 *
 * Thin, in the shape `auth.controller.ts` and `me.controller.ts` established: validate the
 * transport-level shape of the two path parameters, hand off to the service, wrap the result in
 * the 03-API-CONTRACT.md §1 envelope. Every security decision — which roles, which policies, the
 * rate limit, the audit row, the tenancy scope — is in `reveal.service.ts`, where it can be
 * unit-tested without an HTTP request.
 *
 * ### `@Roles(...ALL_PORTAL_ROLES)` is not a hole
 *
 * `RolesGuard` denies any route declaring no authorisation metadata at all (T-013 TC-18), so
 * "every authenticated role may *attempt* a reveal" has to be said explicitly. The actual
 * authorisation is per **policy row**: `reveal.service.ts` requires the caller's role to appear
 * in that field's `reveal_roles`, and a role that appears in none of them can reach this
 * controller and reveal nothing. Encoding the role list statically here instead would duplicate
 * `reveal_roles` in code and let the two disagree — and the copy in code would be the one nobody
 * updates.
 *
 * There is deliberately no `@RequirePermission`: `role_entity_permissions` is a matrix over
 * *entities and actions*, and "may unmask `merchants.contact_email`" is neither. §8 defines the
 * gate as `reveal_roles`, and adding a second, separately-configurable gate would create a state
 * where a policy row permits a reveal and a permission row silently prevents it.
 *
 * ### Why the response is exempt from response masking
 *
 * `@NoResponseMasking()` — the single legitimate use of that decorator. Without it the masking
 * interceptor would resolve the `value` property, find the field's policy through the alias
 * index, and mask the value this endpoint exists to disclose. The exemption is safe precisely
 * because everything that makes disclosure legitimate has already happened by the time the body
 * is built: the role check, the rate limit and the audit write.
 *
 * ### Path-parameter validation
 *
 * Both parameters are attacker-controlled and both are used to look things up, so they are
 * validated here rather than trusted. `policyKey` is matched against the same shape the policy
 * table's own `CHECK` allows; `recordId` is restricted to a positive integer or a UUID, which is
 * every primary key in this schema. A rejected parameter is a **403**, matching the service's
 * "one answer for every reveal failure" rule — a 400 would let a caller distinguish a malformed
 * key from an unauthorised one, and enumerate the policy table by the difference.
 */
import { Controller, Get, Param } from '@nestjs/common';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import { PermissionDeniedHttpException } from '@/common/rbac/rbac.exceptions';
import { ALL_PORTAL_ROLES } from '@/common/rbac/rbac.constants';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import { NoResponseMasking } from './response-masking.interceptor';
import { RevealService, type RevealResult } from './reveal.service';

/**
 * `<schema>.<table>.<column>` or `dto.<Name>.<field>`.
 *
 * Anchored, bounded at the column's own width (`policy_key` is `varchar(160)`), and restricted to
 * identifier characters plus the dot separator — so a key cannot carry a wildcard, a quote or a
 * path segment into any lookup that follows.
 */
export const POLICY_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,60}(\.[A-Za-z_][A-Za-z0-9_]{0,60}){2}$/;

/** Every primary key in this schema is a positive integer or a UUID. */
export const RECORD_ID_PATTERN =
  /^(?:[1-9][0-9]{0,18}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/** The §1 envelope. Declared here so the shape is asserted against one definition. */
export interface RevealEnvelope {
  readonly data: RevealResult;
}

@Controller('reveal')
@Roles(...ALL_PORTAL_ROLES)
export class RevealController {
  constructor(private readonly reveal: RevealService) {}

  /**
   * Returns one plaintext field of one record.
   *
   * `@Audit()` is present in addition to the explicit `pii_revealed` row the service writes: the
   * decorator records the *request* (who called what, and whether it succeeded), while the
   * service's row records the *disclosure* (which field, of which record). §8 asks for the
   * second; the first is what T-014 gives every mutating or sensitive route, and a reveal that
   * failed at the rate limit produces the first and not the second, which is exactly the
   * distinction an investigator wants.
   */
  @Get(':policyKey/:recordId')
  @NoResponseMasking()
  @Audit({ event: 'pii_reveal_request', targetType: 'reveal' })
  async revealField(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('policyKey') policyKey: string,
    @Param('recordId') recordId: string,
  ): Promise<RevealEnvelope> {
    if (!POLICY_KEY_PATTERN.test(policyKey) || !RECORD_ID_PATTERN.test(recordId)) {
      throw new PermissionDeniedHttpException();
    }
    return { data: await this.reveal.reveal(actor, policyKey, recordId) };
  }
}
