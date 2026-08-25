/**
 * T-055 — the real {@link StepUpHook}, replacing T-011's `NoopStepUpHook` in `auth.module.ts`.
 *
 * This is the "one line" `step-up.hook.ts` says T-055 would change, and it is the whole of this
 * feature's presence in the login path. `AuthService.login` calls `evaluate()` at exactly one
 * point — **after** the password has been verified and **before** any session is created — which
 * is what makes both of 02-SECURITY.md §2's requirements hold at once: no session and no refresh
 * token for a `super_admin` awaiting a second factor (step 7), and no way for an unauthenticated
 * caller to learn from timing or response shape whether a given account has MFA (the hook is
 * never reached on a failed login).
 *
 * ### Why the answer is "required" for *every* `super_admin`, enrolled or not
 *
 * 00-ARCHITECTURE.md §5.2a and 02-SECURITY.md §11's checklist item are about the *role*, not
 * about a per-account setting: *"Every `super_admin` account has `mfa_enabled = true`; a fresh
 * `super_admin` account cannot reach any route beyond `/auth/*` and `/auth/mfa/enrol` until it
 * does"*. If the hook only fired for accounts that had already enrolled, then "MFA is mandatory"
 * would mean "MFA is mandatory once you opt in", and a `super_admin` who simply never enrolled
 * would hold an ordinary password-only session forever — which is the exact state AR-08 moved
 * this task into v1 to eliminate.
 *
 * So both cases produce a pending token; the `enrolled` claim inside it is what tells the SPA (and
 * `MfaPendingConfinementGuard`) whether the next screen is "scan this" or "enter your code".
 *
 * ### Why the token is minted here rather than in the controller
 *
 * Because this is the only place that has the **database** user row at the moment the decision is
 * made. The controller sees a `LoginResult`; passing the row out to it so it could mint a token
 * would widen what the transport layer handles, for no benefit. The token travels back through
 * `StepUpDecision.pendingToken`, which is the additive field this task added to that interface.
 */
import { Injectable } from '@nestjs/common';
import type { AuthUserRow } from './credential.repository';
import { MfaPendingTokenService } from './mfa-pending-token.service';
import type { StepUpDecision, StepUpHook } from './step-up.hook';

/** The one role a second factor is mandatory for in v1 (`BACKLOG.md` B-02, AR-08). */
export const MFA_MANDATORY_ROLE = 'super_admin';

@Injectable()
export class TotpStepUpHook implements StepUpHook {
  constructor(private readonly pendingTokens: MfaPendingTokenService) {}

  async evaluate(user: AuthUserRow): Promise<StepUpDecision> {
    if (user.role !== MFA_MANDATORY_ROLE) {
      // Five of the six roles, unchanged from before T-055 (TC-15). `BACKLOG.md` B-02 keeps MFA
      // optional and self-service for them.
      return { required: false };
    }

    return {
      required: true,
      pendingToken: this.pendingTokens.mint({ userId: user.id, enrolled: user.mfaEnabled }),
    };
  }
}
