/**
 * T-055 — `POST /admin/access-control/super-admins/:id/mfa-reset` (implementation note 6).
 *
 * The break-glass path: a `super_admin` who has lost both their device and all ten recovery codes
 * is otherwise permanently locked out, and there is deliberately no self-service way back in —
 * one would be a second, weaker authentication path around the factor this whole task exists to
 * add. So the way back in is another `super_admin`, and every use is audited with both ids.
 *
 * ### Why this route lives in the auth module rather than in T-033's
 *
 * Its path belongs to the Access Control screen (T-033, `/admin/access-control/*`), which has not
 * started and whose files this task must not create (R9). Everything the handler does — reading
 * `mfa_enabled`, clearing a seed, invalidating recovery codes, revoking sessions — is this
 * module's own state, and `MfaService` already implements it. Putting the controller here keeps
 * T-055 inside its own files while giving the endpoint the path 02-SECURITY.md and the task file
 * specify; T-033 renders a button that calls it. Flagged in the completion report so T-033 knows
 * not to declare it again.
 *
 * ### The four checks are in the service, not here
 *
 * Actor's own MFA satisfied, no self-reset, target exists and is a `super_admin`, target's
 * sessions revoked — all in `MfaService.resetByAdmin`, where they are testable without a server
 * and where the audit write sits next to them. This file validates the shape of `:id` and hands
 * over the **verified** actor from `@CurrentUser()`, which is the only place a role or a user id
 * may come from (R3).
 */
import { Controller, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import { NotFoundHttpException } from './auth.exceptions';
import { requestContext } from './auth.controller';
import { CurrentUser, type AuthenticatedUser } from './decorators/current-user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PasswordChangeRequiredGuard } from './guards/password-change-required.guard';
import { SessionValidGuard } from './guards/session-valid.guard';
import { MfaRequiredGuard } from './guards/mfa-required.guard';
import { MfaService } from './services/mfa.service';

/** A positive decimal integer, the shape `portal_users.id` (an identity column) takes. */
const USER_ID_PATTERN = /^[1-9][0-9]{0,9}$/;

@Controller('admin/access-control')
// The same defence-in-depth `AuthController` documents: these run globally too, and duplicating
// them here means T-013's Rollback ("remove the guards from the global provider list") cannot
// leave *this* route — which disables somebody's second factor — reachable without one.
@UseGuards(JwtAuthGuard, SessionValidGuard, PasswordChangeRequiredGuard, MfaRequiredGuard)
@Roles('super_admin')
export class MfaAdminController {
  constructor(private readonly mfa: MfaService) {}

  /**
   * 204: the caller learns that it worked and nothing else. Returning the target's new state
   * would be an inventory of who has MFA and who does not, on a route whose whole subject is
   * somebody else's account.
   */
  @Post('super-admins/:id/mfa-reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetMfa(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: Request,
  ): Promise<void> {
    // A non-numeric id answers 404 for the same reason `DELETE /auth/sessions/:id` does: "not a
    // valid id" and "not a user you may act on" must be indistinguishable, and it keeps a
    // non-integer string from ever reaching an `int` column comparison.
    if (!USER_ID_PATTERN.test(id)) throw new NotFoundHttpException();

    await this.mfa.resetByAdmin(
      { userId: actor.userId, role: actor.role },
      Number.parseInt(id, 10),
      requestContext(request),
    );
  }
}
